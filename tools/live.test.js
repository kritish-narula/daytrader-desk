const E = require('../www/engine.js'); E.setModel(require('../www/model.json'));
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
for (let s = 0; s < 30; s++) {
  const D = { t: [], o: [], h: [], l: [], c: [], v: [] }; let p = 100 + 50 * rnd();
  for (let k = 0; k < 500; k++) { const o = p, c = o * (1 + (rnd() - 0.48) * 0.04); D.t.push(1.7e9 + k * 86400); D.o.push(o); D.c.push(c); D.h.push(Math.max(o, c) * (1 + rnd() * 0.01)); D.l.push(Math.min(o, c) * (1 - rnd() * 0.01)); D.v.push(1e6 * (0.5 + rnd())); p = c; }
  const base = Object.fromEntries(Object.entries(D).map(([k, v]) => [k, v.slice(0, -1)]));
  const A0 = E.analyze(base, { backtest: true });
  const variants = [0.6, 1.0, 1.05].map(m => { const X = JSON.parse(JSON.stringify(D)); const n = X.c.length - 1; X.c[n] = X.c[n - 1] * m; X.h[n] = Math.max(X.h[n], X.c[n]); X.l[n] = Math.min(X.l[n], X.c[n]); X.v[n] = m * 3e5; return X; });
  for (const X of variants) {
    const A = E.analyze(X, { backtest: true, live: true, price: X.c[X.c.length - 1] }), q = E.quick(X, { live: true, price: X.c[X.c.length - 1] });
    for (const hz of ['swing', 'short', 'medium', 'long']) { ok(A.horizons[hz].score === A0.horizons[hz].score, `page ${hz}`); ok(q.horizons[hz].score === A0.horizons[hz].score, `quick ${hz}`); }
    ok(Math.abs(A.chg - (X.c[X.c.length - 1] / X.c[X.c.length - 2] - 1) * 100) < 1e-9, 'chg vs yesterday');
    ok(A.live === true && q.live === true && q.mv === E.MODEL.v, 'flags');
  }
  const N = E.analyze(D, { backtest: true }); ok(N.live === false, 'not live by default');
}
console.log(pass + ' passed, ' + fail + ' failed');
