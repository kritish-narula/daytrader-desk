/* Money-flow data layer. CI (tools/flows.js) writes data/flows.json + data/news_sectors.json; the app reads them from raw.githubusercontent.com.
   Flow definition (same as CI): flow = close x volume x sign(close - previous close), in Rs crore. A market-activity PROXY, not FII/DII data. */
'use strict';
(function () {
  const BASE = 'https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/data/';
  const D = { flows: null, news: null, err: '' };
  async function one(name, key) {
    try { const r = await fetch(BASE + name + '.json?t=' + Math.floor(Date.now() / 6e5)); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); store.set(key, j); return j; }
    catch (e) { D.err = e.message; return store.get(key, null); }
  }
  async function load(force) {
    if (!force && D.flows && Date.now() - (D.at || 0) < 5 * 6e4) return D;
    const [f, n] = await Promise.all([one('flows', 'flows_data'), one('news_sectors', 'flows_news')]);
    D.flows = f; D.news = n; D.at = Date.now(); return D;
  }
  function cached() { if (!D.flows) { D.flows = store.get('flows_data', null); D.news = store.get('flows_news', null); } return D; }
  // intraday numbers are partial-day: scale the reference (yesterday / 9d avg) by the share of the session elapsed so the comparison is like-for-like
  const frac = F => F && F.intraday ? (F.frac || 1) : 1;
  function ref(g, F) { const k = frac(F); return { yday: g.yday * k, avg9: g.avg9 * k, tvAvg9: g.tvAvg9 * k }; }
  const cr = x => { if (x == null || !isFinite(x)) return '–'; const a = Math.abs(x); return (x < 0 ? '−' : x > 0 ? '+' : '') + '₹' + (a >= 1000 ? (a / 1000).toFixed(2) + 'k' : a >= 100 ? a.toFixed(0) : a.toFixed(1)) + ' Cr'; };
  const dcr = x => { if (x == null || !isFinite(x)) return '–'; const a = Math.abs(x); return (x < 0 ? '−' : '+') + (a >= 1000 ? (a / 1000).toFixed(2) + 'k' : a >= 100 ? a.toFixed(0) : a.toFixed(1)); };
  function asOfLabel(F) {
    if (!F) return '';
    const t = new Date(F.generatedAt), hm = t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', hour12: false });
    return F.intraday ? `intraday ${F.asOf} · updated ${hm} IST (Yahoo, delayed ~15-30 min; partial day)` : `${F.asOf} close · updated ${t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })} ${hm} IST`;
  }
  // ---- live estimate for one group (on tap, market open): same formula on fresh Yahoo daily bars ----
  async function live(g, onProg) {
    const syms = g.syms.slice(0, 120);
    const R = await pool(syms, 8, async s => { const { D } = await chart(ySym(s, 'IN'), '1mo', '1d'); return [s, D]; }, onProg);
    const S0 = []; let day = '';
    for (const r of R) { if (!r) continue; const [s, B] = r, L = B.c.length - 1; if (L < 10) continue; if (B.day[L] > day) day = B.day[L]; S0.push([s, B]); }
    const rows = S0.filter(([, B]) => B.day[B.c.length - 1] === day).map(([s, B]) => {
      const L = B.c.length - 1, tv = k => B.c[L - k] * B.v[L - k] / 1e7, fl = k => tv(k) * Math.sign(B.c[L - k] - B.c[L - k - 1]);
      let a = 0, t = 0; for (let k = 1; k <= 9; k++) { a += fl(k); t += tv(k); }
      return { s, today: fl(0), yday: fl(1), avg9: a / 9, tv: tv(0), tvAvg9: t / 9, chg: (B.c[L] / B.c[L - 1] - 1) * 100 };
    });
    if (rows.length < 3) throw new Error('Not enough live data');
    const sum = f => rows.reduce((x, r) => x + f(r), 0), n = rows.length, sorted = rows.slice().sort((a, b) => b.today - a.today);
    return { n, day, today: sum(r => r.today), yday: sum(r => r.yday), avg9: sum(r => r.avg9), tvToday: sum(r => r.tv), tvAvg9: sum(r => r.tvAvg9), adv: Math.round(100 * rows.filter(r => r.chg > 0).length / n), chg: sum(r => r.chg) / n,
      top_in: sorted.filter(r => r.today > 0).slice(0, 5).map(r => r.s), top_in_v: sorted.filter(r => r.today > 0).slice(0, 5).map(r => r.today),
      top_out: sorted.slice().reverse().filter(r => r.today < 0).slice(0, 5).map(r => r.s), top_out_v: sorted.slice().reverse().filter(r => r.today < 0).slice(0, 5).map(r => r.today), at: Date.now() };
  }
  window.Flows = { load, cached, data: D, frac, ref, cr, dcr, asOfLabel, live };
})();
