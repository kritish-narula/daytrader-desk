// Unit tests for the 38 candlestick detectors (E.candles), their context, edge cases, E.candleCall trade levels and the engine hooks.
// Hand-built OHLC: an 80-bar prefix (down / up / flat, every bar range 1.6 → ATR = 1.6, last close 100) followed by the pattern bars.
// Each pattern: POSITIVE (fires), NEAR-MISS (one bar tweaked just past a rule → must not fire), TREND (same bars after the wrong
// prefix → must not fire, for patterns whose definition includes the prior trend). Run: node tools/candles.test.js
const assert = require('assert');
const E = require('../www/engine.js');
let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };

const DAY = 86400, T0 = Date.UTC(2024, 0, 1) / 1000;
function prefix(kind, n = 80) { // every bar: o = previous close, range 1.6, last close 100
  const B = [];
  if (kind === 'down') { let p = 100 + n * 0.6; for (let k = 0; k < n; k++) { const o = p, c = p - 0.6; B.push([o, o + 0.5, c - 0.5, c]); p = c; } }
  else if (kind === 'up') { let p = 100 - n * 0.6; for (let k = 0; k < n; k++) { const o = p, c = p + 0.6; B.push([o, c + 0.5, o - 0.5, c]); p = c; } }
  else { let p = 100; for (let k = 0; k < n; k++) { const c = (n - 1 - k) % 2 ? 100.8 : 100.0, o = p; B.push([o, Math.max(o, c) + 0.4, Math.min(o, c) - 0.4, c]); p = c; } }
  return B;
}
function mk(kind, bars, opts = {}) {
  const all = [...prefix(kind, opts.n), ...bars], sc = opts.scale || 1, D = { t: [], o: [], h: [], l: [], c: [], v: [] };
  all.forEach((b, k) => { D.t.push(T0 + k * DAY); D.o.push(b[0] * sc); D.h.push(b[1] * sc); D.l.push(b[2] * sc); D.c.push(b[3] * sc); D.v.push(b[4] != null ? b[4] : 1e6); });
  return D;
}
const keys = (D, i, o) => E.candles(D, i == null ? D.c.length - 1 : i, null, o).map(p => p.k);
const has = (D, k, o) => keys(D, null, o).includes(k);

// [key, prefix, positive bars, near-miss bars, wrong-trend prefixes]
const CASES = [
  ['bull_engulfing', 'down', [[100, 100.2, 98.6, 98.8], [98.6, 101.0, 98.4, 100.6]], [[100, 100.2, 98.6, 98.8], [98.6, 100.1, 98.4, 99.9]], ['flat', 'up']],
  ['hammer', 'down', [[99.0, 99.45, 97.4, 99.4]], [[99.0, 99.9, 97.4, 99.4]], ['flat', 'up']],
  ['morning_star', 'down', [[100, 100.1, 98.3, 98.4], [98.2, 98.4, 97.6, 98.0], [98.3, 99.9, 98.2, 99.8]], [[100, 100.1, 98.3, 98.4], [98.2, 98.4, 97.6, 98.0], [98.1, 99.15, 98.0, 99.1]], ['flat', 'up']],
  ['piercing', 'down', [[100, 100.1, 98.3, 98.4], [98.2, 99.8, 98.1, 99.6]], [[100, 100.1, 98.3, 98.4], [98.2, 99.1, 98.1, 99.0]], ['flat', 'up']],
  ['bull_harami', 'down', [[100, 100.1, 97.9, 98.0], [98.4, 99.0, 98.3, 98.9]], [[100, 100.1, 97.9, 98.0], [98.4, 100.4, 98.3, 100.3]], ['flat', 'up']],
  ['three_white_soldiers', 'flat', [[100.0, 101.3, 99.9, 101.2], [100.9, 102.4, 100.8, 102.3], [102.0, 103.6, 101.9, 103.5]], [[100.0, 101.3, 99.9, 101.2], [100.9, 102.4, 100.8, 102.3], [102.0, 104.6, 101.9, 103.5]], []],
  ['inverted_hammer', 'down', [[99.0, 101.0, 98.95, 99.4]], [[99.0, 101.0, 98.3, 99.4]], ['flat', 'up']],
  ['dragonfly_doji', 'down', [[99.4, 99.45, 97.5, 99.42]], [[99.4, 99.9, 97.5, 99.42]], ['flat', 'up']],
  ['bull_abandoned_baby', 'down', [[100, 100.1, 98.0, 98.1], [97.5, 97.7, 97.3, 97.52], [98.1, 99.6, 98.0, 99.5]], [[100, 100.1, 98.0, 98.1], [97.5, 98.0, 97.3, 97.52], [98.1, 99.6, 98.0, 99.5]], ['flat', 'up']],
  ['three_inside_up', 'down', [[100, 100.1, 97.9, 98.0], [98.3, 99.3, 98.2, 99.2], [99.3, 100.6, 99.2, 100.5]], [[100, 100.1, 97.9, 98.0], [98.3, 99.3, 98.2, 99.2], [99.3, 100.0, 99.2, 99.9]], ['flat', 'up']],
  ['three_outside_up', 'down', [[100, 100.1, 99.1, 99.2], [99.0, 100.6, 98.9, 100.4], [100.4, 101.3, 100.3, 101.2]], [[100, 100.1, 99.1, 99.2], [99.0, 100.6, 98.9, 100.4], [100.2, 100.5, 100.0, 100.35]], ['flat', 'up']],
  ['bull_kicker', 'down', [[100, 100.1, 98.5, 98.6], [100.2, 101.9, 100.1, 101.8]], [[100, 100.1, 98.5, 98.6], [99.8, 101.5, 99.7, 101.4]], []],
  ['tweezer_bottom', 'down', [[100, 100.1, 98.8, 99.0], [99.0, 100.1, 98.82, 99.9]], [[100, 100.1, 98.8, 99.0], [99.0, 100.1, 98.6, 99.9]], ['flat', 'up']],
  ['rising_three', 'up', [[100, 101.6, 99.9, 101.5], [101.4, 101.5, 100.8, 100.9], [100.9, 101.0, 100.4, 100.5], [100.5, 100.8, 100.3, 100.7], [100.8, 102.0, 100.7, 101.9]],
    [[100, 101.6, 99.9, 101.5], [101.4, 101.5, 100.8, 100.9], [100.9, 101.0, 99.5, 100.5], [100.5, 100.8, 100.3, 100.7], [100.8, 102.0, 100.7, 101.9]], ['down', 'flat']],
  ['concealing_baby_swallow', 'down', [[100, 100.05, 98.45, 98.5], [98.5, 98.55, 96.95, 97.0], [96.7, 97.2, 96.5, 96.6], [97.3, 97.35, 95.7, 95.8]],
    [[100, 100.05, 98.45, 98.5], [98.5, 98.55, 96.95, 97.0], [96.7, 97.2, 96.5, 96.6], [97.3, 97.35, 95.6, 96.55]], ['flat', 'up']],
  ['mat_hold', 'up', [[100, 101.6, 99.9, 101.5], [101.8, 102.0, 101.5, 101.6], [101.6, 101.7, 101.1, 101.2], [101.2, 101.4, 100.9, 101.1], [101.2, 102.6, 101.1, 102.5]],
    [[100, 101.6, 99.9, 101.5], [101.8, 102.0, 101.5, 101.6], [101.6, 101.7, 101.1, 101.2], [101.2, 101.4, 100.5, 101.1], [101.2, 102.6, 101.1, 102.5]], ['down', 'flat']],
  ['bull_separating_lines', 'up', [[100, 100.1, 99.2, 99.3], [100.05, 101.5, 100.0, 101.4]], [[100, 100.1, 99.2, 99.3], [100.4, 101.85, 100.35, 101.75]], ['down', 'flat']],
  ['bull_belt_hold', 'down', [[99.0, 101.1, 99.0, 100.9]], [[99.0, 101.1, 98.5, 100.9]], ['flat', 'up']],
  ['bull_three_line_strike', 'up', [[100, 100.9, 99.9, 100.8], [100.8, 101.7, 100.7, 101.6], [101.6, 102.5, 101.5, 102.4], [102.5, 102.6, 99.6, 99.7]],
    [[100, 100.9, 99.9, 100.8], [100.8, 101.7, 100.7, 101.6], [101.6, 102.5, 101.5, 102.4], [102.5, 102.6, 100.1, 100.2]], []],
  ['ladder_bottom', 'down', [[100, 100.1, 99.0, 99.1], [99.6, 99.7, 98.4, 98.5], [99.0, 99.1, 97.8, 97.9], [97.8, 98.6, 97.6, 97.7], [98.0, 99.6, 97.9, 99.5]],
    [[100, 100.1, 99.0, 99.1], [99.6, 99.7, 98.4, 98.5], [99.0, 99.1, 97.8, 97.9], [97.8, 98.6, 97.6, 97.7], [97.6, 98.65, 97.5, 98.55]], ['flat', 'up']],
  ['meeting_lines', 'down', [[100, 100.1, 98.5, 98.6], [97.4, 98.65, 97.3, 98.6]], [[100, 100.1, 98.5, 98.6], [97.4, 98.95, 97.3, 98.9]], ['flat', 'up']],
  ['bear_engulfing', 'up', [[100, 101.4, 99.8, 101.2], [101.4, 101.6, 99.0, 99.4]], [[100, 101.4, 99.8, 101.2], [101.4, 101.6, 100.0, 100.1]], ['flat', 'down']],
  ['bear_belt_hold', 'up', [[101.0, 101.0, 98.9, 99.1]], [[101.0, 101.5, 98.9, 99.1]], ['flat', 'down']],
  ['three_black_crows', 'flat', [[100, 100.1, 98.7, 98.8], [99.1, 99.2, 97.4, 97.5], [97.8, 97.9, 96.3, 96.4]], [[100, 100.1, 98.7, 98.8], [99.1, 99.2, 97.4, 97.5], [97.8, 97.9, 95.3, 96.4]], []],
  ['bear_three_line_strike', 'down', [[100, 100.1, 99.1, 99.2], [99.2, 99.3, 98.3, 98.4], [98.4, 98.5, 97.5, 97.6], [97.5, 100.4, 97.4, 100.3]],
    [[100, 100.1, 99.1, 99.2], [99.2, 99.3, 98.3, 98.4], [98.4, 98.5, 97.5, 97.6], [97.5, 99.9, 97.4, 99.8]], []],
  ['hanging_man', 'up', [[100.6, 101.05, 99.0, 101.0]], [[100.6, 101.5, 99.0, 101.0]], ['flat', 'down']],
  ['upside_gap_two_crows', 'up', [[100, 101.6, 99.9, 101.5], [102.2, 102.4, 101.8, 101.9], [102.3, 102.5, 101.6, 101.7]], [[100, 101.6, 99.9, 101.5], [102.2, 102.4, 101.8, 101.9], [102.3, 102.5, 101.3, 101.4]], ['flat', 'down']],
  ['evening_star', 'up', [[100, 101.7, 99.9, 101.6], [101.8, 102.2, 101.6, 102.0], [101.7, 101.8, 100.3, 100.4]], [[100, 101.7, 99.9, 101.6], [101.8, 102.2, 101.6, 102.0], [101.9, 102.0, 100.85, 100.9]], ['flat', 'down']],
  ['shooting_star', 'up', [[100.0, 102.05, 99.95, 100.4]], [[100.0, 102.05, 99.3, 100.4]], ['flat', 'down']],
  ['bear_harami', 'up', [[100, 102.1, 99.9, 102.0], [101.6, 101.7, 100.9, 101.0]], [[100, 102.1, 99.9, 102.0], [101.6, 101.7, 99.7, 99.8]], ['flat', 'down']],
  ['bear_doji_star', 'up', [[100, 101.7, 99.9, 101.6], [101.8, 102.2, 101.5, 101.82]], [[100, 101.7, 99.9, 101.6], [101.6, 102.0, 101.3, 101.62]], ['flat', 'down']],
  ['bear_abandoned_baby', 'up', [[100, 101.9, 99.9, 101.8], [102.3, 102.5, 102.1, 102.32], [101.8, 101.9, 100.3, 100.4]], [[100, 101.9, 99.9, 101.8], [102.3, 102.5, 101.9, 102.32], [101.8, 101.9, 100.3, 100.4]], ['flat', 'down']],
  ['tweezer_top', 'up', [[100, 101.2, 99.9, 101.0], [101.0, 101.22, 100.0, 100.1]], [[100, 101.2, 99.9, 101.0], [101.0, 101.5, 100.0, 100.1]], ['flat', 'down']],
  ['bear_kicker', 'up', [[100, 101.5, 99.9, 101.4], [99.8, 99.9, 98.1, 98.2]], [[100, 101.5, 99.9, 101.4], [100.3, 100.4, 98.6, 98.7]], []],
  ['three_inside_down', 'up', [[100, 102.1, 99.9, 102.0], [101.7, 101.8, 100.7, 100.8], [100.7, 100.8, 99.5, 99.6]], [[100, 102.1, 99.9, 102.0], [101.7, 101.8, 100.7, 100.8], [100.7, 100.8, 100.1, 100.2]], ['flat', 'down']],
  ['three_outside_down', 'up', [[100, 100.9, 99.9, 100.8], [101.0, 101.1, 99.4, 99.6], [99.6, 99.7, 98.6, 98.7]], [[100, 100.9, 99.9, 100.8], [101.0, 101.1, 99.4, 99.6], [99.7, 99.8, 99.5, 99.65]], ['flat', 'down']],
  ['bear_mat_hold', 'down', [[100, 100.1, 98.4, 98.5], [98.6, 99.2, 98.5, 99.1], [99.1, 99.6, 99.0, 99.5], [99.5, 99.7, 99.2, 99.3], [99.3, 99.4, 97.9, 98.0]],
    [[100, 100.1, 98.4, 98.5], [98.6, 99.2, 98.5, 99.1], [99.1, 99.6, 99.0, 99.5], [99.5, 99.7, 99.2, 99.3], [99.3, 99.4, 98.35, 98.45]], ['up', 'flat']],
  ['dark_cloud', 'up', [[100, 101.6, 99.9, 101.5], [101.7, 101.8, 100.3, 100.5]], [[100, 101.6, 99.9, 101.5], [101.55, 101.65, 100.3, 100.5]], ['flat', 'down']],
];

t('there are exactly 38 detectors, one test case each, 21 bullish + 17 bearish', () => {
  assert.strictEqual(E.CANDLE_DEFS.length, 38); assert.strictEqual(new Set(CASES.map(c => c[0])).size, 38);
  for (const d of E.CANDLE_DEFS) assert(CASES.find(c => c[0] === d.k), 'case for ' + d.k);
  assert.strictEqual(E.CANDLE_DEFS.filter(d => d.b > 0).length, 21); assert.strictEqual(E.CANDLE_DEFS.filter(d => d.b < 0).length, 17);
});
for (const [k, pre, pos, neg, wrong] of CASES) {
  const d = E.CANDLE_BY[k];
  t(`${k}: fires on the textbook sequence`, () => { const D = mk(pre, pos); assert(has(D, k), `${k} not detected; got [${keys(D)}]`); const p = E.candles(D).find(x => x.k === k); assert.strictEqual(p.len, pos.length); assert.strictEqual(p.b, d.b); assert.strictEqual(p.s, D.c.length - pos.length); });
  t(`${k}: near-miss does not fire`, () => { const D = mk(pre, neg); assert(!has(D, k), `${k} fired on the near-miss`); });
  for (const w of wrong) t(`${k}: no signal without the required prior trend (${w} prefix)`, () => { const D = mk(w, pos); assert(!has(D, k), `${k} fired after a ${w} prefix`); });
  t(`${k}: scale-free (prices ×37 → same detection)`, () => { const D = mk(pre, pos, { scale: 37 }); assert(has(D, k)); });
  t(`${k}: only bars ≤ i are used (bar i on a longer series = bar i on the truncated one)`, () => {
    const D = mk(pre, [...pos, [100, 140, 60, 70], [70, 71, 20, 21]]), i = D.c.length - 3;
    assert.deepStrictEqual(keys(D, i), keys(mk(pre, pos))); });
}
t('trend requirements declared in CANDLE_DEFS match the tests', () => { for (const [k, , , , wrong] of CASES) { const d = E.CANDLE_BY[k]; assert(d.tr ? wrong.length > 0 : wrong.length === 0, k); } });

// ---- edge cases ----
const ENG = CASES.find(c => c[0] === 'bull_engulfing');
t('NaN / missing price inside the pattern → no signal', () => { const D = mk('down', ENG[2]); D.o[D.o.length - 2] = NaN; assert(!has(D, 'bull_engulfing')); D.o[D.o.length - 2] = null; assert(!has(D, 'bull_engulfing')); });
t('zero / negative price → no signal', () => { const D = mk('down', ENG[2]); D.l[D.l.length - 2] = 0; assert(!has(D, 'bull_engulfing')); });
t('zero-range signal bar (circuit-locked / no trades) → nothing evaluated', () => { const D = mk('down', [[100, 100, 100, 100]]); const r = E.candles(D); assert.strictEqual(r.length, 0); assert.strictEqual(r.skip, 'bad bar'); });
t('zero-range bar inside a 3-bar pattern → no signal', () => { const M = CASES.find(c => c[0] === 'morning_star')[2].map(b => b.slice()); M[1] = [98.0, 98.0, 98.0, 98.0]; assert(!has(mk('down', M), 'morning_star')); });
t('inconsistent bar (high below close) is normalised, not rejected', () => { const B = ENG[2].map(b => b.slice()); B[1][1] = 100.5; /* high < close 100.6 */ assert(has(mk('down', B), 'bull_engulfing')); });
t('illiquid tiny-tick name (ATR < 4 ticks) → no signals at all', () => { const D = mk('down', ENG[2], { scale: 0.05 }); const r = E.candles(D); assert.strictEqual(r.length, 0); assert.strictEqual(r.skip, 'illiquid'); });
t('same tiny name with a 0.01 tick is evaluated', () => { const D = mk('down', ENG[2], { scale: 0.05 }); assert(has(D, 'bull_engulfing', { tick: 0.01 })); });
t('frozen name (ATR < 0.15% of price) → no signals', () => { const D = mk('flat', [[100, 100.05, 99.95, 100.02]]); for (let k = 0; k < D.c.length; k++) { D.h[k] = Math.max(D.o[k], D.c[k]) + 0.0; D.l[k] = Math.min(D.o[k], D.c[k]); D.o[k] = 100; D.c[k] = 100.05; D.h[k] = 100.1; D.l[k] = 100; } assert.strictEqual(E.candles(D, null, null, { tick: 0.01 }).skip, 'illiquid'); });
t('data hole > 7 days inside the pattern (suspension) → no signal; long weekend / holiday (4 days) is fine', () => {
  const D = mk('down', ENG[2]), n = D.t.length; D.t[n - 1] = D.t[n - 2] + 12 * DAY; assert(!has(D, 'bull_engulfing'));
  const D2 = mk('down', ENG[2]); D2.t[n - 1] = D2.t[n - 2] + 4 * DAY; assert(has(D2, 'bull_engulfing'));
});
t('a hole BEFORE the pattern does not block it', () => { const D = mk('down', ENG[2]), n = D.t.length; for (let k = n - 2; k < n; k++) D.t[k] += 30 * DAY; D.t[n - 1] = D.t[n - 2] + DAY; assert(has(D, 'bull_engulfing')); });
t('too little history → empty, no throw', () => { const D = { o: [100, 99], h: [101, 100], l: [99, 98], c: [99.5, 99.8] }; assert.deepStrictEqual(E.candles(D, 1).map(x => x.k), []); assert.deepStrictEqual(E.candles(null, 0), []); assert.deepStrictEqual(E.candles(D, 7), []); });
t('opening gap alone is not a "gap" for star patterns: evening star needs the star body at/above the first close', () => {
  const B = CASES.find(c => c[0] === 'evening_star')[2].map(b => b.slice()); B[1] = [101.3, 101.5, 101.0, 101.2]; assert(!has(mk('up', B), 'evening_star')); });
t('tweezer tolerance: lows 0.05·ATR apart = equal, 0.1·ATR apart = not', () => {
  const B = ENG[2]; const tw = lo => mk('down', [[100, 100.1, 98.8, 99.0], [99.0, 100.1, lo, 99.9]]);
  assert(has(tw(98.8 + 0.07), 'tweezer_bottom')); assert(!has(tw(98.8 + 0.17), 'tweezer_bottom')); });
t('hammer vs dragonfly doji are distinct (body vs no body)', () => { assert(!has(mk('down', [[99.4, 99.45, 97.5, 99.42]]), 'hammer')); assert(!has(mk('down', [[99.0, 99.45, 97.4, 99.4]]), 'dragonfly_doji')); });
t('hammer at the low but not at the bottom of the range (higher than prior 10-bar low + 0.25 ATR) → no hammer', () => { assert(!has(mk('down', [[101.5, 101.95, 99.95, 101.9]]), 'hammer')); });

// ---- context ----
t('E.candleCtx: trend, 200 EMA, 20-day extremes, volume, market regime', () => {
  const D = mk('down', ENG[2], { n: 260 }); D.v[D.v.length - 1] = 3e6; const I = E.indicators(D), i = D.c.length - 1, p = E.candles(D, i, I).find(x => x.k === 'bull_engulfing');
  const cx = E.candleCtx(D, I, i, p, false); assert(cx.all && cx.dn && !cx.up && cx.b200 && !cx.a200 && cx.lo20 && !cx.hi20 && cx.vol && cx.mktDn && !cx.mktUp);
  const cy = E.candleCtx(D, I, i, p, undefined); assert(!cy.mktDn && !cy.mktUp, 'unknown regime → neither');
  assert.strictEqual(E.candleCtxBits(cx) & 1, 1);
});

// ---- levels, model plumbing, E.candleCall ----
const SPEC = { entry: 'close', hold: 1, exit: 'close', stop: { type: 'pat', k: 0.25 }, target: { type: 'R', k: 1.5 }, winTest: 0.56, avgTest: 0.41, n: 120, avgF1: 0.3, medTest: 0.2, p5Test: -2.1 };
const MODEL = { v: 9, w: {}, calib: {}, candles: { v: 1, pats: {
  bull_engulfing: { b: 1, seen: { n: 900, win: 0.52, avg: 0.05 }, edges: [{ ctx: 'dn', m: 'cc1', trade: SPEC }] },
  hammer: { b: 1, seen: { n: 400, win: 0.49, avg: -0.04 }, edges: [] },
  bear_engulfing: { b: -1, edges: [{ ctx: 'bogus', trade: SPEC }, { ctx: 'all', m: 'cc1', trade: { entry: 'close', hold: 3, stop: { type: 'pat', k: 0 }, target: { type: 'none' }, avgTest: 1, winTest: 0.6, n: 50 } }] },
  not_a_pattern: { edges: [] } } } };
t('E.candleLevels: pattern stop ∓ k·ATR, R-multiple and ATR targets, both directions', () => {
  const p = { lo: 98, hi: 103 }; let L = E.candleLevels(SPEC, 1, 100, p, 2); assert.strictEqual(L.stop, 97.5); assert.strictEqual(L.target, 100 + 1.5 * 2.5);
  L = E.candleLevels({ stop: { type: 'pat', k: 0.5 }, target: { type: 'R', k: 2 } }, -1, 100, p, 2); assert.strictEqual(L.stop, 104); assert.strictEqual(L.target, 92);
  L = E.candleLevels({ stop: { type: 'atr', k: 1 }, target: { type: 'atr', k: 0.8 } }, 1, 100, p, 2); assert.strictEqual(L.stop, 98); assert.strictEqual(L.target, 101.6);
  L = E.candleLevels({ stop: { type: 'none' }, target: { type: 'R', k: 1 } }, 1, 100, p, 2); assert.strictEqual(L.stop, null); assert.strictEqual(L.target, null);
});
t('setModel keeps only well-formed candle entries', () => {
  assert(E.setModel(MODEL)); const C = E.MODEL.candles.pats; assert(C.bull_engulfing.edge && !C.hammer.edge && !C.bear_engulfing.edge && !C.not_a_pattern);
  assert.strictEqual(C.bear_engulfing.edges.length, 0, 'bad ctx and hold 3 dropped');
});
t('E.candleCall: proven pattern in matching context → concrete trade from the measured rule', () => {
  E.setModel(MODEL); const D = mk('down', ENG[2], { n: 260 }), I = E.indicators(D), i = D.c.length - 1, cc = E.candleCall(D, null, I, { niftyAbove200: false });
  assert.strictEqual(cc.i, i); const it = cc.items.find(x => x.k === 'bull_engulfing'); assert(it && it.edge && it.trade && it.label === 'proven edge');
  const A = E._atrAt(I, i, D.c[i]), p = E.candles(D, i, I).find(x => x.k === 'bull_engulfing'), stop = p.lo - 0.25 * A, R = x => +(Math.round(x / 0.05) * 0.05).toFixed(2);
  assert.strictEqual(it.trade.entry, R(D.c[i])); assert.strictEqual(it.trade.stop, R(stop)); assert.strictEqual(it.trade.target, R(D.c[i] + 1.5 * (D.c[i] - stop)));
  assert.strictEqual(it.trade.hold, 1); assert.strictEqual(it.trade.n, 120); assert(/Tested out of sample/.test(it.trade.text)); assert.strictEqual(cc.items[0].k, 'bull_engulfing', 'trade first');
});
t('E.candleCall: context mismatch → listed as "seen, no proven edge", no trade', () => {
  E.setModel(MODEL); const D = mk('up', CASES.find(c => c[0] === 'rising_three')[2]); const it = E.candleCall(D).items[0];
  assert(it && !it.trade && it.label === 'not measured yet', 'rising three not in model');
  const D2 = mk('down', [[99.0, 99.45, 97.4, 99.4]]), h = E.candleCall(D2).items.find(x => x.k === 'hammer'); assert(h && !h.trade && h.label === 'seen, no proven edge' && h.seen.n === 400);
  const M2 = JSON.parse(JSON.stringify(MODEL)); M2.candles.pats.bull_engulfing.edges[0].ctx = 'up'; E.setModel(M2);
  const e = E.candleCall(mk('down', ENG[2], { n: 260 })).items.find(x => x.k === 'bull_engulfing'); assert(!e.trade && e.label === 'seen, no proven edge');
});
t('E.candleCall: a rule that lost money in fold 1 never trades; live → last COMPLETED bar', () => {
  const M2 = JSON.parse(JSON.stringify(MODEL)); M2.candles.pats.bull_engulfing.edges[0].trade.avgF1 = -0.1; E.setModel(M2);
  assert(!E.candleCall(mk('down', ENG[2], { n: 260 })).items.find(x => x.k === 'bull_engulfing').trade);
  E.setModel(MODEL); const D = mk('down', [...ENG[2], [100.6, 100.7, 90, 90.5]], { n: 260 }), cc = E.candleCall(D, null, null, { live: true });
  assert.strictEqual(cc.i, D.c.length - 2); assert(cc.items.find(x => x.k === 'bull_engulfing' && x.trade));
});
t('E.analyze / E.quick carry candles (quick ≤ 3, compact) and horizon scores are unchanged by the candle model', () => {
  const D = mk('down', ENG[2], { n: 260 }); E.setModel({ v: 9, w: {}, calib: {} }); const a0 = E.analyze(D, { backtest: true });
  E.setModel(MODEL); const a1 = E.analyze(D, { backtest: true, niftyAbove200: false }), q = E.quick(D, { niftyAbove200: false });
  for (const hz of ['intraday', 'swing', 'short', 'medium', 'long']) if (!a0.horizons[hz].na) assert.strictEqual(a1.horizons[hz].score, a0.horizons[hz].score, hz);
  assert(Array.isArray(a1.candles) && a1.candles.find(x => x.k === 'bull_engulfing' && x.trade));
  assert(q.candles.length <= 3 && q.candles[0].k === 'bull_engulfing' && q.candles[0].edge && q.candles[0].stop > 0 && q.candles[0].nT === 120);
  assert(a1.patterns.find(p => p.n === 'Bullish engulfing'), 'E.patterns keeps its name for the replaced detector');
});
t('Tomorrow (btst): proven bullish candle explained in why[], score unchanged; skipped on a forming candle', () => {
  const D = mk('down', ENG[2], { n: 260 }); E.setModel({ v: 9, w: {}, calib: {} }); const b0 = E.btst(D, null, {});
  E.setModel(MODEL); const b1 = E.btst(D, null, { niftyAbove200: false }), b2 = E.btst(D, null, { frac: 0.5 });
  assert.strictEqual(b1.score, b0.score); assert(b1.why.some(w => /^candle: Bullish engulfing/.test(w))); assert(b1.candles && b1.candles[0].k === 'bull_engulfing');
  assert(!b2.candles && !b2.why.some(w => /^candle:/.test(w)));
});
t('E.patterns: old loose hammer (only "below the 20 EMA") no longer fires without a real downtrend', () => {
  const D = mk('flat', [[99.0, 99.45, 97.4, 99.4]], { n: 260 }); E.setModel({ v: 9, w: {}, calib: {} }); const a = E.analyze(D); assert(!a.patterns.find(p => p.n === 'Hammer'));
});
// ---- research helpers (tools/candles_research.js) ----
const CR = require('./candles_research.js');
const SS = (bars, A = 2) => { const n = bars.length; return { n, t: Float64Array.from(bars, (_, k) => T0 + k * DAY), o: Float64Array.from(bars, b => b[0]), h: Float64Array.from(bars, b => b[1]), l: Float64Array.from(bars, b => b[2]), c: Float64Array.from(bars, b => b[3]), A: new Float64Array(n).fill(A) }; };
t('sim: stop / target fills, gap through a level fills at the open, stop first when both touched, time exit, next-open entry, exit at open', () => {
  const ev = { i: 0, b: 1, lo: 98, hi: 101 }, sp = (st, tg, o) => Object.assign({ entry: 'close', hold: 1, exit: 'close', stop: st, target: tg }, o || {});
  const near = (a, b) => assert(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
  near(CR.sim(SS([[100, 101, 99, 100], [100, 105, 99.5, 101]]), ev, sp({ type: 'pat', k: 0 }, { type: 'R', k: 1 })), 2 - 0.25);       // target 102 hit
  near(CR.sim(SS([[100, 101, 99, 100], [100, 100.5, 97, 99]]), ev, sp({ type: 'pat', k: 0 }, { type: 'R', k: 1 })), -2 - 0.25);       // stop 98 hit
  near(CR.sim(SS([[100, 101, 99, 100], [96, 97, 95, 96.5]]), ev, sp({ type: 'pat', k: 0 }, { type: 'R', k: 1 })), -4 - 0.25);         // gapped through the stop → open
  near(CR.sim(SS([[100, 101, 99, 100], [100, 103, 97, 101]]), ev, sp({ type: 'pat', k: 0 }, { type: 'R', k: 1 })), -2 - 0.25);        // both touched → stop
  near(CR.sim(SS([[100, 101, 99, 100], [100, 101, 99, 100.5]]), ev, sp({ type: 'none' }, { type: 'none' })), 0.5 - 0.25);             // time exit
  near(CR.sim(SS([[100, 101, 99, 100], [99, 101, 98.9, 100]]), ev, sp({ type: 'atr', k: 1 }, { type: 'none' }, { entry: 'nextOpen' })), (100 / 99 - 1) * 100 - 0.25);
  assert(isNaN(CR.sim(SS([[100, 101, 99, 100], [97, 98, 96, 97]]), ev, sp({ type: 'pat', k: 0 }, { type: 'none' }, { entry: 'nextOpen' }))), 'opened below the stop → no entry');
  near(CR.sim(SS([[100, 101, 99, 100], [101, 102, 97, 98]]), ev, sp({ type: 'none' }, { type: 'none' }, { exit: 'open' })), 1 - 0.25);
  near(CR.sim(SS([[100, 101, 99, 100], [100, 100.5, 97, 98]]), { i: 0, b: -1, lo: 99, hi: 101 }, sp({ type: 'pat', k: 0 }, { type: 'R', k: 1 })), 1 - 0.25); // short: stop 101, target 99 hit
  near(CR.sim(SS([[100, 101, 99, 100], [100, 101, 97, 98]]), { i: 0, b: -1, lo: 99, hi: 101 }, sp({ type: 'pat', k: 0 }, { type: 'R', k: 1 })), -1 - 0.25); // short: both touched → stop
  const S5 = SS([[100, 101, 99, 100], [100, 101, 99.5, 100.5], [100.5, 101, 100, 100.7], [100.7, 101, 100.2, 100.9], [101, 101.5, 100.6, 101.2], [101.2, 101.6, 100.8, 101.4]]);
  near(CR.sim(S5, ev, sp({ type: 'pat', k: 0 }, { type: 'none' }, { hold: 5 })), 1.4 - 0.30);
  assert(isNaN(CR.sim(S5, Object.assign({}, ev, { i: 2 }), sp({ type: 'none' }, { type: 'none' }, { hold: 5 }))), 'not enough bars');
  const H = SS([[100, 101, 99, 100], [100, 101, 99, 101]]); H.t[1] = H.t[0] + 20 * DAY; assert(isNaN(CR.sim(H, ev, sp({ type: 'none' }, { type: 'none' }))), 'data hole → dropped');
  assert(isNaN(CR.raw(SS([[100, 101, 99, 100], [150, 151, 149, 150]]), 0, 'cc1')), '> 40% move (unadjusted split) dropped');
});
t('stats: date-clustered lower bound is wider than iid when one day has many signals; dedup keeps one per stock per window', () => {
  const v = [], b = [], c1 = [], c2 = []; for (let k = 0; k < 60; k++) { const x = k < 30 ? 1 : -0.2 + 0.01 * k; v.push(x); b.push(0); c1.push(k); c2.push(k < 30 ? 0 : k); }
  const iid = CR.stats(v, b, c1), cl = CR.stats(v, b, c2); assert(Math.abs(iid.avg - cl.avg) < 1e-12 && cl.lo < iid.lo && cl.G === 31 && iid.G === 60);
  assert.strictEqual(iid.n, 60); assert(iid.win > 0.5 && iid.p5 <= iid.med);
  const d = CR.dedup([{ s: 1, i: 10 }, { s: 1, i: 11 }, { s: 1, i: 15 }, { s: 2, i: 11 }], 5); assert.deepStrictEqual(d.map(x => x.s + ':' + x.i), ['1:10', '1:15', '2:11']);
});
t('candles_research.js end-to-end on stub data: report sections, parity, model merged (other keys kept, v+1), --merge, engine accepts', () => {
  const os = require('os'), fs = require('fs'), path = require('path'), cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candles-test-')), mp = path.join(dir, 'model.json'), rp = path.join(dir, 'report.txt'), sp = path.join(dir, 'sec.json');
  fs.writeFileSync(mp, JSON.stringify({ v: 4, w: { a: 1 }, calib: {}, lin: { keep: 1 }, research: { x: 1 } }));
  const syms = Array.from({ length: 24 }, (_, k) => 'STK' + k).join(',');
  const r = cp.spawnSync(process.execPath, ['-r', path.join(__dirname, 'fno_stub.js'), path.join(__dirname, 'candles_research.js')], { encoding: 'utf8', timeout: 300e3,
    env: Object.assign({}, process.env, { YF_CACHE: path.join(dir, 'cache'), RESEARCH_SYMS: syms, MODEL_PATH: mp, REPORT_PATH: rp, CANDLES_SECTION: sp, CANDLE_FORCE: '1', CANDLE_MIN_N: '15', RESEARCH_DRY: '' }) });
  assert.strictEqual(r.status, 0, r.stderr); const rep = fs.readFileSync(rp, 'utf8');
  for (const s of ['ALL SIGNALS', 'BY CONTEXT', 'TRADES', 'DECISION']) assert(rep.includes('==================== ' + s), s);
  assert(/Parity .*: 300 bars, all match/.test(rep), 'detection parity'); assert(/Trade-level parity .*: \d+ signals, all match/.test(rep) && !/MISMATCH/.test(rep), 'trade parity');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8')); assert.strictEqual(m.v, 5); assert.deepStrictEqual(m.lin, { keep: 1 }); assert.deepStrictEqual(m.w, { a: 1 }); assert.deepStrictEqual(m.research, { x: 1 });
  assert(m.candles && m.candles.forced && Object.keys(m.candles.pats).length === 38 && m.candles.pats.bull_engulfing.seen.n > 0);
  assert(E.setModel(m) && E.MODEL.candles && Object.keys(E.MODEL.candles.pats).length === 38);
  for (const P of Object.values(m.candles.pats)) for (const e of P.edges) assert(E.MODEL.candles.pats[Object.keys(m.candles.pats).find(k => m.candles.pats[k] === P)].edges.length === P.edges.length, 'edge survives validation');
  fs.writeFileSync(mp, JSON.stringify({ v: 9, lin: { newer: 1 } }));
  const r2 = cp.spawnSync(process.execPath, [path.join(__dirname, 'candles_research.js'), '--merge', sp], { encoding: 'utf8', env: Object.assign({}, process.env, { MODEL_PATH: mp }) });
  assert.strictEqual(r2.status, 0, r2.stderr); const m2 = JSON.parse(fs.readFileSync(mp, 'utf8')); assert(m2.v === 10 && m2.lin.newer === 1 && m2.candles.pats.hammer);
  fs.rmSync(dir, { recursive: true, force: true });
});
E.setModel({ v: 1, w: {}, calib: {} });
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
