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
const AF      = '0xfefefefefefefefefefefefefefefefefefefefe'; // Hyperliquid Assistance Fund
const LLAMA   = 'https://api.llama.fi/summary/fees/ascend-launchpad?dataType=dailyHoldersRevenue';
const OWNER_PUBLIC = '0x000000000000000000000000000000000000006b';
const SPLITTER = '0xfda2703df09b23caffc30dee6c73b4a12fc82faf';  // Ascend ProtocolSplitter
const KNTQ_EVM = '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0';  // KNTQ on Elysium
const WHYPE    = '0xba876237b0f021a6c6d852d6c26e107997cc5e81';
const USDC     = '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65';  // 6 decimals
const BURN_SINKS = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'];
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

  // The fee account is read from the chain every run, never assumed. Network and infra are one account today.
  const network = '0x' + (await rpc('eth_call', [{ to: OWNER_PUBLIC, data: '0x2d9125e9' }, 'latest'])).slice(-40); // getNetworkFeeAccount()
  const infra   = '0x' + (await rpc('eth_call', [{ to: OWNER_PUBLIC, data: '0xee95a824' }, 'latest'])).slice(-40); // getInfraFeeAccount()
  if (network !== infra) throw new Error(`network (${network}) and infra (${infra}) fee accounts differ; the exact method needs both summed`);
  if (prev?.feeAccount && prev.feeAccount !== network) throw new Error(`fee account changed ${prev.feeAccount} -> ${network}; re-derive history`);
  const FEE = network;
  // An account that has never sent a transaction (nonce 0) cannot have paid anything out, so its balance
  // change over a day is everything it received that day. Once it sends (a buyback), outflows must be added back.
  const nonce = parseInt(await rpc('eth_getTransactionCount', [FEE, 'latest']), 16);
  const feeBalance = await balanceAt(FEE, N);

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
      const delta = (await balanceAt(FEE, b)) - (await balanceAt(FEE, a - 1));
      let fees = 0n;
      for (let k = a; k <= b; k++) for (const r of (await rpc('eth_getBlockReceipts', [hex(k)])) || [])
        if (!NOT_SEQUENCER_FEE.has(r.type)) fees += (BigInt(r.gasUsed || '0x0') - BigInt(r.gasUsedForL1 || '0x0')) * BigInt(r.effectiveGasPrice || '0x0');
      out.push({ from: a, to: b, feesWei: fees.toString(), deltaWei: delta.toString(), ok: fees === delta });
    }
    return { windows: out, blocks: out.length * w, ok: out.every(x => x.ok) };
  }

  if (nonce !== 0) log(`fee account nonce ${nonce}: it has sent transactions, so balance deltas undercount from then on`);
  const done = new Map((prev?.days || []).filter(d => !d.partial && d.check?.windows && d.method === 'fee-account-delta').map(d => [d.date, d]));
  const days = [];
  const today0 = Math.floor(T / 86400) * 86400;
  for (let t = Date.parse(START + 'T00:00:00Z') / 1000; t <= today0; t += 86400) {
    const date = day(t), partial = t === today0;
    if (done.has(date)) { days.push(done.get(date)); continue; }
    const from = await blockAt(t), to = partial ? N : (await blockAt(t + 86400)) - 1;
    if (to < from) { days.push({ date, feesHype: 0, fromBlock: from, toBlock: to, partial, method: 'fee-account-delta', check: { windows: [], blocks: 0, ok: true } }); continue; }
    if (nonce !== 0) { days.push({ date, feesHype: null, partial, method: 'fee-account-delta', error: 'fee account has sent transactions; outflows not yet reconstructed' }); continue; }
    const wei = (await balanceAt(FEE, to)) - (await balanceAt(FEE, from - 1));
    const row = { date, feesHype: +e18(wei).toFixed(9), fromBlock: from, toBlock: to, partial, method: 'fee-account-delta',
                  hours: +(((partial ? T : t + 86400) - t) / 3600).toFixed(2) };
    if (!partial) row.check = await windowCheck(from, to);
    days.push(row);
    log(`${date}${partial ? ' (so far)' : ''}: ${row.feesHype.toFixed(4)} HYPE in fees, blocks ${from}..${to}` +
        (row.check ? `, ${row.check.windows.length} windows ${row.check.ok ? 'exact' : 'MISMATCH ' + JSON.stringify(row.check.windows.filter(x => !x.ok))}` : ''));
  }
  return { method: 'fee-account-delta', feeAccount: FEE, feeAccountNonce: nonce, feeAccountHype: +e18(feeBalance).toFixed(9),
           buybacksExecuted: nonce === 0 ? 0 : null, latestBlock: N, latestTime: T, bounds, days };
}

async function ascendTreasury(prev) {
  const N = parseInt(await rpc('eth_blockNumber', []), 16);
  const treasury = '0x' + (await rpc('eth_call', [{ to: SPLITTER, data: '0x3e4d69ca' }, 'latest'])).slice(-40);   // kntqBurn()
  const ppm = Number(BigInt(await rpc('eth_call', [{ to: SPLITTER, data: '0x9b7858ba' }, 'latest'])));            // kntqBurnPpm()
  const [kntq, whype, usdc] = [await erc20Bal(KNTQ_EVM, treasury), await erc20Bal(WHYPE, treasury), await erc20Bal(USDC, treasury)];
  const logs = async (address, topics) => rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(N), address, topics }]);
  const kntqOut = await logs(KNTQ_EVM, [TRANSFER, pad32(treasury)]);
  const kntqIn = await logs(KNTQ_EVM, [TRANSFER, null, pad32(treasury)]);
  const burned = kntqOut.filter(l => BURN_SINKS.includes('0x' + l.topics[2].slice(-40))).reduce((a, l) => a + BigInt(l.data), 0n);
  const movedOut = kntqOut.reduce((a, l) => a + BigInt(l.data), 0n);
  // Buybacks: WHYPE leaving the treasury in a tx that returns KNTQ to it.
  const known = new Map((prev?.buybacks || []).map(b => [b.tx, b]));
  const buybacks = [];
  for (const l of await logs(WHYPE, [TRANSFER, pad32(treasury)])) {
    if (known.has(l.transactionHash)) { buybacks.push(known.get(l.transactionHash)); continue; }
    const rc = await rpc('eth_getTransactionReceipt', [l.transactionHash]);
    const back = rc.logs.filter(x => x.address.toLowerCase() === KNTQ_EVM && x.topics[0] === TRANSFER && x.topics[2] === pad32(treasury))
                        .reduce((a, x) => a + BigInt(x.data), 0n);
    const blk = await rpc('eth_getBlockByNumber', [l.blockNumber, false]);
    buybacks.push({ tx: l.transactionHash, block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16),
                    whype: +e18(BigInt(l.data)).toFixed(6), kntq: +e18(back).toFixed(6) });
  }
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
  for (const l of kntqOut.filter(l => BURN_SINKS.includes('0x' + l.topics[2].slice(-40)))) {
    const key = l.transactionHash + ':' + parseInt(l.logIndex, 16);
    if (knownBurns.has(key)) { burns.push(knownBurns.get(key)); continue; }
    const blk = await rpc('eth_getBlockByNumber', [l.blockNumber, false]);
    burns.push({ tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16),
                 to: '0x' + l.topics[2].slice(-40), kntq: +e18(BigInt(l.data)).toFixed(6) });
  }
  return { address: treasury, ppm, kntq: +e18(kntq).toFixed(6),
           kntqReceived: +e18(received).toFixed(6), kntqFromBuybacks: +e18(received - fromSplitter - other).toFixed(6),
           kntqFromSplitter: +e18(fromSplitter).toFixed(6), kntqFromOther: +e18(other).toFixed(6), whype: +e18(whype).toFixed(6), usdc: Number(usdc) / 1e6,
           kntqFees, kntqBurned: +e18(burned).toFixed(6), burns, kntqMovedOut: +e18(movedOut).toFixed(6), buybacks, atBlock: N };
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
    return { price, pair: pair.name, total: +ctx.totalSupply };
  };
  const kntq = spot('KNTQ'), hype = spot('HYPE');
  const state = await post({ type: 'spotClearinghouseState', user: AF });
  if (!Array.isArray(state.balances)) throw new Error('Assistance Fund state has no balances');
  const held = state.balances.find(b => b.coin === 'KNTQ');
  // Who sent the Fund its KNTQ, kept as per-sender totals plus the latest rows (the full ledger would make this
  // file grow every half hour). Incremental from the last row seen; the totals must sum to the balance.
  const prevF = prev || {};
  const senders = Object.fromEntries((prevF.senders || []).map(x => [x.from, { ...x }]));
  // one-time migration from the old full-ledger format
  if (!prevF.senders && Array.isArray(prevF.ledger)) for (const r of prevF.ledger) { const x = senders[r.from] ||= { from: r.from, kntq: 0, sends: 0, first: r.time, last: r.time }; x.kntq += r.kntq; x.sends++; x.last = r.time; }
  let recent = [...(prevF.recent || prevF.ledger || [])].slice(-RECENT);
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
  recent = recent.slice(-RECENT);
  return { kntq: kntq.price, kntqPair: kntq.pair, hype: hype.price, hypePair: hype.pair, supplyTotal: kntq.total,
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
const RECENT = 60;
const hl  = await step('hyperliquid', () => hyperliquid(prev?.assistanceFund));
if (hl) {
  data.prices = { kntq: hl.kntq, kntqPair: hl.kntqPair, hype: hl.hype, hypePair: hl.hypePair, at: now };
  data.supply = { total: hl.supplyTotal, at: now };
  const ledgerSum = hl.senders.reduce((a, x) => a + x.kntq, 0);
  const hist = (prev?.assistanceFund?.history || []).filter(h => h.date !== now.slice(0, 10));
  data.assistanceFund = {
    kntq: hl.afKntq, at: now, lastTime: hl.lastTime, recent: hl.recent, ledgerSum: +ledgerSum.toFixed(6),
    // The balance must equal the sum of the sends we can see, or the breakdown is incomplete.
    ledgerMatchesBalance: hl.afKntq != null && Math.abs(ledgerSum - hl.afKntq) < 0.01,
    senders: hl.senders.sort((a, b) => b.kntq - a.kntq).map(x => ({ ...x, kntq: +x.kntq.toFixed(6) })),
    history: hl.afKntq == null ? hist : [...hist, { date: now.slice(0, 10), kntq: hl.afKntq }].slice(-400),
  };
}
/* ---------- Burns ----------
   Burned = every KNTQ burned on Elysium, from any sender, plus KNTQ that reaches Hyperliquid's Assistance Fund
   when it traces back to the sequencer or an Elysium app.
   On Elysium a burn is KNTQ sent to a burn address, or a burn call: a transfer to the zero address that is not a
   bridge withdrawal. KNTQ on Elysium is Arbitrum's standard bridged token, whose only burn function answers to
   the token gateway, so today every transfer to the zero address is a withdrawal to HyperEVM, where the tokens
   still exist. Each one is checked for the gateway's WithdrawalInitiated event in the same transaction, so a real
   burn call would be counted if one ever appeared. */
const BURN_ADDRESSES = ['0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069'];
const ZERO = '0x0000000000000000000000000000000000000000';
const WITHDRAWAL_INITIATED = '0x3073a74ecb728d10be779fe19a74a1428e20468f5b4d167bf9c73d9067847d73';
const KNOWN_FILE = new URL('./sources.json', import.meta.url);

async function knownSources(seq, tre) {
  const known = new Map(), list = [];
  const add = (chain, address, label, kind, extra = {}) => { const k = chain + ':' + address.toLowerCase(); known.set(k, { label, kind, ...extra }); list.push({ chain, address: address.toLowerCase(), label, kind, ...extra }); };
  if (seq?.feeAccount) add('elysium', seq.feeAccount, 'Elysium sequencer fee account', 'sequencer');
  if (tre?.address) add('elysium', tre.address, "Ascend's burn treasury", 'app', { app: 'Ascend' });
  const file = JSON.parse(await readFile(KNOWN_FILE, 'utf8'));
  for (const a of file.apps || []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.address || '') || !['elysium', 'hypercore', 'hyperevm'].includes(a.chain)) throw new Error('sources.json: bad entry ' + JSON.stringify(a));
    add(a.chain, a.address, a.label || a.app, 'app', { app: a.app, evidence: a.evidence });
  }
  const hash = createHash('sha256').update(JSON.stringify({ list, tracer: TRACER_VERSION })).digest('hex').slice(0, 16);
  return { known, list, hash };
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
  const afCredited = afSenders.filter(x => x.credited);
  const afKntq = +afCredited.reduce((t, x) => t + x.kntq, 0).toFixed(6);

  // Alerts: a new wallet whose burn or Assistance Fund send could not be traced to a known source. Each wallet
  // alerts once; the first run records what was already there without alerting.
  const alerted = new Set(prev?.alerted || []), first = !prev?.alerted, alerts = [];
  const flag = (who, what, reason) => { if (alerted.has(who)) return; alerted.add(who); if (!first) alerts.push({ at: now, who, what, reason }); };
  for (const e of other) flag('elysium:' + e.actor, `burned ${e.kntq} KNTQ on Elysium (tx ${e.tx})`, e.reason);
  for (const x of afSenders.filter(x => !x.credited)) flag('hypercore:' + x.from, `sent ${x.kntq.toFixed(2)} KNTQ to the Assistance Fund in ${x.sends} sends`, x.unidentified || x.error);
  for (const a of alerts) log('ALERT source not identified:', a.who, a.what, '|', a.reason);

  return {
    total: +(sum(events) + afKntq).toFixed(6), fromSources: +(sum(credited) + afKntq).toFixed(6), fromOthers: sum(other),
    elysium: { kntq: sum(events), count: events.length, credited: sum(credited), other: sum(other) },
    af: { creditedKntq: afKntq, senders: afSenders.map(x => ({ from: x.from, kntq: +x.kntq.toFixed(6), sends: x.sends, last: x.last, source: x.credited?.label || null,
           reason: x.credited ? null : (x.unidentified || 'not traced yet: ' + x.error), credited: x.credited || null, unidentified: x.unidentified || null, error: x.error || null })) },
    excluded: { withdrawals, withdrawnKntq: +withdrawnKntq.toFixed(6), gateway: '0x5dc84e4cb0f9082246e92a5585c5395592b1af1f', router: '0x61ebbc3a29f1970af2ce862ba9c5364832e14d17', event: WITHDRAWAL_INITIATED },
    burnAddresses: BURN_ADDRESSES, events, zeroChecked,
    actors: [...traced.values()].map(a => ({ actor: a.actor, credited: a.credited || null, unidentified: a.unidentified || null, error: a.error || null, tries: a.tries || 0 })),
    registryHash: K.hash, known: K.list, alerted: [...alerted], alerts, atBlock: N,
  };
}
const K  = await step('knownSources', () => knownSources(data.sequencer, data.ascendTreasury));
const bn = K && await step('burns', () => burns(prev?.burns, K, data.assistanceFund)); if (bn) data.burns = { ...bn, at: now };
// data.elysiumBurns (the previous format) is left in place until the page that reads data.burns is live.
data.oku = { status: 'pledged', counted: false, pledge: '40% of net trading fees on Elysium', announced: '2026-11-07',
             note: 'No Oku fee wallet, Elysium deployment address or burn address has been published.' };
if (!seq && !asc && !tre && !hl) { console.error('nothing refreshed; data.json left untouched'); process.exit(1); }
await writeFile(OUT, JSON.stringify(data));
log('wrote data.json', Object.keys(data.errors).length ? 'with errors: ' + Object.keys(data.errors).join(', ') : 'clean');
