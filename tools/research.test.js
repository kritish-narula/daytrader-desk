// Unit checks for tools/research.js numerics and the engine's learned-model plumbing. Run: node tools/research.test.js
const assert = require('assert');
const R = require('./research.js'), E = require('../www/engine.js');
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log('ok  ', name); };
const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

t('cholSolve solves a known SPD system', () => {
  const A = [4, 2, 0.6, 2, 5, 1, 0.6, 1, 3], x0 = [1, -2, 0.5], b = [0, 1, 2].map(i => A[i * 3] * x0[0] + A[i * 3 + 1] * x0[1] + A[i * 3 + 2] * x0[2]);
  const x = R.cholSolve(Float64Array.from(A), Float64Array.from(b), 3); x0.forEach((v, i) => near(x[i], v, 1e-10, 'x' + i));
});
// synthetic regression with a known answer: y = 0.5 + 2·x1 − 3·x2 + 0·x3 + small noise
let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
const n = 5000, p = 3, Z = new Float64Array(n * p), y = new Float64Array(n);
for (let r = 0; r < n; r++) { for (let j = 0; j < p; j++) Z[r * p + j] = g() + (j === 2 ? 0.5 * Z[r * p] : 0); y[r] = 0.5 + 2 * Z[r * p] - 3 * Z[r * p + 1] + 0.01 * g(); }
t('ridge with tiny lambda recovers the true coefficients and intercept', () => {
  const m = R.ridge(Z, y, n, p, 1e-9); near(m.w[0], 2, 0.002, 'w1'); near(m.w[1], -3, 0.002, 'w2'); near(m.w[2], 0, 0.002, 'w3'); near(m.b, 0.5, 0.002, 'b');
});
t('ridge matches the closed form (X\'X/n + λI)⁻¹ X\'y/n on centred data', () => {
  const lam = 0.7, m = R.ridge(Z, y, n, p, lam), G = R.gram(Z, y, n, p), B = Float64Array.from(G.A); for (let j = 0; j < p; j++) B[j * p + j] += lam;
  const Bw = [0, 1, 2].map(i => [0, 1, 2].reduce((s, j) => s + B[i * p + j] * m.w[j], 0)); Bw.forEach((v, i) => near(v, G.c[i], 1e-9, 'normal eq ' + i));
});
t('ridge shrinks toward zero as lambda grows', () => {
  const norms = [0, 1, 10, 100].map(l => Math.hypot(...R.ridge(Z, y, n, p, l).w)); for (let k = 1; k < norms.length; k++) assert(norms[k] < norms[k - 1], 'monotone shrinkage');
  assert(norms[3] < 0.2 * norms[0], 'heavy shrinkage');
});
t('spearman: monotone = 1, reversed = −1, ties averaged', () => {
  near(R.spearman([1, 2, 3, 4, 5], [10, 20, 30, 1000, 5000]), 1, 1e-12, 'mono'); near(R.spearman([1, 2, 3], [3, 2, 1]), -1, 1e-12, 'rev');
  assert.deepStrictEqual(Array.from(R.rankArr([5, 1, 5, 2])), [2.5, 0, 2.5, 1]);
});
t('icStats overlap adjustment', () => { const s = R.icStats([0.1, 0.12, 0.08, 0.11, 0.09, 0.1], 30); assert(s.ic > 0.09 && s.tAdj < s.t); });
t('E.calMap interpolates and clamps', () => {
  const cal = { x: [-1, 0, 1], y: [20, 50, 90] }; assert.strictEqual(E.calMap(cal, -5), 20); assert.strictEqual(E.calMap(cal, 5), 90); near(E.calMap(cal, 0.5), 70, 1e-12, 'mid');
});
const L = { features: ['mom6', 'f.swing: EMA # above EMA #', 'xs.mom3R'], weights: [0.2, 0.1, 0.3], intercept: 0.01, mu: [0.1, 0, 0.5], sd: [0.2, 0.5, 0.29], lo: [-0.5, -1, 0], hi: [1, 1, 1],
  mmu: 0, msd: 0.25, rmu: 50, rsd: 15, blend: 0.5, cal: { x: [-3, 0, 3], y: [0, 50, 100] } };
t('E.linScore = manual computation (missing f.* → 0, missing other → neutral)', () => {
  const F = { mom6: 2 /* clipped to 1 */ }, z1 = (1 - 0.1) / 0.2, z2 = (0 - 0) / 0.5, z3 = 0;
  const raw = 0.01 + 0.2 * z1 + 0.1 * z2 + 0.3 * z3, bl = 0.5 * (raw - 0) / 0.25 + 0.5 * (60 - 50) / 15, want = Math.round(Math.max(0, Math.min(100, E.calMap(L.cal, bl))));
  assert.strictEqual(E.linScore(L, F, 60), want);
});
t('setModel accepts a valid lin/thresholds/btst, rejects malformed ones', () => {
  assert(E.setModel({ v: 5, w: {}, calib: {}, lin: { swing: L, short: Object.assign({}, L, { weights: [1] }) }, thresholds: { swing: { buy: 62, sell: 40 }, short: { buy: 60, sell: 40 } }, btst: Object.assign({}, L, { blend: 2 }) }));
  assert(E.MODEL.lin.swing && !E.MODEL.lin.short, 'bad lin dropped'); assert(E.MODEL.thresholds.swing && !E.MODEL.thresholds.short, 'thresholds only with lin'); assert(!E.MODEL.btst, 'bad btst dropped');
  assert.deepStrictEqual(E.cuts('swing'), { buy: 62, sell: 40, sbuy: 72, ssell: 30 }); assert.deepStrictEqual(E.cuts('short'), { buy: 58, sell: 42, sbuy: 68, ssell: 32 });
  E.setModel({ v: 1, w: {}, calib: {} }); assert.deepStrictEqual(E.MODEL.lin, {}); assert.strictEqual(E.MODEL.btst, undefined);
});
t('pickThresholds: BUY = lowest qualifying cut ≥ 54 where everything above is positive after cost and beats the universe in both folds', () => {
  const mk = (good) => ({ above: c => ({ n: 500, ac: c >= good ? 0.5 : -0.1, ex: c >= good ? 0.3 : -0.1 }), band: (a) => ({ n: 500, ac: a >= good ? 0.5 : -0.1, ex: a >= good ? 0.3 : -0.1 }), below: c => ({ n: 500, ac: c <= 38 ? -0.5 : 0.2, ex: c <= 38 ? -0.4 : 0.1 }) });
  assert.deepStrictEqual(R.pickThresholds([mk(62), mk(66)]), { buy: 66, sell: 38 });
});
// ---------------- score smoothing (lin[hz].smooth) ----------------
const fr = (a, b, c) => ({ mom6: a, 'f.swing: EMA # above EMA #': b, 'xs.mom3R': c });
const F0 = fr(0.3, 0.5, 0.8), F1 = fr(-0.2, 1, 0.1), F2 = fr(0.6, -0.4, NaN), F3 = fr(5, 5, 5);
t('linScore backward compatible: no `smooth` → only the current bar counts (object or frames)', () => {
  const s = E.linScore(L, F0, 55); assert.strictEqual(E.linScore(L, [F0], 55), s); assert.strictEqual(E.linScore(L, [F0, F1, F2], 55), s);
  assert.strictEqual(E.linK(L), 1); assert.strictEqual(E.linScore(Object.assign({}, L, { smooth: 1 }), [F0, F1], 55), s);
});
t('linScore with smooth = 3 averages the raw model output over 3 frames before blend + calibration', () => {
  const S = Object.assign({}, L, { smooth: 3 }), m = (E.linRaw(S, F0) + E.linRaw(S, F1) + E.linRaw(S, F2)) / 3;
  const raw = S.blend * ((m - S.mmu) / S.msd) + (1 - S.blend) * ((61 - S.rmu) / S.rsd), want = Math.round(Math.max(0, Math.min(100, E.calMap(S.cal, raw))));
  assert.strictEqual(E.linScore(S, [F0, F1, F2, F3], 61), want, 'uses exactly k frames');
  const m2 = (E.linRaw(S, F0) + E.linRaw(S, F1)) / 2, want2 = Math.round(Math.max(0, Math.min(100, E.calMap(S.cal, S.blend * ((m2 - S.mmu) / S.msd) + (1 - S.blend) * ((61 - S.rmu) / S.rsd)))));
  assert.strictEqual(E.linScore(S, [F0, F1], 61), want2, 'fewer frames → mean of what is there');
});
t('linOk validates `smooth` (integer 1–10); setModel without it keeps single-bar scoring', () => {
  assert(E.linOk(Object.assign({}, L, { smooth: 3 }))); for (const bad of [0, 2.5, 11, '3', -1]) assert(!E.linOk(Object.assign({}, L, { smooth: bad })), 'reject ' + bad);
  assert(E.setModel({ v: 7, w: {}, calib: {}, lin: { swing: L, short: Object.assign({}, L, { smooth: 5 }) } }));
  assert.strictEqual(E.linK(E.MODEL.lin.swing), 1); assert.strictEqual(E.linK(E.MODEL.lin.short), 5);
  E.setModel({ v: 1, w: {}, calib: {} });
});
t('linWhy merges features that share a label and averages over the smoothing frames', () => {
  const lb = 'f.swing: Active bullish setup (SMC / VCP / trend)', lc = 'f.short: Active bullish setup (SMC / VCP / trend)', ld = 'f.medium: Active bullish setup (SMC / VCP / trend)';
  const M = Object.assign({}, L, { features: [lb, lc, ld, 'mom6'], weights: [0.1, 0.2, 0.3, 0.05], mu: [0, 0, 0, 0], sd: [1, 1, 1, 1], lo: [-1, -1, -1, -1], hi: [1, 1, 1, 1] });
  const G = { [lb]: 1, [lc]: 1, [ld]: 1, mom6: 0.5 }, W = E.linWhy(M, G, 5);
  assert.strictEqual(W.filter(x => /Active bullish setup/.test(x.lbl)).length, 1, 'one entry per label'); near(W[0].c, 0.6, 1e-12, 'merged contribution'); assert.strictEqual(W.length, 2);
  const M3 = Object.assign({}, M, { smooth: 2 }), W3 = E.linWhy(M3, [G, { [lb]: 0, [lc]: 0, [ld]: 0, mom6: 0.5 }], 5);
  near(W3.find(x => /Active/.test(x.lbl)).c, 0.3, 1e-12, 'averaged over 2 frames');
});
// synthetic daily bars (deterministic) for the engine path
const bars = (N, sd0) => { let sd = sd0; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }; const D = { t: [], o: [], h: [], l: [], c: [], v: [] }; let p = 300;
  for (let i = 0; i < N; i++) { const op = p * (1 + (r() - 0.5) * 0.01); p *= Math.exp(0.0005 + (r() - 0.5) * 0.04); D.t.push(1.6e9 + i * 86400); D.o.push(op); D.c.push(p); D.h.push(Math.max(op, p) * (1 + r() * 0.01)); D.l.push(Math.min(op, p) * (1 - r() * 0.01)); D.v.push(Math.round(1e6 * (0.5 + r()))); }
  return D; };
t('E.analyze with a smoothed model = E.linScore over E.featuresAt frames (the path research.js records); no smooth = single bar', () => {
  const D = bars(420, 11), I = E.indicators(D), i = D.c.length - 1;
  const ks = ['adx', 'volTr', 'ret1', 'clv', 'turn', 'hi52', 'f.swing: Closed above #-day high', 'f.short: Active bullish setup (SMC / VCP / trend)'];
  const mk = smooth => Object.assign({ features: ks, weights: [0.3, 0.2, 0.25, 0.15, 0.1, 0.1, 0.2, 0.1], intercept: 0, mu: [25, 0, 0, 0.5, 8, -0.2, 0, 0], sd: [10, 0.3, 2, 0.3, 1, 0.2, 0.5, 0.5], lo: [5, -2, -10, 0, 5, -1, -1, -1], hi: [60, 2, 10, 1, 11, 0, 1, 1],
    mmu: 0, msd: 1, rmu: 50, rsd: 15, blend: 1, cal: { x: [-3, 0, 3], y: [0, 50, 100] } }, smooth ? { smooth } : {});
  const fr5 = [0, 1, 2, 3, 4].map(t => E.featuresAt(I, i - t)), want = k => E.linScore(mk(k), fr5.map(f => f.F), fr5[0].rule.swing);
  E.setModel({ v: 9, w: {}, calib: {}, lin: { swing: mk(0) } }); const a1 = E.analyze(D).horizons.swing;
  assert.strictEqual(a1.score, want(0)); assert.strictEqual(a1.rule, fr5[0].rule.swing, 'rule score = featuresAt rule');
  E.setModel({ v: 9, w: {}, calib: {}, lin: { swing: mk(5) } }); const a5 = E.analyze(D).horizons.swing;
  assert.strictEqual(a5.score, want(5)); assert(a5.ml.length >= 1 && new Set(a5.ml.map(x => x.t)).size === a5.ml.length, 'ml labels unique');
  // stability: the smoothed score moves less bar to bar than the single-bar one (on this series)
  let d1 = 0, d5 = 0; for (let j = 330; j < 420; j++) { const Dj = Object.fromEntries(Object.entries(D).map(([k, v]) => [k, v.slice(0, j)])), Dk = Object.fromEntries(Object.entries(D).map(([k, v]) => [k, v.slice(0, j - 1)]));
    E.setModel({ v: 9, w: {}, calib: {}, lin: { swing: mk(0) } }); d1 += Math.abs(E.analyze(Dj).horizons.swing.score - E.analyze(Dk).horizons.swing.score);
    E.setModel({ v: 9, w: {}, calib: {}, lin: { swing: mk(5) } }); d5 += Math.abs(E.analyze(Dj).horizons.swing.score - E.analyze(Dk).horizons.swing.score); }
  assert(d5 < d1, `smoothed day-over-day change ${d5} < single-bar ${d1}`);
  E.setModel({ v: 1, w: {}, calib: {} });
});
t('stab(): day-over-day |Δ| statistics', () => {
  const s = R.stab([0, 1, 2, 3], [10, 20, 30, 40], [10, 25, 18, NaN]); assert.strictEqual(s.n, 3); near(s.mean, 17 / 3, 1e-12, 'mean'); assert.strictEqual(s.max, 12); near(s.gt10, 1 / 3, 1e-12, '>10');
});
// ---------------- 🎯 conviction: research's rule evaluation == E.conviction on the scan-row shape ----------------
const ok = x => typeof x === 'number' && isFinite(x);
const convEntry = (rule, extra) => Object.assign({ rule, test: { n: 200, hit: 0.41, hitLo: 0.35, up: 0.6, avg: 1.1, med: 0.9, p5: -4, perMonth: 6, baseHit: 0.3, baseAvg: 0.5, fold: 'F2' }, days: 10 }, extra || {});
t('conviction parity: research convRec values = E.quick row fields, and convRowOk == E.conviction for every grid rule (incl. JSON round trip)', () => {
  E.setModel({ v: 1, w: {}, calib: {} });
  const D = bars(520, 21), I = E.indicators(D); let checks = 0, pos = 0, neg = 0;
  for (let j = 430; j < 520; j += 6) {
    const Dj = Object.fromEntries(Object.entries(D).map(([k, v]) => [k, v.slice(0, j + 1)])), q = E.quick(Dj, { tick: 0.05 }), cv = R.convRec(D, I, j);
    const fields = ['price', 'e20', 'e50', 'e200', 'atr', 'rsi', 'turnover'];
    fields.forEach((k, m) => assert.strictEqual(q[k], cv[m], `${k} at bar ${j}: row ${q[k]} vs research ${cv[m]}`));
    const rows = [q, JSON.parse(JSON.stringify(q))];
    for (const mkt of [1, 0, NaN]) {
      const v = { s: Object.fromEntries(['swing', 'short', 'medium', 'long'].map(k => [k, q.horizons[k].score])), c: cv[0], e20: cv[1], e50: cv[2], e200: cv[3], atr: cv[4], rsi: cv[5], turn: cv[6], mkt };
      const ctx = { niftyAbove200: mkt === 1 ? true : mkt === 0 ? false : undefined };
      for (const hz of ['swing', 'short', 'medium', 'long']) for (const sp of R.convGrid(hz, [{ cut: 0, pct: null }, { cut: 45, pct: 10 }, { cut: 58, pct: 5 }, { cut: 70, pct: 2 }])) {
        const want = R.convRowOk(sp, hz, v);
        for (const row of rows) { const got = E.convEval(convEntry(sp), row, hz, ctx); assert.strictEqual(!!got, want, `${hz} ${JSON.stringify(sp)} bar ${j}`); checks++; }
        want ? pos++ : neg++;
      }
    }
  }
  assert(pos > 50 && neg > 50, `both outcomes exercised (${pos} / ${neg})`); assert(checks > 5000);
});
t('convGrid: score condition + at most 2 other families, one option per family; 108 rules with the regime, fewer without', () => {
  const g = R.convGrid('short', [{ cut: 58, pct: null }, { cut: 70, pct: 10 }, { cut: 75, pct: 5 }, { cut: 80, pct: 2 }]);
  assert.strictEqual(g.length, 108); assert(g.every(sp => ok(sp.score)));
  const fam = sp => [sp.agree, sp.trend, sp.regime, sp.minTurnover, sp.maxAtrE20].filter(x => x != null && x !== false).length;
  assert(g.every(sp => fam(sp) <= 2)); assert(g.filter(sp => sp.agree).every(sp => sp.agree.join() === 'swing,medium' && sp.agreeMin === 58));
  assert(R.convGrid('short', [{ cut: 58, pct: null }], false).every(sp => !sp.regime));
});
t('convDedup: a stock re-signalling within the holding period counts once', () => {
  const day = [0, 0, 3, 6, 9, 10, 12, 21], stock = [1, 2, 1, 1, 2, 1, 2, 1];
  assert.deepStrictEqual(R.convDedup(day, stock, [0, 1, 2, 3, 4, 5, 6, 7], 10), [0, 1, 5, 6, 7]); // stock 1 kept on days 0, 10, 21 (3, 6 within 10 of day 0); stock 2 on 0, 12 (9 within 10)
});
t('hitLower: ≤ Wilson; clustered outcomes widen the bound; empty → NaN', () => {
  const y = Array.from({ length: 200 }, (_, k) => k % 2), iid = R.hitLower(y, y.map((_, k) => k)), cl = R.hitLower(y.map((_, k) => k < 100 ? 1 : 0), y.map((_, k) => Math.floor(k / 50)));
  assert(iid.lo < 0.5 && iid.lo > 0.4, 'iid lo ' + iid.lo); assert(cl.lo < iid.lo, `clustered ${cl.lo} < iid ${iid.lo}`); assert.strictEqual(cl.G, 4); assert(isNaN(R.hitLower([], []).lo));
});
t('E.conviction: model.json lookup, off → null, regime needs ctx.niftyAbove200, intraday = unmeasured agreement flag', () => {
  const D = bars(520, 21), q = E.quick(D, { tick: 0.05 }), s = q.horizons.swing.score;
  const on = convEntry({ score: s, pct: 5 }), reg = convEntry({ score: s, pct: 5, regime: true });
  E.setModel({ v: 3, w: {}, calib: {}, research: { conviction: { swing: on, short: { off: true, why: 'x' }, medium: reg } } });
  const r = E.conviction(q, 'swing', {}); assert(r && r.measured === true && r.hit === 0.41 && r.n === 200 && r.why.length >= 1 && r.hz === 'swing');
  assert.strictEqual(E.conviction(q, 'short', {}), null); assert.strictEqual(E.conviction(q, 'long', {}), null);
  E.setModel({ v: 3, w: {}, calib: {}, research: { conviction: { swing: convEntry({ score: s + 1, pct: 5 }) } } }); assert.strictEqual(E.conviction(q, 'swing', {}), null, 'score below cut');
  E.setModel({ v: 3, w: {}, calib: {}, research: { conviction: { swing: convEntry({ score: s, pct: 5, regime: true }) } } });
  assert.strictEqual(E.conviction(q, 'swing', {}), null, 'regime unknown → no signal'); assert.strictEqual(E.conviction(q, 'swing', { niftyAbove200: false }), null); assert(E.conviction(q, 'swing', { niftyAbove200: true }));
  E.setModel({ v: 3, w: {}, calib: {}, research: { conviction: { swing: on } } });
  const i1 = E.conviction(q, 'intraday', {}, 80); assert(i1 && i1.measured === false && i1.hit === null && i1.basis.hz === 'swing');
  assert.strictEqual(E.conviction(q, 'intraday', {}, 70), null);
  E.setModel({ v: 1, w: {}, calib: {} }); assert.strictEqual(E.conviction(q, 'swing', {}), null, 'no section → null');
});
t('E.above200: last close vs its 200 EMA; live drops the forming bar; short history → undefined', () => {
  const up = { c: Array.from({ length: 300 }, (_, k) => 100 + k) }, dn = { c: Array.from({ length: 300 }, (_, k) => 400 - k) };
  assert.strictEqual(E.above200(up), true); assert.strictEqual(E.above200(dn), false); assert.strictEqual(E.above200({ c: [1, 2, 3] }), undefined);
  assert.strictEqual(E.above200({ c: [...up.c, 1] }, true), true, 'forming bar ignored');
});
// end-to-end on the synthetic stub (tools/fno_stub.js; own cache dir so the real Yahoo cache is never touched)
t('research.js end-to-end on stub data: STABILITY section, parity at bar n and n−1, smoothed model written + accepted by the engine', () => {
  const os = require('os'), fs = require('fs'), path = require('path'), cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-test-')), mp = path.join(dir, 'model.json'), rp = path.join(dir, 'report.txt');
  fs.writeFileSync(mp, JSON.stringify({ v: 1, w: {}, calib: {} }));
  const syms = Array.from({ length: 24 }, (_, k) => 'STK' + k).join(',');
  const r = cp.spawnSync(process.execPath, ['-r', path.join(__dirname, 'fno_stub.js'), path.join(__dirname, 'research.js')], { encoding: 'utf8', timeout: 300e3,
    env: Object.assign({}, process.env, { YF_CACHE: path.join(dir, 'cache'), RESEARCH_SYMS: syms, STEP: '4', BTST_STEP: '6', MODEL_PATH: mp, REPORT_PATH: rp, RESEARCH_FORCE: '1', RESEARCH_FORCE_VARIANT: 'S3', VARIANTS: 'S3,FS', RESEARCH_DRY: '', CONV_MIN_N: '20' }) });
  assert.strictEqual(r.status, 0, r.stderr); const rep = fs.readFileSync(rp, 'utf8');
  assert(/^==================== STABILITY/m.test(rep) && /STABILITY swing/.test(rep) && /STABILITY short/.test(rep), 'stability section');
  assert(!/MISMATCHES/.test(rep), 'parity mismatches'); assert(/every variant's F2 model, bar n and bar n−1\): \d+ rows, all match/.test(rep));
  assert(/^swing .* variant /m.test(rep), 'DECISION names the variant');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8')); assert.strictEqual(m.lin.swing.smooth, 3, 'forced S3 written with smooth = 3');
  assert(E.setModel(m) && E.linK(E.MODEL.lin.swing) === 3);
  assert(/^==================== CONVICTION/m.test(rep) && /engine parity \(E\.convEval on scan-row shape vs research\): \d+ rows \(\d+ signals\), all match/.test(rep), 'conviction section + parity');
  assert(/^swing +🎯 /m.test(rep), 'conviction DECISION line'); const cs = m.research.conviction;
  assert(cs && cs.intraday.off && cs.intraday.measured === false, 'intraday never measured');
  for (const hz of ['swing', 'short', 'medium', 'long']) assert(cs[hz] && (cs[hz].off ? typeof cs[hz].why === 'string' : cs[hz].rule && ok(cs[hz].rule.score) && ok(cs[hz].test.hit) && ok(cs[hz].test.baseHit) && cs[hz].folds.F1 && cs[hz].folds.F2), 'conviction ' + hz);
  const D = bars(400, 5), a = E.analyze(D); assert(Number.isInteger(a.horizons.swing.score) && Number.isInteger(a.horizons.short.score));
  E.setModel({ v: 1, w: {}, calib: {} }); fs.rmSync(dir, { recursive: true, force: true });
});
console.log(`\n${pass} checks passed`);
