// Unit tests for the paper-trading simulator (www/paper.js). Run: node tools/paper.test.js
'use strict';
const assert = require('assert');
const P = require('../www/paper.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok   ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n     ', e.message); } };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} ± ${eps}, got ${a}`);
const noVix = { vix: () => 14 };

// ---------- Black-Scholes ----------
t('BS call/put match textbook (S=K=100, T=1, r=5%, σ=20%)', () => { near(P.bs(100, 100, 1, 0.2, 'CE', 0.05, 0).p, 10.4506, 1e-3); near(P.bs(100, 100, 1, 0.2, 'PE', 0.05, 0).p, 5.5735, 1e-3); });
t('BS Hull example 15.6 (S=42,K=40,T=0.5,r=10%,σ=20%): C=4.76, P=0.81', () => { near(P.bs(42, 40, 0.5, 0.2, 'CE', 0.1, 0).p, 4.76, 0.01); near(P.bs(42, 40, 0.5, 0.2, 'PE', 0.1, 0).p, 0.81, 0.01); });
t('put-call parity with dividend yield', () => { const S = 26000, K = 26100, T = 7 / 365, r = 0.06, q = 0.012, s = 0.13; const c = P.bs(S, K, T, s, 'CE', r, q).p, p = P.bs(S, K, T, s, 'PE', r, q).p; near(c - p, S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-6); });
t('ATM weekly NIFTY premium is sensible (≈0.4·S·σ·√T)', () => { const S = 26000, T = 5 / 365, p = P.bs(S, S, T, 0.13, 'CE', 0.06, 0.012).p; near(p, 0.4 * S * 0.13 * Math.sqrt(T), 25); });
t('theta: same spot, one day later → cheaper option', () => { const o = { und: 'NIFTY', k: 26000, cp: 'CE', exp: '2026-12-01' }; assert.ok(P.optPrice(o, 26000, '2026-11-25', 'close', 13) > P.optPrice(o, 26000, '2026-11-26', 'close', 13)); });
t('expiry close settles at intrinsic', () => { const o = { und: 'NIFTY', k: 26000, cp: 'PE', exp: '2026-12-01' }; near(P.optPrice(o, 25800, '2026-12-01', 'close', 13), 200, 1e-9); });
t('put skew: lower strike gets higher IV, IV ≈ VIX at the money', () => { const T = 7 / 365; near(P.iv('NIFTY', 14, 26000, 26000, T), 0.14, 1e-9); assert.ok(P.iv('NIFTY', 14, 26000, 25000, T) > P.iv('NIFTY', 14, 26000, 27000, T)); assert.ok(P.iv('BANKNIFTY', 14, 60000, 60000, T) > 0.14); });

// ---------- calendar ----------
t('NIFTY weekly expiry on Tuesday; holiday (24-Nov-2026) moves it to Monday', () => { assert.deepStrictEqual(P.expiries('NIFTY', '2026-11-18', 3), ['2026-11-23', '2026-12-01', '2026-12-08']); });
t('BANKNIFTY monthly = last Tuesday', () => { assert.deepStrictEqual(P.expiries('BANKNIFTY', '2026-11-25', 2), ['2026-12-29', '2027-01-26']); });
t('SENSEX weekly Thursday', () => { assert.deepStrictEqual(P.expiries('SENSEX', '2026-11-20', 2), ['2026-11-26', '2026-12-03']); });
t('before 1-Sep-2025: NIFTY Thursday, SENSEX Tuesday', () => { assert.strictEqual(P.expiries('NIFTY', '2025-08-25', 1)[0], '2025-08-28'); assert.strictEqual(P.expiries('SENSEX', '2025-08-20', 1)[0], '2025-08-26'); });
t('Holi 3-Mar-2026 (Tue) → NIFTY expiry Monday 2-Mar', () => assert.strictEqual(P.expiries('NIFTY', '2026-02-26', 1)[0], '2026-03-02'));
t('pickExpiry skips an expiry with < 2 sessions left', () => { assert.strictEqual(P.pickExpiry('NIFTY', '2026-11-20'), '2026-12-01'); assert.strictEqual(P.pickExpiry('NIFTY', '2026-11-18'), '2026-11-23'); });
t('trading days skip weekends and holidays', () => { assert.strictEqual(P.nextTradingDay('2026-11-23'), '2026-11-25'); assert.strictEqual(P.prevTradingDay('2026-11-16'), '2026-11-13'); });

// ---------- costs ----------
t('delivery buy ₹25,000 ≈ ₹53 (brokerage 20 + STT 25 + stamp 3.75 + txn + GST)', () => near(P.orderCost('EQ', 'B', 25000, '2026-11-01'), 53.26, 0.05));
t('delivery sell adds DP charge, no stamp', () => near(P.orderCost('EQ', 'S', 25000, '2026-11-01'), 20 + 25 + 0.7425 + 0.025 + 16 + 0.18 * 20.7675, 0.01));
t('futures STT 0.02% before 1-Apr-2026, 0.05% after', () => { const a = P.orderCost('FUT', 'S', 1e6, '2026-03-31'), b = P.orderCost('FUT', 'S', 1e6, '2026-04-01'); near(b - a, 300, 1e-6); near(P.orderCost('FUT', 'B', 1e6, '2026-05-01') - P.orderCost('FUT', 'B', 1e6, '2026-03-01'), 0, 1e-9); });
t('options: STT only on the sell side, on premium', () => { const b = P.orderCost('OPT', 'B', 10000, '2026-05-01'), s = P.orderCost('OPT', 'S', 10000, '2026-05-01'); near(s - b, 15 - 0.3, 1e-6); });
t('slippage is adverse', () => { assert.ok(P.slip('EQ', 100, 'B') > 100 && P.slip('EQ', 100, 'S') < 100); near(P.slip('OPT', 10, 'B'), 10.5, 1e-9); near(P.slip('OPT', 200, 'S'), 198, 1e-9); });

// ---------- fills and exits ----------
const mkSt = () => { const st = P.newState('2026-11-02'); st.cancelled = {}; return st; };
const order = (x = {}) => Object.assign({ s: 'pb20', sym: 'TEST', seg: 'EQ', b: 1, type: 'open', entry: 100, stop: 95, t1: 107.5, t2: 115, hold: 10, q: 60, sig: '2026-11-02', age: 0 }, x);
const B = (o, h, l, c) => ({ o, h, l, c });
t('next-open order: fills at open + slippage, sized by ₹1,000 risk and ₹25k cap', () => { const st = mkSt(), tr = P.tryFill(st, order(), B(100, 101, 99, 100.5), '2026-11-03', noVix); assert.ok(tr); near(tr.px0, 100.05, 1e-9); assert.strictEqual(tr.qty, Math.min(Math.floor(1000 / 5.05), Math.floor(25000 / 100.05))); });
t('next-open order cancelled when it opens below the stop', () => { const st = mkSt(), o = order(); assert.strictEqual(P.tryFill(st, o, B(94, 96, 93, 95), '2026-11-03', noVix), null); assert.ok(/stop/.test(o.dead)); });
t('buy-stop fills at max(open, trigger) — gap above trigger fills at the open', () => { const st = mkSt(); let tr = P.tryFill(st, order({ type: 'stop', entry: 102 }), B(101, 103, 100.5, 102.5), '2026-11-03', noVix); near(tr.u0, 102, 1e-9); tr = P.tryFill(mkSt(), order({ type: 'stop', entry: 102 }), B(103, 104, 102.8, 103.5), '2026-11-03', noVix); near(tr.u0, 103, 1e-9); });
t('buy-stop not triggered → stays pending', () => { const o = order({ type: 'stop', entry: 102 }); assert.strictEqual(P.tryFill(mkSt(), o, B(100, 101.5, 99, 101), '2026-11-03', noVix), null); assert.ok(!o.dead); });
t('gap through the stop exits at the open (not at the stop)', () => {
  const st = mkSt(), tr = P.tryFill(st, order(), B(100, 101, 99.5, 100.5), '2026-11-03', noVix); P.step(st, tr, B(100, 101, 99.5, 100.5), '2026-11-03', noVix);
  P.step(st, tr, B(92, 93, 91, 92.5), '2026-11-04', noVix); assert.strictEqual(st.open.length, 0); const c = st.closed[0]; near(c.parts[0].px, 92 * (1 - 0.0005), 0.01); assert.ok(/gapped/.test(c.exitWhy)); assert.ok(c.R < -1.5, 'gap loss is worse than 1R: ' + c.R);
});
t('stop and target inside the same bar → stop first (conservative)', () => {
  const st = mkSt(), tr = P.tryFill(st, order(), B(100, 101, 99.5, 100.5), '2026-11-03', noVix); P.step(st, tr, B(100, 101, 99.5, 100.5), '2026-11-03', noVix);
  P.step(st, tr, B(100, 109, 94, 100), '2026-11-04', noVix); assert.strictEqual(st.closed[0].exitWhy, 'stop');
});
t('Target 1: half out, stop to entry, rest out at breakeven', () => {
  const st = mkSt(), tr = P.tryFill(st, order(), B(100, 101, 99.5, 100.5), '2026-11-03', noVix); P.step(st, tr, B(100, 101, 99.5, 100.5), '2026-11-03', noVix);
  P.step(st, tr, B(101, 108, 100.5, 107), '2026-11-04', noVix); assert.strictEqual(st.open.length, 1); assert.strictEqual(tr.qty, tr.q0 - Math.floor(tr.q0 / 2)); near(tr.stop, tr.u0, 1e-9);
  P.step(st, tr, B(105, 106, 99, 100), '2026-11-05', noVix); const c = st.closed[0]; assert.strictEqual(c.exitWhy, 'breakeven stop'); assert.ok(c.pnl > 0, 'T1 half profit beats costs');
});
t('Target 2 after Target 1 closes the trade with > 1R', () => {
  const st = mkSt(), tr = P.tryFill(st, order(), B(100, 101, 99.5, 100.5), '2026-11-03', noVix); P.step(st, tr, B(100, 101, 99.5, 100.5), '2026-11-03', noVix);
  P.step(st, tr, B(101, 116, 100.5, 115.5), '2026-11-04', noVix); const c = st.closed[0]; assert.strictEqual(c.exitWhy, 'Target 2'); assert.ok(c.R > 1.5, 'R ' + c.R);
});
t('time exit at the close after `hold` sessions', () => {
  const st = mkSt(), tr = P.tryFill(st, order({ hold: 2 }), B(100, 101, 99.5, 100.5), '2026-11-03', noVix); P.step(st, tr, B(100, 101, 99.5, 100.5), '2026-11-03', noVix);
  P.step(st, tr, B(100.5, 101, 99.8, 100.8), '2026-11-04', noVix); P.step(st, tr, B(100.8, 102, 100, 101.5), '2026-11-05', noVix); const c = st.closed[0]; assert.ok(/time exit/.test(c.exitWhy)); near(c.parts[0].px, 101.5 * (1 - 0.0005), 0.01);
});
t('short futures: stop above, profit when price falls; costs charged', () => {
  const st = mkSt(), o = order({ s: 'fut_sw', seg: 'FUT', b: -1, entry: 1000, stop: 1020, t1: 970, t2: 940, lot: 500 }), tr = P.tryFill(st, o, B(1000, 1002, 995, 998), '2026-11-03', noVix); assert.ok(tr && tr.lots >= 1);
  P.step(st, tr, B(1000, 1002, 995, 998), '2026-11-03', noVix); P.step(st, tr, B(990, 992, 935, 940), '2026-11-04', noVix); const c = st.closed[0]; assert.ok(c.pnl > 0 && c.costs > 0); assert.strictEqual(c.exitWhy, 'Target 2');
});
t('cash limit: no token positions when the account is fully invested', () => {
  const st = mkSt(); for (let k = 0; k < 4; k++) { const x = P.tryFill(st, order({ sym: 'S' + k, stop: 99 }), B(100, 100, 100, 100), '2026-11-03', noVix); assert.ok(x); }
  const o = order({ sym: 'S9', stop: 99 }); assert.strictEqual(P.tryFill(st, o, B(100, 100, 100, 100), '2026-11-03', noVix), null); assert.ok(/cash/.test(o.dead));
});
t('option buy: premium from BS at the open, premium-halved stop', () => {
  const st = mkSt(), o = order({ s: 'opt_app', sym: 'NIFTY', seg: 'OPT', entry: 26000, stop: 25700, t1: 26450, t2: 26900, hold: 3, opt: { und: 'NIFTY', k: 26000, cp: 'CE', exp: '2026-12-01', lot: 65 } });
  const tr = P.tryFill(st, o, B(26000, 26050, 25950, 26020), '2026-11-25', noVix); assert.ok(tr.px0 > 100 && tr.px0 < 400, 'premium ' + tr.px0); assert.strictEqual(tr.qty % 65, 0);
  P.step(st, tr, B(26000, 26050, 25950, 26020), '2026-11-25', noVix); P.step(st, tr, B(25800, 25820, 25650, 25700), '2026-11-26', noVix); const c = st.closed[0]; assert.ok(c && c.pnl < 0); assert.ok(c.parts[0].px >= 0.4 * tr.px0, 'exit premium ' + c.parts[0].px);
});
t('option buy: exit the day before expiry', () => {
  const st = mkSt(), o = order({ s: 'opt_itm', sym: 'NIFTY', seg: 'OPT', entry: 26000, stop: 25500, t1: 26800, t2: 27500, hold: 5, opt: { und: 'NIFTY', k: 25950, cp: 'CE', exp: '2026-12-01', lot: 65 } });
  const tr = P.tryFill(st, o, B(26000, 26050, 25950, 26020), '2026-11-27', noVix); P.step(st, tr, B(26000, 26050, 25950, 26020), '2026-11-27', noVix, false); P.step(st, tr, B(26020, 26080, 25990, 26050), '2026-11-30', noVix, true); assert.strictEqual(st.closed[0].exitWhy, 'exit the day before expiry');
});
t('iron condor: credit > 0, loss capped by the wings at expiry', () => {
  const st = mkSt(), o = { s: 'ic', sym: 'NIFTY', und: 'NIFTY', seg: 'IC', b: 0, type: 'open', exp: '2026-12-01', width: 200, lot: 65, sig: '2026-11-25', hold: 99, age: 0 };
  const tr = P.tryFill(st, o, B(26000, 26000, 26000, 26000), '2026-11-26', noVix); assert.ok(tr && tr.credit > 0 && tr.credit < 200, 'credit ' + (tr && tr.credit));
  P.step(st, tr, B(26000, 26100, 25950, 26050), '2026-11-26', noVix);
  if (st.open.length) P.step(st, tr, B(27500, 27600, 27400, 27500), '2026-12-01', noVix); // huge rally: call spread fully ITM
  const c = st.closed[0]; assert.ok(c); assert.ok(c.pnl >= -(200 - tr.credit) * tr.q0 - 2000, `loss ${c.pnl} beyond max ${(200 - tr.credit) * tr.q0}`);
});
t('stats: shrunk expectancy and min-trade gate', () => {
  const tr = Array.from({ length: 10 }, (_, k) => ({ R: k % 2 ? 2 : -1, pnl: k % 2 ? 2000 : -1000 })); const x = P.stats(tr, [100000, 101000, 100500, 105000], 100000);
  assert.strictEqual(x.n, 10); assert.strictEqual(x.win, 50); near(x.avgR, 0.5, 1e-9); near(x.shrunkR, 0.25, 1e-9); near(x.pf, 2, 1e-9); assert.ok(x.score > 0); near(x.ret, 5, 1e-9);
  assert.strictEqual(P.stats(tr.slice(0, 5), null, 1e5).score, null);
});
t('review: promotion needs two good weeks; bad strategy demoted', () => {
  const good = { n: 30, score: 1.2, shrunkR: 0.3, pf: 1.8, formR: 0.2, avgR: 0.4 }, bad = { n: 30, score: -1, shrunkR: -0.2, pf: 0.7, formR: -0.4, avgR: -0.3 };
  assert.strictEqual(P.judge('New', good).st, 'Watch'); assert.strictEqual(P.judge('Watch', good).st, 'Promoted'); assert.strictEqual(P.judge('Promoted', bad).st, 'Demoted'); assert.strictEqual(P.judge('Demoted', good).st, 'Watch');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
