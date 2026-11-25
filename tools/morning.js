// Morning scan (GitHub Actions, every NSE trading day): re-prices and re-analyses EVERY NSE stock with the app's own engine,
// then publishes data/scan_in.json (all rows — the app loads them straight into its scanner lists) and data/morning.json
// (market mood, breadth, top picks per horizon, sells). Runs pre-open (≈08:30 IST, on yesterday's close) and after the open
// (≈09:50 IST, including today's first half hour). No broker credentials here: Yahoo daily data.
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js'), P = require('../www/paper.js');
const OUT = path.join(__dirname, '../data'), CONC = +process.env.CONC || 12;
const ist = () => new Date(Date.now() + 5.5 * 3600e3), today = ist().toISOString().slice(0, 10), hm = ist().toISOString().slice(11, 16);

async function yahoo(sym, range = '2y') {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), x = j.chart.result[0], q = x.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
      (x.timestamp || []).forEach((t, i) => { if (q.close[i] == null || q.open[i] == null) return; D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); D.day.push(new Date((t + 19800) * 1000).toISOString().slice(0, 10)); });
      return { D, meta: x.meta };
    } catch (e) { if (a === 2) return null; await new Promise(r => setTimeout(r, 800 * (a + 1))); }
  }
}
async function pool(items, n, fn) { let i = 0; const out = []; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } })); return out; }

(async () => {
  if (!P.isTradingDay(today) && !process.env.FORCE) { console.log(today, 'is not an NSE trading day — skipping'); return; }
  let nse = null; try { nse = JSON.parse(fs.readFileSync(path.join(__dirname, '../www/nse.json'), 'utf8')); } catch (e) {}
  const eq = nse && nse.eq && nse.eq.length > 500 ? nse.eq : null;
  if (!eq) { console.log('NSE equity list unavailable — keeping the last morning scan'); process.exitCode = 0; return; }
  const fo = new Set(Object.keys(nse.fo || {})), cat = nse.cat || {};
  const idx = await yahoo('^NSEI'); if (!idx) throw new Error('Nifty data unavailable');
  const iq = E.quick(idx.D, { tick: 0.05 }), regime = E.rating(iq).signal;
  const phase = hm < '09:15' ? 'pre-open' : 'after open';
  console.log(`Morning scan ${today} ${hm} IST (${phase}) · ${eq.length} NSE stocks · Nifty regime ${regime}`);

  let ok = 0, fail = 0;
  const rows = (await pool(eq, CONC, async ([sym]) => {
    const y = await yahoo(sym + '.NS'); if (!y || y.D.c.length < 60) { fail++; return null; }
    const D = y.D, n = D.c.length - 1;
    const q = E.quick(D, { tick: 0.05, canShort: fo.has(sym), price: y.meta.regularMarketPrice || D.c[n] });
    if (q.err) { fail++; return null; }
    let risk = null; try { const k = E.risk(D, idx.D, 6); if (k && !k.na) risk = k; } catch (e) {}
    for (const h of ['swing', 'short', 'medium', 'long']) { delete q[h]; const x = q.horizons[h]; if (x) { delete x.fv; delete x.calib; } } // top-level copies rebuilt in the app
    if (q.intraday) { delete q.intraday.fv; delete q.intraday.calib; }
    ok++; return Object.assign({ sym }, q, { risk, src: 'yf', prev: n > 0 ? +D.c[n - 1].toFixed(2) : null, lastDay: D.day[n] });
  })).filter(Boolean);
  console.log(`analysed ${ok} · failed ${fail}`);
  if (ok < eq.length * 0.4) { console.log('Too many failures — keeping the last morning scan'); return; }

  // ---------- summary ----------
  const R = rows.map(r => ({ r, R: E.rating(r, { regime, beta: r.risk ? r.risk.beta : undefined }) })).filter(x => x.R && !x.R.na);
  const liquid = x => (x.r.turnover || 0) >= 5e7; // ≥ ₹5 Cr average daily turnover
  const hzTop = hz => rows.filter(r => r.horizons[hz] && !r.horizons[hz].na && (r.turnover || 0) >= 5e7).map(r => ({ r, h: E.hzRating(r.horizons[hz], hz, { regime, canShort: fo.has(r.sym) }) })).filter(x => x.h && x.h.rating >= 58).sort((a, b) => b.h.rating - a.h.rating).slice(0, 10)
    .map(x => ({ sym: x.r.sym, rating: x.h.rating, action: x.h.action, price: +x.r.price.toFixed(2), chg: +(x.r.chg || 0).toFixed(2), sector: (cat[x.r.sym] || [])[1] || '' }));
  const pick = x => ({ sym: x.r.sym, rating: x.R.rating, action: x.R.action, price: +x.r.price.toFixed(2), chg: +(x.r.chg || 0).toFixed(2), sector: (cat[x.r.sym] || [])[1] || '', setups: (x.r.setups || []).filter(s => s.b > 0 && s.q >= 70).map(s => s.n).slice(0, 2) });
  const top = R.filter(liquid).filter(x => x.R.rating >= 58).sort((a, b) => b.R.rating - a.R.rating).slice(0, 15).map(pick);
  const sells = R.filter(liquid).filter(x => x.R.rating <= 35).sort((a, b) => a.R.rating - b.R.rating).slice(0, 10).map(pick);
  const edge = new Set(Object.entries(E.SETUP_STATS).filter(([, a]) => a[3]).map(([k]) => k));
  const setups = R.filter(liquid).filter(x => (x.r.setups || []).some(s => s.b > 0 && s.q >= 70 && edge.has(s.n))).sort((a, b) => b.R.rating - a.R.rating).slice(0, 12).map(pick);
  const lastDay = idx.D.day[idx.D.day.length - 1];
  const fresh = rows.filter(r => r.lastDay === lastDay), up = fresh.filter(r => r.chg > 0).length, dn = fresh.filter(r => r.chg < 0).length;
  const breadth = { n: rows.length, adv: up, dec: dn, a50: Math.round(100 * rows.filter(r => r.e50 && r.price > r.e50).length / rows.length), a200: Math.round(100 * rows.filter(r => r.e200 && r.price > r.e200).length / rows.length),
    hi52: rows.filter(r => r.hi52 && r.price >= r.hi52 * 0.995).length, lo52: rows.filter(r => r.lo52 && r.price <= r.lo52 * 1.005).length, buys: R.filter(x => x.R.rating >= 58).length, sells: R.filter(x => x.R.rating <= 42).length };
  const secAgg = {}; for (const x of R) { const s = (cat[x.r.sym] || [])[1]; if (!s) continue; const a = secAgg[s] = secAgg[s] || { n: 0, sum: 0, up: 0 }; a.n++; a.sum += x.R.rating; a.up += x.r.chg > 0; }
  const sectors = Object.entries(secAgg).filter(([, a]) => a.n >= 5).map(([k, a]) => ({ sector: k, avg: Math.round(a.sum / a.n), adv: Math.round(100 * a.up / a.n), n: a.n })).sort((a, b) => b.avg - a.avg);
  const mood = regime >= 62 ? 'Bullish' : regime >= 52 ? 'Mildly bullish' : regime >= 45 ? 'Neutral' : regime >= 38 ? 'Mildly bearish' : 'Bearish';
  const at = new Date().toISOString();
  const morning = { date: today, time: hm, phase, generatedAt: at, dataDay: lastDay, regime, mood, nifty: { price: +iq.price.toFixed(2), chg: +(iq.chg || 0).toFixed(2) }, breadth, top, swing: hzTop('swing'), short: hzTop('short'), medium: hzTop('medium'), long: hzTop('long'), setups, sells, sectors };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'morning.json'), JSON.stringify(morning));
  // compact: 2-decimal numbers, no empty arrays (keeps the daily download small for phones)
  const rep = (k, v) => typeof v === 'number' ? (Number.isInteger(v) ? v : Math.abs(v) >= 1 ? Math.round(v * 100) / 100 : +v.toPrecision(3)) : Array.isArray(v) && !v.length ? undefined : v;
  fs.writeFileSync(path.join(OUT, 'scan_in.json'), JSON.stringify({ date: today, time: hm, phase, generatedAt: at, dataDay: lastDay, regime, rows }, rep));
  console.log(`mood ${mood} · breadth ${up}↑ ${dn}↓ · above 50-DMA ${breadth.a50}% · top: ${top.slice(0, 5).map(x => x.sym + ' ' + x.rating).join(', ')}`);
  console.log(`scan_in.json ${(fs.statSync(path.join(OUT, 'scan_in.json')).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exitCode = 1; });
