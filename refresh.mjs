#!/usr/bin/env node
// KNTQ burn dashboard: data refresh. Zero dependencies, Node 18+.
//   node refresh.mjs            -> writes data.json next to this file
// Reads:
//   1. Elysium RPC      sequencer fees per UTC day, EXACT: the balance change of the chain's fee account
//                       (ArbOwnerPublic network/infra fee account). Checked per day against receipts, to the wei.
//                       Also the Ascend KNTQ burn treasury: what it holds, its buybacks, and any KNTQ it burned.
//   2. DefiLlama        Ascend's KNTQ-burn leg per day in USD (28.8% of its protocol splitter's share)
//   3. Hyperliquid API  KNTQ and HYPE price, KNTQ supply, the Assistance Fund's KNTQ and who sent it
// A source that fails keeps its previous value with that value's own timestamp; nothing is ever filled with 0.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { makeTracer, TRACER_VERSION } from './attribution.mjs';

const RPC     = process.env.ELYSIUM_RPC || 'https://rpc.elysium.kinetiq.xyz';
const START   = process.env.START || '2026-11-05';          // first day charted (public mainnet: 2026-11-09 13:00 UTC)
const WINDOWS = +(process.env.WINDOWS || 3), WINDOW = +(process.env.WINDOW || 40); // exact check: 3 runs of 40 blocks a day
const OUT     = new URL('./data.json', import.meta.url);
const HL      = 'https://api.hyperliquid.xyz/info';
/* Dollar value of a past buy: the typical price, (high + low + close) / 3, of the Hyperliquid 1-hour candle the buy
   falls in, or of the nearest earlier hour that traded, up to 6 hours back. Candles are fetched in windows and cached
   for the run; a buy's dollar value is stored with it once found, so it never moves with later prices. */
const candleCache = new Map();
async function hlInfo(body) {
  for (let i = 0; ; i++) {
    const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (r.status === 429 && i < 6) { await sleep(2000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`Hyperliquid ${body.type} HTTP ${r.status}`);
    return r.json();
  }
}
async function hourPx(coin, ms) {
  if (!coin || !(ms > 0)) return null;
  let m = candleCache.get(coin); if (!m) candleCache.set(coin, m = new Map());
  const h = Math.floor(ms / 3600e3) * 3600e3;
  if (!m.has(h)) {
    const start = h - 6 * 3600e3, end = Math.min(Date.now(), h + 400 * 3600e3);
    for (const c of await hlInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: start, endTime: end } })) m.set(c.t, (+c.h + +c.l + +c.c) / 3);
    for (let t = start; t <= end; t += 3600e3) if (!m.has(t)) m.set(t, null);    // fetched, no trade that hour
  }
  for (let k = 0; k <= 6; k++) { const v = m.get(h - k * 3600e3); if (v != null) return v; }
  return null;
}
const AF      = '0xfefefefefefefefefefefefefefefefefefefefe'; // Hyperliquid Assistance Fund
const LLAMA   = 'https://api.llama.fi/summary/fees/ascend-launchpad?dataType=dailyHoldersRevenue';
const OWNER_PUBLIC = '0x000000000000000000000000000000000000006b';
const SPLITTER = '0xfda2703df09b23caffc30dee6c73b4a12fc82faf';  // Ascend ProtocolSplitter
const KNTQ_EVM = '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0';  // KNTQ on Elysium
const WHYPE    = '0xba876237b0f021a6c6d852d6c26e107997cc5e81';
const USDC     = '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65';  // 6 decimals
// Burn addresses on Elysium. The zero address is not one: KNTQ sent there is a bridge withdrawal to HyperEVM.
const BURN_ADDRESSES = ['0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069'];
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ARBSYS = '0x0000000000000000000000000000000000000064';
const L2_TO_L1_TX = '0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc';   // ArbSys L2ToL1Tx
// Arbitrum RewardDistributor (the fee splitters since 2026-11-19): a payout, a payout to the fallback, the recipients
const RD_RECIPIENT = '0x8b2a2b28e169eb0e4f62578e9d12f747d7bd0fe1ebc935af28387c18034d7cc0';  // RecipientRecieved(address,uint256)
const RD_FALLBACK  = '0x0fbda5308ce78c0e89ad38a55e04e9b2642b15c693b46ad9e3e6c35687a991b2';  // FallbackRecieved(address,address,uint256)
const RD_OWNER     = '0xf3b03d863408466d72337e3dd8e40d5b9a37c5ef4c274f40dd3542d87697ab7e';  // OwnerRecieved(address,address,uint256), older builds
const RD_RECIPIENTS = '0x33bc54b3c50e54df666d4399528026a4b04671bb2a879281b5279f7352fb3e6c'; // RecipientsUpdated(bytes32,address[],bytes32,uint256[])
// withdrawals to the parent chain in a receipt: ArbSys L2ToL1Tx(caller, destination indexed, …, callvalue, data)
const withdrawalsIn = rc => rc.logs.filter(l => l.address.toLowerCase() === ARBSYS && l.topics[0] === L2_TO_L1_TX)
  .map(l => ({ by: '0x' + l.data.slice(26, 66), destination: '0x' + l.topics[1].slice(-40), hype: +e18(BigInt('0x' + l.data.slice(2 + 64 * 4, 2 + 64 * 5))).toFixed(9) }));
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// The fee account receives each transaction's execution gas x price, tips included. The L1 data part
// (gasUsedForL1 x price, nonzero before Nov 10) is paid toward posting to the parent chain, not to it.
// Arbitrum system tx types whose receipts show gas x price that is NOT paid to the fee account:
// 0x69 submit-retryable (a parent-chain deposit; its fee is settled from the deposit), 0x6a internal.
const NOT_SEQUENCER_FEE = new Set(['0x69', '0x6a']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => '0x' + n.toString(16);
const day = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pad32 = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const e18 = w => Number(w) / 1e18;

/* The public Conduit RPC allows roughly 3 receipt reads a second and counts every call inside a batch,
   so calls go one at a time with a gap, and a rate-limit error waits and retries (it is not a failure). */
let rpcId = 0, gap = 260;
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    let j;
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(30000) });
      j = await r.json();
    } catch (e) { j = { error: { message: 'transport: ' + e.message } }; }
    if (!j.error) { await sleep(gap); return j.result; }
    const limited = /rate limit|too many|transport/i.test(j.error.message);
    if (!limited || attempt >= 12) throw new Error(`${method}: ${j.error.message.slice(0, 140)}`);
    gap = Math.min(1500, gap + 40);
    await sleep(Math.min(20000, 700 * 1.6 ** attempt));
  }
}
const balanceAt = async (addr, blk) => BigInt(await rpc('eth_getBalance', [addr, hex(blk)]));
const erc20Bal = async (tok, who) => BigInt(await rpc('eth_call', [{ to: tok, data: '0x70a08231' + pad32(who).slice(2) }, 'latest']));

async function sequencer(prev) {
  const [latest, chainId] = [await rpc('eth_getBlockByNumber', ['latest', false]), await rpc('eth_chainId', [])];
  if (parseInt(chainId, 16) !== 99901) throw new Error('wrong chain ' + parseInt(chainId, 16));
  const N = parseInt(latest.number, 16), T = parseInt(latest.timestamp, 16);
  log(`chain 99901 block ${N} @ ${new Date(T * 1000).toISOString()}`);

  /* Fee accounts. ArbOwnerPublic names a network and an infra fee account; both are read every run. Until 2026-11-19
     16:41 UTC both were one plain account (0x6cbb…9a05); then Elysium switched both to fee-splitter contracts
     (Arbitrum RewardDistributor). Every account that has ever been a fee account is kept, with the block it started,
     and the fees received over any range of blocks are, summed over all of them, the balance change plus what they
     paid out in that range. An account no longer named only pays out, so its terms cancel and add nothing. */
  const getter = { network: '0x2d9125e9', infra: '0xee95a824' };            // getNetworkFeeAccount(), getInfraFeeAccount()
  const named = async (role, b) => '0x' + (await rpc('eth_call', [{ to: OWNER_PUBLIC, data: getter[role] }, hex(b)])).slice(-40);
  const accounts = (prev?.accounts || (prev?.feeAccount ? [{ address: prev.feeAccount, roles: ['network', 'infra'], from: 0 }] : [])).map(a => ({ ...a }));
  if (!accounts.length) for (const role of ['network', 'infra']) {                       // cold start: the genesis accounts
    const g = await named(role, 1), ex = accounts.find(a => a.address === g);
    if (ex) ex.roles.push(role); else accounts.push({ address: g, roles: [role], from: 0 });
  }
  for (const role of ['network', 'infra']) {
    const now = await named(role, N);
    if (accounts.some(a => a.address === now && a.roles.includes(role))) continue;
    let lo = Math.max(0, ...accounts.filter(a => a.roles.includes(role)).map(a => a.from)), hi = N;   // first block naming it
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if ((await named(role, m)) === now) hi = m; else lo = m; }
    const ex = accounts.find(a => a.address === now);
    if (ex) ex.roles.push(role); else accounts.push({ address: now, roles: [role], from: hi });
    log(`${role} fee account is now ${now}, from block ${hi}`);
  }
  for (const a of accounts) {
    a.contract = (await rpc('eth_getCode', [a.address, 'latest'])).length > 2;
    if (!a.contract) continue;
    // its owner, as the parent-chain address (an L1 sender appears on Elysium offset by Arbitrum's alias)
    try { const o = BigInt('0x' + (await rpc('eth_call', [{ to: a.address, data: '0x8da5cb5b' }, 'latest'])).slice(-40));
          a.owner = '0x' + o.toString(16).padStart(40, '0');
          a.ownerParent = '0x' + ((o - 0x1111000000000000000000000000000000001111n + (1n << 160n)) % (1n << 160n)).toString(16).padStart(40, '0'); } catch {}
  }
  const FEE = await named('network', N);

  /* What each account paid out. A plain account pays only by sending its own transactions (found by bisecting its
     nonce, read once): each one's value and the gas it paid (the L2 part of that gas comes back as a fee, which
     the balance shows). A splitter pays only in distributions, each logged with its amount. */
  const prevOut = new Map((prev?.outflows || []).map(o => [o.account + ':' + (o.nonce ?? o.tx + ':' + o.logIndex), o]));
  const outflows = [];
  for (const a of accounts) {
    if (!a.contract) {
      const nonce = parseInt(await rpc('eth_getTransactionCount', [a.address, hex(N)]), 16);
      const nonceAt = async b => parseInt(await rpc('eth_getTransactionCount', [a.address, hex(b)]), 16);
      let lo = 0;
      for (let n = 0; n < nonce; n++) {
        let o = prevOut.get(a.address + ':' + n) || (n < (prev?.outflows || []).length && !prev?.accounts && a.address === prev?.feeAccount ? { ...(prev.outflows.find(x => x.nonce === n) || {}), account: a.address } : null);
        if (!o || o.block == null) {
          let hi = N;                                                     // first block after which nonce > n
          while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await nonceAt(m) > n) hi = m; else lo = m; }
          const blk = await rpc('eth_getBlockByNumber', [hex(hi), true]);
          const tx = blk.transactions.find(t => t.from.toLowerCase() === a.address && parseInt(t.nonce, 16) === n);
          if (!tx) throw new Error(`transaction ${n} of ${a.address} not found in block ${hi}`);
          const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
          const valueWei = rc.status === '0x1' ? BigInt(tx.value) : 0n, gasWei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
          const to = (tx.to || '').toLowerCase();
          o = { account: a.address, nonce: n, tx: tx.hash, block: hi, time: parseInt(blk.timestamp, 16), to, status: rc.status,
                valueWei: valueWei.toString(), gasWei: gasWei.toString(), hype: +e18(valueWei + gasWei).toFixed(9), withdrawals: withdrawalsIn(rc) };
          log(`${a.address} sent transaction ${n}: ${e18(valueWei).toFixed(4)} HYPE to ${to}`);
        }
        outflows.push(o); lo = o.block;
      }
    } else {
      const logs = await rpc('eth_getLogs', [{ fromBlock: hex(a.from), toBlock: hex(N), address: a.address, topics: [[RD_RECIPIENT, RD_FALLBACK, RD_OWNER]] }]);
      for (const l of logs) {
        const key = a.address + ':' + l.transactionHash + ':' + parseInt(l.logIndex, 16);
        let o = prevOut.get(key);
        if (!o) {
          const blk = await rpc('eth_getBlockByNumber', [l.blockNumber, false]), rc = await rpc('eth_getTransactionReceipt', [l.transactionHash]);
          const valueWei = BigInt('0x' + l.data.slice(-64));
          o = { account: a.address, tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16),
                to: '0x' + l.topics[l.topics.length - 1].slice(-40), status: '0x1', valueWei: valueWei.toString(), gasWei: '0', hype: +e18(valueWei).toFixed(9),
                withdrawals: withdrawalsIn(rc), distribution: true };
        }
        outflows.push(o);
      }
    }
  }
  outflows.sort((x, y) => x.block - y.block || (x.logIndex ?? 0) - (y.logIndex ?? 0));
  const outIn = (from, to) => outflows.filter(o => o.block >= from && o.block <= to).reduce((s, o) => s + BigInt(o.valueWei) + BigInt(o.gasWei), 0n);
  const balAll = async b => { let s = 0n; for (const a of accounts) s += await balanceAt(a.address, b); return s; };
  const nonce = parseInt(await rpc('eth_getTransactionCount', [accounts[0].address, hex(N)]), 16);   // the original account's
  const feeBalance = await balAll(N);
  // the recipients the splitters pay now (their latest RecipientsUpdated), watched with everything else they were paid
  const recipients = [];
  for (const a of accounts.filter(x => x.contract)) {
    const ups = await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(N), address: a.address, topics: [RD_RECIPIENTS] }]);
    if (!ups.length) continue;
    const d = ups[ups.length - 1].data.slice(2), word = i => d.slice(i * 64, i * 64 + 64), at = off => parseInt(word(off / 32), 16);
    const ro = at(32), wo = at(96), n = parseInt(d.slice(ro * 2, ro * 2 + 64), 16);
    for (let i = 0; i < n; i++) recipients.push({ account: a.address, address: '0x' + d.slice(ro * 2 + 64 + i * 64, ro * 2 + 128 + i * 64).slice(-40),
      bps: parseInt(d.slice(wo * 2 + 64 + i * 64, wo * 2 + 128 + i * 64), 16) });
  }

  const bounds = { ...(prev?.bounds || {}) };              // UTC midnight (s) -> first block at/after it
  async function blockAt(ts) {
    if (bounds[ts]) return bounds[ts];
    let lo = 1, hi = N;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const b = await rpc('eth_getBlockByNumber', [hex(mid), false]);
      if (parseInt(b.timestamp, 16) < ts) lo = mid + 1; else hi = mid;
    }
    return (bounds[ts] = lo);
  }

  /* Independent witness, exact: in a few randomly placed runs of consecutive blocks, the fee account's balance
     change must equal the sum of every receipt's gas x price, to the wei. This tests the one thing the daily
     figure rests on (that the account receives fees and nothing else). A day where any window disagrees is
     published as unverified and the page shows it as not loaded. A random sample of single blocks is NOT used:
     per-block fees are so skewed that a sample of a hundred blocks reads 30-60% low on busy days. */
  async function windowCheck(from, to) {
    const span = to - from + 1, w = Math.min(span, WINDOW), out = [];
    for (let i = 0; i < Math.min(WINDOWS, Math.ceil(span / w)); i++) {
      const a = from + Math.floor(Math.random() * (span - w + 1)), b = a + w - 1;
      const delta = (await balAll(b)) - (await balAll(a - 1));
      let fees = 0n;
      for (let k = a; k <= b; k++) for (const r of (await rpc('eth_getBlockReceipts', [hex(k)])) || [])
        if (!NOT_SEQUENCER_FEE.has(r.type)) fees += (BigInt(r.gasUsed || '0x0') - BigInt(r.gasUsedForL1 || '0x0')) * BigInt(r.effectiveGasPrice || '0x0');
      const sent = outIn(a, b);                                       // what it paid out inside the window
      out.push({ from: a, to: b, feesWei: fees.toString(), deltaWei: delta.toString(), ...(sent ? { sentWei: sent.toString() } : {}), ok: fees === delta + sent });
    }
    return { windows: out, blocks: out.length * w, ok: out.every(x => x.ok) };
  }

  const done = new Map((prev?.days || []).filter(d => !d.partial && d.check?.windows && d.method === 'fee-account-delta').map(d => [d.date, d]));
  const days = [];
  const today0 = Math.floor(T / 86400) * 86400;
  for (let t = Date.parse(START + 'T00:00:00Z') / 1000; t <= today0; t += 86400) {
    const date = day(t), partial = t === today0;
    if (done.has(date)) { days.push(done.get(date)); continue; }
    const from = await blockAt(t), to = partial ? N : (await blockAt(t + 86400)) - 1;
    if (to < from) { days.push({ date, feesHype: 0, fromBlock: from, toBlock: to, partial, method: 'fee-account-delta', check: { windows: [], blocks: 0, ok: true } }); continue; }
    const sent = outIn(from, to);
    const wei = (await balAll(to)) - (await balAll(from - 1)) + sent;
    const row = { date, feesHype: +e18(wei).toFixed(9), fromBlock: from, toBlock: to, partial, method: 'fee-account-delta', ...(sent ? { sentHype: +e18(sent).toFixed(9) } : {}),
                  hours: +(((partial ? T : t + 86400) - t) / 3600).toFixed(2) };
    if (!partial) row.check = await windowCheck(from, to);
    days.push(row);
    log(`${date}${partial ? ' (so far)' : ''}: ${row.feesHype.toFixed(4)} HYPE in fees, blocks ${from}..${to}` +
        (row.check ? `, ${row.check.windows.length} windows ${row.check.ok ? 'exact' : 'MISMATCH ' + JSON.stringify(row.check.windows.filter(x => !x.ok))}` : ''));
  }
  // The last hour, the same way: balance change plus what was sent, from the first block an hour back.
  let h0 = N - 1; { let lo = 1, hi = N; while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (parseInt((await rpc('eth_getBlockByNumber', [hex(m), false])).timestamp, 16) < T - 3600) lo = m + 1; else hi = m; } h0 = lo; }
  const hourWei = feeBalance - (await balAll(h0 - 1)) + outIn(h0, N);
  const sentAll = outflows.reduce((a, o) => a + BigInt(o.valueWei) + BigInt(o.gasWei), 0n);
  const cur = [FEE, await named('infra', N)];
  return { method: 'fee-account-delta', feeAccount: FEE, accounts: await Promise.all(accounts.map(async a => ({ ...a, current: cur.includes(a.address), hype: +e18(await balanceAt(a.address, N)).toFixed(9) }))),
           recipients, feeAccountNonce: nonce, feeAccountHype: +e18(feeBalance).toFixed(9),
           // every fee the account has ever received: what it holds plus everything it has sent
           feesAllTimeHype: +e18(feeBalance + sentAll).toFixed(9), sentHype: +e18(sentAll).toFixed(9), outflows,
           lastHour: { hype: +e18(hourWei).toFixed(9), fromBlock: h0, toBlock: N, toTime: T },
           buybacksExecuted: null, latestBlock: N, latestTime: T, bounds, days };
}

async function ascendTreasury(prev) {
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const treasury = '0x' + (await rpc('eth_call', [{ to: SPLITTER, data: '0x3e4d69ca' }, 'latest'])).slice(-40);   // kntqBurn()
  const ppm = Number(BigInt(await rpc('eth_call', [{ to: SPLITTER, data: '0x9b7858ba' }, 'latest'])));            // kntqBurnPpm()
  const [kntq, whype, usdc] = [await erc20Bal(KNTQ_EVM, treasury), await erc20Bal(WHYPE, treasury), await erc20Bal(USDC, treasury)];
  const logs = async (address, topics) => rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(N), address, topics }]);
  const kntqOut = await logs(KNTQ_EVM, [TRANSFER, pad32(treasury)]);
  const kntqIn = await logs(KNTQ_EVM, [TRANSFER, null, pad32(treasury)]);
  const burned = kntqOut.filter(l => BURN_ADDRESSES.includes('0x' + l.topics[2].slice(-40))).reduce((a, l) => a + BigInt(l.data), 0n);
  const movedOut = kntqOut.reduce((a, l) => a + BigInt(l.data), 0n);
  // Buybacks: KNTQ arriving in a tx where the treasury pays with any token or native HYPE (see treasuryBuys).
  const { buybacks, warnings } = await treasuryBuys(treasury, kntqIn, prev);
  // Everything the treasury holds came in one of two ways: its own WHYPE-for-KNTQ buybacks, or straight from the
  // splitter as KNTQ (the burn leg of fees from launch pools priced in KNTQ). Anything else is reported, not hidden.
  const bbTx = new Set(buybacks.map(b => b.tx)), sum = ls => ls.reduce((a, l) => a + BigInt(l.data), 0n);
  const fromSplitter = sum(kntqIn.filter(l => !bbTx.has(l.transactionHash) && '0x' + l.topics[1].slice(-40) === SPLITTER));
  const other = sum(kntqIn.filter(l => !bbTx.has(l.transactionHash) && '0x' + l.topics[1].slice(-40) !== SPLITTER));
  const received = sum(kntqIn);
  // Each direct KNTQ fee payment, with its time, for the page's live feed (cached by tx; block times read once).
  const knownFees = new Map((prev?.kntqFees || []).map(f => [f.tx + ':' + f.logIndex, f]));
  const kntqFees = [];
  for (const l of kntqIn.filter(l => !bbTx.has(l.transactionHash) && '0x' + l.topics[1].slice(-40) === SPLITTER)) {
    const key = l.transactionHash + ':' + parseInt(l.logIndex, 16);
    if (knownFees.has(key)) { kntqFees.push(knownFees.get(key)); continue; }
    const blk = await rpc('eth_getBlockByNumber', [l.blockNumber, false]);
    kntqFees.push({ tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16), kntq: +e18(BigInt(l.data)).toFixed(6) });
  }
  // Each burn (KNTQ sent from the treasury to a burn address), with its time, so the page can date the first one.
  const knownBurns = new Map((prev?.burns || []).map(x => [x.tx + ':' + x.logIndex, x]));
  const burns = [];
  for (const l of kntqOut.filter(l => BURN_ADDRESSES.includes('0x' + l.topics[2].slice(-40)))) {
    const key = l.transactionHash + ':' + parseInt(l.logIndex, 16);
    if (knownBurns.has(key)) { burns.push(knownBurns.get(key)); continue; }
    const blk = await rpc('eth_getBlockByNumber', [l.blockNumber, false]);
    burns.push({ tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16),
                 to: '0x' + l.topics[2].slice(-40), kntq: +e18(BigInt(l.data)).toFixed(6) });
  }
  return { address: treasury, ppm, kntq: +e18(kntq).toFixed(6),
           kntqReceived: +e18(received).toFixed(6), kntqFromBuybacks: +e18(received - fromSplitter - other).toFixed(6),
           kntqFromSplitter: +e18(fromSplitter).toFixed(6), kntqFromOther: +e18(other).toFixed(6), whype: +e18(whype).toFixed(6), usdc: Number(usdc) / 1e6,
           kntqFees, kntqBurned: +e18(burned).toFixed(6), burns, kntqMovedOut: +e18(movedOut).toFixed(6), buybacks, warnings, atBlock: N };
}

/* A buyback by an Ascend treasury is a transaction in which KNTQ arrives (from anyone but the splitter) and the treasury
   pays: any ERC-20 leaving it, or native HYPE (no log, so read as its balance drop over that block). WHYPE and native
   HYPE are priced as HYPE and USDC as dollars; any other token is still counted, by its KNTQ, and logged as a warning.
   KNTQ arriving with no payment is not a buy and stays under "other". Each tx is read once and cached by hash. */
const PAY_META = new Map([[WHYPE, { symbol: 'WHYPE', decimals: 18, priced: 'HYPE' }], [USDC, { symbol: 'USDC', decimals: 6, priced: 'USD' }]]);
async function payToken(addr) {
  if (PAY_META.has(addr)) return PAY_META.get(addr);
  let m = { symbol: addr, decimals: null, priced: null };
  try { const d = await rpc('eth_call', [{ to: addr, data: '0x313ce567' }, 'latest']); if (d && d !== '0x') m.decimals = Number(BigInt(d)); } catch {}
  try { const r = await rpc('eth_call', [{ to: addr, data: '0x95d89b41' }, 'latest']); const n = parseInt(r.slice(66, 130), 16);
        const sym = Buffer.from(r.slice(130, 130 + n * 2), 'hex').toString('utf8'); if (sym) m.symbol = sym; } catch {}
  PAY_META.set(addr, m); return m;
}
async function treasuryBuys(treasury, kntqIn, prev) {
  const known = new Map((prev?.buybacks || []).filter(b => b.paid).map(b => [b.tx, b]));   // older rows lack paid: re-read once
  const txs = [...new Set(kntqIn.filter(l => '0x' + l.topics[1].slice(-40) !== SPLITTER).map(l => l.transactionHash))];
  const buybacks = [], warnings = [];
  for (const h of txs) {
    let b = known.get(h);
    if (!b) {
      const rc = await rpc('eth_getTransactionReceipt', [h]);
      if (rc.status !== '0x1') continue;
      const T = rc.logs.filter(x => x.topics[0] === TRANSFER && x.topics.length === 3);
      const back = T.filter(x => x.address.toLowerCase() === KNTQ_EVM && x.topics[2] === pad32(treasury)).reduce((a, x) => a + BigInt(x.data), 0n);
      const paid = {}, unpriced = [];
      for (const x of T.filter(x => x.topics[1] === pad32(treasury) && x.address.toLowerCase() !== KNTQ_EVM)) {
        const tok = x.address.toLowerCase(), m = await payToken(tok);
        if (m.decimals == null) { unpriced.push({ token: tok, symbol: m.symbol, raw: BigInt(x.data).toString(), why: 'decimals unreadable' }); continue; }
        paid[m.symbol] = +((paid[m.symbol] || 0) + Number(BigInt(x.data)) / 10 ** m.decimals).toFixed(6);
        if (!m.priced) unpriced.push({ token: tok, symbol: m.symbol, why: 'no price source' });
      }
      const blkN = parseInt(rc.blockNumber, 16);
      if (!Object.keys(paid).length && !unpriced.length) {            // no token left: native HYPE, or not a buy at all
        const drop = await balanceAt(treasury, blkN - 1) - await balanceAt(treasury, blkN);
        if (drop > 0n) paid.HYPE = +e18(drop).toFixed(6);
      }
      if (!Object.keys(paid).length && !unpriced.length) continue;   // KNTQ arrived with no payment: not a buy
      const blk = await rpc('eth_getBlockByNumber', [rc.blockNumber, false]);
      b = { tx: h, block: blkN, time: parseInt(blk.timestamp, 16), kntq: +e18(back).toFixed(6), whype: paid.WHYPE || 0, paid };
      if (unpriced.length) b.unpriced = unpriced;
    }
    if (b.unpriced) warnings.push({ tx: b.tx, what: `buy paid with a token the page cannot price (${b.unpriced.map(u => u.symbol).join(', ')}); its KNTQ is counted` });
    buybacks.push(b);
  }
  buybacks.sort((a, b) => a.block - b.block);
  for (const w of warnings) log('WARNING', treasury, w.tx, w.what);
  return { buybacks, warnings };
}

/* Ascend's strategic treasury: the splitter's other KNTQ leg (43.2%), bought and held for liquidity and rewards, never
   burned. Read the same way as the burn treasury, kept in its own block so nothing adds it to queued or burned.
   0xdcc81cb2 returns its address and 0x9dfa1b6e its share in ppm (names not published; checked 2026-11-19). */
async function ascendStrategic(prev, burnTreasury) {
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const address = '0x' + (await rpc('eth_call', [{ to: SPLITTER, data: '0xdcc81cb2' }, 'latest'])).slice(-40);
  const ppm = Number(BigInt(await rpc('eth_call', [{ to: SPLITTER, data: '0x9dfa1b6e' }, 'latest'])));
  if (address === ZERO_ADDR || address === burnTreasury) throw new Error(`splitter returned ${address} as the strategic treasury`);
  if (ppm <= 0 || ppm >= 1e6) throw new Error(`strategic share ${ppm} ppm is not a share`);
  const logs = async topics => rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(N), address: KNTQ_EVM, topics }]);
  const kntqIn = await logs([TRANSFER, null, pad32(address)]), kntqOut = await logs([TRANSFER, pad32(address)]);
  const { buybacks, warnings } = await treasuryBuys(address, kntqIn, prev?.address === address ? prev : null);
  const sum = ls => ls.reduce((a, l) => a + BigInt(l.data), 0n);
  const bbTx = new Set(buybacks.map(b => b.tx));
  const fromSplitter = sum(kntqIn.filter(l => !bbTx.has(l.transactionHash) && '0x' + l.topics[1].slice(-40) === SPLITTER));
  const other = sum(kntqIn.filter(l => !bbTx.has(l.transactionHash) && '0x' + l.topics[1].slice(-40) !== SPLITTER));
  return { address, ppm, kntq: +e18(await erc20Bal(KNTQ_EVM, address)).toFixed(6), bought: +buybacks.reduce((a, b) => a + b.kntq, 0).toFixed(6),
           kntqFromSplitter: +e18(fromSplitter).toFixed(6), kntqFromOther: +e18(other).toFixed(6), kntqMovedOut: +e18(sum(kntqOut)).toFixed(6),
           buybacks, warnings, counted: false, atBlock: N };
}

async function hyperliquid(prev) {
  const post = async body => {
    const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`hyperliquid ${body.type}: HTTP ${r.status}`);
    return r.json();
  };
  const [meta, ctxs] = await post({ type: 'spotMetaAndAssetCtxs' });
  const spot = name => {                                   // the token's pair against USDC (token index 0)
    const tok = meta.tokens.find(t => t.name === name); if (!tok) throw new Error(`no ${name} token on Hyperliquid spot`);
    const pair = meta.universe.find(u => u.tokens[0] === tok.index && u.tokens[1] === 0); if (!pair) throw new Error(`no ${name}/USDC pair`);
    const ctx = ctxs.find(c => c.coin === pair.name); if (!ctx) throw new Error(`no context for ${pair.name}`);
    const price = +(ctx.midPx ?? ctx.markPx);
    if (!(price > 0)) throw new Error(`${name} price not positive`);
    return { price, pair: pair.name, total: +ctx.totalSupply, vol24: +ctx.dayNtlVlm, tokenId: tok.tokenId };
  };
  const kntq = spot('KNTQ'), hype = spot('HYPE');
  const det = await post({ type: 'tokenDetails', tokenId: kntq.tokenId });            // max supply, for the FDV
  const maxSupply = +det.maxSupply; if (!(maxSupply > 0)) throw new Error('KNTQ max supply not positive');
  const state = await post({ type: 'spotClearinghouseState', user: AF });
  if (!Array.isArray(state.balances)) throw new Error('Assistance Fund state has no balances');
  const held = state.balances.find(b => b.coin === 'KNTQ');
  // Who sent the Fund its KNTQ, kept as per-sender totals plus the latest rows (the full ledger would make this
  // file grow every half hour). Incremental from the last row seen; the totals must sum to the balance.
  const prevF = prev || {};
  const senders = Object.fromEntries((prevF.senders || []).map(x => [x.from, { ...x }]));
  // one-time migration from the old full-ledger format
  if (!prevF.senders && Array.isArray(prevF.ledger)) for (const r of prevF.ledger) { const x = senders[r.from] ||= { from: r.from, kntq: 0, sends: 0, first: r.time, last: r.time }; x.kntq += r.kntq; x.sends++; x.last = r.time; }
  let recent = prevF.recent ? [...prevF.recent] : [...(prevF.ledger || [])].slice(-RECENT);
  let lastTime = prevF.lastTime || (recent.length ? recent[recent.length - 1].time : Date.parse('2024-10-01') - 1);
  let start = lastTime + 1;
  for (let page = 0; page < 40; page++) {
    const r = await post({ type: 'userNonFundingLedgerUpdates', user: AF, startTime: start, endTime: Date.now() });
    if (!Array.isArray(r) || !r.length) break;
    for (const x of r.sort((a, b) => a.time - b.time)) {
      if (x.delta?.token === 'KNTQ' && ['send', 'spotTransfer'].includes(x.delta.type) && (x.delta.destination || '').toLowerCase() === AF) {
        const row = { time: x.time, from: (x.delta.user || '').toLowerCase(), kntq: +x.delta.amount, hash: x.hash };
        const s = senders[row.from] ||= { from: row.from, kntq: 0, sends: 0, first: row.time, last: row.time };
        s.kntq += row.kntq; s.sends++; s.last = row.time; recent.push(row);
      }
      lastTime = Math.max(lastTime, x.time);
    }
    const last = Math.max(...r.map(x => x.time)); if (last < start) break; start = last + 1;
    if (r.length < 500) break;
  }
  /* Rows kept: everything from the last WINDOW (so the page can sum the last 24 h and 7 d), and never fewer than
     RECENT. recentSince is the time from which the rows are complete; until it is, the 7-day sum is not shown.
     The first run after this was added rebuilds the window from the ledger once. */
  const since = Date.now() - WINDOW_MS;
  let recentSince = prevF.recentSince ?? null;
  if (recentSince == null || recentSince > since) {
    const rows = []; let s0 = since;
    for (let page = 0; page < 60; page++) {
      const r = await post({ type: 'userNonFundingLedgerUpdates', user: AF, startTime: s0, endTime: Date.now() });
      if (!Array.isArray(r) || !r.length) break;
      for (const x of r) if (x.delta?.token === 'KNTQ' && ['send', 'spotTransfer'].includes(x.delta.type) && (x.delta.destination || '').toLowerCase() === AF)
        rows.push({ time: x.time, from: (x.delta.user || '').toLowerCase(), kntq: +x.delta.amount, hash: x.hash });
      const last = Math.max(...r.map(x => x.time)); if (r.length < 500 || last < s0) break; s0 = last + 1;
      if (page === 59) throw new Error('Assistance Fund ledger window did not finish in 60 pages');
    }
    const seen = new Set(rows.map(r => r.hash + r.time + r.kntq));
    recent = [...recent.filter(r => r.time < since && !seen.has(r.hash + r.time + r.kntq)), ...rows].sort((a, b) => a.time - b.time);
    recentSince = since;
  }
  recent = recent.filter((r, i) => r.time >= since || i >= recent.length - RECENT);
  recentSince = Math.max(recentSince, since);
  return { recentSince, kntq: kntq.price, kntqPair: kntq.pair, hype: hype.price, hypePair: hype.pair, supplyTotal: kntq.total, maxSupply, kntqVol24: kntq.vol24,
           afKntq: held ? +held.total : null, senders: Object.values(senders), recent, lastTime };
}

async function ascendUsd() {
  const r = await fetch(LLAMA, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('DefiLlama HTTP ' + r.status);
  const j = await r.json();
  return (j.totalDataChart || []).map(([ts, usd]) => ({ date: day(ts), usd: +(+usd).toFixed(2) }));
}

const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => null);
const now = new Date().toISOString();
const data = { ...(prev || {}), generated: now, errors: {} };
const step = async (name, fn) => { try { return await fn(); } catch (e) { log(`${name} FAILED: ${e.message} (keeping previous, with its own timestamp)`); data.errors[name] = { message: e.message, at: now }; return null; } };

const seq = await step('sequencer', () => sequencer(prev?.sequencer));        if (seq) data.sequencer = { ...seq, at: now };
const asc = await step('ascend', ascendUsd);                                   if (asc && asc.length) data.ascend = { ...(data.ascend || {}), days: asc, at: now };
const tre = await step('ascendTreasury', () => ascendTreasury(prev?.ascendTreasury)); if (tre) data.ascendTreasury = { ...tre, at: now };
const strat = await step('ascendStrategic', () => ascendStrategic(prev?.ascendStrategic, data.ascendTreasury?.address)); if (strat) data.ascendStrategic = { ...strat, at: now };
const RECENT = 60, WINDOW_MS = 8 * 86400e3;
const hl  = await step('hyperliquid', () => hyperliquid(prev?.assistanceFund));
if (hl) {
  data.prices = { kntq: hl.kntq, kntqPair: hl.kntqPair, hype: hl.hype, hypePair: hl.hypePair, kntqVol24Usd: hl.kntqVol24, at: now };
  data.supply = { total: hl.supplyTotal, max: hl.maxSupply, at: now };
  const ledgerSum = hl.senders.reduce((a, x) => a + x.kntq, 0);
  const hist = (prev?.assistanceFund?.history || []).filter(h => h.date !== now.slice(0, 10));
  data.assistanceFund = {
    kntq: hl.afKntq, at: now, lastTime: hl.lastTime, recent: hl.recent, recentSince: hl.recentSince, ledgerSum: +ledgerSum.toFixed(6),
    // The balance must equal the sum of the sends we can see, or the breakdown is incomplete.
    ledgerMatchesBalance: hl.afKntq != null && Math.abs(ledgerSum - hl.afKntq) < 0.01,
    senders: hl.senders.sort((a, b) => b.kntq - a.kntq).map(x => ({ ...x, kntq: +x.kntq.toFixed(6) })),
    history: hl.afKntq == null ? hist : [...hist, { date: now.slice(0, 10), kntq: hl.afKntq }].slice(-400),
  };
}
/* Dollars spent on each Ascend buy (both treasuries), at the hour of the buy: USDC at $1, WHYPE and HYPE at that
   hour's HYPE price. A buy that cannot be priced keeps usd null, is left out of spentUsd and is warned about. */
async function priceAscendBuys(blk, hypePair) {
  if (!blk?.buybacks) return;
  blk.warnings = (blk.warnings || []).filter(w => !w.price);
  for (const b of blk.buybacks) {
    if (b.usd == null) {
      let usd = 0, missing = !!b.unpriced;
      for (const [sym, amt] of Object.entries(b.paid || { WHYPE: b.whype })) {
        if (sym === 'USDC') usd += amt;
        else if (sym === 'WHYPE' || sym === 'HYPE') { const p = await hourPx(hypePair, b.time * 1000); if (p == null) missing = true; else usd += amt * p; }
        else missing = true;
      }
      b.usd = missing ? null : +usd.toFixed(2);
    }
    if (b.usd == null) blk.warnings.push({ tx: b.tx, price: true, what: 'buy could not be valued in dollars; its KNTQ is counted, its cost is left out of spentUsd' });
  }
  blk.spentUsd = +blk.buybacks.reduce((a, b) => a + (b.usd || 0), 0).toFixed(2);
  blk.unpricedBuys = blk.buybacks.filter(b => b.usd == null).length;
}
await step('priceAscendBuys', async () => { for (const k of ['ascendTreasury', 'ascendStrategic']) await priceAscendBuys(data[k], data.prices?.hypePair); });

/* Where the sequencer's fees went once they left the fee account (first on 2026-11-19). Every address the account paid
   is watched: a KNTQ buy by one of them (KNTQ arriving in a transaction where it pays) is a sequencer buy, KNTQ it
   holds is bought but not yet burned, and the refresh's attribution credits any burn or Assistance Fund deposit that
   traces back to them to the sequencer (see knownSources). Withdrawals to the parent chain are listed with their
   destinations, which are watched there too. Nothing here is set by hand: a new payment adds a new watched address. */
async function sequencerSweep(seq, prev) {
  const outs = (seq?.outflows || []).filter(o => o.status === '0x1' && BigInt(o.valueWei) > 0n);
  const watch = [...new Set([...outs.map(o => o.to), ...(seq?.recipients || []).map(r => r.address)])];
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const prevW = new Map((prev?.wallets || []).map(w => [w.address, w]));
  const wallets = [], buys = [], tokenWarnings = [];
  for (const a of watch) {
    const kntqIn = await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(N), address: KNTQ_EVM, topics: [TRANSFER, null, pad32(a)] }]);
    const pw = prevW.get(a), { buybacks, warnings } = await treasuryBuys(a, kntqIn, pw ? { buybacks: (prev?.buybacks || []).filter(b => b.wallet === a) } : null);
    tokenWarnings.push(...warnings);
    for (const b of buybacks) buys.push({ ...b, wallet: a });
    const o = outs.filter(x => x.to === a), r = (seq?.recipients || []).filter(x => x.address === a);
    wallets.push({ address: a, contract: (await rpc('eth_getCode', [a, 'latest'])).length > 2, bps: r.length ? r[0].bps : null,
                   receivedHype: +o.reduce((t, x) => t + e18(BigInt(x.valueWei)), 0).toFixed(9), firstTime: o.length ? o[0].time : null,
                   hype: +e18(await balanceAt(a, N)).toFixed(9), kntq: +e18(await erc20Bal(KNTQ_EVM, a)).toFixed(6),
                   withdrawals: outs.flatMap(x => x.withdrawals || []).filter(w => w.by === a) });
  }
  const blk = { buybacks: buys.sort((x, y) => x.block - y.block), warnings: tokenWarnings };
  await priceAscendBuys(blk, data.prices?.hypePair);
  const hypeOf = b => (b.paid?.WHYPE || 0) + (b.paid?.HYPE || 0);
  return { wallets, buybacks: blk.buybacks, spentHype: +blk.buybacks.reduce((t, b) => t + hypeOf(b), 0).toFixed(9),
           boughtKntq: +blk.buybacks.reduce((t, b) => t + b.kntq, 0).toFixed(6), spentUsd: blk.spentUsd, unpricedBuys: blk.unpricedBuys,
           heldKntq: +wallets.reduce((t, w) => t + w.kntq, 0).toFixed(6), warnings: blk.warnings, atBlock: N };
}
const sw = await step('sequencerSweep', () => sequencerSweep(data.sequencer, prev?.sequencerSweep)); if (sw) data.sequencerSweep = { ...sw, at: now };
/* ---------- Burns ----------
   Burned = every KNTQ burned on Elysium, from any sender, plus KNTQ that reaches Hyperliquid's Assistance Fund
   when it traces back to the sequencer or an Elysium app.
   On Elysium a burn is KNTQ sent to a burn address, or a burn call: a transfer to the zero address that is not a
   bridge withdrawal. KNTQ on Elysium is Arbitrum's standard bridged token, whose only burn function answers to
   the token gateway, so today every transfer to the zero address is a withdrawal to HyperEVM, where the tokens
   still exist. Each one is checked for the gateway's WithdrawalInitiated event in the same transaction, so a real
   burn call would be counted if one ever appeared. */
const ZERO = '0x0000000000000000000000000000000000000000';
const WITHDRAWAL_INITIATED = '0x3073a74ecb728d10be779fe19a74a1428e20468f5b4d167bf9c73d9067847d73';
const KNOWN_FILE = new URL('./sources.json', import.meta.url);

async function knownSources(seq, tre, sweep) {
  const known = new Map(), list = [];
  const add = (chain, address, label, kind, extra = {}) => { const k = chain + ':' + address.toLowerCase(); known.set(k, { label, kind, ...extra }); list.push({ chain, address: address.toLowerCase(), label, kind, ...extra }); };
  for (const f of seq?.accounts || (seq?.feeAccount ? [{ address: seq.feeAccount }] : []))     // every account that has been a fee account
    add('elysium', f.address, 'Elysium sequencer fee account', 'sequencer');
  if (tre?.address) add('elysium', tre.address, "Ascend's burn treasury", 'app', { app: 'Ascend' });
  const owners = new Set((seq?.accounts || []).map(a => a.ownerParent).filter(Boolean));
  // Sequencer fees moved out of the fee account: the wallets it paid, on Elysium; a plain wallet (no code) is the same
  // key on HyperEVM and Hyperliquid, so it is watched there too; withdrawal destinations are watched on the parent side.
  for (const w of sweep?.wallets || []) {
    add('elysium', w.address, 'Elysium sequencer fees, moved to ' + w.address.slice(0, 6) + '…' + w.address.slice(-4), 'sequencer');
    if (!w.contract) for (const c of ['hyperevm', 'hypercore']) add(c, w.address, 'Elysium sequencer fees, moved to ' + w.address.slice(0, 6) + '…' + w.address.slice(-4), 'sequencer');
    for (const d of w.withdrawals || []) for (const c of ['hyperevm', 'hypercore'])
      if (!owners.has(d.destination) && !known.has(c + ':' + d.destination)) add(c, d.destination, 'Elysium sequencer fees, withdrawn to ' + d.destination.slice(0, 6) + '…' + d.destination.slice(-4), 'sequencer');
  }
  // The fee splitters' owner also receives a share, but it is the contract that controls Elysium's fees and may hold
  // other money, so it is never credited: a burn or Assistance Fund send from it is listed for review instead.
  const review = [...owners].map(a => ({ address: a, why: "owner of the sequencer's fee splitters; receives a share of fees" }));
  const file = JSON.parse(await readFile(KNOWN_FILE, 'utf8'));
  // A wallet with counted: false (a project that buys and holds) is shown in the projects table only: it is
  // never a source, so its burns and Assistance Fund sends stay out of the sequencer-or-apps figures.
  const projectOnly = new Map();
  for (const a of file.apps || []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.address || '') || !['elysium', 'hypercore', 'hyperevm'].includes(a.chain)) throw new Error('sources.json: bad entry ' + JSON.stringify(a));
    if (a.counted === false) { projectOnly.set(a.chain + ':' + a.address.toLowerCase(), a.app); continue; }
    add(a.chain, a.address, a.label || a.app, 'app', { app: a.app, evidence: a.evidence });
  }
  const hash = createHash('sha256').update(JSON.stringify({ list, tracer: TRACER_VERSION })).digest('hex').slice(0, 16);
  return { known, list, hash, review, projectOnly };
}

async function burns(prev, K, af) {
  // Time limits: 150 s for Elysium wallets and 90 s for Assistance Fund senders per run, at most 75 s per wallet,
  // least-tried wallets first. A wallet that runs out of time three times is recorded as too slow to trace (its
  // burns stay under other wallets), so one slow trail can never hold up the rest.
  const elyEnd = Date.now() + 150e3;
  const tracerFor = end => makeTracer({ rpc, known: K.known, deadline: Math.min(end, Date.now() + 75e3) });
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const old = new Map((prev?.events || []).map(e => [e.tx + ':' + e.logIndex, e]));
  const oldZero = new Map((prev?.zeroChecked || []).map(z => [z.tx, z.withdrawal]));
  const logsTo = to => rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(N), address: KNTQ_EVM, topics: [TRANSFER, null, pad32(to)] }]);
  const cand = [];
  for (const a of BURN_ADDRESSES) for (const l of await logsTo(a)) cand.push({ l, how: 'burn address' });
  const zeroChecked = [];
  let withdrawals = 0, withdrawnKntq = 0;
  for (const l of await logsTo(ZERO)) {
    let w = oldZero.get(l.transactionHash);
    if (w == null) { const rc = await rpc('eth_getTransactionReceipt', [l.transactionHash]); w = rc.logs.some(x => x.topics[0] === WITHDRAWAL_INITIATED); }
    zeroChecked.push({ tx: l.transactionHash, withdrawal: w });
    if (w) { withdrawals++; withdrawnKntq += e18(BigInt(l.data)); } else cand.push({ l, how: 'burn call' });
  }
  // Attribution: the token's sender or the transaction's sender is a known source, or the trail proves it.
  const traced = new Map(prev?.registryHash === K.hash ? (prev?.actors || []).map(a => [a.actor, a]) : []);
  const tries = new Map((prev?.actors || []).map(a => [a.actor, a.tries || 0]));
  const events = [];
  // first pass: read each burn; second pass: trace the actors that still need it, least-tried first
  const rows = [];
  for (const { l, how } of cand) {
    const key = l.transactionHash + ':' + parseInt(l.logIndex, 16);
    let e = old.get(key);
    if (!e) {
      const blk = await rpc('eth_getBlockByNumber', [l.blockNumber, false]), tx = await rpc('eth_getTransactionByHash', [l.transactionHash]);
      e = { tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16),
            from: '0x' + l.topics[1].slice(-40), actor: tx.from.toLowerCase(), to: '0x' + l.topics[2].slice(-40), how, kntq: +e18(BigInt(l.data)).toFixed(6) };
    }
    rows.push(e);
  }
  const need = new Map();
  for (const e of rows) {
    const direct = K.known.get('elysium:' + e.from) || K.known.get('elysium:' + e.actor);
    if (direct) { traced.set(e.actor, { actor: e.actor, credited: direct }); continue; }
    const a = traced.get(e.actor);
    if ((!a || a.error) && !need.has(e.actor)) need.set(e.actor, e.block);
  }
  for (const [actor, block] of [...need].sort((x, y) => (tries.get(x[0]) || 0) - (tries.get(y[0]) || 0))) {
    if (Date.now() > elyEnd) { traced.set(actor, { actor, error: 'time budget for this run used up', tries: tries.get(actor) || 0 }); continue; }
    const r = await tracerFor(elyEnd).trace('elysium', actor, block);
    const n = (tries.get(actor) || 0) + (r.error ? 1 : 0);
    traced.set(actor, r.error && n >= 3 ? { actor, unidentified: 'too slow to trace within the refresh time limit (3 tries)', tries: n } : { actor, ...r, tries: n });
  }
  for (const e of rows) {
    const a = traced.get(e.actor) || { error: 'not traced' };
    events.push({ ...e, source: a.credited ? a.credited.label : null, kind: a.credited ? a.credited.kind : null, reason: a.credited ? null : (a.unidentified || 'not traced yet: ' + a.error) });
  }
  events.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  for (const e of events) if ((K.review || []).some(r => r.address === e.actor || r.address === e.from))   // never credited
    Object.assign(e, { source: null, kind: null, reason: 'possible sequencer burn, needs review' });
  const PO = K.projectOnly || new Map(), poReason = app => `${app}'s treasury: in the projects table, not counted as the sequencer or apps`;
  for (const e of events) { const app = PO.get('elysium:' + e.from) || PO.get('elysium:' + e.actor); if (app) Object.assign(e, { source: null, kind: null, reason: poReason(app), project: app }); }
  const sum = xs => +xs.reduce((t, e) => t + e.kntq, 0).toFixed(6);
  const credited = events.filter(e => e.source), other = events.filter(e => !e.source);

  // Assistance Fund arrivals count only when the sender traces back to the sequencer or an Elysium app.
  const afEnd = Date.now() + 90e3;
  const afPrev = new Map(prev?.registryHash === K.hash ? (prev?.af?.senders || []).map(x => [x.from, x]) : []);
  const afSenders = [];
  for (const s of af?.senders || []) {
    let t = afPrev.get(s.from);
    if (!t || t.error || t.last !== s.last || !(t.credited || t.unidentified)) {
      const direct = K.known.get('hypercore:' + s.from);
      t = { from: s.from, last: s.last, ...(direct ? { credited: direct } : Date.now() > afEnd ? { error: 'time budget for this run used up' } : await tracerFor(afEnd).trace('hypercore', s.from, s.last)) };
    }
    afSenders.push({ ...t, kntq: s.kntq, sends: s.sends });
  }
  // From a review address: not credited (it stays under other burns), logged so a person can look at it.
  const reviewSet = new Map((K.review || []).map(r => [r.address, r]));
  const review = [
    ...events.filter(e => reviewSet.has(e.actor) || reviewSet.has(e.from)).map(e => ({ chain: 'elysium', address: reviewSet.has(e.actor) ? e.actor : e.from, tx: e.tx, kntq: e.kntq, time: e.time })),
    ...afSenders.filter(x => reviewSet.has(x.from)).map(x => ({ chain: 'hypercore', address: x.from, kntq: x.kntq, sends: x.sends, time: Math.floor((x.last || 0) / 1000) })),
  ].map(r => ({ ...r, status: 'possible sequencer burn, needs review', why: reviewSet.get(r.address).why }));
  for (const r of review) if (r.chain === 'hypercore') { const x = afSenders.find(y => y.from === r.address); if (x) { delete x.credited; x.unidentified = 'possible sequencer burn, needs review'; } }
  for (const x of afSenders) { const app = PO.get('hypercore:' + x.from); if (app) { delete x.credited; delete x.error; x.unidentified = poReason(app); } }
  const afCredited = afSenders.filter(x => x.credited);
  const afKntq = +afCredited.reduce((t, x) => t + x.kntq, 0).toFixed(6);

  // Alerts: a new wallet whose burn or Assistance Fund send could not be traced to a known source. Each wallet
  // alerts once; the first run records what was already there without alerting.
  const alerted = new Set(prev?.alerted || []), first = !prev?.alerted, alerts = [];
  const flag = (who, what, reason) => { if (alerted.has(who)) return; alerted.add(who); if (!first) alerts.push({ at: now, who, what, reason }); };
  for (const e of other.filter(e => !e.project)) flag('elysium:' + e.actor, `burned ${e.kntq} KNTQ on Elysium (tx ${e.tx})`, e.reason);
  for (const x of afSenders.filter(x => !x.credited && !PO.has('hypercore:' + x.from))) flag('hypercore:' + x.from, `sent ${x.kntq.toFixed(2)} KNTQ to the Assistance Fund in ${x.sends} sends`, x.unidentified || x.error);
  for (const a of alerts) log('ALERT source not identified:', a.who, a.what, '|', a.reason);

  return {
    total: +(sum(events) + afKntq).toFixed(6), fromSources: +(sum(credited) + afKntq).toFixed(6), fromOthers: sum(other),
    elysium: { kntq: sum(events), count: events.length, credited: sum(credited), other: sum(other) },
    af: { creditedKntq: afKntq, senders: afSenders.map(x => ({ from: x.from, kntq: +x.kntq.toFixed(6), sends: x.sends, last: x.last, source: x.credited?.label || null,
           reason: x.credited ? null : (x.unidentified || 'not traced yet: ' + x.error), credited: x.credited || null, unidentified: x.unidentified || null, error: x.error || null })) },
    excluded: { withdrawals, withdrawnKntq: +withdrawnKntq.toFixed(6), gateway: '0x5dc84e4cb0f9082246e92a5585c5395592b1af1f', router: '0x61ebbc3a29f1970af2ce862ba9c5364832e14d17', event: WITHDRAWAL_INITIATED },
    burnAddresses: BURN_ADDRESSES, events, zeroChecked,
    actors: [...traced.values()].map(a => ({ actor: a.actor, credited: a.credited || null, unidentified: a.unidentified || null, error: a.error || null, tries: a.tries || 0 })),
    registryHash: K.hash, known: K.list, review, reviewAddresses: K.review || [], alerted: [...alerted], alerts, atBlock: N,
  };
}
/* ---------- Kinetiq's own figures, cross-checked ----------
   kinetiq.xyz/kntq fills its "Projects buying KNTQ" table and its supply numbers from three routes of its own site.
   They are undocumented and unversioned, so every field is shape-checked, a project with no totals is kept as "not
   tracked" (never as zero), and each figure that the chain can confirm is checked against the chain here. */
const KINETIQ = 'https://kinetiq.xyz/api/kntq-data/';
const HYPEREVM = 'https://rpc.hyperliquid.xyz/evm';
const SKNTQ = '0x696238e0ca31c94e24ca4cbe7921754e172e4d0f';   // Staked KNTQ (ERC-4626 vault) on HyperEVM
async function kinetiq(tre, afKntq, strat) {
  const get = async path => { const r = await fetch(KINETIQ + path, { headers: { 'user-agent': 'stateofblocks-kntq-burn' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); return r.json(); };
  const num = (v, what) => { const n = typeof v === 'string' ? +v : v; if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${what} is not a number`); return n; };
  const [eco, sup, vol] = await Promise.all([get('ecosystem-buybacks'), get('supply-breakdown?chainId=999'), get('volume')]);
  if (!Array.isArray(eco?.projects)) throw new Error('ecosystem-buybacks has no projects list');
  // the chain's own reading of what Kinetiq reports
  const call = async (to, data) => { const r = await fetch(HYPEREVM, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) }).then(r => r.json());
    if (!r.result || r.result === '0x') throw new Error('HyperEVM call failed: ' + (r.error?.message || 'empty')); return r.result; };
  const stakedChain = Number(BigInt(await call(SKNTQ, '0x01e1d114'))) / 1e18;            // totalAssets()
  const close = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-4);
  const projects = eco.projects.map(p => {
    const t = p.totals, tracked = t != null;
    const row = { slug: String(p.slug), title: String(p.title), commitment: String(p.commitment ?? ''), share: p.share ?? null, tracked,
      bought: tracked ? num(t.kntqAmount, p.slug + ' bought') : null, spentUsd: tracked ? num(t.usdValue, p.slug + ' spent') : null,
      burned: tracked ? num(t.burnedKntqAmount, p.slug + ' burned') : null, lastBuy: tracked ? (t.lastTime ?? null) : null,
      days: Array.isArray(p.days) ? p.days.length : null };
    // Cross-check where the chain has an address for the project. Ascend: Kinetiq counts the buys of both its burn
    // treasury and its strategic treasury, so the chain figure is the two together.
    if (p.slug === 'ascend' && tre && strat) {
      const all = [...(tre.buybacks || []), ...(strat.buybacks || [])];
      const chain = { bought: +(tre.kntqFromBuybacks + strat.bought).toFixed(6), burned: tre.kntqBurned, buys: all.length, lastBuy: all.length ? Math.max(...all.map(b => b.time)) * 1000 : null };
      const ok = tracked && close(row.bought, chain.bought, 1) && close(row.burned, chain.burned, 1);
      row.check = { status: ok ? 'match' : 'mismatch', chain, against: `Ascend's burn treasury ${tre.address} and strategic treasury ${strat.address} on Elysium` };
    } else row.check = { status: 'no address', note: 'No wallet or burn address for this project is known, so the chain cannot confirm or contradict the figure.' };
    return row;
  });
  const supply = { staked: num(sup.amountStaked, 'amountStaked'), circulating: num(sup.circulatingSupply, 'circulatingSupply'), burned: num(sup.amountBurned, 'amountBurned') };
  return {
    source: 'kinetiq.xyz/kntq (routes /api/kntq-data/ecosystem-buybacks, supply-breakdown, volume)', projects, supply, volumeUsd: num(vol.volume, 'volume'),
    chain: { staked: stakedChain, stakedVault: SKNTQ, afKntq },
    // Kinetiq's figures are cached on its side and the Fund takes sends every hour, so small timing gaps are allowed
    checks: { staked: close(supply.staked, stakedChain, stakedChain * 0.002) ? 'match' : 'mismatch', stakedDiff: +(supply.staked - stakedChain).toFixed(2),
              burned: afKntq == null ? 'unchecked' : close(supply.burned, afKntq, afKntq * 0.005) ? 'match' : 'mismatch', burnedDiff: afKntq == null ? null : +(supply.burned - afKntq).toFixed(2) },
  };
}
const kq = await step('kinetiq', () => kinetiq(data.ascendTreasury, data.assistanceFund?.kntq, data.ascendStrategic)); if (kq) data.kinetiq = { ...kq, at: now };
/* ---------- Projects buying KNTQ ----------
   The table is sources.json's projects list. Two things are added here:
   1. A project in Kinetiq's "projects buying KNTQ" data that is not in the list is added as pledged, not verifiable,
      with Kinetiq as its source, and raises an alert once. It leaves the added list when it is put into sources.json.
      A project in sources.json excludedProjects (matched by Kinetiq slug, or by its title containing `match`) is never
      added, so a project the editor removed stays removed.
   2. Each app wallet in sources.json has its whole history read: buys (KNTQ arriving in a transaction in which
      the wallet also paid something out, with what it paid) and burns (KNTQ to a burn address on Elysium, or to the
      Assistance Fund on Hyperliquid). History is cached per wallet; a wallet the cache has not seen yet is read from
      Elysium's first block, or from the start of its Hyperliquid history, so adding a wallet backfills everything it
      ever did, not only what comes after. A long history is read over several runs and shown as incomplete until done. */
const BUY_READS_PER_RUN = 300;
const tokenMeta = new Map([[WHYPE, { symbol: 'HYPE', decimals: 18 }], [USDC, { symbol: 'USDC', decimals: 6 }]]);
async function token(addr) {
  if (tokenMeta.has(addr)) return tokenMeta.get(addr);
  const dec = Number(BigInt(await rpc('eth_call', [{ to: addr, data: '0x313ce567' }, 'latest']).catch(() => '0x12')));
  let symbol = addr.slice(0, 8);
  try { const r = await rpc('eth_call', [{ to: addr, data: '0x95d89b41' }, 'latest']); const n = parseInt(r.slice(66, 130), 16);
        symbol = Buffer.from(r.slice(130, 130 + n * 2), 'hex').toString('utf8') || symbol; } catch {}
  const m = { symbol, decimals: dec }; tokenMeta.set(addr, m); return m;
}
const blockTimes = new Map();
const blockTime = async b => { if (!blockTimes.has(b)) blockTimes.set(b, parseInt((await rpc('eth_getBlockByNumber', [hex(b), false])).timestamp, 16)); return blockTimes.get(b); };

async function elysiumWallet(w, N, budget) {
  const a = w.address, from = w.atBlock == null ? 0 : w.atBlock + 1;
  if (from <= N) {
    const logs = topics => rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(N), address: KNTQ_EVM, topics }]);
    for (const l of await logs([TRANSFER, pad32(a)])) {
      const to = '0x' + l.topics[2].slice(-40);
      if (BURN_ADDRESSES.includes(to)) w.burns.push({ tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: parseInt(l.blockNumber, 16), to, kntq: +e18(BigInt(l.data)).toFixed(6) });
    }
    for (const l of await logs([TRANSFER, null, pad32(a)])) w.pending.push({ tx: l.transactionHash, block: parseInt(l.blockNumber, 16) });
    w.atBlock = N;
  }
  // Each inflow's transaction is read once. It is a buy when the wallet also paid something out in it (a token, or
  // HYPE if it sent the transaction), whoever sent it: contract wallets are often run by a keeper.
  const done = new Set(w.buys.map(b => b.tx).concat(w.notBuys));
  while (w.pending.length && budget.n > 0) {
    const { tx, block } = w.pending.shift(); if (done.has(tx)) continue; done.add(tx); budget.n--;
    const rc = await rpc('eth_getTransactionReceipt', [tx]);
    const got = rc.logs.filter(x => x.address.toLowerCase() === KNTQ_EVM && x.topics[0] === TRANSFER && x.topics[2] === pad32(a)).reduce((s, x) => s + BigInt(x.data), 0n);
    const paid = {};
    if (rc.from.toLowerCase() === a) { const t = await rpc('eth_getTransactionByHash', [tx]); if (BigInt(t.value) > 0n) paid.HYPE = e18(BigInt(t.value)); }
    for (const x of rc.logs.filter(x => x.topics[0] === TRANSFER && x.topics[1] === pad32(a) && x.address.toLowerCase() !== KNTQ_EVM && x.topics.length === 3)) {
      const m = await token(x.address.toLowerCase()); paid[m.symbol] = (paid[m.symbol] || 0) + Number(BigInt(x.data)) / 10 ** m.decimals;
    }
    if (!Object.keys(paid).length) { w.notBuys.push(tx); continue; }               // KNTQ in, nothing paid: not a buy
    w.buys.push({ tx, block, time: await blockTime(block), kntq: +e18(got).toFixed(6), paid: Object.fromEntries(Object.entries(paid).map(([k, v]) => [k, +v.toFixed(6)])) });
  }
  for (const b of w.burns) if (b.time == null) b.time = await blockTime(b.block);
  w.complete = w.pending.length === 0;
}

async function coreKntq(a) {
  const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'spotClearinghouseState', user: a }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('hyperliquid spotClearinghouseState HTTP ' + r.status);
  const j = await r.json(); if (!Array.isArray(j?.balances)) throw new Error('hyperliquid spotClearinghouseState: no balances');
  return +(+(j.balances.find(b => b.coin === 'KNTQ')?.total || 0)).toFixed(6);
}
async function hypercoreWallet(w) {
  const a = w.address;
  const post = async body => { const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('hyperliquid ' + body.type + ' HTTP ' + r.status); return r.json(); };
  const meta = await post({ type: 'spotMeta' });
  const kntq = meta.tokens.find(t => t.name === 'KNTQ').index, name = i => meta.tokens.find(t => t.index === i)?.name;
  const pairs = new Map(meta.universe.filter(u => u.tokens[0] === kntq).map(u => [u.name, name(u.tokens[1])]));
  for (let start = (w.fillsTo ?? -1) + 1, page = 0; page < 20; page++) {                // from the first fill, for a new wallet
    const fills = await post({ type: 'userFillsByTime', user: a, startTime: start, endTime: Date.now() });
    if (!Array.isArray(fills) || !fills.length) break;
    for (const f of fills) if (pairs.has(f.coin) && f.side === 'B' && !w.buys.some(b => b.tx === f.hash + ':' + f.tid))
      w.buys.push({ tx: f.hash + ':' + f.tid, time: Math.floor(f.time / 1000), kntq: +f.sz, paid: { [pairs.get(f.coin)]: +(+f.px * +f.sz).toFixed(6) } });
    const last = Math.max(...fills.map(f => f.time)); w.fillsTo = last; start = last + 1;
    if (fills.length < 2000) break;
  }
  for (let start = (w.ledgerTo ?? -1) + 1, page = 0; page < 20; page++) {
    const rows = await post({ type: 'userNonFundingLedgerUpdates', user: a, startTime: start, endTime: Date.now() });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) { const d = r.delta || {};
      if (d.token === 'KNTQ' && ['send', 'spotTransfer'].includes(d.type) && (d.user || '').toLowerCase() === a && (d.destination || '').toLowerCase() === AF)
        w.burns.push({ tx: r.hash, time: Math.floor(r.time / 1000), to: AF, kntq: +d.amount }); }
    const last = Math.max(...rows.map(r => r.time)); w.ledgerTo = last; start = last + 1;
    if (rows.length < 500) break;
  }
  w.complete = true;
}

async function projects(prev, kq, hypePair) {
  const file = JSON.parse(await readFile(KNOWN_FILE, 'utf8'));
  const ours = file.projects || [];
  for (const p of ours) if (!p.name || !p.commitment) throw new Error('sources.json: project needs name and commitment ' + JSON.stringify(p));
  const slugs = new Set(ours.map(p => p.kinetiq).filter(Boolean)), names = new Set(ours.map(p => p.name));
  // Projects the editor has taken off the table: never added back from Kinetiq's list, by slug or by name.
  const excl = file.excludedProjects || [];
  for (const x of excl) if (!x.kinetiq && !x.match) throw new Error('sources.json: excluded project needs kinetiq or match ' + JSON.stringify(x));
  const excluded = (slug, title) => excl.some(x => (x.kinetiq && x.kinetiq === slug) || (x.match && String(title || '').toLowerCase().includes(String(x.match).toLowerCase())));
  const alerted = new Set(prev?.alerted || []), alerts = [];
  const alert = (key, what) => { if (alerted.has(key)) return; alerted.add(key); alerts.push({ at: new Date().toISOString(), what }); log('ALERT', what); };
  // 1. Kinetiq's list against ours (kept from the last run when Kinetiq could not be read)
  const added = new Map((prev?.added || []).filter(x => !slugs.has(x.kinetiq) && !excluded(x.kinetiq, x.name)).map(x => [x.kinetiq, x]));
  if (kq) for (const p of kq.projects) if (!slugs.has(p.slug) && !added.has(p.slug) && !excluded(p.slug, p.title))
    added.set(p.slug, { name: p.title, commitment: p.commitment, kinetiq: p.slug, source: 'kinetiq', firstSeen: new Date().toISOString() });
  for (const x of added.values()) alert('kinetiq:' + x.kinetiq, `Kinetiq lists a project buying KNTQ that is not in the table: ${x.name} ("${x.commitment}"). Added as pledged, not verifiable.`);
  // 2. app wallets, each with its whole history
  const N = parseInt(await rpc('eth_blockNumber', []), 16), budget = { n: BUY_READS_PER_RUN };
  const cache = new Map((prev?.wallets || []).map(w => [w.chain + ':' + w.address, w]));
  const wallets = [];
  for (const app of file.apps || []) {
    const key = app.chain + ':' + app.address.toLowerCase();
    let w = cache.get(key);
    if (!w) { w = { chain: app.chain, address: app.address.toLowerCase(), buys: [], burns: [], pending: [], notBuys: [], added: new Date().toISOString() };
              log(`new wallet ${key} for ${app.app}: reading its whole history`); }
    Object.assign(w, { app: app.app, label: app.label || app.app, error: null });
    if (!names.has(app.app) && ![...added.values()].some(x => x.name === app.app)) alert('wallet-project:' + key, `sources.json lists wallet ${key} for "${app.app}", which is not a project in the table.`);
    try {
      if (w.chain === 'elysium') await elysiumWallet(w, N, budget);
      else if (w.chain === 'hypercore') await hypercoreWallet(w);
      else { w.complete = false; w.error = 'HyperEVM wallet history is not read yet'; }
    } catch (e) { w.error = e.message; log(`wallet ${key} FAILED: ${e.message} (kept what was read)`); }
    // what it holds now, and each buy in dollars at the hour it was bought (USDC at $1, HYPE at that hour's price)
    try { w.kntq = w.chain === 'elysium' ? +e18(await erc20Bal(KNTQ_EVM, w.address)).toFixed(6) : w.chain === 'hypercore' ? await coreKntq(w.address) : null; }
    catch (e) { w.kntq = null; log(`wallet ${key}: balance unreadable: ${e.message}`); }
    for (const b of w.buys) if (b.usd == null) {
      let usd = 0, missing = false;
      for (const [sym, amt] of Object.entries(b.paid || {})) {
        if (sym === 'USDC') usd += amt;
        else if (sym === 'HYPE' || sym === 'WHYPE') { const p = hypePair ? await hourPx(hypePair, b.time * 1000) : null; if (p == null) missing = true; else usd += amt * p; }
        else missing = true;
      }
      b.usd = missing ? null : +usd.toFixed(2);
    }
    wallets.push(w);
  }
  // rows: our list, then Kinetiq's additions, each with the totals of its wallets
  const sumPaid = bs => bs.reduce((o, b) => { for (const [k, v] of Object.entries(b.paid)) o[k] = +((o[k] || 0) + v).toFixed(6); return o; }, {});
  const list = [...ours.map(p => ({ ...p, source: p.source || 'ours' })), ...added.values()].map(p => {
    const ws = wallets.filter(w => w.app === p.name), buys = ws.flatMap(w => w.buys), burns = ws.flatMap(w => w.burns);
    const row = { name: p.name, commitment: p.commitment, kinetiq: p.kinetiq || null, chain: p.chain || null, source: p.source, kind: p.kind === 'buy' || p.kind === 'spend' ? p.kind : 'burn', note: p.note || null, wallets: ws.length };
    if (ws.length) Object.assign(row, { verified: true, complete: ws.every(w => w.complete && !w.error),
      bought: +buys.reduce((s, b) => s + b.kntq, 0).toFixed(6), paid: sumPaid(buys), burned: +burns.reduce((s, b) => s + b.kntq, 0).toFixed(6),
      buys: buys.length, lastBuy: buys.length ? Math.max(...buys.map(b => b.time)) : null,
      held: ws.some(w => w.kntq == null) ? null : +ws.reduce((s, w) => s + w.kntq, 0).toFixed(6),
      spentUsd: +buys.reduce((s, b) => s + (b.usd || 0), 0).toFixed(2), unpricedBuys: buys.filter(b => b.usd == null).length,
      counted: !(file.apps || []).some(a => a.app === p.name && a.counted === false),
      reading: ws.reduce((s, w) => s + (w.pending?.length || 0), 0) });
    return row;
  });
  return { list, added: [...added.values()], excluded: excl.map(x => ({ name: x.name, kinetiq: x.kinetiq || null, since: x.since || null })), wallets, alerted: [...alerted], alerts, atBlock: N };
}
const pj = await step('projects', () => projects(prev?.projects, data.kinetiq, data.prices?.hypePair)); if (pj) data.projects = { ...pj, at: now };
/* Montra on Elysium. Its pools earn fees in KNTQ; its buyback contract swaps that KNTQ for MONTRA in Montra's pool
   manager and the MONTRA is burned in the same transaction. So Montra spends KNTQ: the page shows it as a project
   row and never adds it to bought, queued or burned. Addresses are read from Montra's on-chain registry every run.
   Totals are kept in wei and grow from a block cursor; a changed registry address starts the count again from 0. */
const MONTRA_REGISTRY = '0xf1e2fa75422f889e565f3142bdbf60b28dce2aa7';
async function logsRange(address, topics, from, to) {
  try { return await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address, topics }]); }
  catch (e) { if (to - from < 1000) throw e; const m = Math.floor((from + to) / 2);      // too wide: halve, never skip
              return [...await logsRange(address, topics, from, m), ...await logsRange(address, topics, m + 1, to)]; }
}
async function montra(prev, kntqPair) {
  const reg = async k => '0x' + (await rpc('eth_call', [{ to: MONTRA_REGISTRY, data: '0x8eaa6ac0' + Buffer.from(k).toString('hex').padEnd(64, '0') }, 'latest'])).slice(-40);
  const filler = await reg('buybackFiller'), token = await reg('montra');
  if (filler === ZERO || token === ZERO) throw new Error('Montra registry returned the zero address');
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const keep = prev && prev.filler === filler && prev.token === token && Number.isInteger(prev.atBlock) && prev.spentUsd != null;
  const from = keep ? prev.atBlock + 1 : 0;
  // KNTQ leaving the buyback contract (into the pool), and MONTRA sent to the zero address, both since the cursor.
  // A swap and its burn are in one transaction, so one block range always holds both.
  const spent = await logsRange(KNTQ_EVM, [TRANSFER, pad32(filler)], from, N);
  const burns = await logsRange(token, [TRANSFER, null, pad32(ZERO)], from, N);
  const byTx = new Map();
  for (const l of spent) { const x = byTx.get(l.transactionHash) || { tx: l.transactionHash, block: parseInt(l.blockNumber, 16), time: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : null, kntq: 0n, montra: 0n }; x.kntq += BigInt(l.data); byTx.set(l.transactionHash, x); }
  for (const l of burns) { const x = byTx.get(l.transactionHash); if (x) x.montra += BigInt(l.data); }   // only burns from a KNTQ buyback
  const buys = [...byTx.values()].sort((a, b) => a.block - b.block);
  const kntqWei = BigInt(keep ? prev.kntqSpentWei : 0) + buys.reduce((a, x) => a + x.kntq, 0n);
  const montraWei = BigInt(keep ? prev.montraBurnedWei : 0) + buys.reduce((a, x) => a + x.montra, 0n);
  // each buy's KNTQ in dollars at the hour it was spent (logs carry the block time)
  let usdNew = 0, unpricedNew = 0;
  for (const x of buys) { const p = x.time ? await hourPx(kntqPair, x.time * 1000) : null; if (p == null) unpricedNew++; else usdNew += e18(x.kntq) * p; }
  const spentUsd = +((keep ? prev.spentUsd : 0) + usdNew).toFixed(2), unpricedBuys = (keep ? prev.unpricedBuys || 0 : 0) + unpricedNew;
  if (unpricedNew) log('WARNING montra:', unpricedNew, 'buys could not be valued in dollars');
  let last = keep ? prev.lastBuy : null;
  if (buys.length) { const x = buys[buys.length - 1], blk = await rpc('eth_getBlockByNumber', [hex(x.block), false]);
    last = { tx: x.tx, block: x.block, time: parseInt(blk.timestamp, 16), kntq: +e18(x.kntq).toFixed(6), montra: +e18(x.montra).toFixed(6) }; }
  return { registry: MONTRA_REGISTRY, filler, token, kntqSpentWei: kntqWei.toString(), montraBurnedWei: montraWei.toString(),
           kntqSpent: +e18(kntqWei).toFixed(6), montraBurned: +e18(montraWei).toFixed(6), buybacks: (keep ? prev.buybacks : 0) + buys.length,
           spentUsd, unpricedBuys, warnings: unpricedBuys ? [{ what: `${unpricedBuys} buys could not be valued in dollars; their KNTQ is counted, their value is left out of spentUsd` }] : [],
           lastBuy: last, counted: false, atBlock: N };
}
const mo = await step('montra', () => montra(prev?.montra, data.prices?.kntqPair)); if (mo) data.montra = { ...mo, at: now };
/* ---------- Handed to Kinetiq's buyback bot ----------
   Elysium's 85% share is paid to one wallet: the fee splitters' largest recipient, read from the chain. That wallet
   withdraws part of what it receives to the parent chain. Each withdrawal lands on the destination's HyperCore account
   about a day later (several may land together), and that account passes it on to Kinetiq's hourly Assistance Fund
   buyer, which also spends Kinetiq's own money. Only HYPE that traces exactly from the wallet is counted:
   - an arrival on HyperCore (a HYPE transfer from the HyperEVM system address) matches when it equals the sum of one
     run of consecutive, not yet matched withdrawals from the wallet that happened before it, to the 1e-8 HYPE HyperCore
     keeps (allowing 1e-8 of rounding per withdrawal);
   - it is handed over when the same amount, exactly, then goes from that account to the buyer.
   The destination's other funding never matches a withdrawal, so it is never counted. The buyer's KNTQ is never
   credited to the sequencer, because the buyer's money is mixed: the page lowers queued by the HYPE handed over and
   counts the buyer's Assistance Fund sends in total burned only, as it always has. */
const AF_BUYER = '0xaa3b7392052d62928cc87701e3ca6fb6630bb6e2';    // Kinetiq's hourly Assistance Fund buyer
const SYSTEM_HYPE = '0x2222222222222222222222222222222222222222';  // HyperEVM -> HyperCore HYPE transfers come from here
const units8 = s => { const [i, f = ''] = String(s).split('.'); return BigInt(i) * 100000000n + BigInt((f + '00000000').slice(0, 8)); };
const hype8 = u => +(Number(u) / 1e8).toFixed(8);
async function sequencerHandover(seq, prev, afSenders) {
  const rs = seq?.recipients || [];
  if (!rs.length) throw new Error('the fee splitters have no recipients in this run');
  const topBps = Math.max(...rs.map(r => r.bps));
  const mains = [...new Set(rs.filter(r => r.bps === topBps).map(r => r.address.toLowerCase()))];
  if (mains.length !== 1) throw new Error(`the splitters' largest recipients differ: ${mains.join(', ')}`);
  const wallet = mains[0], p = prev?.wallet === wallet ? prev : null;
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const startBlock = Math.min(...(seq.accounts || []).filter(a => a.contract).map(a => a.from));
  if (!Number.isFinite(startBlock)) throw new Error('no fee-splitter account to start from');
  // 1. the wallet's withdrawals, read incrementally. ArbSys does not index the caller, so every withdrawal is read.
  const withdrawals = (p?.withdrawals || []).map(({ state, ...w }) => w), seen = new Set(withdrawals.map(w => w.tx + ':' + w.logIndex));
  for (let a = p ? p.scannedTo + 1 : startBlock; a <= N; a += 200000) {
    for (const l of await logsRange(ARBSYS, [L2_TO_L1_TX], a, Math.min(N, a + 199999))) {
      if ('0x' + l.data.slice(26, 66) !== wallet) continue;
      const wei = BigInt('0x' + l.data.slice(2 + 64 * 4, 2 + 64 * 5)), key = l.transactionHash + ':' + parseInt(l.logIndex, 16);
      if (wei === 0n || seen.has(key)) continue; seen.add(key);
      const blk = parseInt(l.blockNumber, 16);
      withdrawals.push({ tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: blk, time: await blockTime(blk),
                         destination: '0x' + l.topics[1].slice(-40), valueWei: wei.toString(), hype: +e18(wei).toFixed(9) });
    }
  }
  withdrawals.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  // 2. each destination's HyperCore HYPE transfers, read incrementally from the first withdrawal to it
  const ledgers = {};
  for (const d of [...new Set(withdrawals.map(w => w.destination))]) {
    const pl = p?.ledgers?.[d], rows = [...(pl?.rows || [])], keys = new Set(rows.map(r => r.hash + r.from + r.to + r.amount));
    let to = pl?.to ?? Math.min(...withdrawals.filter(w => w.destination === d).map(w => w.time)) * 1000 - 1, start = to + 1;
    for (let page = 0; page < 40; page++) {
      const r = await hlInfo({ type: 'userNonFundingLedgerUpdates', user: d, startTime: start, endTime: Date.now() });
      if (!Array.isArray(r)) throw new Error(`Hyperliquid ledger for ${d} is not a list`);
      if (!r.length) break;
      for (const x of r) { const t = x.delta || {};
        if (t.type === 'spotTransfer' && t.token === 'HYPE') {
          const row = { hash: x.hash, time: x.time, from: (t.user || '').toLowerCase(), to: (t.destination || '').toLowerCase(), amount: String(t.amount) };
          if (!keys.has(row.hash + row.from + row.to + row.amount)) { keys.add(row.hash + row.from + row.to + row.amount); rows.push(row); } }
        to = Math.max(to, x.time); }
      start = Math.max(...r.map(x => x.time)) + 1;
      if (r.length < 500) break;
      if (page === 39) throw new Error(`Hyperliquid ledger for ${d} did not finish in 40 pages`);
    }
    ledgers[d] = { to, rows: rows.sort((a, b) => a.time - b.time) };
  }
  // 3. match arrivals to withdrawals, then hand-overs to arrivals
  const ws = withdrawals.map(w => ({ ...w, u: BigInt(w.valueWei) / 10000000000n, state: 'withdrawn' }));
  const arrivals = [], handed = [];
  for (const [d, L] of Object.entries(ledgers)) {
    const mine = ws.filter(w => w.destination === d);
    const outs = L.rows.filter(r => r.from === d && r.to === AF_BUYER).map(r => ({ ...r, used: false }));
    for (const a of L.rows.filter(r => r.from === SYSTEM_HYPE && r.to === d)) {
      const au = units8(a.amount), open = mine.filter(w => w.state === 'withdrawn' && w.time * 1000 <= a.time);
      let hit = null, diff = 0n;
      for (let i = 0; i < open.length && !hit; i++) {
        let sum = 0n;
        for (let k = i; k < Math.min(open.length, i + 8); k++) {
          sum += open[k].u; const n = BigInt(k - i + 1);
          if (sum - au <= n && au - sum <= n) { hit = open.slice(i, k + 1); diff = au - sum; break; }
          if (sum > au + n) break;
        }
      }
      if (!hit) { arrivals.push({ hash: a.hash, time: a.time, destination: d, hype: hype8(au), units: au.toString(), counted: false }); continue; }
      for (const w of hit) w.state = 'arrived';
      const o = outs.find(x => !x.used && x.time >= a.time && units8(x.amount) === au);
      const rec = { arrivalHash: a.hash, arrivalTime: a.time, destination: d, hype: hype8(au), units: au.toString(),
                    roundingUnits: Number(diff), withdrawals: hit.map(w => w.tx) };
      if (o) { o.used = true; for (const w of hit) w.state = 'handed'; handed.push({ ...rec, hash: o.hash, time: o.time, to: AF_BUYER }); }
      arrivals.push({ hash: a.hash, time: a.time, destination: d, hype: hype8(au), units: au.toString(), counted: true, handed: !!o });
    }
  }
  const sumU = xs => xs.reduce((t, x) => t + x, 0n), warnings = [];
  const buyer = (afSenders || []).find(x => x.from === AF_BUYER);
  if (!buyer || !(buyer.kntq > 0)) warnings.push({ what: `${AF_BUYER} is not a sender to the Assistance Fund in this run's data; check it is still Kinetiq's buyer` });
  const pending = ws.filter(w => w.state === 'withdrawn'), atDest = arrivals.filter(a => a.counted && !a.handed);
  for (const w of warnings) log('WARNING handover', w.what);
  log(`handover: ${handed.length} hand-overs, ${hype8(sumU(handed.map(h => BigInt(h.units))))} HYPE from ${wallet} to the buyer; ` +
      `${pending.length} withdrawals on their way; ${arrivals.filter(a => !a.counted).length} arrivals from other funding not counted`);
  return { wallet, buyer: AF_BUYER, buyerKntqToFund: buyer ? buyer.kntq : null,
           handedHype: hype8(sumU(handed.map(h => BigInt(h.units)))), handed,
           inTransitHype: +e18(pending.reduce((t, w) => t + BigInt(w.valueWei), 0n)).toFixed(9), inTransit: pending.length,
           atDestinationHype: hype8(sumU(atDest.map(a => BigInt(a.units)))),
           otherFundingHype: hype8(sumU(arrivals.filter(a => !a.counted).map(a => BigInt(a.units)))),
           withdrawals: ws.map(({ u, ...w }) => w), arrivals, ledgers, scannedTo: N, warnings, atBlock: N };
}
const ho = await step('sequencerHandover', () => sequencerHandover(data.sequencer, prev?.sequencerHandover, data.assistanceFund?.senders)); if (ho) data.sequencerHandover = { ...ho, at: now };
const K  = await step('knownSources', () => knownSources(data.sequencer, data.ascendTreasury, data.sequencerSweep));
const bn = K && await step('burns', () => burns(prev?.burns, K, data.assistanceFund)); if (bn) data.burns = { ...bn, at: now };
delete data.elysiumBurns;                           // the previous format; the live page reads data.burns
data.oku = { status: 'pledged', counted: false, pledge: '40% of net trading fees on Elysium', announced: '2026-11-07',
             note: 'No Oku fee wallet, Elysium deployment address or burn address has been published.' };
if (!seq && !asc && !tre && !hl) { console.error('nothing refreshed; data.json left untouched'); process.exit(1); }
data.warnings = [['ascendTreasury', data.ascendTreasury], ['ascendStrategic', data.ascendStrategic], ['montra', data.montra], ['sequencerSweep', data.sequencerSweep], ['sequencerHandover', data.sequencerHandover]]
  .flatMap(([k, v]) => (v?.warnings || []).map(w => ({ step: k, ...w })));
await writeFile(OUT, JSON.stringify(data));
log('wrote data.json', Object.keys(data.errors).length ? 'with errors: ' + Object.keys(data.errors).join(', ') : 'clean', data.warnings.length ? `(${data.warnings.length} warnings)` : '');
