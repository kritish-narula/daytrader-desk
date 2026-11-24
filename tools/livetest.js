// CI smoke test: live Yahoo data through the engine.
const E = require('../www/engine.js');
async function chart(s, range, iv) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=${range}&interval=${iv}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json(), R = j.chart.result[0], q = R.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
  R.timestamp.forEach((t, i) => { if (q.close[i] == null) return; D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); D.day.push(new Date(t * 1000).toISOString().slice(0, 10)); });
  return { D, meta: R.meta };
}
(async () => {
  for (const s of ['RELIANCE.NS', '^NSEI', 'AAPL']) {
    try {
      const d = await chart(s, '2y', '1d'), it = await chart(s, '5d', '5m');
      const A = E.analyze(d.D, { intra: it.D, backtest: true, fnoSym: s === '^NSEI' ? 'NIFTY' : null, canShort: true });
      console.log(s, d.D.c.length, 'bars', 'price', A.price.toFixed(2), 'overall', A.overall, A.overallAction);
      for (const [k, h] of Object.entries(A.horizons)) console.log('  ', k.padEnd(8), h.score, h.action, h.levels ? `E ${h.levels.entry} SL ${h.levels.stop} T1 ${h.levels.t1} T2 ${h.levels.t2}` : '', h.bt ? `odds ${h.bt.odds} (${h.bt.wins}/${h.bt.n})` : '');
      console.log('   patterns:', A.patterns.map(p => p.n).join(', ') || '-', '| cross:', A.cross.map(c => c.name + ' ' + c.status).join(', ') || '-');
      if (A.fno) console.log('   fno:', A.fno.idea);
    } catch (e) { console.log(s, 'FAILED', e.message); }
  }
  try { const fs = require('fs'), u = JSON.parse(fs.readFileSync(__dirname + '/../www/us.json')); const c = {}; for (const k in u.cat) c[u.cat[k][0]] = (c[u.cat[k][0]] || 0) + 1; console.log('us.json:', u.eq.length, 'stocks', JSON.stringify(c), 'sectors:', [...new Set(Object.values(u.cat).map(x => x[1]))].join(', ')); } catch (e) { console.log('us.json missing', e.message); }
  const q = await fetch('https://query2.finance.yahoo.com/v1/finance/search?q=tata%20motors&quotesCount=5&newsCount=0', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()).catch(e => ({ err: e.message }));
  console.log('search:', (q.quotes || []).map(x => x.symbol).join(', ') || JSON.stringify(q).slice(0, 200));
})();
