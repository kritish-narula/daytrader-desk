#!/usr/bin/env node
/* F&O research (GitHub Actions, weekly): walk-forward tuning of every F&O parameter of the app, on 5 years of Yahoo daily data.
     node tools/fno_research.js [--out data/] [--limit 150] [--quick] [--indices NIFTY,BANKNIFTY,SENSEX]
   Method: the last ~5 years of daily bars are split TRAIN (first 60%, ≈ years 1-3) / TEST (last 40%, ≈ years 4-5). Parameters are searched on
   TRAIN only (coordinate ascent on the t-statistic of the net R multiple per trade), then each changed parameter is adopted only if it
   ALSO improves the net expectancy on TEST versus today's default (forward selection, n ≥ 20 trades and ≥ 35% of the default's trade count).
   Everything about option prices is SIMULATED (Black-Scholes on India VIX, real expiry calendar, real cost schedule incl. STT 0.15% from
   1-Apr-2026, slippage): it ranks rules, it is NOT live P&L. Writes data/fno_params.json (the app reads it) and data/fno_report.txt. */
'use strict';
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js'), P = require('../www/paper.js'), S = require('./fno_sim.js');
const { TRAIN: U1, TEST: U2 } = require('./universe.js');

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(__dirname, '..', 'data')));
const QUICK = args.includes('--quick'), LIMIT = +arg('--limit', 0) || (QUICK ? 40 : 150);
const WANT = (arg('--indices', 'NIFTY,BANKNIFTY,SENSEX')).split(',').filter(Boolean);
const CACHE = process.env.FNO_CACHE || '/tmp/fnocache';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const f1 = (x, d = 1) => x == null || !isFinite(x) ? '–' : x.toFixed(d), sg = (x, d = 2) => x == null || !isFinite(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(d);
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);

// ---------------------------------------------------------------------------------------------------------------- data
async function yahoo(ysym) {
  const f = `${CACHE}/${ysym.replace(/[^A-Za-z0-9]/g, '_')}.json`;
  try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (Date.now() - c.at < 12 * 3600e3) return c.D; } catch (e) {}
  let err;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?range=7y&interval=1d&includePrePost=false`, { headers: { 'User-Agent': UA } });
      const R = (await r.json()).chart.result[0], q = R.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
      R.timestamp.forEach((t, i) => {
        if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null || !(x > 0))) return;
        const day = new Date((t + 19800) * 1000).toISOString().slice(0, 10);
        if (D.day.length && D.day[D.day.length - 1] === day) { const n = D.c.length - 1; D.h[n] = Math.max(D.h[n], q.high[i]); D.l[n] = Math.min(D.l[n], q.low[i]); D.c[n] = q.close[i]; D.v[n] += q.volume[i] || 0; return; }
        D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); D.day.push(day);
      });
      if (D.c.length < 300) throw new Error('short series ' + D.c.length);
      try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: Date.now(), D })); } catch (e) {}
      return D;
    } catch (e) { err = e; await sleep(600 * (k + 1)); }
  }
  throw err;
}
async function pool(items, n, fn) { let i = 0; const out = []; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } })); return out; }

// ---------------------------------------------------------------------------------------------------------------- index preparation
const dowOf = day => new Date(day + 'T00:00:00Z').getUTCDay();
function prepIndex(und, D, vixD) {
  const n = D.c.length, I = E.indicators(D), X = P.prep(und, D), ctx = { regime: 50, news: 0, canShort: true };
  // India VIX aligned to the index's trading days (forward-filled); fallback = 20-day realised vol × 1.1 when ^INDIAVIX is missing
  const vm = new Map(); if (vixD) vixD.day.forEach((d, k) => vm.set(d, vixD.c[k]));
  const vix = new Array(n).fill(NaN); let last = NaN, first = null;
  for (let i = 0; i < n; i++) { const v = vm.get(D.day[i]); if (v > 0) { last = v; if (first == null) first = v; } vix[i] = last; }
  for (let i = 0; i < n && !(vix[i] > 0); i++) vix[i] = first;
  let vixSrc = vixD ? '^INDIAVIX' : 'HV20×1.1 (no VIX data)';
  if (!vixD) for (let i = 21; i < n; i++) { const r = []; for (let j = i - 19; j <= i; j++) r.push(Math.log(D.c[j] / D.c[j - 1])); const m = S.mean(r); vix[i] = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / 19 * 252) * 110; if (i === 21) for (let j = 0; j < 21; j++) vix[j] = vix[21]; }
  const vixPct = vix.map((v, i) => { if (i < 60) return 50; let c = 0, m = 0; for (let j = Math.max(0, i - 251); j <= i; j++) { m++; if (vix[j] <= v) c++; } return c / m * 100; });
  const T = { n, sI: new Array(n).fill(NaN), rS: new Array(n).fill(NaN), rSh: new Array(n).fill(NaN), c: D.c, o: D.o, e20: I.e20, e50: I.e50, e200: I.e200, adx: I.adx, vix, vixPct, ret1: new Array(n).fill(0), sig20: new Array(n).fill(0.01), dow: D.day.map(dowOf) };
  for (let i = 1; i < n; i++) T.ret1[i] = Math.log(D.c[i] / D.c[i - 1]);
  for (let i = 21; i < n; i++) { const r = T.ret1.slice(i - 19, i + 1), m = S.mean(r); T.sig20[i] = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / 19) || 0.01; }
  const evalStart = Math.max(262, n - 1262); T.evalStart = evalStart;
  const clampA = x => Math.max(-1, Math.min(1, x));
  for (let i = evalStart - 2; i < n - 1; i++) {
    // intraday component when the market is closed = the app's "no 5-minute bars" branch: daily-trend factor + close position + day change + volume
    const cb = E._combine(E._factors(I, i, 'swing')), rg = D.h[i] - D.l[i], chg = (D.c[i] / D.c[i - 1] - 1) * 100, vx = I.v20[i - 1] ? D.v[i] / I.v20[i - 1] : NaN;
    const f = [[1, clampA(cb)], [2, rg > 0 ? clampA(2 * (D.c[i] - D.l[i]) / rg - 1) : NaN], [1.5, clampA(chg / 2)]].filter(x => isFinite(x[1]));
    if (isFinite(vx) && vx > 0) f.push([1, clampA((vx - 1) * Math.sign(chg))]);
    T.sI[i] = E.hzRating({ score: E._toScore(E._combine(f)) }, 'intraday', ctx).rating;
    T.rS[i] = E.hzRating({ score: P.score(X, 'swing', i), bt: P.bt(X, 'swing', i + 1) }, 'swing', ctx).rating;
    T.rSh[i] = E.hzRating({ score: P.score(X, 'short', i), bt: P.bt(X, 'short', i + 1) }, 'short', ctx).rating;
  }
  // holidays = weekdays without a bar inside the data window (feeds the expiry calendar)
  const have = new Set(D.day), extra = new Set(); for (let d = D.day[0]; d <= D.day[n - 1]; d = P.addDays(d, 1)) if (![0, 6].includes(P.dow(d)) && !have.has(d)) extra.add(d);
  const lvc = new Map();
  const M = { und, D, atr: I.atr, lot: P.IDX_LOT[und] || 50, extra, T, vixSrc, vixAt: (j, mom) => mom === 'open' ? vix[Math.max(0, j - 1)] : mom === 'close' ? vix[j] : (vix[Math.max(0, j - 1)] + vix[j]) / 2,
    lv: (i, dir) => { const k = i * 2 + (dir > 0 ? 1 : 0); let v = lvc.get(k); if (!v) { v = E._levels(I, i, 'swing', dir, 0.05, D.c[i]); lvc.set(k, v); } return v; } };
  const trainN = Math.floor((n - 1 - evalStart) * 0.6); M.a = evalStart; M.split = evalStart + trainN; M.b = n - 2; M.splitDay = D.day[M.split];
  return M;
}

// ---------------------------------------------------------------------------------------------------------------- evaluator with memoised trades
function makeEval(M, sim) {
  const memo = new Map(), T = M.T;
  const tradeOf = (i, side, cfg, ck) => {
    const key = i + side + ck; let t = memo.get(key); if (t !== undefined) return t;
    t = (T.vixPct[i] > cfg.exit.ivSpread ? S.simSpread : S.simOption)(M, sim, i, side, cfg); memo.set(key, t); return t;
  };
  return {
    run(cfg, a, b) {
      const ck = JSON.stringify([cfg.exit, cfg.strike]), out = [];
      for (let i = a; i < b; i++) { const side = S.sideAt(T, cfg.sig, i); if (!side) continue; const t = tradeOf(i, side, cfg, ck); if (t) out.push(t); }
      return out;
    },
  };
}
const split = (ev, M, cfg) => ({ train: ev.run(cfg, M.a, M.split), test: ev.run(cfg, M.split, M.b) });

// ---------------------------------------------------------------------------------------------------------------- search space (index options)
const MIXES = [[0.3, 0.7, 0], [0, 1, 0], [0.15, 0.85, 0], [0.5, 0.5, 0], [0, 0.7, 0.3], [0.3, 0.5, 0.2], [0.2, 0.4, 0.4], [0.15, 0.55, 0.3], [0, 0.5, 0.5], [0.5, 0.3, 0.2], [0.7, 0.3, 0], [0, 0, 1], [1, 0, 0]];
const PARAMS = [
  { k: 'mix', lbl: 'horizon mix (intraday/swing/short)', vals: MIXES, show: v => v.join('/'), get: c => [c.sig.wI, c.sig.wS, c.sig.wH], set: (c, v) => { [c.sig.wI, c.sig.wS, c.sig.wH] = v; } },
  { k: 'thr', lbl: 'entry threshold (side score ≥)', vals: [55, 57.5, 60, 62.5, 65, 67.5, 70, 72.5, 75], get: c => c.sig.thr, set: (c, v) => { c.sig.thr = v; } },
  { k: 'trend', lbl: 'trend filter', vals: ['none', 'e20', 'e50', 'e2050', 'e200', 'adx20', 'adx25', 'e50adx'], get: c => c.sig.trend, set: (c, v) => { c.sig.trend = v; } },
  { k: 'vixPctMax', lbl: 'skip when VIX 1-yr percentile >', vals: [100, 90, 80, 70, 60, 50], get: c => c.sig.vixPctMax, set: (c, v) => { c.sig.vixPctMax = v; } },
  { k: 'vixMax', lbl: 'skip when India VIX >', vals: [99, 30, 25, 22, 20, 18, 16], get: c => c.sig.vixMax, set: (c, v) => { c.sig.vixMax = v; } },
  { k: 'vixMin', lbl: 'skip when India VIX <', vals: [0, 11, 12, 13, 14, 15], get: c => c.sig.vixMin, set: (c, v) => { c.sig.vixMin = v; } },
  { k: 'gapAgainst', lbl: 'skip if open gaps against the trade by >% ', vals: [null, 0.2, 0.35, 0.5, 0.8], get: c => c.sig.gapAgainst, set: (c, v) => { c.sig.gapAgainst = v; } },
  { k: 'gapWith', lbl: 'skip if open gaps with the trade by >% (chasing)', vals: [null, 0.3, 0.5, 0.8, 1.2], get: c => c.sig.gapWith, set: (c, v) => { c.sig.gapWith = v; } },
  { k: 'dowSkip', lbl: 'skip entry weekday (1=Mon … 5=Fri)', vals: [[], [1], [2], [3], [4], [5]], get: c => c.sig.dowSkip, set: (c, v) => { c.sig.dowSkip = v; } },
  { k: 'bigSkip', lbl: 'skip if last day already moved ≥ kσ with the trade', vals: [null, 1, 1.5, 2, 2.5], get: c => c.sig.bigSkip, set: (c, v) => { c.sig.bigSkip = v; } },
  { k: 'strike', lbl: 'strike (delta aim / ITM1-ATM-OTM1)', vals: [{ mode: 'delta', aim: 0.55 }, { mode: 'delta', aim: 0.3 }, { mode: 'delta', aim: 0.4 }, { mode: 'delta', aim: 0.45 }, { mode: 'delta', aim: 0.5 }, { mode: 'delta', aim: 0.6 }, { mode: 'delta', aim: 0.7 }, { mode: 'steps', n: 1 }, { mode: 'steps', n: 0 }, { mode: 'steps', n: -1 }], show: v => v.mode === 'delta' ? 'delta ' + v.aim : v.n === 1 ? 'ITM1' : v.n === 0 ? 'ATM' : 'OTM1', get: c => c.strike, set: (c, v) => { c.strike = v; } },
  { k: 'minDays', lbl: 'expiry: min trading days left', vals: [4, 1, 2, 3, 5], get: c => c.exit.minDays, set: (c, v) => { c.exit.minDays = v; } },
  { k: 'hold', lbl: 'holding period (sessions; 1 = same-day close)', vals: [3, 1, 2, 4, 5], get: c => c.exit.hold, set: (c, v) => { c.exit.hold = v; } },
  { k: 'sl', lbl: 'premium stop (% of premium)', vals: [0.5, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45], show: v => Math.round(v * 100) + '%', get: c => c.exit.sl, set: (c, v) => { c.exit.sl = v; } },
  { k: 'stopU', lbl: 'underlying stop (engine level / k·ATR / none)', vals: ['lvl', null, 0.75, 1, 1.5, 2], show: v => v === 'lvl' ? 'engine swing stop' : v == null ? 'none (premium stop only)' : v + '×ATR', get: c => c.exit.stopU, set: (c, v) => { c.exit.stopU = v; } },
  { k: 'tgt', lbl: 'target (engine T1/T2 · premium multiple · ATR · none)', vals: [{ kind: 'lvl', v: 0 }, { kind: 'none', v: 0 }, { kind: 'prem', v: 0.3 }, { kind: 'prem', v: 0.5 }, { kind: 'prem', v: 0.75 }, { kind: 'prem', v: 1 }, { kind: 'und', v: 0.5 }, { kind: 'und', v: 0.75 }, { kind: 'und', v: 1 }, { kind: 'und', v: 1.5 }], show: v => v.kind === 'lvl' ? 'engine T1 half / T2' : v.kind === 'none' ? 'none (time exit)' : v.kind === 'prem' ? '+' + Math.round(v.v * 100) + '% premium' : v.v + '×ATR underlying', get: c => c.exit.tgt, set: (c, v) => { c.exit.tgt = v; } },
  { k: 'trail', lbl: 'trailing stop (activates at +x%, trails y% below peak)', vals: [null, { act: 0.3, off: 0.2 }, { act: 0.5, off: 0.25 }, { act: 0.5, off: 0.35 }, { act: 0.8, off: 0.3 }], show: v => v ? `at +${Math.round(v.act * 100)}% trail ${Math.round(v.off * 100)}%` : 'off', get: c => c.exit.trail, set: (c, v) => { c.exit.trail = v; } },
  { k: 'ivSpread', lbl: 'IV rich: debit spread when VIX percentile >', vals: [100, 90, 80, 70, 60], get: c => c.exit.ivSpread, set: (c, v) => { c.exit.ivSpread = v; } },
];
const keyOf = (p, c) => JSON.stringify(p.get(c));
const showP = (p, v) => p.show ? p.show(v) : v == null ? 'off' : Array.isArray(v) ? (v.length ? v.join(',') : 'none') : String(v);
const MINN = 30, MARGIN_IDX = 0.05, MARGIN_STK = 0.03, NFLOOR = 0.6; // NFLOOR: an adopted set may not cut the OOS trade count below 60% of the default's (complexity / overfit guard) // a parameter must add ≥ this much net R/trade OUT-OF-SAMPLE to be adopted (noise guard)
const objective = st => st.n < MINN ? -99 : st.t;

function search(ev, M, passes, logLines) {
  let cfg = S.clone(S.DEFAULT_CFG), best = objective(S.stats(ev.run(cfg, M.a, M.split))), evals = 0;
  for (let pass = 1; pass <= passes; pass++) {
    let changed = false;
    for (const p of PARAMS) {
      let bv = null, bo = best; const rows = [];
      for (const v of p.vals) { const c2 = S.clone(cfg); p.set(c2, S.clone(v)); const st = S.stats(ev.run(c2, M.a, M.split)); evals++; const o = objective(st); rows.push([showP(p, v), st.n, st.avgR, o]); if (o > bo + 0.05) { bo = o; bv = v; } } // +0.05 t hysteresis against noise
      if (bv != null && keyOf(p, cfg) !== JSON.stringify(bv)) { p.set(cfg, S.clone(bv)); best = bo; changed = true; }
      logLines.push(`  pass ${pass} · ${pad(p.lbl, 58)} → ${showP(p, p.get(cfg))}  (train t=${f1(best, 2)})`);
    }
    if (!changed) break;
  }
  return { cfg, evals, trainObj: best };
}

// forward selection: apply tuned parameters one by one (largest train contribution first) only if TEST expectancy improves vs the accepted set
function select(ev, M, tuned) {
  const def = S.DEFAULT_CFG, base = S.stats(ev.run(def, M.a, M.split)), diff = PARAMS.filter(p => keyOf(p, tuned) !== keyOf(p, def));
  const contrib = diff.map(p => { const c = S.clone(tuned); p.set(c, S.clone(p.get(def))); return { p, drop: S.stats(ev.run(tuned, M.a, M.split)).t - S.stats(ev.run(c, M.a, M.split)).t }; }).sort((a, b) => b.drop - a.drop);
  let cur = S.clone(def), curT = S.stats(ev.run(cur, M.split, M.b)), curTr = base; const rows = [], order = [], defTest = curT;
  for (const { p, drop } of contrib) {
    const c2 = S.clone(cur); p.set(c2, S.clone(p.get(tuned)));
    const te = S.stats(ev.run(c2, M.split, M.b)), tr = S.stats(ev.run(c2, M.a, M.split));
    const enough = te.n >= 20 && te.n >= NFLOOR * defTest.n, better = te.avgR > curT.avgR + MARGIN_IDX && tr.avgR >= curTr.avgR - 0.02;
    const acc = enough && better;
    rows.push({ k: p.k, lbl: p.lbl, from: showP(p, p.get(cur)), to: showP(p, p.get(tuned)), drop, trainAvgR: tr.avgR, testAvgR: te.avgR, testN: te.n, acc, why: acc ? 'adopted' : !enough ? 'too few OOS trades' : 'no OOS gain' });
    if (acc) { cur = c2; curT = te; curTr = tr; order.push(p); }
  }
  return { cfg: cur, rows, order };
}

// ---------------------------------------------------------------------------------------------------------------- diagnostics on the underlying (direction signal)
function dirDiag(M, L) {
  const D = M.D, T = M.T, rows = [], mk = (name, sel) => {
    const o = { tr: [[], [], []], te: [[], [], []] };
    for (let i = M.a; i < M.b - 3; i++) { const d = sel(i); if (!d) continue; const e = i + 1, w = i < M.split ? o.tr : o.te; for (let h = 0; h < 3; h++) w[h].push(d * (D.c[e + h] / D.o[e] - 1) * 1e4); }
    const cell = a => a[0].length >= 5 ? `n=${lpad(a[0].length, 3)} hit ${lpad(f1(a[0].filter(x => x > 0).length / a[0].length * 100, 0), 3)}% ${lpad(sg(S.mean(a[0]), 0), 5)}/${lpad(sg(S.mean(a[1]), 0), 5)}/${lpad(sg(S.mean(a[2]), 0), 5)}bp` : '       (too few)           ';
    rows.push(`  ${pad(name, 34)}TRAIN ${cell(o.tr)}  | TEST ${cell(o.te)}`);
  };
  const side = (s, i) => { const x = S.sideAt(T, Object.assign({}, S.DEFAULT_CFG.sig, s), i); return x ? (x === 'CE' ? 1 : -1) : 0; };
  L.push('  Directional underlying return after the signal, entry at next OPEN → close of day 1 / 2 / 3 (bp, after nothing: pure direction, no option costs).');
  for (const m of MIXES.slice(0, 11)) mk(`mix ${m.join('/')} @65`, i => side({ wI: m[0], wS: m[1], wH: m[2] }, i));
  for (const th of [55, 60, 65, 70, 75]) mk(`default mix, threshold ${th}`, i => side({ thr: th }, i));
  for (const tr of ['e20', 'e50', 'e2050', 'e200', 'adx20', 'adx25']) mk(`default @65 + trend ${tr}`, i => side({ trend: tr }, i));
  for (const [nm, f] of [['VIX pct ≤50', t => t <= 50], ['VIX pct 50-80', t => t > 50 && t <= 80], ['VIX pct >80', t => t > 80]]) mk(`default @65, ${nm}`, i => f(T.vixPct[i]) ? side({}, i) : 0);
  for (const [nm, f] of [['VIX rising >5% d/d', i => T.vix[i] / T.vix[i - 1] - 1 > 0.05], ['VIX falling <-5% d/d', i => T.vix[i] / T.vix[i - 1] - 1 < -0.05]]) mk(`default @65, ${nm}`, i => f(i) ? side({}, i) : 0);
  for (let d = 1; d <= 5; d++) mk(`default @65, entry on ${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][d]}`, i => T.dow[i + 1] === d ? side({}, i) : 0);
  for (const g of [[-9, -0.5], [-0.5, -0.2], [-0.2, 0.2], [0.2, 0.5], [0.5, 9]]) mk(`default @65, gap ${g[0] <= -9 ? '<' + g[1] : g[1] >= 9 ? '>' + g[0] : g.join('..')}% (with trade)`, i => { const s = side({}, i); if (!s) return 0; const gp = s * (T.o[i + 1] / T.c[i] - 1) * 100; return gp >= g[0] && gp < g[1] ? s : 0; });
  L.push('', '  Mean reversion after big days (all days, no signal needed): sign = +1 continuation, −1 reversal of the last close-to-close move; return of next day open→close in bp (direction = same as the big move):');
  for (const k of [1, 1.5, 2, 2.5]) {
    const a = [[], []]; for (let i = M.a; i < M.b - 1; i++) { if (Math.abs(T.ret1[i]) >= k * T.sig20[i]) a[i < M.split ? 0 : 1].push(Math.sign(T.ret1[i]) * (D.c[i + 1] / D.o[i + 1] - 1) * 1e4); }
    L.push(`  |move| ≥ ${k}σ: TRAIN n=${lpad(a[0].length, 3)} ${lpad(sg(S.mean(a[0]), 1), 6)}bp | TEST n=${lpad(a[1].length, 3)} ${lpad(sg(S.mean(a[1]), 1), 6)}bp`);
  }
  L.push(...rows);
}

// ---------------------------------------------------------------------------------------------------------------- one index
function line(name, st) { return `  ${pad(name, 26)} n=${lpad(st.n, 3)}  hit ${lpad(f1(st.hit, 0), 3)}%  avgR ${lpad(sg(st.avgR, 2), 6)}  exp ${lpad(sg(st.expPct, 1), 6)}%/trade  PF ${lpad(st.pf == null ? '–' : f1(st.pf, 2), 5)}  maxDD ${lpad(f1(st.mdd, 1), 5)}R  worst ${lpad(f1(st.worst, 2), 5)}R  t=${lpad(f1(st.t, 2), 5)}`; }
function cfgDesc(cfg) {
  const s = cfg.sig, x = cfg.exit; return [`mix ${s.wI}/${s.wS}/${s.wH}`, `thr ${s.thr}`, `trend ${s.trend}`, `VIXpct≤${s.vixPctMax}`, `VIX ${s.vixMin}–${s.vixMax}`, `gapAgainst ${s.gapAgainst == null ? 'off' : s.gapAgainst}`, `gapWith ${s.gapWith == null ? 'off' : s.gapWith}`, `skipDow ${s.dowSkip.join(',') || 'none'}`, `bigSkip ${s.bigSkip == null ? 'off' : s.bigSkip + 'σ'}`,
    `strike ${showP(PARAMS.find(p => p.k === 'strike'), cfg.strike)}`, `minDays ${x.minDays}`, `hold ${x.hold}`, `SL ${Math.round(x.sl * 100)}%`, `stopU ${showP(PARAMS.find(p => p.k === 'stopU'), x.stopU)}`, `target ${showP(PARAMS.find(p => p.k === 'tgt'), x.tgt)}`, `trail ${showP(PARAMS.find(p => p.k === 'trail'), x.trail)}`, `spread@VIXpct>${x.ivSpread}`].join(' · ');
}
function indexParams(und, cfg, sel, ev, M, fin) {
  const def = S.DEFAULT_CFG, o = {}, acc = new Set(sel.rows.filter(r => r.acc).map(r => r.k));
  const put = (k, v) => { if (acc.has(k)) o[k] = v; };
  put('mix', { wI: cfg.sig.wI, wS: cfg.sig.wS, wH: cfg.sig.wH }); put('thr', cfg.sig.thr); put('trend', cfg.sig.trend); put('vixPctMax', cfg.sig.vixPctMax); put('vixMax', cfg.sig.vixMax); put('vixMin', cfg.sig.vixMin);
  put('gapAgainst', cfg.sig.gapAgainst); put('gapWith', cfg.sig.gapWith); put('dowSkip', cfg.sig.dowSkip); put('bigSkip', cfg.sig.bigSkip); put('strike', cfg.strike);
  put('minDays', cfg.exit.minDays); put('hold', cfg.exit.hold); put('sl', cfg.exit.sl); put('stopU', cfg.exit.stopU); put('tgt', cfg.exit.tgt); put('trail', cfg.exit.trail); put('ivSpread', cfg.exit.ivSpread);
  return o;
}
// calls are switched off when the adopted rules lose clearly, or when default AND adopted are negative out-of-sample and negative in every IV/slippage stress row
function indexEnabled(sf, sd, allNeg, ci) { return !((sf.n >= 25 && sf.avgR < -0.10 && ci[1] < 0.05) || (sf.n >= 25 && sf.avgR < 0 && sd.avgR < 0 && allNeg)); }
function runIndex(und, M, L) {
  const sim = { ivm: S.IDX[und].mult }, ev = makeEval(M, sim), T = M.T;
  L.push('', '='.repeat(118), `${und}  (${S.IDX[und].y})   data ${M.D.day[M.a]} → ${M.D.day[M.b]}  ·  TRAIN ${M.D.day[M.a]} → ${M.D.day[M.split - 1]} (${M.split - M.a} sessions)  ·  TEST ${M.splitDay} → ${M.D.day[M.b]} (${M.b - M.split} sessions)  ·  lot ${M.lot}  ·  IV = ${M.vixSrc} × ${sim.ivm} + put skew`, '='.repeat(118));
  L.push('', 'A. DIRECTION SIGNAL (underlying only)'); dirDiag(M, L);
  const sl = []; const t0 = Date.now(); const res = search(ev, M, QUICK ? 1 : 2, sl);
  L.push('', `B. COORDINATE SEARCH on TRAIN only (${res.evals} configurations, ${((Date.now() - t0) / 1000).toFixed(0)}s; objective = t-stat of net R/trade, n ≥ ${MINN}; +0.05 hysteresis)`, ...sl);
  const sel = select(ev, M, res.cfg);
  L.push('', 'C. OUT-OF-SAMPLE GATE (forward selection on TEST; a change is kept only if TEST net expectancy beats the accepted set by ≥ ' + MARGIN_IDX + ' R, n ≥ 20 and ≥ ' + NFLOOR * 100 + '% of default trades)');
  L.push(`  ${pad('parameter', 52)}${pad('default → tuned', 44)}${lpad('trainΔt', 8)}${lpad('train R', 8)}${lpad('test R', 8)}${lpad('test n', 7)}  verdict`);
  for (const r of sel.rows) L.push(`  ${pad(r.lbl, 52)}${pad(r.from + ' → ' + r.to, 44)}${lpad(sg(r.drop, 2), 8)}${lpad(sg(r.trainAvgR, 2), 8)}${lpad(sg(r.testAvgR, 2), 8)}${lpad(r.testN, 7)}  ${r.acc ? 'ADOPT' : 'keep default (' + r.why + ')'}`);
  if (!sel.rows.length) L.push('  search found nothing better than the defaults on TRAIN.');
  // complexity guard: with more than 2 adopted parameters also build the simplest version (first 2 by train contribution); prefer it when its TEST CI overlaps the full version's
  let fin = sel.cfg, accKeys = sel.order.map(p => p.k), simpleNote = '';
  if (sel.order.length > 2) {
    const sc = S.clone(S.DEFAULT_CFG); for (const p of sel.order.slice(0, 2)) p.set(sc, S.clone(p.get(sel.cfg)));
    const fT = ev.run(sel.cfg, M.split, M.b), sT = ev.run(sc, M.split, M.b), fS = S.stats(fT), sS = S.stats(sT), fC = S.bootCI(fT.map(t => t.R)), sC = S.bootCI(sT.map(t => t.R)), overlap = sC[1] >= fC[0] && fC[1] >= sC[0] && sS.n >= NFLOOR * S.stats(ev.run(S.DEFAULT_CFG, M.split, M.b)).n;
    simpleNote = `  SIMPLER ALTERNATIVE (${sel.order.slice(0, 2).map(p => p.k).join(' + ')}): TEST n=${sS.n} avgR ${sg(sS.avgR, 2)} CI [${sg(sC[0], 2)}, ${sg(sC[1], 2)}]  vs full (${sel.order.length} params): n=${fS.n} avgR ${sg(fS.avgR, 2)} CI [${sg(fC[0], 2)}, ${sg(fC[1], 2)}]  → ${overlap ? 'CIs overlap: the SIMPLER version is used' : 'CIs do not overlap: the full version is kept'}`;
    if (overlap) { fin = sc; accKeys = sel.order.slice(0, 2).map(p => p.k); }
  }
  const W = { def: split(ev, M, S.DEFAULT_CFG), tun: split(ev, M, res.cfg), fin: split(ev, M, fin) };
  if (simpleNote) L.push('', simpleNote);
  L.push('', 'D. RESULT (simulated option P&L, 1 lot, after costs + slippage; R = P&L / premium risked at the stop)');
  L.push('  TRAIN'); L.push(line('today\'s defaults', S.stats(W.def.train))); L.push(line('search optimum (unvalidated)', S.stats(W.tun.train))); L.push(line('ADOPTED parameters', S.stats(W.fin.train)));
  L.push('  TEST (out-of-sample)'); const sd = S.stats(W.def.test), sf = S.stats(W.fin.test); L.push(line('today\'s defaults', sd)); L.push(line('search optimum (unvalidated)', S.stats(W.tun.test))); L.push(line('ADOPTED parameters', sf));
  const ci = S.bootCI(W.fin.test.map(t => t.R)); L.push(`  ADOPTED test avgR 95% bootstrap CI [${sg(ci[0], 2)}, ${sg(ci[1], 2)}]   ·  default test avgR CI [${sg(S.bootCI(W.def.test.map(t => t.R))[0], 2)}, ${sg(S.bootCI(W.def.test.map(t => t.R))[1], 2)}]`);
  L.push(`  adopted config: ${cfgDesc(fin)}`);
  const byYear = {}; for (const t of [...W.fin.train, ...W.fin.test]) { const y = t.day.slice(0, 4); (byYear[y] = byYear[y] || []).push(t.R); }
  L.push('  by year (ADOPTED): ' + Object.keys(byYear).sort().map(y => `${y}: n=${byYear[y].length} ${sg(S.mean(byYear[y]), 2)}R`).join(' · '));
  const why = {}; for (const t of W.fin.test) why[t.why] = (why[t.why] || 0) + 1; L.push('  exits (TEST): ' + Object.entries(why).map(([k, v]) => `${k} ${v}`).join(' · '));
  // robustness of the ADOPTED vs default on TEST under harsher modelling assumptions
  L.push('', 'E. ROBUSTNESS on TEST (avgR; does the edge survive other IV levels and double slippage?)');
  const rob = [];
  for (const [nm, ivm, sx] of [['model IV ×1.00 (base)', sim.ivm, 1], ['IV ×0.90', sim.ivm * 0.9, 1], ['IV ×1.10', sim.ivm * 1.1, 1], ['IV ×1.25', sim.ivm * 1.25, 1], ['slippage ×2', sim.ivm, 2], ['slippage ×3', sim.ivm, 3]]) {
    const s0 = P.SLIP.OPT, m0 = P.SLIP.OPT_MIN; P.SLIP.OPT = s0 * sx; P.SLIP.OPT_MIN = m0 * sx;
    const e2 = makeEval(M, { ivm }); const a = S.stats(e2.run(S.DEFAULT_CFG, M.split, M.b)), b = S.stats(e2.run(fin, M.split, M.b)); P.SLIP.OPT = s0; P.SLIP.OPT_MIN = m0;
    rob.push([nm, a, b]); L.push(`  ${pad(nm, 24)} default ${lpad(sg(a.avgR, 2), 6)}R (n=${a.n})   adopted ${lpad(sg(b.avgR, 2), 6)}R (n=${b.n})`);
  }
  const oos = { n: sf.n, hit: sf.hit, avgR: sf.avgR, expPct: sf.expPct, pf: sf.pf, mdd: sf.mdd, t: sf.t, ci95R: ci, defaultAvgR: sd.avgR, defaultExpPct: sd.expPct, defaultN: sd.n };
  const trainSt = S.stats(W.fin.train);
  const params = indexParams(und, fin, { rows: accKeys.map(k => ({ k, acc: true })) }, ev, M);
  const allNeg = rob.every(r => r[2].avgR < 0), enabled = indexEnabled(sf, sd, allNeg, ci);
  const offWhy = enabled ? null : `Measured on 5y of data (simulated premiums, ${sf.n} out-of-sample trades): average ${sg(sf.avgR, 2)}R per trade after costs for the best rule set and ${sg(sd.avgR, 2)}R for today's rules${allNeg ? ', negative under every IV/slippage stress' : ''}: no edge.`;
  return { params: Object.assign({ enabled, why: offWhy, sim: { ivMult: sim.ivm, lot: M.lot } }, params, { stats: { train: { n: trainSt.n, hit: trainSt.hit, avgR: trainSt.avgR, expPct: trainSt.expPct }, test: oos, from: M.D.day[M.a], trainTo: M.D.day[M.split - 1], to: M.D.day[M.b] } }), oos, sf, sd, nChanged: accKeys.length, enabled, robustOK: rob[0][2].avgR > 0 && rob[4][2].avgR > 0 };
}

// ---------------------------------------------------------------------------------------------------------------- stock futures
function stockLots() { try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../www/nse.json'), 'utf8')); return j.fo || {}; } catch (e) { return {}; } }
function prepStock(sym, D, lot) {
  const n = D.c.length, I = E.indicators(D), X = P.prep(sym, D); if (n < 400) return null;
  const a = Math.max(262, n - 1262), sw = new Array(n).fill(NaN), sh = sw.slice(), md = sw.slice();
  for (let i = a - 2; i < n - 1; i++) { sw[i] = P.score(X, 'swing', i); sh[i] = P.score(X, 'short', i); md[i] = P.score(X, 'medium', i); }
  const hh = new Array(n).fill(NaN), ll = hh.slice(), ret63 = hh.slice(), ret126 = hh.slice(), vr = hh.slice(), rsi = I.rsi;
  for (let i = 60; i < n; i++) { let H = -1, Lw = 1e18; for (let j = i - 55; j < i; j++) { H = Math.max(H, D.h[j]); Lw = Math.min(Lw, D.l[j]); } hh[i] = H; ll[i] = Lw; ret63[i] = D.c[i] / D.c[i - 63] - 1; if (i >= 126) ret126[i] = D.c[i] / D.c[i - 126] - 1; vr[i] = I.v20[i - 1] > 0 ? D.v[i] / I.v20[i - 1] : NaN; }
  const px = D.c[n - 1], estLot = lot || Math.max(1, Math.round(1.5e6 / px / 5) * 5);
  return { sym, D, I, n, a, sw, sh, md, hh, ll, ret63, ret126, vr, rsi, lot: estLot, lotEst: !lot, dayIdx: new Map(D.day.map((d, i) => [d, i])), turn: S.mean(D.c.slice(-60).map((c, k) => c * D.v[n - 60 + k])) };
}
const STK_DEF = { fam: 'swing', thr: 70, sides: 'both', stopAtr: 1.5, tgtAtr: 2.25, hold: 10 };
function stockSide(c, st, i, rank) {
  let s = NaN; const f = c.fam;
  if (f === 'swing') s = st.sw[i]; else if (f === 'short') s = st.sh[i]; else if (f === 'medium') s = st.md[i]; else if (f === 'blend') s = 0.4 * st.sw[i] + 0.35 * st.sh[i] + 0.25 * st.md[i];
  let b = 0;
  if (f === 'swing' || f === 'short' || f === 'medium' || f === 'blend') { if (!(s >= 0)) return 0; b = s >= c.thr ? 1 : s <= 100 - c.thr ? -1 : 0; }
  else if (f === 'mom63' || f === 'mom126') { const r = rank[f][i]; if (r == null) return 0; b = r >= c.thr / 100 ? 1 : r <= 1 - c.thr / 100 ? -1 : 0; }
  else if (f === 'brk55') { const D = st.D; if (!(st.vr[i] > 1.3)) return 0; b = D.c[i] > st.hh[i] ? 1 : D.c[i] < st.ll[i] ? -1 : 0; }
  else if (f === 'rsi') { const D = st.D, lo = 100 - c.thr; b = st.rsi[i] <= lo + 5 && D.c[i] > st.I.e200[i] ? 1 : st.rsi[i] >= c.thr - 5 && D.c[i] < st.I.e200[i] ? -1 : 0; }
  if (c.sides === 'long' && b < 0) return 0; if (c.sides === 'short' && b > 0) return 0; return b;
}
const stkMemo = new Map();
function stockTrade(st, i, b, c) { // entry next open, stop / target in ATR, time exit; per-unit R using the stop distance
  const key = st.sym + '|' + i + '|' + b + '|' + c.stopAtr + '|' + c.tgtAtr + '|' + c.hold; let r = stkMemo.get(key); if (r !== undefined) return r;
  const D = st.D, e = i + 1, atr = st.I.atr[i]; r = null;
  if (e < st.n - 1 && atr > 0) {
    const fill = P.slip('FUT', D.o[e], b > 0 ? 'B' : 'S'), stop = fill - b * c.stopAtr * atr, tgt = c.tgtAtr ? fill + b * c.tgtAtr * atr : null, qty = st.lot; let exit = null, j = e, why = '';
    for (; j < st.n; j++) {
      if (j > e && b * (D.o[j] - stop) <= 0) { exit = D.o[j]; why = 'gap stop'; break; }
      if (j > e && tgt != null && b * (D.o[j] - tgt) >= 0) { exit = D.o[j]; why = 'gap target'; break; }
      if (b * ((b > 0 ? D.l[j] : D.h[j]) - stop) <= 0) { exit = stop; why = 'stop'; break; }
      if (tgt != null && b * ((b > 0 ? D.h[j] : D.l[j]) - tgt) >= 0) { exit = tgt; why = 'target'; break; }
      if (j - e + 1 >= c.hold) { exit = D.c[j]; why = 'time'; break; }
    }
    if (exit == null) { j = st.n - 1; exit = D.c[j]; why = 'end'; }
    const xs = P.slip('FUT', exit, b > 0 ? 'S' : 'B'), gross = b * (xs - fill) * qty, cost = P.orderCost('FUT', b > 0 ? 'B' : 'S', fill * qty, D.day[e]) + P.orderCost('FUT', b > 0 ? 'S' : 'B', xs * qty, D.day[j]), pnl = gross - cost;
    r = { sym: st.sym, i, e, x: j, day: D.day[e], b, pnl, R: pnl / (c.stopAtr * atr * qty), pct: pnl / (fill * qty) * 100, why, notional: fill * qty };
  }
  stkMemo.set(key, r); return r;
}
const SP = [
  { k: 'fam', lbl: 'signal family', vals: ['swing', 'short', 'medium', 'blend', 'mom63', 'mom126', 'brk55', 'rsi'] },
  { k: 'thr', lbl: 'threshold (rating ≥ x long / ≤ 100−x short; momentum percentile; RSI extreme)', vals: [60, 65, 70, 75, 80, 85, 90] },
  { k: 'sides', lbl: 'which side', vals: ['both', 'long', 'short'] },
  { k: 'stopAtr', lbl: 'stop (× ATR)', vals: [1.5, 1, 2, 2.5, 3] },
  { k: 'tgtAtr', lbl: 'target (× ATR, 0 = none)', vals: [2.25, 0, 1.5, 3, 4.5, 6] },
  { k: 'hold', lbl: 'max holding (sessions)', vals: [10, 3, 5, 15, 20, 30] },
];
function runStocks(stocks, splitDay, L) {
  const lastDay = stocks.reduce((m, s) => s.D.day[s.n - 1] > m ? s.D.day[s.n - 1] : m, ''), firstDay = stocks.reduce((m, s) => s.D.day[s.a] < m || !m ? s.D.day[s.a] : m, '');
  // cross-sectional momentum percentile per day
  const rank = { mom63: stocks.map(s => new Array(s.n).fill(null)), mom126: stocks.map(s => new Array(s.n).fill(null)) }; const byDay = new Map();
  stocks.forEach((s, k) => { for (let i = s.a - 2; i < s.n; i++) { const d = s.D.day[i]; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push([k, i]); } });
  for (const [, arr] of byDay) for (const f of ['mom63', 'mom126']) { const key = f === 'mom63' ? 'ret63' : 'ret126', v = arr.map(([k, i]) => [stocks[k][key][i], k, i]).filter(x => x[0] === x[0]).sort((a, b) => a[0] - b[0]); v.forEach((x, r) => { rank[f][x[1]][x[2]] = v.length > 10 ? r / (v.length - 1) : null; }); }
  const wrap = st => { const k = stocks.indexOf(st); return { mom63: rank.mom63[k], mom126: rank.mom126[k] }; }; // rank[f][i] for this stock's own series
  const runC = (c, a, b) => { const out = []; for (const st of stocks) { const R = wrap(st); let busy = -1; for (let i = st.a; i < st.n - 2; i++) { if (i < busy) continue; const day = st.D.day[i + 1]; if (day < a || day >= b) continue; const s = stockSide(c, st, i, R); if (!s) continue; const t = stockTrade(st, i, s, c); if (t) { out.push(t); busy = t.x; } } } return out; };
  const tr = c => S.stats(runC(c, firstDay, splitDay)), te = c => S.stats(runC(c, splitDay, '9999')), obj = st => st.n < 60 ? -99 : st.t;
  L.push('', '='.repeat(118), `STOCK FUTURES  (${stocks.length} F&O stocks · ${firstDay} → ${lastDay} · TRAIN → ${splitDay} · TEST ${splitDay} → ; lots ${stocks.filter(s => !s.lotEst).length} from NSE list, ${stocks.filter(s => s.lotEst).length} estimated from the ₹15 lakh minimum contract)`, '='.repeat(118));
  L.push('  Trades: signal at the close, enter next OPEN (slippage 0.03%), stop/target in ATR, time exit; one open trade per stock; futures costs incl. STT 0.05% sell side from 1-Apr-2026. R = P&L / (stop distance × lot).', '  Note: trades across stocks are correlated (same market days), so t-statistics are optimistic; trust TEST averages and CI, not t.');
  let cur = Object.assign({}, STK_DEF), best = obj(tr(cur)), evals = 0;
  const famTable = []; // per-family snapshot at its own best threshold / both sides, for the report
  for (const fam of SP[0].vals) for (const sides of ['both', 'long', 'short']) { let bo = -99, bt = null; for (const thr of SP[1].vals) { const c = Object.assign({}, STK_DEF, { fam, thr, sides }), a = tr(c), o = obj(a); evals++; if (o > bo) { bo = o; bt = { c, a }; } } if (bt) famTable.push({ fam, sides, thr: bt.c.thr, trn: bt.a, tst: te(bt.c) }); }
  L.push('', 'A. SIGNAL FAMILIES (each at its best TRAIN threshold; default exit 1.5 ATR stop / 2.25 ATR target / 10 sessions)');
  L.push(`  ${pad('family · sides · thr', 28)}${pad('TRAIN', 48)}TEST`);
  const cellS = s => `n=${lpad(s.n, 4)} hit ${lpad(f1(s.hit, 0), 3)}% avgR ${lpad(sg(s.avgR, 2), 6)} exp ${lpad(sg(s.expPct, 2), 6)}%`;
  for (const r of famTable) L.push(`  ${pad(`${r.fam} · ${r.sides} · ${r.thr}`, 28)}${pad(cellS(r.trn), 48)}${cellS(r.tst)}`);
  const sl = [];
  for (let pass = 1; pass <= (QUICK ? 1 : 2); pass++) {
    let ch = false;
    for (const p of SP) { let bv = null, bo = best; for (const v of p.vals) { const c2 = Object.assign({}, cur, { [p.k]: v }), o = obj(tr(c2)); evals++; if (o > bo + 0.05) { bo = o; bv = v; } } if (bv != null && bv !== cur[p.k]) { cur[p.k] = bv; best = bo; ch = true; } sl.push(`  pass ${pass} · ${pad(p.lbl, 76)} → ${cur[p.k]}  (train t=${f1(best, 2)})`); }
    if (!ch) break;
  }
  L.push('', `B. COORDINATE SEARCH on TRAIN (${evals} configurations)`, ...sl);
  // OOS gate, forward selection vs STK_DEF
  const defTe = te(STK_DEF), defTr = tr(STK_DEF); let acc = Object.assign({}, STK_DEF), accTe = defTe, accTr = defTr; const rows = [];
  const keys = SP.map(p => p.k).filter(k => cur[k] !== STK_DEF[k]).map(k => { const c = Object.assign({}, cur, { [k]: STK_DEF[k] }); return { k, drop: tr(cur).t - tr(c).t }; }).sort((a, b) => b.drop - a.drop);
  for (const { k, drop } of keys) { const c2 = Object.assign({}, acc, { [k]: cur[k] }), t2 = te(c2), r2 = tr(c2), ok = t2.n >= 40 && t2.n >= NFLOOR * defTe.n && t2.avgR > accTe.avgR + MARGIN_STK && r2.avgR >= accTr.avgR - 0.02; rows.push(`  ${pad(k, 10)}${pad(STK_DEF[k] + ' → ' + cur[k], 24)} trainΔt ${lpad(sg(drop, 2), 6)}  train R ${lpad(sg(r2.avgR, 2), 6)}  test R ${lpad(sg(t2.avgR, 2), 6)} (n=${t2.n})  ${ok ? 'ADOPT' : 'keep default'}`); if (ok) { acc = c2; accTe = t2; accTr = r2; } }
  L.push('', 'C. OUT-OF-SAMPLE GATE', ...(rows.length ? rows : ['  nothing differs from the default.']));
  const fin = acc, trF = accTr, teF = accTe, teTr = runC(fin, splitDay, '9999'), ci = S.bootCI(teTr.map(t => t.R));
  L.push('', 'D. RESULT (after costs)'); L.push(line('default TRAIN', defTr)); L.push(line('default TEST', defTe)); L.push(line('ADOPTED TRAIN', trF)); L.push(line('ADOPTED TEST', teF)); L.push(`  ADOPTED test avgR 95% CI [${sg(ci[0], 2)}, ${sg(ci[1], 2)}] · adopted: ${JSON.stringify(fin)}`);
  for (const sd of ['long', 'short']) { const c = Object.assign({}, fin, { sides: sd }), a = tr(c), b = te(c); L.push(`  side ${pad(sd, 6)} (adopted signal/exit)  TRAIN ${cellS(a)}   TEST ${cellS(b)}`); }
  const enabled = !(teF.n >= 60 && ci[1] < 0.05); // no meaningful edge after costs (upper end of the 95% CI below +0.05R) → stock calls off
  const why = enabled ? null : `Measured on 5y of data (${teF.n} out-of-sample trades, after futures costs): average ${sg(teF.avgR, 2)}R per trade, 95% CI [${sg(ci[0], 2)}, ${sg(ci[1], 2)}] → no meaningful edge; default ${sg(defTe.avgR, 2)}R.`;
  return { enabled, why, signal: { fam: fin.fam, thr: fin.thr, sides: fin.sides }, exit: { stopAtr: fin.stopAtr, tgtAtr: fin.tgtAtr, hold: fin.hold }, adopted: Object.keys(STK_DEF).filter(k => fin[k] !== STK_DEF[k]), stats: { train: { n: trF.n, hit: trF.hit, avgR: trF.avgR, expPct: trF.expPct }, test: { n: teF.n, hit: teF.hit, avgR: teF.avgR, expPct: teF.expPct, pf: teF.pf, ci95R: ci, defaultAvgR: defTe.avgR, defaultN: defTe.n } }, famTable: famTable.map(r => ({ fam: r.fam, sides: r.sides, thr: r.thr, trainAvgR: r.trn.avgR, testAvgR: r.tst.avgR, testN: r.tst.n })) };
}

// ---------------------------------------------------------------------------------------------------------------- main
async function main() {
  const t0 = Date.now(), L = [], out = { version: 1, generatedAt: new Date().toISOString(), method: 'walk-forward: search on first 60% (≈ years 1-3), adopt only what also beats today\'s default on the last 40% (≈ years 4-5), after costs; premiums simulated (Black-Scholes on India VIX)', index: {}, stocks: null, oos: {} };
  L.push('DayTrader Desk · F&O research · ' + out.generatedAt, 'All option premiums are SIMULATED (Black-Scholes, IV = India VIX × per-index factor + put skew). Results rank rules; they are not live results.',
    `STT/costs: ${JSON.stringify({ optSttSell: P.COST.OPT.stt26, slipOpt: P.SLIP.OPT })} (STT 0.15% on premium from ${P.COST.STT_HIKE}) · lots ${JSON.stringify(P.IDX_LOT)}`);
  let vixD = null; try { vixD = await yahoo('^INDIAVIX'); } catch (e) { log('no ^INDIAVIX:', e.message); L.push('WARNING: ^INDIAVIX unavailable, using realised-vol proxy.'); }
  const verdict = [];
  for (const und of WANT) {
    let D; try { D = await yahoo(S.IDX[und].y); } catch (e) { log(und, 'data failed:', e.message); L.push('', und + ': data unavailable (' + e.message + ') · skipped'); continue; }
    log(und, D.c.length, 'bars'); const M = prepIndex(und, D, vixD), r = runIndex(und, M, L);
    out.index[und] = r.params; out.oos[und] = r.oos; verdict.push([und, r]);
  }
  // stocks
  let stk = null;
  try {
    const lots = stockLots(), names = Object.keys(lots).length >= 50 ? Object.keys(lots) : [...U1, ...U2];
    log('stocks:', names.length, 'candidates', Object.keys(lots).length ? '(NSE F&O list)' : '(fallback list)');
    const raw = (await pool(names.filter(s => !/[^A-Z0-9&-]/.test(s)).slice(0, QUICK ? 60 : 260), 6, async s => { const D = await yahoo(s + '.NS'); return { s, D }; })).filter(Boolean);
    const loaded = raw.map(({ s, D }) => ({ s, D, turn: S.mean(D.c.slice(-60).map((c, k) => c * D.v[D.c.length - 60 + k])) })).sort((a, b) => b.turn - a.turn).slice(0, LIMIT);
    const stocks = loaded.map(({ s, D }) => prepStock(s, D, lots[s] > 0 ? lots[s] : 0)).filter(Boolean);
    if (stocks.length >= 15) {
      let splitDay = null; const first = Object.values(out.index)[0]; if (first && first.stats) splitDay = P.addDays(first.stats.trainTo, 1);
      if (!splitDay) { const s0 = stocks[0], k = s0.a + Math.floor((s0.n - 1 - s0.a) * 0.6); splitDay = s0.D.day[k]; }
      stk = runStocks(stocks, splitDay, L); out.stocks = stk; out.oos.stocks = stk.stats.test;
    } else L.push('', 'STOCK FUTURES: fewer than 15 stocks loaded · skipped');
  } catch (e) { log('stocks failed:', e.stack || e.message); L.push('', 'STOCK FUTURES: failed (' + e.message + ')'); }
  // summary
  const S1 = ['', '='.repeat(118), 'SUMMARY (what changes in the app)', '='.repeat(118)];
  for (const [und, r] of verdict) {
    const p = out.index[und], keys = Object.keys(p).filter(k => !['enabled', 'why', 'sim', 'stats'].includes(k));
    S1.push(`  ${pad(und, 10)} ${r.nChanged ? keys.length + ' parameter(s) tuned: ' + keys.join(', ') : 'defaults kept (nothing beat them out-of-sample)'} · TEST avgR ${sg(r.sf.avgR, 2)} (default ${sg(r.sd.avgR, 2)}), exp ${sg(r.sf.expPct, 1)}%/trade, hit ${f1(r.sf.hit, 0)}%, n=${r.sf.n} · ${p.enabled ? 'calls ON' : 'CALLS OFF: ' + (p.why || 'no after-cost edge out-of-sample')}${r.robustOK ? '' : ' · fragile: edge disappears under IV×/slippage stress'}`);
  }
  if (stk) S1.push(`  STOCKS     ${stk.adopted.length ? 'tuned: ' + stk.adopted.join(', ') : 'defaults kept'} · ${stk.signal.fam} ${stk.signal.sides} thr ${stk.signal.thr}; TEST avgR ${sg(stk.stats.test.avgR, 2)} (default ${sg(stk.stats.test.defaultAvgR, 2)}), n=${stk.stats.test.n} · ${stk.enabled ? 'ON' : 'OFF: no OOS edge'}`);
  S1.push('', `Runtime ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  L.push(...S1);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'fno_params.json'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(OUT, 'fno_report.txt'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { indexEnabled, prepIndex, makeEval, PARAMS, search, select, prepStock, stockSide, stockTrade };
