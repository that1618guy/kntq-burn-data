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
// Burn addresses on Elysium. The zero address is not one: KNTQ sent there is a bridge withdrawal to HyperEVM.
const BURN_ADDRESSES = ['0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069'];
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
  const burned = kntqOut.filter(l => BURN_ADDRESSES.includes('0x' + l.topics[2].slice(-40))).reduce((a, l) => a + BigInt(l.data), 0n);
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
/* ---------- Kinetiq's own figures, cross-checked ----------
   kinetiq.xyz/kntq fills its "Projects buying KNTQ" table and its supply numbers from three routes of its own site.
   They are undocumented and unversioned, so every field is shape-checked, a project with no totals is kept as "not
   tracked" (never as zero), and each figure that the chain can confirm is checked against the chain here. */
const KINETIQ = 'https://kinetiq.xyz/api/kntq-data/';
const HYPEREVM = 'https://rpc.hyperliquid.xyz/evm';
const SKNTQ = '0x696238e0ca31c94e24ca4cbe7921754e172e4d0f';   // Staked KNTQ (ERC-4626 vault) on HyperEVM
async function kinetiq(tre, afKntq) {
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
    // Cross-check where the chain has an address for the project. Only Ascend has one today: its burn treasury.
    if (p.slug === 'ascend' && tre) {
      const chain = { bought: tre.kntqFromBuybacks, burned: tre.kntqBurned, buys: tre.buybacks?.length ?? null, lastBuy: tre.buybacks?.length ? tre.buybacks[tre.buybacks.length - 1].time * 1000 : null };
      const ok = tracked && close(row.bought, chain.bought, 1) && close(row.burned, chain.burned, 1);
      row.check = { status: ok ? 'match' : 'mismatch', chain, against: `Ascend's burn treasury ${tre.address} on Elysium` };
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
const kq = await step('kinetiq', () => kinetiq(data.ascendTreasury, data.assistanceFund?.kntq)); if (kq) data.kinetiq = { ...kq, at: now };
/* ---------- Projects buying KNTQ ----------
   The table is sources.json's projects list. Two things are added here:
   1. A project in Kinetiq's "projects buying KNTQ" data that is not in the list is added as pledged, not verifiable,
      with Kinetiq as its source, and raises an alert once. It leaves the added list when it is put into sources.json.
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

async function projects(prev, kq) {
  const file = JSON.parse(await readFile(KNOWN_FILE, 'utf8'));
  const ours = file.projects || [];
  for (const p of ours) if (!p.name || !p.commitment) throw new Error('sources.json: project needs name and commitment ' + JSON.stringify(p));
  const slugs = new Set(ours.map(p => p.kinetiq).filter(Boolean)), names = new Set(ours.map(p => p.name));
  const alerted = new Set(prev?.alerted || []), alerts = [];
  const alert = (key, what) => { if (alerted.has(key)) return; alerted.add(key); alerts.push({ at: new Date().toISOString(), what }); log('ALERT', what); };
  // 1. Kinetiq's list against ours (kept from the last run when Kinetiq could not be read)
  const added = new Map((prev?.added || []).filter(x => !slugs.has(x.kinetiq)).map(x => [x.kinetiq, x]));
  if (kq) for (const p of kq.projects) if (!slugs.has(p.slug) && !added.has(p.slug))
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
    wallets.push(w);
  }
  // rows: our list, then Kinetiq's additions, each with the totals of its wallets
  const sumPaid = bs => bs.reduce((o, b) => { for (const [k, v] of Object.entries(b.paid)) o[k] = +((o[k] || 0) + v).toFixed(6); return o; }, {});
  const list = [...ours.map(p => ({ ...p, source: p.source || 'ours' })), ...added.values()].map(p => {
    const ws = wallets.filter(w => w.app === p.name), buys = ws.flatMap(w => w.buys), burns = ws.flatMap(w => w.burns);
    const row = { name: p.name, commitment: p.commitment, kinetiq: p.kinetiq || null, chain: p.chain || null, source: p.source, note: p.note || null, wallets: ws.length };
    if (ws.length) Object.assign(row, { verified: true, complete: ws.every(w => w.complete && !w.error),
      bought: +buys.reduce((s, b) => s + b.kntq, 0).toFixed(6), paid: sumPaid(buys), burned: +burns.reduce((s, b) => s + b.kntq, 0).toFixed(6),
      buys: buys.length, lastBuy: buys.length ? Math.max(...buys.map(b => b.time)) : null,
      reading: ws.reduce((s, w) => s + (w.pending?.length || 0), 0) });
    return row;
  });
  return { list, added: [...added.values()], wallets, alerted: [...alerted], alerts, atBlock: N };
}
const pj = await step('projects', () => projects(prev?.projects, data.kinetiq)); if (pj) data.projects = { ...pj, at: now };
const K  = await step('knownSources', () => knownSources(data.sequencer, data.ascendTreasury));
const bn = K && await step('burns', () => burns(prev?.burns, K, data.assistanceFund)); if (bn) data.burns = { ...bn, at: now };
delete data.elysiumBurns;                           // the previous format; the live page reads data.burns
data.oku = { status: 'pledged', counted: false, pledge: '40% of net trading fees on Elysium', announced: '2026-11-07',
             note: 'No Oku fee wallet, Elysium deployment address or burn address has been published.' };
if (!seq && !asc && !tre && !hl) { console.error('nothing refreshed; data.json left untouched'); process.exit(1); }
await writeFile(OUT, JSON.stringify(data));
log('wrote data.json', Object.keys(data.errors).length ? 'with errors: ' + Object.keys(data.errors).join(', ') : 'clean');
