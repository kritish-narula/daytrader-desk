// Money-flow proxy per index / industry + sector news pulse. Runs in GitHub Actions (no credentials).
// Sources: NSE/niftyindices constituent CSVs, Yahoo Finance daily bars, Google News RSS. Writes data/flows.json + data/news_sectors.json.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..'), DATA = path.join(ROOT, 'data');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', Accept: '*/*', Referer: 'https://www.nseindia.com/' };
const NOW = process.env.FLOWS_NOW ? new Date(process.env.FLOWS_NOW) : new Date();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- headline scorer: reuse www/news.js word lists (it is a browser IIFE, so run it in a sandbox) ----
function loadScorer() {
  const sb = { window: {}, DOMParser: function () {}, fetch: () => { throw new Error('no net'); } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'www', 'news.js'), 'utf8'), sb);
  return sb.window.News.score;
}
const score = loadScorer();

async function text(u, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u, { headers: UA }); if (r.ok) return await r.text(); if (r.status === 404) return null; } catch (e) {}
    await sleep(400 * (i + 1));
  }
  return null;
}
function parseCSV(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const h = rows[0].map(x => x.trim().toLowerCase());
  return rows.slice(1).filter(r => r.length > 1).map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] || '').trim()])));
}
const BASES = ['https://nsearchives.nseindia.com/content/indices/', 'https://www.niftyindices.com/IndexConstituent/', 'https://archives.nseindia.com/content/indices/'];
async function csv(files) {
  for (const f of files) for (const b of BASES) { const t = await text(b + f, 1); if (t) { const r = parseCSV(t).filter(x => x.symbol); if (r.length) return r; } }
  return null;
}
const IDX = [ // id, name, [csv names]
  ['nifty50', 'NIFTY 50', ['ind_nifty50list.csv']], ['niftynext50', 'NIFTY NEXT 50', ['ind_niftynext50list.csv']],
  ['niftybank', 'NIFTY BANK', ['ind_niftybanklist.csv']], ['niftyit', 'NIFTY IT', ['ind_niftyitlist.csv']],
  ['niftyauto', 'NIFTY AUTO', ['ind_niftyautolist.csv']], ['niftypharma', 'NIFTY PHARMA', ['ind_niftypharmalist.csv']],
  ['niftyfmcg', 'NIFTY FMCG', ['ind_niftyfmcglist.csv']], ['niftymetal', 'NIFTY METAL', ['ind_niftymetallist.csv']],
  ['niftyrealty', 'NIFTY REALTY', ['ind_niftyrealtylist.csv']], ['niftyenergy', 'NIFTY ENERGY', ['ind_niftyenergylist.csv']],
  ['niftypsubank', 'NIFTY PSU BANK', ['ind_niftypsubanklist.csv']], ['niftyfinserv', 'NIFTY FIN SERVICE', ['ind_niftyfinancelist.csv', 'ind_niftyfinancialserviceslist.csv']],
  ['niftymedia', 'NIFTY MEDIA', ['ind_niftymedialist.csv']], ['niftymid100', 'NIFTY MIDCAP 100', ['ind_niftymidcap100list.csv']],
  ['niftysmall100', 'NIFTY SMALLCAP 100', ['ind_niftysmallcap100list.csv']]];
const slug = s => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- universe (cached to data/flows_universe.json so a blocked NSE does not break the job) ----
async function universe() {
  const UF = path.join(DATA, 'flows_universe.json');
  let old = {}; try { old = JSON.parse(fs.readFileSync(UF, 'utf8')); } catch (e) {}
  const groups = [], ind = {}; let ok = 0;
  for (const [id, name, files] of IDX) {
    const r = await csv(files);
    if (r) { groups.push({ id, name, type: 'index', syms: r.map(x => x.symbol) }); ok++; }
    else if ((old.groups || []).find(g => g.id === id)) groups.push(old.groups.find(g => g.id === id));
    else console.log('index list missing:', name);
  }
  const tm = await csv(['ind_niftytotalmarket_list.csv', 'ind_niftytotalmarketlist.csv', 'ind_nifty500list.csv']);
  if (tm) { ok++; for (const x of tm) if (x.industry) (ind[x.industry] = ind[x.industry] || []).push(x.symbol); }
  const oldInd = (old.groups || []).filter(g => g.type === 'industry' && g.src === 'nse');
  if (tm) for (const [name, syms] of Object.entries(ind)) groups.push({ id: 'ind-' + slug(name), name, type: 'industry', src: 'nse', syms });
  else groups.push(...oldInd);
  let map = {}; try { map = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf8')); } catch (e) { console.log('industry_map.json unreadable', e.message); }
  for (const [k, v] of Object.entries(map)) if (k[0] !== '_' && v.symbols) groups.push({ id: 'fine-' + k, name: v.name, type: 'industry', src: 'curated', q: v.q, syms: [...new Set(v.symbols)] });
  const out = groups.filter(g => g.syms.length >= 3);
  if (ok) { try { fs.writeFileSync(UF, JSON.stringify({ at: NOW.toISOString(), groups: out.filter(g => g.src !== 'curated') })); } catch (e) {} }
  else console.log('WARNING: no NSE list reachable; using cached universe');
  return out;
}

// ---- Yahoo daily bars ----
const istDay = t => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
async function bars(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.NS?range=1mo&interval=1d&includePrePost=false`;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA['User-Agent'], Accept: 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(600 * (i + 1)); continue; }
      const R = (await r.json()).chart.result[0], q = R.indicators.quote[0], B = [];
      R.timestamp.forEach((t, k) => { if (q.close[k] != null) B.push({ d: istDay(t), c: q.close[k], v: q.volume[k] || 0 }); });
      return B;
    } catch (e) { await sleep(600 * (i + 1)); }
  }
  return null;
}
async function poolRun(items, n, fn) { let i = 0; const out = {}; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[items[k]] = await fn(items[k]); } })); return out; }

// ---- per-stock stats. Definition: flow_d = close_d * volume_d * sign(close_d - close_{d-1}) (in Rs crore) ----
const CR = 1e7;
function stockStats(B, asOf) {
  if (!B || B.length < 11 || B[B.length - 1].d !== asOf) return null;
  const L = B.length - 1, tv = k => B[L - k].c * B[L - k].v / CR, fl = k => tv(k) * Math.sign(B[L - k].c - B[L - k - 1].c);
  let a9 = 0, t9 = 0; for (let k = 1; k <= 9; k++) { a9 += fl(k); t9 += tv(k); }
  return { today: fl(0), yday: fl(1), avg9: a9 / 9, tv: tv(0), tvAvg9: t9 / 9, chg: (B[L].c / B[L - 1].c - 1) * 100 };
}
const r2 = x => Math.round(x * 100) / 100;
function groupStats(g, S) {
  const xs = g.syms.map(s => [s, S[s]]).filter(x => x[1]); if (xs.length < 3) return null;
  const sum = f => xs.reduce((a, x) => a + f(x[1]), 0), n = xs.length;
  const tvT = sum(s => s.tv), tvA = sum(s => s.tvAvg9);
  const byFlow = xs.slice().sort((a, b) => b[1].today - a[1].today);
  return { id: g.id, name: g.name, type: g.type, n, today: r2(sum(s => s.today)), yday: r2(sum(s => s.yday)), avg9: r2(sum(s => s.avg9)),
    tvToday: r2(tvT), tvAvg9: r2(tvA), ratio: tvA ? r2(tvT / tvA) : null, adv: Math.round(100 * xs.filter(x => x[1].chg > 0).length / n), chg: r2(sum(s => s.chg) / n),
    top_in: byFlow.filter(x => x[1].today > 0).slice(0, 5).map(x => x[0]), top_in_v: byFlow.filter(x => x[1].today > 0).slice(0, 5).map(x => r2(x[1].today)),
    top_out: byFlow.slice().reverse().filter(x => x[1].today < 0).slice(0, 5).map(x => x[0]), top_out_v: byFlow.slice().reverse().filter(x => x[1].today < 0).slice(0, 5).map(x => r2(x[1].today)),
    chgs: Object.fromEntries(byFlow.slice(0, 5).concat(byFlow.slice(-5)).map(x => [x[0], r2(x[1].chg)])), syms: g.syms };
}

// ---- Google News RSS ----
const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
async function news(q) {
  const x = await text(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:3d')}&hl=en-IN&gl=IN&ceid=IN:en`);
  if (!x) return null;
  const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map(m => {
    const g = t => { const r = m[1].match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return r ? unesc(r[1]).trim() : ''; };
    let title = g('title'); const src = g('source'); if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
    return { title, link: g('link'), date: Date.parse(g('pubDate')) ? new Date(Date.parse(g('pubDate'))).toISOString() : '', score: score(title) };
  }).filter(i => i.title);
  const seen = new Set(), out = []; for (const i of items) { const k = i.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (!seen.has(k)) { seen.add(k); out.push(i); } }
  let s = 0, w = 0, ns = 0, neg24 = 0;
  for (const i of out) { if (!i.score) continue; ns++; const age = Math.max(0, NOW - Date.parse(i.date)) / 864e5, wt = Math.pow(0.5, (isFinite(age) ? age : 3) / 1.5); s += i.score * wt; w += wt; if (i.score < 0 && age < 1) neg24++; }
  const sc = w ? Math.max(-1, Math.min(1, s / Math.max(w, 1))) : 0;
  out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || Date.parse(b.date) - Date.parse(a.date));
  return { score: r2(sc), n: ns, total: out.length, neg24, flag: ns >= 3 && (sc <= -0.35 || neg24 >= 3) ? 'negative' : ns >= 3 && sc >= 0.5 ? 'positive' : null, top: out.slice(0, 5) };
}
const newsQuery = g => g.q || (g.type === 'index' ? (/^NIFTY \d+$/.test(g.name) ? 'Nifty 50 stocks market' : g.name.replace(/^NIFTY /, 'Nifty ').replace('FIN SERVICE', 'Financial Services') + ' stocks') : `Indian ${g.name.replace(/&/g, 'and')} industry stocks`);

(async () => {
  const t0 = Date.now(); fs.mkdirSync(DATA, { recursive: true });
  const U = await universe(); const syms = [...new Set(U.flatMap(g => g.syms))];
  console.log('groups', U.length, 'stocks', syms.length);
  const Bs = await poolRun(syms, 14, bars);
  const days = {}; for (const s of syms) { const B = Bs[s]; if (B && B.length) days[B[B.length - 1].d] = (days[B[B.length - 1].d] || 0) + 1; }
  const asOf = Object.keys(days).sort((a, b) => days[b] - days[a] || (a < b ? 1 : -1))[0];
  const fetched = syms.filter(s => Bs[s]).length;
  console.log('bars ok', fetched, '/', syms.length, 'asOf', asOf, Date.now() - t0, 'ms');
  if (!asOf || fetched < Math.min(60, syms.length * 0.3)) { console.log('Too little data; keeping existing files.'); process.exit(0); }
  const S = {}; for (const s of syms) S[s] = stockStats(Bs[s], asOf);
  // intraday detection (IST)
  const ist = new Date(NOW.getTime() + 19800e3), today = ist.toISOString().slice(0, 10), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  const live = asOf === today && wd >= 1 && wd <= 5 && mins >= 555 && mins < 935;
  const frac = live ? Math.max(0.05, Math.min(1, (mins - 555) / 375)) : 1;
  const groups = U.map(g => groupStats(g, S)).filter(Boolean);
  const defs = {
    flow: 'Net money flow (Rs crore) = sum over a group\'s stocks of close x volume x sign(close - previous close). A market-activity proxy for money moving into or out of a group: it is not FII/DII data. True FII/DII sector flows are published only fortnightly by NSDL.',
    yday: 'The previous trading session, same formula.', avg9: 'Average daily net flow over the 9 sessions before today (today excluded, so it is not diluted by itself).',
    turnover: 'Traded value (close x volume) today divided by the 9-session average traded value; above 1.0x = busier than usual.',
    adv: '% of the group\'s stocks that closed above the previous close.', chg: 'Equal-weighted average % change of the group\'s stocks (not market-cap weighted).',
    delivery: 'Delivery % is not shown: NSE delivery (bhavcopy) files cannot be fetched reliably from CI.', source: 'Daily bars from Yahoo Finance (delayed); constituents from NSE index lists.' };
  fs.writeFileSync(path.join(DATA, 'flows.json'), JSON.stringify({ asOf, generatedAt: NOW.toISOString(), intraday: live, frac: r2(frac), stocks: fetched, groups, definitions: defs }));
  console.log('wrote flows.json', groups.length, 'groups; intraday', live);
  // sector news pulse
  const N = {}; const gs = U.filter(g => groups.find(x => x.id === g.id));
  await poolRun(gs.map(g => g.id), 4, async id => { const g = gs.find(x => x.id === id); const r = await news(newsQuery(g)); if (r) N[id] = r; await sleep(150); });
  if (Object.keys(N).length) { fs.writeFileSync(path.join(DATA, 'news_sectors.json'), JSON.stringify({ generatedAt: NOW.toISOString(), groups: N })); console.log('wrote news_sectors.json', Object.keys(N).length, 'flagged', Object.values(N).filter(x => x.flag === 'negative').length); }
  else console.log('news: nothing fetched; keeping existing file');
  console.log('done in', Math.round((Date.now() - t0) / 1000), 's');
})().catch(e => { console.error(e); process.exit(1); });
