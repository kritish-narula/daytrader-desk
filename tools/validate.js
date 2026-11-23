// Walk-forward validation on real data: do chart patterns / setups hit their targets, and do higher ratings lead to better forward returns?
const E = require('../www/engine.js');
const SYMS = ['RELIANCE','TCS','HDFCBANK','ICICIBANK','INFY','BHARTIARTL','SBIN','ITC','LT','HINDUNILVR','KOTAKBANK','AXISBANK','BAJFINANCE','MARUTI','SUNPHARMA','HCLTECH','M&M','TITAN','ASIANPAINT','ULTRACEMCO','NTPC','POWERGRID','ONGC','TATASTEEL','JSWSTEEL','ADANIPORTS','COALINDIA','WIPRO','TECHM','NESTLEIND','BAJAJFINSV','HINDALCO','CIPLA','DRREDDY','EICHERMOT','BRITANNIA','APOLLOHOSP','INDUSINDBK','TRENT','BEL'];
async function daily(s) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}.NS?range=5y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const R = (await r.json()).chart.result[0], q = R.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [] };
  R.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null)) return; D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); });
  return D;
}
const slice = (D, a, b) => ({ t: D.t.slice(a, b), o: D.o.slice(a, b), h: D.h.slice(a, b), l: D.l.slice(a, b), c: D.c.slice(a, b), v: D.v.slice(a, b) });
function outcome(D, i, dir, stop, target, hold = 30) { // 1 target first, -1 stop first, 0 neither
  for (let j = i + 1; j <= Math.min(D.c.length - 1, i + hold); j++) {
    if (dir > 0 ? D.l[j] <= stop : D.h[j] >= stop) return -1;
    if (dir > 0 ? D.h[j] >= target : D.l[j] <= target) return 1;
  }
  return 0;
}
(async () => {
  const pat = {}, buckets = { '70+': [], '58-69': [], '43-57': [], '<=42': [] }; let stocks = 0;
  for (const s of SYMS) {
    let D; try { D = await daily(s); } catch (e) { continue; } if (D.c.length < 600) continue; stocks++;
    const seen = new Set();
    for (let i = 320; i < D.c.length - 31; i += 2) {
      const W = slice(D, i - 299, i + 1), I = E.indicators(W), k = W.c.length - 1;
      const items = [...E.chartPatterns(I, 0.05).filter(p => p.status !== 'forming').map(p => ({ n: p.n, b: p.b, stop: p.stop, target: p.target, key: p.n + p.id })),
                     ...E.setups(I, k, 0.05).filter(x => x.entry && x.stop && x.target && x.k !== 'PRE').map(x => ({ n: x.n, b: x.b, stop: x.stop, target: x.target, key: x.n + Math.floor(i / 10) }))];
      for (const it of items) {
        if (!it.b || seen.has(s + it.key)) continue; seen.add(s + it.key);
        const o = outcome(D, i, it.b, it.stop, it.target), P = pat[it.n] = pat[it.n] || { n: 0, w: 0, l: 0, rr: 0 };
        const rr = Math.abs(it.target - D.c[i]) / Math.max(1e-9, Math.abs(D.c[i] - it.stop));
        P.n++; P.rr += rr; if (o > 0) P.w++; else if (o < 0) P.l++;
      }
      if (i % 10 === 0) { // rating → forward 10-day return
        const A = E.analyze(W, { backtest: false }); if (A.err) continue;
        const r = E.rating(A).rating, fwd = (D.c[i + 10] / D.c[i] - 1) * 100;
        buckets[r >= 70 ? '70+' : r >= 58 ? '58-69' : r > 42 ? '43-57' : '<=42'].push(fwd);
      }
    }
  }
  console.log(`VALIDATION on ${stocks} NSE large caps, 5y daily, walk-forward (no look-ahead)`);
  console.log('Pattern/setup'.padEnd(44), 'signals  target-first  stop-first  avg R:R  break-even');
  for (const [n, P] of Object.entries(pat).sort((a, b) => b[1].n - a[1].n)) {
    const rr = P.rr / P.n, be = 100 / (1 + rr), wr = 100 * P.w / Math.max(1, P.w + P.l);
    console.log(n.padEnd(44), String(P.n).padStart(6), `${wr.toFixed(0)}%`.padStart(12), `${(100 * P.l / Math.max(1, P.w + P.l)).toFixed(0)}%`.padStart(11), rr.toFixed(2).padStart(9), `${be.toFixed(0)}% ${wr >= be ? 'EDGE' : 'no edge'}`.padStart(14));
  }
  console.log('\nRating bucket → forward 10-day return');
  for (const [b, a] of Object.entries(buckets)) { if (!a.length) continue; const m = a.reduce((x, y) => x + y, 0) / a.length, up = 100 * a.filter(x => x > 0).length / a.length; console.log(b.padEnd(8), `n=${a.length}`.padEnd(9), `avg ${m >= 0 ? '+' : ''}${m.toFixed(2)}%`.padEnd(14), `up ${up.toFixed(0)}%`); }
})();
