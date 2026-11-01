# FTS Queue Bot

BSC（币安智能链）上某个「排队抽签」类合约的多账号自动脚本：**抢位入场 → 等开奖 → 领返利/空投**。

一套引擎，两个启动器：

| 平台                     | 文件            | 说明                          |
| ---------------------- | ------------- | --------------------------- |
| Linux / Termux / macOS | `autofts.sh`  | Bash 单文件，Termux 上可长时间挂机     |
| Windows                | `autofts.ps1` | 同一份逻辑，PowerShell 5.1 与 7 通用 |

两个脚本都是**单文件、零安装**（只需 Node.js 18+），下载下来就能跑。源码在 `src/`，脚本由 `build/build.py` 构建生成，随 [Releases](../../releases) 发布。

---

## ⚠️ 先读这段

- 本项目是**自动化工具**，不保证赚钱。合约规则、开奖结果、返利比例都由链上合约决定，与本项目无关。
- 私钥以明文存放在 `wallets.json`，**这个文件等同于私钥本身**：不要同步到网盘、不要发聊天工具、不要提交到 Git。Windows 版会自动用 ACL 把它的权限收紧到只有当前用户可读写（Linux 上是 `chmod 600`），但这只防同机其他用户，防不了能登录你账号的人。
- **Windows 上请用 `autofts.ps1`**：它会用 ACL 把 `wallets.json` 收紧到「当前用户 + SYSTEM + Administrators」。Git Bash 里跑 `autofts.sh` 只有 `chmod`，在 Windows 上不生效，等于没有保护。
- **请务必用专门的小号钱包，不要放主钱包。**
- 脚本会在你配置的人数区间内自动发交易，**会真实花钱**。首次务必按 `--probe → --init → --selftest → --dry-run → --run` 的顺序走一遍。
- 合约地址、ABI、房间参数都可能被项目方改动。跑之前先 `--probe` 确认链上还能对上。

---

## 功能

- **多账号并发**：每个账号独立 nonce、独立互斥锁，互不干扰
- **按块驱动**：WebSocket 订阅出块 + HTTP 轮询兜底，0.75 秒一块也不漏
- **抢位判定**：当前轮人数落在 `[下限, 上限)` 且轮次进行中才入场，避免无效交易
- **自动领返利**：定时扫最近 N 轮，用 `staticCall` 预检可领性，能领才发交易
- **nonce 自愈**：交易被节点丢弃时自动补交易填坑，账号不会静默卡死
- **多节点容灾**：HTTP 节点池自动测速选优，429 自动冷却切换
- **只读探针**：`--probe` 完全不需要私钥，先验证合约再决定要不要跑
- **配置向导**：房间、抢位区间、延迟、手续费、领取间隔，全部在终端里点选

## 工作原理

```
        ┌──────────────┐
        │  新区块事件   │  WebSocket / 轮询
        └──────┬───────┘
               ▼
   ┌───────────────────────┐
   │ 读 currentRound /     │  每个块只查一次，所有账号共享
   │ roundInfo / roomConfigs│
   └──────────┬────────────┘
              ▼
   ┌───────────────────────┐      人数不在区间 / 轮次已结束
   │ 逐个账号判断能否入场   │──────────────► 跳过
   └──────────┬────────────┘
              ▼ 在区间内
   ┌───────────────────────┐
   │ 查余额 / 授权 → 发交易 │  estimateGas 预检，失败不上链
   └───────────────────────┘

   并行：每账号一个 claimLoop，定时扫历史轮次领返利
```


> 出块很快时（BSC 约 0.75 秒一块）引擎只处理**最新块**，中间的块会被合并跳过——这是有意为之：排队人数以最新块为准，逐块回放既追不上出块速度也没有意义。状态读取失败时会退回重试，最多 3 次。
引擎（`src/core.js`）负责所有链上交互，启动器（`.sh` / `.ps1`）负责环境检查、配置向导、进程守护和崩溃重启。

## 仓库结构

```
src/
  core.js              引擎：链上交互、抢单、领返利、nonce 管理
  probe.js             只读探针：验证合约地址与函数是否存在
templates/
  autofts.sh.tpl       Bash 启动器模板（占位符 @@CORE_JS@@ / @@PROBE_JS@@）
  autofts.ps1.tpl      PowerShell 启动器模板
build/
  build.py             把 src/*.js 注入模板，产出 dist/ 下的两个单文件脚本
.github/workflows/
  release.yml          推送时自动构建并创建 Release
config.example.json    配置示例
```

`dist/` 是构建产物，不提交到仓库——请从 [Releases](../../releases) 下载。

## 下载使用

### Windows

从 Releases 下载 `autofts.ps1`，放到一个**空目录**（脚本会在这里生成 `core.js`、`logs/`、`wallets.json`）。

```powershell
# 1. 装 Node.js 18+（已装可跳过）
winget install OpenJS.NodeJS.LTS

# 2. 首次跑需要放开执行策略（只对本次进程生效）
powershell -ExecutionPolicy Bypass -File .\autofts.ps1 --init

# 3. 按提示走完向导，然后依次验证
powershell -ExecutionPolicy Bypass -File .\autofts.ps1 --selftest
powershell -ExecutionPolicy Bypass -File .\autofts.ps1 --dry-run
powershell -ExecutionPolicy Bypass -File .\autofts.ps1 --run
```

PowerShell 7 用户把 `powershell` 换成 `pwsh` 即可，两个版本行为一致。

### Linux / macOS

```bash
chmod +x autofts.sh
./autofts.sh --init
./autofts.sh --selftest
./autofts.sh --run
```

### Termux（安卓）

```bash
pkg update && pkg install nodejs-lts termux-api
# 把 autofts.sh 放到 ~/fts 之类的目录
bash autofts.sh --init
bash autofts.sh --run
```

再执行一次 `termux-wake-lock`（脚本会自己做），并在系统设置里把 Termux 设为「不受电池优化限制」，否则息屏后容易被杀。

## 命令

| 命令           | 作用                                      |
| ------------ | --------------------------------------- |
| `--probe`    | 只读探测：节点连通性、合约是否存在、函数签名是否匹配。**不需要私钥**    |
| `--init`     | 打开配置向导（房间/抢位区间/延迟/手续费/账号），配完即退出         |
| `--settings` | 同 `--init`，随时回来改设置                      |
| `--selftest` | 只读体检：合约、余额、授权、`enterQueue` 预演。**一分钱不花** |
| `--dry-run`  | 全流程演练：真实出块、真实读状态，但交易不上链                 |
| `--run`      | 正式运行（默认）                                |
| `--stop`     | 停止后台运行的引擎                               |
| `--help`     | 查看帮助                                    |

## 配置

### 配置向导

`--init` 会打开一个交互式页面，所有日常要改的项都在里面：

```
  ╔════════════════════════════════════════════════════╗
  ║          FTS 自动打金 · 引导配置                   ║
  ╚════════════════════════════════════════════════════╝
    账号数量   : 2 个
    参与房间   : 10U / 50U
    抢位区间   : 30 ~ 60 人
    抢单延迟   : 0 ms
    手续费     : 固定 0.05 gwei
    领取间隔   : 30 秒
    最低 BNB   : 0.005
  ────────────────────────────────────────────────────
      [1] 参与房间          [2] 抢位人数区间
      [3] 抢单延迟          [4] 手续费 / Gas
      [5] 领取返利间隔      [6] 最低 BNB 余额
      [7] 账号管理          [8] 恢复默认值
      [9] 保存并退出        [0] 不保存退出
```

### config.json

向导写出来的文件，也可以手改（Windows 上注意存成 **UTF-8 无 BOM**，脚本启动时会自动剥 BOM）。

| 字段                  | 默认        | 说明                             |
| ------------------- | --------- | ------------------------------ |
| `ROOMS`             | `[0,1,2]` | 参与的房间，`0`=10U `1`=50U `2`=100U |
| `SNIPE_MIN_COUNT`   | `30`      | 抢位人数下限（含）                      |
| `SNIPE_MAX_COUNT`   | `60`      | 抢位人数上限（不含）                     |
| `SNIPE_DELAY_MS`    | `0`       | 轮次开始后延迟多少毫秒再入场                 |
| `GAS_GWEI`          | `0.05`    | 固定 gas 价。写 `null` 改为自动模式       |
| `GAS_MAX_GWEI`      | `10`      | 自动模式下的 gas 上限                  |
| `GAS_MULT`          | `1.25`    | 自动模式下的上浮倍数                     |
| `CLAIM_INTERVAL_MS` | `30000`   | 领返利扫描间隔                        |
| `MIN_BNB_GAS`       | `0.005`   | BNB 余额提醒阈值（只提醒，不中断）            |

> 手续费默认 **0.05 gwei**。这是 BSC 当前的实际水平（节点建议价、区块内成交中位数与最低值都是 0.05 gwei）。如果某段时间交易迟迟不上链，把它调高到 0.1 ~ 1 gwei。

### wallets.json

由向导生成，`chmod 600`。结构：

```json
{
  "wallets": [
    {
      "PRIVATE_KEY": "64位十六进制，不带0x也可以",
      "ADDRESS": "0x...",
      "REFERRER": "0x... 推荐人地址"
    }
  ]
}
```

**不要手写这个文件**，用 `--init` 添加，它会校验私钥与地址是否匹配、地址是否重复。

## 首次使用

```
--probe    → 确认合约地址/函数在链上对得上（不用私钥）
--init     → 配房间、区间、手续费，加账号
--selftest → 检查余额/授权，预演一次 enterQueue（不花钱）
--dry-run  → 完整跑一遍逻辑，交易不上链
--run      → 正式运行
```

`--selftest` 里出现下面这些**不是错误**：

- `enterQueue 预演未通过: Queue: daily round limit` → 该房间今日轮次已用完，等次日重置
- `claim 预演不可用: Queue: not in round` → 当前没有可领的轮次，正常
- `房间N 链上标记为停用` → 项目方关了这个房间，脚本会自动跳过

## 常见问题

**Q：会不会把我的钱转走？**  
脚本只调用合约的 `enterQueue` / `claimRefundAndAirdrop`，以及 USDT 的 `approve`。它不会、也没有能力做其他转账。但私钥是明文存储的，**保护好你的机器**。

**Q：授权额度是多少？**  
每轮只授权「刚好一轮票价」，用完下一轮再授权。不做无限授权。

**Q：为什么每次入场要发两笔交易？**  
因为授权按轮计价，入场消耗掉之后需要重新授权。这是有意的安全取舍（避免大额授权），代价是抢位时会慢一拍。想要更快可以在 `config.json` 里调大授权轮数——但这需要改动 `src/core.js` 的授权策略，默认版本不提供。

**Q：`--stop` 停不掉？**  
两个启动器都有「停止标志文件 + PID 文件 + 进程名兜底」三重保障，正常都能停。如果还停不掉，直接关终端窗口。

**Q：能在服务器上 24 小时跑吗？**  
可以。Linux 下建议 `nohup`/`systemd` 托管；脚本自身带崩溃重启（默认最多 50 次，稳定运行 5 分钟后计数清零）。

**Q：改完 `src/core.js` 怎么生效？**  
重新构建：`python3 build/build.py`，然后把 `dist/` 里的脚本拷到运行目录。运行目录里那份 `core.js` 是脚本每次启动时自动重写的，不用手动改。

## 从源码构建

```bash
git clone <this-repo>
cd fts-queue-bot
python3 build/build.py
# 产物在 dist/
```

`build.py` 只做一件事：把 `src/core.js` / `src/probe.js` 原样注入两个模板。构建时会检查源码里有没有行首的 `'@`（会提前终止 PowerShell here-string）。

跑回归测试（无需额外依赖）：

```bash
node test/sendtx-nonce.js
```

这个测试把 `sendTx` 从源码里整段抽出来，用桩函数模拟「第一次广播超时但交易已进 mempool」，
断言第二次尝试用的是**同一个 nonce + 更高 gas**（替换），而不是重新读 pending 拿 N+1（并排发两笔）。

## 已验证环境

| 项          | 版本                 |
| ---------- | ------------------ |
| Node.js    | 22.x（要求 ≥ 18）      |
| ethers     | 6.x                |
| PowerShell | 5.1.26100 / 7.6.9  |
| 链          | BSC 主网（chainId 56） |

`--probe` / `--selftest` / `--dry-run` 均已在 BSC 主网实测通过。

## 许可证

MIT，见 [LICENSE](LICENSE)。
