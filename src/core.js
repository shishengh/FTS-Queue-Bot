'use strict';
/**
 * FTS 多账号自动打金 - 加固版核心引擎 v2.0
 * 模式: run(默认) | dry-run(只预演不上链) | selftest(只读体检, 不发任何交易)
 */

// ---------------- 依赖检查 ----------------
let ethers;
try {
  ethers = require('ethers');
} catch (e) {
  console.error('\x1b[31m[FATAL] 缺少 ethers 依赖: ' + e.message + '\x1b[0m');
  console.error('\x1b[33m修复: cd ' + __dirname + ' && npm install ethers@6\x1b[0m');
  process.exit(20);
}

const fs = require('fs');
const path = require('path');

const MODE = process.argv[2] || 'run';
const DRY_RUN = MODE === 'dry-run';
const SELFTEST = MODE === 'selftest';
const VERSION = '2.0-hardened';
// 提示文案里的启动命令: Windows 上应显示 .ps1 的写法
const LAUNCH = process.env.FTS_LAUNCHER === 'ps1'
  ? 'powershell -ExecutionPolicy Bypass -File autofts.ps1'
  : (process.env.FTS_LAUNCHER === 'bash'
    ? 'bash autofts.sh'
    : (process.platform === 'win32' ? 'powershell -ExecutionPolicy Bypass -File autofts.ps1' : 'bash autofts.sh'));

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const WALLETS_FILE = path.join(ROOT, 'wallets.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- 配置 ----------------
// config.json 容错: 手改配置写错(比如把数组写成字符串、JSON 语法错误)时
// 不能让整个引擎崩掉，而是报错提示并用默认值继续跑
let userCfg = {};
let cfgProblems = [];
try {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) userCfg = parsed;
    else cfgProblems.push('config.json 顶层必须是对象，已忽略');
  } catch (e) {
    cfgProblems.push(`config.json 不是合法 JSON: ${e.message} (已使用全部默认配置)`);
  }
} catch (e) { /* 没有 config.json 是正常的 */ }

// 类型安全读取：类型不对就用默认值，绝不抛异常
function cfgArr(v, dflt, name) {
  if (v === undefined || v === null) return dflt;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  cfgProblems.push(`config.json 的 ${name} 应该是数组或逗号分隔字符串，当前是 ${typeof v}，已用默认值 ${JSON.stringify(dflt)}`);
  return dflt;
}
function cfgNum(v, dflt, name) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  cfgProblems.push(`config.json 的 ${name} 应该是数字，当前是 "${v}"，已用默认值 ${dflt}`);
  return dflt;
}
function cfgStr(v, dflt, name) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'string') return v;
  cfgProblems.push(`config.json 的 ${name} 应该是字符串，当前是 ${typeof v}，已用默认值`);
  return dflt;
}

const CFG = {
  QUEUE_ADDR: process.env.FTS_QUEUE_ADDR || cfgStr(userCfg.QUEUE_ADDR, '0x88E6A7fA7eaCBdf774496A15304a7fDB0A16f301', 'QUEUE_ADDR'),
  USDT_ADDR: process.env.FTS_USDT_ADDR || cfgStr(userCfg.USDT_ADDR, '0x55d398326f99059fF775485246999027B3197955', 'USDT_ADDR'),
  CHAIN_ID: cfgNum(process.env.FTS_CHAIN_ID ?? userCfg.CHAIN_ID, 56, 'CHAIN_ID'),
  // 房间 0=10U 1=50U 2=100U，全部启用；可用 FTS_ROOMS=0,1 缩小范围
  ROOMS: (process.env.FTS_ROOMS
    ? process.env.FTS_ROOMS.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n))
    : cfgArr(userCfg.ROOMS, [0, 1, 2], 'ROOMS').map(Number).filter(n => !isNaN(n))),
  HTTP_POOL: process.env.FTS_HTTP_POOL
    ? process.env.FTS_HTTP_POOL.split(',').map(s => s.trim()).filter(Boolean)
    : cfgArr(userCfg.HTTP_POOL, [
      'https://bsc-dataseed1.binance.org',
      'https://bsc-dataseed2.binance.org',
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed1.defibit.io',
      'https://binance.llamarpc.com',
      'https://1rpc.io/bnb'
    ], 'HTTP_POOL').map(s => String(s).trim()).filter(Boolean),
  WSS_POOL: process.env.FTS_WSS_POOL
    ? process.env.FTS_WSS_POOL.split(',').map(s => s.trim()).filter(Boolean)
    : cfgArr(userCfg.WSS_POOL, [
      'wss://bsc-rpc.publicnode.com',
      'wss://bsc.drpc.org'
    ], 'WSS_POOL').map(s => String(s).trim()).filter(Boolean),

  SNIPE_MIN_COUNT: cfgNum(process.env.FTS_MIN_COUNT ?? userCfg.SNIPE_MIN_COUNT, 30, 'SNIPE_MIN_COUNT'),
  SNIPE_MAX_COUNT: cfgNum(process.env.FTS_MAX_COUNT ?? userCfg.SNIPE_MAX_COUNT, 60, 'SNIPE_MAX_COUNT'),
  SNIPE_DELAY_MS: cfgNum(process.env.FTS_DELAY_MS ?? userCfg.SNIPE_DELAY_MS, 0, 'SNIPE_DELAY_MS'),
  CLAIM_INTERVAL_MS: cfgNum(process.env.FTS_CLAIM_MS ?? userCfg.CLAIM_INTERVAL_MS, 30000, 'CLAIM_INTERVAL_MS'),
  CLAIM_LOOKBACK: cfgNum(process.env.FTS_CLAIM_LOOKBACK ?? userCfg.CLAIM_LOOKBACK, 20, 'CLAIM_LOOKBACK'),
  POLL_INTERVAL_MS: cfgNum(process.env.FTS_POLL_MS ?? userCfg.POLL_INTERVAL_MS, 1500, 'POLL_INTERVAL_MS'),
  WS_STALE_MS: cfgNum(process.env.FTS_WS_STALE_MS ?? userCfg.WS_STALE_MS, 45000, 'WS_STALE_MS'),
  RPC_TIMEOUT_MS: cfgNum(process.env.FTS_RPC_TIMEOUT_MS, 12000, 'RPC_TIMEOUT_MS'),
  MAX_RPC_RETRY: cfgNum(process.env.FTS_RPC_RETRY, 3, 'MAX_RPC_RETRY'),
  TX_WAIT_MS: cfgNum(process.env.FTS_TX_WAIT_MS, 90000, 'TX_WAIT_MS'),
  GAS_MULT: cfgNum(process.env.FTS_GAS_MULT, 1.25, 'GAS_MULT'),
  // 下限要低于默认的固定价(0.05)，否则 capGwei 会把 0.05 悄悄顶到下限
  GAS_MIN_GWEI: cfgNum(process.env.FTS_GAS_MIN_GWEI, 0.01, 'GAS_MIN_GWEI'),
  GAS_MAX_GWEI: cfgNum(process.env.FTS_GAS_MAX_GWEI, 10, 'GAS_MAX_GWEI'),
  // 手续费默认"固定 0.05 gwei"。
  // 约定: config.json 里 GAS_GWEI 缺省 = 用默认 0.05；显式写 null = 自动模式(按链上价上浮)
  GAS_FIXED_GWEI: (() => {
    const raw = process.env.FTS_GAS_GWEI ?? userCfg.GAS_GWEI;
    if (raw === null) return null;                                   // 显式 null -> 自动
    if (raw === undefined || raw === '') return 0.05;                // 未配置 -> 默认固定 0.05
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0.05;
  })(),
  GAS_LIMIT_CAP: cfgNum(process.env.FTS_GAS_CAP, 800000, 'GAS_LIMIT_CAP'),
  // 交易类型: auto=运行时探测链是否支持 EIP-1559 / 0=强制 Legacy / 2=强制 1559
  TX_TYPE: String(process.env.FTS_TX_TYPE || userCfg.TX_TYPE || 'auto').toLowerCase(),
  PRIORITY_MAX_GWEI: cfgNum(process.env.FTS_PRIORITY_GWEI ?? userCfg.PRIORITY_MAX_GWEI, 1.5, 'PRIORITY_MAX_GWEI'),
  // 授权额度: 默认按"票价 × 轮数"算小额授权，避免大额无限授权
  // 授权策略: 默认每轮只授权"刚好一轮票价"，用完再授权（避免大额/多轮授权带来的问题）
  // 仅在显式设置 FTS_APPROVE_ROUNDS>1 或 FTS_APPROVE_USD 时才改变
  APPROVE_USD: process.env.FTS_APPROVE_USD !== undefined || userCfg.APPROVE_USD !== undefined
    ? cfgNum(process.env.FTS_APPROVE_USD ?? userCfg.APPROVE_USD, 0, 'APPROVE_USD')
    : null,                                   // null = 自动按票价 × APPROVE_ROUNDS
  APPROVE_ROUNDS: cfgNum(process.env.FTS_APPROVE_ROUNDS ?? userCfg.APPROVE_ROUNDS, 1, 'APPROVE_ROUNDS'),
  MIN_BNB_GAS: cfgNum(process.env.FTS_MIN_BNB ?? userCfg.MIN_BNB_GAS, 0.005, 'MIN_BNB_GAS'),
  // nonce 断档自愈: 发现"有在途交易但 latest 长期不动"就补一笔自转填坑
  GAP_CHECK_MS: cfgNum(process.env.FTS_GAP_CHECK_MS, 20000, 'GAP_CHECK_MS'),
  GAP_STUCK_MS: cfgNum(process.env.FTS_GAP_STUCK_MS, 45000, 'GAP_STUCK_MS'),
  // 并发与限流: 防止多账号同时打爆公共节点(429)
  RPC_MAX_CONCURRENT: cfgNum(process.env.FTS_RPC_CONCURRENCY ?? userCfg.RPC_MAX_CONCURRENT, 4, 'RPC_MAX_CONCURRENT'),
  RPC_MIN_SPACING_MS: cfgNum(process.env.FTS_RPC_SPACING_MS, 60, 'RPC_MIN_SPACING_MS'),
  ACCOUNT_STAGGER_MS: cfgNum(process.env.FTS_ACCOUNT_STAGGER_MS, 120, 'ACCOUNT_STAGGER_MS'),
  // 启动排水: 等上一轮未确认交易落地，避免重启后 nonce 回退
  STARTUP_DRAIN_MS: cfgNum(process.env.FTS_DRAIN_MS, 30000, 'STARTUP_DRAIN_MS')
};

// ---------------- 配置自检 ----------------
// 启动时把有问题的配置一次性说清楚，而不是运行中崩掉或静默失效
function validateCfg() {
  const p = [];
  if (CFG.SNIPE_MIN_COUNT >= CFG.SNIPE_MAX_COUNT) {
    p.push(`抢单人数下限(${CFG.SNIPE_MIN_COUNT}) >= 上限(${CFG.SNIPE_MAX_COUNT})，条件永远不成立 -> 永远不会入场。已自动放宽为 [${CFG.SNIPE_MIN_COUNT}, ${CFG.SNIPE_MIN_COUNT + 1})`);
    CFG.SNIPE_MAX_COUNT = CFG.SNIPE_MIN_COUNT + 1;
  }
  if (CFG.SNIPE_MIN_COUNT < 0) { p.push('抢单人数下限为负数，已改为 0'); CFG.SNIPE_MIN_COUNT = 0; }
  if (!CFG.ROOMS.length) { p.push('ROOMS 为空，已恢复为 [0,1,2]'); CFG.ROOMS = [0, 1, 2]; }
  if (!CFG.HTTP_POOL.length) { p.push('HTTP_POOL 为空，已恢复为默认 BSC 节点'); CFG.HTTP_POOL = ['https://bsc-dataseed1.binance.org', 'https://bsc-rpc.publicnode.com']; }
  if (CFG.CLAIM_LOOKBACK < 1) { p.push('CLAIM_LOOKBACK 必须 >=1，已改为 1'); CFG.CLAIM_LOOKBACK = 1; }
  if (CFG.GAS_MIN_GWEI > CFG.GAS_MAX_GWEI) { p.push(`GAS_MIN_GWEI(${CFG.GAS_MIN_GWEI}) > GAS_MAX_GWEI(${CFG.GAS_MAX_GWEI})，已对调`); [CFG.GAS_MIN_GWEI, CFG.GAS_MAX_GWEI] = [CFG.GAS_MAX_GWEI, CFG.GAS_MIN_GWEI]; }
  // 固定 gas 高于上限时，capGwei 会把它悄悄压下来，用户会以为设置没生效
  if (CFG.GAS_FIXED_GWEI && CFG.GAS_FIXED_GWEI > CFG.GAS_MAX_GWEI) {
    p.push(`固定 gas(${CFG.GAS_FIXED_GWEI} gwei) 高于上限(${CFG.GAS_MAX_GWEI} gwei)，已把上限提到 ${CFG.GAS_FIXED_GWEI}`);
    CFG.GAS_MAX_GWEI = CFG.GAS_FIXED_GWEI;
  }
  // 低于下限同理(默认 0.05 gwei 必须能原样发出去，不能被顶到 1 gwei)
  if (CFG.GAS_FIXED_GWEI && CFG.GAS_FIXED_GWEI < CFG.GAS_MIN_GWEI) {
    p.push(`固定 gas(${CFG.GAS_FIXED_GWEI} gwei) 低于下限(${CFG.GAS_MIN_GWEI} gwei)，已把下限降到 ${CFG.GAS_FIXED_GWEI}`);
    CFG.GAS_MIN_GWEI = CFG.GAS_FIXED_GWEI;
  }
  if (!['auto', '0', '2'].includes(CFG.TX_TYPE)) { p.push(`TX_TYPE 只能是 auto/0/2，当前 "${CFG.TX_TYPE}"，已改为 auto`); CFG.TX_TYPE = 'auto'; }
  if (CFG.APPROVE_ROUNDS < 1) { p.push('APPROVE_ROUNDS 必须 >=1，已改为 1'); CFG.APPROVE_ROUNDS = 1; }
  if (CFG.GAP_STUCK_MS < 15000) { p.push('GAP_STUCK_MS 太小(容易误判)，已改为 15000'); CFG.GAP_STUCK_MS = 15000; }
  return p.concat(cfgProblems);
}

// ---------------- 日志 ----------------
let logStream = null;
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const lf = path.join(LOG_DIR, 'fts-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.log');
  logStream = fs.createWriteStream(lf, { flags: 'a' });
  logStream.write(`\n===== 启动 v${VERSION} mode=${MODE} ${new Date().toLocaleString()} =====\n`);
} catch (e) { /* 日志不可用时仅控制台 */ }

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[0m' };
const tss = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const short = a => (a || 'SYS').slice(0, 8);

function log(level, addr, msg, color) {
  const line = `[${tss()}] [${level}] [${short(addr)}] ${msg}`;
  console.log((color || '') + line + C.d);
  try { logStream.write(line + '\n'); } catch (e) { }
}
// 同一原因的报错做节流，避免每个块刷屏（默认 60s 内只报一次）
const errSeen = new Map();
function errOnce(addr, m, ms) {
  const gap = ms === undefined ? 60000 : ms;
  const key = (addr || '') + '|' + m.replace(/\d+(\.\d+)?/g, '#');
  const now = Date.now();
  const last = errSeen.get(key) || 0;
  if (now - last < gap) return;
  errSeen.set(key, now);
  err(addr, m);
}

const info = (a, m) => log('INFO', a, m);
const ok = (a, m) => log(' OK ', a, m, C.g);
const warn = (a, m) => log('WARN', a, m, C.y);
const err = (a, m) => log('ERR ', a, m, C.r);
const fatal = (a, m) => log('FATAL', a, m, C.r);

// 警告就是警告: 用黄色 WARN，不要打成红色 ERR 吓人
function warnOnce(addr, m, ms) {
  const gap = ms === undefined ? 60000 : ms;
  const key = 'W|' + (addr || '') + '|' + m.replace(/\d+(\.\d+)?/g, '#');
  const now = Date.now();
  if (now - (errSeen.get(key) || 0) < gap) return;
  errSeen.set(key, now);
  warn(addr, m);
}

// ---------------- 错误详情 ----------------
function decodeRevert(e) {
  try {
    const data = e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data);
    if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
      return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
    }
    if (typeof data === 'string' && data !== '0x') return 'raw=' + data.slice(0, 20) + '...';
  } catch (x) { }
  return null;
}
function formatError(e) {
  if (!e) return '未知错误';
  const parts = [];
  parts.push('code=' + (e.code || e.name || 'UNKNOWN'));
  const msg = e.shortMessage || e.reason || e.message || '';
  if (msg) parts.push('msg=' + String(msg).replace(/\n/g, ' ').slice(0, 300));
  const rv = decodeRevert(e);
  if (rv) parts.push('revert=' + rv);
  if (e.action) parts.push('action=' + e.action);
  if (e.transaction && e.transaction.to) parts.push('to=' + e.transaction.to);
  if (e.info && e.info.error && e.info.error.message) parts.push('rpc=' + String(e.info.error.message).slice(0, 200));
  return parts.join(' | ');
}
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('超时 ' + ms + 'ms: ' + (label || '')), { code: 'TIMEOUT' })), ms))]);
}

// ---------------- ABI ----------------
const QUEUE_ABI = [
  'function currentRound(uint8 room) view returns (uint256)',
  'function roundInfo(uint8 room, uint256 roundIndex) view returns (uint256 count, uint256 startTime, uint8 state, uint256 deadline, address[] winners)',
  'function roomConfigs(uint8 room) view returns (uint256 ticketPrice, uint256 maxCapacity, uint256 winnerCount, uint256 loserAirdropUsd, uint256 quotaThreshold, bool enabled, uint16 dailyRoundLimit, uint16 todayRounds, uint32 todayRoundsDay)',
  'function enterQueue(uint8 room, address referrer)',
  'function claimRefundAndAirdrop(uint8 room, uint256 roundIndex)',
  'function allowance(address owner, address spender) view returns (uint256)' // 仅用于兼容性探测
];
const USDT_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

// ---------------- 并发闸门 ----------------
// 公共节点对并发很敏感(429)，全局限制同时在飞的请求数，并保证最小间隔
class Semaphore {
  constructor(max) { this.max = Math.max(1, max); this.n = 0; this.q = []; this.lastAt = 0; }
  async acquire() {
    if (this.n < this.max) {
      this.n++;
    } else {
      // 排队等待: release() 会把令牌"直接转交"给等待者(不减少 n)，
      // 所以这里绝不能再自增 —— 否则等待者恢复前新来的 acquire 会看到 n<max 插队，
      // 最终并发数被顶穿，超过 RPC_MAX_CONCURRENT。
      await new Promise(r => this.q.push(r));
    }
    const gap = CFG.RPC_MIN_SPACING_MS - (Date.now() - this.lastAt);
    if (gap > 0) await sleep(gap);
    this.lastAt = Date.now();
  }
  release() {
    const next = this.q.shift();
    if (next) { next(); return; }   // 令牌转交，n 保持不变
    this.n = Math.max(0, this.n - 1);
  }
  async run(fn) { await this.acquire(); try { return await fn(); } finally { this.release(); } }
}
const rpcGate = new Semaphore(CFG.RPC_MAX_CONCURRENT);

// ---------------- 429 / 限流识别 ----------------
function isRateLimited(e) {
  const s = (e.shortMessage || e.message || '') + (e.info && e.info.error && e.info.error.message || '');
  return e.code === 'SERVER_ERROR' && /429|too many requests|rate limit|over rate|exceed/i.test(s);
}
// 节点冷却表: 被限流的节点短时间内不再使用
const cooldown = new Map();
const cooldownLeft = url => Math.max(0, (cooldown.get(url) || 0) - Date.now());
function markCooldown(url, ms) { cooldown.set(url, Date.now() + ms); }

// ---------------- RPC 管理器 ----------------
class RpcManager {
  constructor(urls) {
    this.urls = urls.slice();
    this.index = 0;
    this.provider = null;
    this.failStreak = 0;
    this.listeners = [];
    this.stats429 = 0;
  }
  onRotate(fn) { this.listeners.push(fn); }
  makeProvider(url) {
    return new ethers.JsonRpcProvider(url, CFG.CHAIN_ID, { staticNetwork: true });
  }
  async probe(url) {
    const t0 = Date.now();
    try {
      const p = this.makeProvider(url);
      const h = await withTimeout(p.getBlockNumber(), CFG.RPC_TIMEOUT_MS, 'getBlockNumber');
      return { url, latency: Date.now() - t0, height: h, ok: true };
    } catch (e) {
      return { url, ok: false, error: e };
    }
  }
  async pickBest() {
    const rs = await Promise.all(this.urls.map(u => this.probe(u)));
    const good = rs.filter(r => r.ok).sort((a, b) => a.latency - b.latency);
    if (!good.length) {
      const detail = rs.map(r => `${r.url} -> ${r.error ? (r.error.shortMessage || r.error.message) : 'x'}`).join('; ');
      throw new Error('所有 HTTP 节点不可用: ' + detail);
    }
    good.forEach(r => info('SYS', `节点可用: ${r.url} 延迟=${r.latency}ms 高度=${r.height}`));
    this.index = this.urls.indexOf(good[0].url);
    this.provider = this.makeProvider(good[0].url);
    ok('SYS', `主节点: ${good[0].url} (${good[0].latency}ms)`);
    return this.provider;
  }
  async rotate() {
    const old = this.urls[this.index];
    // 第一轮优先跳过处于冷却期的节点
    for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= this.urls.length; i++) {
      const idx = (this.index + i) % this.urls.length;
      const left = cooldownLeft(this.urls[idx]);
      if (pass === 0 && left > 0) continue;   // 冷却中，先试别的
      const r = await this.probe(this.urls[idx]);
      if (!r.ok) err('SYS', `备用节点探测失败 ${this.urls[idx]}: ${formatError(r.error)}`);
      if (r.ok) {
        this.index = idx;
        this.provider = this.makeProvider(this.urls[idx]);
        this.failStreak = 0;
        warn('SYS', `已切换节点: ${old} -> ${this.urls[idx]} (${r.latency}ms)`);
        for (const fn of this.listeners) { try { fn(this.provider); } catch (e) { } }
        return true;
      }
    }
    }
    warn('SYS', '所有节点探测失败(或被限流冷却)，3 秒后重试');
    await sleep(3000);
    return false;
  }
  async rpc(fn, label) {
    let lastErr;
    for (let i = 0; i < CFG.MAX_RPC_RETRY; i++) {
      // 闸门只保护"发请求"这一瞬间；重试的退避/换节点必须在闸门外，
      // 否则一次慢/失败的重试会占住名额，把整个引擎堵死(实测会静默卡住)
      await rpcGate.acquire();
      try {
        // 全局兜底超时: 没有它，一个卡死的 HTTP 请求会永久占住闸门名额，
        // 累积几次后整个引擎静默死锁(4 个名额被 4 个挂起请求吃光)
        const r = await withTimeout(Promise.resolve(fn(this.provider)), CFG.RPC_TIMEOUT_MS, 'rpc');
        this.failStreak = 0;
        return r;
      } catch (e) {
        lastErr = e;
        this.failStreak++;
      } finally {
        rpcGate.release();
      }
      // ---- 以下重试逻辑都在闸门之外 ----
      if (isRateLimited(lastErr)) {
        this.stats429++;
        const backoff = 2000 * (i + 1);
        warn('SYS', `节点限流(429) 第 ${this.stats429} 次，冷却 ${this.urls[this.index]} 30s 并切换节点: ${formatError(lastErr).slice(0, 110)}`);
        markCooldown(this.urls[this.index], 30000);
        await this.rotate();
        await sleep(backoff);
        continue;
      }
      const transient = ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'BAD_DATA'].includes(lastErr.code) || !lastErr.code;
      if (transient) {
        if (this.failStreak >= 2) await this.rotate();
        await sleep(400 * (i + 1));
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }
  // 统一的"受闸门保护"的直连调用(用于不经过重试逻辑的场景)
  gated(fn) { return rpcGate.run(fn); }
}

// ---------------- 全局状态 ----------------
const mgr = new RpcManager(CFG.HTTP_POOL);
const instances = [];

function bind(inst, provider) {
  inst.provider = provider;
  inst.wallet = new ethers.Wallet(inst.pk, provider);
  inst.queue = new ethers.Contract(CFG.QUEUE_ADDR, QUEUE_ABI, inst.wallet);
  inst.usdt = new ethers.Contract(CFG.USDT_ADDR, USDT_ABI, inst.wallet);
}
mgr.onRotate(p => instances.forEach(i => bind(i, p)));

// ---------------- WebSocket 可用性 ----------------
function ensureWebSocket() {
  if (typeof globalThis.WebSocket !== 'undefined') return true;
  try {
    const wsmod = require('ws');
    globalThis.WebSocket = wsmod.WebSocket || wsmod;
    info('SYS', '已注入 ws 模块作为 WebSocket 实现');
    return true;
  } catch (e) {
    warn('SYS', 'WebSocket 不可用(缺少 ws)，将使用 HTTP 轮询模式兜底。修复: npm install ws');
    return false;
  }
}

// ---------------- 区块流: WS 优先 + 轮询兜底 ----------------
class BlockStream {
  constructor() {
    this.wsOk = false;
    this.wsIndex = 0;
    this.wsBackoff = 3000;
    // 初始化为"现在"，否则首次 watchdog 检查时会把 Date.now()-0 打印成
    // "已 17 亿秒未收到新块"这种吓人的假告警
    this.lastBlockAt = Date.now();
    this.lastHeight = 0;
    this.wsProvider = null;
    this.stopped = false;
    this.ticking = false;
    this.dupSkipped = 0;
    this.tickCount = 0;
    // 去重改用"区块号"，不再用 800ms 时间窗(BSC 出块已降到 0.75s，时间窗会丢块)
    this.seenBlocks = new Set();
    this.blockRetry = new Map();   // 块号 -> 状态读取失败次数
    this.pendingBlocks = [];      // 上一轮没查完时挂起，查完立刻补跑
    this.isReconnecting = false;  // 防止同时连出多条 WebSocket(幽灵连接)
    this.connecting = false;
    this.wsErrAt = 0;
  }
  start() {
    if (ensureWebSocket()) this.connectWs(); else warn('SYS', 'WS 不可用，直接进入轮询模式');
    this.startPolling();
    this.startWatchdog();
  }
  connectWs() {
    if (this.stopped) return;
    // 幽灵连接防护: 同一时刻只允许一条连接流程在跑。
    // 断线时 open/close/error 可能连续触发，无锁会同时开出四五条 WS 挤爆手机网络。
    if (this.connecting) { this.dupSkipped++; return; }
    const url = CFG.WSS_POOL[this.wsIndex % CFG.WSS_POOL.length];
    if (!url) return;
    this.connecting = true;
    let opened = false;
    let provider = null;
    const guard = setTimeout(() => {
      if (!opened) {
        warn('SYS', `WS 连接超时: ${url} -> 换下一个节点`);
        this.connecting = false;
        try { provider && provider.destroy && provider.destroy(); } catch (e) { }
        this.scheduleReconnect();
      }
    }, 12000);
    try {
      provider = new ethers.WebSocketProvider(url, CFG.CHAIN_ID, { staticNetwork: true });
      this.wsProvider = provider;
      provider.websocket.on('open', () => {
        opened = true; clearTimeout(guard);
        this.connecting = false;
        this.wsOk = true; this.wsBackoff = 3000;
        ok('SYS', `WebSocket 已连接: ${url}`);
      });
      provider.websocket.on('close', () => {
        clearTimeout(guard);
        this.connecting = false;
        this.wsOk = false;
        warn('SYS', 'WebSocket 断开，准备重连');
        this.scheduleReconnect();
      });
      provider.websocket.on('error', (e) => {
        clearTimeout(guard);
        this.connecting = false;
        const m = (e && (e.message || e.type)) || 'unknown';
        err('SYS', `WebSocket 错误: ${m}`);
      });
      // ethers v6 的 JsonRpcApiProvider 会在内部请求失败时 emit('error')。
      // EventEmitter 上如果没有 'error' 监听者，Node 会直接抛 ERR_UNHANDLED_ERROR，
      // 之前只监听了底层 socket 的 error，provider 层的没监听 -> 变成"未捕获异常"。
      provider.on('error', (e) => {
        this.wsErrAt = Date.now();
        this.wsOk = false;
        warnOnce('SYS', `WS provider 异常(将触发重连): ${(e && (e.shortMessage || e.message)) || e}`, 15000);
        this.scheduleReconnect();
      });
      provider.on('block', (bn) => { this.lastBlockAt = Date.now(); this.lastHeight = bn; this.tick(bn, 'ws'); });
    } catch (e) {
      clearTimeout(guard);
      this.connecting = false;
      err('SYS', `WebSocket 初始化失败: ${formatError(e)}`);
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.stopped) return;
    // 已经在重连流程中就不再排新的，避免重连风暴
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.connecting = false;
    try { this.wsProvider && this.wsProvider.destroy && this.wsProvider.destroy(); } catch (e) { }
    this.wsOk = false;
    this.wsIndex++;
    const wait = Math.min(this.wsBackoff, 30000);
    this.wsBackoff = Math.min(this.wsBackoff * 2, 30000);
    info('SYS', `${Math.round(wait / 1000)} 秒后重连 WebSocket (第 ${this.wsIndex} 次)`);
    setTimeout(() => {
      this.isReconnecting = false;
      this.connectWs();
    }, wait);
  }
  startPolling() {
    const loop = async () => {
      while (!this.stopped) {
        try {
          const h = await mgr.rpc(p => withTimeout(p.getBlockNumber(), 8000, 'poll'));
          // 块号变了就交给 tick，去重在 tick 里按块号做(不再靠时间窗判断)
          if (h > this.lastHeight) {
            this.lastHeight = h;
            this.lastBlockAt = Date.now();
            this.tick(h, 'poll');
          }
        } catch (e) {
          errOnce('SYS', '轮询获取区块失败: ' + formatError(e), 30000);
        }
        await sleep(CFG.POLL_INTERVAL_MS);
      }
    };
    loop();
  }
  startWatchdog() {
    setInterval(() => {
      if (this.stopped) return;
      if (Date.now() - this.lastBlockAt > CFG.WS_STALE_MS) {
        warnOnce('SYS', `已 ${Math.round((Date.now() - this.lastBlockAt) / 1000)}s 未收到新块，轮询兜底中` + (this.wsOk ? '，重置 WS' : ''), 30000);
        if (this.wsOk) { this.scheduleReconnect(); }
      }
    }, 10000);
  }
  // 出块处理: 按"区块号"去重 + 忙时挂起补跑
  // 旧实现用 800ms 时间窗去重，BSC 出块已降到 ~0.75s，会直接丢掉约一半的区块；
  // 而且上一轮没查完时新块被直接丢弃。现在改成：没查过的块号排队，查完立刻补跑。
  tick(height, src) {
    const h = Number(height);
    if (!Number.isFinite(h)) return;
    if (this.seenBlocks.has(h)) { this.dupSkipped++; return; }  // 同一个块只处理一次(WS/轮询双通道去重)
    this.seenBlocks.add(h);
    // 控制缓存体积
    if (this.seenBlocks.size > 500) this.seenBlocks = new Set([...this.seenBlocks].slice(-200));

    this.pendingBlocks.push(h);
    if (this.pendingBlocks.length > 50) this.pendingBlocks.splice(0, this.pendingBlocks.length - 50);

    if (this.ticking) return;  // 正在处理，新块排队等下一轮自动补跑
    this.runQueue();
  }

  async runQueue() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.pendingBlocks.length && !this.stopped) {
        // 关键: 只按"最新块号"处理一次，而不是把排队的每个块都完整查一遍。
        // 旧写法逐块处理，每块要 3 房间 × 2 个串行 RTT(≈1s)，再加账号错峰 await 睡眠，
        // 而 BSC 0.75s 出一块 -> 队列永远追不上，实际退化成 2s 一次的状态轮询，
        // 抢单窗口早就过去了(而且每轮 height 都不同，共享缓存完全不命中)。
        const h = Math.max(...this.pendingBlocks);
        this.pendingBlocks.length = 0;
        this.tickCount++;
        let rooms;
        try {
          rooms = await getSharedState(h);
        } catch (e) {
          // 关键: 不能把失败当成"这个块处理过了"。tick 里已经 seenBlocks.add(h)，
          // 如果这里直接 continue，WS 和轮询再送同一个块号都会被去重掉，
          // 这个块的抢单窗口就永久丢了。这里退回 seenBlocks 并重排，最多重试 3 次。
          const tries = (this.blockRetry.get(h) || 0) + 1;
          this.blockRetry.set(h, tries);
          if (this.blockRetry.size > 200) {
            // 按块号淘汰(块号单调递增)。不能按插入顺序删 —— 那可能把还在重试中的块
            // 删掉，计数归零后又白送 3 次机会，极端情况下会无限重试
            for (const k of this.blockRetry.keys()) { if (k < h - 200) this.blockRetry.delete(k); }
          }
          if (tries <= 3 && !this.stopped) {
            this.seenBlocks.delete(h);           // 允许同块号再次进入
            this.pendingBlocks.push(h);
            warnOnce('SYS', `读取区块 ${h} 状态失败(第 ${tries} 次)，稍后重试: ${formatError(e).slice(0, 120)}`, 20000);
            await sleep(300 * tries);
          } else {
            errOnce('SYS', `区块 ${h} 连续 ${tries} 次读取失败，放弃该块: ${formatError(e)}`, 30000);
          }
          continue;
        }
        // 账号错峰用 setTimeout，不要 await sleep —— 否则 10 个账号光"睡觉"就 1.2s，
        // 把出块队列直接堵死
        let idx = 0;
        for (const inst of instances) {
          if (!inst || inst.busy) continue;
          const delay = Math.min(idx * CFG.ACCOUNT_STAGGER_MS, 300);
          idx++;
          const fire = () => snipeWithState(inst, rooms).catch(e => err(inst.address, '抢单异常: ' + formatError(e)));
          if (delay > 0) setTimeout(fire, delay); else fire();
        }
      }
    } finally {
      this.ticking = false;
      // 收尾时又来新块则再跑一轮，避免遗漏
      if (this.pendingBlocks.length && !this.stopped) this.runQueue();
    }
  }
}

// ---------------- 房间标签 ----------------
// 0=10U 1=50U 2=100U；若链上票价与预设不符，直接显示真实票价
const ROOM_NAMES = { 0: '10U', 1: '50U', 2: '100U' };
function roomLabel(room, ticketPrice) {
  const preset = ROOM_NAMES[room];
  if (ticketPrice === null || ticketPrice === undefined) return `房间${room}${preset ? '(' + preset + ')' : ''}`;
  const p = Number(ethers.formatUnits(ticketPrice, 18));
  if (!Number.isFinite(p)) return `房间${room}${preset ? '(' + preset + ')' : ''}`;
  return preset && preset !== String(p) + 'U' ? `房间${room}(链上票价${p}U,预设${preset})` : `房间${room}(${p}U)`;
}

// ---------------- 资金与授权 ----------------
async function ensureFunds(inst, ticketPrice, room) {
  const tag = roomLabel(room, ticketPrice);
  // 1) USDT 余额
  let bal = 0n;
  try {
    bal = await mgr.rpc(p => inst.usdt.balanceOf(inst.address));
  } catch (e) {
    err(inst.address, `[${tag}] 读取 USDT 余额失败: ${formatError(e)}`);
    err(inst.address, `[${tag}] 排查: 检查 USDT 合约地址是否正确(FTS_USDT_ADDR)、该节点是否 ban 了 eth_call、换节点重试`);
    return false;
  }
  if (bal < ticketPrice) {
    errOnce(inst.address, `[${tag}] USDT 余额不足: 本轮需要 ${ethers.formatUnits(ticketPrice, 18)}，钱包当前 ${ethers.formatUnits(bal, 18)} -> 跳过本轮，不会发交易(已节流，60s 内不重复打印)`);
    return false;
  }
  // 2) BNB gas 检查（60s 缓存: BNB 只用于付 gas，变化极慢，没必要每个块都查）
  try {
    const nowTs = Date.now();
    if (!inst.bnbCache || nowTs - inst.bnbCache.at > 60000) {
      inst.bnbCache = { at: nowTs, v: await mgr.rpc(p => inst.provider.getBalance(inst.address)) };
    }
    const bnb = inst.bnbCache.v;
    if (bnb < ethers.parseEther(String(CFG.MIN_BNB_GAS))) {
      warnOnce(inst.address, `[${tag}] BNB 余额偏低(gas): ${ethers.formatEther(bnb)} BNB，建议保留 > ${CFG.MIN_BNB_GAS}，否则交易发不出去`);
    }
  } catch (e) { /* 非致命 */ }

  // 3) 授权：必须以 USDT 合约为准（原版误用 QUEUE 合约，导致抢单静默失败）
  let allowance = 0n;
  try {
    allowance = await mgr.rpc(p => inst.usdt.allowance(inst.address, CFG.QUEUE_ADDR));
  } catch (e) {
    err(inst.address, `[${tag}] 读取 USDT 授权额度失败: ${formatError(e)}`);
    err(inst.address, `[${tag}] 排查: 确认 USDT 合约支持 allowance(view)；若该节点异常请换节点`);
    return false;
  }
  // 每轮只授权"刚好这一轮"的票价，用完下一轮再授权（不做多轮/大额授权）
  const need = ticketPrice;
  if (allowance >= need) return true;

  // 默认: 授权额度 = 本轮票价。可用 FTS_APPROVE_ROUNDS>1 或 FTS_APPROVE_USD 覆盖
  let target;
  if (CFG.APPROVE_USD === null) {
    target = ticketPrice * BigInt(Math.max(1, CFG.APPROVE_ROUNDS));
  } else if (CFG.APPROVE_USD === 0) {
    target = bal;
  } else {
    target = ethers.parseUnits(String(CFG.APPROVE_USD), 18);
  }
  if (bal < target) target = bal; // 余额不足则按余额授权
  const rounds = Number(ethers.formatUnits(target, 18)) / Number(ethers.formatUnits(ticketPrice, 18));
  info(inst.address, `[${tag}] 授权不足(当前 ${ethers.formatUnits(allowance, 18)} < 本轮需要 ${ethers.formatUnits(need, 18)})，发起授权 ${ethers.formatUnits(target, 18)} USDT (${rounds >= 1 ? Math.round(rounds) : rounds.toFixed(2)} 轮用量)`);
  const okTx = await sendTx(inst, {
    label: `[${tag}] USDT 授权 ${ethers.formatUnits(target, 18)}`,
    contract: inst.usdt,
    method: 'approve',
    args: [CFG.QUEUE_ADDR, target],
    critical: true
  });
  if (!okTx) {
    err(inst.address, `[${tag}] 授权失败，本轮放弃入场(不会扣款)。常见原因: 钱包 USDT 为 0 / BNB 不够 gas / 合约暂停 / 节点广播失败`);
    return false;
  }
  return true;
}

// ---------------- 手续费策略: 运行时探测，不硬编码 ----------------
// BSC 各节点对 EIP-1559 的支持程度不一(部分节点 baseFee 恒为 0)。
// 这里读最新区块的 baseFeePerGas 判断：>0 走 type 2(可用优先费插队)，否则走 type 0。
let eip1559Cached = null; // null=未探测 / true / false
async function detectEip1559() {
  if (eip1559Cached !== null) return eip1559Cached;
  try {
    const blk = await mgr.rpc(p => withTimeout(p.getBlock('latest'), 8000, 'getBlock'));
    const base = blk && blk.baseFeePerGas !== null && blk.baseFeePerGas !== undefined ? BigInt(blk.baseFeePerGas) : 0n;
    eip1559Cached = base > 0n;
    info('SYS', `手续费模式探测: baseFeePerGas=${base} -> ${eip1559Cached ? 'EIP-1559 (type 2)' : 'Legacy (type 0)'}`);
    return eip1559Cached;
  } catch (e) {
    warn('SYS', `手续费模式探测失败，回退 Legacy: ${formatError(e).slice(0, 120)}`);
    eip1559Cached = false;
    return false;
  }
}
function capGwei(v) {
  const max = ethers.parseUnits(String(CFG.GAS_MAX_GWEI), 'gwei');
  const min = ethers.parseUnits(String(CFG.GAS_MIN_GWEI), 'gwei');
  if (v > max) v = max;
  if (v < min) v = min;
  return v;
}
function scaled(base, attempt) {
  const mult = BigInt(Math.round(CFG.GAS_MULT * 100)) * (attempt > 1 ? 130n : 100n) / 100n;
  return capGwei((base * mult) / 100n);
}
async function buildFeeParams(attempt) {
  const forced = CFG.TX_TYPE === '2' ? true : (CFG.TX_TYPE === '0' ? false : await detectEip1559());
  const bump = attempt > 1 ? 1.3 : 1;

  if (!forced) {
    let gasPrice;
    if (CFG.GAS_FIXED_GWEI) {
      gasPrice = capGwei(ethers.parseUnits(String(CFG.GAS_FIXED_GWEI), 'gwei'));
    } else {
      const fd = await mgr.rpc(p => withTimeout(p.getFeeData(), 8000, 'feeData'));
      gasPrice = scaled(fd.gasPrice || fd.maxFeePerGas || ethers.parseUnits('1', 'gwei'), attempt);
    }
    return { type: 0, gasPrice, tx: { type: 0, gasPrice }, desc: `${ethers.formatUnits(gasPrice, 'gwei')}gwei` };
  }

  const fd = await mgr.rpc(p => withTimeout(p.getFeeData(), 8000, 'feeData'));
  let baseFee = fd.lastBaseFeePerGas || 0n;
  if (!baseFee) {
    try {
      const blk = await mgr.rpc(p => withTimeout(p.getBlock('latest'), 8000, 'getBlock'));
      baseFee = blk && blk.baseFeePerGas ? BigInt(blk.baseFeePerGas) : 0n;
    } catch (e) { }
  }
  const prioMax = ethers.parseUnits(String(CFG.PRIORITY_MAX_GWEI), 'gwei');
  let maxPriorityFeePerGas = (fd.maxPriorityFeePerGas || ethers.parseUnits('0.5', 'gwei'));
  const prio = (maxPriorityFeePerGas * BigInt(Math.round(bump * 100))) / 100n;
  maxPriorityFeePerGas = prio > prioMax ? prioMax : prio;
  // maxFee = base*2 + prio，再乘上浮系数；同时保证不低于 legacy 报价，避免被判定低价
  let maxFeePerGas = (baseFee * 2n + maxPriorityFeePerGas);
  maxFeePerGas = scaled(maxFeePerGas || ethers.parseUnits('1', 'gwei'), attempt);
  if (CFG.GAS_FIXED_GWEI) {
    const g = capGwei(ethers.parseUnits(String(CFG.GAS_FIXED_GWEI), 'gwei'));
    maxFeePerGas = g; maxPriorityFeePerGas = g > prioMax ? prioMax : g;
  }
  return {
    type: 2,
    gasPrice: maxFeePerGas, // 仅用于日志/展示
    tx: { type: 2, maxFeePerGas, maxPriorityFeePerGas },
    desc: `maxFee=${ethers.formatUnits(maxFeePerGas, 'gwei')} prio=${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')}gwei`
  };
}

// ---------------- 后台确认 ----------------
// 广播后不等 receipt，确认过程放后台，成功/失败单独打日志并回调。
// 失败时通过 onFailed 把"已领取"标记撤掉，下一轮会重试，不会漏退款。
function confirmTxInBackground(inst, tx, opt, nonce) {
  (async () => {
    try {
      const receipt = await withTimeout(tx.wait(1, CFG.TX_WAIT_MS), CFG.TX_WAIT_MS + 10000, 'wait');
      if (receipt && receipt.status === 1) {
        ok(inst.address, `${opt.label} 已确认! hash=${tx.hash} gasUsed=${receipt.gasUsed} block=${receipt.blockNumber}`);
        if (opt.onConfirmed) { try { opt.onConfirmed(); } catch (e) { } }
      } else {
        inst.stats.failed++;
        err(inst.address, `${opt.label} 上链失败(status=0): ${tx.hash} -> 可能 revert，请到区块浏览器查看`);
        if (opt.onFailed) { try { opt.onFailed(); } catch (e) { } }
      }
    } catch (e) {
      // 超时 != 失败: 交易可能还在 mempool。这里必须做"同 nonce 加价重播"，
      // 否则一旦这笔被公共节点丢弃，nonce 就永久断档 —— 该账号后续所有交易
      // 都会排在它后面卡死，直到进程重启(drainPending 只在启动时跑一次)。
      const reb = await rebroadcastSameNonce(inst, tx, nonce);
      if (reb) {
        warnOnce(inst.address, `${opt.label} 确认超时，已按同 nonce(${nonce}) 加价重播: ${reb}`, 30000);
        return;
      }
      inst.stats.failed++;
      warnOnce(inst.address, `${opt.label} 确认超时: ${tx.hash} -> 已交给 nonce 巡检，稍后会自动补交易填坑`, 30000);
      if (opt.onFailed) { try { opt.onFailed(); } catch (e) { } }
    }
  })().catch(() => { });
}

// 用完全相同的 nonce + 更高 gas 重播原交易（内容不变，只换手续费）
async function rebroadcastSameNonce(inst, tx, nonce) {
  if (DRY_RUN) return null;
  // 广播必须和 sendTx / gapFixer 共用同一把 nonce 锁，
  // 否则三者可能同时用同一个 nonce 发交易，互相覆盖
  const release = await inst.mutex.acquire();
  try {
    const fee = await buildFeeParams(2);   // attempt=2 -> 1.3 倍加价
    const rep = await withTimeout(inst.wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value || 0n,
      nonce,
      gasLimit: tx.gasLimit || undefined,
      ...fee.tx
    }), 30000, 'rebroadcast');
    return rep.hash;
  } catch (e) {
    warnOnce(inst.address, `同 nonce(${nonce}) 重播失败: ${formatError(e)}`, 60000);
    return null;
  } finally {
    release();
  }
}

// ---------------- nonce 断档自愈 ----------------
// 定时对比 latest / pending: 只要"有在途交易"且 latest 长时间不推进，就在缺失的
// nonce 上补一笔 0 值自转。它既能替换掉被 mempool 丢弃的那笔，也能把 nonce 空洞填平，
// 让账号不会因为一笔丢包就静默死亡。
function startGapFixer(inst) {
  if (DRY_RUN || SELFTEST) return;
  let lastLatest = -1;
  let sameSince = Date.now();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const latest = Number(await mgr.rpc(p => p.getTransactionCount(inst.address, 'latest')));
      const pending = Number(await mgr.rpc(p => p.getTransactionCount(inst.address, 'pending')));
      if (latest !== lastLatest) { lastLatest = latest; sameSince = Date.now(); return; }
      if (pending <= latest) return;                            // 没有在途交易，健康
      if (Date.now() - sameSince < CFG.GAP_STUCK_MS) return;    // 还没卡够久
      const stuck = Math.round((Date.now() - sameSince) / 1000);
      warn(inst.address, `nonce 疑似卡住: latest=${latest} pending=${pending} 已 ${stuck}s 未推进 -> 在 nonce=${latest} 补一笔 0 值自转填坑`);
      // 和 sendTx / 重播共用 nonce 锁，避免三方同时用同一 nonce 广播
      const release = await inst.mutex.acquire();
      try {
        const fee = await buildFeeParams(2);
        const tx = await withTimeout(inst.wallet.sendTransaction({
          to: inst.address, value: 0n, nonce: latest, gasLimit: 21000n, ...fee.tx
        }), 30000, 'gapfill');
        ok(inst.address, `填坑交易已广播: ${tx.hash} (nonce=${latest})`);
        inst.nonce = null;      // 让后续交易重新读 pending，避免继续用错号
      } finally {
        release();
      }
      sameSince = Date.now();
    } catch (e) {
      warnOnce(inst.address, `nonce 巡检失败: ${formatError(e)}`, 60000);
    } finally {
      busy = false;
    }
  }, CFG.GAP_CHECK_MS);
}

// ---------------- 统一交易发送 ----------------
async function sendTx(inst, opt) {
  const release = await inst.mutex.acquire();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // ---- 手续费策略: 运行时探测链是否支持 EIP-1559，不硬编码交易类型 ----
        const fee = await buildFeeParams(attempt);
        const gasPrice = fee.gasPrice;

        // gasLimit 预估(同时充当 revert 预检)
        let gasLimit;
        try {
          const est = await withTimeout(
            opt.contract[opt.method].estimateGas(...opt.args, { from: inst.address }),
            12000, 'estimateGas'
          );
          gasLimit = (est * 125n) / 100n;
          if (gasLimit > BigInt(CFG.GAS_LIMIT_CAP)) gasLimit = BigInt(CFG.GAS_LIMIT_CAP);
        } catch (e) {
          // 抢单高峰 revert 很常见(人数已满/已入场)，必须节流，否则每块刷屏
          errOnce(inst.address, `${opt.label} 预检失败(不会上链): ${formatError(e)}`, 15000);
          return false;
        }

        const nonce = inst.nonce !== null
          ? inst.nonce
          : await mgr.rpc(p => p.getTransactionCount(inst.address, 'pending'));

        if (DRY_RUN) {
          info(inst.address, `[DRY-RUN] 将发送 ${opt.label}: to=${opt.contract.target} fn=${opt.method}(${opt.args.map(String).join(',')}) nonce=${nonce} gas=${gasLimit} gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei`);
          return true;
        }

        const tx = await withTimeout(
          opt.contract[opt.method](...opt.args, Object.assign({ gasLimit, nonce }, fee.tx)),
          30000, 'send'
        );
        info(inst.address, `${opt.label} 交易已广播: ${tx.hash} (nonce=${nonce}, gas=${gasLimit}, ${fee.desc}, type=${fee.type})`);
        // 广播成功就立刻推进本地 nonce，保证同一账号后续交易不会撞号
        inst.nonce = nonce + 1;

        if (opt.noWait) {
          // 不等上链: 拿到 hash 就交还控制权(领取退款专用)。
          // 若等 90 秒 receipt，抢单雷达会在这期间完全瞎掉。
          // nonce 锁只在"广播"这一瞬间持有，确认交给后台，不会卡住抢单。
          inst.stats.sent++;
          confirmTxInBackground(inst, tx, opt, nonce);
          return true;
        }

        let receipt;
        try {
          receipt = await withTimeout(tx.wait(1, CFG.TX_WAIT_MS), CFG.TX_WAIT_MS + 10000, 'wait');
        } catch (e) {
          warn(inst.address, `${opt.label} 等待确认超时: ${tx.hash} -> 需手动确认，暂时锁定 nonce`);
          inst.nonce = null;
          return false;
        }
        if (receipt && receipt.status === 1) {
          inst.stats.sent++;
          ok(inst.address, `${opt.label} 成功! hash=${tx.hash} gasUsed=${receipt.gasUsed} block=${receipt.blockNumber}`);
          return true;
        }
        inst.nonce = null;
        inst.stats.failed++;
        err(inst.address, `${opt.label} 链上失败(status=0): ${tx.hash} gasUsed=${receipt ? receipt.gasUsed : '?'} -> 可能触发 revert，请到区块浏览器查看`);
        return false;
      } catch (e) {
        const c = e.code || '';
        if (c === 'NONCE_EXPIRED' || /nonce/i.test(e.shortMessage || e.message || '')) {
          warn(inst.address, `${opt.label} nonce 冲突，刷新后重试: ${formatError(e)}`);
          inst.nonce = null;
          await sleep(500);
          continue;
        }
        if (c === 'REPLACEMENT_UNDERPRICED') {
          warn(inst.address, `${opt.label} gas 过低(replacement underpriced)，加价重试`);
          await sleep(500);
          continue;
        }
        if (c === 'INSUFFICIENT_FUNDS') {
          err(inst.address, `${opt.label} BNB 不足以支付 gas: ${formatError(e)}`);
          inst.nonce = null;
          return false;
        }
        if (c === 'CALL_EXCEPTION') {
          err(inst.address, `${opt.label} 合约调用失败(revert): ${formatError(e)}`);
          inst.nonce = null;
          return false;
        }
        if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT'].includes(c)) {
          warn(inst.address, `${opt.label} 网络异常(${c})，切换节点重试(${attempt}/2): ${formatError(e)}`);
          await mgr.rotate();
          await sleep(800);
          continue;
        }
        err(inst.address, `${opt.label} 未分类错误: ${formatError(e)}`);
        inst.nonce = null;
        return false;
      }
    }
    return false;
  } finally {
    release();
  }
}

// ---------------- 共享只读合约 ----------------
// 所有账号共用同一个 provider 合约读轮次状态，避免 N 个账号重复发同样的查询
let readQueue = null;
function bindRead(p) { try { readQueue = new ethers.Contract(CFG.QUEUE_ADDR, QUEUE_ABI, p); } catch (e) { } }
mgr.onRotate(bindRead);

// ---------------- 出块共享状态缓存 ----------------
// 同一个区块内，所有房间/所有账号共用一份查询结果 -> 请求量从 O(账号数×房间×3) 降到 O(房间×3)
const sharedCache = { height: -1, at: 0, rooms: null };
// 票价/容量/开关这类配置几乎不变，缓存 60s；否则每个块都要为每个房间多打一次 RPC
const roomCfgCache = new Map();
async function getRoomCfg(room) {
  const c = roomCfgCache.get(room);
  if (c && Date.now() - c.at < 60000) return c.cfg;
  const cfg = await mgr.rpc(p => readQueue.roomConfigs(room)).catch(() => null);
  if (cfg) roomCfgCache.set(room, { at: Date.now(), cfg });
  return cfg;
}
async function getSharedState(height) {
  if (sharedCache.rooms && sharedCache.height === height && Date.now() - sharedCache.at < 3000) return sharedCache.rooms;
  if (!readQueue) bindRead(mgr.provider);
  // 房间之间并行查(串行 3 房间 = 6 个 RTT，BSC 0.75s 出块根本来不及)
  const pairs = await Promise.all(CFG.ROOMS.map(async room => {
    try {
      const rId = Number(await mgr.rpc(p => readQueue.currentRound(room)));
      // currentRound=0 说明该房间还没开过任何一轮，查 roundInfo(room,0) 必然 revert，
      // 这是正常状态，不要当成错误刷告警
      if (rId === 0) return null;
      const [info2, cfg] = await Promise.all([
        mgr.rpc(p => readQueue.roundInfo(room, rId)).catch(() => null),
        getRoomCfg(room)
      ]);
      if (!info2) {
        warnOnce('SYS', `房间${room} roundInfo 返回空，本轮跳过该房间`, 30000);
        return null;
      }
      return [room, {
        rId,
        count: Number(info2.count),
        state: Number(info2.state),
        startTime: Number(info2.startTime),
        enabled: cfg ? cfg.enabled !== false : true,
        ticketPrice: cfg ? cfg.ticketPrice : null
      }];
    } catch (e) {
      warnOnce('SYS', `读取房间${room} 状态失败: ${formatError(e).slice(0, 140)}`, 30000);
      return null;
    }
  }));
  const rooms = {};
  for (const p of pairs) if (p) rooms[p[0]] = p[1];
  // 一个房间都没读出来就别写缓存，否则接下来 3 秒会一直返回"空状态"
  if (Object.keys(rooms).length) {
    sharedCache.height = height; sharedCache.at = Date.now(); sharedCache.rooms = rooms;
  }
  return rooms;
}

// ---------------- 启动排水: 解决重启后 nonce 脏数据 ----------------
// 崩溃/重启后内存中维护的 nonce 丢失，若上一笔交易还在 mempool，
// RPC 的 pending nonce 可能尚未更新 -> 直接发会 nonce too low 或覆盖前一笔。
// 这里在启动(或重启)后先等 pending == latest，确认没有在途交易再开始。
async function drainPending(inst) {
  const t0 = Date.now();
  try {
    let latest = Number(await mgr.rpc(p => p.getTransactionCount(inst.address, 'latest')));
    let pending = Number(await mgr.rpc(p => p.getTransactionCount(inst.address, 'pending')));
    if (pending <= latest) { inst.nonce = pending; return; }
    warn(inst.address, `检测到 ${pending - latest} 笔在途交易，等待其确认后再开始(最多 ${Math.round(CFG.STARTUP_DRAIN_MS / 1000)}s)...`);
    while (Date.now() - t0 < CFG.STARTUP_DRAIN_MS) {
      await sleep(2000);
      latest = Number(await mgr.rpc(p => p.getTransactionCount(inst.address, 'latest')));
      pending = Number(await mgr.rpc(p => p.getTransactionCount(inst.address, 'pending')));
      if (pending <= latest) {
        inst.nonce = pending;
        ok(inst.address, `在途交易已清空，起始 nonce=${pending}`);
        return;
      }
    }
    warn(inst.address, `排水超时，仍有 ${pending - latest} 笔在途；改用 pending nonce=${pending} 并继续(失败会自动重试)`);
    inst.nonce = pending;
  } catch (e) {
    warn(inst.address, `排水检查失败，按运行时获取 nonce 处理: ${formatError(e).slice(0, 140)}`);
    inst.nonce = null;
  }
}

// ---------------- 抢单 ----------------
async function snipeWithState(inst, rooms) {
  if (!inst || inst.busy) return;
  inst.busy = true;
  try {
    for (const room of CFG.ROOMS) {
      const st = rooms[room];
      if (!st) continue;
      const count = st.count;
      if (st.state !== 0) continue;                    // 0=进行中
      if (count < inst.min || count >= inst.max) continue;

      const now = Math.floor(Date.now() / 1000);
      if (now < st.startTime + inst.delayMs / 1000) continue;

      const key = `${room}:${st.rId}`;
      if (inst.acted.has(key)) continue;
      if (!st.enabled) { warnOnce(inst.address, `${roomLabel(room, st.ticketPrice)} 已停用，跳过`, 300000); continue; }
      // 注意不能用 !st.ticketPrice 判断: 0n 在 JS 里是 falsy，票价真为 0 时会被误判成"读不到票价"
      if (st.ticketPrice === null || st.ticketPrice === undefined) {
        errOnce(inst.address, `[房间${room}] 读不到票价(roomConfigs 返回空)，跳过本轮。排查: 该房间是否已在链上配置`, 300000);
        continue;
      }
      const tag = roomLabel(room, st.ticketPrice);

      if (!(await ensureFunds(inst, st.ticketPrice, room))) { continue; }

      inst.acted.add(key);
      const okTx = await sendTx(inst, {
        label: `[${tag}] 入场(当前 ${count} 人, 轮次 ${st.rId})`,
        contract: inst.queue,
        method: 'enterQueue',
        args: [room, inst.referrer]
      });
      if (!okTx) inst.acted.delete(key); // 失败允许重试
    }
  } catch (e) {
    err(inst.address, '抢单流程异常: ' + formatError(e));
    err(inst.address, '抢单流程排查: 若持续报错，先用 --selftest 检查合约地址/ABI/余额/授权');
  } finally {
    inst.busy = false;
    if (inst.acted.size > 300) inst.acted = new Set([...inst.acted].slice(-100));
  }
}

// ---------------- 领取返利 ----------------
// roundInfo 全局缓存: 已结算轮次的信息永远不变，同一个 (房间,轮次) 只查一次。
// 多账号共享这份缓存，请求量从 O(账号 × 房间 × 轮次) 降到 O(房间 × 轮次)。
const roundInfoCache = new Map();
async function getRoundInfo(inst, room, r) {
  const key = `${room}:${r}`;
  const hit = roundInfoCache.get(key);
  // 已结算(state!=0) -> 永久复用；进行中 -> 10 秒内复用
  if (hit && (hit.settled || Date.now() - hit.at < 10000)) return hit;
  const info2 = await mgr.rpc(p => inst.queue.roundInfo(room, r));
  const state = Number(info2.state);
  const rec = {
    at: Date.now(),
    count: Number(info2.count),
    state,
    winners: (info2.winners || []).map(w => String(w).toLowerCase()),
    settled: state !== 0
  };
  roundInfoCache.set(key, rec);
  if (roundInfoCache.size > 3000) {
    [...roundInfoCache.keys()].slice(0, 1000).forEach(k => roundInfoCache.delete(k));
  }
  return rec;
}

async function claimLoop(inst) {
  while (true) {
    try {
      for (const room of CFG.ROOMS) {
        const rId = Number(await mgr.rpc(p => inst.queue.currentRound(room)));
        const start = Math.max(0, rId - CFG.CLAIM_LOOKBACK);
        // 重要: 不再用 state === 2 过滤。进行中(state 0)的轮次同样可能允许退款，
        // 只按 "本轮有人(count>0) 且 我不是中奖者" 粗筛，能不能领一律交给
        // staticCall 预检决定 —— 这样才不会漏掉任何一笔退款。
        // 注意用 <= : 当前轮次(rId)也要扫。
        for (let r = start; r <= rId; r++) {
          const ck = `${room}:${r}`;
          // 已处理过的轮次直接跳过，连 roundInfo 都不查 —— 这是省掉绝大部分请求的关键
          if (inst.claimed.has(ck)) continue;
          let rec;
          try { rec = await getRoundInfo(inst, room, r); }
          catch (e) { continue; }               // 单轮读取失败不影响其他轮次
          if (rec.count <= 0) continue;         // 空轮次，无人可退
          if (rec.winners.includes(inst.address.toLowerCase())) continue; // 中奖者不退款

          // 预检: 不报错就说明可领。报错(Queue: not in round / claimed 等)静默跳过
          let claimable = true;
          try {
            await mgr.rpc(p => inst.queue.claimRefundAndAirdrop.staticCall(room, r, { from: inst.address }));
          } catch (e) {
            claimable = false;
            // 关键: 只有"合约明确拒绝"(revert) 才能永久跳过。
            // 节点超时 / 429 / 网络抖动 属于软失败，一旦标记永久，这个账号就
            // 永远漏掉这笔退款/空投了，而且没有任何补救机会。
            const hardFail = e.code === 'CALL_EXCEPTION' || decodeRevert(e) !== null;
            if (hardFail && rec.state !== 0) inst.claimed.add(ck);
            else if (!hardFail) {
              warnOnce(inst.address, `[房间${room}] 轮次${r} 预检遇到网络问题，稍后重试(不标记已领): ${formatError(e).slice(0, 120)}`, 60000);
            }
          }
          if (!claimable) continue;

          // 领取不等上链: 广播成功即返回，确认在后台进行。
          // 这样领取不会占用 nonce 锁长达数十秒，抢单雷达始终在线。
          const okTx = await sendTx(inst, {
            label: `[房间${room}] 领取返利 轮次${r}(state=${rec.state})`,
            contract: inst.queue,
            method: 'claimRefundAndAirdrop',
            args: [room, r],
            noWait: true,
            onFailed: () => { inst.claimed.delete(ck); }  // 上链失败就撤标记，下轮重试
          });
          if (okTx) inst.claimed.add(ck);
          else errOnce(inst.address, `[房间${room}] 轮次${r} 预检通过但广播失败，下一轮会重试。排查: 该轮是否已过期/已被他人结算`, 30000);
        }
      }
    } catch (e) {
      err(inst.address, '领取流程异常: ' + formatError(e));
      err(inst.address, '领取流程排查: currentRound/roundInfo 是否为预期格式; 合约地址或房间号是否变更');
    }
    if (inst.claimed.size > 500) inst.claimed = new Set([...inst.claimed].slice(-200));
    await sleep(CFG.CLAIM_INTERVAL_MS + Math.random() * 5000);
  }
}

// ---------------- 自检 ----------------
let selftestWallets = [];
async function selftest() {
  console.log(C.b + '\n========== FTS 自检报告 ==========' + C.d);
  console.log(`引擎版本: ${VERSION} | node: ${process.version} | ethers: ${ethers.version}`);
  console.log(`WS 可用: ${ensureWebSocket()} | 队列合约: ${CFG.QUEUE_ADDR} | USDT: ${CFG.USDT_ADDR}`);

  console.log('\n--- 1. RPC 节点探测 ---');
  try { await mgr.pickBest(); } catch (e) { fatal('SYS', formatError(e)); process.exit(1); }

  console.log('\n--- 2. 合约存在性 ---');
  for (const [name, addr] of [['QUEUE', CFG.QUEUE_ADDR], ['USDT', CFG.USDT_ADDR]]) {
    const code = await mgr.rpc(p => p.getCode(addr));
    console.log(`  ${name} ${addr}: ${code && code !== '0x' ? '有合约代码 (长度 ' + code.length + ')' : '❌ 无合约代码，地址可能错误'}`);
  }

  console.log('\n--- 3. 合约方法探测 ---');
  const probe = async (label, fn) => {
    try { const v = await mgr.rpc(p => withTimeout(fn(), 10000, label)); console.log(`  ✅ ${label}: ${String(v).slice(0, 120)}`); return v; }
    catch (e) { console.log(`  ❌ ${label}: ${formatError(e)}`); return null; }
  };
  const qRead = new ethers.Contract(CFG.QUEUE_ADDR, QUEUE_ABI, mgr.provider);
  const uRead = new ethers.Contract(CFG.USDT_ADDR, USDT_ABI, mgr.provider);
  await probe('QUEUE.currentRound(0)', () => qRead.currentRound(0));
  // 逐个房间体检(0=10U 1=50U 2=100U)，房间不存在/未启用要能一眼看出
  const roomOk = {};
  for (const room of CFG.ROOMS) {
    // 注意: probe 返回的是格式化后的字符串，这里另外取一次原始对象用于判断。
    // 读取失败会重试 3 次，避免一次网络抖动被误判成"房间不存在"
    await probe(`QUEUE.roomConfigs(${room})`, () => qRead.roomConfigs(room).then(c =>
      `ticketPrice=${ethers.formatUnits(c.ticketPrice, 18)} max=${c.maxCapacity} winners=${c.winnerCount} enabled=${c.enabled} daily=${c.dailyRoundLimit}/已开${c.todayRounds}`));
    let cfg = null, lastCfgErr = null;
    for (let a = 0; a < 3 && !cfg; a++) {
      try { cfg = await qRead.roomConfigs(room); } catch (e) { lastCfgErr = e; await sleep(600); }
    }
    if (cfg && cfg.ticketPrice !== undefined && cfg.ticketPrice !== null) {
      const enabled = cfg.enabled;
      const price = Number(ethers.formatUnits(cfg.ticketPrice, 18));
      roomOk[room] = enabled;
      const expect = { 0: 10, 1: 50, 2: 100 }[room];
      if (expect && price !== expect) console.log(`  ⚠️ 房间${room} 链上票价 ${price}U 与预设 ${expect}U 不符，以链上为准`);
      if (!enabled) console.log(`  ⚠️ 房间${room} 链上标记为停用(enabled=false)，脚本会自动跳过`);
      await probe(`QUEUE.currentRound(${room})`, () => qRead.currentRound(room));
      const rid = await qRead.currentRound(room).catch(() => null);
      // currentRound 为 0 表示这个房间还没开过任何一轮，此时查 roundInfo(room,0)
      // 会 revert(ARRAY_RANGE_ERROR)，那是正常的，不该报成 ❌
      if (rid !== null && BigInt(rid) > 0n) {
        await probe(`QUEUE.roundInfo(${room}, ${rid})`, () => qRead.roundInfo(room, rid).then(i =>
          `count=${i.count} state=${i.state} start=${i.startTime} deadline=${i.deadline} winners=${i.winners.length}`));
      } else if (rid !== null) {
        console.log(`  ○ 房间${room} 尚无任何轮次(currentRound=0)，跳过 roundInfo 查询`);
      }
      // 每日轮次上限: 用完后再入场必然 revert，提前说清楚，别让人以为是脚本坏了
      const dLimit = Number(cfg.dailyRoundLimit), dUsed = Number(cfg.todayRounds);
      if (dLimit > 0 && dUsed >= dLimit) {
        console.log(`  ⚠️ 房间${room} 今日轮次已用完 (${dUsed}/${dLimit})，现在入场会 revert "Queue: daily round limit"，需等次日重置`);
      }
    } else {
      roomOk[room] = false;
      console.log(`  ⚠️ 房间${room} 读取失败(已重试 3 次): ${lastCfgErr ? formatError(lastCfgErr) : '返回空'}`);
      console.log(`     含义: 该房间可能未在链上配置，或合约不支持 roomConfigs(${room})。脚本会自动跳过，其他房间不受影响`);
    }
  }
  // 队列合约没有 allowance，这是"兼容性探测"，失败才是预期结果，不该报 ❌
  try {
    await mgr.rpc(p => qRead.allowance(CFG.QUEUE_ADDR, CFG.QUEUE_ADDR));
    console.log('  ✅ QUEUE.allowance 可调用(意外: 该合约本不该有 allowance)');
  } catch (e) {
    console.log('  ○ QUEUE.allowance 不可调用(符合预期: 授权额度以 USDT 合约为准)');
  }
  await probe('USDT.decimals', () => uRead.decimals());
  await probe('USDT.symbol', () => uRead.symbol());

  console.log('\n--- 4. 账号检查 ---');
  // 复用 main 已经加载好的钱包列表，不再重复 loadWallets()(否则校验失败信息会打印两遍)
  const wallets = selftestWallets;
  if (!wallets.length) { fatal('CFG', 'wallets.json 中没有有效账号'); process.exit(1); }
  let allReady = true;
  for (const w of wallets) {
    console.log(`\n  账号 ${w.ADDRESS}`);
    if (w.wallet.address.toLowerCase() !== w.ADDRESS.toLowerCase()) {
      console.log('   ❌ 私钥与地址不匹配，跳过'); allReady = false; continue;
    }
    const bnb = await mgr.rpc(p => p.getBalance(w.ADDRESS));
    const usdt = await mgr.rpc(p => uRead.balanceOf(w.ADDRESS));
    const allow = await mgr.rpc(p => uRead.allowance(w.ADDRESS, CFG.QUEUE_ADDR));
    console.log(`   BNB=${ethers.formatEther(bnb)} | USDT=${ethers.formatUnits(usdt, 18)} | 已授权=${ethers.formatUnits(allow, 18)} (单轮授权模式)`);
    if (bnb < ethers.parseEther('0.005')) { console.log('   ❌ BNB 不足，无法支付 gas，所有交易都会失败'); allReady = false; }
    // 逐房间说明钱够不够
    for (const room of CFG.ROOMS) {
      if (!roomOk[room]) continue;
      const cfg = await qRead.roomConfigs(room).catch(() => null);
      if (!cfg) continue;
      const p = cfg.ticketPrice;
      const okBal = usdt >= p;
      console.log(`   房间${room}(${ethers.formatUnits(p, 18)}U): USDT ${okBal ? '✅ 够' : '❌ 不够(差 ' + ethers.formatUnits(p - usdt, 18) + ')'}` +
        ` | 授权 ${allow >= p ? '✅ 够' : '⚠️ 需先授权 ' + ethers.formatUnits(p, 18)}`);
      if (!okBal) allReady = false;
    }
    if (allow === 0n) console.log('   ⚠️ 授权为 0，首次入场会自动发起"单轮票价"授权交易');
  }

  console.log('\n--- 5. 交易预演 (不上链，一分钱不花) ---');
  for (const w of wallets) {
    for (const room of CFG.ROOMS) {
      let cfg = null;
      try { cfg = await mgr.rpc(p => qRead.roomConfigs(room)); } catch (e) { }
      if (!cfg || !cfg.ticketPrice) {
        console.log(`  ○ ${short(w.ADDRESS)} 房间${room} 未启用/未配置，跳过预演(运行时也会自动跳过)`);
        continue;
      }
      if (cfg.enabled === false) {
        console.log(`  ○ ${short(w.ADDRESS)} 房间${room}(${ethers.formatUnits(cfg.ticketPrice, 18)}U) 链上已停用，跳过预演`);
        continue;
      }
      const tag = roomLabel(room, cfg.ticketPrice);
      try {
        const data = qRead.interface.encodeFunctionData('enterQueue', [room, w.REFERRER]);
        await mgr.rpc(p => withTimeout(p.call({ to: CFG.QUEUE_ADDR, from: w.ADDRESS, data }), 10000, 'enterQueue.call'));
        console.log(`  ✅ ${short(w.ADDRESS)} [${tag}] enterQueue 预演通过`);
      } catch (e) {
        const txt = String(e.shortMessage || e.reason || e.message || '');
        // 每日上限 / 房间满员属于"业务状态"，不是配置错误，不该算阻塞项
        if (/daily round limit|full|capacity/i.test(txt)) {
          console.log(`  ℹ️ ${short(w.ADDRESS)} [${tag}] enterQueue 预演未通过(业务状态，非配置问题): ${txt.slice(0, 120)}`);
        } else {
          console.log(`  ❌ ${short(w.ADDRESS)} [${tag}] enterQueue 预演失败: ${formatError(e)}`);
          console.log(`     排查: ①该账号是否已绑定推荐人 ②是否已在其他轮次排队 ③房间是否满员/已达每日上限 ④USDT 余额或授权是否不足`);
          allReady = false;
        }
      }
    }
    for (const room of CFG.ROOMS) {
      if (roomOk[room] === false) continue;
      try {
        const rId = Number(await mgr.rpc(p => qRead.currentRound(room)));
        if (rId <= 0) continue;
        const data = qRead.interface.encodeFunctionData('claimRefundAndAirdrop', [room, rId - 1]);
        await mgr.rpc(p => withTimeout(p.call({ to: CFG.QUEUE_ADDR, from: w.ADDRESS, data }), 10000, 'claim.call'));
        console.log(`  ✅ ${short(w.ADDRESS)} [房间${room}] claimRefundAndAirdrop 预演通过`);
      } catch (e) {
        console.log(`  ℹ️ ${short(w.ADDRESS)} [房间${room}] claim 预演不可用(多为当前无可领轮次，属正常): ${formatError(e).slice(0, 160)}`);
      }
    }
  }

  console.log('\n========== 自检结论 ==========');
  console.log(allReady ? C.g + '✅ 具备交易条件，可执行: ' + LAUNCH + ' --run' + C.d : C.y + '⚠️ 存在阻塞项，请根据上方 ❌ 修复后再运行' + C.d);
  process.exit(allReady ? 0 : 1);
}

// ---------------- 钱包加载 ----------------
function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) {
    fatal('CFG', `找不到 ${WALLETS_FILE}，请先运行配置向导`);
    return [];
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8').replace(/^﻿/, '')); }
  catch (e) { fatal('CFG', `wallets.json 解析失败: ${e.message}`); return []; }
  const list = data.wallets || [];
  const out = [];
  for (const c of list) {
    try {
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(c.PRIVATE_KEY || '')) { fatal('CFG', `私钥格式错误(需64位hex): ${short(c.ADDRESS)}`); continue; }
      const pk = c.PRIVATE_KEY.startsWith('0x') ? c.PRIVATE_KEY : '0x' + c.PRIVATE_KEY;
      const wallet = new ethers.Wallet(pk);
      if (!/^0x[a-fA-F0-9]{40}$/.test(c.ADDRESS || '')) { fatal('CFG', `地址格式错误: ${c.ADDRESS}`); continue; }
      if (wallet.address.toLowerCase() !== c.ADDRESS.toLowerCase()) { fatal('CFG', `私钥与地址不匹配: 配置=${c.ADDRESS} 实际=${wallet.address}`); continue; }
      if (!/^0x[a-fA-F0-9]{40}$/.test(c.REFERRER || '')) { fatal('CFG', `推荐人地址格式错误: ${c.REFERRER}`); continue; }
      out.push({ ...c, pk, wallet });
    } catch (e) {
      fatal('CFG', `账号加载失败: ${formatError(e)}`);
    }
  }
  return out;
}

// ---------------- 主流程 ----------------
async function main() {
  // 配置校验: 有问题就地修正并明确告知，不让它悄悄生效或让引擎崩掉
  const cfgIssues = validateCfg();
  if (cfgIssues.length) {
    warn('SYS', `配置发现 ${cfgIssues.length} 处问题，已按下列方式处理:`);
    cfgIssues.forEach(s => warn('SYS', '  - ' + s));
  }

  const gasDesc = CFG.GAS_FIXED_GWEI
    ? `固定 ${CFG.GAS_FIXED_GWEI} gwei`
    : `自动 ×${CFG.GAS_MULT} (上限 ${CFG.GAS_MAX_GWEI} gwei)`;
  info('SYS', `FTS 引擎 v${VERSION} 启动 | 模式=${MODE} | 房间=${CFG.ROOMS.join(',')} | 抢位=[${CFG.SNIPE_MIN_COUNT},${CFG.SNIPE_MAX_COUNT}) | 延迟=${CFG.SNIPE_DELAY_MS}ms | 手续费=${gasDesc}`);
  const wallets = loadWallets();
  if (!wallets.length) { fatal('SYS', '没有可用账号，退出(错误码 21)'); process.exit(21); }
  try { fs.chmodSync(WALLETS_FILE, 0o600); } catch (e) { }

  if (SELFTEST) { selftestWallets = wallets; return selftest(); }

  try { await mgr.pickBest(); }
  catch (e) { fatal('SYS', 'RPC 初始化失败: ' + formatError(e)); process.exit(22); }
  bindRead(mgr.provider);
  await detectEip1559();

  for (const w of wallets) {
    const inst = {
      conf: w, pk: w.pk, address: w.wallet.address, wallet: null, provider: null, queue: null, usdt: null,
      referrer: w.REFERRER,
      min: num(w.SNIPE_MIN_COUNT, CFG.SNIPE_MIN_COUNT),
      max: num(w.SNIPE_MAX_COUNT, CFG.SNIPE_MAX_COUNT),
      delayMs: num(w.SNIPE_DELAY_MS, CFG.SNIPE_DELAY_MS),
      mutex: new (class { constructor() { this.q = Promise.resolve(); } async acquire() { let rel; const next = new Promise(r => rel = r); const prev = this.q; this.q = this.q.then(() => next); await prev; return rel; } })(),
      acted: new Set(), claimed: new Set(), nonce: null, busy: false,
      bnbCache: null,
      stats: { sent: 0, failed: 0 }
    };
    bind(inst, mgr.provider);
    instances.push(inst);
    ok(inst.address, '账号加载完成');
  }

  // 排水并行做: 串行时 10 个账号最坏要等 5 分钟才能开始抢第一单
  await Promise.all(instances.map(i => drainPending(i)));

  for (const inst of instances) {
    startGapFixer(inst);   // nonce 断档自愈
    claimLoop(inst);
  }

  const stream = new BlockStream();
  stream.start();

  // 崩溃自愈测试钩子
  if (process.env.FTS_CRASH_TEST === '1') {
    setTimeout(() => { console.error('[CRASH-TEST] 模拟崩溃退出'); process.exit(99); }, 5000);
  }

  // 状态心跳
  setInterval(() => {
    const s = instances.map(i => `${short(i.address)}(tx${i.stats.sent}/f${i.stats.failed})`).join(' ');
    // 带上块高/已处理块数，方便一眼看出"是不是卡住了"
    info('SYS', `心跳 | 节点=${CFG.HTTP_POOL[mgr.index]} | WS=${stream.wsOk ? '连接' : '轮询'} | 块高=${stream.lastHeight} 已处理=${stream.tickCount} 去重=${stream.dupSkipped} | ${s}`);
  }, 60000);

  // 未捕获异常: 单次异常继续跑(公共节点抖动很常见)，但短时间连续爆就退出，
  // 交给外壳重启 —— 状态机可能已经被搞坏了，硬撑着跑比重启更危险。
  let crashN = 0, crashAt = Date.now();
  process.on('uncaughtException', e => {
    const now = Date.now();
    if (now - crashAt > 60000) { crashN = 0; crashAt = now; }
    crashN++;
    err('SYS', `未捕获异常(${crashN}/20，进程继续): ` + formatError(e));
    if (crashN >= 20) {
      fatal('SYS', '60 秒内未捕获异常超过 20 次，主动退出让外壳重启');
      try { logStream && logStream.end(); } catch (x) { }
      process.exit(24);
    }
  });
  process.on('unhandledRejection', e => { err('SYS', '未处理Promise拒绝: ' + formatError(e && e.message ? e.message : String(e))); });
}

main().catch(e => { fatal('SYS', '主流程致命错误: ' + formatError(e)); process.exit(23); });
