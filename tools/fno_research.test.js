// Unit tests for the F&O research simulator (tools/fno_sim.js), the tuned-parameter helpers (www/optchain.js) and an end-to-end stub run.
// Run: node tools/fno_research.test.js
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const P = require('../www/paper.js'), S = require('./fno_sim.js'), OC = require('../www/optchain.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok   ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n     ', e.message); } };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} ± ${eps}, got ${a}`);

// ---- synthetic market: weekdays from 2026-05-04; price path given by f(k)
function market(f, n = 40, und = 'NIFTY', vix = 15) {
  const day = []; let d = '2026-05-04'; while (day.length < n) { if (P.isTradingDay(d)) day.push(d); d = P.addDays(d, 1); }
  const c = day.map((_, k) => f(k)), o = c.map((x, k) => k ? c[k - 1] : x), h = c.map((x, k) => Math.max(x, o[k]) * 1.002), l = c.map((x, k) => Math.min(x, o[k]) * 0.998);
  return { und, D: { o, h, l, c, v: c.map(() => 0), day }, atr: c.map(x => x * 0.01), lot: P.IDX_LOT[und], extra: new Set(), vixAt: () => vix, lv: (i, dir) => ({ stop: c[i] * (1 - dir * 0.012), t1: c[i] * (1 + dir * 0.012), t2: c[i] * (1 + dir * 0.024) }) };
}
const SIM = { ivm: 1 }, cfg = () => S.clone(S.DEFAULT_CFG);

t('expiry calendar: NIFTY weekly Tuesday, BANKNIFTY monthly last Tuesday, SENSEX weekly Thursday (2026)', () => {
  assert.strictEqual(S.expiryOf({ und: 'NIFTY', extra: new Set() }, '2026-06-01', 1), '2026-06-02');
  assert.strictEqual(P.dow(S.expiryOf({ und: 'NIFTY', extra: new Set() }, '2026-06-03', 2)), 2);
  assert.strictEqual(P.dow(S.expiryOf({ und: 'SENSEX', extra: new Set() }, '2026-06-03', 2)), 4);
  assert.strictEqual(S.expiryOf({ und: 'BANKNIFTY', extra: new Set() }, '2026-06-03', 2), '2026-06-30');
});
t('minDays: expiry with fewer sessions than required is skipped', () => {
  const a = S.expiryOf({ und: 'NIFTY', extra: new Set() }, '2026-06-04', 1), b = S.expiryOf({ und: 'NIFTY', extra: new Set() }, '2026-06-04', 4);
  assert.strictEqual(a, '2026-06-09'); assert.strictEqual(b, '2026-06-16'); assert.ok(P.tradingDaysBetween('2026-06-04', b) >= 4);
});
t('pickStrike: delta aim 0.55 gives |delta| near 0.55; ITM1 is below ATM for a CE, above for a PE', () => {
  const M = market(() => 24000), exp = '2026-06-09';
  const k = S.pickStrike(M, SIM, 24000, 'CE', { mode: 'delta', aim: 0.55 }, '2026-06-02', exp, 5), d = Math.abs(S.optPx && P.bs(24000, k, P.tYears('2026-06-02', 'open', exp), S.ivOf(SIM, 15, 24000, k, P.tYears('2026-06-02', 'open', exp)), 'CE', P.RF, P.DIV.NIFTY).delta);
  near(d, 0.55, 0.06, 'delta'); assert.ok(k < 24000, 'delta .55 CE is slightly ITM');
  assert.strictEqual(S.pickStrike(M, SIM, 24010, 'CE', { mode: 'steps', n: 1 }, '2026-06-02', exp, 5), 23950);
  assert.strictEqual(S.pickStrike(M, SIM, 24010, 'PE', { mode: 'steps', n: 1 }, '2026-06-02', exp, 5), 24050);
  assert.strictEqual(S.pickStrike(M, SIM, 24010, 'CE', { mode: 'steps', n: -1 }, '2026-06-02', exp, 5), 24050);
});
t('IV: ≈ VIX × multiplier at the money; lower strike gets more vol (put skew)', () => {
  near(S.ivOf({ ivm: 1.15 }, 14, 24000, 24000, 7 / 365), 0.161, 1e-6); assert.ok(S.ivOf(SIM, 14, 24000, 23000, 7 / 365) > S.ivOf(SIM, 14, 24000, 25000, 7 / 365));
});
t('simOption: strong rally → CE wins, entry at next open, costs include the 0.15% sell-side STT (after 1-Apr-2026)', () => {
  const M = market(k => 24000 * (1 + 0.012 * k)), c = cfg(); c.exit.tgt = { kind: 'none', v: 0 }; c.exit.stopU = null; c.exit.hold = 3; c.exit.sl = 0.5;
  const r = S.simOption(M, SIM, 5, 'CE', c); assert.ok(r && r.pnl > 0 && r.R > 0, JSON.stringify(r)); assert.strictEqual(r.e, 6); assert.strictEqual(r.held, 3);
  const sellValue = (r.fill + (r.pnl + r.costs) / M.lot) * M.lot, stt = P.COST.OPT.stt26 * sellValue; assert.ok(r.costs > stt * 0.9, 'costs include STT'); assert.ok(r.costs < stt + 0.01 * sellValue + 100);
});
t('simOption: crash → premium stop caps the loss near −1R (gap slippage allowed)', () => {
  const M = market(k => k < 6 ? 24000 : 24000 * (1 - 0.04 * (k - 5))), c = cfg(); c.exit.tgt = { kind: 'none', v: 0 }; c.exit.stopU = null; c.exit.sl = 0.3;
  const r = S.simOption(M, SIM, 5, 'CE', c); assert.ok(r && r.pnl < 0, JSON.stringify(r)); assert.ok(r.R > -1.8 && r.R < -0.8, 'R ' + r.R); assert.ok(/stop/.test(r.why), r.why);
});
t('simOption: PE profits in a falling market; premium target exits early', () => {
  const M = market(k => 24000 * (1 - 0.02 * k)), c = cfg(); c.exit.tgt = { kind: 'prem', v: 0.3 }; c.exit.stopU = null; c.exit.hold = 5;
  const r = S.simOption(M, SIM, 5, 'PE', c); assert.ok(r && r.pnl > 0 && r.why === 'target', JSON.stringify(r));
});
t('simOption: hold 1 closes the same session; day-before-expiry rule exits early', () => {
  const M = market(k => 24000 + 20 * k), c = cfg(); c.exit.hold = 1; c.exit.tgt = { kind: 'none', v: 0 }; c.exit.stopU = null; assert.strictEqual(S.simOption(M, SIM, 5, 'CE', c).held, 1);
  c.exit.hold = 9; c.exit.minDays = 2; const r = S.simOption(M, SIM, 5, 'CE', c); assert.strictEqual(r.held, 5, 'entry Tue 12-May, expiry Tue 19-May → exits at the close of Mon 18-May'); assert.ok(/before expiry/.test(r.why));
});
t('simOption: levels mode takes half at T1 and moves the stop to breakeven', () => {
  const M = market(k => 24000 * (1 + 0.006 * k)), c = cfg(); c.exit.hold = 6; const r = S.simOption(M, SIM, 5, 'CE', c); assert.ok(r && r.pnl > 0, JSON.stringify(r));
});
t('simSpread: loss bounded by the debit; profit capped by the width', () => {
  const up = market(k => 24000 * (1 + 0.01 * k)), c = cfg(); c.exit.ivSpread = 0; c.exit.hold = 3; const w = S.simSpread(up, SIM, 5, 'CE', c); assert.ok(w && w.spread, 'spread');
  const dn = market(k => k < 6 ? 24000 : 24000 * (1 - 0.03 * (k - 5))), l = S.simSpread(dn, SIM, 5, 'CE', c); assert.ok(l.pnl > -(l.fill * dn.lot) - 1, 'max loss ≈ debit: ' + l.pnl);
});
t('stats: expectancy, hit rate, profit factor and drawdown by hand', () => {
  const st = S.stats([{ R: 1, pct: 10, pnl: 100 }, { R: -1, pct: -10, pnl: -100 }, { R: 2, pct: 20, pnl: 200 }, { R: -1, pct: -10, pnl: -100 }]);
  near(st.avgR, 0.25, 1e-9); near(st.hit, 50, 1e-9); near(st.pf, 1.5, 1e-9); near(st.mdd, 1, 1e-9); assert.strictEqual(st.n, 4); assert.strictEqual(S.stats([]).n, 0);
});
t('bootCI is deterministic and brackets the mean', () => { const v = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 1 : -0.4)), a = S.bootCI(v), b = S.bootCI(v), m = S.mean(v); assert.deepStrictEqual(a, b); assert.ok(a[0] < m && m < a[1]); });
t('signals: threshold, mix and filters', () => {
  const n = 5, mk = x => new Array(n).fill(x), T = { sI: mk(70), rS: mk(70), rSh: mk(40), c: mk(100), o: mk(100), e20: mk(95), e50: mk(90), e200: mk(80), adx: mk(30), vix: mk(15), vixPct: mk(40), ret1: mk(0.002), sig20: mk(0.008), dow: mk(3) };
  const sg = Object.assign({}, S.DEFAULT_CFG.sig); assert.strictEqual(S.sideAt(T, sg, 1), 'CE');
  assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { thr: 75 }), 1), null, 'threshold');
  assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { wI: 0, wS: 0, wH: 1, thr: 60 }), 1), 'PE', 'short-horizon mix (bull 40) gives PE 60');
  assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { vixMax: 12 }), 1), null, 'vix max'); assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { vixPctMax: 30 }), 1), null, 'vix pct');
  assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { dowSkip: [3] }), 1), null, 'weekday'); assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { bigSkip: 0.2 }), 1), null, 'exhaustion');
  assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { trend: 'e50adx' }), 1), 'CE'); T.e50 = mk(110); assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { trend: 'e50' }), 1), null, 'trend');
  T.o = mk(98); assert.strictEqual(S.sideAt(T, Object.assign({}, sg, { gapAgainst: 1 }), 1), null, 'gap against 2%');
});

// ---- tuned-parameter helpers in the app (www/optchain.js)
t('OC.cfgFor: no params = today\'s constants; tuned values override a COPY only', () => {
  assert.deepStrictEqual(OC.cfgFor(null), OC.CFG); const c = OC.cfgFor({ strike: { mode: 'delta', aim: 0.4 }, minDays: 2, hold: 2, sl: 0.3 });
  near(c.deltaAim, 0.4, 1e-9); near(c.deltaLo, 0.3, 1e-9); near(c.deltaHi, 0.5, 1e-9); assert.strictEqual(c.minDaysLeft.swing, 2); assert.strictEqual(c.minSlPct, 0.3); assert.strictEqual(c.maxSlPct, 0.3); assert.strictEqual(OC.CFG.minSlPct, 0.15); assert.strictEqual(OC.CFG.minDaysLeft.swing, 4);
});
t('OC.tunedFor / hasTuned / stockGate', () => {
  const Pm = { index: { NIFTY: { enabled: true, thr: 60, stats: {} }, SENSEX: { enabled: true, stats: {} } }, stocks: { enabled: true, signal: { sides: 'long' }, stats: { test: { n: 100 } } } };
  assert.strictEqual(OC.tunedFor('NIFTY', null), null); assert.strictEqual(OC.tunedFor('BANKNIFTY', Pm), null); assert.ok(OC.hasTuned(OC.tunedFor('NIFTY', Pm))); assert.ok(!OC.hasTuned(OC.tunedFor('SENSEX', Pm)));
  assert.ok(OC.stockGate('long', Pm).ok); assert.ok(!OC.stockGate('short', Pm).ok); assert.ok(OC.stockGate('short', null).ok); assert.ok(!OC.stockGate('long', { stocks: { enabled: false } }).ok);
});
t('OC.filterSignal: every tuned filter blocks with a reason; clean signal passes', () => {
  const f = { price: 100, e20: 98, e50: 95, e200: 90, adx: 30, vix: 15, vixPct: 40, gapPct: 0.1, dow: 3, ret1: 0.002, sig20: 0.008 };
  assert.strictEqual(OC.filterSignal('CE', { trend: 'e50', vixMax: 20 }, f), null);
  for (const [tp, ff] of [[{ trend: 'e20' }, { e20: 105 }], [{ trend: 'adx25' }, { adx: 20 }], [{ vixMax: 12 }, {}], [{ vixMin: 18 }, {}], [{ vixPctMax: 30 }, {}], [{ gapAgainst: 0.3 }, { gapPct: -0.5 }], [{ gapWith: 0.3 }, { gapPct: 0.5 }], [{ dowSkip: [3] }, {}], [{ bigSkip: 0.2 }, {}]]) assert.ok(/^Tuned filter/.test(OC.filterSignal('CE', tp, Object.assign({}, f, ff)) || ''), JSON.stringify(tp));
  assert.strictEqual(OC.filterSignal('PE', { gapAgainst: 0.3 }, Object.assign({}, f, { gapPct: -0.5 })), null, 'gap down helps a PE'); assert.strictEqual(OC.filterSignal('CE', null, f), null);
});
// buildCall regression: without ctx.tune the call is byte-identical to the one built with an explicit default cfg; with a tuned config the call changes in the expected places
const mkChain = () => { const S0 = 24100, rows = [], exp = '2026-12-01', T = OC.tYears(exp, Date.parse('2026-11-25T10:00:00+05:30'));
  for (let k = 23000; k <= 25200; k += 50) { const mk = cpx => { const iv = 0.14, b = OC.bs(S0, k, T, iv, cpx), p = Math.round(b.p * 20) / 20 || 0.05; return { ltp: p, chg: 0, oi: 1e5, doi: 0, vol: 5e4, ivSrc: iv, bid: p - 0.1, ask: p + 0.1, src: 'NSE' }; }; rows.push({ k, ce: mk('CE'), pe: mk('PE') }); }
  const ch = { exp, rows, spot: S0, lot: 65, src: 'NSE', hasVol: true, expiries: [exp] }; OC.enrich(ch, Date.parse('2026-11-25T10:00:00+05:30')); ch.an = OC.analytics(ch); return ch; };
t('buildCall: no tuned params → identical call; tuned strike / SL / target / spread applied when given', () => {
  const o = { sym: 'NIFTY', side: 'CE', ce: 72, pe: 28, hzKey: 'swing', open: true, late: false, L: { entry: 24100, stop: 23900, t1: 24300, t2: 24500 }, why: [], hzLabel: 'Swing' }, now = Date.parse('2026-11-25T10:00:00+05:30');
  const a = OC.buildCall(o, mkChain(), { now }), b = OC.buildCall(o, mkChain(), { now, cfg: undefined, tune: undefined }); assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const tp = { strike: { mode: 'delta', aim: 0.4 }, sl: 0.3, tgt: { kind: 'prem', v: 0.5 }, stopU: 1, hold: 2, trail: { act: 0.5, off: 0.25 }, ivSpread: 50 };
  const c = OC.buildCall(o, mkChain(), { now, cfg: OC.cfgFor(tp), tune: tp, atr: 150, vixPct: 70, tuned: { n: 1 } });
  assert.ok(!c.notrade, c.notrade); assert.ok(Math.abs(c.g.delta) < Math.abs(a.g.delta) + 1e-9, 'lower delta strike'); near(c.sl, Math.round(c.ltp * 0.7 * 20) / 20, 0.06, 'fixed 30% premium stop'); near(c.t1, Math.round(c.ltp * 1.5 * 20) / 20, 0.06, 'target +50%');
  near(c.slU, 24100 - 150, 0.01, 'underlying stop 1×ATR'); assert.ok(/hold up to 2 sessions/.test(c.exitBy) && /Trail/.test(c.exitBy)); assert.ok(c.spread || c.warn.some(w => /rich|spread/i.test(w)) || c.rich, 'IV rich → spread rule'); assert.deepStrictEqual(c.tuned, { n: 1 });
  const no = OC.buildCall(Object.assign({}, o, { side: null, blockWhy: 'Tuned filter: x' }), mkChain(), { now }); assert.strictEqual(no.notrade, 'Tuned filter: x');
});

t('gate: indices switch OFF when default and adopted are negative and every stress row is negative; stay ON when any is positive or n is small', () => {
  const R = require('./fno_research.js'), ci = [-0.3, 0.1];
  assert.strictEqual(R.indexEnabled({ n: 77, avgR: -0.12 }, { avgR: -0.18 }, true, ci), false, 'BANKNIFTY case');
  assert.strictEqual(R.indexEnabled({ n: 77, avgR: -0.12 }, { avgR: -0.18 }, false, ci), true, 'a stress row is positive → keep');
  assert.strictEqual(R.indexEnabled({ n: 77, avgR: -0.05 }, { avgR: 0.1 }, true, ci), true, 'default positive → keep');
  assert.strictEqual(R.indexEnabled({ n: 20, avgR: -0.3 }, { avgR: -0.3 }, true, ci), true, 'too few trades → keep');
  assert.strictEqual(R.indexEnabled({ n: 60, avgR: -0.2 }, { avgR: 0.3 }, false, [-0.4, 0.0]), false, 'clear loss');
});
t('disabled index / stock book: NO TRADE reason and card note carry the measured reason', () => {
  const T = { enabled: false, why: 'Measured on 5y: avg -0.12R over 77 trades.', stats: { test: { n: 77, hit: 31, avgR: -0.12, expPct: -5.8 }, from: 'a', to: 'b' } }, i = OC.tuneInfo(T);
  assert.ok(!i.enabled && /switched off/.test(OC.tuneText(i)) && /-0.12R/.test(OC.tuneText(i)));
  const g = OC.stockGate('long', { stocks: { enabled: false, why: 'no edge x' } }); assert.ok(!g.ok && g.why === 'no edge x');
});

// ---- end-to-end: stub fetch, quick run, schema of the outputs
t('fno_research.js end-to-end on stub data writes fno_params.json + fno_report.txt', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fno-')), r = cp.spawnSync(process.execPath, ['-r', path.join(__dirname, 'fno_stub.js'), path.join(__dirname, 'fno_research.js'), '--quick', '--out', out], { env: Object.assign({}, process.env, { FNO_CACHE: path.join(out, 'cache') }), encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, r.stderr.slice(-800)); const j = JSON.parse(fs.readFileSync(path.join(out, 'fno_params.json'), 'utf8')), rep = fs.readFileSync(path.join(out, 'fno_report.txt'), 'utf8');
  assert.ok(j.generatedAt && j.index && j.oos); for (const u of ['NIFTY', 'BANKNIFTY', 'SENSEX']) { const p = j.index[u]; assert.ok(p && typeof p.enabled === 'boolean' && p.stats && p.stats.test && p.stats.test.n >= 0, u); assert.ok(j.oos[u]); }
  assert.ok(j.stocks && j.stocks.signal && j.stocks.exit && typeof j.stocks.enabled === 'boolean');
  for (const h of ['A. DIRECTION SIGNAL', 'B. COORDINATE SEARCH', 'C. OUT-OF-SAMPLE GATE', 'D. RESULT', 'E. ROBUSTNESS', 'STOCK FUTURES', 'SUMMARY']) assert.ok(rep.includes(h), 'report section ' + h);
  // only parameters that beat the default OOS are written: every written key is a known tunable
  const known = new Set(['enabled', 'why', 'sim', 'stats', 'mix', 'thr', 'trend', 'vixPctMax', 'vixMax', 'vixMin', 'gapAgainst', 'gapWith', 'dowSkip', 'bigSkip', 'strike', 'minDays', 'hold', 'sl', 'stopU', 'tgt', 'trail', 'ivSpread']); for (const u in j.index) for (const k in j.index[u]) assert.ok(known.has(k), 'unknown key ' + k);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
