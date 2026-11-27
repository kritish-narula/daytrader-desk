// Candlestick research (GitHub Actions, workflow_dispatch: .github/workflows/candles.yml; no broker credentials — Yahoo daily bars only).
//
// For each of the 38 patterns of E.candles (www/engine.js — the SAME detector the phone runs) on the Nifty 500 × ~5 years of daily bars
// (same universe + Yahoo cache as tools/research.js):
//  1. Outcomes after the signal bar i, direction-adjusted (bearish patterns = short), after costs:
//       cc1 = close → next close (entry at the close, BTST)     oc1 = next open → next close (entry at tomorrow's open)
//       gap = close → next open (sell into the opening gap)     cc5 = close → close 5 sessions later (swing)
//       hi1 = how far the next day ran in the pattern's favour (next high vs close for bullish, low for bearish) — reported, not a trade.
//     Costs: COST1 (0.25 % round trip) for 1-day trades, COST5 (0.30 %) for 5-day trades. Bars with a > 7-day hole or a > 40 % move
//     (unadjusted split / bad print) are dropped.
//  2. De-duplication: one signal per stock per pattern per max(pattern length, holding period) bars.
//  3. Baseline = the unconditional same-day average over ALL stocks in the universe (same metric, same direction, same cost): a pattern only
//     counts if it beats what any stock did on those same days.
//  4. Context (E.candleCtx, same as the phone): all · uptrend (close > 50 EMA > 200 EMA) · downtrend · above / below 200 EMA · at a 20-day
//     low / high · volume ≥ 1.5× 20-day average · Nifty above / below its 200 EMA.
//  5. Walk-forward by time, DISJOINT test folds, embargo EMB days before each test start:
//       F1 train < 60 % of days − EMB → test 60–80 %   ·   F2 train < 80 % − EMB → test last 20 %.
//     edge:true for a (pattern, context, metric) only if, in BOTH folds: train n ≥ MIN_N with avg > 0 and > baseline, AND test n ≥ MIN_N,
//     ≥ MIN_G distinct dates, avg after cost > 0, avg > same-day baseline, and the 95 % lower bound of the avg (date-clustered standard error —
//     many stocks print the same pattern on the same market day; 5-day blocks for cc5) above zero.
//  6. Trade levels for every edge (data, not folklore): stop ∈ {none, pattern low/high ∓ k·ATR (k 0 / 0.25 / 0.5), 1 ATR}, target ∈ {none,
//     1R, 1.5R, 2R, the 50th / 75th percentile of the favourable move reached (in ATRs, from TRAIN)}; entry / holding period from the metric
//     that proved the edge (gap = exit at the next open, no stop/target). Picked on TRAIN by after-cost average (n ≥ MIN_N), reported on TEST;
//     the stored rule = F2's pick (most recent train window); avgF1 = F1's own pick on F1's test (procedure check). Stop and target are
//     simulated on daily bars: gap through a level fills at the open; stop and target touched the same day = stop (conservative).
//  7. Writes data/candles_report.txt and merges `candles` into www/model.json (every other key kept; v + 1). Also writes the section to
//     CANDLES_SECTION so the workflow can re-merge it onto a newer model.json if a push races another job: --merge <file>.
//  8. Parity: E.candles + E.candleCtx on the truncated history (what the phone sees) == research detection on the full series, and
//     E.candleCall's trade levels == research's levels for sampled edge signals.
//
// env: RESEARCH_SYMS, UNIVERSE_MAX (as research.js), CONC (10), BUDGET_MIN (20: stop fetching new stocks), COST1 (0.25), COST5 (0.30),
//      CANDLE_MIN_N (30), CANDLE_MIN_G (10), EMB (10), RESEARCH_DRY=1 (no files), MODEL_PATH / REPORT_PATH / CANDLES_SECTION (testing), YF_CACHE.
// Dev run without Yahoo: YF_CACHE=/tmp/yfstub RESEARCH_SYMS=A,B,… RESEARCH_DRY=1 node -r ./tools/fno_stub.js tools/candles_research.js
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js');
const RS = require('./research.js');

const ENV = process.env, T0 = Date.now();
const COST1 = ENV.COST1 != null ? +ENV.COST1 : 0.25, COST5 = ENV.COST5 != null ? +ENV.COST5 : 0.30;
const CONC = +ENV.CONC || 10, BUDGET = (+ENV.BUDGET_MIN || 20) * 60e3, MIN_N = +ENV.CANDLE_MIN_N || 30, MIN_G = +ENV.CANDLE_MIN_G || 10, EMB = ENV.EMB != null ? +ENV.EMB : 10;
const START = 210, TICK = 0.05, Z95 = 1.959964, MAXMOVE = 40, HOLE = 7 * 86400;
const DRY = !!ENV.RESEARCH_DRY, FORCE = !!ENV.CANDLE_FORCE; // CANDLE_FORCE=1: testing only — any combo with enough test signals counts as an edge (exercises the trade / merge path on stub data)
const MODEL_PATH = ENV.MODEL_PATH || path.join(__dirname, '../www/model.json'), REPORT = ENV.REPORT_PATH || path.join(__dirname, '../data/candles_report.txt');
const SECTION = ENV.CANDLES_SECTION || path.join(require('os').tmpdir(), 'candles_section.json');
const ok = x => typeof x === 'number' && isFinite(x);
const LOG = []; const log = (...a) => { const s = a.join(' '); LOG.push(s); console.log(s); };
const f2 = x => ok(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '  n/a'; const pc = x => ok(x) ? Math.round(100 * x) + '%' : 'n/a';
const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
const r3 = x => ok(x) ? Math.round(x * 1000) / 1000 : null, r2 = x => ok(x) ? Math.round(x * 100) / 100 : null;
const DEFS = E.CANDLE_DEFS, CTX = E.CANDLE_CTX;
const MET = { cc1: { hold: 1, entry: 'close', exit: 'close', lbl: 'close→next close' }, oc1: { hold: 1, entry: 'nextOpen', exit: 'close', lbl: 'next open→close' },
  gap: { hold: 1, entry: 'close', exit: 'open', lbl: 'close→next open' }, cc5: { hold: 5, entry: 'close', exit: 'close', lbl: 'close→close, 5 days' } };
const MK = Object.keys(MET), costOf = m => MET[m].hold === 1 ? COST1 : COST5;

// ---------------- outcomes (long, raw %, NaN when not available / data error) ----------------
function holeAfter(S, i, k) { if (!S.t) return false; for (let j = i + 1; j <= i + k; j++) if (S.t[j] - S.t[j - 1] > HOLE) return true; return false; }
function raw(S, i, m) {
  const h = MET[m].hold; if (i + h >= S.n || holeAfter(S, i, h)) return NaN;
  const x = m === 'cc1' ? S.c[i + 1] / S.c[i] : m === 'oc1' ? S.c[i + 1] / S.o[i + 1] : m === 'gap' ? S.o[i + 1] / S.c[i] : S.c[i + 5] / S.c[i];
  const r = (x - 1) * 100; return ok(r) && Math.abs(r) <= MAXMOVE ? r : NaN;
}
function reach(S, i, b) { if (i + 1 >= S.n || holeAfter(S, i, 1)) return NaN; const r = b > 0 ? (S.h[i + 1] / S.c[i] - 1) * 100 : (1 - S.l[i + 1] / S.c[i]) * 100; return ok(r) && Math.abs(r) <= MAXMOVE ? r : NaN; }
// trade simulation of a rule on daily bars (direction b). Returns after-cost % or NaN (no entry / not enough bars).
function sim(S, e, spec) {
  const i = e.i, b = e.b, hold = spec.hold; if (i + hold >= S.n || holeAfter(S, i, hold)) return NaN;
  const cost = hold === 1 ? COST1 : COST5, E0 = spec.entry === 'close' ? S.c[i] : S.o[i + 1];
  if (!(E0 > 0)) return NaN;
  if (spec.exit === 'open') { const r = b * (S.o[i + 1] / E0 - 1) * 100; return Math.abs(r) <= MAXMOVE ? r - cost : NaN; }
  const lv = E.candleLevels(spec, b, E0, e, S.A[i]), st = lv.stop, tg = lv.target;
  if (st != null && !(b * (E0 - st) > 0)) return NaN; // opened through the stop: no entry
  let px = NaN;
  for (let j = i + 1; j <= i + hold && !ok(px); j++) {
    const open = !(spec.entry === 'nextOpen' && j === i + 1);
    if (open && st != null && b * (S.o[j] - st) <= 0) px = S.o[j];
    else if (open && tg != null && b * (S.o[j] - tg) >= 0) px = S.o[j];
    else if (st != null && b * ((b > 0 ? S.l[j] : S.h[j]) - st) <= 0) px = st;
    else if (tg != null && b * ((b > 0 ? S.h[j] : S.l[j]) - tg) >= 0) px = tg;
  }
  if (!ok(px)) px = S.c[i + hold];
  const r = b * (px / E0 - 1) * 100; return Math.abs(r) <= MAXMOVE ? r - cost : NaN;
}
// favourable move reached during the hold, in ATRs (for percentile targets)
function mfe(S, e, spec) {
  const i = e.i, b = e.b; if (i + spec.hold >= S.n) return NaN; const E0 = spec.entry === 'close' ? S.c[i] : S.o[i + 1]; let m = b > 0 ? -Infinity : Infinity;
  for (let j = i + 1; j <= i + spec.hold; j++) m = b > 0 ? Math.max(m, S.h[j]) : Math.min(m, S.l[j]); return b * (m - E0) / S.A[i];
}

// ---------------- statistics ----------------
const quant = (s, q) => RS.quantile(s, q);
// mean, win, median, worst 5 %, same-day baseline, excess, 95 % lower bounds with date-clustered SE (max of iid and cluster SE)
function stats(v, base, cl) {
  const n = v.length; if (!n) return { n: 0, G: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / n, bm = base.reduce((a, b) => a + b, 0) / n, s = v.slice().sort((a, b) => a - b);
  const lb = (x, mu) => { const S = new Map(); let ss = 0; for (let k = 0; k < n; k++) { const d = x[k] - mu; ss += d * d; S.set(cl[k], (S.get(cl[k]) || 0) + d); }
    const G = S.size; let V = 0; for (const y of S.values()) V += y * y; const seI = n > 1 ? Math.sqrt(ss / (n - 1) / n) : Infinity, seC = G >= 2 ? Math.sqrt(V * G / (G - 1)) / n : seI;
    return { lo: mu - Z95 * Math.max(seI, seC), G }; };
  const ex = v.map((x, k) => x - base[k]), L = lb(v, mean), LX = lb(ex, mean - bm);
  return { n, G: L.G, avg: mean, base: bm, ex: mean - bm, win: v.filter(x => x > 0).length / n, med: quant(s, 0.5), p5: quant(s, 0.05), lo: L.lo, exLo: LX.lo };
}
function dedup(evs, W) { const last = new Map(), out = []; for (const e of evs) { const l = last.get(e.s); if (l == null || e.i >= l + W) { out.push(e); last.set(e.s, e.i); } } return out; }

// ---------------- data ----------------
async function collect() {
  const U0 = RS.universe(), syms = U0.syms, idx = await RS.getDaily('^NSEI');
  const dk = t => Math.floor((t + 19800) / 86400);
  let grid = idx ? idx.t.map(dk) : null;
  const above = new Map(); // Nifty above its own 200 EMA, by IST day (what E.above200 computes on the phone)
  if (idx) { const M = E.alignMarket(idx, idx); for (let j = 0; j < idx.c.length; j++) if (ok(M.e200[j])) above.set(dk(idx.t[j]), idx.c[j] > M.e200[j]); }
  if (!grid) { const S = new Set(); for (const s of syms.slice(0, 20)) { const D = await RS.getDaily(s); if (D) D.t.forEach(t => S.add(dk(t))); } grid = [...S].sort((a, b) => a - b); }
  const gidx = new Map(grid.map((d, k) => [d, k])), G = grid.length;
  const base = {}; for (const m of [...MK, 'hiL', 'hiS']) base[m] = { s: new Float64Array(G), n: new Uint32Array(G) };
  const stocks = [], events = []; let skipped = 0, budgetHit = false, bars = 0, skipIll = 0;
  await RS.pool(syms, CONC, async (sym) => {
    if (Date.now() - T0 > BUDGET) { budgetHit = true; return; }
    const D = await RS.getDaily(sym); if (!D || !D.c || D.c.length < 300) { skipped++; return; }
    const I = E.indicators(D), n = D.c.length, si = stocks.length;
    const S = { sym, n, t: Float64Array.from(D.t), o: Float64Array.from(D.o), h: Float64Array.from(D.h), l: Float64Array.from(D.l), c: Float64Array.from(D.c), v: Float64Array.from(D.v, x => ok(x) ? x : NaN), A: new Float64Array(n), g: new Int32Array(n).fill(-1) };
    for (let i = 0; i < n; i++) { S.A[i] = E._atrAt(I, i, D.c[i]); const g = gidx.get(dk(D.t[i])); if (g != null) S.g[i] = g; }
    stocks.push(S);
    for (let i = START; i < n - 1; i++) {
      const g = S.g[i]; if (g < 0) continue; bars++;
      for (const m of MK) { const r = raw(S, i, m); if (ok(r)) { base[m].s[g] += r; base[m].n[g]++; } }
      const rl = reach(S, i, 1), rs = reach(S, i, -1); if (ok(rl)) { base.hiL.s[g] += rl; base.hiL.n[g]++; } if (ok(rs)) { base.hiS.s[g] += rs; base.hiS.n[g]++; }
      const P = E.candles(D, i, I, { tick: TICK }); if (P.skip === 'illiquid') skipIll++;
      if (!P.length) continue;
      const mk = above.get(dk(D.t[i]));
      for (const p of P) events.push({ s: si, i, d: g, p: DEFS.findIndex(x => x.k === p.k), b: p.b, len: p.len, lo: p.lo, hi: p.hi, cx: E.candleCtxBits(E.candleCtx(D, I, i, p, mk)) });
    }
  });
  const dayMean = {}; for (const m in base) dayMean[m] = Float64Array.from(base[m].s, (x, g) => base[m].n[g] >= 20 ? x / base[m].n[g] : NaN);
  return { U0, idx, grid, above, stocks, events, dayMean, skipped, budgetHit, bars, skipIll, want: syms.length };
}

// ---------------- main ----------------
const STOPS = [{ type: 'none' }, { type: 'pat', k: 0 }, { type: 'pat', k: 0.25 }, { type: 'pat', k: 0.5 }, { type: 'atr', k: 1 }];
const TGTS = [{ type: 'none' }, { type: 'R', k: 1 }, { type: 'R', k: 1.5 }, { type: 'R', k: 2 }, { type: 'atr', q: 50 }, { type: 'atr', q: 75 }];
const specTxt = sp => sp.exit === 'open' ? 'sell at next open' : `stop ${sp.stop.type === 'none' ? 'none' : sp.stop.type === 'pat' ? `pattern low/high ∓ ${sp.stop.k}·ATR` : sp.stop.k + ' ATR'} · target ${sp.target.type === 'none' ? 'none (time exit)' : sp.target.type === 'R' ? sp.target.k + 'R' : `${sp.target.k} ATR (p${sp.target.q} of move reached)`}`;

async function main() {
  if (process.argv[2] === '--merge') return mergeSection(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
  let model = {}; try { model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); } catch (e) {}
  log(`DayTrader Desk — candlestick research (38 patterns) · ${new Date().toISOString().slice(0, 16)}Z · model.json v${model.v || 0}`);
  log('Honest-numbers note: BACKTEST on historical daily bars (walk-forward, out of sample where marked "test"), not live results.');
  const C = await collect(), { stocks, events, dayMean } = C;
  log(`Universe: ${C.U0.src} · ${stocks.length}/${C.want} stocks (${C.skipped} skipped: < 300 bars or fetch failed${C.budgetHit ? '; time budget hit' : ''}) · Nifty ${C.idx ? 'ok' : 'UNAVAILABLE (no market-regime context)'}`);
  log(`Stock-days scanned: ${C.bars} (from bar ${START}: EMA200 context ready) · illiquid/frozen bars skipped by the detector: ${C.skipIll} · pattern signals (before de-dup): ${events.length}`);
  log(`Costs: ${COST1}% round trip for 1-day trades, ${COST5}% for 5-day trades · bearish patterns measured as SHORT trades (in India: F&O or intraday only)`);
  const days = [...new Set(events.map(e => e.d))].sort((a, b) => a - b);
  if (stocks.length < 3 || days.length < 100) { log('Not enough data — nothing written.'); return writeReport(); }
  // folds on the trading-day grid of all scanned days
  const allDays = []; { const S = new Set(); for (const s of stocks) for (let i = START; i < s.n - 1; i++) if (s.g[i] >= 0) S.add(s.g[i]); allDays.push(...[...S].sort((a, b) => a - b)); }
  const nd = allDays.length, c60 = allDays[Math.floor(nd * 0.6)], c80 = allDays[Math.floor(nd * 0.8)];
  const fd = g => { const d = C.grid[g]; return d != null ? new Date(d * 86400e3).toISOString().slice(0, 10) : '?'; };
  const FOLDS = { F1: { tr: d => d < c60 - EMB, te: d => d >= c60 && d < c80 }, F2: { tr: d => d < c80 - EMB, te: d => d >= c80 } };
  log(`Folds (embargo ${EMB} trading days, disjoint tests): F1 train ${fd(allDays[0])} … < ${fd(c60 - EMB)} → test ${fd(c60)} … < ${fd(c80)} · F2 train … < ${fd(c80 - EMB)} → test ${fd(c80)} … ${fd(allDays[nd - 1])}`);
  // unconditional baseline (all stock-days)
  const bl = {}; for (const m of MK) { let s = 0, k = 0; for (const s0 of stocks) for (let i = START; i < s0.n - 1; i++) { const r = raw(s0, i, m); if (ok(r)) { s += r; k++; } } bl[m] = k ? s / k : NaN; }
  log(`Unconditional baseline (every stock-day, long, before cost): cc1 ${f2(bl.cc1)}% · oc1 ${f2(bl.oc1)}% · gap ${f2(bl.gap)}% · cc5 ${f2(bl.cc5)}%  → after cost long cc1 ${f2(bl.cc1 - COST1)}%, cc5 ${f2(bl.cc5 - COST5)}%`);

  const byPat = DEFS.map(() => []); for (const e of events) byPat[e.p].push(e); for (const a of byPat) a.sort((x, y) => x.s - y.s || x.i - y.i);
  const val = (e, m) => { const r = raw(stocks[e.s], e.i, m); return ok(r) ? e.b * r - costOf(m) : NaN; };
  const bse = (e, m) => { const x = dayMean[m][e.d]; return ok(x) ? e.b * x - costOf(m) : NaN; };
  const clu = (e, m) => MET[m].hold === 1 ? e.d : Math.floor(e.d / 5);
  const ST = (evs, m, fn) => { const v = [], b = [], c = []; for (const e of evs) { const x = fn ? fn(e) : val(e, m), y = bse(e, m); if (ok(x) && ok(y)) { v.push(x); b.push(y); c.push(clu(e, m)); } } return stats(v, b, c); };
  const sub = (evs, ctx, m, f, part) => { const bit = 1 << CTX.indexOf(ctx); return dedup(evs.filter(e => (e.cx & bit) && (!f || FOLDS[f][part](e.d))), Math.max(DEFS[evs.length ? evs[0].p : 0].len, MET[m].hold)); };

  // ---- overall table (in-sample, all data, any context) ----
  log(`\n==================== ALL SIGNALS (any context, all 5 years, in-sample description; after cost; bearish = short) ====================`);
  log(`${pad('pattern', 30)} ${lp('dir', 3)} ${lp('n', 6)} ${lp('days', 5)} | next day close→close: ${lp('win', 4)} ${lp('avg', 6)} ${lp('med', 6)} ${lp('worst5%', 8)} ${lp('base', 6)} | ${lp('oc1', 6)} ${lp('gap', 6)} ${lp('reach', 6)} ${lp('vs', 6)} | 5d: ${lp('win', 4)} ${lp('avg', 6)} ${lp('base', 6)}`);
  const sec = { v: 1, date: new Date().toISOString().slice(0, 10), stocks: stocks.length, from: fd(allDays[0]), to: fd(allDays[nd - 1]), cost: { d1: COST1, d5: COST5 }, minN: MIN_N,
    folds: { F1: { trainTo: fd(c60 - EMB), test: [fd(c60), fd(c80)] }, F2: { trainTo: fd(c80 - EMB), test: [fd(c80), fd(allDays[nd - 1])] } }, tests: 0, pats: {} };
  for (const [pi, d] of DEFS.entries()) {
    const ev = byPat[pi], e1 = sub(ev, 'all', 'cc1'), e5 = sub(ev, 'all', 'cc5');
    const s1 = ST(e1, 'cc1'), so = ST(e1, 'oc1'), sg = ST(e1, 'gap'), s5 = ST(e5, 'cc5');
    const rch = e1.map(e => reach(stocks[e.s], e.i, e.b)).filter(ok).sort((a, b) => a - b), rb = e1.map(e => dayMean[e.b > 0 ? 'hiL' : 'hiS'][e.d]).filter(ok).sort((a, b) => a - b);
    sec.pats[d.k] = { b: d.b, seen: { n: s1.n, days: s1.G, win: r3(s1.win), avg: r2(s1.avg), med: r2(s1.med), p5: r2(s1.p5), base: r2(s1.base), oc1: r2(so.avg), gap: r2(sg.avg), reach: r2(quant(rch, 0.5)), reachBase: r2(quant(rb, 0.5)), win5: r3(s5.win), avg5: r2(s5.avg), base5: r2(s5.base), n5: s5.n, insample: true }, edges: [] };
    log(`${pad(d.n, 30)} ${lp(d.b > 0 ? '▲' : '▼', 3)} ${lp(s1.n, 6)} ${lp(s1.G || 0, 5)} | ${' '.repeat(22)}${lp(pc(s1.win), 4)} ${lp(f2(s1.avg), 6)} ${lp(f2(s1.med), 6)} ${lp(f2(s1.p5), 8)} ${lp(f2(s1.base), 6)} | ${lp(f2(so.avg), 6)} ${lp(f2(sg.avg), 6)} ${lp(f2(quant(rch, 0.5)), 6)} ${lp(f2(quant(rb, 0.5)), 6)} | ${' '.repeat(4)}${lp(pc(s5.win), 4)} ${lp(f2(s5.avg), 6)} ${lp(f2(s5.base), 6)}`);
  }
  log(`(reach = median % the next day moved in the pattern's direction from the close (high for ▲, low for ▼); vs = the same for all stocks on those days)`);

  // ---- context × metric × fold ----
  log(`\n==================== BY CONTEXT (walk-forward TEST folds; avg after cost vs same-day baseline; * = edge) ====================`);
  log(`${pad('pattern', 30)} ${pad('context', 7)} ${pad('metric', 6)} | F1 test: ${lp('n', 5)} ${lp('win', 4)} ${lp('avg', 6)} ${lp('base', 6)} ${lp('lo95', 6)} | F2 test: ${lp('n', 5)} ${lp('win', 4)} ${lp('avg', 6)} ${lp('base', 6)} ${lp('lo95', 6)} | train F1/F2 avg`);
  const EDGES = [];
  for (const [pi, d] of DEFS.entries()) {
    const ev = byPat[pi]; if (!ev.length) continue;
    for (const ctx of CTX) for (const m of MK) {
      sec.tests++;
      const R = {}; let pass = true;
      for (const f of ['F1', 'F2']) {
        const tr = ST(sub(ev, ctx, m, f, 'tr'), m), te = ST(sub(ev, ctx, m, f, 'te'), m); R[f] = { tr, te };
        const okTr = tr.n >= MIN_N && tr.avg > 0 && tr.ex > 0, okTe = te.n >= MIN_N && te.G >= MIN_G && te.avg > 0 && te.ex > 0 && te.lo > 0;
        if (!(okTr && okTe) && !(FORCE && tr.n >= MIN_N && te.n >= MIN_N)) pass = false;
      }
      if (R.F1.te.n < 10 && R.F2.te.n < 10) continue; // too rare to print
      const q = s => `${lp(s.n, 5)} ${lp(pc(s.win), 4)} ${lp(f2(s.avg), 6)} ${lp(f2(s.base), 6)} ${lp(f2(s.lo), 6)}`;
      if (ctx === 'all' || pass || (R.F1.te.n >= MIN_N && R.F2.te.n >= MIN_N && m === 'cc1'))
        log(`${pad(d.n, 30)} ${pad(ctx, 7)} ${pad(m, 6)} | ${' '.repeat(9)}${q(R.F1.te)} | ${' '.repeat(9)}${q(R.F2.te)} | ${f2(R.F1.tr.avg)} / ${f2(R.F2.tr.avg)}${pass ? '  *' : ''}`);
      if (pass) EDGES.push({ pi, d, ctx, m, R });
    }
  }
  if (FORCE) { sec.forced = true; log('CANDLE_FORCE: edges FORCED (testing only — not a real result)'); }
  log(`Tests run: ${sec.tests} (pattern × context × metric). Edge = both folds pass (train sign + test n ≥ ${MIN_N}, ≥ ${MIN_G} dates, avg > 0, avg > baseline, date-clustered 95% lower bound > 0).`);
  log(`Multiple-testing note: with ${sec.tests} tests, a few chance passes in ONE fold are expected; requiring train + both disjoint test folds keeps the expected number of false edges well below 1 if folds were independent — still treat single edges with care.`);

  // ---- trade levels for edges ----
  log(`\n==================== TRADES (edges only: stop / target picked on TRAIN by after-cost avg, reported on TEST) ====================`);
  for (const X of EDGES) {
    const ev = byPat[X.pi], M = MET[X.m], picks = {};
    for (const f of ['F1', 'F2']) {
      const tr = sub(ev, X.ctx, X.m, f, 'tr'), te = sub(ev, X.ctx, X.m, f, 'te');
      let grid;
      if (M.exit === 'open') grid = [{ entry: 'close', hold: 1, exit: 'open', stop: { type: 'none' }, target: { type: 'none' } }];
      else {
        const mf = tr.map(e => mfe(stocks[e.s], e, M)).filter(ok).sort((a, b) => a - b);
        grid = [];
        for (const st of STOPS) for (const tg of TGTS) {
          if (tg.type === 'R' && st.type === 'none') continue;
          const tgt = tg.type === 'atr' ? { type: 'atr', k: r2(Math.max(0.1, quant(mf, tg.q / 100))), q: tg.q } : Object.assign({}, tg);
          if (tg.type === 'atr' && !ok(tgt.k)) continue;
          grid.push({ entry: M.entry, hold: M.hold, exit: 'close', stop: Object.assign({}, st), target: tgt });
        }
      }
      let best = null;
      for (const sp of grid) { const s = ST(tr, X.m, e => sim(stocks[e.s], e, sp)); if (s.n >= MIN_N && (!best || s.avg > best.s.avg)) best = { sp, s }; }
      if (!best) { picks[f] = null; continue; }
      picks[f] = { sp: best.sp, tr: best.s, te: ST(te, X.m, e => sim(stocks[e.s], e, best.sp)) };
    }
    const P2 = picks.F2, P1 = picks.F1;
    log(`${pad(X.d.n, 30)} when ${pad(X.ctx, 6)} ${pad(X.m, 4)} (${M.lbl}) · raw edge test avg F1 ${f2(X.R.F1.te.avg)}% / F2 ${f2(X.R.F2.te.avg)}% (base ${f2(X.R.F1.te.base)} / ${f2(X.R.F2.te.base)})`);
    if (!P2) { log('   no stop/target rule reached n ≥ ' + MIN_N + ' on train — not stored'); continue; }
    log(`   F2 pick: ${specTxt(P2.sp)} · train avg ${f2(P2.tr.avg)}% (n ${P2.tr.n}) → TEST n ${P2.te.n} win ${pc(P2.te.win)} avg ${f2(P2.te.avg)}% med ${f2(P2.te.med)}% worst5% ${f2(P2.te.p5)}% lo95 ${f2(P2.te.lo)}%`);
    if (P1) log(`   F1 pick: ${specTxt(P1.sp)} · TEST n ${P1.te.n} win ${pc(P1.te.win)} avg ${f2(P1.te.avg)}%`);
    const trade = Object.assign({}, P2.sp, { winTest: r3(P2.te.win), avgTest: r2(P2.te.avg), medTest: r2(P2.te.med), p5Test: r2(P2.te.p5), loTest: r2(P2.te.lo), n: P2.te.n,
      avgF1: P1 ? r2(P1.te.avg) : null, winF1: P1 ? r3(P1.te.win) : null, nF1: P1 ? P1.te.n : null, trainAvg: r2(P2.tr.avg), trainN: P2.tr.n });
    if (!(P2.te.n > 0 && ok(trade.avgTest) && ok(trade.winTest))) continue;
    const pub = s => ({ n: s.n, G: s.G, win: r3(s.win), avg: r2(s.avg), med: r2(s.med), p5: r2(s.p5), base: r2(s.base), lo: r2(s.lo) });
    sec.pats[X.d.k].edges.push({ ctx: X.ctx, m: X.m, F1: pub(X.R.F1.te), F2: pub(X.R.F2.te), trade });
  }
  for (const k in sec.pats) { const P = sec.pats[k]; P.edges.sort((a, b) => b.trade.avgTest - a.trade.avgTest); P.edges = P.edges.slice(0, 5); P.edge = P.edges.some(e => e.trade.avgTest > 0 && (e.trade.avgF1 == null || e.trade.avgF1 > 0)); }

  // ---- parity ----
  parity(C, sec);

  // ---- decision ----
  log(`\n==================== DECISION ====================`);
  const proven = Object.entries(sec.pats).filter(([, P]) => P.edge);
  if (!proven.length) log('No pattern (in any context) beat the same-day baseline after costs in BOTH test folds — the app lists candles as "seen, no proven edge" and suggests no candle trades.');
  for (const [k, P] of proven) { const e = P.edges.find(x => x.trade.avgTest > 0 && (x.trade.avgF1 == null || x.trade.avgF1 > 0)); log(`${pad(E.CANDLE_BY[k].n, 30)} TRADE when ${E.CANDLE_CTX_LBL[e.ctx]} · ${MET[e.m].lbl} · ${specTxt(e.trade)} · test avg ${f2(e.trade.avgTest)}% win ${pc(e.trade.winTest)} n ${e.trade.n} (F1 ${f2(e.trade.avgF1)}%)`); }
  log(`Patterns never seen in the data: ${DEFS.filter(d => !sec.pats[d.k].seen.n).map(d => d.n).join(', ') || 'none'}`);
  log(`runtime ${((Date.now() - T0) / 60e3).toFixed(1)} min · memory ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB rss`);
  if (DRY) { log('RESEARCH_DRY: nothing written.'); return; }
  fs.writeFileSync(SECTION, JSON.stringify(sec));
  mergeSection(sec);
  writeReport();
}

// research detection vs the phone path (truncated history, own indicators); E.candleCall trade levels vs research levels
function parity(C, sec) {
  const { stocks, events, above } = C; let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dk = t => Math.floor((t + 19800) / 86400), cut = (a, i) => Array.from(a.subarray(0, i + 1));
  const toD = (S, i) => ({ t: cut(S.t, i), o: cut(S.o, i), h: cut(S.h, i), l: cut(S.l, i), c: cut(S.c, i), v: cut(S.v, i) });
  const sample = []; for (let k = 0; k < 150 && events.length; k++) sample.push(events[Math.floor(rnd() * events.length)]);
  for (let k = 0; k < 150; k++) { const s = Math.floor(rnd() * stocks.length), S = stocks[s]; const i = START + Math.floor(rnd() * Math.max(1, S.n - START - 1)); sample.push({ s, i, bare: true }); }
  let mis = 0, nb = 0; const bad = []; C.parityMis = 0;
  for (const e of sample) {
    const S = stocks[e.s]; if (e.i >= S.n) continue; nb++;
    const Dt = toD(S, e.i), It = E.indicators(Dt), P = E.candles(Dt, e.i, It, { tick: TICK });
    const want = events.filter(x => x.s === e.s && x.i === e.i).map(x => DEFS[x.p].k + ':' + x.cx).sort().join(',');
    const got = P.map(p => p.k + ':' + (E.candleCtxBits(E.candleCtx(Dt, It, e.i, p, above.get(dk(S.t[e.i])))))).sort().join(',');
    if (want !== got) { mis++; if (bad.length < 5) bad.push(`${S.sym}@${e.i}: research [${want}] vs phone [${got}]`); }
  }
  C.parityMis += mis;
  log(`\nParity (E.candles + E.candleCtx on the truncated history = what the phone sees, vs research on the full series): ${nb} bars, ${mis ? mis + ' MISMATCHES: ' + bad.join(' | ') : 'all match'}`);
  // trade levels: E.candleCall with this run's section loaded
  const saved = E.MODEL; let n2 = 0, m2 = 0;
  try {
    E.setModel(Object.assign({}, saved, { v: saved.v || 1, candles: sec }));
    const edgeK = new Set(Object.entries(sec.pats).filter(([, P]) => P.edge).map(([k]) => k));
    const evs = events.filter(e => edgeK.has(DEFS[e.p].k)); for (let k = 0; k < 3000 && n2 < 60 && evs.length; k++) {
      const e = evs[Math.floor(rnd() * evs.length)], S = stocks[e.s], Dt = toD(S, e.i);
      const it = E.candleCall(Dt, e.i, null, { niftyAbove200: above.get(dk(S.t[e.i])) }).items.find(x => x.k === DEFS[e.p].k && x.trade); if (!it) continue; n2++;
      const r = sec.pats[it.k].edges.find(x => x.ctx === it.rule.ctx && x.m === it.rule.m), lv = E.candleLevels(r.trade, e.b, S.c[e.i], e, S.A[e.i]), R = x => x == null ? null : +(Math.round(x / TICK) * TICK).toFixed(2);
      if (it.trade.entry !== R(S.c[e.i]) || it.trade.stop !== R(lv.stop) || it.trade.target !== R(lv.target)) m2++;
    }
  } finally { E.MODEL = saved; }
  C.parityMis += m2;
  log(`Trade-level parity (E.candleCall vs research levels on sampled edge signals): ${n2} signals, ${m2 ? m2 + ' MISMATCHES' : 'all match'}`);
}

function mergeSection(sec) {
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); } catch (e) {}
  const out = Object.assign({}, cur, { candles: sec, v: (cur.v || 0) + 1, date: new Date().toISOString().slice(0, 10) });
  const keep = E.MODEL; if (!E.setModel(out) || !E.MODEL.candles) throw new Error('candles section failed engine validation — not written'); E.MODEL = keep;
  fs.writeFileSync(MODEL_PATH, JSON.stringify(out, null, 1));
  const note = `Merged candles into ${path.relative(path.join(__dirname, '..'), MODEL_PATH)} → v${out.v} (other sections kept: ${Object.keys(cur).filter(k => k !== 'candles').join(', ') || 'none'})`;
  if (process.argv[2] === '--merge') console.log(note); else log(note);
}
function writeReport() { if (DRY) return; fs.mkdirSync(path.dirname(REPORT), { recursive: true }); fs.writeFileSync(REPORT, LOG.join('\n') + '\n'); }

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { stats, dedup, sim, raw, mfe, MET };
