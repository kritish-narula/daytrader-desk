// Feature lab + walk-forward model fit for the STOCK side (GitHub Actions, weekly; no broker credentials — Yahoo daily bars only).
//
//  1. Universe: Nifty 500 (www/nse.json `cat` L/M/S) else the 80 stocks of tools/universe.js; 5 years daily; Nifty (^NSEI) for context.
//  2. Every STEP-th trading day, for every stock: the feature vector the app itself computes (E.features — engine factor values
//     'f.*' + the research registry in www/engine.js, single source of truth), the current rule score per horizon, and targets:
//     forward return (% and in ATRs) over 10/30/60/120 days, Target-1-before-stop with the app's own levels (E._levels), and
//     the return of that trade (stop / T1 / time exit). Cross-sectional features (ranks across the universe that day) are added after.
//  3. BTST rows (every BTST_STEP-th day): E.btstFeatures + the rule score (E.btstAt) → next-day gap, close-to-close, open-to-close.
//  4. Walk-forward by TIME with an embargo: fold 1 = train first 60% of days → test last 40%; fold 2 = expanding, train 80% → test
//     last 20%; plus a stock split (train on half the stocks in fold-1 train years, test on the OTHER half in fold-1 test years).
//  5. Model per horizon: ridge regression on winsorised z-scored features → per-day rank of the forward ATR return; features kept only
//     when their rank-IC has the same sign in both halves of the training window; lambda and the blend with the rule score are
//     picked on an inner time split of the training window (never on the test years).
//  6. Gate: adopt a horizon's model only if its OOS rank-IC AND its top-decile after-cost expectancy beat the current app score in
//     BOTH time folds (and the IC is positive). Thresholds (BUY / SELL cut-offs) come from OOS score bands of both folds.
//  7. Writes www/model.json sections `lin`, `thresholds`, `btst` (merge: every other key is kept) + data/research_report.txt.
//  8. Stability (VARIANT_HZ, default swing+short): every sampled row also records the feature vectors of the NLAG previous bars
//     (E.featuresAt — what the phone computes), so each candidate is scored at bar n AND bar n−1 for the same stock (= the
//     "drop the last bar" test). Variants: base (single bar, the original model), S3/S5 (score smoothing: mean of the model's raw
//     output over the last 3/5 bars — ridge fitted on the lag-averaged z-features; engine: lin[hz].smooth = k), FS (single-bar
//     features ret1/clv/gap1/volx dropped; their multi-day versions stay), FS+S3, shrink / S3+shrink (blend toward the rule score:
//     the most-stable blend whose inner-split IC ≥ STAB_IC_TOL × the best blend's). Adopted = the most stable variant that, in BOTH
//     time folds, beats the rule score (IC + MIN_IC_GAIN and top-decile after cost; F1 t ≥ MIN_T) AND keeps ≥ STAB_IC_TOL of the base
//     variant's OOS IC and a top-decile after cost within STAB_TOP_TOL %-points of it. Printed in the STABILITY section + DECISION.
//  9. CONVICTION (🎯): per daily horizon, a small pre-declared grid of selection rules (app score ≥ 58 / top 10·5·2 % cut, + ≤ 2 of
//     neighbour agreement, trend stack, Nifty > 200 EMA, liquidity, not overextended) is searched on each fold's TRAIN rows (max lower
//     95% bound of the T1-before-stop hit rate; n ≥ CONV_MIN_N de-duplicated signals; avg after-cost trade > 0) and measured on its TEST
//     rows. Writes model.json research.conviction[hz] = {rule, test, folds} only if the rule beat plain BUY ≥ 58 on hit AND after-cost
//     average in BOTH test folds, else {off, why}. The phone evaluates the same spec with E.conviction (parity checked here).
//
// env: RESEARCH_SYMS (comma list, overrides the universe), UNIVERSE_MAX (cap stocks), STEP (3), BTST_STEP (2), CONC (10), BUDGET_MIN (18: stop fetching new stocks after this),
//      COST (0.30 % round trip, multi-day delivery), BTST_COST (0.25), RESEARCH_SCOPE ('stock' | 'stock,mkt' | 'stock,mkt,xs'),
//      MIN_IC_GAIN (0.003), MIN_T (1.5: overlap-adjusted t of the model's OOS IC in fold 1; BTST needs 2×MIN_T),
//      RESEARCH_BASELINE ('app' = current model.json score, or 'rule'), RESEARCH_FORCE=1 (testing: write even if the gate fails),
//      RESEARCH_DRY=1 (don't write files), MODEL_PATH / REPORT_PATH (testing), YF_CACHE (/tmp/yfcache),
//      VARIANTS ('base,S3,S5,FS,FS+S3,shrink,S3+shrink'), VARIANT_HZ ('swing,short'), STAB_IC_TOL (0.9), STAB_TOP_TOL (0.10 %-points),
//      RESEARCH_FORCE_VARIANT (testing, with RESEARCH_FORCE: write this variant when none qualifies), CONV_MIN_N (150: min train signals per conviction rule).
// Dev run without Yahoo: YF_CACHE=/tmp/yfstub RESEARCH_SYMS=A,B,… RESEARCH_DRY=1 node -r ./tools/fno_stub.js tools/research.js
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js');
const U = require('./universe.js');

const ENV = process.env, T0 = Date.now();
const HZ = { swing: 10, short: 30, medium: 60, long: 120 }, HZS = Object.keys(HZ);
const STEP = Math.max(1, +ENV.STEP || 3), BSTEP = Math.max(1, +ENV.BTST_STEP || 2), CONC = +ENV.CONC || 10, BUDGET = (+ENV.BUDGET_MIN || 18) * 60e3;
const COST = ENV.COST != null ? +ENV.COST : 0.30, BCOST = ENV.BTST_COST != null ? +ENV.BTST_COST : 0.25;
const SCOPE = new Set((ENV.RESEARCH_SCOPE || 'stock').split(',').map(s => s.trim()));
const BASE = ENV.RESEARCH_BASELINE || 'app', FORCE = !!ENV.RESEARCH_FORCE, DRY = !!ENV.RESEARCH_DRY;
const MIN_IC_GAIN = ENV.MIN_IC_GAIN != null ? +ENV.MIN_IC_GAIN : 0.003, MIN_T = ENV.MIN_T != null ? +ENV.MIN_T : 1.5, LIQ = Math.log10(5e7); // ₹5 Cr/day for the "top 10" portfolio
const LAMS = [0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10], BLENDS = [0, 0.25, 0.5, 0.75, 1];
const MODEL_PATH = ENV.MODEL_PATH || path.join(__dirname, '../www/model.json'), REPORT = ENV.REPORT_PATH || path.join(__dirname, '../data/research_report.txt');
const CUTS = [20, 25, 30, 35, 38, 42, 46, 50, 54, 58, 62, 66, 70, 75, 80, 85]; // candidate score cut-offs for thresholds
// stability variants (see header §8)
const IC_TOL = ENV.STAB_IC_TOL != null ? +ENV.STAB_IC_TOL : 0.9, TOP_TOL = ENV.STAB_TOP_TOL != null ? +ENV.STAB_TOP_TOL : 0.10;
const SINGLE = ['ret1', 'clv', 'gap1', 'volx']; // single-bar features; their multi-day versions (ret5, clv5, gapAvg20, volx5) stay
const VDEF = {
  base: { k: 1, d: 'single bar (original model)' },
  S3: { k: 3, d: 'score = mean of model output over last 3 bars' },
  S5: { k: 5, d: 'score = mean of model output over last 5 bars' },
  FS: { k: 1, excl: SINGLE, d: 'single-bar features dropped (' + SINGLE.join('/') + ')' },
  'FS+S3': { k: 3, excl: SINGLE, d: 'FS + 3-bar score smoothing' },
  shrink: { k: 1, shrink: true, d: `blend toward rule: most stable blend with inner IC ≥ ${IC_TOL}×best` },
  'S3+shrink': { k: 3, shrink: true, d: 'S3 + shrink toward rule' },
};
const VARIANTS = ['base', ...(ENV.VARIANTS || Object.keys(VDEF).join(',')).split(',').map(x => x.trim()).filter(x => VDEF[x] && x !== 'base')].map(n => Object.assign({ name: n }, VDEF[n]));
const VHZ = new Set((ENV.VARIANT_HZ != null ? ENV.VARIANT_HZ : 'swing,short').split(',').map(x => x.trim()).filter(Boolean));
const KV = Math.max(1, ...VARIANTS.map(v => v.k));
const ok = x => typeof x === 'number' && isFinite(x);
const LOG = [], STAB = []; const log = (...a) => { const s = a.join(' '); LOG.push(s); console.log(s); };
const f3 = x => ok(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '  n/a ';
const f2 = x => ok(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : ' n/a';
const pc = x => ok(x) ? (100 * x).toFixed(0) + '%' : 'n/a';
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);

// ---------------- numerics (exported for tools/research.test.js) ----------------
function cholSolve(A, b, p) { // A p×p symmetric positive definite (row-major), returns x with A x = b
  const L = new Float64Array(p * p);
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * p + j]; for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k];
    L[i * p + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * p + j];
  }
  const y = new Float64Array(p), x = new Float64Array(p);
  for (let i = 0; i < p; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * p + k] * y[k]; y[i] = s / L[i * p + i]; }
  for (let i = p - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < p; k++) s -= L[k * p + i] * x[k]; x[i] = s / L[i * p + i]; }
  return x;
}
// ridge on Z (n×p row-major, Float64Array) → y; penalty lam on the per-row-averaged scale (diag of Z'Z/n ≈ 1 for z-scores). Intercept unpenalised.
function gram(Z, y, n, p) {
  const mz = new Float64Array(p); let my = 0;
  for (let r = 0; r < n; r++) { my += y[r]; for (let j = 0; j < p; j++) mz[j] += Z[r * p + j]; }
  my /= n; for (let j = 0; j < p; j++) mz[j] /= n;
  const A = new Float64Array(p * p), c = new Float64Array(p), d = new Float64Array(p);
  for (let r = 0; r < n; r++) {
    const yr = y[r] - my;
    for (let j = 0; j < p; j++) d[j] = Z[r * p + j] - mz[j];
    for (let j = 0; j < p; j++) { const dj = d[j]; c[j] += dj * yr; for (let k = 0; k <= j; k++) A[j * p + k] += dj * d[k]; }
  }
  for (let j = 0; j < p; j++) { c[j] /= n; for (let k = 0; k <= j; k++) { A[j * p + k] /= n; A[k * p + j] = A[j * p + k]; } }
  return { A, c, mz, my, p };
}
function ridgeG(G, lam) {
  const { A, c, mz, my, p } = G, B = Float64Array.from(A); for (let j = 0; j < p; j++) B[j * p + j] += lam;
  const w = cholSolve(B, c, p); let b0 = my; for (let j = 0; j < p; j++) b0 -= w[j] * mz[j];
  return { w: Array.from(w), b: b0 };
}
const ridge = (Z, y, n, p, lam) => ridgeG(gram(Z, y, n, p), lam);
function rankArr(v) { // average ranks, 0-based
  const n = v.length, ix = Array.from({ length: n }, (_, k) => k).sort((a, b) => v[a] - v[b]), r = new Float64Array(n);
  for (let k = 0; k < n;) { let m = k; while (m + 1 < n && v[ix[m + 1]] === v[ix[k]]) m++; const avg = (k + m) / 2; for (let q = k; q <= m; q++) r[ix[q]] = avg; k = m + 1; }
  return r;
}
function pearson(x, y) {
  const n = x.length; if (n < 3) return NaN; let mx = 0, my = 0; for (let k = 0; k < n; k++) { mx += x[k]; my += y[k]; } mx /= n; my /= n;
  let a = 0, b = 0, c = 0; for (let k = 0; k < n; k++) { const dx = x[k] - mx, dy = y[k] - my; a += dx * dy; b += dx * dx; c += dy * dy; }
  return b > 0 && c > 0 ? a / Math.sqrt(b * c) : NaN;
}
const spearman = (x, y) => pearson(rankArr(x), rankArr(y));
function quantile(sorted, q) { if (!sorted.length) return NaN; const p = (sorted.length - 1) * q, a = Math.floor(p), b = Math.ceil(p); return sorted[a] + (sorted[b] - sorted[a]) * (p - a); }
function icStats(ics, h) { // daily ICs → mean, t, overlap-adjusted t (forward windows of h days sampled every STEP days overlap)
  const v = ics.filter(ok), n = v.length; if (n < 5) return { ic: NaN, t: NaN, tAdj: NaN, days: n, pos: NaN };
  const m = v.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)), t = sd > 0 ? m / sd * Math.sqrt(n) : NaN;
  return { ic: m, t, tAdj: t / Math.sqrt(Math.max(1, h / STEP)), days: n, pos: v.filter(x => x > 0).length / n };
}

// ---------------- data ----------------
async function getDaily(s) {
  for (let a = 0; a < 3; a++) { try { const D = await U.daily(s); if (D && D.c && D.c.length) return D; } catch (e) { if (a === 2) return null; } await new Promise(r => setTimeout(r, 700 * (a + 1))); }
  return null;
}
const dayKey = t => Math.floor((t + 19800) / 86400);
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { console.error('stock', items[k], e.message); } } })); }

function universe() {
  let nse = null; try { nse = JSON.parse(fs.readFileSync(path.join(__dirname, '../www/nse.json'), 'utf8')); } catch (e) {}
  const cat = (nse && nse.cat) || {};
  let syms = Object.entries(cat).filter(([, v]) => ['L', 'M', 'S'].includes(v[0])).map(([k]) => k), src = 'Nifty 500 (nse.json cat L/M/S)';
  if (syms.length < 100) { syms = [...U.TRAIN, ...U.TEST]; src = 'tools/universe.js TRAIN+TEST (nse.json cat unavailable)'; }
  if (ENV.RESEARCH_SYMS) { syms = ENV.RESEARCH_SYMS.split(',').map(x => x.trim()).filter(Boolean); src = 'RESEARCH_SYMS'; }
  if (+ENV.UNIVERSE_MAX) syms = syms.slice(0, +ENV.UNIVERSE_MAX);
  return { syms, cat, src };
}

// collect rows. Horizon rows: X (features), rule/base score per hz, targets per hz. BTST rows: features, rule/base, next-day targets.
async function collect() {
  const U0 = universe(), syms = U0.syms;
  const idx = await getDaily('^NSEI');
  const champ = E.MODEL, champLin = BASE === 'app' ? (champ.lin || {}) : {}, champB = BASE === 'app' ? champ.btst : null;
  // previous bars recorded per row: enough for the largest smoothing window at bar n−1 (stability) and the champion's own smoothing
  const NLAG = Math.max(1, KV, ...HZS.map(hz => E.linK(champLin[hz])));
  // trading-day grid: Nifty's days (fallback: union of the first stocks' days)
  let grid = idx ? idx.t.map(dayKey) : null;
  const nifChg = new Map(); if (idx) for (let j = 1; j < idx.c.length; j++) nifChg.set(dayKey(idx.t[j]), (idx.c[j] / idx.c[j - 1] - 1) * 100);
  if (!grid) { const S = new Set(); for (const s of syms.slice(0, 20)) { const D = await getDaily(s); if (D) D.t.forEach(t => S.add(dayKey(t))); } grid = [...S].sort((a, b) => a - b); }
  const gidx = new Map(grid.map((d, k) => [d, k]));
  const H = { rows: [], names: [], col: new Map() }, B = { rows: [], names: [], col: new Map() };
  const colOf = (S, k) => { let j = S.col.get(k); if (j == null) { j = S.names.length; S.col.set(k, j); S.names.push(k); } return j; };
  for (const q of E.FEATS) colOf(H, q.k); // registry order first
  const stocks = []; let skipped = 0, budgetHit = false;
  await pool(syms, CONC, async (sym) => {
    if (Date.now() - T0 > BUDGET) { budgetHit = true; return; }
    const D = await getDaily(sym); if (!D || D.c.length < 400) { skipped++; return; }
    const si = stocks.length; stocks.push({ sym, sec: (U0.cat[sym] || [])[1] || '', cap: (U0.cat[sym] || [])[0] || '' });
    const I = E.indicators(D), m = idx ? E.alignMarket(D, idx) : null, n = D.c.length, C = D.c;
    const cache = new Map(), frame = j => { let f = cache.get(j); if (!f) { f = E.featuresAt(I, j, { m }); cache.set(j, f); } return f; }; // E.featuresAt = the phone's path
    for (let i = 252; i < n - 1; i++) {
      const g = gidx.get(dayKey(D.t[i])); if (g == null) continue;
      const c = C[i];
      if (g % STEP === 0) {
        for (const j of [...cache.keys()]) if (j < i - NLAG) cache.delete(j);
        const fr = []; for (let t = 0; t <= NLAG; t++) fr.push(frame(i - t));
        const Fs = fr.map(q => q.F), F = Fs[0], y = new Float32Array(16).fill(NaN);
        const rule = Float32Array.from(HZS, hz => fr[0].rule[hz]), rule1 = Float32Array.from(HZS, hz => fr[1].rule[hz]);
        const base = Float32Array.from(HZS, (hz, h) => champLin[hz] ? E.linScore(champLin[hz], Fs, rule[h]) : rule[h]);
        const base1 = Float32Array.from(HZS, (hz, h) => champLin[hz] ? E.linScore(champLin[hz], Fs.slice(1), rule1[h]) : rule1[h]);
        const A = E._atrAt(I, i, c);
        HZS.forEach((hz, h) => {
          const k = HZ[hz]; if (i + k >= n) return;
          const L = E._levels(I, i, hz, 1, 1e-9, c); let res = 0, px = NaN;
          for (let j = i + 1; j <= i + k; j++) {
            if (D.o[j] <= L.stop) { res = -1; px = D.o[j]; break; }
            if (D.l[j] <= L.stop) { res = -1; px = L.stop; break; }
            if (D.h[j] >= L.t1) { res = 1; px = Math.max(L.t1, D.o[j]); break; }
          }
          if (!res) px = C[i + k];
          y[h * 4] = (C[i + k] / c - 1) * 100; y[h * 4 + 1] = (C[i + k] - c) / A; y[h * 4 + 2] = res > 0 ? 1 : 0; y[h * 4 + 3] = (px / c - 1) * 100;
        });
        const x = new Float32Array(128).fill(NaN);
        for (const [k, v] of Object.entries(F)) { const j = colOf(H, k); if (j >= 128) throw new Error('too many features'); x[j] = v; }
        const xl = Fs.slice(1).map(Ft => { const a = new Float32Array(128).fill(NaN); for (const [k, v] of Object.entries(Ft)) { const j = colOf(H, k); if (j >= 128) throw new Error('too many features'); a[j] = v; } return a; });
        H.rows.push({ d: g, s: si, x, xl, rule, rule1, base, base1, y, cv: convRec(D, I, i) });
      }
      if (g % BSTEP === 0) {
        const ctx = { frac: 1, nifChg: nifChg.get(dayKey(D.t[i])) };
        const r = E.btstAt(D, I, i, null, ctx); if (!r) continue;
        const F = E.btstFeatures(D, I, i, null, ctx), x = new Float32Array(40).fill(NaN);
        for (const [k, v] of Object.entries(F)) { const j = colOf(B, k); if (j >= 40) throw new Error('too many btst features'); x[j] = v; }
        const rule = r.rule != null ? r.rule : r.score, base = champB ? E.linScore(champB, F, rule) : rule;
        let tv = 0; for (let j = i - 19; j <= i; j++) tv += C[j] * (D.v[j] || 0);
        B.rows.push({ d: g, s: si, x, rule, base, gap: (D.o[i + 1] / c - 1) * 100, cc: (C[i + 1] / c - 1) * 100, oc: (C[i + 1] / D.o[i + 1] - 1) * 100, liq: tv / 20 >= 5e7 ? 1 : 0 });
      }
    }
  });
  return { H, B, stocks, grid, idxOk: !!idx, skipped, budgetHit, src: U0.src, want: syms.length, NLAG };
}

// raw values the CONVICTION rules read — exactly the scan-row fields E.quick / analyze emit (price, e20, e50, e200, atr, rsi, turnover)
function convRec(D, I, i) { let s = 0, m = 0; for (let j = Math.max(0, i - 19); j <= i; j++) { s += D.c[j] * (D.v[j] || 0); m++; } return Float64Array.of(D.c[i], I.e20[i], I.e50[i], I.e200[i], I.atr[i], I.rsi[i], s / m); }

// add cross-sectional features (per day): momentum ranks, RS rank, sector momentum + its rank, breadth
function addXS(H, stocks) {
  const j = k => H.col.get(k), cm3 = j('mom3'), cm6 = j('mom6'), crs = j('rs3'), cd50 = j('d50');
  const out = ['xs.mom3R', 'xs.mom6R', 'xs.rs3R', 'xs.secMom3', 'xs.secMom3R', 'xs.breadth50'].map(k => j(k));
  const byDay = new Map(); for (const r of H.rows) { let a = byDay.get(r.d); if (!a) byDay.set(r.d, a = []); a.push(r); }
  for (const rows of byDay.values()) {
    const rk = (cj, oj) => { const v = rows.filter(r => ok(r.x[cj])); if (v.length < 5) return; const R = rankArr(v.map(r => r.x[cj])); v.forEach((r, k) => { r.x[oj] = R[k] / (v.length - 1); }); };
    rk(cm3, out[0]); rk(cm6, out[1]); rk(crs, out[2]);
    const sec = new Map(); for (const r of rows) { const s = stocks[r.s].sec; if (!s || !ok(r.x[cm3])) continue; const a = sec.get(s) || { s: 0, n: 0 }; a.s += r.x[cm3]; a.n++; sec.set(s, a); }
    const sm = [...sec.entries()].filter(([, a]) => a.n >= 3).map(([s, a]) => [s, a.s / a.n]), smR = rankArr(sm.map(x => x[1])), smap = new Map(sm.map((x, k) => [x[0], [x[1], sm.length > 1 ? smR[k] / (sm.length - 1) : 0.5]]));
    const br = rows.filter(r => ok(r.x[cd50])), b50 = br.length ? br.filter(r => r.x[cd50] > 0).length / br.length : NaN;
    for (const r of rows) { const q = smap.get(stocks[r.s].sec); if (q) { r.x[out[3]] = q[0]; r.x[out[4]] = q[1]; } r.x[out[5]] = b50; }
  }
}

// ---------------- dataset helpers ----------------
// DS: {rows sorted by day, NF, names, isF[], get(r, j) (f.* missing = 0), score/target accessors}
function dataset(S, NF) {
  S.rows.sort((a, b) => a.d - b.d || a.s - b.s);
  const names = S.names.slice(0, NF), isF = names.map(k => k.startsWith('f.'));
  const N = S.rows.length, X = new Float32Array(N * NF), NL = N && S.rows[0].xl ? S.rows[0].xl.length : 0, XL = Array.from({ length: NL }, () => new Float32Array(N * NF));
  const put = (A, x, i) => { for (let j = 0; j < NF; j++) { let v = x[j]; if (!ok(v) && isF[j]) v = 0; A[i * NF + j] = v; } };
  S.rows.forEach((r, i) => { put(X, r.x, i); r.x = null; for (let t = 0; t < NL; t++) put(XL[t], r.xl[t], i); r.xl = null; });
  const day = Int32Array.from(S.rows, r => r.d), stock = Int32Array.from(S.rows, r => r.s);
  // per-day centred ranks of every feature (NaN → 0 = middle): fast univariate rank-IC
  const XR = new Float32Array(N * NF);
  const groups = []; for (let a = 0; a < N;) { let b = a; while (b < N && day[b] === day[a]) b++; groups.push([a, b]); a = b; }
  for (const [a, b] of groups) for (let j = 0; j < NF; j++) {
    const ix = [], v = []; for (let i = a; i < b; i++) { const x = X[i * NF + j]; if (ok(x)) { ix.push(i); v.push(x); } }
    if (v.length < 3) continue; const R = rankArr(v); for (let k = 0; k < ix.length; k++) XR[ix[k] * NF + j] = R[k] / (v.length - 1) - 0.5;
  }
  return { N, NF, names, isF, X, XL, NL, XR, day, stock, groups, rows: S.rows };
}
// feature matrix of lag t (0 = the row's own bar, t = t bars earlier)
const xAt = (DS, t) => { if (!t) return DS.X; if (t > DS.NL) throw new Error(`lag ${t} not recorded (NLAG ${DS.NL})`); return DS.XL[t - 1]; };
// day-over-day stability of a score for the same stock: |score(bar n) − score(bar n−1)| over rows
function stab(rows, s0, s1) {
  const d = []; for (const i of rows) if (ok(s0[i]) && ok(s1[i])) d.push(Math.abs(s0[i] - s1[i]));
  d.sort((a, b) => a - b); const n = d.length;
  return { n, mean: n ? d.reduce((a, b) => a + b, 0) / n : NaN, med: quantile(d, 0.5), p90: quantile(d, 0.9), max: n ? d[n - 1] : NaN, gt10: n ? d.filter(x => x > 10).length / n : NaN };
}
function dayRank(DS, y) { // per-day centred rank of a target (NaN stays NaN)
  const out = new Float32Array(DS.N).fill(NaN);
  for (const [a, b] of DS.groups) { const ix = [], v = []; for (let i = a; i < b; i++) if (ok(y[i])) { ix.push(i); v.push(y[i]); } if (v.length < 3) continue; const R = rankArr(v); for (let k = 0; k < ix.length; k++) out[ix[k]] = R[k] / (v.length - 1) - 0.5; }
  return out;
}
// subset = sorted row indices; split into day groups
function dayGroups(DS, sub) { const g = []; for (let a = 0; a < sub.length;) { let b = a; while (b < sub.length && DS.day[sub[b]] === DS.day[sub[a]]) b++; g.push(sub.slice(a, b)); a = b; } return g; }
const rangeIdx = (DS, pred) => { const o = []; for (let i = 0; i < DS.N; i++) if (pred(i)) o.push(i); return o; };
// univariate IC from precomputed ranks (Pearson of per-day ranks ≈ Spearman)
function featIC(DS, sub, j, yr, h) {
  const ics = [];
  for (const g of dayGroups(DS, sub)) { const a = [], b = []; for (const i of g) if (ok(yr[i])) { a.push(DS.XR[i * DS.NF + j]); b.push(yr[i]); } if (a.length >= 15) ics.push(pearson(a, b)); }
  return icStats(ics, h);
}
// exact per-day Spearman of a score vs a target
function scoreIC(DS, sub, sc, y, h) {
  const ics = [];
  for (const g of dayGroups(DS, sub)) { const a = [], b = []; for (const i of g) if (ok(y[i]) && ok(sc[i])) { a.push(sc[i]); b.push(y[i]); } if (a.length >= 15) ics.push(spearman(a, b)); }
  return icStats(ics, h);
}
// portfolio stats per day, averaged over days: top / bottom decile and "buy the top 10 liquid" (after cost), excess vs the day's universe
function portStats(DS, sub, sc, T, cost, liq) {
  const acc = () => ({ r: 0, h: 0, tr: 0, ex: 0, beat: 0, n: 0, hn: 0, trn: 0 });
  const top = acc(), bot = acc(), t10 = acc(), all = acc();
  const add = (A, rows, mu) => { if (!rows.length) return; let r = 0, h = 0, hn = 0, tr = 0, trn = 0; for (const i of rows) { r += T.ret[i]; if (T.hit && ok(T.hit[i])) { h += T.hit[i]; hn++; } if (T.trade && ok(T.trade[i])) { tr += T.trade[i]; trn++; } }
    r /= rows.length; A.r += r; A.ex += r - mu; A.beat += r > mu ? 1 : 0; A.n++; if (hn) { A.h += h / hn; A.hn++; } if (trn) { A.tr += tr / trn; A.trn++; } };
  for (const g0 of dayGroups(DS, sub)) {
    const g = g0.filter(i => ok(T.ret[i]) && ok(sc[i])); if (g.length < 20) continue;
    const mu = g.reduce((a, i) => a + T.ret[i], 0) / g.length; add(all, g, mu);
    const s = g.slice().sort((a, b) => sc[b] - sc[a]), k = Math.max(1, Math.floor(g.length / 10));
    add(top, s.slice(0, k), mu); add(bot, s.slice(-k), mu); add(t10, s.filter(i => liq(i)).slice(0, 10), mu);
  }
  const fin = A => ({ ret: A.n ? A.r / A.n : NaN, ac: A.n ? A.r / A.n - cost : NaN, ex: A.n ? A.ex / A.n : NaN, beat: A.n ? A.beat / A.n : NaN, hit: A.hn ? A.h / A.hn : NaN, trade: A.trn ? A.tr / A.trn - cost : NaN, days: A.n });
  return { top: fin(top), bot: fin(bot), t10: fin(t10), all: fin(all) };
}
// score bands (cumulative and per band) for thresholds: mean ret after cost, excess vs the day universe (pooled rows)
function bands(DS, sub, sc, T, cost) {
  const dayMu = new Map(); for (const g of dayGroups(DS, sub)) { const v = g.filter(i => ok(T.ret[i])); if (v.length) dayMu.set(DS.day[g[0]], v.reduce((a, i) => a + T.ret[i], 0) / v.length); }
  const edges = [0, ...CUTS, 101], B = edges.slice(0, -1).map((lo, k) => ({ lo, hi: edges[k + 1], n: 0, r: 0, ex: 0, h: 0, hn: 0, up: 0 }));
  for (const i of sub) { if (!ok(T.ret[i]) || !ok(sc[i])) continue; const b = B.find(x => sc[i] >= x.lo && sc[i] < x.hi); if (!b) continue; b.n++; b.r += T.ret[i]; b.ex += T.ret[i] - dayMu.get(DS.day[i]); b.up += T.ret[i] > 0; if (T.hit && ok(T.hit[i])) { b.h += T.hit[i]; b.hn++; } }
  const st = bs => { const n = bs.reduce((a, b) => a + b.n, 0); return { n, ac: n ? bs.reduce((a, b) => a + b.r, 0) / n - cost : NaN, ex: n ? bs.reduce((a, b) => a + b.ex, 0) / n : NaN, hit: bs.reduce((a, b) => a + b.hn, 0) ? bs.reduce((a, b) => a + b.h, 0) / bs.reduce((a, b) => a + b.hn, 0) : NaN }; };
  return { B, above: c => st(B.filter(b => b.lo >= c)), below: c => st(B.filter(b => b.hi <= c)), band: (a, b) => st(B.filter(x => x.lo >= a && x.hi <= b)) };
}
// calibration bins for the app's "track record" (E.calibBins): hit T1 first, avg return, % up
function calibBins(DS, sub, sc, T) {
  const Bn = E.calibBins, bins = Bn.slice(0, -1).map((lo, k) => ({ lo, hi: Bn[k + 1], n: 0, h: 0, r: 0, u: 0 }));
  for (const i of sub) { if (!ok(T.ret[i]) || !ok(sc[i]) || !ok(T.hit[i])) continue; const b = bins[E.binOf(sc[i])]; b.n++; b.h += T.hit[i]; b.r += T.ret[i]; b.u += T.ret[i] > 0; }
  return bins.filter(b => b.n >= 20).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, p: +(b.h / b.n).toFixed(3), ret: +(b.r / b.n).toFixed(2), up: +(b.u / b.n).toFixed(3) }));
}

// ---------------- model fit ----------------
function normParams(DS, sub, cols) {
  return cols.map(j => {
    const v = []; const stepS = Math.max(1, Math.floor(sub.length / 60000));
    for (let k = 0; k < sub.length; k += stepS) { const x = DS.X[sub[k] * DS.NF + j]; if (ok(x)) v.push(x); }
    v.sort((a, b) => a - b); const lo = quantile(v, 0.01), hi = quantile(v, 0.99);
    let m = 0, s = 0, n = 0; for (const x of v) { const c = Math.min(hi, Math.max(lo, x)); m += c; n++; } m /= Math.max(1, n);
    for (const x of v) { const c = Math.min(hi, Math.max(lo, x)); s += (c - m) ** 2; } s = Math.sqrt(s / Math.max(1, n - 1));
    return { j, k: DS.names[j], lo: ok(lo) ? lo : 0, hi: ok(hi) ? hi : 0, mu: ok(m) ? m : 0, sd: s > 1e-9 ? s : 1, cov: v.length * stepS / sub.length };
  });
}
// z-features; k > 1 = mean of the z-features over the row's last k bars (the smoothed model is linear in them: mean of the raw
// output over k bars = intercept + w · mean z, so the ridge is fitted on exactly what E.linScore averages)
function zRows(DS, rows, P, k = 1) {
  const p = P.length, Z = new Float64Array(rows.length * p), Xs = Array.from({ length: k }, (_, t) => xAt(DS, t));
  rows.forEach((i, r) => { for (let q = 0; q < p; q++) { const c = P[q]; let s = 0; for (let t = 0; t < k; t++) s += E.zFeat(c.k, Xs[t][i * DS.NF + c.j], c.lo, c.hi, c.mu, c.sd); Z[r * p + q] = k === 1 ? s : s / k; } });
  return Z;
}
function predict(DS, rows, P, w, b, k = 1, lag0 = 0) {
  const out = new Float64Array(DS.N).fill(NaN), Xs = Array.from({ length: k }, (_, t) => xAt(DS, lag0 + t));
  for (const i of rows) { let acc = 0; for (let t = 0; t < k; t++) { let s = b; for (let q = 0; q < P.length; q++) { const c = P[q]; s += w[q] * E.zFeat(c.k, Xs[t][i * DS.NF + c.j], c.lo, c.hi, c.mu, c.sd); } acc += s; } out[i] = acc / k; }
  return out;
}
const meanSd = (arr, rows) => { let m = 0, n = 0; for (const i of rows) if (ok(arr[i])) { m += arr[i]; n++; } m /= Math.max(1, n); let s = 0; for (const i of rows) if (ok(arr[i])) s += (arr[i] - m) ** 2; return [m, Math.sqrt(s / Math.max(1, n - 1)) || 1]; };
// split a sorted subset by time at quantile q of its days, with an embargo of `emb` grid days before the split
function timeSplit(DS, sub, q, emb) { const days = [...new Set(sub.map(i => DS.day[i]))]; const cut = days[Math.floor(days.length * q)]; return [sub.filter(i => DS.day[i] < cut - emb), sub.filter(i => DS.day[i] >= cut)]; }

// fit on `train`: returns engine-format L (+ diag). opt.cols forces the candidate feature list.
function fitModel(DS, train, tg, h, opt = {}) {
  const sub = train.filter(i => ok(tg.yr[i]));
  const k = opt.k || 1, excl = new Set(opt.excl || []);
  let cand = opt.cols || DS.names.map((k, j) => j).filter(j => SCOPE.has(E.featScope(DS.names[j])) && !tg.exclude.has(DS.names[j]) && !excl.has(DS.names[j]));
  let P = normParams(DS, sub, cand).filter(c => c.cov >= 0.6 && c.hi > c.lo);
  // feature selection: same IC sign in both halves of the training window
  const [h1, h2] = timeSplit(DS, sub, 0.5, h), sel = [];
  if (!opt.cols) {
    for (const c of P) { const a = featIC(DS, h1, c.j, tg.yr, h), b = featIC(DS, h2, c.j, tg.yr, h); c.ic1 = a.ic; c.ic2 = b.ic; if (ok(a.ic) && ok(b.ic) && Math.sign(a.ic) === Math.sign(b.ic) && Math.min(Math.abs(a.ic), Math.abs(b.ic)) >= 0.003) sel.push(c); }
    if (sel.length < 3) P = P.slice().sort((a, b) => Math.abs((b.ic1 || 0) + (b.ic2 || 0)) - Math.abs((a.ic1 || 0) + (a.ic2 || 0))).slice(0, 5); else P = sel;
  }
  if (!P.length) return null;
  const p = P.length;
  // inner time split for lambda + blend
  const [it, iv] = timeSplit(DS, sub, 0.7, h);
  let best = { lam: 1, ic: -Infinity, blend: 1 };
  if (it.length > 200 && iv.length > 100) {
    const G = gram(zRows(DS, it, P, k), Float64Array.from(it, i => tg.yr[i]), it.length, p);
    for (const lam of LAMS) { const m = ridgeG(G, lam), pr = predict(DS, iv, P, m.w, m.b, k), s = scoreIC(DS, iv, pr, tg.y, h); if (ok(s.ic) && s.ic > best.ic) best = { lam, ic: s.ic, m }; }
    if (best.m) {
      const prT = predict(DS, it, P, best.m.w, best.m.b, k), [mm, ms] = meanSd(prT, it), [rm, rs] = meanSd(tg.rule, it), prV = predict(DS, iv, P, best.m.w, best.m.b, k);
      const prV1 = opt.shrink ? predict(DS, iv, P, best.m.w, best.m.b, k, 1) : null;
      let bb = { b: 1, ic: -Infinity }; const cands = [];
      for (const bl of BLENDS) {
        const sc = new Float64Array(DS.N).fill(NaN); for (const i of iv) sc[i] = bl * (prV[i] - mm) / ms + (1 - bl) * (tg.rule[i] - rm) / rs; const s = scoreIC(DS, iv, sc, tg.y, h); if (ok(s.ic) && s.ic > bb.ic + 1e-4) bb = { b: bl, ic: s.ic };
        if (opt.shrink && ok(s.ic)) { // instability of the blended raw value at bar n vs n−1, in units of its cross-sectional sd
          let d = 0, nd = 0; for (const i of iv) { const v1 = bl * (prV1[i] - mm) / ms + (1 - bl) * (tg.rule1[i] - rm) / rs; if (ok(v1) && ok(sc[i])) { d += Math.abs(sc[i] - v1); nd++; } }
          cands.push({ b: bl, ic: s.ic, ins: nd ? d / nd / meanSd(sc, iv)[1] : Infinity });
        }
      }
      if (opt.shrink && bb.ic > 0) { const c = cands.filter(x => x.ic >= IC_TOL * bb.ic).sort((a, b) => a.ins - b.ins || b.ic - a.ic)[0]; if (c) bb = { b: c.b, ic: c.ic }; }
      best.blend = bb.b; best.blendIC = bb.ic;
    }
  }
  const m = ridge(zRows(DS, sub, P, k), Float64Array.from(sub, i => tg.yr[i]), sub.length, p, best.lam);
  const pr = predict(DS, sub, P, m.w, m.b, k), [mmu, msd] = meanSd(pr, sub), [rmu, rsd] = meanSd(tg.rule, sub);
  // calibration: quantiles of the blended raw value → the same quantiles of the current app score (lists keep their size)
  const raw = [], base = [];
  for (const i of sub) { raw.push(best.blend * (pr[i] - mmu) / msd + (1 - best.blend) * (tg.rule[i] - rmu) / rsd); base.push(tg.base[i]); }
  raw.sort((a, b) => a - b); base.sort((a, b) => a - b);
  const Q = Array.from({ length: 41 }, (_, k) => k / 40), cx = Q.map(q => +quantile(raw, q).toFixed(5)), cy = Q.map(q => +quantile(base, q).toFixed(2));
  for (let k = 1; k < cx.length; k++) if (cx[k] < cx[k - 1]) cx[k] = cx[k - 1];
  for (let k = 1; k < cy.length; k++) if (cy[k] < cy[k - 1]) cy[k] = cy[k - 1];
  const r6 = x => +x.toFixed(6);
  const L = { features: P.map(c => c.k), weights: m.w.map(r6), intercept: r6(m.b), mu: P.map(c => r6(c.mu)), sd: P.map(c => r6(c.sd)), lo: P.map(c => r6(c.lo)), hi: P.map(c => r6(c.hi)),
    mmu: r6(mmu), msd: r6(msd), rmu: r6(rmu), rsd: r6(rsd), blend: best.blend, cal: { x: cx, y: cy }, lambda: best.lam };
  if (k > 1) L.smooth = k; // absent = single bar (backward compatible)
  return { L, P, diag: { lam: best.lam, innerIC: best.ic, blend: best.blend, blendIC: best.blendIC, nTrain: sub.length, nFeat: p } };
}
// score rows with an engine-format model — exactly E.linScore's math (same expression order). lag0 = 1 scores every row as of its
// previous bar (rule must then be the previous bar's rule score). Smoothed models (L.smooth = k) average the raw output over lags
// lag0 … lag0+k−1, like the engine over frames [F(i), F(i−1), …].
function scoreRows(DS, rows, L, rule, lag0 = 0) {
  const cols = L.features.map(k => DS.names.indexOf(k)), out = new Float64Array(DS.N).fill(NaN), k = E.linK(L), Xs = Array.from({ length: k }, (_, t) => xAt(DS, lag0 + t));
  for (const i of rows) {
    let acc = 0;
    for (let t = 0; t < k; t++) { const X = Xs[t]; let s = L.intercept || 0; for (let q = 0; q < cols.length; q++) s += L.weights[q] * E.zFeat(L.features[q], cols[q] >= 0 ? X[i * DS.NF + cols[q]] : NaN, L.lo[q], L.hi[q], L.mu[q], L.sd[q]); acc += s; }
    const m = (acc / k - L.mmu) / L.msd, r = (rule[i] - L.rmu) / L.rsd, raw = L.blend * m + (1 - L.blend) * r;
    out[i] = Math.round(Math.max(0, Math.min(100, E.calMap(L.cal, raw))));
  }
  return out;
}
function parity(DS, L, rule, rows, lag0 = 0) { // engine E.linScore on reconstructed feature objects (frames for smoothed models) == research scoring
  const sc = scoreRows(DS, rows, L, rule, lag0), k = E.linK(L); let bad = 0;
  for (const i of rows) {
    const Fs = []; for (let t = 0; t < k; t++) { const X = xAt(DS, lag0 + t), F = {}; DS.names.forEach((nm, j) => { F[nm] = X[i * DS.NF + j]; }); Fs.push(F); }
    if (E.linScore(L, k === 1 ? Fs[0] : Fs, rule[i]) !== sc[i]) bad++;
  }
  return bad;
}

// thresholds from OOS bands of BOTH folds (BUY searched in 54–85, SELL in 20–46 so a HOLD band always remains): BUY = lowest cut where (score ≥ cut) and the band just above it beat the universe and are
// positive after costs in both folds; SELL = highest cut where (score < cut) lags the universe and loses money (or lags by > cost) in both
function pickThresholds(BF) {
  let buy = null, sell = null;
  for (let k = 0; k < CUTS.length; k++) {
    const c = CUTS[k]; if (c < 54) continue; const nx = CUTS[k + 1] || 101;
    if (BF.every(B => { const a = B.above(c), bd = B.band(c, nx); return a.n >= 100 && a.ac > 0 && a.ex > 0 && (bd.n < 50 || (bd.ex > 0 && bd.ac > 0)); })) { buy = c; break; }
  }
  for (let k = CUTS.length - 1; k >= 0; k--) {
    const c = CUTS[k]; if (c > 46) continue;
    if (BF.every(B => { const a = B.below(c); return a.n >= 100 && a.ex < 0 && (a.ac < 0 || a.ex < -COST); })) { sell = c; break; }
  }
  return { buy, sell };
}

// ---------------- report helpers ----------------
function evalAll(DS, sub, sc, tg, h, cost, liq) { return { ic: scoreIC(DS, sub, sc, tg.y, h), icRet: tg.retY ? scoreIC(DS, sub, sc, tg.retY, h) : null, p: portStats(DS, sub, sc, tg.T, cost, liq) }; }
function line(name, ev) {
  const P = ev.p;
  return `${pad(name, 22)} IC ${f3(ev.ic.ic)} (t ${lpad(ok(ev.ic.tAdj) ? ev.ic.tAdj.toFixed(1) : 'n/a', 5)}, ${pc(ev.ic.pos)} days>0)  top10% ${f2(P.top.ret)}% → after cost ${f2(P.top.ac)}%  hit ${pc(P.top.hit)}  trade ${f2(P.top.trade)}%  vs universe ${f2(P.top.ex)}  | bottom10% ${f2(P.bot.ret)}%  | buy-top-10 ${f2(P.t10.ac)}% after cost, beat universe ${pc(P.t10.beat)} of days`;
}

// ---------------- main ----------------
async function main() {
  let model = {}; try { model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); } catch (e) {}
  E.setModel(Object.assign({}, model, { v: model.v || 1 })); // champion factor weights + setup stats, exactly what the app runs
  log(`DayTrader Desk — stock research report · ${new Date().toISOString().slice(0, 16)}Z · model.json v${model.v || 0}`);
  log(`Honest-numbers note: everything below is a BACKTEST on historical daily bars (walk-forward, out-of-sample where marked), not live results.`);
  const C = await collect();
  log(`Universe: ${C.src} · ${C.stocks.length}/${C.want} stocks used (${C.skipped} skipped: <400 bars or fetch failed${C.budgetHit ? '; time budget hit — rest skipped' : ''}) · Nifty ${C.idxOk ? 'ok' : 'UNAVAILABLE (mkt features empty)'}`);
  log(`Rows: ${C.H.rows.length} stock-days (every ${STEP} trading days) · ${C.B.rows.length} BTST stock-days (every ${BSTEP}) · collection ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  log(`Costs: ${COST}% round trip (multi-day) · ${BCOST}% BTST · baseline = ${BASE === 'app' ? 'current app horizon score (learned model where model.json has one, else the rule score; E.hzRating\'s regime/news/backtest nudges excluded)' : 'rule score'} · adoptable scopes: ${[...SCOPE].join(', ')}`);
  if (C.H.rows.length < 2000) { log('Not enough rows for research — nothing written.'); return finish(model, {}, null, C); }
  addXS(C.H, C.stocks);
  const DS = dataset(C.H, C.H.names.length);
  const days = [...new Set(DS.day)], nd = days.length, dayAt = q => days[Math.min(nd - 1, Math.floor(nd * q))];
  const half = C.stocks.map(s => { let hsh = 0; for (const ch of s.sym) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0; return hsh % 2; });
  const liqJ = DS.names.indexOf('turn'), liq = i => DS.X[i * DS.NF + liqJ] >= LIQ;
  const s1 = dayAt(0.6), s2 = dayAt(0.8);
  const fmtDay = g => { const d = C.grid[g]; return d != null ? new Date(d * 86400e3).toISOString().slice(0, 10) : '?'; };
  log(`Folds (embargo = horizon): F1 train < ${fmtDay(s1)} → test ≥ ${fmtDay(s1)} · F2 train < ${fmtDay(s2)} → test ≥ ${fmtDay(s2)} · stock split: F1 years, train on one half of the stocks, test on the other half`);

  const adopted = {}, newLin = {}, newTh = {}, summary = {}, CV = {}; // CV: per-horizon inputs of the CONVICTION section
  log(`Stability variants for ${[...VHZ].join(', ') || '(none)'}: ${VARIANTS.map(v => v.name).join(', ')} · previous bars recorded per row: ${C.NLAG}`);
  const featRows = []; // per feature IC summary
  for (const hz of HZS) {
    const h = HZ[hz], hi = HZS.indexOf(hz);
    const T = { ret: Float32Array.from(DS.rows, r => r.y[hi * 4]), atr: Float32Array.from(DS.rows, r => r.y[hi * 4 + 1]), hit: Float32Array.from(DS.rows, r => r.y[hi * 4 + 2]), trade: Float32Array.from(DS.rows, r => r.y[hi * 4 + 3]) };
    T.hit = T.hit.map((x, i) => ok(T.ret[i]) ? x : NaN);
    const tg = { y: T.atr, yr: dayRank(DS, T.atr), retY: T.ret, T, rule: Float32Array.from(DS.rows, r => r.rule[hi]), base: Float32Array.from(DS.rows, r => r.base[hi]), exclude: new Set(),
      rule1: Float32Array.from(DS.rows, r => r.rule1[hi]), base1: Float32Array.from(DS.rows, r => r.base1[hi]) };
    const all = rangeIdx(DS, i => ok(T.atr[i]));
    const F1tr = all.filter(i => DS.day[i] < s1 - h), F1te = all.filter(i => DS.day[i] >= s1), F2tr = all.filter(i => DS.day[i] < s2 - h), F2te = all.filter(i => DS.day[i] >= s2);
    const F3tr = F1tr.filter(i => half[DS.stock[i]] === 0), F3te = F1te.filter(i => half[DS.stock[i]] === 1);
    CV[hz] = { h, T, rule: tg.rule, base: tg.base, all, folds: { F1: [F1tr, F1te], F2: [F2tr, F2te] }, adopted: false };
    log(`\n==================== ${hz.toUpperCase()} · ${h} trading days · ${all.length} rows ====================`);
    // feature IC table rows (full sample + fold stability)
    for (let j = 0; j < DS.NF; j++) {
      const a = featIC(DS, all, j, tg.yr, h), b = featIC(DS, F1tr, j, tg.yr, h), c = featIC(DS, F1te, j, tg.yr, h), d = featIC(DS, F2te, j, tg.yr, h);
      const fr = featRows[j] = featRows[j] || { k: DS.names[j], scope: E.featScope(DS.names[j]), hz: {} };
      fr.hz[hz] = { ic: a.ic, t: a.tAdj, stable: [b.ic, c.ic, d.ic].every(ok) && Math.sign(b.ic) === Math.sign(c.ic) && Math.sign(c.ic) === Math.sign(d.ic) };
    }
    // folds — every variant (only `base` outside VARIANT_HZ); the baselines' fold evaluations are shared
    const folds = [['F1', F1tr, F1te], ['F2', F2tr, F2te], ['stock-split', F3tr, F3te]], VS = VHZ.has(hz) ? VARIANTS : VARIANTS.slice(0, 1), RV = {}, FE = {};
    const champLearned = BASE === 'app' && Object.keys(E.MODEL.lin || {}).includes(hz);
    for (const v of VS) {
      const R = RV[v.name] = {};
      if (v.name !== 'base') log(`\n-- variant ${v.name}: ${v.d} --`);
      for (const [nm, tr, te] of folds) {
        if (tr.length < 500 || te.length < 200) { if (v.name === 'base') log(`${nm}: not enough rows (train ${tr.length}, test ${te.length})`); continue; }
        const fit = fitModel(DS, tr, tg, h, { k: v.k, excl: v.excl, shrink: v.shrink }); if (!fit) { log(`${nm} [${v.name}]: no usable features`); continue; }
        const fe = FE[nm] = FE[nm] || { eb: evalAll(DS, te, tg.base, tg, h, COST, liq), er: champLearned || VHZ.has(hz) ? evalAll(DS, te, tg.rule, tg, h, COST, liq) : null,
          Bb: bands(DS, te, tg.base, T, COST), stR: stab(te, tg.rule, tg.rule1), stB: stab(te, tg.base, tg.base1) };
        const sc = scoreRows(DS, te, fit.L, tg.rule), sc1 = scoreRows(DS, te, fit.L, tg.rule1, 1);
        const em = evalAll(DS, te, sc, tg, h, COST, liq);
        R[nm] = { fit, sc, te, em, eb: fe.eb, er: fe.er, st: stab(te, sc, sc1), B: bands(DS, te, sc, T, COST), Bb: fe.Bb, stR: fe.stR, stB: fe.stB };
        if (v.name === 'base') {
          log(`\n${nm}: train ${tr.length} rows → test ${te.length} rows · ${fit.diag.nFeat} features · lambda ${fit.diag.lam} · blend model/rule ${fit.diag.blend}/${(1 - fit.diag.blend).toFixed(2)} (inner IC ${f3(fit.diag.innerIC)})`);
          log('  ' + line('model (OOS)', R[nm].em)); log('  ' + line('current app score', fe.eb)); if (fe.er) log('  ' + line('rule score only', fe.er));
        } else log('  ' + line(`${nm} ${fit.diag.nFeat}f b${fit.diag.blend}`, em));
      }
    }
    let R = RV.base;
    if (!R.F1 || !R.F2) { log(`${hz}: folds incomplete — not adopted.`); summary[hz] = { adopted: false, reason: 'folds incomplete' }; continue; }
    let pass, vPick = VARIANTS[0];
    if (!VHZ.has(hz)) {
      const gate = ['F1', 'F2'].map(f => ({ f, ic: R[f].em.ic.ic > R[f].eb.ic.ic + MIN_IC_GAIN && R[f].em.ic.ic > 0, top: R[f].em.p.top.ac > R[f].eb.p.top.ac }));
      const sig = R.F1.em.ic.tAdj >= MIN_T; pass = gate.every(g => g.ic && g.top) && sig;
      log(`\nGATE ${hz}: ${gate.map(g => `${g.f} IC ${g.ic ? 'beats' : 'does NOT beat'} baseline, top-decile after cost ${g.top ? 'beats' : 'does NOT beat'}`).join(' · ')} · F1 OOS t ${ok(R.F1.em.ic.tAdj) ? R.F1.em.ic.tAdj.toFixed(1) : 'n/a'} ${sig ? '≥' : '<'} ${MIN_T} → ${pass ? 'PASS' : 'FAIL'}${!pass && FORCE ? ' (RESEARCH_FORCE: writing anyway — testing only)' : ''}`);
    } else {
      // stability selection: eligible = beats the RULE score in both folds (IC + MIN_IC_GAIN, top decile after cost; F1 t ≥ MIN_T) and is
      // not materially worse than the base variant (IC ≥ IC_TOL × base, top decile ≥ base − TOP_TOL) → the most stable eligible one
      const ref = RV.base, el = {}; let parBad = 0, parN = 0;
      for (const v of VS) {
        const Rv = RV[v.name], why = [];
        if (!Rv.F1 || !Rv.F2) why.push('folds incomplete');
        else {
          for (const f of ['F1', 'F2']) {
            const m = Rv[f].em, r = Rv[f].er, b = ref[f].em;
            if (!(m.ic.ic > r.ic.ic + MIN_IC_GAIN && m.ic.ic > 0)) why.push(`${f} IC ≤ rule`);
            if (!(m.p.top.ac > r.p.top.ac)) why.push(`${f} top ≤ rule`);
            if (!(m.ic.ic >= b.ic.ic - Math.abs(b.ic.ic) * (1 - IC_TOL))) why.push(`${f} IC < ${IC_TOL}×base`);
            if (!(m.p.top.ac >= b.p.top.ac - TOP_TOL)) why.push(`${f} top < base−${TOP_TOL}`);
          }
          if (!(Rv.F1.em.ic.tAdj >= MIN_T)) why.push(`F1 t < ${MIN_T}`);
          // engine parity on the smoothed path too: this variant's F2 model, scored at bar n and at bar n−1
          const smp = Rv.F2.te.filter((_, q) => q % Math.max(1, Math.floor(Rv.F2.te.length / 150)) === 0), bad = parity(DS, Rv.F2.fit.L, tg.rule, smp) + parity(DS, Rv.F2.fit.L, tg.rule1, smp, 1);
          parBad += bad; parN += 2 * smp.length; if (bad) why.push(`PARITY ${bad} MISMATCHES`);
        }
        el[v.name] = { ok: !why.length, why, ins: Rv.F1 && Rv.F2 ? (Rv.F1.st.mean + Rv.F2.st.mean) / 2 : Infinity, minIC: Rv.F1 && Rv.F2 ? Math.min(Rv.F1.em.ic.ic, Rv.F2.em.ic.ic) : -Infinity };
      }
      const okV = VS.filter(v => el[v.name].ok).sort((a, b) => (Math.abs(el[a.name].ins - el[b.name].ins) < 0.05 ? el[b.name].minIC - el[a.name].minIC : el[a.name].ins - el[b.name].ins));
      pass = okV.length > 0; if (pass) { vPick = okV[0]; R = RV[vPick.name]; }
      else if (FORCE && ENV.RESEARCH_FORCE_VARIANT && RV[ENV.RESEARCH_FORCE_VARIANT] && RV[ENV.RESEARCH_FORCE_VARIANT].F2) { vPick = VS.find(v => v.name === ENV.RESEARCH_FORCE_VARIANT); R = RV[vPick.name]; } // testing only
      // STABILITY table (report section + per-horizon copy)
      const sl = x => x ? `${lpad(x.mean.toFixed(1), 5)} ${lpad(x.med.toFixed(0), 3)} ${lpad(x.p90.toFixed(0), 3)} ${lpad(pc(x.gt10), 4)}` : lpad('n/a', 20);
      const S = [`STABILITY ${hz} — |score(bar n) − score(bar n−1)|, same stock, OOS test rows (= the drop-last-bar test): mean med p90 %>10pts · F1 test | F2 test · OOS IC and top-decile after cost F1 / F2`,
        `   ${pad('variant', 11)} ${pad('k', 2)} ${pad('F1: mean med p90 >10', 21)} | ${pad('F2: mean med p90 >10', 21)} | ${pad('IC F1 / F2', 16)} | ${pad('top10% a.c. F1 / F2', 19)} | verdict`,
        `   ${pad('rule score', 11)} ${pad('-', 2)} ${sl(ref.F1.stR)} | ${sl(ref.F2.stR)} | ${f3(ref.F1.er.ic.ic)} / ${f3(ref.F2.er.ic.ic)} | ${f2(ref.F1.er.p.top.ac)}% / ${f2(ref.F2.er.p.top.ac)}% | reference`,
        `   ${pad('current app', 11)} ${pad(String(E.linK((E.MODEL.lin || {})[hz])), 2)} ${sl(ref.F1.stB)} | ${sl(ref.F2.stB)} | ${f3(ref.F1.eb.ic.ic)} / ${f3(ref.F2.eb.ic.ic)} | ${f2(ref.F1.eb.p.top.ac)}% / ${f2(ref.F2.eb.p.top.ac)}% | ${champLearned ? 'learned champion: fitted on ALL rows last run, so in-sample on these test years — shown, not gated on' : 'baseline = rule'}`];
      for (const v of VS) {
        const Rv = RV[v.name], e = el[v.name]; if (!Rv.F1 || !Rv.F2) { S.push(`   ${pad(v.name, 11)} folds incomplete`); continue; }
        S.push(`   ${pad(v.name, 11)} ${pad(String(v.k), 2)} ${sl(Rv.F1.st)} | ${sl(Rv.F2.st)} | ${f3(Rv.F1.em.ic.ic)} / ${f3(Rv.F2.em.ic.ic)} | ${f2(Rv.F1.em.p.top.ac)}% / ${f2(Rv.F2.em.p.top.ac)}% | ${v === vPick && pass ? 'ADOPT' : e.ok ? 'eligible' : 'no: ' + e.why.join(', ')}`);
      }
      S.push(`   tolerance: IC ≥ ${IC_TOL}× base and top-decile after cost ≥ base − ${TOP_TOL}%-pts in both folds, and beat the rule score in both folds (F1 t ≥ ${MIN_T}); pick = lowest mean day-over-day change (F1+F2)`);
      S.push(`   engine parity (E.linScore vs research, every variant's F2 model, bar n and bar n−1): ${parN} rows, ${parBad ? parBad + ' MISMATCHES' : 'all match'}`);
      S.push(`   → ${pass ? `${vPick.name} (${vPick.d})` : 'no variant qualifies — keep current'}`);
      S.forEach(x => log(x)); STAB.push('', ...S);
      summary[hz + '_el'] = el;
      log(`\nGATE ${hz}: ${pass ? `PASS with variant ${vPick.name}` : 'FAIL (no variant beats the rule score in both folds within tolerance)'}${!pass && FORCE ? ' (RESEARCH_FORCE: writing anyway — testing only)' : ''}`);
    }
    // production model: refit on all rows with features selected in both folds (fallback: F2's)
    const s1f = new Set(R.F1.fit.L.features), both = R.F2.fit.L.features.filter(k => s1f.has(k));
    const cols = (both.length >= 3 ? both : R.F2.fit.L.features).map(k => DS.names.indexOf(k));
    const prod = fitModel(DS, all, tg, h, { cols, k: vPick.k });
    prod.L.blend = R.F2.fit.L.blend; // blend from the inner validation of the most recent fold; refit cal with it
    { const pr = predict(DS, all, prod.P, prod.L.weights, prod.L.intercept, vPick.k), raw = [], base = []; for (const i of all) { raw.push(prod.L.blend * (pr[i] - prod.L.mmu) / prod.L.msd + (1 - prod.L.blend) * (tg.rule[i] - prod.L.rmu) / prod.L.rsd); base.push(tg.base[i]); }
      raw.sort((a, b) => a - b); base.sort((a, b) => a - b); const Q = Array.from({ length: 41 }, (_, k) => k / 40); prod.L.cal = { x: Q.map(q => +quantile(raw, q).toFixed(5)), y: Q.map(q => +quantile(base, q).toFixed(2)) };
      for (let k = 1; k < 41; k++) { if (prod.L.cal.x[k] < prod.L.cal.x[k - 1]) prod.L.cal.x[k] = prod.L.cal.x[k - 1]; if (prod.L.cal.y[k] < prod.L.cal.y[k - 1]) prod.L.cal.y[k] = prod.L.cal.y[k - 1]; } }
    log(`\nProduction weights (${hz}${VHZ.has(hz) ? ` · variant ${vPick.name}${vPick.k > 1 ? `, score = mean over ${vPick.k} bars` : ''}` : ''}${pass ? '' : ', NOT adopted'}; refit on all rows; effect of +1 sd of the feature on the model, in model sd; + = bullish):`);
    prod.L.features.map((k, q) => [k, prod.L.weights[q] / prod.L.msd]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).forEach(([k, w]) => log(`   ${f3(w)}  ${pad(k, 44)} ${E.featScope(k) === 'stock' ? '' : '[' + E.featScope(k) + ']'} ${(E.FEATS.find(q => q.k === k) || {}).lbl || ''}`));
    log(`   intercept ${f3(prod.L.intercept)} · blend ${prod.L.blend} model / ${(1 - prod.L.blend).toFixed(2)} rule score · lambda ${prod.L.lambda}`);
    // bands → thresholds (on each fold's own OOS model scores; the score scale is the same calibrated 0–100 scale)
    log(`\nOOS score bands (${hz}) — F1 test | F2 test: n, avg ${h}d return after ${COST}% cost, excess vs universe, hit T1 first`);
    for (let k = 0; k < R.F1.B.B.length; k++) {
      const a = R.F1.B.B[k], b = R.F2.B.B[k]; if (!a.n && !b.n) continue;
      const s = x => x.n ? `${lpad(x.n, 6)} ${f2(x.r / x.n - COST)}% ${f2(x.ex / x.n)} ${x.hn ? pc(x.h / x.hn) : 'n/a'}` : lpad('-', 6) + '                     ';
      log(`   ${lpad(a.lo, 3)}–${pad(a.hi - 1, 3)} ${s(a)} | ${s(b)}`);
    }
    const th = pickThresholds([R.F1.B, R.F2.B]), thB = pickThresholds([R.F1.Bb, R.F2.Bb]);
    log(`Recommended cut-offs (${hz}, model score): BUY ≥ ${th.buy == null ? 'none qualifies (no band was positive after costs AND beat the universe in both folds)' : th.buy} · SELL ≤ ${th.sell == null ? 'none qualifies' : th.sell}   [same rule on the current score: BUY ≥ ${thB.buy == null ? 'none' : thB.buy}, SELL ≤ ${thB.sell == null ? 'none' : thB.sell}; app uses 58/42]`);
    const cur = bands(DS, F1te, tg.base, T, COST).above(58), cur2 = bands(DS, F2te, tg.base, T, COST).above(58);
    log(`What "BUY" means today (current horizon score ≥ 58, before the app's regime/news/backtest nudges): F1 n=${cur.n} ${f2(cur.ac)}% after cost, ${f2(cur.ex)} vs universe, hit ${pc(cur.hit)} | F2 n=${cur2.n} ${f2(cur2.ac)}%, ${f2(cur2.ex)}, hit ${pc(cur2.hit)}`);
    // regime split of the model's top decile (F1 test)
    const mj = DS.names.indexOf('mkt200');
    if (mj >= 0) { const up = R.F1.te.filter(i => DS.X[i * DS.NF + mj] === 1), dn = R.F1.te.filter(i => DS.X[i * DS.NF + mj] === 0);
      const a = portStats(DS, up, R.F1.sc, T, COST, liq), b = portStats(DS, dn, R.F1.sc, T, COST, liq);
      log(`Regime (F1 test, model top decile after cost): Nifty above 200 EMA ${f2(a.top.ac)}% (${a.top.days} days, universe ${f2(a.all.ac)}%) · below ${f2(b.top.ac)}% (${b.top.days} days, universe ${f2(b.all.ac)}%)`); }
    // engine parity: the app's E.linScore gives the same number research measured
    const sample = all.filter((_, k) => k % Math.max(1, Math.floor(all.length / 300)) === 0), bad = parity(DS, prod.L, tg.rule, sample) + parity(DS, prod.L, tg.rule1, sample, 1);
    log(`Engine parity check (E.linScore vs research scoring, ${sample.length} rows at bar n + ${sample.length} at bar n−1${E.linK(prod.L) > 1 ? `, ${E.linK(prod.L)}-bar smoothing` : ''}): ${bad ? bad + ' MISMATCHES' : 'all match'}`);
    const stP = stab(all, scoreRows(DS, all, prod.L, tg.rule), scoreRows(DS, all, prod.L, tg.rule1, 1));
    if (VHZ.has(hz)) STAB.push(`   production model (${vPick.name}, refit on all rows — in-sample): day-over-day mean ${stP.mean.toFixed(1)} · median ${stP.med.toFixed(0)} · p90 ${stP.p90.toFixed(0)} · max ${stP.max.toFixed(0)} · >10pts ${pc(stP.gt10)} · parity ${bad ? bad + ' MISMATCHES' : 'all match'}`);
    const oos = k => ({ ic: +R[k].em.ic.ic.toFixed(4), icBase: +R[k].eb.ic.ic.toFixed(4), top: +R[k].em.p.top.ac.toFixed(3), topBase: +R[k].eb.p.top.ac.toFixed(3), hit: +(R[k].em.p.top.hit || 0).toFixed(3), t10: +(R[k].em.p.t10.ac || 0).toFixed(3) });
    const el = summary[hz + '_el']; delete summary[hz + '_el'];
    const st2 = x => ({ mean: +x.mean.toFixed(2), p90: +x.p90.toFixed(1) });
    summary[hz] = { adopted: pass, oos: { f1: oos('F1'), f2: oos('F2'), stock: R['stock-split'] ? oos('stock-split') : null }, thresholds: th };
    if (VHZ.has(hz)) Object.assign(summary[hz], { variant: vPick.name, smooth: vPick.k, stab: { f1: st2(R.F1.st), f2: st2(R.F2.st), baseF1: st2(RV.base.F1.st), baseF2: st2(RV.base.F2.st), ruleF1: st2(R.F1.stR), prod: st2(stP) },
      why: pass ? `most stable of ${Object.values(el).filter(e => e.ok).length} eligible variant(s)` : 'none eligible: ' + Object.entries(el).map(([k, e]) => `${k} (${e.why.join(', ')})`).join('; ') });
    if ((pass || FORCE) && !bad) {
      const L = Object.assign(prod.L, { scope: [...new Set(prod.L.features.map(E.featScope))], target: `${h}d forward return in ATRs (per-day rank)`, days: h, date: new Date().toISOString().slice(0, 10),
        calib: calibBins(DS, F1te, R.F1.sc, T), oos: summary[hz].oos });
      newLin[hz] = L; adopted[hz] = true; Object.assign(CV[hz], { adopted: true, L: { F1: R.F1.fit.L, F2: R.F2.fit.L }, prodL: L });
      if (th.buy != null && th.sell != null && th.buy > th.sell + 4) newTh[hz] = { buy: th.buy, sell: th.sell, sbuy: Math.min(95, Math.max(th.buy + 8, CUTS.find(c => c >= th.buy + 8) || th.buy + 10)), ssell: Math.max(5, th.sell - 10) };
    }
  }
  // ---------------- feature table ----------------
  log(`\n==================== FEATURE RANK-IC (full sample; vs per-day rank of forward ATR return) ====================`);
  log(`${pad('feature', 46)} ${HZS.map(h => lpad(h, 16)).join('')}   (✓ = same sign in F1-train, F1-test, F2-test; t overlap-adjusted)`);
  for (const fr of featRows.filter(Boolean)) log(`${pad(fr.k.slice(0, 44) + (fr.scope === 'stock' ? '' : ' [' + fr.scope + ']'), 46)} ${HZS.map(h => { const x = fr.hz[h]; return x ? lpad(`${f3(x.ic)} ${ok(x.t) ? x.t.toFixed(1) : ''}${x.stable ? '✓' : ' '}`, 16) : lpad('', 16); }).join('')}`);

  // ---------------- CONVICTION ----------------
  const conv = conviction(DS, CV, C);
  // ---------------- BTST ----------------
  const btst = runBtst(C, liq);
  finish(model, { newLin, newTh, adopted, summary, conv }, btst, C);
}

// ---------------- CONVICTION (🎯 high-conviction filter; see header §9) ----------------
// Per daily horizon: a small PRE-DECLARED grid of selection rules (the horizon's app score ≥ BUY 58 / top 10 / 5 / 2 % cut, plus at most two
// of: neighbour-horizon agreement, trend stack, Nifty > 200 EMA, liquidity, not overextended) is searched on the TRAIN part of each fold
// only (objective: lower 95% bound of the T1-before-stop hit rate, subject to n ≥ CONV_MIN_N de-duplicated signals and a positive
// after-cost trade return), then the picked rule is measured on that fold's TEST part. One signal per stock per holding period.
const NB = { swing: ['short'], short: ['swing', 'medium'], medium: ['short', 'long'], long: ['medium'] };
const AGREE_MIN = 58, BUY_MIN = 58, CONV_PCTS = [10, 5, 2], CONV_MIN_N = ENV.CONV_MIN_N != null ? +ENV.CONV_MIN_N : 150, CONV_MIN_TEST = 30, Z95 = 1.96;
const CONV_FAMS = [ // one option per family, at most two families (+ the score condition = at most 3 conditions)
  [{ agree: true }],
  [{ trend: 'stack' }, { trend: 'stack20' }],
  [{ regime: true }],
  [{ minTurnover: 1e8 }, { minTurnover: 5e8 }],
  [{ maxAtrE20: 3, maxRsi: 75 }],
];
// research's own evaluation of a rule on one row. v = {s: {hz: app score}, c (close = row price), e20, e50, e200, atr, rsi, turn (₹ 20d avg), mkt (Nifty > 200 EMA: 1/0/NaN)}
function convRowOk(sp, hz, v) {
  if (!(v.s[hz] >= sp.score)) return false;
  if (sp.agree && !sp.agree.every(nb => v.s[nb] >= sp.agreeMin)) return false;
  if (sp.trend && !(v.c > v.e50 && v.e50 > v.e200 && (sp.trend !== 'stack20' || v.e20 > v.e50))) return false;
  if (sp.regime && v.mkt !== 1) return false;
  if (sp.minTurnover != null && !(v.turn >= sp.minTurnover)) return false;
  if (sp.maxAtrE20 != null && !(Math.abs(v.c - v.e20) <= sp.maxAtrE20 * v.atr)) return false;
  if (sp.maxRsi != null && !(v.rsi < sp.maxRsi)) return false;
  return true;
}
// the grid for one horizon; cuts = [{cut, pct}] (pct null = plain BUY ≥ 58)
function convGrid(hz, cuts, hasMkt = true) {
  const fams = CONV_FAMS.filter(f => hasMkt || !f[0].regime), combos = [];
  const rec = (k, ch) => { combos.push(ch); if (ch.length === 2) return; for (let f = k; f < fams.length; f++) for (const o of fams[f]) rec(f + 1, [...ch, o]); };
  rec(0, []);
  const out = [];
  for (const c of cuts) for (const ch of combos) { const sp = Object.assign({ score: c.cut, pct: c.pct }, ...ch); if (sp.agree) { sp.agree = NB[hz].slice(); sp.agreeMin = AGREE_MIN; } out.push(sp); }
  return out;
}
const convKey = sp => [sp.pct || 'buy', sp.agree ? 'agree' : '', sp.trend || '', sp.regime ? 'reg' : '', sp.minTurnover || '', sp.maxAtrE20 != null ? 'ext' : ''].join('|');
function convDesc(sp, hz) {
  const a = [`${hz} score ≥ ${sp.score}${sp.pct ? ` (top ${sp.pct}%)` : ' (BUY)'}`];
  if (sp.agree) a.push(`${sp.agree.join(' & ')} ≥ ${sp.agreeMin}`);
  if (sp.trend) a.push(sp.trend === 'stack20' ? 'close>E50>E200 & E20>E50' : 'close>E50>E200');
  if (sp.regime) a.push('Nifty>200EMA');
  if (sp.minTurnover != null) a.push(`turnover ≥ ₹${sp.minTurnover / 1e7} Cr`);
  if (sp.maxAtrE20 != null) a.push(`≤${sp.maxAtrE20} ATR from E20 & RSI<${sp.maxRsi}`);
  return a.join(' + ');
}
// one signal per stock per holding period: rows in day order; a row is kept only if the stock's last KEPT signal is ≥ h grid days earlier
function convDedup(day, stock, idx, h) { const last = new Map(), out = []; for (const i of idx) { const l = last.get(stock[i]); if (l == null || day[i] >= l + h) { out.push(i); last.set(stock[i], day[i]); } } return out; }
// lower 95% bound of a hit rate: min(Wilson, cluster-robust normal bound with clusters = h-day blocks — signals whose windows share
// the same market path are not independent). Returns {lo, G (clusters)}
function hitLower(y, blk) {
  const n = y.length; if (!n) return { lo: NaN, G: 0 };
  const p = y.reduce((a, b) => a + b, 0) / n, z2 = Z95 * Z95;
  const wil = (p + z2 / (2 * n) - Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const S = new Map(); for (let k = 0; k < n; k++) S.set(blk[k], (S.get(blk[k]) || 0) + y[k] - p);
  const G = S.size; let V = 0; for (const x of S.values()) V += x * x;
  const seIid = Math.sqrt(p * (1 - p) / n), seCl = G >= 2 ? Math.sqrt(V * G / (G - 1)) / n : seIid;
  return { lo: Math.max(0, Math.min(wil, p - Z95 * Math.max(seIid, seCl))), G };
}
function convStats(DS, sig, T, h, months) {
  const n = sig.length; if (!n) return { n: 0 };
  const hit = sig.map(i => T.hit[i]), tr = sig.map(i => T.trade[i] - COST).sort((a, b) => a - b), L = hitLower(hit, sig.map(i => Math.floor(DS.day[i] / h)));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { n, hit: mean(hit), hitLo: L.lo, G: L.G, up: sig.filter(i => T.ret[i] > 0).length / n, avg: mean(tr), med: quantile(tr, 0.5), p5: quantile(tr, 0.05),
    endAvg: mean(sig.map(i => T.ret[i])) - COST, perMonth: ok(months) && months > 0 ? n / months : NaN };
}
function conviction(DS, CV, C) {
  const t0 = Date.now(), N = DS.N, out = {}, lines = {}, L0 = [];
  const mj = DS.names.indexOf('mkt200'), hasMkt = mj >= 0 && DS.rows.some((_, i) => DS.X[i * DS.NF + mj] === 1);
  L0.push(`\n==================== CONVICTION (🎯 high conviction) ====================`);
  L0.push(`Rule grid per horizon (pre-declared): app score ≥ BUY ${BUY_MIN} / top ${CONV_PCTS.join(' / ')} % cut (score value from the TRAIN rows) + at most 2 of: neighbour horizon(s) ≥ ${AGREE_MIN} · close>E50>E200 (or also E20>E50) · ${hasMkt ? 'Nifty > 200 EMA' : '(Nifty regime unavailable — dropped)'} · 20d turnover ≥ ₹10 / ₹50 Cr · ≤3 ATR from E20 & RSI<75`);
  L0.push(`Picked on TRAIN only: max lower-95% bound of hit = T1 before stop (app levels, E._levels), subject to n ≥ ${CONV_MIN_N} signals and avg after-cost trade > 0; then measured on TEST (same folds + embargo as above).`);
  L0.push(`De-duplicated: one signal per stock per holding period. lo = 95% lower bound (min of Wilson and cluster-robust by holding-period blocks; G = # blocks). trade = stop/T1/time exit, after ${COST}% cost. up = % up at horizon end. /mo = signals per month in the test years (rows are sampled every ${STEP} days, so the real count is somewhat higher).`);
  L0.push(`Score = the score the app will show: the fold's own model where this run adopts a learned model (in-sample on train, out of sample on test), else the current app score. ON only if the picked rule beats plain BUY ≥ ${BUY_MIN} on hit rate AND avg after-cost trade in BOTH test folds (and n_test ≥ ${CONV_MIN_TEST}).`);
  // per-row raw values; scores per (hz, fold) on EVERY row (neighbour agreement needs the other horizons' scores)
  const VB = DS.rows.map((r, i) => ({ c: r.cv[0], e20: r.cv[1], e50: r.cv[2], e200: r.cv[3], atr: r.cv[4], rsi: r.cv[5], turn: r.cv[6], mkt: mj >= 0 ? DS.X[i * DS.NF + mj] : NaN, s: null }));
  const allN = Array.from({ length: N }, (_, i) => i), SC = {};
  for (const hz of HZS) { const cv = CV[hz]; if (!cv) continue; SC[hz] = {}; for (const f of ['F1', 'F2']) SC[hz][f] = cv.adopted ? scoreRows(DS, allN, cv.L[f], cv.rule) : cv.base; SC[hz].P = cv.adopted ? scoreRows(DS, allN, cv.prodL, cv.rule) : cv.base; }
  const months = sub => { if (!sub.length) return NaN; let a = Infinity, b = -Infinity; for (const i of sub) { a = Math.min(a, DS.day[i]); b = Math.max(b, DS.day[i]); } return (C.grid[b] - C.grid[a] + 1) / 30.44; };
  const pick = (hz, sub, S, T, h) => {
    const v = []; for (const i of sub) if (ok(S[i])) v.push(S[i]); v.sort((a, b) => a - b);
    const cuts = [{ cut: BUY_MIN, pct: null }, ...CONV_PCTS.map(p => ({ cut: Math.ceil(quantile(v, 1 - p / 100)), pct: p }))]; // scores are integers: ≥ ceil(q) ⇔ ≥ q
    let best = null, nOk = 0; const grid = convGrid(hz, cuts, hasMkt);
    for (const sp of grid) {
      const sig = convDedup(DS.day, DS.stock, sub.filter(i => convRowOk(sp, hz, VB[i])), h), st = convStats(DS, sig, T, h, NaN);
      if (!(st.n >= CONV_MIN_N && st.avg > 0)) continue; nOk++;
      if (!best || st.hitLo > best.st.hitLo + 1e-12 || (Math.abs(st.hitLo - best.st.hitLo) <= 1e-12 && st.n > best.st.n)) best = { sp, st };
    }
    return { best, nGrid: grid.length, nOk };
  };
  const setS = f => { for (let i = 0; i < N; i++) { const s = {}; for (const hz of HZS) s[hz] = SC[hz] ? SC[hz][f][i] : NaN; VB[i].s = s; } };
  const res = {}; for (const hz of HZS) res[hz] = { folds: {} };
  for (const f of ['F1', 'F2']) {
    setS(f);
    for (const hz of HZS) {
      const cv = CV[hz]; if (!cv) continue; const [tr, te] = cv.folds[f], h = cv.h, T = cv.T;
      if (tr.length < 500 || te.length < 200) { res[hz].folds[f] = { err: `not enough rows (train ${tr.length}, test ${te.length})` }; continue; }
      const P = pick(hz, tr, SC[hz][f], T, h), mo = months(te);
      const base = convStats(DS, convDedup(DS.day, DS.stock, te.filter(i => VB[i].s[hz] >= BUY_MIN), h), T, h, mo), allS = convStats(DS, convDedup(DS.day, DS.stock, te, h), T, h, mo);
      if (!P.best) { res[hz].folds[f] = { err: `no rule met n ≥ ${CONV_MIN_N} and avg after-cost > 0 on train (${P.nGrid} rules)`, base, all: allS }; continue; }
      const test = convStats(DS, convDedup(DS.day, DS.stock, te.filter(i => convRowOk(P.best.sp, hz, VB[i])), h), T, h, mo);
      res[hz].folds[f] = { sp: P.best.sp, train: P.best.st, test, base, all: allS, nOk: P.nOk, nGrid: P.nGrid };
    }
  }
  setS('P');
  const r3 = x => ok(x) ? +x.toFixed(3) : null, r2 = x => ok(x) ? +x.toFixed(2) : null;
  const pub = st => st && st.n ? { n: st.n, hit: r3(st.hit), hitLo: r3(st.hitLo), up: r3(st.up), avg: r2(st.avg), med: r2(st.med), p5: r2(st.p5), endAvg: r2(st.endAvg), perMonth: r2(st.perMonth), G: st.G } : { n: 0 };
  const ruleOut = sp => { const o = { score: sp.score, pct: sp.pct }; for (const k of ['agree', 'agreeMin', 'trend', 'regime', 'minTurnover', 'maxAtrE20', 'maxRsi']) if (sp[k] != null && sp[k] !== false) o[k] = sp[k]; return o; };
  const sl = st => st && st.n ? `${lpad(st.n, 5)} ${lpad(ok(st.perMonth) ? st.perMonth.toFixed(1) : '-', 5)} ${lpad(pc(st.hit), 4)} ${lpad(pc(st.hitLo), 4)} ${lpad(st.G, 3)} ${lpad(pc(st.up), 4)} ${lpad(f2(st.avg) + '%', 7)} ${lpad(f2(st.med) + '%', 7)} ${lpad(f2(st.p5) + '%', 8)}` : lpad('none', 5) + ' '.repeat(52);
  for (const hz of HZS) {
    const cv = CV[hz], R = res[hz], h = HZ[hz];
    L0.push(`\n-- ${hz.toUpperCase()} · ${h} trading days · score source: ${cv ? (cv.adopted ? 'learned model adopted this run (fold models / production model)' : 'current app score (model.json as loaded)') : 'n/a'} --`);
    L0.push(`   ${pad('fold', 5)} ${pad('set', 13)} ${lpad('n', 5)} ${lpad('/mo', 5)} ${lpad('hit', 4)} ${lpad('lo', 4)} ${lpad('G', 3)} ${lpad('up', 4)} ${lpad('avg', 7)} ${lpad('med', 7)} ${lpad('worst5%', 8)}   rule (picked on train)`);
    if (!cv) { lines[hz] = `${pad(hz, 7)} 🎯 OFF · folds incomplete`; out[hz] = { off: true, why: 'folds incomplete' }; L0.push('   folds incomplete'); continue; }
    const why = [], foldsOut = {}; let cand = true, on = true;
    for (const f of ['F1', 'F2']) {
      const x = R.folds[f];
      if (!x || x.err) { on = false; cand = false; why.push(`${f}: ${x ? x.err : 'missing'}`); L0.push(`   ${pad(f, 5)} ${x ? x.err : 'missing'}`); if (x && x.base) { L0.push(`   ${pad(f, 5)} ${pad('BUY≥' + BUY_MIN, 13)} ${sl(x.base)}`); L0.push(`   ${pad(f, 5)} ${pad('all stocks', 13)} ${sl(x.all)}`); } continue; }
      L0.push(`   ${pad(f, 5)} ${pad('train (pick)', 13)} ${sl(x.train)}   ${convDesc(x.sp, hz)}  [${x.nOk}/${x.nGrid} rules feasible]`);
      L0.push(`   ${pad(f, 5)} ${pad('TEST rule', 13)} ${sl(x.test)}`);
      L0.push(`   ${pad(f, 5)} ${pad('TEST BUY≥' + BUY_MIN, 13)} ${sl(x.base)}`);
      L0.push(`   ${pad(f, 5)} ${pad('TEST all', 13)} ${sl(x.all)}`);
      const bH = x.test.n && x.base.n && x.test.hit > x.base.hit, bA = x.test.n && x.base.n && x.test.avg > x.base.avg, bN = x.test.n >= CONV_MIN_TEST;
      if (!(bH && bA && bN)) on = false;
      if (!(bH && bA && x.test.n >= 15)) cand = false;
      why.push(`${f}: hit ${pc(x.test.hit)} vs BUY ${pc(x.base.hit)} ${bH ? '✓' : '✗'}, avg ${f2(x.test.avg)}% vs ${f2(x.base.avg)}% ${bA ? '✓' : '✗'}, n ${x.test.n || 0}${bN ? '' : ` < ${CONV_MIN_TEST} ✗`}`);
      foldsOut[f] = { rule: ruleOut(x.sp), train: pub(x.train), test: pub(x.test), base: pub(x.base), all: pub(x.all) };
    }
    // production rule: the same selection procedure on ALL rows with the production score
    const P = pick(hz, cv.all, SC[hz].P, cv.T, h);
    if (P.best) L0.push(`   ${pad('prod', 5)} ${pad('in-sample', 13)} ${sl(P.best.st)}   ${convDesc(P.best.sp, hz)}`);
    else { on = false; why.push(`production pick: no rule met n ≥ ${CONV_MIN_N} and avg > 0 on all rows`); }
    const stable = P.best && ['F1', 'F2'].every(f => R.folds[f] && R.folds[f].sp && convKey(R.folds[f].sp) === convKey(P.best.sp));
    const forced = !on && FORCE && P.best && ['F1', 'F2'].every(f => R.folds[f] && R.folds[f].test && R.folds[f].test.n); // testing only
    const tier = on || forced ? 'confirmed' : cand && P.best && FORCE !== 'off' ? 'candidate' : null; // candidate: beat BUY≥58 on hit AND avg in BOTH test folds, but < 30 test cases
    if (tier) {
      const worst = ['F1', 'F2'].map(f => [f, R.folds[f]]).sort((a, b) => a[1].test.hit - b[1].test.hit)[0], wt = worst[1];
      const test = Object.assign(pub(wt.test), { baseHit: r3(wt.base.hit), baseAvg: r2(wt.base.avg), baseN: wt.base.n, allHit: r3(wt.all.hit), allAvg: r2(wt.all.avg), fold: worst[0] });
      out[hz] = { rule: ruleOut(P.best.sp), desc: convDesc(P.best.sp, hz), test, folds: foldsOut, stable, days: h, date: new Date().toISOString().slice(0, 10),
        tier, note: 'test = the walk-forward fold with the lower out-of-sample hit rate; backtest on daily bars, not live results' + (tier === 'candidate' ? '; CANDIDATE: both test folds beat BUY≥58 but too few cases to confirm' : '') };
      if (forced) out[hz].forced = true;
      lines[hz] = `${pad(hz, 7)} 🎯 ${forced ? 'FORCED (gate FAILED; RESEARCH_FORCE testing only) · ' + why.join(' · ') + ' ·' : tier === 'candidate' ? 'CANDIDATE (both folds beat BUY≥58, n < 30) · ' + why.join(' · ') + ' ·' : 'ON  ·'} ${convDesc(P.best.sp, hz)} · OOS (worst fold ${worst[0]}) hit ${pc(wt.test.hit)} (lo ${pc(wt.test.hitLo)}) vs BUY≥${BUY_MIN} ${pc(wt.base.hit)} · avg ${f2(wt.test.avg)}% vs ${f2(wt.base.avg)}% · n ${wt.test.n} (${ok(wt.test.perMonth) ? wt.test.perMonth.toFixed(1) : '?'}/mo) · rule ${stable ? 'same in F1, F2 and production' : 'differs between folds/production (procedure validated, exact rule not)'}`;
    } else {
      out[hz] = { off: true, why: why.join(' · '), folds: foldsOut };
      lines[hz] = `${pad(hz, 7)} 🎯 OFF · ${why.join(' · ')}`;
    }
    L0.push(`   DECISION ${lines[hz].replace(/^\S+\s+/, '')}`);
    // engine parity: E.convEval (what the phone runs on a scan row, NaN → null like JSON rows) == research's rule evaluation
    if (out[hz].rule) {
      const sp = out[hz].rule, pos = cv.all.filter(i => convRowOk(sp, hz, VB[i])), smp = [...pos.filter((_, k) => k % Math.max(1, Math.floor(pos.length / 200)) === 0), ...cv.all.filter((_, k) => k % Math.max(1, Math.floor(cv.all.length / 400)) === 0)];
      let bad = 0; const nn = x => ok(x) ? x : null;
      for (const i of smp) {
        const v = VB[i], row = { price: nn(v.c), e20: nn(v.e20), e50: nn(v.e50), e200: nn(v.e200), atr: nn(v.atr), rsi: nn(v.rsi), turnover: nn(v.turn), horizons: Object.fromEntries(HZS.map(k => [k, { score: nn(v.s[k]) }])) };
        if (!!E.convEval(out[hz], row, hz, { niftyAbove200: v.mkt === 1 ? true : v.mkt === 0 ? false : undefined }) !== convRowOk(sp, hz, v)) bad++;
      }
      L0.push(`   engine parity (E.convEval on scan-row shape vs research): ${smp.length} rows (${Math.min(pos.length, smp.length)} signals), ${bad ? bad + ' MISMATCHES — conviction OFF' : 'all match'}`);
      if (bad) { out[hz] = { off: true, why: `engine parity: ${bad} mismatches` }; lines[hz] = `${pad(hz, 7)} 🎯 OFF · engine parity ${bad} mismatches`; }
    }
  }
  out.intraday = { off: true, measured: false, why: 'no historical intraday bars — nothing measured; the app may show an unmeasured agreement flag (swing 🎯 + intraday rating ≥ 75)' };
  L0.push(`\nintraday: not measured (no historical intraday data). E.conviction(row, 'intraday') returns an agreement flag marked measured:false only.`);
  L0.push(`conviction runtime ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  L0.forEach(x => log(x));
  return { out, lines };
}

function runBtst(C) {
  log(`\n==================== TOMORROW / BTST (next session) ====================`);
  if (C.B.rows.length < 2000) { log('Not enough BTST rows.'); return null; }
  const DS = dataset(C.B, C.B.names.length), days = [...new Set(DS.day)], nd = days.length, s1 = days[Math.floor(nd * 0.6)], s2 = days[Math.floor(nd * 0.8)];
  const gap = Float32Array.from(DS.rows, r => r.gap), cc = Float32Array.from(DS.rows, r => r.cc), oc = Float32Array.from(DS.rows, r => r.oc);
  const rule = Float32Array.from(DS.rows, r => r.rule), base = Float32Array.from(DS.rows, r => r.base), liqA = Uint8Array.from(DS.rows, r => r.liq), liq = i => liqA[i] === 1;
  const all = rangeIdx(DS, i => ok(gap[i]) && ok(cc[i]));
  const F = { F1: [all.filter(i => DS.day[i] < s1 - 1), all.filter(i => DS.day[i] >= s1)], F2: [all.filter(i => DS.day[i] < s2 - 1), all.filter(i => DS.day[i] >= s2)] };
  // univariate IC table
  log(`${pad('feature', 14)} ${lpad('IC gap', 10)} ${lpad('IC close', 10)}`);
  const yrG = dayRank(DS, gap), yrC = dayRank(DS, cc);
  for (let j = 0; j < DS.NF; j++) { const a = featIC(DS, all, j, yrG, 1), b = featIC(DS, all, j, yrC, 1); log(`${pad(DS.names[j], 14)} ${lpad(f3(a.ic), 10)} ${lpad(f3(b.ic), 10)}   ${E.BTST_LBL[DS.names[j]] || ''}`); }
  log(`Rule score (E.btstAt) IC: gap ${f3(scoreIC(DS, all, rule, gap, 1).ic)} · close ${f3(scoreIC(DS, all, rule, cc, 1).ic)}`);
  const res = {};
  for (const [tname, y] of [['gap', gap], ['close', cc]]) {
    const tg = { y, yr: dayRank(DS, y), T: { ret: y }, rule, base, exclude: new Set(['lastHr']) };
    log(`\n-- target: next-day ${tname === 'gap' ? 'opening gap (sell at open)' : 'close-to-close (hold to close)'} --`);
    const R = {};
    for (const [nm, [tr, te]] of Object.entries(F)) {
      const fit = fitModel(DS, tr, tg, 1); if (!fit) continue;
      const sc = scoreRows(DS, te, fit.L, rule), em = evalAll(DS, te, sc, tg, 1, BCOST, liq), eb = evalAll(DS, te, base, tg, 1, BCOST, liq);
      R[nm] = { fit, sc, te, em, eb };
      log(`${nm}: ${fit.diag.nFeat} features · lambda ${fit.diag.lam} · blend ${fit.diag.blend}`); log('  ' + line('model (OOS)', em)); log('  ' + line('current BTST score', eb));
    }
    if (!R.F1 || !R.F2) continue;
    const pass = ['F1', 'F2'].every(f => R[f].em.ic.ic > R[f].eb.ic.ic + MIN_IC_GAIN && R[f].em.ic.ic > 0 && R[f].em.p.top.ac > R[f].eb.p.top.ac) && R.F1.em.ic.tAdj >= 2 * MIN_T;
    // exit rule on the model's OOS top decile: sell at open vs hold to close vs "sell at open if it gaps up, else hold"
    const exits = {};
    for (const f of ['F1', 'F2']) {
      const { sc, te } = R[f], acc = { open: [], close: [], cond: [] };
      for (const g of dayGroups(DS, te)) { const s = g.filter(i => ok(sc[i])).sort((a, b) => sc[b] - sc[a]), k = Math.max(1, Math.floor(s.length / 10)); for (const i of s.slice(0, k)) { acc.open.push(gap[i]); acc.close.push(cc[i]); acc.cond.push(gap[i] > 0 ? gap[i] : cc[i]); } }
      exits[f] = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { avg: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length) - BCOST, up: v.filter(x => x > BCOST).length / Math.max(1, v.length) }]));
    }
    const best = ['open', 'close', 'cond'].map(k => [k, Math.min(exits.F1[k].avg, exits.F2[k].avg)]).sort((a, b) => b[1] - a[1])[0];
    log(`Exit rule on the model's top decile (after ${BCOST}% cost) — F1 | F2:`);
    for (const k of ['open', 'close', 'cond']) log(`   ${pad({ open: 'sell at the open', close: 'hold to the close', cond: 'sell at open if gap-up, else hold' }[k], 36)} ${f3(exits.F1[k].avg)}% (${pc(exits.F1[k].up)} profitable) | ${f3(exits.F2[k].avg)}% (${pc(exits.F2[k].up)})`);
    log(`   → best in both folds (worst-case): ${best[0]} (${f3(best[1])}% per trade after cost)${best[1] <= 0 ? ' — NO positive after-cost edge; treat Tomorrow picks as watch-list only' : ''}`);
    log(`GATE btst/${tname}: ${pass ? 'PASS' : 'FAIL'} (needs IC and top-decile after cost to beat the current score in both folds, F1 t ≥ ${2 * MIN_T}; F1 t ${ok(R.F1.em.ic.tAdj) ? R.F1.em.ic.tAdj.toFixed(1) : 'n/a'})`);
    res[tname] = { R, pass, best, exits, tg, all };
  }
  // pick: a passing target with the higher worst-case after-cost exit expectancy
  const cands = Object.entries(res).filter(([, r]) => r.pass || FORCE).sort((a, b) => b[1].best[1] - a[1].best[1]);
  const summary = Object.fromEntries(Object.entries(res).map(([k, r]) => [k, { pass: r.pass, exit: r.best[0], exitAfterCost: +r.best[1].toFixed(3), f1: { ic: +r.R.F1.em.ic.ic.toFixed(4), icBase: +r.R.F1.eb.ic.ic.toFixed(4) }, f2: { ic: +r.R.F2.em.ic.ic.toFixed(4), icBase: +r.R.F2.eb.ic.ic.toFixed(4) } }]));
  if (!cands.length) { log('BTST: no learned model adopted (current score kept).'); return { summary }; }
  const [tname, r] = cands[0], R = r.R;
  const s1f = new Set(R.F1.fit.L.features), both = R.F2.fit.L.features.filter(k => s1f.has(k)), cols = (both.length >= 3 ? both : R.F2.fit.L.features).map(k => DS.names.indexOf(k));
  const prod = fitModel(DS, r.all, r.tg, 1, { cols }); if (!prod) return { summary };
  const sample = r.all.filter((_, k) => k % Math.max(1, Math.floor(r.all.length / 300)) === 0), bad = parity(DS, prod.L, rule, sample);
  log(`BTST production model (target ${tname}; weight per +1 sd, in model sd): ${prod.L.features.map((k, q) => `${k} ${f3(prod.L.weights[q] / prod.L.msd)}`).join(', ')} · blend ${prod.L.blend} · parity ${bad ? bad + ' MISMATCHES' : 'all match'}`);
  if (bad) return { summary };
  const txt = { open: 'Sell in the first minutes after the open — on past data the edge was in the opening gap.', close: 'Hold to the close — on past data the gain kept building through the day.', cond: 'Sell at the open if it gaps up; if it opens flat/down, hold to the close.' }[r.best[0]];
  return { summary, L: Object.assign(prod.L, { target: tname, exit: { rule: r.best[0], text: txt, afterCost: +r.best[1].toFixed(3), edge: r.best[1] > 0 }, date: new Date().toISOString().slice(0, 10), oos: summary[tname] }) };
}

function finish(model, H, btst, C) {
  const { newLin = {}, newTh = {}, summary = {}, conv = null } = H || {};
  if (STAB.length) { log(`\n==================== STABILITY ====================`); STAB.forEach(x => log(x)); }
  log(`\n==================== DECISION ====================`);
  for (const hz of HZS) { const s = summary[hz]; log(`${pad(hz, 7)} ${s ? (s.adopted ? 'ADOPT learned model' : newLin[hz] ? 'FORCED write (gate FAILED; RESEARCH_FORCE testing only)' : 'keep current') + (s.oos ? ` · OOS IC F1 ${f3(s.oos.f1.ic)} vs ${f3(s.oos.f1.icBase)} · F2 ${f3(s.oos.f2.ic)} vs ${f3(s.oos.f2.icBase)} · top-decile after cost F1 ${f2(s.oos.f1.top)}% vs ${f2(s.oos.f1.topBase)}% · F2 ${f2(s.oos.f2.top)}% vs ${f2(s.oos.f2.topBase)}%` : '') + (newTh[hz] ? ` · cut-offs BUY ≥ ${newTh[hz].buy} SELL ≤ ${newTh[hz].sell}` : newLin[hz] ? ' · no qualifying cut-offs → 58/42' : '') + (s.variant ? ` · variant ${s.variant}${s.smooth > 1 ? ` (smooth=${s.smooth})` : ''}: day-over-day mean |Δ| F1 ${s.stab.f1.mean} / F2 ${s.stab.f2.mean} (p90 ${s.stab.f1.p90} / ${s.stab.f2.p90}) vs base ${s.stab.baseF1.mean} / ${s.stab.baseF2.mean} (p90 ${s.stab.baseF1.p90} / ${s.stab.baseF2.p90}) · why: ${s.why}` : '') : 'no result'}`); }
  if (conv) for (const hz of HZS) if (conv.lines[hz]) log(conv.lines[hz]);
  log(`btst    ${btst && btst.L ? `ADOPT (${btst.L.target} target, exit: ${btst.L.exit.rule}, ${f3(btst.L.exit.afterCost)}% per trade after cost OOS worst fold)` : 'keep current'}`);
  log(`runtime ${((Date.now() - T0) / 60e3).toFixed(1)} min · memory ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB rss`);
  if (DRY) { log('RESEARCH_DRY: nothing written.'); return writeReport(); }
  // merge into the CURRENT file (learn.js may have rewritten it earlier in the same job); keep every other key
  let cur = model; try { cur = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); } catch (e) {}
  const lin = Object.assign({}, cur.lin || {}), th = Object.assign({}, cur.thresholds || {});
  let changed = false;
  for (const [hz, L] of Object.entries(newLin)) { lin[hz] = L; if (newTh[hz]) th[hz] = newTh[hz]; else delete th[hz]; changed = true; }
  const out = Object.assign({}, cur);
  if (Object.keys(lin).length) out.lin = lin; if (Object.keys(th).length) out.thresholds = th;
  if (btst && btst.L) { out.btst = btst.L; changed = true; }
  out.research = { date: new Date().toISOString().slice(0, 10), stocks: C ? C.stocks.length : 0, rows: C ? C.H.rows.length : 0, summary, btst: btst ? btst.summary : null, forced: FORCE || undefined,
    conviction: conv ? conv.out : undefined };
  if (changed) { out.v = (cur.v || 0) + 1; out.date = new Date().toISOString().slice(0, 10); }
  if (!E.setModel(out)) throw new Error('model.json failed validation — not written');
  for (const hz of Object.keys(out.lin || {})) if (!E.MODEL.lin[hz]) throw new Error('lin.' + hz + ' failed engine validation');
  if (out.btst && !E.MODEL.btst) throw new Error('btst failed engine validation');
  fs.writeFileSync(MODEL_PATH, JSON.stringify(out, null, 1));
  log(`Wrote ${path.relative(path.join(__dirname, '..'), MODEL_PATH)}${changed ? ` v${out.v} (learned sections: ${[...Object.keys(newLin), ...(btst && btst.L ? ['btst'] : [])].join(', ')})` : ' (research summary only; no model change)'}`);
  writeReport();
}
function writeReport() { if (DRY) return; fs.mkdirSync(path.dirname(REPORT), { recursive: true }); fs.writeFileSync(REPORT, LOG.join('\n') + '\n'); }

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { cholSolve, ridge, gram, ridgeG, spearman, rankArr, pearson, icStats, pickThresholds, quantile, stab, convRec, convRowOk, convGrid, convDedup, hitLower, NB, universe, getDaily, pool }; // universe / getDaily / pool: shared with tools/candles_research.js (same universe + Yahoo cache)
