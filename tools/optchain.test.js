// Unit tests for www/optchain.js maths: node tools/optchain.test.js
'use strict';
const OC = require('../www/optchain.js');
let pass = 0, fail = 0;
const near = (a, b, tol, msg) => { if (Math.abs(a - b) <= tol) pass++; else { fail++; console.log('FAIL', msg, a, '!=', b); } };
const eq = (a, b, msg) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', msg, JSON.stringify(a), '!=', JSON.stringify(b)); } };

// Black-Scholes textbook values (Hull): S=100 K=100 T=1 r=5% σ=20%
const c = OC.bs(100, 100, 1, 0.2, 'CE', 0.05), p = OC.bs(100, 100, 1, 0.2, 'PE', 0.05);
near(c.p, 10.4506, 1e-3, 'call price'); near(p.p, 5.5735, 1e-3, 'put price');
near(c.delta, 0.6368, 1e-3, 'call delta'); near(p.delta, -0.3632, 1e-3, 'put delta');
near(c.gamma, 0.018762, 1e-5, 'gamma'); near(p.gamma, c.gamma, 1e-12, 'gamma CE = PE');
near(c.vega, 0.37524, 1e-4, 'vega per vol pt'); near(c.theta * 365, -6.414, 1e-2, 'call theta / yr'); near(p.theta * 365, -1.658, 1e-2, 'put theta / yr');
near(c.p - p.p, 100 - 100 * Math.exp(-0.05), 1e-6, 'put-call parity');
near(c.pitm, 0.5596, 1e-3, 'P(ITM) = N(d2)');
// expiry / zero vol → intrinsic
eq(OC.bs(110, 100, 0, 0.2, 'CE').p, 10, 'intrinsic at expiry'); eq(OC.bs(90, 100, 0, 0.2, 'CE').p, 0, 'OTM worthless at expiry');

// implied vol round-trips across moneyness, short expiries and both sides
for (const [S, K, T, s, cp] of [[24120, 24100, 6 / 365, 0.12, 'CE'], [24120, 24500, 6 / 365, 0.14, 'CE'], [24120, 23500, 2 / 365, 0.18, 'PE'], [1300, 1400, 30 / 365, 0.32, 'CE'], [52040, 52000, 0.5 / 365, 0.2, 'PE'], [100, 100, 1, 0.9, 'CE']]) {
  const pr = OC.bs(S, K, T, s, cp).p; near(OC.iv(pr, S, K, T, cp), s, 1e-4, `iv round trip ${S}/${K}/${cp}`);
}
eq(OC.iv(5, 24120, 24000, 6 / 365, 'CE'), null, 'iv null below intrinsic');
eq(OC.iv(0, 24120, 24000, 6 / 365, 'CE'), null, 'iv null at zero price');

// OI interpretation
eq(['LB', 'SB', 'SC', 'LU', ''].join(), [OC.interpret(5, 100), OC.interpret(-5, 100), OC.interpret(5, -100), OC.interpret(-5, -100), OC.interpret(0, 100)].join(), 'interpretation');

// max pain: hand-computed
const rows = [{ k: 100, ce: { oi: 10 }, pe: { oi: 50 } }, { k: 110, ce: { oi: 30 }, pe: { oi: 30 } }, { k: 120, ce: { oi: 60 }, pe: { oi: 5 } }];
// pain(100)= PE: 30*10+5*20=400 ; pain(110)= CE 10*10=100 + PE 5*10=50 → 150 ; pain(120)= CE 10*20+30*10=500
eq(OC.maxPain(rows), 110, 'max pain');

// analytics on a symmetric synthetic chain
const S = 24120, T = OC.tYears('2026-12-01', Date.parse('2026-11-25T10:00:00+05:30'));
const R = []; for (let k = 23500; k <= 24800; k += 50) R.push({ k, ce: { ltp: OC.bs(S, k, T, 0.12, 'CE').p, oi: 1000 + (k === 24500 ? 9e5 : 0), doi: k === 24300 ? 5e4 : 100, vol: 10, ivSrc: 0.12, chg: 1 }, pe: { ltp: OC.bs(S, k, T, 0.12, 'PE').p, oi: 1200 + (k === 23800 ? 8e5 : 0), doi: k === 23900 ? 6e4 : 50, vol: 12, ivSrc: 0.12, chg: -1 } });
const ch = { exp: '2026-12-01', spot: S, rows: R }; OC.enrich(ch, Date.parse('2026-11-25T10:00:00+05:30')); const an = OC.analytics(ch);
eq(an.atm, 24100, 'ATM'); eq(an.res, 24500, 'resistance = max CE OI'); eq(an.sup, 23800, 'support = max PE OI'); eq(an.buildCE, 24300, 'CE OI build'); eq(an.buildPE, 23900, 'PE OI build');
near(an.atmIV, 0.12, 1e-9, 'ATM IV'); near(an.pcr, an.peOI / an.ceOI, 1e-12, 'PCR'); eq(an.step, 50, 'strike step');
near(an.straddle, R.find(r => r.k === 24100).ce.ltp + R.find(r => r.k === 24100).pe.ltp, 1e-9, 'straddle');
near(an.skew.pts, 0, 1e-9, 'flat skew');
// solved IV when the source has none
const ch2 = { exp: '2026-12-01', spot: S, rows: R.map(r => ({ k: r.k, ce: Object.assign({}, r.ce, { ivSrc: null }), pe: Object.assign({}, r.pe, { ivSrc: null }) })) };
OC.enrich(ch2, Date.parse('2026-11-25T10:00:00+05:30')); near(ch2.rows.find(r => r.k === 24100).ce.iv, 0.12, 1e-4, 'solved IV');

// compact numbers
eq([OC.cmp(950), OC.cmp(12345), OC.cmp(123456), OC.cmp(3.4e7), OC.cmp(-2.5e5)].join(), '950,12K,1.2L,3.4Cr,-2.5L', 'compact');
eq(OC.toNse('2026-11-25'), '25-Nov-2026', 'toNse'); eq(OC.fromNse('02-Dec-2026'), '2026-12-02', 'fromNse');

// trading days left (Wed 25-Nov-2026 10:00 IST → Tue 1-Dec: 25,26,27,30,1 = 5)
eq(OC.tradingDaysLeft('2026-12-01', Date.parse('2026-11-25T10:00:00+05:30')), 5, 'trading days left');
eq(OC.tradingDaysLeft('2026-12-01', Date.parse('2026-11-25T16:00:00+05:30')), 4, 'after close excludes today');
eq(OC.pickExpiry(['2026-11-25', '2026-12-01'], 'intraday', Date.parse('2026-11-25T10:00:00+05:30')), '2026-12-01', 'skip expiry-day contract');
// Taylor projection never below intrinsic
near(OC.project(10, { delta: 0.5, gamma: 0, theta: 0 }, -100, 0, 100, 0, 'CE'), 0.05, 1e-9, 'floor 0.05');

// big move 1 day before expiry: BS re-price caps the Taylor overshoot; result ≥ intrinsic
{ const S0 = 80110, K = 80100, T = 1 / 365, iv = 0.13, g = OC.bs(S0, K, T, iv, 'CE'), P0 = g.p, S1 = S0 + 1500;
  const taylor = P0 + g.delta * 1500 + 0.5 * g.gamma * 1500 * 1500, pr = OC.project(P0, g, 1500, 0.1, K, S1, 'CE', { iv, T, S0 });
  if (pr < taylor && pr >= S1 - K) pass++; else { fail++; console.log('FAIL project cap', pr, taylor); }
  near(OC.project(P0, g, 0, 0, K, S0, 'CE', { iv, T, S0 }), P0, 1e-6, 'no move, no time → same premium'); }
// buildCall: bullish NIFTY plan on the synthetic chain
const o = { sym: 'NIFTY', side: 'CE', ce: 72, pe: 28, open: true, late: false, hzKey: 'swing', hzLabel: 'Swing', L: { entry: 24120, stop: 23980, t1: 24330, t2: 24540 }, why: [] };
ch.lot = 65; ch.src = 'NSE'; ch.an = an; ch.hasVol = true;
const call = OC.buildCall(o, ch, { now: Date.parse('2026-11-25T10:00:00+05:30'), mins: 600 });
console.log('call', JSON.stringify({ k: call.k, d: call.g && call.g.delta.toFixed(3), entry: [call.entryLo, call.entryHi], sl: call.sl, t1: call.t1, t2: call.t2, rr: call.rr && call.rr.toFixed(2), conf: call.conf, notrade: call.notrade, lotCap: call.capLot, maxLoss: call.maxLossLot }));
if (!call.notrade) {
  const d = Math.abs(call.g.delta); if (d >= 0.45 && d <= 0.65) pass++; else { fail++; console.log('FAIL delta band', d); }
  if (call.sl < call.entryLo && call.t1 > call.entryHi && call.t2 > call.t1) pass++; else { fail++; console.log('FAIL premium ordering'); }
  if (call.sl >= call.ltp * 0.55 - 0.05 && call.sl <= call.ltp * 0.85 + 0.05) pass++; else { fail++; console.log('FAIL SL bounds', call.sl, call.ltp); }
  near(call.capLot, call.entryHi * 65, 1e-6, 'capital per lot');
} else { fail++; console.log('FAIL unexpected no-trade', call.notrade); }
// no side → no trade
if (OC.buildCall(Object.assign({}, o, { side: null, ce: 55, pe: 45 }), ch).notrade) pass++; else { fail++; console.log('FAIL no-trade'); }
// target too close → no trade (R:R)
if (OC.buildCall(Object.assign({}, o, { L: { entry: 24120, stop: 23900, t1: 24140, t2: 24160 } }), ch, { now: Date.parse('2026-11-25T10:00:00+05:30'), mins: 600 }).notrade) pass++; else { fail++; console.log('FAIL rr no-trade'); }

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
