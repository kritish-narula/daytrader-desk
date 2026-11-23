// Walk-forward validation on real data (no look-ahead).
// 1) Do chart patterns / setups hit target before stop?  2) Does each rating factor predict forward returns (IC)?
// 3) Do rating buckets separate forward returns — on a TRAIN universe and an out-of-sample TEST universe?
const E = require('../www/engine.js');
const TRAIN = ['RELIANCE','TCS','HDFCBANK','ICICIBANK','INFY','BHARTIARTL','SBIN','ITC','LT','HINDUNILVR','KOTAKBANK','AXISBANK','BAJFINANCE','MARUTI','SUNPHARMA','HCLTECH','M&M','TITAN','ASIANPAINT','ULTRACEMCO','NTPC','POWERGRID','ONGC','TATASTEEL','JSWSTEEL','ADANIPORTS','COALINDIA','WIPRO','TECHM','NESTLEIND','BAJAJFINSV','HINDALCO','CIPLA','DRREDDY','EICHERMOT','BRITANNIA','APOLLOHOSP','INDUSINDBK','TRENT','BEL'];
const TEST = ['TATAPOWER','IOC','BPCL','GAIL','PNB','BANKBARODA','CANBK','BHEL','SAIL','NMDC','PFC','RECLTD','SIEMENS','ABB','PIDILITIND','DABUR','GODREJCP','HAVELLS','DMART','NAUKRI','POLYCAB','DIVISLAB','LUPIN','AUROPHARMA','TVSMOTOR','ASHOKLEY','CHOLAFIN','MUTHOOTFIN','FEDERALBNK','IDFCFIRSTB','PERSISTENT','COFORGE','MPHASIS','DIXON','IRCTC','HINDZINC','VOLTAS','TATACOMM','PAGEIND','BALKRISIND'];
const MODE = process.argv[2] || 'full';
async function daily(s) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}.NS?range=5y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const R = (await r.json()).chart.result[0], q = R.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [] };
  R.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null)) return; D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); });
  return D;
}
const slice = (D, a, b) => ({ t: D.t.slice(a, b), o: D.o.slice(a, b), h: D.h.slice(a, b), l: D.l.slice(a, b), c: D.c.slice(a, b), v: D.v.slice(a, b) });
function outcome(D, i, dir, stop, target, hold = 30) { for (let j = i + 1; j <= Math.min(D.c.length - 1, i + hold); j++) { if (dir > 0 ? D.l[j] <= stop : D.h[j] >= stop) return -1; if (dir > 0 ? D.h[j] >= target : D.l[j] <= target) return 1; } return 0; }
function corr(x, y) { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let a = 0, b = 0, c = 0; for (let k = 0; k < n; k++) { a += (x[k] - mx) * (y[k] - my); b += (x[k] - mx) ** 2; c += (y[k] - my) ** 2; } return a / Math.sqrt(b * c); }
async function run(SYMS, label, doPatterns) {
  const pat = {}, ic = {}, B = { rating: {}, swing: {}, short: {} }; let stocks = 0;
  const bk = r => r >= 70 ? '70+' : r >= 58 ? '58-69' : r > 42 ? '43-57' : '<=42';
  for (const s of SYMS) {
    let D; try { D = await daily(s); } catch (e) { continue; } if (D.c.length < 600) continue; stocks++;
    const seen = new Set();
    for (let i = 320; i < D.c.length - 21; i += 2) {
      const W = slice(D, i - 299, i + 1), I = E.indicators(W), k = W.c.length - 1;
      if (doPatterns) {
        const items = [...E.chartPatterns(I, 0.05).filter(p => p.status !== 'forming').map(p => ({ n: p.n, b: p.b, stop: p.stop, target: p.target, key: p.n + p.id })),
                       ...E.setups(I, k, 0.05).filter(x => x.entry && x.stop && x.target && x.k !== 'PRE').map(x => ({ n: x.n, b: x.b, stop: x.stop, target: x.target, key: x.n + Math.floor(i / 10) }))];
        for (const it of items) { if (!it.b || seen.has(s + it.key)) continue; seen.add(s + it.key);
          const o = outcome(D, i, it.b, it.stop, it.target), P = pat[it.n] = pat[it.n] || { n: 0, w: 0, l: 0, rr: 0 };
          P.n++; P.rr += Math.abs(it.target - D.c[i]) / Math.max(1e-9, Math.abs(D.c[i] - it.stop)); if (o > 0) P.w++; else if (o < 0) P.l++; }
      }
      if (i % 6 === 0) {
        const f10 = (D.c[i + 10] / D.c[i] - 1) * 100, f20 = (D.c[i + 20] / D.c[i] - 1) * 100;
        for (const hz of ['swing', 'short']) for (const f of E._factors(I, k, hz)) { const key = hz + ': ' + f[2]; const X = ic[key] = ic[key] || { x: [], y: [] }; X.x.push(f[1]); X.y.push(hz === 'swing' ? f10 : f20); }
        const A = E.analyze(W, { backtest: false }); if (A.err) continue;
        const add = (o, r, f) => (o[bk(r)] = o[bk(r)] || []).push(f);
        add(B.rating, E.rating(A).rating, f10); add(B.swing, A.horizons.swing.score, f10); add(B.short, A.horizons.short.score, f20);
      }
    }
  }
  console.log(`\n===== ${label}: ${stocks} stocks, 5y daily, walk-forward =====`);
  if (doPatterns) {
    console.log('Pattern/setup'.padEnd(44), 'signals  target-first  avg R:R  break-even');
    for (const [n, P] of Object.entries(pat).sort((a, b) => b[1].n - a[1].n)) { const rr = P.rr / P.n, be = 100 / (1 + rr), wr = 100 * P.w / Math.max(1, P.w + P.l);
      console.log(n.padEnd(44), String(P.n).padStart(6), `${wr.toFixed(0)}%`.padStart(12), rr.toFixed(2).padStart(8), `${be.toFixed(0)}% ${wr >= be ? 'EDGE' : 'no edge'}`.padStart(14)); }
  }
  console.log('Factor IC (correlation of factor value with forward return; >0.02 useful, <0 inverted)');
  for (const [k, X] of Object.entries(ic).sort()) if (X.x.length > 200) console.log('  ' + k.padEnd(52), corr(X.x, X.y).toFixed(3), ` n=${X.x.length}`);
  for (const [name, o] of Object.entries(B)) { console.log(`Buckets by ${name} score → forward ${name === 'short' ? 20 : 10}-day return`);
    for (const b of ['70+', '58-69', '43-57', '<=42']) { const a = o[b] || []; if (!a.length) continue; const m = a.reduce((x, y) => x + y, 0) / a.length; console.log('  ' + b.padEnd(7), `n=${a.length}`.padEnd(8), `avg ${m >= 0 ? '+' : ''}${m.toFixed(2)}%`.padEnd(13), `up ${(100 * a.filter(x => x > 0).length / a.length).toFixed(0)}%`); } }
}
(async () => { await run(TRAIN, 'TRAIN (large caps)', MODE !== 'fast'); await run(TEST, 'TEST (out-of-sample mid/large caps)', MODE === 'full'); })();
