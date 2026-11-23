/* IPOs: grey-market premium (GMP) tables from public trackers, news sentiment and an apply rating.
   GMP is unofficial and unregulated; it often changes and does not guarantee the listing price. */
'use strict';
(function (root) {
  const SOURCES = [
    ['ipowatch', 'https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/'],
    ['ipoji', 'https://www.ipoji.com/ipo-gmp'],
  ];
  const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8377;|&#x20b9;/gi, '₹').replace(/&#8211;|&ndash;/g, '-').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const num = s => { const m = String(s || '').replace(/,/g, '').match(/[-+]?\d+(\.\d+)?/); return m ? +m[0] : NaN; };

  // Generic: find tables whose header mentions GMP, map columns by header words.
  function parseTables(html) {
    const out = [];
    for (const tm of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
      const rows = [...tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r => [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => strip(c[1])));
      if (rows.length < 2) continue;
      const hdr = rows[0].map(h => h.toLowerCase()); if (!hdr.some(h => h.includes('gmp'))) continue;
      const col = (...keys) => hdr.findIndex(h => keys.some(k => h.includes(k)));
      const iName = col('ipo name', 'company', 'ipo'), iGmp = hdr.findIndex(h => /gmp/.test(h) && !/date|update/.test(h)), iPrice = col('price band', 'issue price', 'price'),
        iEst = col('est', 'listing'), iDate = col('date', 'open'), iType = col('type'), iStatus = col('status'), iTrend = col('trend');
      for (const r of rows.slice(1)) {
        if (r.length < 3 || !r[iName]) continue;
        const name = r[iName].replace(/\s*(ipo|sme ipo)\s*$/i, '').replace(/\s+(open|closed|upcoming|listed)$/i, '').trim();
        const price = r[iPrice] || '', hi = Math.max(...(price.replace(/,/g, '').match(/\d+(\.\d+)?/g) || ['NaN']).map(Number));
        const gmp = num(r[iGmp]);
        const typeTxt = (iType >= 0 ? r[iType] : '') + ' ' + r[iName];
        out.push({
          name, gmp: isFinite(gmp) ? gmp : 0, price: isFinite(hi) ? hi : NaN, priceBand: price, est: iEst >= 0 ? r[iEst] : '',
          dates: iDate >= 0 ? r[iDate] : '', sme: /sme|emerge|bse sme/i.test(typeTxt), status: (iStatus >= 0 ? r[iStatus] : (/(open|closed|upcoming|listed)/i.exec(r[iName]) || [, ''])[1]).trim(),
          trend: iTrend >= 0 ? r[iTrend] : '',
        });
      }
    }
    // keep each IPO once, prefer the row with a price
    const seen = new Map(); for (const x of out) { const k = x.name.toLowerCase(); if (!seen.has(k) || (!isFinite(seen.get(k).price) && isFinite(x.price))) seen.set(k, x); }
    return [...seen.values()].filter(x => x.name.length > 2);
  }

  async function fetchText(u) { const r = await fetch(u, { headers: { Accept: 'text/html' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }
  async function load() {
    let lastErr;
    for (const [src, url] of SOURCES) {
      try { const L = parseTables(await fetchText(url)); if (L.length) return { list: L, src, url, at: Date.now() }; lastErr = new Error('no GMP table found at ' + src); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('IPO data unavailable');
  }

  // Rating 0–100 for applying. Inputs: GMP %, GMP trend vs our last snapshot, SME risk, news, market trend.
  function rate(x, ctx = {}) {
    if (!(x.price > 0)) return { rating: 50, action: 'AWAITING PRICE', gmpPct: 0, why: [[0, 'Price band not announced yet, so GMP can\'t be judged']] };
    const g = isFinite(x.price) && x.price > 0 ? 100 * x.gmp / x.price : 0;
    const why = [];
    let s = g >= 40 ? 34 : g >= 25 ? 26 : g >= 15 ? 18 : g >= 8 ? 10 : g >= 3 ? 3 : g > 0 ? -4 : g === 0 ? -12 : -25;
    why.push([s, g > 0 ? `GMP +${g.toFixed(1)}% over the issue price` : g === 0 ? 'No grey-market premium' : `Grey market quoting a ${g.toFixed(1)}% discount`]);
    const prev = ctx.prevGmp; if (isFinite(prev) && prev !== x.gmp) { const d = x.gmp > prev ? 6 : -8; s += d; why.push([d, `GMP ${x.gmp > prev ? 'rising' : 'falling'} (was ₹${prev})`]); }
    else if (/↑|up|▲|🟢/i.test(x.trend)) { s += 4; why.push([4, 'GMP trend up']); } else if (/↓|down|▼|🔴/i.test(x.trend)) { s -= 6; why.push([-6, 'GMP trend down']); }
    if (isFinite(ctx.news) && ctx.news !== 0) { const d = Math.round(10 * ctx.news); s += d; why.push([d, `${ctx.news > 0 ? 'Positive' : 'Negative'} news flow`]); }
    if (isFinite(ctx.regime)) { const d = Math.round(Math.max(-5, Math.min(5, (ctx.regime - 50) / 8))); if (d) { s += d; why.push([d, `Market ${d > 0 ? 'uptrend helps' : 'weakness hurts'} listings`]); } }
    if (x.sme) { s -= 6; why.push([-6, 'SME issue: big lot size, thin trading, higher risk']); }
    const r = Math.max(0, Math.min(100, Math.round(50 + s)));
    const st = (x.status || '').toLowerCase();
    const act = /listed/.test(st) ? 'LISTED' : /closed/.test(st) ? 'CLOSED' : r >= 70 ? 'APPLY' : r >= 58 ? 'APPLY (listing gains)' : r >= 45 ? 'NEUTRAL' : 'AVOID';
    return { rating: r, action: act, gmpPct: g, why: why.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])) };
  }
  // "19 Nov - 23 Nov", "1-3 Dec", "28 Nov 2026 - 2 Dec 2026" -> {open, close, allot, list} (allotment/listing per SEBI T+3: T+1 / T+3 working days)
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  function dates(s, now = new Date()) {
    const m = String(s || '').toLowerCase().match(/(\d{1,2})\s*([a-z]{3,4})?\s*(\d{4})?\s*[-–to]+\s*(\d{1,2})\s*([a-z]{3,4})\s*(\d{4})?/);
    if (!m) return null;
    const mc = MON[m[5]], mo = m[2] && MON[m[2]] != null ? MON[m[2]] : mc; if (mc == null) return null;
    const pick = (mon, yr) => { if (yr) return +yr; let y = now.getFullYear(); const d = new Date(y, mon, 15); if (d - now > 200 * 864e5) y--; else if (now - d > 200 * 864e5) y++; return y; };
    const close = new Date(pick(mc, m[6]), mc, +m[4]); let open = new Date(pick(mo, m[3] || m[6]), mo, +m[1]); if (open > close) open = new Date(open.getFullYear() - 1, mo, +m[1]);
    const work = (d, n) => { const x = new Date(d); while (n > 0) { x.setDate(x.getDate() + 1); if (x.getDay() % 6) n--; } return x; };
    return { open, close, allot: work(close, 1), list: work(close, 3) };
  }
  function when(D, now = new Date()) {
    if (!D) return '';
    const day = d => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    const o = day(D.open), c = day(D.close), a = day(D.allot), l = day(D.list);
    if (o > 0) return o === 1 ? 'Opens tomorrow' : `Opens in ${o} days`;
    if (c === 0) return 'Closes today: last day to apply';
    if (c > 0) return c === 1 ? 'Open · closes tomorrow' : `Open · closes in ${c} days`;
    if (a === 0) return 'Allotment today';
    if (a > 0) return 'Allotment tomorrow';
    if (l === 0) return 'Listing today';
    if (l > 0) return `Listing in ${l} day${l > 1 ? 's' : ''}`;
    return 'Listed';
  }
  const api = { load, parseTables, rate, dates, when };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.IPO = api;
})(typeof self !== 'undefined' ? self : this);
