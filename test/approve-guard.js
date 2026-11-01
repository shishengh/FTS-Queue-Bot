#!/usr/bin/env node
/**
 * APPROVE 配置边界回归测试
 *
 * 背景: ensureFunds 里算授权额度那几行原本没有保护，三个配置边界会让它**永久抛异常**：
 *   - APPROVE_ROUNDS 非整数(1.5)  -> BigInt(1.5) 抛 RangeError
 *   - APPROVE_USD 过大(>=1e21)     -> String() 变成 "1e+21"，parseUnits 不认
 *   - APPROVE_USD 为负            -> parseUnits 能过，但 approve(uint256) 编码时炸
 * 异常从 ensureFunds 冒到抢单流程的 catch，账号每轮都在这里失败，且日志被节流后几乎看不见。
 *
 * 做法: 把 validateCfg / ensureFunds 从 src/core.js 里整段抽出来，注入桩函数跑一遍。
 *
 * 用法: node test/approve-guard.js
 */

const fs = require('fs');
const path = require('path');
let ethers;
try {
  ethers = require('ethers');
} catch (e) {
  console.error('本测试需要 ethers: 在仓库根目录执行 npm install ethers@6');
  process.exit(2);
}

const ROOT = path.dirname(__dirname);
const SRC = process.env.CORE_PATH || path.join(ROOT, 'src', 'core.js');
const text = fs.readFileSync(SRC, 'utf8');

function extract(name) {
  const start = text.indexOf(name);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let depth = 0, end = -1;
  for (let j = text.indexOf('{', start); j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return text.slice(start, end);
}

const validateSrc = extract('function validateCfg() {');
const ensureSrc = extract('async function ensureFunds(inst, ticketPrice, room) {');

const CFG = {};
const cfgProblems = [];   // validateCfg 末尾会 concat 这个全局数组
const makeValidate = () => new Function('CFG', 'cfgProblems', validateSrc + '\nreturn validateCfg;')(CFG, cfgProblems);

let problems = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    problems++;
    console.log(`  ❌ ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

// ============ 1. validateCfg 修配置 ============
function baseCfg() {
  return {
    SNIPE_MIN_COUNT: 30, SNIPE_MAX_COUNT: 60, ROOMS: [0], HTTP_POOL: ['x'],
    CLAIM_LOOKBACK: 20, CLAIM_INTERVAL_MS: 30000,
    GAS_MIN_GWEI: 0.01, GAS_MAX_GWEI: 10, GAS_MULT: 1.25, GAS_FIXED_GWEI: 0.05,
    APPROVE_ROUNDS: 1, APPROVE_USD: null,
    MIN_BNB_GAS: 0.005, ACCOUNT_STAGGER_MS: 100, RPC_TIMEOUT_MS: 12000
  };
}

console.log('--- validateCfg ---');

Object.assign(CFG, baseCfg(), { APPROVE_ROUNDS: 1.5 });
makeValidate()();
check('APPROVE_ROUNDS=1.5 -> 1', CFG.APPROVE_ROUNDS === 1, `实际 ${CFG.APPROVE_ROUNDS}`);

Object.assign(CFG, baseCfg(), { APPROVE_USD: -5 });
makeValidate()();
check('APPROVE_USD=-5 -> null(自动)', CFG.APPROVE_USD === null, `实际 ${CFG.APPROVE_USD}`);

Object.assign(CFG, baseCfg(), { APPROVE_USD: 1e30 });
makeValidate()();
check('APPROVE_USD=1e30 -> null(自动)', CFG.APPROVE_USD === null, `实际 ${CFG.APPROVE_USD}`);

Object.assign(CFG, baseCfg(), { APPROVE_USD: 100 });
makeValidate()();
check('APPROVE_USD=100 保持不变', CFG.APPROVE_USD === 100, `实际 ${CFG.APPROVE_USD}`);

// String(1e-7) 是 "1e-7"，用"字符串里有 e"判断会误伤；这里必须保持不变
Object.assign(CFG, baseCfg(), { APPROVE_USD: 0.0000001 });
makeValidate()();
check('APPROVE_USD=1e-7 不被误判(保持原值)', CFG.APPROVE_USD === 0.0000001, `实际 ${CFG.APPROVE_USD}`);

// ============ 2. ensureFunds 不抛异常 ============
console.log('\n--- ensureFunds ---');

const TICKET = ethers.parseUnits('10', 18);   // 一轮 10U
const BAL = ethers.parseUnits('100', 18);

function makeEnsure(cfg) {
  Object.assign(CFG, cfg);
  let approved = null;
  const inst = {
    address: '0xTest',
    usdt: {
      balanceOf: async () => BAL,
      allowance: async () => 0n
    },
    provider: { getBalance: async () => ethers.parseEther('1') },
    bnbCache: null
  };
  const stubs = {
    CFG,
    ethers,
    mgr: { rpc: async (fn) => fn(inst) },
    info: () => { }, err: () => { }, errOnce: () => { }, warnOnce: () => { },
    formatError: (e) => e.message || String(e),
    roomLabel: () => '房间0',
    sendTx: async (_inst, opt) => { approved = opt.args[1]; return true; }
  };
  const fn = new Function(...Object.keys(stubs), ensureSrc + '\nreturn ensureFunds;')(...Object.values(stubs));
  return { run: () => fn(inst, TICKET, 0), getApproved: () => approved };
}

(async () => {
  const cases = [
    ['APPROVE_ROUNDS=1.5', { APPROVE_ROUNDS: 1.5, APPROVE_USD: null }, TICKET],
    ['APPROVE_USD=1e30', { APPROVE_ROUNDS: 1, APPROVE_USD: 1e30 }, TICKET],
    ['APPROVE_USD=-5', { APPROVE_ROUNDS: 1, APPROVE_USD: -5 }, TICKET],
    ['APPROVE_USD=100', { APPROVE_ROUNDS: 1, APPROVE_USD: 100 }, ethers.parseUnits('100', 18)],
    ['APPROVE_USD=1e-7', { APPROVE_ROUNDS: 1, APPROVE_USD: 0.0000001 }, TICKET]
  ];

  for (const [name, cfg, expect] of cases) {
    const h = makeEnsure(Object.assign(baseCfg(), cfg));
    let threw = null, ret = null;
    try { ret = await h.run(); } catch (e) { threw = e; }
    const got = h.getApproved();
    check(`${name}: 不抛异常`, threw === null, threw && threw.message);
    check(`${name}: 授权额 = ${ethers.formatUnits(expect, 18)}U`,
      got !== null && got === expect, got === null ? '没发起授权' : ethers.formatUnits(got, 18) + 'U');
  }

  console.log('');
  if (problems === 0) {
    console.log('✅ 全部通过');
    process.exit(0);
  }
  console.log(`❌ ${problems} 项失败`);
  process.exit(1);
})();
