// List vs stock-page parity on REAL data (run in CI: Yahoo is reachable there).
// For a sample of stocks from data/scan_in.json (the auto-scan rows the phone lists) it re-fetches Yahoo 2y daily bars and computes:
//   A) the CI row's horizon ratings (what the list shows)            → E.hzRating(row.horizons[hz])
//   B) the scanner path now  (E.quick, what a rolling refresh writes) → E.hzRating
//   C) the stock-page path now (E.analyze backtest:true)              → E.hzRating
// plus sensitivity: C with the last bar dropped, and with a 1-year history (mStock fallback), to show how fragile each score is.
// Writes data/parity_report.txt.
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js');
try { E.setModel(JSON.parse(fs.readFileSync(path.join(__dirname, '../www/model.json'), 'utf8'))); } catch (e) { console.log('no model.json'); }
const HZ = ['swing', 'short', 'medium', 'long'];
async function yahoo(sym, range = '2y') {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status);
      const x = (await r.json()).chart.result[0], q = x.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [] };
      (x.timestamp || []).forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return; D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); });
      return { D, meta: x.meta };
    } catch (e) { if (a === 2) return null; await new Promise(r => setTimeout(r, 700 * (a + 1))); }
  }
}
const cut = (D, k) => Object.fromEntries(Object.entries(D).map(([a, v]) => [a, v.slice(0, v.length - k)]));
const tail = (D, k) => Object.fromEntries(Object.entries(D).map(([a, v]) => [a, v.slice(-k)]));
const rate = (H, hz, regime) => { const h = H && H[hz]; if (!h || h.na) return null; const r = E.hzRating(h, hz, { regime }); return r ? r.rating : null; };
(async () => {
  const S = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/scan_in.json'), 'utf8')), regime = S.regime;
  const rows = S.rows.filter(r => r.horizons && (r.turnover || 0) >= 5e7);
  // sample: the top 40 of every horizon list (what the user opens) + 120 random liquid names
  const pick = new Set();
  for (const hz of HZ) rows.map(r => [r, rate(r.horizons, hz, regime)]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(x => pick.add(x[0]));
  for (let k = 0; k < 120; k++) pick.add(rows[(k * 7919) % rows.length]);
  const L = [...pick], out = [], lines = [];
  let i = 0; await Promise.all(Array.from({ length: 10 }, async () => { while (i < L.length) { const r = L[i++]; const y = await yahoo(r.sym + '.NS'); if (!y || y.D.c.length < 220) continue;
    const n = y.D.c.length - 1, px = y.meta.regularMarketPrice || y.D.c[n];
    const q = E.quick(y.D, { tick: 0.05, price: px }), a = E.analyze(y.D, { tick: 0.05, backtest: true, price: px });
    const a1 = E.analyze(cut(y.D, 1), { tick: 0.05, backtest: true }), a250 = E.analyze(tail(y.D, 250), { tick: 0.05, backtest: true });
    const o = { sym: r.sym, sameBar: r.t === y.D.t[n], rowT: r.t, nowT: y.D.t[n], hz: {} };
    for (const hz of HZ) o.hz[hz] = { list: rate(r.horizons, hz, regime), quick: rate(q.horizons, hz, regime), page: rate(a.horizons, hz, regime), drop1: rate(a1.horizons, hz, regime), y1: rate(a250.horizons, hz, regime), rule: a.horizons[hz] && a.horizons[hz].rule, ml: a.horizons[hz] && a.horizons[hz].ml };
    out.push(o); } }));
  const P = s => s == null ? '  –' : String(s).padStart(3);
  lines.push(`List vs page parity · ${new Date().toISOString()} · scan_in ${S.generatedAt} · model v${E.MODEL.v} · lin: ${Object.keys(E.MODEL.lin || {}).join(',') || 'none'} · ${out.length} stocks`);
  for (const hz of HZ) {
    const d = (a, b) => out.map(o => o.hz[hz]).filter(x => x[a] != null && x[b] != null).map(x => Math.abs(x[a] - x[b]));
    const st = (a, b) => { const v = d(a, b).sort((x, y) => x - y); return v.length ? `n=${v.length} median ${v[v.length >> 1]} p90 ${v[Math.floor(v.length * 0.9)]} max ${v[v.length - 1]} >10pts ${v.filter(x => x > 10).length}` : 'n=0'; };
    lines.push(`\n== ${hz.toUpperCase()} ${(E.MODEL.lin || {})[hz] ? '(learned model)' : '(rule score)'}`);
    lines.push(`  quick vs page (same data, same moment):     ${st('quick', 'page')}`);
    lines.push(`  list (CI row) vs page now:                  ${st('list', 'page')}`);
    lines.push(`  page vs page with last bar dropped:         ${st('page', 'drop1')}`);
    lines.push(`  page vs page on 1y history (mStock path):   ${st('page', 'y1')}`);
    const worst = out.filter(o => o.hz[hz].list != null && o.hz[hz].page != null).sort((a, b) => Math.abs(b.hz[hz].list - b.hz[hz].page) - Math.abs(a.hz[hz].list - a.hz[hz].page)).slice(0, 6);
    for (const o of worst) lines.push(`   ${o.sym.padEnd(12)} list${P(o.hz[hz].list)} quick${P(o.hz[hz].quick)} page${P(o.hz[hz].page)} drop1${P(o.hz[hz].drop1)} 1y${P(o.hz[hz].y1)} rule${P(o.hz[hz].rule)} sameBar ${o.sameBar}${o.hz[hz].ml ? ' · drivers ' + o.hz[hz].ml.slice(0, 4).map(x => x.t + ' ' + x.w).join(', ') : ''}`);
  }
  fs.writeFileSync(path.join(__dirname, '../data/parity_report.txt'), lines.join('\n') + '\n'); console.log(lines.join('\n'));
})();
