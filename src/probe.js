#!/usr/bin/env node
'use strict';
/**
 * FTS 链上只读探针 (probe) —— 完全不需要私钥/钱包
 *
 * 用途: 在真机上验证"这个合约到底长什么样"，再决定要不要跑交易。
 * 只发 eth_call / eth_getCode 这类只读请求，不会签名、不会广播、不花一分钱。
 *
 * 用法:
 *   node probe.js                          # 用 config.json 或默认地址
 *   node probe.js 0x你的队列合约地址        # 指定要探测的合约
 *   node probe.js <合约> <你的钱包地址>     # 额外查该地址余额/授权(只读, 仍不需要私钥)
 */

let ethers;
try { ethers = require('ethers'); }
catch (e) { console.error('缺少 ethers，请先: npm install ethers@6'); process.exit(20); }
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let userCfg = {};
try { userCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, '')); } catch (e) { }

const TARGET = process.argv[2] || process.env.FTS_QUEUE_ADDR || userCfg.QUEUE_ADDR || '0x88E6A7fA7eaCBdf774496A15304a7fDB0A16f301';
const USDT_ADDR = process.env.FTS_USDT_ADDR || userCfg.USDT_ADDR || '0x55d398326f99059fF775485246999027B3197955';
const WATCH_ADDR = process.argv[3] || process.env.FTS_WATCH_ADDR || '';
const CHAIN_ID = Number(process.env.FTS_CHAIN_ID || userCfg.CHAIN_ID || 56);
const RPCS = (process.env.FTS_HTTP_POOL || (userCfg.HTTP_POOL || [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://binance.llamarpc.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org'
]).join(',')).split(',').map(s => s.trim()).filter(Boolean);

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', D = '\x1b[0m';
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(Object.assign(new Error('超时'), { code: 'TIMEOUT' })), ms))]);
const errText = e => `${e.code || '?'} ${String(e.shortMessage || e.reason || e.message || e).slice(0, 150)}`;
// 提示文案按平台显示对应的启动命令
const LAUNCH = process.env.FTS_LAUNCHER === 'ps1'
  ? 'powershell -ExecutionPolicy Bypass -File autofts.ps1'
  : (process.env.FTS_LAUNCHER === 'bash'
    ? 'bash autofts.sh'
    : (process.platform === 'win32' ? 'powershell -ExecutionPolicy Bypass -File autofts.ps1' : 'bash autofts.sh'));

// ---------- 函数签名候选 ----------
// 只写函数名+参数类型(不写返回类型)，这样即使猜错返回类型也能探测存在性
const CANDIDATES = {
  currentRound: ['currentRound(uint8)', 'currentRound(uint256)', 'currentRound(uint16)', 'currentRound()', 'currentRound(uint32)'],
  roundInfo: ['roundInfo(uint8,uint256)', 'roundInfo(uint256,uint256)', 'roundInfo(uint256)', 'roundInfo(uint8,uint256,address)', 'roundInfo(uint256,address)'],
  roomConfigs: ['roomConfigs(uint8)', 'roomConfigs(uint256)', 'roomConfigs()', 'roomConfigs(uint8,uint256)'],
  enterQueue: ['enterQueue(uint8,address)', 'enterQueue(uint256,address)', 'enterQueue(address)', 'enterQueue(uint8,address,uint256)', 'enterQueue(uint256)'],
  claimRefundAndAirdrop: ['claimRefundAndAirdrop(uint8,uint256)', 'claimRefundAndAirdrop(uint256,uint256)', 'claimRefundAndAirdrop(uint256)', 'claimRefundAndAirdrop()', 'claimRefundAndAirdrop(uint8,uint256,address)']
};
// 写函数没有返回值，eth_call 通常返回空 -> 只能靠"字节码里有没有这个 selector"判断
const WRITE_FNS = new Set(['enterQueue', 'claimRefundAndAirdrop']);

const nParams = sig => sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean).length;
const selectorOf = sig => { try { return ethers.FunctionFragment.from(sig).selector; } catch (e) { return null; } };

function fakeArgs(sig) {
  const fr = ethers.FunctionFragment.from(sig);
  return fr.inputs.map(i => {
    const t = i.type;
    if (t.startsWith('uint')) return 1;
    if (t === 'address') return '0x0000000000000000000000000000000000000001';
    if (t === 'bool') return true;
    if (t.startsWith('bytes')) return '0x';
    if (t === 'string') return 'x';
    return 0;
  });
}

// 宽松解码: 不知道返回类型时，按 32 字节切分，逐个给出"最像什么"的解读
function looseDecode(ret) {
  if (!ret || ret === '0x') return [];
  const body = ret.slice(2);
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) words.push('0x' + body.slice(i, i + 64));
  return words.map((w, idx) => {
    const v = BigInt(w);
    const hex = w.slice(2);
    const isAddr = /^0{24}[0-9a-fA-F]{40}$/.test(w);
    let guess;
    if (isAddr) guess = `address ${ethers.getAddress('0x' + hex.slice(24))}`;
    else if (v === 0n) guess = 'uint 0';
    else if (v === 1n) guess = 'uint 1 (也可能是 bool true)';
    else if (v > 1e15) guess = `uint ${v} (若按18位小数 = ${ethers.formatUnits(v, 18)})`;
    else if (v > 1_600_000_000 && v < 2_500_000_000) guess = `uint ${v} (看起来像时间戳 ${new Date(Number(v) * 1000).toLocaleString('zh-CN')})`;
    else guess = `uint ${v}`;
    return `      word[${idx}] ${guess}`;
  });
}

async function pickRpc() {
  const out = [];
  for (const u of RPCS) {
    const t0 = Date.now();
    try {
      const p = new ethers.JsonRpcProvider(u, CHAIN_ID, { staticNetwork: true });
      const bn = await withTimeout(p.getBlockNumber(), 20000);
      const cid = await withTimeout(p.getNetwork().then(n => Number(n.chainId)), 8000).catch(() => null);
      out.push({ u, ok: true, lat: Date.now() - t0, bn: Number(bn), cid });
    } catch (e) { out.push({ u, ok: false, err: errText(e) }); }
  }
  return out;
}

(async () => {
  console.log(B + '\n================ FTS 链上只读探针 ================' + D);
  console.log(`探测合约: ${TARGET}`);
  console.log(`USDT    : ${USDT_ADDR}`);
  console.log(`链 ID   : ${CHAIN_ID}`);
  console.log('说明    : 全程只读，不签名、不广播、不需要私钥\n');

  // ---------- 1. RPC ----------
  console.log(B + '--- 1. RPC 连通性 ---' + D);
  const rs = await pickRpc();
  let anyOk = false;
  for (const r of rs) {
    if (r.ok) {
      anyOk = true;
      const warn = (r.cid && r.cid !== CHAIN_ID) ? ` ${Y}⚠️ 链ID与目标(${CHAIN_ID})不符${D}` : '';
      console.log(`  ${G}✅${D} ${r.u} 延迟=${r.lat}ms 高度=${r.bn} chainId=${r.cid}${warn}`);
    } else console.log(`  ${R}❌${D} ${r.u} -> ${r.err}`);
  }
  if (!anyOk) { console.log(R + '\n结论: 没有任何 RPC 可用。检查网络 / 换节点(FTS_HTTP_POOL) / 确认没被防火墙拦。' + D); process.exit(22); }
  const best = rs.filter(r => r.ok).sort((a, b) => a.lat - b.lat)[0];
  const provider = new ethers.JsonRpcProvider(best.u, CHAIN_ID, { staticNetwork: true });
  console.log(`  ${G}主用节点: ${best.u}${D}`);

  // ---------- 2. 合约存在性 ----------
  console.log(B + '\n--- 2. 目标地址上有没有合约 ---' + D);
  const code = await withTimeout(provider.getCode(TARGET), 20000).catch(e => { console.log('  读取字节码失败: ' + errText(e)); return '0x'; });
  const isContract = code && code !== '0x' && code !== '0x0';
  console.log(`  字节码长度: ${(code.length - 2) / 2} 字节`);
  if (!isContract) {
    console.log(R + '  ❌ 该地址上没有合约代码 —— 不是合约地址，脚本里的合约地址很可能是错的！' + D);
    console.log(Y + '  请到项目官方渠道重新核对地址，并确认链一致(BSC / ETH 地址不通用)。' + D);
    process.exit(1);
  }
  console.log(`  ${G}✅ 是合约${D}` + ((code.length - 2) / 2 < 500 ? ` ${Y}(代码很短，很可能是代理合约 Proxy)${D}` : ''));

  // ---------- 3. 代理探测 ----------
  console.log(B + '\n--- 3. 代理合约探测 (真合约可能藏在小代码后面) ---' + D);
  const implSet = new Set();
  const SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'];
  for (const slot of SLOTS) {
    try {
      const v = await withTimeout(provider.getStorage(TARGET, slot), 20000).catch(() => null);
      if (v && v !== '0x' + '0'.repeat(64)) {
        const a = ethers.getAddress('0x' + v.slice(-40));
        if (a !== ethers.ZeroAddress) { implSet.add(a); console.log(`  槽位 ${slot.slice(0, 14)}... -> 实现合约 ${a}`); }
      }
    } catch (e) { }
  }
  for (const sig of ['implementation()', 'getImplementation()', 'target()', 'masterCopy()']) {
    try {
      const r = await withTimeout(provider.call({ to: TARGET, data: selectorOf(sig) }), 8000);
      if (r && r.length >= 66) {
        const a = ethers.getAddress('0x' + r.slice(-40));
        if (a !== ethers.ZeroAddress) { implSet.add(a); console.log(`  ${sig} -> ${a}`); }
      }
    } catch (e) { }
  }
  const implList = [...implSet];
  console.log(implList.length ? `  ${G}发现 ${implList.length} 个实现合约，一并扫描其字节码${D}` : '  未发现代理结构(按普通合约处理)');

  // ---------- 4. 函数签名探测 ----------
  console.log(B + '\n--- 4. 函数签名探测 (脚本能不能调得动，全看这里) ---' + D);
  const scan = [TARGET, ...implList];
  const bcs = new Map();
  for (const a of scan) { try { bcs.set(a, (await withTimeout(provider.getCode(a), 20000)).toLowerCase()); } catch (e) { bcs.set(a, ''); } }

  const found = {};
  for (const [fn, sigs] of Object.entries(CANDIDATES)) {
    console.log(`\n  ${B}[${fn}]${D}${WRITE_FNS.has(fn) ? ' (写函数: 主要看字节码是否命中)' : ''}`);
    found[fn] = [];
    for (const sig of sigs) {
      const sel = selectorOf(sig);
      if (!sel) continue;
      let inCode = false, where = '';
      for (const [a, bc] of bcs) { if (bc && bc.includes(sel.slice(2).toLowerCase())) { inCode = true; where = a === TARGET ? '主合约' : '实现合约'; break; } }
      let callOk = false, retLen = 0, note = '';
      try {
        const fr = ethers.FunctionFragment.from(sig);
        const enc = fr.inputs.length ? ethers.AbiCoder.defaultAbiCoder().encode(fr.inputs.map(i => i.type), fakeArgs(sig)).slice(2) : '';
        const r = await withTimeout(provider.call({ to: TARGET, data: sel + enc, from: '0x0000000000000000000000000000000000000001' }), 10000);
        retLen = (r.length - 2) / 2;
        callOk = retLen > 0;
        note = callOk ? `调用返回 ${retLen} 字节` : '调用返回空(写函数属正常)';
      } catch (e) { note = '调用失败: ' + errText(e).slice(0, 100); }

      const matched = WRITE_FNS.has(fn) ? inCode : (inCode || callOk);
      if (matched) {
        found[fn].push({ sig, sel, inCode, callOk });
        console.log(`    ${G}✔${D} ${sig}`);
        console.log(`      selector=${sel} | 字节码命中=${inCode ? '是(' + where + ')' : '否'} | ${note}`);
      } else {
        console.log(`    ${R}✘${D} ${sig}  (字节码无 / 调用失败)`);
      }
    }
    if (!found[fn].length) console.log(`    ${R}⚠️ 没找到匹配签名：这个函数可能不叫这个名字，或不在该合约上${D}`);
  }

  // ---------- 5. 读取真实数据 ----------
  console.log(B + '\n--- 5. 读取真实链上数据 ---' + D);
  const readRaw = async (label, sig, args) => {
    const sel = selectorOf(sig);
    const fr = ethers.FunctionFragment.from(sig);
    const enc = args.length ? ethers.AbiCoder.defaultAbiCoder().encode(fr.inputs.map(i => i.type), args).slice(2) : '';
    try {
      const r = await withTimeout(provider.call({ to: TARGET, data: sel + enc }), 10000);
      if (!r || r === '0x') { console.log(`  ${Y}○${D} ${label}: 无返回数据(写函数或该轮次不存在)`); return null; }
      const lines = looseDecode(r);
      console.log(`  ${G}✅${D} ${label} -> ${(r.length - 2) / 2} 字节:`);
      lines.slice(0, 12).forEach(l => console.log(l));
      if (lines.length > 12) console.log(`      ... 还有 ${lines.length - 12} 个字段`);
      return r;
    } catch (e) { console.log(`  ${R}❌${D} ${label}: ${errText(e)}`); return null; }
  };

  const curSig = (found.currentRound[0] && found.currentRound[0].sig) || 'currentRound(uint8)';
  const roomSig = (found.roomConfigs[0] && found.roomConfigs[0].sig) || 'roomConfigs(uint8)';
  const infoSig = (found.roundInfo[0] && found.roundInfo[0].sig) || 'roundInfo(uint8,uint256)';

  const curRaw = await readRaw('currentRound(0)', curSig, nParams(curSig) === 0 ? [] : [0]);
  // 逐个房间查票价(0=10U 1=50U 2=100U)，哪个房间在链上存在、票价多少，一眼看清
  for (const room of [0, 1, 2]) {
    await readRaw(`roomConfigs(${room})`, roomSig, nParams(roomSig) === 0 ? [] : [room]);
  }
  let curVal = null;
  if (curRaw) { try { curVal = BigInt('0x' + curRaw.slice(2, 66)); } catch (e) { } }
  // 候选签名里可能有 3 个参数的变体(roundInfo(uint8,uint256,address))，
  // 类型未知没法瞎补参数，参数个数对不上就直接跳过这条候选，别让它抛 ABI 编码错误
  const infoArgCount = nParams(infoSig);
  if (infoArgCount <= 2) {
    const infoArgs = infoArgCount === 0 ? []
      : (infoArgCount === 1 ? [0] : [0, curVal === null ? 1 : curVal]);
    await readRaw(`roundInfo(0, ${curVal === null ? '?' : curVal})`, infoSig, infoArgs);
  } else {
    console.log('  ○ roundInfo 候选参数过多，跳过');
  }

  // ---------- 6. USDT ----------
  console.log(B + '\n--- 6. USDT 合约 ---' + D);
  const uCode = await withTimeout(provider.getCode(USDT_ADDR), 20000).catch(() => '0x');
  console.log(`  USDT 地址有合约: ${uCode && uCode !== '0x' ? G + '是' : R + '否(地址错?)'}${D}`);
  const uRead = new ethers.Contract(USDT_ADDR, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], provider);
  try { console.log(`  symbol=${await withTimeout(uRead.symbol(), 20000)} decimals=${await withTimeout(uRead.decimals(), 20000)}`); }
  catch (e) { console.log(`  ${Y}读取 symbol/decimals 失败(不影响使用): ${errText(e)}${D}`); }

  // ---------- 7. 钱包体检 ----------
  console.log(B + '\n--- 7. 钱包体检 (只读，不需要私钥) ---' + D);
  if (!WATCH_ADDR) {
    console.log(`  ${Y}未提供观察地址。用法: node probe.js <合约地址> <你的钱包地址>${D}`);
    console.log(`  ${Y}余额和授权额度都是链上公开信息，任何人可查，无需私钥。${D}`);
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(WATCH_ADDR)) {
    console.log(`  ${R}地址格式不对: ${WATCH_ADDR}${D}`);
  } else {
    try {
      const bnb = await withTimeout(provider.getBalance(WATCH_ADDR), 20000);
      console.log(`  BNB 余额  : ${ethers.formatEther(bnb)} ${bnb < ethers.parseEther('0.01') ? Y + '(偏少，gas 可能不够)' + D : G + '(够用)' + D}`);
      const usdt = await withTimeout(uRead.balanceOf(WATCH_ADDR), 20000);
      console.log(`  USDT 余额 : ${ethers.formatUnits(usdt, 18)}`);
      const allow = await withTimeout(uRead.allowance(WATCH_ADDR, TARGET), 20000);
      console.log(`  已授权额度: ${ethers.formatUnits(allow, 18)} ${allow === 0n ? Y + '(0，首次入场需先发授权交易)' + D : G + '(已授权)' + D}`);
    } catch (e) { console.log(`  ${R}读取失败: ${errText(e)}${D}`); }
  }

  // ---------- 结论 ----------
  console.log(B + '\n================ 探测结论 ================' + D);
  const missing = Object.entries(found).filter(([, v]) => !v.length).map(([k]) => k);
  if (missing.length) {
    console.log(R + `❌ 链上找不到这些函数: ${missing.join(', ')}` + D);
    console.log(Y + '   常见原因: 合约地址错了 / 链选错了 / 函数名或参数类型变过 / 合约是代理且实现已更换。' + D);
    console.log(Y + '   处理: 用上面标 ✔ 的签名更新 config.json，或向项目方索取正确地址与 ABI。' + D);
  } else {
    console.log(G + '✅ 脚本用到的函数在链上都找得到，合约地址与 ABI 基本对得上。' + D);
  }
  console.log('\n建议的下一步:');
  console.log('  1) 若上面有 ❌，先修地址/ABI，别急着跑交易');
  console.log('  2) 确认无误后: ' + LAUNCH + ' --init 配置账号');
  console.log('  3) 先跑: ' + LAUNCH + ' --selftest  (只读体检，不花钱)');
  console.log('  4) 再跑: ' + LAUNCH + ' --dry-run   (全流程演练，交易不上链)');
  console.log('  5) 最后: ' + LAUNCH + ' --run       (正式交易)');
  console.log(`\n本次使用节点: ${best.u}`);
  process.exit(missing.length ? 1 : 0);
})().catch(e => { console.error(R + '探针自身异常: ' + (e.stack || e.message) + D); process.exit(23); });
