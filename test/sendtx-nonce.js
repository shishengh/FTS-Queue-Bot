#!/usr/bin/env node
/**
 * sendTx nonce 复用回归测试
 *
 * 背景: sendTx 内部有 attempt 1/2 两次尝试，attempt 2 会用更高的 gas 重发。
 * 如果第一次广播抛 TIMEOUT（交易其实可能已经进了 mempool），而 nonce 没有跨
 * attempt 保留，attempt 2 会重新读 pending 拿到 N+1，结果变成"并排发两笔"
 * 而不是"同 nonce 加价替换"——白烧一笔 gas，还可能留下 nonce 空洞。
 *
 * 做法: 把 sendTx 从 src/core.js 里按大括号配对整段抽出来，注入桩函数跑一遍，
 * 断言两次广播用的是同一个 nonce、且 pending 只读了一次。
 *
 * 用法: node test/sendtx-nonce.js
 *      （无需依赖，只要 Node 18+）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const SRC = process.env.CORE_PATH || path.join(ROOT, 'src', 'core.js');

// ---- 从 core.js 里抽出 sendTx ----
const text = fs.readFileSync(SRC, 'utf8');
const start = text.indexOf('async function sendTx(inst, opt) {');
if (start < 0) {
  console.error('找不到 sendTx，core.js 结构可能变了，请更新本测试');
  process.exit(2);
}
let depth = 0, end = -1;
for (let j = text.indexOf('{', start); j < text.length; j++) {
  if (text[j] === '{') depth++;
  else if (text[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const fnSrc = text.slice(start, end);

// ---- 桩 ----
const calls = [];
let pendingCalls = 0;
let pendingValue = 5;
const provider = { getTransactionCount: async () => pendingValue };

const stubs = {
  mgr: {
    rpc: async (fn) => { pendingCalls++; return fn(provider); },
    rotate: async () => { }
  },
  buildFeeParams: async (attempt) => ({
    gasPrice: BigInt(attempt) * 1000000000n,
    tx: { gasPrice: BigInt(attempt) * 1000000000n },
    desc: `attempt${attempt}`,
    type: 0
  }),
  ethers: { formatUnits: (v) => String(v) },
  CFG: { GAS_LIMIT_CAP: 800000, TX_WAIT_MS: 50 },
  withTimeout: (p) => p,
  DRY_RUN: false,
  info: () => { }, warn: () => { }, ok: () => { }, err: () => { }, errOnce: () => { },
  sleep: async () => { },
  confirmTxInBackground: () => { },
  formatError: (e) => e.message || String(e)
};

const factory = new Function(...Object.keys(stubs), fnSrc + '\nreturn sendTx;');
const sendTx = factory(...Object.values(stubs));

// ---- 场景: 第一次广播 TIMEOUT，但交易已进 mempool（pending 5 -> 6）----
const inst = {
  address: '0xTest',
  nonce: null,
  provider,
  mutex: { acquire: async () => () => { } },
  stats: { sent: 0, failed: 0 }
};

let attempt = 0;
const send = async (...args) => {
  attempt++;
  const opts = args[args.length - 1];
  calls.push({ attempt, nonce: opts.nonce, gasPrice: Number(opts.gasPrice) });
  if (attempt === 1) {
    pendingValue = 6;
    const e = new Error('request timeout');
    e.code = 'TIMEOUT';
    throw e;
  }
  return {
    hash: '0xdeadbeef',
    wait: async () => ({ status: 1, gasUsed: 21000n, blockNumber: 1 })
  };
};
send.estimateGas = async () => 21000n;

const opt = { label: '[测试]', contract: { enterQueue: send }, method: 'enterQueue', args: [] };

(async () => {
  const ok = await sendTx(inst, opt);

  console.log('广播记录:');
  calls.forEach(c => console.log(`  attempt ${c.attempt}: nonce=${c.nonce} gasPrice=${c.gasPrice}`));
  console.log('读 pending nonce 次数:', pendingCalls);
  console.log('最终 inst.nonce:', inst.nonce, '| 返回值:', ok);

  const problems = [];
  if (calls.length !== 2) problems.push(`应该广播 2 次，实际 ${calls.length} 次`);
  if (calls.length === 2 && calls[0].nonce !== calls[1].nonce) {
    problems.push(`两次 nonce 不一致(${calls[0].nonce} vs ${calls[1].nonce})，会并排发两笔`);
  }
  if (calls.length === 2 && !(calls[1].gasPrice > calls[0].gasPrice)) {
    problems.push('attempt 2 没有加价，起不到替换作用');
  }
  if (pendingCalls !== 1) problems.push(`pending nonce 被读了 ${pendingCalls} 次，应该只读 1 次`);

  console.log('');
  if (problems.length === 0) {
    console.log('✅ 通过: attempt 2 用同一 nonce 加价替换');
    process.exit(0);
  }
  console.log('❌ 失败:');
  problems.forEach(p => console.log('   -', p));
  process.exit(1);
})();
