#!/bin/bash
# ==============================================================
# FTS 多账号自动打金脚本 - 加固版 v2.4 (Termux / Linux 通用)
# ==============================================================
set -uo pipefail

# 告诉内嵌的 core.js/probe.js "我是被哪个启动器拉起来的"，用于提示文案
export FTS_LAUNCHER=bash

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WORK_DIR" || exit 1
mkdir -p logs
# Windows 上用记事本把 json 存成 "UTF-8 带 BOM" 时，JSON.parse 会直接抛错、
# 整份配置被静默忽略。启动时统一把 BOM 去掉，一劳永逸。
strip_bom() {
  [ -f "$1" ] || return 0
  node -e 'const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8");if(s.charCodeAt(0)===0xFEFF){fs.writeFileSync(p,s.slice(1),"utf8");console.log("已移除 BOM: "+p)}' "$1" 2>/dev/null || true
}
strip_bom config.json
strip_bom wallets.json

PID_FILE="$WORK_DIR/logs/engine.pid"
STOP_FLAG="$WORK_DIR/logs/.stop"   # --stop 的"可靠信号": 即使 PID 丢失/被复用也能让外壳循环退出

MODE="run"
DO_INIT=0
DO_WIZARD=0
PROBE_ARGS=""

usage() {
  cat << 'HELP'
用法: bash autofts.sh [模式]

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
  GAS_GWEI           固定 gas 价，默认 0.05；写 null 则改为自动(按链上价 × GAS_MULT)
  CLAIM_INTERVAL_MS  领取返利扫描间隔，默认 30000
  MIN_BNB_GAS        最低 BNB 提醒阈值，默认 0.005
HELP
  exit 0
}

ok_msg() { echo -e "\e[32m✅ $*\e[0m"; }
warn_msg() { echo -e "\e[33m⚠️  $*\e[0m"; }
die() { echo -e "\e[31m❌ [FATAL] $*\e[0m"; exit 1; }

# ---- 唤醒锁: 统一登记，任何退出路径都能释放 ----
WAKE_LOCKED=0
release_wake() {
  if [ "$WAKE_LOCKED" = 1 ]; then
    command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
    echo "已释放唤醒锁"
    WAKE_LOCKED=0
  fi
}
acquire_wake() {
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock && WAKE_LOCKED=1 && ok_msg "已获取 CPU 唤醒锁(息屏不断网)"
  else
    warn_msg "未找到 termux-wake-lock。可选: pkg install termux-api"
    warn_msg "建议同时: 系统设置 -> 电池优化 -> 将 Termux 设为不优化，否则息屏后可能被杀"
  fi
}
# 任何退出/中断都先释放唤醒锁，避免手机一直亮屏耗电
on_exit() { release_wake; }
trap on_exit EXIT INT TERM

stop_engine() {
  # 关键: 必须先停"外壳 while 循环"，再停 node。
  # 只停 node 的话，外壳会以为程序崩了，几秒后又把 node 拉起来(--stop 停不下来的根因)。
  local node_pid="" shell_pid="" found=0 p cl=""

  # 0) 先落"停止标志"。外壳循环每轮开头都会检查它，
  #    这样即使 PID 文件丢了 / PID 被复用 / 没有 pgrep，也一定能停下来。
  : > "$STOP_FLAG" 2>/dev/null || true

  if [ -f "$PID_FILE" ]; then
    node_pid="$(sed -n 's/^node=//p'  "$PID_FILE" 2>/dev/null | head -1)"
    shell_pid="$(sed -n 's/^shell=//p' "$PID_FILE" 2>/dev/null | head -1)"
  fi

  # PID 复用防护: 手机重启后 PID 会被别的进程占用，直接 kill 会误杀无辜进程
  alive_ours() {
    local q="$1" cmd=""
    [ -n "$q" ] || return 1
    kill -0 "$q" 2>/dev/null || return 1
    cmd="$(ps -p "$q" -o args= 2>/dev/null || echo '')"
    [ -z "$cmd" ] && return 0          # ps 不支持 -o 时(部分 Termux)退化为只校验存活
    case "$cmd" in *autofts.sh*|*core.js*|*probe.js*) return 0 ;; esac
    return 1
  }

  if alive_ours "$shell_pid"; then
    kill -TERM "$shell_pid" 2>/dev/null
    found=1
    echo "已停止外壳守护循环 (PID $shell_pid)"
  fi
  if alive_ours "$node_pid"; then
    kill -TERM "$node_pid" 2>/dev/null
    found=1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$node_pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$node_pid" 2>/dev/null && kill -KILL "$node_pid" 2>/dev/null
    echo "已停止引擎 (PID $node_pid)"
  fi
  rm -f "$PID_FILE"

  # 兜底(PID 文件丢失的情况)，Termux 原生可能没有 pkill，优先用 pgrep
  if command -v pgrep >/dev/null 2>&1; then
    p="$(pgrep -f "$WORK_DIR/core.js" 2>/dev/null | tr '\n' ' ' || true)"
    if [ -n "${p// /}" ]; then
      # shellcheck disable=SC2086
      kill -TERM $p 2>/dev/null
      sleep 1
      # shellcheck disable=SC2086
      kill -KILL $p 2>/dev/null
      echo "已停止运行中的引擎(PID: $p)"
      found=1
    fi
  elif command -v pkill >/dev/null 2>&1; then
    if pkill -f "$WORK_DIR/core.js" 2>/dev/null; then echo "已停止运行中的引擎(pkill 兜底)"; found=1; fi
  fi

  if [ "$found" = 0 ]; then
    echo "当前没有运行中的引擎"
    rm -f "$STOP_FLAG"     # 没东西可停就把标志清掉，免得下次 --run 刚启动就被它打断
  fi
  release_wake
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --probe)
      MODE="probe"; shift
      PROBE_ARGS="$*"; break ;;
    --selftest) MODE="selftest" ;;
    --dry-run)  MODE="dry-run" ;;
    --run)      MODE="run" ;;
    --init)     DO_INIT=1 ;;
    --settings) DO_WIZARD=1 ;;
    --stop)     stop_engine ;;
    -h|--help)  usage ;;
    *) echo "未知参数: $1 (用 --help 查看用法)"; exit 2 ;;
  esac
  shift
done

# ==============================================================
echo -e "\e[33m[1/5] 检查运行环境...\e[0m"
IS_TERMUX=0
case "${PREFIX:-}" in *com.termux*) IS_TERMUX=1 ;; esac
if [ "$IS_TERMUX" = 1 ]; then ok_msg "Termux 环境 ($PREFIX)"; else echo "非 Termux 环境，按通用 Linux 处理"; fi

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
  warn_msg "未找到 Node.js，尝试安装..."
  if [ "$IS_TERMUX" = 1 ] && command -v pkg >/dev/null 2>&1; then
    pkg install nodejs-lts -y || die "Node.js 安装失败，请手动执行: pkg install nodejs-lts"
  else
    die "未找到 Node.js。Termux 请执行: pkg install nodejs-lts"
  fi
fi
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -z "${NODE_MAJOR:-}" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node 版本过低 ($(node -v))，需要 >= 18。Termux: pkg install nodejs-lts"
fi
ok_msg "Node $(node -v) / npm $(npm -v 2>/dev/null || echo '?')"

# --- ethers ---
if ! node -e "require('ethers')" >/dev/null 2>&1; then
  echo "安装依赖 ethers@6 ..."
  # 注意: 不要用 "npm config set registry"，那会永久改写用户的 ~/.npmrc。
  # 这里只在"默认源失败"时临时带 --registry 参数重试，不改任何全局配置。
  for i in 1 2 3; do
    npm install ethers@6 --no-audit --no-fund && break
    warn_msg "第 $i 次安装失败，2 秒后重试..."
    sleep 2
  done
  if ! node -e "require('ethers')" >/dev/null 2>&1; then
    warn_msg "默认源安装失败，改用国内镜像临时重试(不改你的 npm 配置)..."
    npm install ethers@6 --no-audit --no-fund --registry=https://registry.npmmirror.com || true
  fi
  node -e "require('ethers')" >/dev/null 2>&1 || die "ethers 安装失败，请手动执行: cd $WORK_DIR && npm install ethers@6"
fi
ok_msg "ethers $(node -e "console.log(require('ethers').version)" 2>/dev/null || echo '?') 已就绪"

# --- ws (WebSocket 依赖，缺失时自动降级为 HTTP 轮询) ---
if ! node -e "try{require('ws')}catch(e){process.exit(1)}" >/dev/null 2>&1; then
  echo "安装 WebSocket 依赖 ws ..."
  npm install ws --no-audit --no-fund >/dev/null 2>&1 || warn_msg "ws 安装失败，将自动使用 HTTP 轮询模式兜底(仍可正常工作)"
fi

# ==============================================================
echo -e "\e[33m[2/5] 写入核心引擎...\e[0m"
cat << 'CORE_EOF' > core.js
@@CORE_JS@@
CORE_EOF
cat << 'PROBE_EOF' > probe.js
@@PROBE_JS@@
PROBE_EOF
node --check core.js || die "core.js 生成异常(语法错误)"
node --check probe.js || die "probe.js 生成异常(语法错误)"
ok_msg "核心引擎 core.js + 只读探针 probe.js 已写入"

# --probe 是纯只读探测，必须在"要求输入私钥"之前退出
if [ "$MODE" = "probe" ]; then
  echo ""
  # shellcheck disable=SC2086
  node probe.js $PROBE_ARGS
  exit $?
fi

# ==============================================================
# [3/5] 引导配置页
# ==============================================================
# 设计原则: 只放"日常真的要改"的项 —— 房间 / 抢位区间 / 延迟 / 手续费 / 领取间隔 / 最低BNB / 账号。
# 节点池、并发数、超时这些调错就出事的高级参数不放在这里，需要时直接改 config.json。

WIZ_ROOMS="0,1,2"; WIZ_MIN="30"; WIZ_MAX="60"; WIZ_DELAY="0"
WIZ_GAS_MODE="fixed"; WIZ_GAS_FIXED="0.05"; WIZ_GAS_MAX="10"; WIZ_GAS_MULT="1.25"
WIZ_CLAIM="30"; WIZ_BNB="0.005"

# ---- 读现有 config.json 作为默认值 ----
wiz_load() {
  local k v
  [ -f config.json ] || return 0
  while IFS='=' read -r k v; do
    [ -n "$v" ] || continue
    case "$k" in
      ROOMS)            WIZ_ROOMS="$v" ;;
      SNIPE_MIN_COUNT)  WIZ_MIN="$v" ;;
      SNIPE_MAX_COUNT)  WIZ_MAX="$v" ;;
      SNIPE_DELAY_MS)   WIZ_DELAY="$v" ;;
      CLAIM_INTERVAL_MS) WIZ_CLAIM="$(( v / 1000 ))" ;;
      MIN_BNB_GAS)      WIZ_BNB="$v" ;;
      GAS_MODE)         if [ "$v" = "auto" ]; then WIZ_GAS_MODE="auto"; else WIZ_GAS_MODE="fixed"; fi ;;
      GAS_GWEI)         WIZ_GAS_FIXED="$v"; WIZ_GAS_MODE="fixed" ;;
      GAS_MAX_GWEI)     WIZ_GAS_MAX="$v" ;;
      GAS_MULT)         WIZ_GAS_MULT="$v" ;;
    esac
  done < <(node -e '
    const fs=require("fs");
    let c={}; try{c=JSON.parse(fs.readFileSync("config.json","utf8"))}catch(e){}
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
  ' 2>/dev/null)
  # 兼容旧配置里 CLAIM_INTERVAL_MS 直接是毫秒
  [ -n "$WIZ_CLAIM" ] || WIZ_CLAIM=30
}

wiz_rooms_text() {
  local out="" i name
  for i in ${WIZ_ROOMS//,/ }; do
    case "$i" in 0) name="10U" ;; 1) name="50U" ;; 2) name="100U" ;; *) name="房间$i" ;; esac
    out="${out:+$out · }${name}"
  done
  echo "${out:-未选择}"
}

wiz_gas_text() {
  if [ "$WIZ_GAS_MODE" = "fixed" ]; then
    echo "固定 ${WIZ_GAS_FIXED} gwei"
  else
    echo "自动(链上价 ×${WIZ_GAS_MULT}，上限 ${WIZ_GAS_MAX} gwei)"
  fi
}

wiz_account_count() {
  node -e 'try{const d=JSON.parse(require("fs").readFileSync("wallets.json","utf8"));console.log((d.wallets||[]).length)}catch(e){console.log(0)}' 2>/dev/null || echo 0
}

wiz_header() {
  [ -t 1 ] && clear 2>/dev/null
  echo ""
  echo "  ╔════════════════════════════════════════════════════╗"
  echo "  ║          FTS 自动打金 · 引导配置                   ║"
  echo "  ╚════════════════════════════════════════════════════╝"
  echo "    账号数量   : $(wiz_account_count) 个"
  echo "    参与房间   : $(wiz_rooms_text)"
  echo "    抢位区间   : ${WIZ_MIN} ~ ${WIZ_MAX} 人"
  echo "    抢单延迟   : ${WIZ_DELAY} ms"
  echo "    手续费     : $(wiz_gas_text)"
  echo "    领取间隔   : ${WIZ_CLAIM} 秒"
  echo "    最低 BNB   : ${WIZ_BNB}"
  echo "  ────────────────────────────────────────────────────"
}

wiz_ask_int() {   # 提示 默认值 最小 最大 -> REPLY
  local p="$1" d="$2" lo="$3" hi="$4" v
  while true; do
    read -r -p "    $p [$d]: " v
    v="${v:-$d}"
    if [[ ! "$v" =~ ^[0-9]+$ ]]; then warn_msg "请输入整数"; continue; fi
    if [ "$v" -lt "$lo" ] || [ "$v" -gt "$hi" ]; then warn_msg "取值范围 ${lo} ~ ${hi}"; continue; fi
    REPLY="$v"; return 0
  done
}

wiz_ask_dec() {   # 提示 默认值 最小 最大 -> REPLY（支持小数）
  local p="$1" d="$2" lo="$3" hi="$4" v
  while true; do
    read -r -p "    $p [$d]: " v
    v="${v:-$d}"
    if [[ ! "$v" =~ ^[0-9]+([.][0-9]+)?$ ]]; then warn_msg "请输入数字"; continue; fi
    if ! awk -v a="$v" -v lo="$lo" -v hi="$hi" 'BEGIN{exit !((a+0)>=(lo+0) && (a+0)<=(hi+0))}'; then
      warn_msg "取值范围 ${lo} ~ ${hi}"; continue
    fi
    REPLY="$v"; return 0
  done
}

# ---- 各项设置 ----
wiz_edit_rooms() {
  local v out="" i
  wiz_header
  echo "    选择参与的房间(可多选，逗号分隔)"
  echo "      0 = 10U    1 = 50U    2 = 100U"
  echo "    当前: ${WIZ_ROOMS}"
  read -r -p "    请输入(如 0 或 0,1): " v
  v="${v:-$WIZ_ROOMS}"; v="${v// /}"
  if [[ ! "$v" =~ ^[0-2](,[0-2])*$ ]]; then warn_msg "只能填 0/1/2，用英文逗号分隔"; sleep 1; return; fi
  for i in 0 1 2; do case ",$v," in *",$i,"*) out="${out:+$out,}$i" ;; esac; done
  WIZ_ROOMS="$out"
}

wiz_edit_range() {
  local lo hi
  wiz_header
  echo "    抢位区间: 当前轮排队人数落在这个范围内才入场"
  echo "      太小 -> 还没轮到你名额就满了；太大 -> 中签率低"
  wiz_ask_int "人数下限" "$WIZ_MIN" 0 9999; lo="$REPLY"
  wiz_ask_int "人数上限" "$WIZ_MAX" 1 10000; hi="$REPLY"
  if [ "$lo" -ge "$hi" ]; then warn_msg "下限必须小于上限，本次修改已放弃"; sleep 1; return; fi
  WIZ_MIN="$lo"; WIZ_MAX="$hi"
}

wiz_edit_delay() {
  wiz_header
  echo "    抢单延迟: 轮次开始后等待多少毫秒再入场"
  echo "      0 = 立即入场；适当延迟可避开开轮瞬间的拥堵"
  wiz_ask_int "延迟(毫秒)" "$WIZ_DELAY" 0 60000
  WIZ_DELAY="$REPLY"
}

wiz_edit_gas() {
  local ch
  wiz_header
  echo "    ---- 手续费 / Gas ----"
  echo "      [1] 固定 gas 价(默认 0.05 gwei，每笔都按这个价发)"
  echo "      [2] 自动: 按链上实时价上浮，并设上限保护"
  echo "    当前: $(wiz_gas_text)"
  read -r -p "    请选择 [1/2]: " ch
  case "$ch" in
    2) wiz_ask_dec "上浮倍数(相对链上实时价)" "$WIZ_GAS_MULT" 1 5
       WIZ_GAS_MULT="$REPLY"
       wiz_ask_dec "gas 上限 (gwei，防止链上拥堵时被扣爆)" "$WIZ_GAS_MAX" 0.5 200
       WIZ_GAS_MAX="$REPLY"; WIZ_GAS_MODE="auto" ;;
    *) wiz_ask_dec "固定 gas 价 (gwei)" "${WIZ_GAS_FIXED:-0.05}" 0.01 200
       WIZ_GAS_FIXED="$REPLY"; WIZ_GAS_MODE="fixed" ;;
  esac
}

wiz_edit_claim() {
  wiz_header
  echo "    领取返利间隔: 每隔多少秒扫一次可领取的退款/空投"
  echo "      太小浪费节点额度，太大会漏领"
  wiz_ask_int "间隔(秒)" "$WIZ_CLAIM" 10 3600
  WIZ_CLAIM="$REPLY"
}

wiz_edit_bnb() {
  wiz_header
  echo "    最低 BNB 余额: 低于这个值只提醒，不中断运行"
  wiz_ask_dec "最低 BNB" "$WIZ_BNB" 0 1
  WIZ_BNB="$REPLY"
}

# ---- 账号管理 ----
wiz_add_account() {
  local pk addr ref
  wiz_header
  echo "    ---- 添加账号 ----"
  [ -f wallets.json ] || echo '{"wallets": []}' > wallets.json
  while true; do
    read -r -p "    私钥 (64位hex，可不带0x，输入不显示): " -s pk; echo
    pk="${pk#0x}"
    if [[ "$pk" =~ ^[0-9a-fA-F]{64}$ ]]; then break; fi
    warn_msg "私钥格式错误(必须是 64 位十六进制)"
  done
  while true; do
    read -r -p "    钱包地址 (0x开头): " addr
    if [[ "$addr" =~ ^0x[a-fA-F0-9]{40}$ ]]; then break; fi
    warn_msg "地址格式错误"
  done
  while true; do
    read -r -p "    推荐人地址 (0x开头): " ref
    if [[ "$ref" =~ ^0x[a-fA-F0-9]{40}$ ]]; then break; fi
    warn_msg "推荐人地址格式错误"
  done
  # 不再写入每个账号独立的抢位设置，统一由引导页的全局配置控制
  FTS_PK="$pk" FTS_ADDR="$addr" FTS_REF="$ref" node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync("wallets.json", "utf8"));
    if (d.wallets.some(w => String(w.ADDRESS).toLowerCase() === process.env.FTS_ADDR.toLowerCase())) {
      console.error("该地址已在列表中"); process.exit(2);
    }
    d.wallets.push({ PRIVATE_KEY: process.env.FTS_PK, ADDRESS: process.env.FTS_ADDR, REFERRER: process.env.FTS_REF });
    const tmp = "wallets.json.tmp";
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, "wallets.json");
  ' || { warn_msg "写入失败(地址重复或文件异常)"; sleep 1; return; }
  chmod 600 wallets.json 2>/dev/null || true
  ok_msg "账号 $addr 已添加"
  sleep 1
}

wiz_clear_accounts() {
  local a
  read -r -p "    确认清空全部账号? 不可恢复 (y/N): " a
  case "$a" in
    [Yy]*) echo '{"wallets": []}' > wallets.json; chmod 600 wallets.json 2>/dev/null || true
           ok_msg "已清空" ;;
    *) echo "    已取消" ;;
  esac
  sleep 1
}

wiz_accounts() {
  local ch
  while true; do
    wiz_header
    echo "    ---- 账号管理 ----"
    node -e '
      try {
        const d = JSON.parse(require("fs").readFileSync("wallets.json","utf8"));
        if (!d.wallets.length) console.log("    (还没有账号)");
        d.wallets.forEach((w,i)=>console.log("    ["+(i+1)+"] "+w.ADDRESS+"   推荐人 "+w.REFERRER));
      } catch(e) { console.log("    (还没有账号)"); }
    ' 2>/dev/null
    echo "    ────────────────────────────────────────────────"
    echo "      [1] 添加账号    [2] 清空重录    [0] 返回"
    read -r -p "    请选择: " ch
    case "$ch" in
      1) wiz_add_account ;;
      2) wiz_clear_accounts ;;
      0) return ;;
    esac
  done
}

wiz_defaults() {
  local a
  read -r -p "    恢复全部设置为默认值? (y/N): " a
  case "$a" in
    [Yy]*)
      WIZ_ROOMS="0,1,2"; WIZ_MIN="30"; WIZ_MAX="60"; WIZ_DELAY="0"
      WIZ_GAS_MODE="fixed"; WIZ_GAS_FIXED="0.05"; WIZ_GAS_MAX="10"; WIZ_GAS_MULT="1.25"
      WIZ_CLAIM="30"; WIZ_BNB="0.005"
      ok_msg "已恢复默认(尚未保存)" ;;
    *) echo "    已取消" ;;
  esac
  sleep 1
}

# ---- 保存 ----
wiz_commit() {
  local ov a
  if [ -z "$WIZ_ROOMS" ]; then warn_msg "至少要选一个房间"; sleep 1; return 1; fi
  if [ "$WIZ_MIN" -ge "$WIZ_MAX" ]; then warn_msg "抢位下限必须小于上限"; sleep 1; return 1; fi

  WIZ_ROOMS="$WIZ_ROOMS" WIZ_MIN="$WIZ_MIN" WIZ_MAX="$WIZ_MAX" WIZ_DELAY="$WIZ_DELAY" \
  WIZ_GAS_MODE="$WIZ_GAS_MODE" WIZ_GAS_FIXED="$WIZ_GAS_FIXED" WIZ_GAS_MAX="$WIZ_GAS_MAX" \
  WIZ_GAS_MULT="$WIZ_GAS_MULT" WIZ_CLAIM="$WIZ_CLAIM" WIZ_BNB="$WIZ_BNB" \
  node -e '
    const fs = require("fs");
    let c = {};
    try { c = JSON.parse(fs.readFileSync("config.json","utf8")); } catch(e) {}
    const e = process.env;
    c.ROOMS = String(e.WIZ_ROOMS || "0,1,2").split(",").map(s=>Number(s.trim())).filter(n=>!isNaN(n));
    c.SNIPE_MIN_COUNT = Number(e.WIZ_MIN);
    c.SNIPE_MAX_COUNT = Number(e.WIZ_MAX);
    c.SNIPE_DELAY_MS  = Number(e.WIZ_DELAY);
    c.CLAIM_INTERVAL_MS = Number(e.WIZ_CLAIM) * 1000;
    c.MIN_BNB_GAS = Number(e.WIZ_BNB);
    c.GAS_MAX_GWEI = Number(e.WIZ_GAS_MAX);
    c.GAS_MULT = Number(e.WIZ_GAS_MULT);
    if (e.WIZ_GAS_MODE === "fixed") c.GAS_GWEI = Number(e.WIZ_GAS_FIXED);
    else c.GAS_GWEI = null;
    const tmp = "config.json.tmp";
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
    fs.renameSync(tmp, "config.json");
  ' || { warn_msg "写入 config.json 失败"; sleep 1; return 1; }

  # 老版本会在每个账号里存 SNIPE_MIN/MAX/DELAY，它们会覆盖全局设置 -> 提示统一
  ov="$(node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync("wallets.json","utf8"));
      console.log(d.wallets.filter(w => w.SNIPE_MIN_COUNT!==undefined || w.SNIPE_MAX_COUNT!==undefined || w.SNIPE_DELAY_MS!==undefined).length);
    } catch(e) { console.log(0); }
  ' 2>/dev/null || echo 0)"
  if [ "${ov:-0}" -gt 0 ]; then
    echo ""
    warn_msg "有 ${ov} 个账号带独立抢位设置，会覆盖上面的全局值"
    read -r -p "    改为统一使用全局设置? (Y/n): " a
    case "$a" in
      [Nn]*) echo "    保留账号独立设置(全局值对这些账号不生效)" ;;
      *) node -e '
        const fs = require("fs");
        const d = JSON.parse(fs.readFileSync("wallets.json","utf8"));
        d.wallets.forEach(w => { delete w.SNIPE_MIN_COUNT; delete w.SNIPE_MAX_COUNT; delete w.SNIPE_DELAY_MS; });
        const tmp = "wallets.json.tmp";
        fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, "wallets.json");
      ' && ok_msg "已统一为全局设置" ;;
    esac
  fi
  return 0
}

wiz_menu() {
  echo "      [1] 参与房间          [2] 抢位人数区间"
  echo "      [3] 抢单延迟          [4] 手续费 / Gas"
  echo "      [5] 领取返利间隔      [6] 最低 BNB 余额"
  echo "      [7] 账号管理          [8] 恢复默认值"
  echo "      [9] 保存并退出        [0] 不保存退出"
  echo "  ────────────────────────────────────────────────────"
}

wizard_main() {
  local ch
  wiz_load
  while true; do
    wiz_header
    wiz_menu
    read -r -p "    请选择: " ch
    case "$ch" in
      1) wiz_edit_rooms ;;
      2) wiz_edit_range ;;
      3) wiz_edit_delay ;;
      4) wiz_edit_gas ;;
      5) wiz_edit_claim ;;
      6) wiz_edit_bnb ;;
      7) wiz_accounts ;;
      8) wiz_defaults ;;
      9) if wiz_commit; then return 0; fi ;;
      0) echo ""; echo "  已退出，未做任何修改"; return 1 ;;
      *) ;;
    esac
  done
}

# ---- 进入引导页 ----
if [ "$DO_INIT" = 1 ] || [ "$DO_WIZARD" = 1 ] || [ ! -f wallets.json ]; then
  echo -e "\e[33m[3/5] 配置向导...\e[0m"
  if [ ! -t 0 ] && [ "${FTS_ALLOW_PIPE_INIT:-0}" != "1" ]; then
    die "配置向导需要交互式终端。请在终端里直接执行: bash autofts.sh --init"
  fi
  if wizard_main; then
    echo ""
    ok_msg "配置已保存到 config.json（账号在 wallets.json）"
    echo "  当前设置: 房间=$(wiz_rooms_text) 抢位=${WIZ_MIN}~${WIZ_MAX} 延迟=${WIZ_DELAY}ms 手续费=$(wiz_gas_text)"
    echo ""
    echo "下一步建议(按顺序):"
    echo "  bash autofts.sh --selftest   # 只读体检，一分钱不花"
    echo "  bash autofts.sh --dry-run    # 全流程演练，交易不上链"
    echo "  bash autofts.sh --run        # 确认无误后再正式运行"
  fi
  # 配置向导结束一律退出，绝不自动开始交易
  exit 0
fi

node -e '
  const fs=require("fs");
  let d;
  try { d = JSON.parse(fs.readFileSync("wallets.json","utf8")); }
  catch (e) { console.error("wallets.json 不是合法的 JSON: " + e.message); process.exit(1); }
  if(!d || !Array.isArray(d.wallets) || d.wallets.length===0){ console.error("wallets.json 中没有账号"); process.exit(1); }
  console.log(`已加载 ${d.wallets.length} 个账号配置`);
' || die "wallets.json 无效或为空，请执行: bash autofts.sh --init"

# ==============================================================
echo -e "\e[33m[4/5] 设备保活...\e[0m"
# 只有真正要长时间运行的模式才拿唤醒锁；selftest/短期任务不拿，避免白耗电
case "$MODE" in
  run|dry-run) acquire_wake ;;
  *) echo "模式 $MODE 不需要长时间挂机，跳过唤醒锁(不耗电)" ;;
esac

# ==============================================================
echo -e "\e[33m[5/5] 启动引擎 (模式: $MODE)...\e[0m"
echo "--------------------------------------------------------"

if [ "$MODE" = "selftest" ]; then
  node core.js selftest
  exit $?
fi

CONSOLE_LOG="logs/console-$(date +%Y%m%d).log"
RUNNING=1
TAIL_PID=""
cleanup() {
  RUNNING=0
  echo ""
  echo "正在退出..."
  rm -f "$PID_FILE" "$STOP_FLAG"
  # 必须回收 tail，否则每次 --stop / Ctrl-C 都会漏一个常驻的 tail -f 进程
  [ -n "${TAIL_PID:-}" ] && kill "$TAIL_PID" 2>/dev/null
  TAIL_PID=""
  release_wake
  exit 0
}
trap cleanup INT TERM

# 清掉上一轮遗留的停止标志，否则 --run 一启动就被它打断
rm -f "$STOP_FLAG"

# 日志清理: 只保留最近 7 天，并限制单个控制台日志体积(手机存储很宝贵)
find logs -maxdepth 1 -name 'console-*.log*' -mtime +7 -delete 2>/dev/null || true
find logs -maxdepth 1 -name 'fts-*.log'        -mtime +7 -delete 2>/dev/null || true
LOG_MAX_MB="${FTS_LOG_MAX_MB:-20}"

RESTARTS=0
RESTART_MAX="${FTS_RESTART_MAX:-50}"
# 稳定运行多久就把崩溃计数清零(默认 300 秒)，避免挂机十小时后因累计次数永久停机
STABLE_RESET_SEC="${FTS_STABLE_RESET:-300}"

while [ "$RUNNING" = 1 ]; do
  # --stop 的可靠信号: 即使 PID 文件丢了，也能在这里退出
  if [ -f "$STOP_FLAG" ]; then
    echo "检测到停止标志，外壳循环退出"
    rm -f "$STOP_FLAG"
    break
  fi

  # 控制台日志滚动，避免单文件无限增长
  if [ -f "$CONSOLE_LOG" ]; then
    SZ="$(wc -c < "$CONSOLE_LOG" 2>/dev/null || echo 0)"
    if [ "${SZ:-0}" -gt $(( LOG_MAX_MB * 1024 * 1024 )) ]; then
      mv -f "$CONSOLE_LOG" "$CONSOLE_LOG.1" 2>/dev/null || true
      echo "控制台日志超过 ${LOG_MAX_MB}MB，已滚动为 $CONSOLE_LOG.1"
    fi
  fi

  START_TS="$(date +%s)"
  # 后台跑 node(这样能拿到它真实的 PID 用于 --stop)，同时 tail -f 实时看日志
  node "$WORK_DIR/core.js" "$MODE" >> "$CONSOLE_LOG" 2>&1 &
  NODE_PID=$!
  # PID 文件用 key=value，避免"少写一行"时把行号当 PID 用
  printf 'shell=%s\nnode=%s\n' "$$" "$NODE_PID" > "$PID_FILE"
  tail -f -n 0 "$CONSOLE_LOG" 2>/dev/null &
  TAIL_PID=$!
  wait "$NODE_PID"
  CODE=$?
  kill "$TAIL_PID" 2>/dev/null
  TAIL_PID=""
  rm -f "$PID_FILE"
  END_TS="$(date +%s)"
  RAN_SEC=$(( END_TS - START_TS ))
  # 跑够时间说明是稳定的，之前的崩溃计数作废
  if [ "$RAN_SEC" -ge "$STABLE_RESET_SEC" ] && [ "$RESTARTS" -ne 0 ]; then
    echo "已稳定运行 ${RAN_SEC}s(>= ${STABLE_RESET_SEC}s)，崩溃计数重置为 0"
    RESTARTS=0
  fi
  [ "$RUNNING" = 0 ] && break
  [ -f "$STOP_FLAG" ] && { rm -f "$STOP_FLAG"; echo "检测到停止标志，外壳循环退出"; break; }
  case "$CODE" in
    0)
      echo "引擎正常退出"; break ;;
    20)
      die "依赖缺失，请先安装 ethers (npm install ethers@6)" ;;
    21)
      die "没有可用账号，请执行: bash autofts.sh --init" ;;
    22)
      warn_msg "RPC 全部不可用，10 秒后重试..."; sleep 10; RESTARTS=$((RESTARTS+1)) ;;
    *)
      RESTARTS=$((RESTARTS+1))
      if [ "$RESTARTS" -gt "$RESTART_MAX" ]; then die "连续崩溃超过 ${RESTART_MAX} 次，停止重启。请查看 logs/ 排查"; fi
      WAIT=$((RESTARTS * 2)); [ "$WAIT" -gt 30 ] && WAIT=30
      warn_msg "引擎退出(码 $CODE)，${WAIT}s 后第 $RESTARTS 次重启..."
      sleep "$WAIT" ;;
  esac
done
cleanup
