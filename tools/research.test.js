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
console.log(`\n${pass} checks passed`);
