#Requires -Version 5.1
<#
    FTS 多账号自动打金脚本 - Windows 版
    同一个文件同时兼容 PowerShell 5.1 (Desktop) 与 PowerShell 7 (Core)

    用法:
      powershell -ExecutionPolicy Bypass -File autofts.ps1 --init
      pwsh -File autofts.ps1 --run

    模式与 autofts.sh 完全一致:
      --probe / --selftest / --dry-run / --run / --init / --settings / --stop / --help

    说明: 引擎逻辑内嵌在本文件里(core.js / probe.js)，运行时释放到同目录。
          config.json / wallets.json 与 Linux 版通用，可直接互相拷贝。
#>

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# 告诉内嵌的 core.js/probe.js "我是被哪个启动器拉起来的"，用于提示文案
$env:FTS_LAUNCHER = 'ps1'

# ============================================================
# 兼容层: PS 5.1 与 PS 7 的差异全部集中在这里
# ============================================================
$Script:IsPS7 = ($PSVersionTable.PSVersion.Major -ge 6)
$Script:PSVer = $PSVersionTable.PSVersion.ToString()

# 控制台编码: PS 5.1 默认是系统代码页(中文 GBK)，不改成 UTF-8 中文会乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Script:ScriptPath = $MyInvocation.MyCommand.Definition
if (-not $Script:ScriptPath) { $Script:ScriptPath = $PSCommandPath }
$Script:WorkDir = Split-Path -Parent $Script:ScriptPath
Set-Location -LiteralPath $Script:WorkDir

$Script:LogDir   = Join-Path $Script:WorkDir 'logs'
if (-not (Test-Path -LiteralPath $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
$Script:PidFile  = Join-Path $Script:LogDir 'engine.pid'
$Script:StopFlag = Join-Path $Script:LogDir '.stop'
$Script:TmpJsDir = Join-Path $Script:LogDir '.js'
if (-not (Test-Path -LiteralPath $Script:TmpJsDir)) { New-Item -ItemType Directory -Path $Script:TmpJsDir -Force | Out-Null }

# Windows 上用记事本/Set-Content 存成 "UTF-8 带 BOM" 时，JSON.parse 会直接抛错、
# 整份配置被静默忽略。启动时统一把 BOM 去掉，一劳永逸。
function Repair-JsonBom {
    param([string]$Name)
    $f = Join-Path $Script:WorkDir $Name
    if (-not (Test-Path -LiteralPath $f)) { return }
    try {
        $b = [System.IO.File]::ReadAllBytes($f)
        if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
            $txt = [System.Text.Encoding]::UTF8.GetString($b, 3, $b.Length - 3)
            [System.IO.File]::WriteAllText($f, $txt, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "已移除 BOM: $Name"
        }
    } catch { }
}
Repair-JsonBom 'config.json'
Repair-JsonBom 'wallets.json'

# ============================================================
# 输出
# ============================================================
function Write-Ok      { param([string]$m) Write-Host "[OK]    $m" -ForegroundColor Green }
function Write-WarnMsg { param([string]$m) Write-Host "[!]     $m" -ForegroundColor Yellow }
function Write-ErrMsg  { param([string]$m) Write-Host "[X]     $m" -ForegroundColor Red }
function Write-Die     { param([string]$m) Write-Host "[FATAL] $m" -ForegroundColor Red; exit 1 }
function Write-Step    { param([string]$m) Write-Host $m -ForegroundColor Cyan }

# ============================================================
# 帮助
# ============================================================
function Show-Usage {
    Write-Host @'
用法: powershell -ExecutionPolicy Bypass -File autofts.ps1 [模式]

模式:
  --probe      链上只读探测: 验证合约地址/函数在不在(完全不需要钱包私钥)
  --selftest   只读体检: 环境/依赖/RPC/合约/余额/授权 + 交易预演(一分钱不花)
  --dry-run    全流程预演: 走完所有逻辑但交易不上链
  --run        正式运行(默认)
  --init       打开配置向导(房间/抢位区间/延迟/手续费/账号)，配完即退出
  --settings   同 --init，随时回来改设置
  --stop       停止后台运行的引擎
  --help       查看本帮助

建议首次使用顺序:
  --probe  ->  --init  ->  --selftest  ->  --dry-run  ->  --run

常用可调项(都在 --init 向导里，也可直接改 config.json):
  ROOMS              参与房间 0=10U 1=50U 2=100U
  SNIPE_MIN_COUNT / SNIPE_MAX_COUNT  抢单人数区间，默认 30/60
  SNIPE_DELAY_MS     抢单延迟(毫秒)，默认 0
  GAS_GWEI           固定 gas 价，默认 0.05；写 null 则改为自动(按链上价 x GAS_MULT)
  CLAIM_INTERVAL_MS  领取返利扫描间隔，默认 30000
  MIN_BNB_GAS        最低 BNB 提醒阈值，默认 0.005
'@
    exit 0
}

# ============================================================
# 停止引擎
# ============================================================
function Stop-Engine {
    # 先落停止标志: 即使 PID 丢失/被复用，外层循环也会退出
    try { Set-Content -LiteralPath $Script:StopFlag -Value '' -Encoding ASCII -Force -ErrorAction SilentlyContinue } catch { }

    $shellPid = 0; $nodePid = 0; $found = $false
    if (Test-Path -LiteralPath $Script:PidFile) {
        foreach ($line in (Get-Content -LiteralPath $Script:PidFile -ErrorAction SilentlyContinue)) {
            if ($line -match '^shell=(\d+)') { $shellPid = [int]$Matches[1] }
            if ($line -match '^node=(\d+)')  { $nodePid  = [int]$Matches[1] }
        }
    }

    # PID 复用防护: 必须能读到命令行、且确实是本脚本，才敢 kill。
    # 读不到命令行时(权限/CIM 异常)宁可不动手 —— PID 复用误杀别的进程，
    # 比 --stop 少停一次严重得多。
    $shellOk = $false
    if ($shellPid -gt 0 -and (Get-Process -Id $shellPid -ErrorAction SilentlyContinue)) {
        $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$shellPid" -ErrorAction SilentlyContinue
        if ($ci -and $ci.CommandLine) {
            if ($ci.CommandLine -match 'autofts') { $shellOk = $true }
        } else {
            Write-WarnMsg "无法校验 PID $shellPid 的命令行，跳过外壳进程(避免 PID 复用误杀)"
        }
    }
    if ($shellOk) {
        Stop-Process -Id $shellPid -Force -ErrorAction SilentlyContinue
        Write-Host "已停止外壳守护循环 (PID $shellPid)"
        $found = $true
    }
    if ($nodePid -gt 0 -and (Get-Process -Id $nodePid -ErrorAction SilentlyContinue)) {
        $corePathCheck = Join-Path $Script:WorkDir 'core.js'
        $ciNode = Get-CimInstance Win32_Process -Filter "ProcessId=$nodePid" -ErrorAction SilentlyContinue
        if (-not $ciNode -or -not $ciNode.CommandLine -or $ciNode.CommandLine -like "*$corePathCheck*") {
            if ($ciNode -and $ciNode.CommandLine) {
                Stop-Process -Id $nodePid -Force -ErrorAction SilentlyContinue
                Write-Host "已停止引擎 (PID $nodePid)"
                $found = $true
            } elseif (-not $ciNode) {
                # 读不到进程信息：可能是权限问题，保守跳过
                Write-WarnMsg "无法校验引擎 PID $nodePid，跳过(可用任务管理器手动结束)"
            } else {
                Stop-Process -Id $nodePid -Force -ErrorAction SilentlyContinue
                Write-Host "已停止引擎 (PID $nodePid)"
                $found = $true
            }
        }
    }
    Remove-Item -LiteralPath $Script:PidFile -Force -ErrorAction SilentlyContinue

    # 兜底: 按命令行找残留的 node core.js
    # 只认"本目录下的 core.js"，否则会把机器上别的项目/别的副本一起杀掉
    $corePath = Join-Path $Script:WorkDir 'core.js'
    $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -and $_.CommandLine -like "*$corePath*" })
    foreach ($p in $left) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "已停止残留引擎进程 (PID $($p.ProcessId))"
        $found = $true
    }

    if (-not $found) {
        Write-Host "当前没有运行中的引擎"
        Remove-Item -LiteralPath $Script:StopFlag -Force -ErrorAction SilentlyContinue
    } else {
        # 外壳是被强杀的，没人去消费这个标志；确认都停干净了就顺手清掉，
        # 免得下次启动看到一个残留文件犯嘀咕(启动时本来也会清，这里只是保持干净)
        Start-Sleep -Milliseconds 800
        $shellAlive = $false
        if ($shellPid -gt 0) { $shellAlive = [bool](Get-Process -Id $shellPid -ErrorAction SilentlyContinue) }
        $stillNode = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                       Where-Object { $_.CommandLine -and $_.CommandLine -like "*$corePath*" })
        if (-not $shellAlive -and $stillNode.Count -eq 0) {
            Remove-Item -LiteralPath $Script:StopFlag -Force -ErrorAction SilentlyContinue
        }
    }
    exit 0
}

# ============================================================
# 参数解析
# ============================================================
$Mode      = 'run'
$DoInit    = $false
$DoWizard  = $false
$ProbeArgs = @()

for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -eq '--probe') {
        $Mode = 'probe'
        if ($i + 1 -lt $args.Count) { $ProbeArgs = @($args[($i + 1)..($args.Count - 1)]) }
        break
    }
    elseif ($a -eq '--selftest') { $Mode = 'selftest' }
    elseif ($a -eq '--dry-run')  { $Mode = 'dry-run' }
    elseif ($a -eq '--run')      { $Mode = 'run' }
    elseif ($a -eq '--init')     { $DoInit = $true }
    elseif ($a -eq '--settings') { $DoWizard = $true }
    elseif ($a -eq '--stop')     { Stop-Engine }
    elseif ($a -eq '-h' -or $a -eq '--help') { Show-Usage }
    else {
        Write-Host "未知参数: $a (用 --help 查看用法)" -ForegroundColor Red
        exit 2
    }
}

# ============================================================
Write-Step "[1/5] 检查运行环境..."
Write-Host "PowerShell $Script:PSVer ($($PSVersionTable.PSEdition))"

# --- Node.js ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-WarnMsg "未找到 Node.js，尝试用 winget 安装..."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) { & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Host }
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { Write-Die "未找到 Node.js。请安装 Node 18+ : https://nodejs.org/ 或 winget install OpenJS.NodeJS.LTS" }
}
$Script:NodeExe = $nodeCmd.Source
$nodeVer = (& $Script:NodeExe -v 2>$null)
$nodeMajor = 0
if ($nodeVer -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 18) { Write-Die "Node 版本过低 ($nodeVer)，需要 >= 18" }
Write-Ok "Node $nodeVer"

# ------------------------------------------------------------
# 关键兼容点: PowerShell 5.1 把参数传给原生程序时，会把字符串里的双引号吃掉，
# 所以 `node -e "含双引号的代码"` 会被改坏(实测 require("fs") 变成 require(fs))。
# 这里统一改成"先写临时 .js 文件，再执行文件"，两种版本行为一致。
# ------------------------------------------------------------
$Script:LastNodeExit = 0
function Invoke-NodeJs {
    param([string]$Name, [string]$Code)
    $f = Join-Path $Script:TmpJsDir ($Name + '.js')
    [System.IO.File]::WriteAllText($f, $Code, (New-Object System.Text.UTF8Encoding($false)))
    $out = & $Script:NodeExe $f 2>&1
    $Script:LastNodeExit = $LASTEXITCODE
    return $out
}

# --- ethers ---
$null = Invoke-NodeJs 'check-ethers' 'require("ethers");'
if ($Script:LastNodeExit -ne 0) {
    Write-Host "安装依赖 ethers@6 ..."
    # 优先用 npm.cmd: Windows 上同时有 npm.cmd / npm.ps1，直接调 npm.ps1 会受执行策略限制
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npmCmd) { Write-Die "未找到 npm，请重装 Node.js" }
    $npmExe = $npmCmd.Source
    for ($t = 1; $t -le 3; $t++) {
        & $npmExe install ethers@6 --no-audit --no-fund 2>&1 | Out-Host
        $null = Invoke-NodeJs 'check-ethers' 'require("ethers");'
        if ($Script:LastNodeExit -eq 0) { break }
        Write-WarnMsg "第 $t 次安装失败，2 秒后重试..."
        Start-Sleep -Seconds 2
    }
    if ($Script:LastNodeExit -ne 0) {
        Write-WarnMsg "默认源安装失败，改用国内镜像临时重试(不改你的 npm 配置)..."
        & $npmExe install ethers@6 --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | Out-Host
        $null = Invoke-NodeJs 'check-ethers' 'require("ethers");'
    }
    if ($Script:LastNodeExit -ne 0) { Write-Die "ethers 安装失败，请手动执行: cd `"$Script:WorkDir`"; npm install ethers@6" }
}
$ethVer = Invoke-NodeJs 'ver-ethers' 'console.log(require("ethers").version);'
Write-Ok "ethers $ethVer 已就绪"

# --- ws (WebSocket，缺失时自动降级为 HTTP 轮询) ---
$null = Invoke-NodeJs 'check-ws' 'try{require("ws")}catch(e){process.exit(1)}'
if ($Script:LastNodeExit -ne 0) {
    Write-Host "安装 WebSocket 依赖 ws ..."
    $npmCmd2 = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCmd2) { $npmCmd2 = Get-Command npm -ErrorAction SilentlyContinue }
    if ($npmCmd2) { & $npmCmd2.Source install ws --no-audit --no-fund 2>&1 | Out-Host }
    $null = Invoke-NodeJs 'check-ws' 'try{require("ws")}catch(e){process.exit(1)}'
    if ($Script:LastNodeExit -ne 0) { Write-WarnMsg "ws 安装失败，将自动使用 HTTP 轮询模式兜底(仍可正常工作)" }
}

# ============================================================
Write-Step "[2/5] 写入核心引擎..."
$CoreJs = @'
@@CORE_JS@@
'@
$ProbeJs = @'
@@PROBE_JS@@
'@

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# 末尾补一个换行，让生成的文件与 Linux 版完全一致(here-string 不含结尾换行)
[System.IO.File]::WriteAllText((Join-Path $Script:WorkDir 'core.js'),  $CoreJs  + "`r`n", $Utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $Script:WorkDir 'probe.js'), $ProbeJs + "`r`n", $Utf8NoBom)

& $Script:NodeExe --check core.js 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Die "core.js 生成异常(语法错误)" }
& $Script:NodeExe --check probe.js 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Die "probe.js 生成异常(语法错误)" }
Write-Ok "核心引擎 core.js + 只读探针 probe.js 已写入"

# --probe 是纯只读探测，必须在"要求输入私钥"之前退出
if ($Mode -eq 'probe') {
    Write-Host ""
    & $Script:NodeExe probe.js @ProbeArgs
    exit $LASTEXITCODE
}

# ============================================================
# [3/5] 引导配置页
# ============================================================
# 只放"日常真的要改"的项；节点池、并发、超时等高级参数请直接改 config.json

$Script:WizRooms = '0,1,2'; $Script:WizMin = '30'; $Script:WizMax = '60'; $Script:WizDelay = '0'
$Script:WizGasMode = 'fixed'; $Script:WizGasFixed = '0.05'; $Script:WizGasMax = '10'; $Script:WizGasMult = '1.25'
$Script:WizClaim = '30'; $Script:WizBnb = '0.005'

function Load-Wiz {
    if (-not (Test-Path -LiteralPath 'config.json')) { return }
    $code = @'
const fs=require("fs");
let c={};
try{c=JSON.parse(fs.readFileSync("config.json","utf8"))}catch(e){}
const put=(k,v)=>{ if(v!==undefined&&v!==null&&v!=="") console.log(k+"="+(Array.isArray(v)?v.join(","):String(v))); };
put("ROOMS",c.ROOMS);
put("SNIPE_MIN_COUNT",c.SNIPE_MIN_COUNT);
put("SNIPE_MAX_COUNT",c.SNIPE_MAX_COUNT);
put("SNIPE_DELAY_MS",c.SNIPE_DELAY_MS);
put("CLAIM_INTERVAL_MS",c.CLAIM_INTERVAL_MS);
put("MIN_BNB_GAS",c.MIN_BNB_GAS);
console.log("GAS_MODE="+(c.GAS_GWEI===null?"auto":"fixed"));
put("GAS_GWEI",c.GAS_GWEI);
put("GAS_MAX_GWEI",c.GAS_MAX_GWEI);
put("GAS_MULT",c.GAS_MULT);
'@
    $lines = Invoke-NodeJs 'cfg-read' $code
    foreach ($l in $lines) {
        if ($l -match '^([A-Z_]+)=(.*)$') {
            $k = $Matches[1]; $v = $Matches[2]
            switch ($k) {
                'ROOMS'             { $Script:WizRooms = $v }
                'SNIPE_MIN_COUNT'   { $Script:WizMin = $v }
                'SNIPE_MAX_COUNT'   { $Script:WizMax = $v }
                'SNIPE_DELAY_MS'    { $Script:WizDelay = $v }
                'CLAIM_INTERVAL_MS' {
                    # config.json 被手改成非法值时不能把整个向导搞崩
                    try { $Script:WizClaim = [string][int]([double]$v / 1000) } catch { }
                }
                'MIN_BNB_GAS'       { $Script:WizBnb = $v }
                'GAS_MODE'          { if ($v -eq 'auto') { $Script:WizGasMode = 'auto' } else { $Script:WizGasMode = 'fixed' } }
                'GAS_GWEI'          { $Script:WizGasFixed = $v; $Script:WizGasMode = 'fixed' }
                'GAS_MAX_GWEI'      { $Script:WizGasMax = $v }
                'GAS_MULT'          { $Script:WizGasMult = $v }
            }
        }
    }
}

function Get-RoomsText {
    $out = @()
    foreach ($i in ($Script:WizRooms -split ',')) {
        $t = $i.Trim()
        if (-not $t) { continue }
        switch ($t) {
            '0' { $out += '10U' }
            '1' { $out += '50U' }
            '2' { $out += '100U' }
            default { $out += "房间$t" }
        }
    }
    if ($out.Count -eq 0) { return '未选择' }
    return ($out -join ' / ')
}

function Get-GasText {
    if ($Script:WizGasMode -eq 'fixed') { return "固定 $($Script:WizGasFixed) gwei" }
    return "自动(链上价 x$($Script:WizGasMult)，上限 $($Script:WizGasMax) gwei)"
}

function Get-AccountCount {
    if (-not (Test-Path -LiteralPath 'wallets.json')) { return 0 }
    $code = 'try{const d=JSON.parse(require("fs").readFileSync("wallets.json","utf8"));console.log((d.wallets||[]).length)}catch(e){console.log(0)}'
    $n = Invoke-NodeJs 'acc-count' $code
    if ("$n" -match '^\d+$') { return [int]$n }
    return 0
}

function Show-WizHeader {
    # 输出被重定向时(比如写日志)不要清屏，否则会刷一堆空行
    if (-not [Console]::IsOutputRedirected) { try { Clear-Host } catch { } }
    Write-Host ""
    Write-Host "  +----------------------------------------------------+" -ForegroundColor DarkCyan
    Write-Host "  |          FTS 自动打金 - 引导配置                   |" -ForegroundColor DarkCyan
    Write-Host "  +----------------------------------------------------+" -ForegroundColor DarkCyan
    Write-Host "    账号数量   : $(Get-AccountCount) 个"
    Write-Host "    参与房间   : $(Get-RoomsText)"
    Write-Host "    抢位区间   : $($Script:WizMin) ~ $($Script:WizMax) 人"
    Write-Host "    抢单延迟   : $($Script:WizDelay) ms"
    Write-Host "    手续费     : $(Get-GasText)"
    Write-Host "    领取间隔   : $($Script:WizClaim) 秒"
    Write-Host "    最低 BNB   : $($Script:WizBnb)"
    Write-Host "  ----------------------------------------------------"
}

function Ask-Int {
    param([string]$Prompt, [string]$Default, [int]$Min, [int]$Max)
    while ($true) {
        $v = Read-Host "    $Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($v)) { $v = $Default }
        $n = 0
        if (-not [int]::TryParse($v, [ref]$n)) { Write-WarnMsg "请输入整数"; continue }
        if ($n -lt $Min -or $n -gt $Max) { Write-WarnMsg "取值范围 $Min ~ $Max"; continue }
        return [string]$n
    }
}

function Ask-Dec {
    param([string]$Prompt, [string]$Default, [double]$Min, [double]$Max)
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    while ($true) {
        $v = Read-Host "    $Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($v)) { $v = $Default }
        if ($v -notmatch '^\d+(\.\d+)?$') { Write-WarnMsg "请输入数字(小数点用 .)"; continue }
        $d = 0.0
        if (-not [double]::TryParse($v, [System.Globalization.NumberStyles]::Float, $inv, [ref]$d)) { Write-WarnMsg "请输入数字"; continue }
        if ($d -lt $Min -or $d -gt $Max) { Write-WarnMsg "取值范围 $Min ~ $Max"; continue }
        return $v
    }
}

function Edit-Rooms {
    Show-WizHeader
    Write-Host "    选择参与的房间(可多选，逗号分隔)"
    Write-Host "      0 = 10U    1 = 50U    2 = 100U"
    Write-Host "    当前: $($Script:WizRooms)"
    $v = Read-Host "    请输入(如 0 或 0,1)"
    if ([string]::IsNullOrWhiteSpace($v)) { $v = $Script:WizRooms }
    $v = $v -replace '\s', ''
    if ($v -notmatch '^[0-2](,[0-2])*$') { Write-WarnMsg "只能填 0/1/2，用英文逗号分隔"; Start-Sleep -Seconds 1; return }
    $out = @()
    foreach ($i in '0', '1', '2') { if (",$v," -like "*,$i,*") { $out += $i } }
    $Script:WizRooms = ($out -join ',')
}

function Edit-Range {
    Show-WizHeader
    Write-Host "    抢位区间: 当前轮排队人数落在这个范围内才入场"
    Write-Host "      太小 -> 还没轮到你名额就满了；太大 -> 中签率低"
    $lo = Ask-Int "人数下限" $Script:WizMin 0 9999
    $hi = Ask-Int "人数上限" $Script:WizMax 1 10000
    if ([int]$lo -ge [int]$hi) { Write-WarnMsg "下限必须小于上限，本次修改已放弃"; Start-Sleep -Seconds 1; return }
    $Script:WizMin = $lo; $Script:WizMax = $hi
}

function Edit-Delay {
    Show-WizHeader
    Write-Host "    抢单延迟: 轮次开始后等待多少毫秒再入场"
    Write-Host "      0 = 立即入场；适当延迟可避开开轮瞬间的拥堵"
    $Script:WizDelay = Ask-Int "延迟(毫秒)" $Script:WizDelay 0 60000
}

function Edit-Gas {
    Show-WizHeader
    Write-Host "    ---- 手续费 / Gas ----"
    Write-Host "      [1] 固定 gas 价(默认 0.05 gwei，每笔都按这个价发)"
    Write-Host "      [2] 自动: 按链上实时价上浮，并设上限保护"
    Write-Host "    当前: $(Get-GasText)"
    $ch = Read-Host "    请选择 [1/2]"
    if ($ch -eq '2') {
        $Script:WizGasMult = Ask-Dec "上浮倍数(相对链上实时价)" $Script:WizGasMult 1 5
        $Script:WizGasMax  = Ask-Dec "gas 上限 (gwei，防止拥堵时被扣爆)" $Script:WizGasMax 0.5 200
        $Script:WizGasMode = 'auto'
    } else {
        $def = '0.05'
        if ($Script:WizGasFixed) { $def = $Script:WizGasFixed }
        $Script:WizGasFixed = Ask-Dec "固定 gas 价 (gwei)" $def 0.01 200
        $Script:WizGasMode = 'fixed'
    }
}

function Edit-Claim {
    Show-WizHeader
    Write-Host "    领取返利间隔: 每隔多少秒扫一次可领取的退款/空投"
    Write-Host "      太小浪费节点额度，太大会漏领"
    $Script:WizClaim = Ask-Int "间隔(秒)" $Script:WizClaim 10 3600
}

function Edit-Bnb {
    Show-WizHeader
    Write-Host "    最低 BNB 余额: 低于这个值只提醒，不中断运行"
    $Script:WizBnb = Ask-Dec "最低 BNB" $Script:WizBnb 0 1
}

function Add-Account {
    Show-WizHeader
    Write-Host "    ---- 添加账号 ----"
    if (-not (Test-Path -LiteralPath 'wallets.json')) { Set-Content -LiteralPath 'wallets.json' -Value '{"wallets": []}' -Encoding ASCII }

    $pk = ''
    while ($true) {
        $sec = Read-Host "    私钥 (64位hex，可不带0x，输入不显示)" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        # SecureString 内部是 UTF-16，必须用 PtrToStringBSTR；
        # PtrToStringAuto 依赖系统 ANSI/Unicode 模式，跨机器可能解出乱码
        try { $pk = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $pk = "$pk".Trim()
        if ($pk -match '^0x') { $pk = $pk.Substring(2) }
        if ($pk -match '^[0-9a-fA-F]{64}$') { break }
        Write-WarnMsg "私钥格式错误(必须是 64 位十六进制)"
    }
    $addr = ''
    while ($true) {
        $addr = "$(Read-Host '    钱包地址 (0x开头)')".Trim()
        if ($addr -match '^0x[a-fA-F0-9]{40}$') { break }
        Write-WarnMsg "地址格式错误"
    }
    $ref = ''
    while ($true) {
        $ref = "$(Read-Host '    推荐人地址 (0x开头)')".Trim()
        if ($ref -match '^0x[a-fA-F0-9]{40}$') { break }
        Write-WarnMsg "推荐人地址格式错误"
    }

    $env:FTS_PK = $pk; $env:FTS_ADDR = $addr; $env:FTS_REF = $ref
    $code = @'
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("wallets.json","utf8"));
if(d.wallets.some(w=>String(w.ADDRESS).toLowerCase()===process.env.FTS_ADDR.toLowerCase())){
  console.error("该地址已在列表中"); process.exit(2);
}
d.wallets.push({PRIVATE_KEY:process.env.FTS_PK,ADDRESS:process.env.FTS_ADDR,REFERRER:process.env.FTS_REF});
const tmp="wallets.json.tmp";
fs.writeFileSync(tmp,JSON.stringify(d,null,2),{mode:0o600});
fs.renameSync(tmp,"wallets.json");
'@
    $out = Invoke-NodeJs 'wallet-add' $code
    Remove-Item Env:FTS_PK -ErrorAction SilentlyContinue
    Remove-Item Env:FTS_ADDR -ErrorAction SilentlyContinue
    Remove-Item Env:FTS_REF -ErrorAction SilentlyContinue
    if ($Script:LastNodeExit -ne 0) {
        foreach ($l in $out) { Write-WarnMsg "$l" }
        Start-Sleep -Seconds 1
        return
    }
    Write-Ok "账号 $addr 已添加"
    Start-Sleep -Seconds 1
}

function Clear-Accounts {
    $a = Read-Host "    确认清空全部账号? 不可恢复 (y/N)"
    if ($a -match '^[Yy]') {
        Set-Content -LiteralPath 'wallets.json' -Value '{"wallets": []}' -Encoding ASCII
        Write-Ok "已清空"
    } else {
        Write-Host "    已取消"
    }
    Start-Sleep -Seconds 1
}

function Show-Accounts {
    while ($true) {
        Show-WizHeader
        Write-Host "    ---- 账号管理 ----"
        if (Test-Path -LiteralPath 'wallets.json') {
            $code = 'try{const d=JSON.parse(require("fs").readFileSync("wallets.json","utf8"));if(!d.wallets.length)console.log("    (还没有账号)");d.wallets.forEach((w,i)=>console.log("    ["+(i+1)+"] "+w.ADDRESS+"   推荐人 "+w.REFERRER));}catch(e){console.log("    (还没有账号)")}'
            $lines = Invoke-NodeJs 'acc-list' $code
            foreach ($l in $lines) { Write-Host "$l" }
        } else {
            Write-Host "    (还没有账号)"
        }
        Write-Host "    ------------------------------------------------"
        Write-Host "      [1] 添加账号    [2] 清空重录    [0] 返回"
        $ch = Read-Host "    请选择"
        switch ($ch) {
            '1' { Add-Account }
            '2' { Clear-Accounts }
            default { return }
        }
    }
}

function Reset-Defaults {
    $a = Read-Host "    恢复全部设置为默认值? (y/N)"
    if ($a -match '^[Yy]') {
        $Script:WizRooms = '0,1,2'; $Script:WizMin = '30'; $Script:WizMax = '60'; $Script:WizDelay = '0'
        $Script:WizGasMode = 'fixed'; $Script:WizGasFixed = '0.05'; $Script:WizGasMax = '10'; $Script:WizGasMult = '1.25'
        $Script:WizClaim = '30'; $Script:WizBnb = '0.005'
        Write-Ok "已恢复默认(尚未保存)"
    } else {
        Write-Host "    已取消"
    }
    Start-Sleep -Seconds 1
}

function Save-Wiz {
    if ([string]::IsNullOrWhiteSpace($Script:WizRooms)) { Write-WarnMsg "至少要选一个房间"; Start-Sleep -Seconds 1; return $false }
    if ([int]$Script:WizMin -ge [int]$Script:WizMax) { Write-WarnMsg "抢位下限必须小于上限"; Start-Sleep -Seconds 1; return $false }

    $env:WIZ_ROOMS = $Script:WizRooms
    $env:WIZ_MIN = $Script:WizMin
    $env:WIZ_MAX = $Script:WizMax
    $env:WIZ_DELAY = $Script:WizDelay
    $env:WIZ_GAS_MODE = $Script:WizGasMode
    $env:WIZ_GAS_FIXED = $Script:WizGasFixed
    $env:WIZ_GAS_MAX = $Script:WizGasMax
    $env:WIZ_GAS_MULT = $Script:WizGasMult
    $env:WIZ_CLAIM = $Script:WizClaim
    $env:WIZ_BNB = $Script:WizBnb

    $code = @'
const fs=require("fs");
let c={};
try{c=JSON.parse(fs.readFileSync("config.json","utf8"))}catch(e){}
const e=process.env;
c.ROOMS=String(e.WIZ_ROOMS||"0,1,2").split(",").map(s=>Number(s.trim())).filter(n=>!isNaN(n));
c.SNIPE_MIN_COUNT=Number(e.WIZ_MIN);
c.SNIPE_MAX_COUNT=Number(e.WIZ_MAX);
c.SNIPE_DELAY_MS=Number(e.WIZ_DELAY);
c.CLAIM_INTERVAL_MS=Number(e.WIZ_CLAIM)*1000;
c.MIN_BNB_GAS=Number(e.WIZ_BNB);
c.GAS_MAX_GWEI=Number(e.WIZ_GAS_MAX);
c.GAS_MULT=Number(e.WIZ_GAS_MULT);
if(e.WIZ_GAS_MODE==="fixed")c.GAS_GWEI=Number(e.WIZ_GAS_FIXED);else c.GAS_GWEI=null;
const tmp="config.json.tmp";
fs.writeFileSync(tmp,JSON.stringify(c,null,2)+"\n");
fs.renameSync(tmp,"config.json");
'@
    $null = Invoke-NodeJs 'cfg-write' $code
    $rc = $Script:LastNodeExit
    foreach ($k in 'WIZ_ROOMS','WIZ_MIN','WIZ_MAX','WIZ_DELAY','WIZ_GAS_MODE','WIZ_GAS_FIXED','WIZ_GAS_MAX','WIZ_GAS_MULT','WIZ_CLAIM','WIZ_BNB') {
        Remove-Item "Env:$k" -ErrorAction SilentlyContinue
    }
    if ($rc -ne 0) { Write-WarnMsg "写入 config.json 失败"; Start-Sleep -Seconds 1; return $false }

    # 老版本会在每个账号里存 SNIPE_MIN/MAX/DELAY，会覆盖全局设置 -> 提示统一
    $chk = 'try{const d=JSON.parse(require("fs").readFileSync("wallets.json","utf8"));console.log(d.wallets.filter(w=>w.SNIPE_MIN_COUNT!==undefined||w.SNIPE_MAX_COUNT!==undefined||w.SNIPE_DELAY_MS!==undefined).length)}catch(e){console.log(0)}'
    $ov = Invoke-NodeJs 'cfg-ovr' $chk
    if ("$ov" -match '^\d+$' -and [int]$ov -gt 0) {
        Write-Host ""
        Write-WarnMsg "有 $ov 个账号带独立抢位设置，会覆盖上面的全局值"
        $a = Read-Host "    改为统一使用全局设置? (Y/n)"
        if ($a -notmatch '^[Nn]') {
            $strip = @'
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("wallets.json","utf8"));
d.wallets.forEach(w=>{delete w.SNIPE_MIN_COUNT;delete w.SNIPE_MAX_COUNT;delete w.SNIPE_DELAY_MS;});
const tmp="wallets.json.tmp";
fs.writeFileSync(tmp,JSON.stringify(d,null,2),{mode:0o600});
fs.renameSync(tmp,"wallets.json");
'@
            $null = Invoke-NodeJs 'wallet-strip' $strip
            Write-Ok "已统一为全局设置"
        } else {
            Write-Host "    保留账号独立设置(全局值对这些账号不生效)"
        }
    }
    return $true
}

function Invoke-Wizard {
    Load-Wiz
    while ($true) {
        Show-WizHeader
        Write-Host "      [1] 参与房间          [2] 抢位人数区间"
        Write-Host "      [3] 抢单延迟          [4] 手续费 / Gas"
        Write-Host "      [5] 领取返利间隔      [6] 最低 BNB 余额"
        Write-Host "      [7] 账号管理          [8] 恢复默认值"
        Write-Host "      [9] 保存并退出        [0] 不保存退出"
        Write-Host "  ----------------------------------------------------"
        $ch = Read-Host "    请选择"
        switch ($ch) {
            '1' { Edit-Rooms }
            '2' { Edit-Range }
            '3' { Edit-Delay }
            '4' { Edit-Gas }
            '5' { Edit-Claim }
            '6' { Edit-Bnb }
            '7' { Show-Accounts }
            '8' { Reset-Defaults }
            '9' { if (Save-Wiz) { return $true } }
            '0' { Write-Host ""; Write-Host "  已退出，未做任何修改"; return $false }
        }
    }
}

# ---- 进入引导页 ----
if ($DoInit -or $DoWizard -or (-not (Test-Path -LiteralPath 'wallets.json'))) {
    Write-Step "[3/5] 配置向导..."
    if ([Console]::IsInputRedirected -and $env:FTS_ALLOW_PIPE_INIT -ne '1') {
        Write-Die "配置向导需要交互式终端。请在 PowerShell 窗口里直接执行: powershell -ExecutionPolicy Bypass -File autofts.ps1 --init"
    }
    if (Invoke-Wizard) {
        Write-Host ""
        Write-Ok "配置已保存到 config.json（账号在 wallets.json）"
        Write-Host "  当前设置: 房间=$(Get-RoomsText) 抢位=$($Script:WizMin)~$($Script:WizMax) 延迟=$($Script:WizDelay)ms 手续费=$(Get-GasText)"
        Write-Host ""
        Write-Host "下一步建议(按顺序):"
        Write-Host "  powershell -ExecutionPolicy Bypass -File autofts.ps1 --selftest   # 只读体检，一分钱不花"
        Write-Host "  powershell -ExecutionPolicy Bypass -File autofts.ps1 --dry-run    # 全流程演练，交易不上链"
        Write-Host "  powershell -ExecutionPolicy Bypass -File autofts.ps1 --run        # 确认无误后再正式运行"
    }
    exit 0
}

$vcode = @'
const fs=require("fs");
let d;
try{d=JSON.parse(fs.readFileSync("wallets.json","utf8"))}
catch(e){console.error("wallets.json 不是合法的 JSON: "+e.message);process.exit(1)}
if(!d||!Array.isArray(d.wallets)||d.wallets.length===0){console.error("wallets.json 中没有账号");process.exit(1)}
console.log("已加载 "+d.wallets.length+" 个账号配置");
'@
$vout = Invoke-NodeJs 'wallet-check' $vcode
foreach ($l in $vout) { Write-Host "$l" }
if ($Script:LastNodeExit -ne 0) { Write-Die "wallets.json 无效或为空，请执行: powershell -ExecutionPolicy Bypass -File autofts.ps1 --init" }

# ============================================================
if ($Mode -eq 'selftest') {
    Write-Step "[4/5] 启动准备..."
    Write-Step "[5/5] 运行自检 (模式: selftest)..."
    Write-Host "--------------------------------------------------------"
    & $Script:NodeExe core.js selftest
    exit $LASTEXITCODE
}

Write-Step "[4/5] 启动准备..."
Write-Step "[5/5] 启动引擎 (模式: $Mode)..."
Write-Host "--------------------------------------------------------"

# 清掉上一轮遗留的停止标志
Remove-Item -LiteralPath $Script:StopFlag -Force -ErrorAction SilentlyContinue

# 日志清理: 只保留最近 7 天
Get-ChildItem -Path $Script:LogDir -Filter 'fts-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

$restarts   = 0
$restartMax = 50
if ($env:FTS_RESTART_MAX -match '^\d+$') { $restartMax = [int]$env:FTS_RESTART_MAX }
$stableReset = 300
if ($env:FTS_STABLE_RESET -match '^\d+$') { $stableReset = [int]$env:FTS_STABLE_RESET }

$running = $true
while ($running) {
    if (Test-Path -LiteralPath $Script:StopFlag) {
        Write-Host "检测到停止标志，外壳循环退出"
        Remove-Item -LiteralPath $Script:StopFlag -Force -ErrorAction SilentlyContinue
        break
    }

    $startTs = Get-Date
    # 不用 Start-Process: PS 5.1 在环境里同时存在 Path / PATH 时会抛
    # "Item has already been added. Key in dictionary: 'Path'"，导致子进程根本起不来。
    # 直接用 .NET Process，行为稳定，且子进程会继承当前控制台(输出实时可见)。
    $code = -1
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Script:NodeExe
        # 用绝对路径启动: 这样进程命令行里带完整路径，--stop 的兜底匹配才不会误杀别的项目
        $psi.Arguments = '"' + (Join-Path $Script:WorkDir 'core.js') + '" ' + $Mode
        $psi.WorkingDirectory = $Script:WorkDir
        $psi.UseShellExecute = $false
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $null = $proc.Start()
        Set-Content -LiteralPath $Script:PidFile -Value @("shell=$PID", "node=$($proc.Id)") -Encoding ASCII -ErrorAction SilentlyContinue
        $proc.WaitForExit()
        $code = $proc.ExitCode
    } catch {
        Write-ErrMsg "启动引擎失败: $($_.Exception.Message)"
        $code = -1
    } finally {
        if ($proc) { try { $proc.Dispose() } catch { } }
        Remove-Item -LiteralPath $Script:PidFile -Force -ErrorAction SilentlyContinue
    }

    $ranSec = [int]((Get-Date) - $startTs).TotalSeconds
    if ($ranSec -ge $stableReset -and $restarts -ne 0) {
        Write-Host "已稳定运行 ${ranSec}s(>= ${stableReset}s)，崩溃计数重置为 0"
        $restarts = 0
    }

    if (Test-Path -LiteralPath $Script:StopFlag) {
        Write-Host "检测到停止标志，外壳循环退出"
        Remove-Item -LiteralPath $Script:StopFlag -Force -ErrorAction SilentlyContinue
        break
    }

    if ($null -eq $code) { $code = -1 }
    if ($code -eq 0) {
        Write-Host "引擎正常退出"
        break
    }
    elseif ($code -eq 20) {
        Write-Die "依赖缺失，请先安装 ethers (npm install ethers@6)"
    }
    elseif ($code -eq 21) {
        Write-Die "没有可用账号，请执行: powershell -ExecutionPolicy Bypass -File autofts.ps1 --init"
    }
    elseif ($code -eq 22) {
        Write-WarnMsg "RPC 全部不可用，10 秒后重试..."
        Start-Sleep -Seconds 10
        $restarts++
    }
    else {
        $restarts++
        if ($restarts -gt $restartMax) { Write-Die "连续崩溃超过 $restartMax 次，停止重启。请查看 logs/ 排查" }
        $wait = $restarts * 2
        if ($wait -gt 30) { $wait = 30 }
        Write-WarnMsg "引擎退出(码 $code)，${wait}s 后第 $restarts 次重启..."
        Start-Sleep -Seconds $wait
    }
}

Write-Host ""
Write-Host "正在退出..."
Remove-Item -LiteralPath $Script:PidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Script:StopFlag -Force -ErrorAction SilentlyContinue
exit 0
