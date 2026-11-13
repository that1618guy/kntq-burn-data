/* Attribution of KNTQ burns and Assistance Fund arrivals to known sources.

   A burn is credited to a source only when the chain proves where the money came from: the wallet that burned
   (or sent to the Assistance Fund) is a known source itself, or EVERY inflow it had before the burn traces, within
   MAX_HOPS hops, to known sources. Swaps a wallet makes with its own money keep its funds' origin. Anything else
   ends the trail and leaves the burn "source not identified": a deposit from another chain, a genesis allocation,
   an unknown contract, an internal transfer that needs a trace API to see, a wallet too busy to read in full, or
   one inflow from anywhere unknown. Money is interchangeable, so a wallet with mixed funding proves nothing about
   any one of its sends; it is not credited pro rata.

   Known sources: the sequencer fee account and Ascend's burn treasury (both read from the chain every run), and
   the confirmed app wallets in sources.json. Every result records its reason and the path it followed. */

// Bump when the tracing rules change: cached verdicts from older rules are then re-traced.
export const TRACER_VERSION = 2;
const MAX_HOPS = 3;          // hops beyond the wallet that burned
const NODE_BUDGET = 30;      // wallets read per trace before giving up as "too wide"
const HL = 'https://api.hyperliquid.xyz/info';
const SYSTEM_HYPE = '0x2222222222222222222222222222222222222222';   // HyperEVM <-> HyperCore HYPE transfers
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = n => '0x' + n.toString(16);
const pad32 = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = a => a.slice(0, 6) + '…' + a.slice(-4);

async function hl(body) {
  for (let k = 0; ; k++) {
    try { const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
          if (r.ok) { await sleep(150); return r.json(); } if (k >= 5) throw new Error('HTTP ' + r.status); }
    catch (e) { if (k >= 5) throw e; }
    await sleep(1500 * (k + 1));
  }
}

class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }

export function makeTracer({ rpc, known, deadline = Infinity }) {
  // Past the run's time budget a trace stops with an error, not a verdict, and is picked up again next run.
  const checkTime = () => { if (Date.now() > deadline) throw new Error('time budget for this run used up'); };
  // known: Map "chain:address" -> { label, kind, app }
  const isKnown = (chain, a) => known.get(chain + ':' + a.toLowerCase());
  const codeCache = new Map(), hlCache = new Map();
  const isContract = async a => { if (!codeCache.has(a)) codeCache.set(a, (await rpc('eth_getCode', [a, 'latest'])).length > 2); return codeCache.get(a); };

  /* ---- Elysium: every inflow to an address up to a block, read lazily, oldest HYPE first, so a trace stops at
     the first inflow it cannot follow without reading the rest ---- */
  async function* elysiumInflows(a, toBlock) {
    const nonce = parseInt(await rpc('eth_getTransactionCount', [a, hex(toBlock)]), 16);
    if (nonce > 200) throw new Stop(`${short(a)} on Elysium has sent ${nonce} transactions, too busy to read in full`);
    const logs = await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(toBlock), topics: [TRANSFER, null, pad32(a)] }]);
    if (logs.length > 150) throw new Stop(`${short(a)} on Elysium has ${logs.length} token inflows, too many to read in full`);
    for (const l of logs) yield { kind: 'token', from: '0x' + l.topics[1].slice(-40), tx: l.transactionHash, block: parseInt(l.blockNumber, 16) };
    // native HYPE: blocks where the balance rose (or a spend could hide a rise), found by bisection, left first
    const bal = async b => BigInt(await rpc('eth_getBalance', [a, hex(b)]));
    const non = async b => parseInt(await rpc('eth_getTransactionCount', [a, hex(b)]), 16);
    let reads = 0;
    async function* rises(lo, hi, blo, bhi, nlo, nhi) {
      if (bhi <= blo && nhi === nlo) return;
      if (hi === lo) { yield lo; return; }
      if ((reads += 2) > 160) throw new Stop(`${short(a)} on Elysium has too many HYPE movements to read in full`);
      checkTime();
      const mid = (lo + hi) >> 1, bm = await bal(mid), nm = await non(mid);
      yield* rises(lo, mid, blo, bm, nlo, nm); yield* rises(mid + 1, hi, bm, bhi, nm, nhi);
    }
    for await (const b of rises(1, toBlock, 0n, await bal(toBlock), 0, nonce)) {
      const before = await bal(b - 1), after = await bal(b);
      const blk = await rpc('eth_getBlockByNumber', [hex(b), true]);
      const mine = blk.transactions.filter(t => (t.to || '').toLowerCase() === a && BigInt(t.value) > 0n);
      if (!mine.length && after <= before) continue;                       // only a spend in this block
      if (!mine.length) throw new Stop(`${short(a)} received HYPE in block ${b} by an internal transfer, which needs a trace API to follow`);
      for (const t of mine) {
        if (['0x64', '0x65', '0x69'].includes(t.type)) throw new Stop(`${short(a)} was funded from another chain (bridge deposit in block ${b})`);
        yield { kind: 'hype', from: t.from.toLowerCase(), tx: t.hash, block: b };
      }
    }
  }

  /* ---- HyperCore: every inflow to an address up to a time ---- */
  async function coreRows(a) {
    if (hlCache.has(a)) return hlCache.get(a);
    let start = Date.parse('2024-01-01'), rows = [], pages = 0;
    for (;;) {
      const u = await hl({ type: 'userNonFundingLedgerUpdates', user: a, startTime: start, endTime: Date.now() });
      rows.push(...u); if (u.length < 500) break;
      if (++pages > 8) throw new Stop(`${short(a)} on Hyperliquid has more than 4,000 ledger rows, too busy to read in full`);
      start = u[u.length - 1].time + 1;
    }
    hlCache.set(a, rows); return rows;
  }
  async function coreInflows(a, toTime) {
    const out = [];
    for (const r of await coreRows(a)) {
      if (r.time > toTime) continue;
      const d = r.delta, dest = (d.destination || '').toLowerCase(), user = (d.user || '').toLowerCase();
      if (d.type === 'send' || d.type === 'spotTransfer') { if (dest === a && user !== a) out.push({ kind: d.token || 'USDC', from: user, time: r.time, hash: r.hash }); continue; }
      if (['internalTransfer', 'accountClassTransfer', 'subAccountTransfer'].includes(d.type)) continue;            // between its own balances
      if (['withdraw', 'accountActivationGas', 'deployGasAuction', 'spotDeployGasAuction'].includes(d.type)) continue; // outflows
      if (d.type === 'deposit') throw new Stop(`${short(a)} on Hyperliquid was funded by a deposit from Arbitrum`);
      if (d.type === 'spotGenesis') throw new Stop(`${short(a)} on Hyperliquid holds a genesis allocation`);
      throw new Stop(`${short(a)} on Hyperliquid received funds by "${d.type}", which this does not follow`);
    }
    return out;
  }

  /* ---- the trace: is everything this address received known-source money? ---- */
  async function pure(chain, a, cut, depth, seen, budget, path) {
    a = a.toLowerCase();
    const k = isKnown(chain, a); if (k) return [k];
    if (depth > MAX_HOPS) throw new Stop(`the trail is longer than ${MAX_HOPS} hops (${path.join(' ← ')})`);
    if (seen.has(chain + a)) return [];                                    // a loop adds nothing new
    seen.add(chain + a);
    if (++budget.n > NODE_BUDGET) throw new Stop(`the trail fans out to more than ${NODE_BUDGET} wallets`);
    checkTime();
    const sources = [];
    if (chain === 'elysium') {
      if (await isContract(a)) throw new Stop(`funds came from contract ${short(a)}, which is not a known source`);
      let any = false;
      for await (const i of elysiumInflows(a, cut)) {
        any = true;
        if (i.kind === 'token' && /^0x0{40}$/.test(i.from)) throw new Stop(`${short(a)} received KNTQ or another token bridged in from HyperEVM (minted on Elysium)`);
        if (i.kind === 'token' && await isContract(i.from)) {
          const t = await rpc('eth_getTransactionByHash', [i.tx]);
          if (t.from.toLowerCase() === a) continue;                         // a swap it made with its own money
          throw new Stop(`${short(a)} received tokens from contract ${short(i.from)} in a transaction it did not send`);
        }
        sources.push(...await pure('elysium', i.from, i.block, depth + 1, seen, budget, [...path, short(i.from)]));
      }
      if (!any) throw new Stop(`${short(a)} on Elysium shows no inflows to follow`);
    } else {
      const ins = await coreInflows(a, cut);
      if (!ins.length) throw new Stop(`${short(a)} on Hyperliquid shows no inflows to follow`);
      for (const i of ins) {
        if (i.from === SYSTEM_HYPE) {                                       // from its own HyperEVM address
          const e = isKnown('hyperevm', a); if (e) { sources.push(e); continue; }
          throw new Stop(`${short(a)} moved funds in from its HyperEVM address, which is not followed yet`);
        }
        sources.push(...await pure('hypercore', i.from, i.time, depth + 1, seen, budget, [...path, short(i.from)]));
      }
    }
    return sources;
  }

  /* trace one actor; returns { credited: {label,kind,app} } or { unidentified: reason } */
  async function trace(chain, actor, cut) {
    try {
      const srcs = await pure(chain, actor, cut, 0, new Set(), { n: 0 }, [short(actor)]);
      const labels = [...new Map(srcs.map(s => [s.label, s])).values()];
      if (!labels.length) return { unidentified: 'no inflow reached a known source' };
      if (labels.length > 1) return { unidentified: `funded by more than one known source (${labels.map(s => s.label).join(', ')}), so no single source can be credited` };
      return { credited: labels[0] };
    } catch (e) {
      if (e instanceof Stop) return { unidentified: e.reason };
      return { error: e.message };                                          // a read failed: try again next run
    }
  }
  return { trace, isContract, isKnown };
}
