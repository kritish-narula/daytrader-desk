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
//
// env: RESEARCH_SYMS (comma list, overrides the universe), UNIVERSE_MAX (cap stocks), STEP (3), BTST_STEP (2), CONC (10), BUDGET_MIN (18: stop fetching new stocks after this),
//      COST (0.30 % round trip, multi-day delivery), BTST_COST (0.25), RESEARCH_SCOPE ('stock' | 'stock,mkt' | 'stock,mkt,xs'),
//      MIN_IC_GAIN (0.003), MIN_T (1.5: overlap-adjusted t of the model's OOS IC in fold 1; BTST needs 2×MIN_T),
//      RESEARCH_BASELINE ('app' = current model.json score, or 'rule'), RESEARCH_FORCE=1 (testing: write even if the gate fails),
//      RESEARCH_DRY=1 (don't write files), MODEL_PATH / REPORT_PATH (testing), YF_CACHE (/tmp/yfcache).
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
const ok = x => typeof x === 'number' && isFinite(x);
const LOG = []; const log = (...a) => { const s = a.join(' '); LOG.push(s); console.log(s); };
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
    for (let i = 252; i < n - 1; i++) {
      const g = gidx.get(dayKey(D.t[i])); if (g == null) continue;
      const c = C[i];
      if (g % STEP === 0) {
        const fv = {}, rule = new Float32Array(4), base = new Float32Array(4), y = new Float32Array(16).fill(NaN);
        HZS.forEach((hz, h) => { const f = E._factors(I, i, hz); for (const x of f) if (x[4]) fv[x[4]] = x[1]; rule[h] = E._toScore(E._combine(f)); });
        const F = E.features(I, i, { fv, m });
        HZS.forEach((hz, h) => { const L = champLin[hz]; base[h] = L ? E.linScore(L, F, rule[h]) : rule[h]; });
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
        H.rows.push({ d: g, s: si, x, rule, base, y });
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
  return { H, B, stocks, grid, idxOk: !!idx, skipped, budgetHit, src: U0.src, want: syms.length };
}

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
  const N = S.rows.length, X = new Float32Array(N * NF);
  S.rows.forEach((r, i) => { for (let j = 0; j < NF; j++) { let v = r.x[j]; if (!ok(v) && isF[j]) v = 0; X[i * NF + j] = v; } r.x = null; });
  const day = Int32Array.from(S.rows, r => r.d), stock = Int32Array.from(S.rows, r => r.s);
  // per-day centred ranks of every feature (NaN → 0 = middle): fast univariate rank-IC
  const XR = new Float32Array(N * NF);
  const groups = []; for (let a = 0; a < N;) { let b = a; while (b < N && day[b] === day[a]) b++; groups.push([a, b]); a = b; }
  for (const [a, b] of groups) for (let j = 0; j < NF; j++) {
    const ix = [], v = []; for (let i = a; i < b; i++) { const x = X[i * NF + j]; if (ok(x)) { ix.push(i); v.push(x); } }
    if (v.length < 3) continue; const R = rankArr(v); for (let k = 0; k < ix.length; k++) XR[ix[k] * NF + j] = R[k] / (v.length - 1) - 0.5;
  }
  return { N, NF, names, isF, X, XR, day, stock, groups, rows: S.rows };
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
function zRows(DS, rows, P) { const p = P.length, Z = new Float64Array(rows.length * p); rows.forEach((i, r) => { for (let q = 0; q < p; q++) { const c = P[q]; Z[r * p + q] = E.zFeat(c.k, DS.X[i * DS.NF + c.j], c.lo, c.hi, c.mu, c.sd); } }); return Z; }
function predict(DS, rows, P, w, b) { const out = new Float64Array(DS.N).fill(NaN); for (const i of rows) { let s = b; for (let q = 0; q < P.length; q++) { const c = P[q]; s += w[q] * E.zFeat(c.k, DS.X[i * DS.NF + c.j], c.lo, c.hi, c.mu, c.sd); } out[i] = s; } return out; }
const meanSd = (arr, rows) => { let m = 0, n = 0; for (const i of rows) if (ok(arr[i])) { m += arr[i]; n++; } m /= Math.max(1, n); let s = 0; for (const i of rows) if (ok(arr[i])) s += (arr[i] - m) ** 2; return [m, Math.sqrt(s / Math.max(1, n - 1)) || 1]; };
// split a sorted subset by time at quantile q of its days, with an embargo of `emb` grid days before the split
function timeSplit(DS, sub, q, emb) { const days = [...new Set(sub.map(i => DS.day[i]))]; const cut = days[Math.floor(days.length * q)]; return [sub.filter(i => DS.day[i] < cut - emb), sub.filter(i => DS.day[i] >= cut)]; }

// fit on `train`: returns engine-format L (+ diag). opt.cols forces the candidate feature list.
function fitModel(DS, train, tg, h, opt = {}) {
  const sub = train.filter(i => ok(tg.yr[i]));
  let cand = opt.cols || DS.names.map((k, j) => j).filter(j => SCOPE.has(E.featScope(DS.names[j])) && !tg.exclude.has(DS.names[j]));
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
    const G = gram(zRows(DS, it, P), Float64Array.from(it, i => tg.yr[i]), it.length, p);
    for (const lam of LAMS) { const m = ridgeG(G, lam), pr = predict(DS, iv, P, m.w, m.b), s = scoreIC(DS, iv, pr, tg.y, h); if (ok(s.ic) && s.ic > best.ic) best = { lam, ic: s.ic, m }; }
    if (best.m) {
      const prT = predict(DS, it, P, best.m.w, best.m.b), [mm, ms] = meanSd(prT, it), [rm, rs] = meanSd(tg.rule, it), prV = predict(DS, iv, P, best.m.w, best.m.b);
      let bb = { b: 1, ic: -Infinity };
      for (const bl of BLENDS) { const sc = new Float64Array(DS.N).fill(NaN); for (const i of iv) sc[i] = bl * (prV[i] - mm) / ms + (1 - bl) * (tg.rule[i] - rm) / rs; const s = scoreIC(DS, iv, sc, tg.y, h); if (ok(s.ic) && s.ic > bb.ic + 1e-4) bb = { b: bl, ic: s.ic }; }
      best.blend = bb.b; best.blendIC = bb.ic;
    }
  }
  const m = ridge(zRows(DS, sub, P), Float64Array.from(sub, i => tg.yr[i]), sub.length, p, best.lam);
  const pr = predict(DS, sub, P, m.w, m.b), [mmu, msd] = meanSd(pr, sub), [rmu, rsd] = meanSd(tg.rule, sub);
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
  return { L, P, diag: { lam: best.lam, innerIC: best.ic, blend: best.blend, blendIC: best.blendIC, nTrain: sub.length, nFeat: p } };
}
// score rows with an engine-format model — exactly E.linScore's math
function scoreRows(DS, rows, L, rule) {
  const cols = L.features.map(k => DS.names.indexOf(k)), out = new Float64Array(DS.N).fill(NaN);
  for (const i of rows) {
    let s = L.intercept || 0; for (let q = 0; q < cols.length; q++) s += L.weights[q] * E.zFeat(L.features[q], cols[q] >= 0 ? DS.X[i * DS.NF + cols[q]] : NaN, L.lo[q], L.hi[q], L.mu[q], L.sd[q]);
    const raw = L.blend * (s - L.mmu) / L.msd + (1 - L.blend) * (rule[i] - L.rmu) / L.rsd;
    out[i] = Math.round(Math.max(0, Math.min(100, E.calMap(L.cal, raw))));
  }
  return out;
}
function parity(DS, L, rule, rows, fn) { // engine E.linScore on reconstructed feature objects == research scoring
  const sc = scoreRows(DS, rows, L, rule); let bad = 0;
  for (const i of rows) { const F = {}; DS.names.forEach((k, j) => { const v = DS.X[i * DS.NF + j]; F[k] = v; }); if ((fn || E.linScore)(L, F, rule[i]) !== sc[i]) bad++; }
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

  const adopted = {}, newLin = {}, newTh = {}, summary = {};
  const featRows = []; // per feature IC summary
  for (const hz of HZS) {
    const h = HZ[hz], hi = HZS.indexOf(hz);
    const T = { ret: Float32Array.from(DS.rows, r => r.y[hi * 4]), atr: Float32Array.from(DS.rows, r => r.y[hi * 4 + 1]), hit: Float32Array.from(DS.rows, r => r.y[hi * 4 + 2]), trade: Float32Array.from(DS.rows, r => r.y[hi * 4 + 3]) };
    T.hit = T.hit.map((x, i) => ok(T.ret[i]) ? x : NaN);
    const tg = { y: T.atr, yr: dayRank(DS, T.atr), retY: T.ret, T, rule: Float32Array.from(DS.rows, r => r.rule[hi]), base: Float32Array.from(DS.rows, r => r.base[hi]), exclude: new Set() };
    const all = rangeIdx(DS, i => ok(T.atr[i]));
    const F1tr = all.filter(i => DS.day[i] < s1 - h), F1te = all.filter(i => DS.day[i] >= s1), F2tr = all.filter(i => DS.day[i] < s2 - h), F2te = all.filter(i => DS.day[i] >= s2);
    const F3tr = F1tr.filter(i => half[DS.stock[i]] === 0), F3te = F1te.filter(i => half[DS.stock[i]] === 1);
    log(`\n==================== ${hz.toUpperCase()} · ${h} trading days · ${all.length} rows ====================`);
    // feature IC table rows (full sample + fold stability)
    for (let j = 0; j < DS.NF; j++) {
      const a = featIC(DS, all, j, tg.yr, h), b = featIC(DS, F1tr, j, tg.yr, h), c = featIC(DS, F1te, j, tg.yr, h), d = featIC(DS, F2te, j, tg.yr, h);
      const fr = featRows[j] = featRows[j] || { k: DS.names[j], scope: E.featScope(DS.names[j]), hz: {} };
      fr.hz[hz] = { ic: a.ic, t: a.tAdj, stable: [b.ic, c.ic, d.ic].every(ok) && Math.sign(b.ic) === Math.sign(c.ic) && Math.sign(c.ic) === Math.sign(d.ic) };
    }
    // folds
    const folds = [['F1', F1tr, F1te], ['F2', F2tr, F2te], ['stock-split', F3tr, F3te]], R = {};
    for (const [nm, tr, te] of folds) {
      if (tr.length < 500 || te.length < 200) { log(`${nm}: not enough rows (train ${tr.length}, test ${te.length})`); continue; }
      const fit = fitModel(DS, tr, tg, h); if (!fit) { log(`${nm}: no usable features`); continue; }
      const sc = scoreRows(DS, te, fit.L, tg.rule), base = tg.base, rule = tg.rule;
      const em = evalAll(DS, te, sc, tg, h, COST, liq), eb = evalAll(DS, te, base, tg, h, COST, liq);
      const er = BASE === 'app' && Object.keys(E.MODEL.lin || {}).includes(hz) ? evalAll(DS, te, rule, tg, h, COST, liq) : null;
      R[nm] = { fit, sc, te, em, eb, B: bands(DS, te, sc, T, COST), Bb: bands(DS, te, base, T, COST) };
      log(`\n${nm}: train ${tr.length} rows → test ${te.length} rows · ${fit.diag.nFeat} features · lambda ${fit.diag.lam} · blend model/rule ${fit.diag.blend}/${(1 - fit.diag.blend).toFixed(2)} (inner IC ${f3(fit.diag.innerIC)})`);
      log('  ' + line('model (OOS)', em)); log('  ' + line('current app score', eb)); if (er) log('  ' + line('rule score only', er));
    }
    if (!R.F1 || !R.F2) { log(`${hz}: folds incomplete — not adopted.`); summary[hz] = { adopted: false, reason: 'folds incomplete' }; continue; }
    const gate = ['F1', 'F2'].map(f => ({ f, ic: R[f].em.ic.ic > R[f].eb.ic.ic + MIN_IC_GAIN && R[f].em.ic.ic > 0, top: R[f].em.p.top.ac > R[f].eb.p.top.ac }));
    const sig = R.F1.em.ic.tAdj >= MIN_T, pass = gate.every(g => g.ic && g.top) && sig;
    log(`\nGATE ${hz}: ${gate.map(g => `${g.f} IC ${g.ic ? 'beats' : 'does NOT beat'} baseline, top-decile after cost ${g.top ? 'beats' : 'does NOT beat'}`).join(' · ')} · F1 OOS t ${ok(R.F1.em.ic.tAdj) ? R.F1.em.ic.tAdj.toFixed(1) : 'n/a'} ${sig ? '≥' : '<'} ${MIN_T} → ${pass ? 'PASS' : 'FAIL'}${!pass && FORCE ? ' (RESEARCH_FORCE: writing anyway — testing only)' : ''}`);
    // production model: refit on all rows with features selected in both folds (fallback: F2's)
    const s1f = new Set(R.F1.fit.L.features), both = R.F2.fit.L.features.filter(k => s1f.has(k));
    const cols = (both.length >= 3 ? both : R.F2.fit.L.features).map(k => DS.names.indexOf(k));
    const prod = fitModel(DS, all, tg, h, { cols });
    prod.L.blend = R.F2.fit.L.blend; // blend from the inner validation of the most recent fold; refit cal with it
    { const pr = predict(DS, all, prod.P, prod.L.weights, prod.L.intercept), raw = [], base = []; for (const i of all) { raw.push(prod.L.blend * (pr[i] - prod.L.mmu) / prod.L.msd + (1 - prod.L.blend) * (tg.rule[i] - prod.L.rmu) / prod.L.rsd); base.push(tg.base[i]); }
      raw.sort((a, b) => a - b); base.sort((a, b) => a - b); const Q = Array.from({ length: 41 }, (_, k) => k / 40); prod.L.cal = { x: Q.map(q => +quantile(raw, q).toFixed(5)), y: Q.map(q => +quantile(base, q).toFixed(2)) };
      for (let k = 1; k < 41; k++) { if (prod.L.cal.x[k] < prod.L.cal.x[k - 1]) prod.L.cal.x[k] = prod.L.cal.x[k - 1]; if (prod.L.cal.y[k] < prod.L.cal.y[k - 1]) prod.L.cal.y[k] = prod.L.cal.y[k - 1]; } }
    log(`\nProduction weights (${hz}${pass ? '' : ', NOT adopted'}; refit on all rows; effect of +1 sd of the feature on the model, in model sd; + = bullish):`);
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
    const sample = all.filter((_, k) => k % Math.max(1, Math.floor(all.length / 300)) === 0), bad = parity(DS, prod.L, tg.rule, sample);
    log(`Engine parity check (E.linScore vs research scoring, ${sample.length} rows): ${bad ? bad + ' MISMATCHES' : 'all match'}`);
    const oos = k => ({ ic: +R[k].em.ic.ic.toFixed(4), icBase: +R[k].eb.ic.ic.toFixed(4), top: +R[k].em.p.top.ac.toFixed(3), topBase: +R[k].eb.p.top.ac.toFixed(3), hit: +(R[k].em.p.top.hit || 0).toFixed(3), t10: +(R[k].em.p.t10.ac || 0).toFixed(3) });
    summary[hz] = { adopted: pass, oos: { f1: oos('F1'), f2: oos('F2'), stock: R['stock-split'] ? oos('stock-split') : null }, thresholds: th };
    if ((pass || FORCE) && !bad) {
      const L = Object.assign(prod.L, { scope: [...new Set(prod.L.features.map(E.featScope))], target: `${h}d forward return in ATRs (per-day rank)`, days: h, date: new Date().toISOString().slice(0, 10),
        calib: calibBins(DS, F1te, R.F1.sc, T), oos: summary[hz].oos });
      newLin[hz] = L; adopted[hz] = true;
      if (th.buy != null && th.sell != null && th.buy > th.sell + 4) newTh[hz] = { buy: th.buy, sell: th.sell, sbuy: Math.min(95, Math.max(th.buy + 8, CUTS.find(c => c >= th.buy + 8) || th.buy + 10)), ssell: Math.max(5, th.sell - 10) };
    }
  }
  // ---------------- feature table ----------------
  log(`\n==================== FEATURE RANK-IC (full sample; vs per-day rank of forward ATR return) ====================`);
  log(`${pad('feature', 46)} ${HZS.map(h => lpad(h, 16)).join('')}   (✓ = same sign in F1-train, F1-test, F2-test; t overlap-adjusted)`);
  for (const fr of featRows.filter(Boolean)) log(`${pad(fr.k.slice(0, 44) + (fr.scope === 'stock' ? '' : ' [' + fr.scope + ']'), 46)} ${HZS.map(h => { const x = fr.hz[h]; return x ? lpad(`${f3(x.ic)} ${ok(x.t) ? x.t.toFixed(1) : ''}${x.stable ? '✓' : ' '}`, 16) : lpad('', 16); }).join('')}`);

  // ---------------- BTST ----------------
  const btst = runBtst(C, liq);
  finish(model, { newLin, newTh, adopted, summary }, btst, C);
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
  const { newLin = {}, newTh = {}, summary = {} } = H || {};
  log(`\n==================== DECISION ====================`);
  for (const hz of HZS) { const s = summary[hz]; log(`${pad(hz, 7)} ${s ? (s.adopted ? 'ADOPT learned model' : newLin[hz] ? 'FORCED write (gate FAILED; RESEARCH_FORCE testing only)' : 'keep current') + (s.oos ? ` · OOS IC F1 ${f3(s.oos.f1.ic)} vs ${f3(s.oos.f1.icBase)} · F2 ${f3(s.oos.f2.ic)} vs ${f3(s.oos.f2.icBase)} · top-decile after cost F1 ${f2(s.oos.f1.top)}% vs ${f2(s.oos.f1.topBase)}% · F2 ${f2(s.oos.f2.top)}% vs ${f2(s.oos.f2.topBase)}%` : '') + (newTh[hz] ? ` · cut-offs BUY ≥ ${newTh[hz].buy} SELL ≤ ${newTh[hz].sell}` : newLin[hz] ? ' · no qualifying cut-offs → 58/42' : '') : 'no result'}`); }
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
  out.research = { date: new Date().toISOString().slice(0, 10), stocks: C ? C.stocks.length : 0, rows: C ? C.H.rows.length : 0, summary, btst: btst ? btst.summary : null, forced: FORCE || undefined };
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
module.exports = { cholSolve, ridge, gram, ridgeG, spearman, rankArr, pearson, icStats, pickThresholds, quantile };
