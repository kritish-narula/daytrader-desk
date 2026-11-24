#!/usr/bin/env node
/* Paper-trading league runner (GitHub Actions, after the NSE close). No broker credentials: Yahoo daily bars + NSE public files.
   node tools/paper.js                 daily run: catch up every session since the last run (first run = backfill 120)
   node tools/paper.js --backfill 120  replay the last 120 sessions walk-forward (no look-ahead), labelled "backfilled"
   Options: --out <dir> (default data/), --limit <n> (first n stocks, for tests), --until <YYYY-MM-DD> (stop at that session, for tests)
   Writes data/paper.json (app view), data/paper_history.json (daily equity per strategy), data/paper_state.json (full state). */
'use strict';
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js'), P = require('../www/paper.js');
const { TRAIN, TEST } = require('./universe.js');

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BACKFILL = args.includes('--backfill') ? +arg('--backfill', 120) || 120 : 0;
const OUT = path.resolve(arg('--out', path.join(__dirname, '..', 'data')));
const LIMIT = +arg('--limit', 0) || 0;
const UNTIL = arg('--until', null); // testing: pretend the last session is this date
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', Accept: '*/*', Referer: 'https://www.nseindia.com/' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- data ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function yahoo(ysym, range = '2y', interval = '1d') {
  let err;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?range=${range}&interval=${interval}&includePrePost=false`, { headers: { 'User-Agent': UA['User-Agent'] } });
      const j = await r.json(), R = j.chart.result[0], q = R.indicators.quote[0];
      const D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
      R.timestamp.forEach((t, i) => {
        if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null || !(x > 0))) return;
        const day = new Date((t + 19800) * 1000).toISOString().slice(0, 10); // IST date
        if (D.day.length && D.day[D.day.length - 1] === day) { const n = D.c.length - 1; D.h[n] = Math.max(D.h[n], q.high[i]); D.l[n] = Math.min(D.l[n], q.low[i]); D.c[n] = q.close[i]; D.v[n] += q.volume[i] || 0; return; }
        D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); D.day.push(day);
      });
      if (D.c.length < 30) throw new Error('short series');
      return D;
    } catch (e) { err = e; await sleep(500 * (k + 1)); }
  }
  throw err;
}
async function text(u) { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }
const csvRows = t => t.split(/\r?\n/).filter(Boolean).map(l => l.split(',').map(x => x.trim().replace(/^"|"$/g, '')));
async function universe() {
  let n200 = [], fo = {}, src = [];
  try { const R = csvRows(await text('https://nsearchives.nseindia.com/content/indices/ind_nifty200list.csv')); const h = R[0].map(x => x.toLowerCase()), k = h.indexOf('symbol'); n200 = R.slice(1).map(r => r[k]).filter(Boolean); src.push('Nifty 200 (NSE)'); } catch (e) { log('nifty200 list failed:', e.message); }
  try {
    for (const r of csvRows(await text('https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv'))) {
      if (r.length < 3 || !r[1] || /symbol/i.test(r[1])) continue; const lot = r.slice(2).map(x => parseInt(x, 10)).find(x => x > 0); if (!lot) continue;
      if (P.IDX_LOT[r[1]] != null) P.IDX_LOT[r[1]] = lot; else if (!/NIFTY/.test(r[1])) fo[r[1]] = lot;
    }
    if (Object.keys(fo).length) src.push('F&O lots (NSE)');
  } catch (e) { log('fo lots failed:', e.message); }
  // fallback: the 80 large/mid caps the engine is validated on; lots approximated from the ₹15 lakh minimum contract value
  if (n200.length < 100) { n200 = [...TRAIN, ...TEST]; src.push('fallback 80-stock list'); }
  const foApprox = !Object.keys(fo).length;
  const syms = [...new Set([...n200, ...Object.keys(fo)])].filter(s => !/[^A-Z0-9&-]/.test(s));
  return { syms: LIMIT ? syms.slice(0, LIMIT) : syms, fo, foApprox, src: src.join(' + ') };
}
async function pool(items, n, fn) { let i = 0; const out = []; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } })); return out; }

// ---------- one session ----------
function runDay(st, day, nextDay, M) {
  const ctxF = M.ctxF, bar = (sym, d = day) => { const X = M.X[sym]; if (!X) return null; const i = X.idx.get(d); return i == null ? null : { o: X.D.o[i], h: X.D.h[i], l: X.D.l[i], c: X.D.c[i], i }; };
  const opened = [];
  // 1) pending entry orders
  const keep = [];
  for (const o of st.pending) {
    const b = bar(o.sym); if (!b) { if (++o.age > P.ORDER_VALID) continue; keep.push(o); continue; }
    const t = P.tryFill(st, o, b, day, ctxF);
    if (t) { opened.push(t); continue; }
    const why = o.dead || (o.type === 'open' ? 'not filled' : ++o.age >= P.ORDER_VALID ? 'entry not triggered in 3 sessions' : null);
    if (why) { st.cancelled[o.s] = (st.cancelled[o.s] || 0) + 1; const W = st.why[o.s] = st.why[o.s] || {}; W[why] = (W[why] || 0) + 1; continue; }
    keep.push(o);
  }
  st.pending = keep;
  // benchmark: Nifty buy & hold from the first session
  if (!st.open.some(t => t.s === 'nifty_bh') && !st.closed.some(t => t.s === 'nifty_bh')) { const b = bar('NIFTY'); if (b) { const px = P.slip('EQ', b.o, 'B'), qty = Math.floor((P.CAPITAL.EQ - 200) / px * 1000) / 1000; st.open.push({ id: 'nifty_bh:NIFTY:' + day, s: 'nifty_bh', sym: 'NIFTY', seg: 'EQ', b: 1, sig: day, d0: day, u0: b.o, px0: px, qty, q0: qty, stop: 0, stop0: 0, t1: 1e12, t2: 2e12, hold: 1e9, held: 0, risk: P.CAPITAL.EQ, block: px * qty, costs: P.orderCost('EQ', 'B', px * qty, day), mark: px, parts: [], bf: !!st.bfMode, fillDay: true, why: 'benchmark' }); st.acc.nifty_bh.costs += st.open[st.open.length - 1].costs; } }
  // 2) manage every open trade on today's bar
  for (const t of st.open.slice()) {
    const u = t.seg === 'OPT' ? t.opt.und : t.seg === 'IC' ? t.und : t.sym, b = bar(u); if (!b) continue;
    const nextExp = t.seg === 'OPT' && nextDay >= t.opt.exp;
    P.step(st, t, b, day, ctxF, nextExp);
  }
  // 3) equity curve
  st.hist.days.push(day);
  for (const s of P.STRATS) {
    const acc = st.acc[s.id]; let eq = P.capital(s.id) + acc.realised;
    for (const t of st.open) if (t.s === s.id) eq += P.unreal(t) - (t.entryCostCharged ? 0 : t.costs);
    (st.hist.eq[s.id] = st.hist.eq[s.id] || []).push(Math.round(eq));
  }
  // 4) today's signals → orders for the next session
  const busy = sid => new Set([...st.open.filter(t => t.s === sid).map(t => t.seg === 'OPT' ? t.opt.und : t.sym), ...st.pending.filter(o => o.s === sid).map(o => o.sym)]);
  const sigs = {}; const add = o => (sigs[o.s] = sigs[o.s] || []).push(o);
  const reg = M.regime(day), ctx = { regime: reg, news: 0 };
  for (const sym of M.stocks) {
    const X = M.X[sym], i = X && X.idx.get(day); if (i == null) continue;
    try { for (const o of P.eqSignals(X, i, ctx)) add(o); if (M.fo[sym]) for (const o of P.futSignals(X, i, ctx, M.fo[sym])) add(o); } catch (e) { M.err = (M.err || 0) + 1; }
  }
  for (const und of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
    const X = M.X[und], i = X && X.idx.get(day); if (i == null || i < 210) continue;
    const g = P.idxSignal(und, X.D, i, ctxF.vix(day, 'close')); if (!g) continue;
    M.idxSig[und] = g;
    if (g.side && g.L) {
      const exp = P.pickExpiry(und, nextDay, 2, M.holidays);
      for (const s of P.STRATS.filter(s => s.kind === 'idxopt')) {
        const k = s.pick === 'app' ? g.strikes[g.appPick] : g.strikes[s.pick];
        add({ s: s.id, sym: und, seg: 'OPT', b: g.dirN, type: 'open', entry: g.price, stop: g.L.stop, t1: g.L.t1, t2: g.L.t2, hold: s.hold, q: g.conv, sig: day, why: `${g.side} side rated ${g.conv} (call ${g.ce} / put ${g.pe})`, opt: { und, k, cp: g.side, exp, lot: P.IDX_LOT[und], pick: s.pick === 'app' ? g.appPick : s.pick } });
      }
    }
    if (und === 'NIFTY' && g.swingScore > 42 && g.swingScore < 58) {
      const exp = P.pickExpiry('NIFTY', nextDay, 2, M.holidays), n = P.tradingDaysBetween(nextDay, exp, M.holidays);
      if (n <= 6) add({ s: 'ic', sym: 'NIFTY', und: 'NIFTY', seg: 'IC', b: 0, type: 'open', entry: g.price, stop: 0, t1: 0, t2: 0, hold: 99, q: 50, sig: day, exp, width: 200, lot: P.IDX_LOT.NIFTY, why: `NIFTY swing score ${g.swingScore}: no trend → sell the range` });
    }
  }
  const take = (sid, list, max) => {
    const b = busy(sid), out = [];
    for (const o of list.sort((a, c) => c.q - a.q)) { if (out.length >= max) break; if (b.has(o.sym)) continue; if (sid === 'ic' && (st.open.some(t => t.s === 'ic') || st.pending.some(x => x.s === 'ic'))) break; b.add(o.sym); out.push(Object.assign({}, o, { s: sid, age: 0, src: o.s !== sid ? o.s : o.src || null })); }
    return out;
  };
  const newOrders = [];
  for (const s of P.STRATS) if (sigs[s.id]) newOrders.push(...take(s.id, sigs[s.id], P.MAX_NEW_PER_DAY[s.seg]));
  // the self-improving "best-of league": today's signals of the strategies promoted at the latest weekly review
  for (const [mid, seg] of [['meta_eq', 'EQ'], ['meta_fno', 'FNO']]) {
    const pr = P.promoted(st, seg); if (!pr.length) continue;
    const cand = []; pr.forEach((sid, rk) => (sigs[sid] || []).forEach(o => cand.push(Object.assign({}, o, { q: 1000 - rk * 100 + o.q, src: sid, hold: o.hold }))));
    newOrders.push(...take(mid, cand, P.MAX_NEW_PER_DAY[seg]));
  }
  st.pending.push(...newOrders);
  M.todaySigs = newOrders.length;
  // 5) weekly review on the last session of each week
  if (P.isoWeek(nextDay) !== P.isoWeek(day)) { const ch = P.review(st, day); if (ch.length) log(day, 'review:', ch.map(c => `${c.id} ${c.from}→${c.to}`).join(', ')); }
  st.lastDay = day;
  return opened;
}

// ---------- outputs ----------
const slimT = t => { const o = Object.assign({}, t); delete o.entryCostCharged; delete o.block; delete o.fillDay; delete o.openFill; if (o.mark != null) o.mark = Math.round(o.mark * 100) / 100; if (o.uMark != null) o.uMark = Math.round(o.uMark * 100) / 100; if (o.qty != null) o.qty = Math.round(o.qty * 1000) / 1000; return o; };
function writeOut(st, M) {
  fs.mkdirSync(OUT, { recursive: true });
  const day = st.lastDay, cut = P.addDays(day, -92);
  const rows = P.STRATS.map(s => {
    const tr = st.closed.filter(t => t.s === s.id), ser = st.hist.eq[s.id] || [], cap = P.capital(s.id);
    const all = P.stats(tr, ser, cap), live = P.stats(tr.filter(t => !t.bf), null, cap), bf = P.stats(tr.filter(t => t.bf), null, cap);
    const sx = st.status[s.id] || { st: s.kind === 'bench' ? 'Benchmark' : 'New', why: '' };
    const unreal = st.open.filter(t => t.s === s.id).reduce((a, t) => a + P.unreal(t), 0);
    return { id: s.id, seg: s.seg, kind: s.kind, name: s.name, short: s.short, rules: s.rules, cap, status: sx.st, statusWhy: sx.why, since: sx.since, score: all.score, stats: { all, live, bf }, eq: ser[ser.length - 1] || cap, unreal: Math.round(unreal), openN: st.open.filter(t => t.s === s.id).length, pendingN: st.pending.filter(o => o.s === s.id).length, cancelled: st.cancelled[s.id] || 0, skipped: st.why[s.id] || {} };
  });
  for (const seg of ['EQ', 'FNO']) { const rk = rows.filter(r => r.seg === seg && r.score != null && r.kind !== 'bench').sort((a, b) => b.score - a.score); rk.forEach((r, k) => r.rank = k + 1); }
  const leaders = { EQ: P.promoted(st, 'EQ'), FNO: P.promoted(st, 'FNO') };
  leaders.signals = st.pending.filter(o => leaders.EQ.includes(o.s) || leaders.FNO.includes(o.s)).map(o => ({ s: o.s, sym: o.sym, seg: o.seg, b: o.b, type: o.type, entry: o.entry, stop: o.stop, t1: o.t1, t2: o.t2, why: o.why, opt: o.opt || null }));
  leaders.setups = P.setupStats(st.closed);
  const idx = Object.fromEntries(Object.entries(M.idxSig).map(([k, g]) => [k, { day: g.day, price: Math.round(g.price * 100) / 100, ce: g.ce, pe: g.pe, side: g.side, swing: g.swingScore, vix: g.vix && Math.round(g.vix * 100) / 100 }]));
  const nowIST = new Date(Date.now() + 19800e3);
  const out = {
    v: 1, updated: new Date().toISOString(), updatedIST: nowIST.toISOString().slice(0, 16).replace('T', ' ') + ' IST', asOf: day, start: st.start, liveFrom: st.liveFrom, backfillUntil: st.bfUntil || null,
    source: 'GitHub Actions · Yahoo daily bars (after the close) · ' + M.univSrc + (M.foApprox ? ' · F&O lot sizes approximated' : ''), universe: M.stocks.length,
    capital: P.CAPITAL, futCapital: P.FUT_CAPITAL, risk: Object.assign({}, P.RISK, { FUT: P.FUT_RISK }), minTrades: P.MIN_TRADES, idxLot: P.IDX_LOT, vix: M.vixNow,
    strategies: rows, leaders, idx,
    open: st.open.map(slimT), pending: st.pending.map(o => { const x = Object.assign({}, o); delete x.age; return x; }),
    closed: st.closed.filter(t => t.d1 >= cut).map(slimT).reverse(),
    today: { day, opened: st.open.concat(st.closed).filter(t => t.d0 === day).map(t => t.id), closed: st.closed.filter(t => t.d1 === day).map(t => t.id), orders: st.pending.length },
    reviews: st.reviews.slice(-12).reverse(),
    notes: ['Paper trades only: no real orders. Fills use daily bars: next-open entries, stop-first when a day touches both stop and target, gaps through a stop fill at the open.',
      'F&O premiums are SIMULATED with Black-Scholes using India VIX (with a per-index multiplier and put skew). Real premiums, spreads and IV can differ a lot.',
      'Backfilled trades replay past sessions walk-forward (each signal uses only data up to that day), but the strategy rules and the rating model were designed with knowledge of that period. Treat them as a rough start; only live-forward results are a fair test.',
      'Costs include brokerage, STT, exchange, SEBI, stamp duty, GST and slippage. Past results do not guarantee future returns.'],
  };
  fs.writeFileSync(path.join(OUT, 'paper.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(OUT, 'paper_history.json'), JSON.stringify({ v: 1, days: st.hist.days, bfUntil: st.bfUntil || null, eq: st.hist.eq }));
  fs.writeFileSync(path.join(OUT, 'paper_state.json'), JSON.stringify(st));
  log('wrote', OUT, `· ${st.open.length} open · ${st.pending.length} orders · ${st.closed.length} closed`);
  return out;
}

// ---------- main ----------
(async () => {
  try { E.setModel(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'www', 'model.json'), 'utf8'))); } catch (e) { log('model.json not loaded:', e.message); }
  const U = await universe(); log('universe', U.syms.length, U.src);
  const idxY = { NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', SENSEX: '^BSESN' };
  const [vixD, ...idxD] = await Promise.all([yahoo('^INDIAVIX').catch(e => (log('VIX failed:', e.message), null)), ...Object.values(idxY).map(y => yahoo(y).catch(() => null))]);
  if (!idxD[0]) throw new Error('No NIFTY data from Yahoo: aborting without touching data/.');
  const X = {}; Object.keys(idxY).forEach((k, n) => { if (idxD[n]) X[k] = P.prep(k, idxD[n]); });
  let done = 0;
  await pool(U.syms, 8, async s => { const D = await yahoo(s + '.NS'); X[s] = P.prep(s, D); if (++done % 50 === 0) log('fetched', done); });
  const stocks = U.syms.filter(s => X[s] && X[s].D.c.length >= 250);
  // F&O lots: NSE file, else approximate (₹15 lakh minimum contract value, rounded to 25 shares)
  const fo = {}; for (const s of stocks) { if (U.fo[s]) fo[s] = U.fo[s]; else if (U.foApprox && [...TRAIN, ...TEST].includes(s)) { const px = X[s].D.c[X[s].D.c.length - 1]; fo[s] = Math.max(25, Math.round(1500000 / px / 25) * 25); } }
  log('stocks with data', stocks.length, '· F&O', Object.keys(fo).length);
  // trading calendar = NIFTY sessions; a weekday without a NIFTY bar in the past is a holiday
  const N = X.NIFTY.D; let days = N.day.slice();
  const istNow = new Date(Date.now() + 19800e3), todayIST = istNow.toISOString().slice(0, 10), minsIST = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  if (days[days.length - 1] === todayIST && minsIST < 15 * 60 + 45) { days.pop(); log('dropping today\'s unfinished bar'); }
  if (UNTIL) days = days.filter(d => d <= UNTIL);
  const holidays = new Set(); for (let k = 1; k < days.length; k++) { let d = P.addDays(days[k - 1], 1); while (d < days[k]) { if (P.dow(d) % 6) holidays.add(d); d = P.addDays(d, 1); } }
  const vixAt = (day, mom) => { if (!vixD) return 14; const i = vixD.day.indexOf(day); if (i >= 0) return mom === 'open' ? vixD.o[i] : vixD.c[i]; let k = vixD.day.length - 1; while (k > 0 && vixD.day[k] > day) k--; return vixD.c[k]; };
  // market regime like the app: Nifty's blended signal
  const regCache = {}, regime = day => { if (regCache[day] != null) return regCache[day]; const i = X.NIFTY.idx.get(day); if (i == null || i < 210) return 50; return (regCache[day] = P.ratings(X.NIFTY, i, {}).rating.signal); };
  const M = { X, stocks, fo, foApprox: U.foApprox, univSrc: U.src, holidays, idxSig: {}, regime, vixNow: vixD ? vixD.c[vixD.c.length - 1] : null,
    ctxF: { vix: vixAt, emaCrossDown: (sym, day) => { const x = X[sym], i = x && x.idx.get(day); return i > 0 && x.I.e20[i] < x.I.e50[i] && x.I.e20[i - 1] >= x.I.e50[i - 1]; } } };
  const nextOf = k => k + 1 < days.length ? days[k + 1] : P.nextTradingDay(days[k], holidays);
  const statePath = path.join(OUT, 'paper_state.json');
  let st = null; if (!BACKFILL) { try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) {} }
  if (!st || st.v !== 1) {
    const nb = BACKFILL || 120, k0 = Math.max(260, days.length - nb);
    if (k0 >= days.length) throw new Error('not enough history for a backfill');
    st = P.newState(days[k0]); st.bfMode = true; st.cancelled = {}; st.why = {};
    log(`backfill ${days.length - k0} sessions from ${days[k0]} (walk-forward)`);
    for (let k = k0; k < days.length; k++) { runDay(st, days[k], nextOf(k), M); if ((k - k0) % 20 === 0) log('  ', days[k], 'open', st.open.length, 'closed', st.closed.length); }
    st.bfMode = false; st.bfUntil = st.lastDay; st.liveFrom = nextOf(days.length - 1);
  } else {
    st.cancelled = st.cancelled || {}; st.why = st.why || {};
    const todo = days.map((d, k) => [d, k]).filter(([d]) => d > st.lastDay);
    if (!todo.length) log('no new session since', st.lastDay);
    for (const [d, k] of todo) { log('session', d); runDay(st, d, nextOf(k), M); }
  }
  if (M.err) log('signal errors (skipped):', M.err);
  writeOut(st, M);
})().catch(e => { console.error('paper run failed:', e && e.stack || e); process.exit(1); });
