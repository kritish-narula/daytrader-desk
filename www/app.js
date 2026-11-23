/* DayTrader Desk app */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem('dtd2_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('dtd2_' + k, JSON.stringify(v)); } catch (e) {} } };
const MK = {
  IN: { name: 'India', tz: 'Asia/Kolkata', open: 555, close: 930, cur: '₹', tick: 0.05, idx: () => window.IDX_IN },
  US: { name: 'Global', tz: 'America/New_York', open: 570, close: 960, cur: '$', tick: 0.01, idx: () => window.IDX_US },
};
const S = { mkt: store.get('mkt', 'IN'), tab: 'home', nse: null, saved: store.get('saved', { IN: [], US: [] }), scan: store.get('scan', {}), detail: null, hz: 'swing', chartMode: 'daily', timer: null };

// ---------- symbols ----------
async function loadNSE() {
  try { const r = await fetch('nse.json'); if (r.ok) { S.nse = await r.json(); return; } } catch (e) {}
  S.nse = { eq: window.SEED_IN, fo: {}, idx: {}, updated: null, seed: true };
}
const ySym = (sym, mkt = S.mkt) => {
  if (mkt === 'US') return sym;
  const ix = window.IDX_IN.find(x => x[0] === sym); if (ix) return ix[2];
  return /\.(NS|BO)$|^\^/.test(sym) ? sym : sym + '.NS';
};
const baseSym = y => y.replace(/\.(NS|BO)$/, '');
const nameOf = (sym, mkt = S.mkt) => {
  if (mkt === 'US') { const x = window.US_LIST.find(z => z[0] === sym); return x ? x[1] : ''; }
  const ix = window.IDX_IN.find(x => x[0] === sym); if (ix) return ix[1];
  const x = S.nse.eq.find(z => z[0] === sym); return x ? x[1] : '';
};
const foLot = sym => (S.nse.fo || {})[sym] || (S.nse.idx || {})[sym] || null;
const isFno = sym => !!foLot(sym) || window.IDX_IN.some(x => x[0] === sym);

// ---------- data (Yahoo Finance; works in the Android app via native HTTP) ----------
const YH = 'https://query1.finance.yahoo.com';
async function getJSON(u) { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
async function chart(ysym, range, interval) {
  const j = await getJSON(`${YH}/v8/finance/chart/${encodeURIComponent(ysym)}?range=${range}&interval=${interval}&includePrePost=false`);
  const R = j.chart && j.chart.result && j.chart.result[0]; if (!R || !R.timestamp) throw new Error('No data for ' + ysym);
  const q = R.indicators.quote[0], tz = R.meta.exchangeTimezoneName || 'UTC';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
  R.timestamp.forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null)) return;
    D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); D.day.push(fmt.format(new Date(t * 1000)));
  });
  return { D, meta: R.meta };
}
async function ysearch(q) {
  const j = await getJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`);
  return (j.quotes || []).filter(x => x.symbol && /EQUITY|ETF|INDEX/.test(x.quoteType || ''));
}
async function pool(items, n, fn, onProg) {
  let i = 0, done = 0; const out = [];
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } done++; onProg && onProg(done, items.length); } }));
  return out;
}

// ---------- helpers ----------
function marketOpen(m = S.mkt) {
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: MK[m].tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value;
  const mins = +p.hour * 60 + +p.minute; return !['Sat', 'Sun'].includes(p.weekday) && mins >= MK[m].open && mins < MK[m].close;
}
const cur = () => MK[S.mkt].cur;
const fmt = (x, d = 2) => x == null || !isFinite(x) ? '–' : (+x).toLocaleString(S.mkt === 'IN' ? 'en-IN' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = x => !isFinite(x) ? '' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${x.toFixed(2)}%</span>`;
const cls = sc => sc >= 58 ? 'b1' : sc <= 42 ? 'b-1' : 'b0';
const badge = (sc, lbl) => `<div class="sc ${cls(sc)}">${sc}<small>${esc(lbl || '')}</small></div>`;
const shortAct = a => ({ 'STRONG BUY': 'S.BUY', 'BUY': 'BUY', 'HOLD / WAIT': 'HOLD', 'SELL': 'SELL', 'STRONG SELL': 'S.SELL', 'SELL / EXIT': 'EXIT', 'AVOID': 'AVOID' }[a] || a);
function setLive() { const on = marketOpen(); $('#live').className = 'live' + (on ? ' on' : ''); $('#live span').textContent = on ? 'Market open' : 'Closed'; }

// ---------- views ----------
function render() {
  clearInterval(S.timer); S.timer = null;
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mkt));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.t === S.tab));
  $('#navFno').style.display = S.mkt === 'IN' ? '' : 'none';
  setLive(); window.scrollTo(0, 0);
  ({ home: vHome, scan: vScan, fno: vFno, saved: vSaved, detail: vDetail, broker: vBroker })[S.tab]();
  const gb = $('#gear'); if (gb) gb.classList.toggle('on', !!(window.MS && MS.ok()));
}
function rowHTML(sym, name, price, chg, sc, lbl, tags = '', rank, bear) {
  return `<div class="row" data-sym="${esc(sym)}">${rank ? `<div class="rk">${rank}</div>` : ''}${sc != null ? (bear ? `<div class="sc b-1">${sc}<small>${esc(lbl || '')}</small></div>` : badge(sc, lbl)) : ''}<div class="nm"><div class="s">${esc(sym)}</div><div class="f">${esc(name)}</div>${tags}</div>
  <div class="px">${price != null ? cur() + fmt(price) : ''}<small>${chg != null ? pct(chg) : ''}</small></div></div>`;
}
function bindRows(el) { el.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym)); }

function vHome() {
  const m = MK[S.mkt], sc = S.scan[S.mkt];
  const v = $('#view');
  v.innerHTML = `<div class="search"><input id="q" placeholder="Search ${S.mkt === 'IN' ? 'any NSE stock or index' : 'any global stock, e.g. AAPL'}" autocomplete="off"></div>
  <div id="sres"></div>${S.mkt === 'IN' ? (MS.ok() ? '<div class="note up" style="margin:-4px 2px 10px">● mStock live prices on</div>' : `<div class="warn" id="msBan" style="cursor:pointer">${MS.cfg().apiKey ? 'mStock session expired. Tap to log in for live prices.' : 'Connect your mStock account for exchange-accurate live prices. Tap to set up.'}</div>`) : ''}
  <div class="idx" id="idx">${m.idx().map(x => `<div class="card" data-sym="${x[0]}"><div class="n">${x[1]}</div><div class="p" id="ix_${x[0]}"><span class="spin"></span></div><div id="ixc_${x[0]}" style="font-size:12px"></div></div>`).join('')}</div>
  <div class="chips" id="quick">${[['top', '⭐ Top rated'], ['setups', '🧭 SMC / VCP'], ['cross', '✂️ EMA cross'], ['intra', '⚡ Intraday'], ['news', '📰 News'], ['sell', '🔻 Sells']].map(x => `<button data-q="${x[0]}">${x[1]}</button>`).join('')}</div>
  <h3>Top rated today <a id="goScan">${sc ? 'Rescan' : 'Run scan'}</a></h3><div id="picks">${picksHTML(sc)}</div>
  <h3>Watchlist</h3><div id="wl">${S.saved[S.mkt].length ? '<div class="list">' + S.saved[S.mkt].map(s => rowHTML(s, nameOf(s), null, null, null)).join('') + '</div>' : '<div class="empty">Tap ☆ on any stock to save it here.</div>'}</div>
  <h3>Popular</h3><div class="chips" style="flex-wrap:wrap">${(S.mkt === 'IN' ? window.SEED_IN.slice(0, 24) : window.US_LIST.slice(0, 24)).map(x => `<button data-sym="${x[0]}">${x[0]}</button>`).join('')}</div>
  ${S.mkt === 'IN' && S.nse.seed ? '<p class="note">Showing a starter list. The full NSE list loads in the installed app build.</p>' : S.mkt === 'IN' ? `<p class="note">${S.nse.eq.length.toLocaleString()} NSE stocks · ${Object.keys(S.nse.fo || {}).length} F&O stocks · list from ${S.nse.updated}</p>` : ''}`;
  v.querySelectorAll('.idx .card, .chips button').forEach(b => b.onclick = () => openDetail(b.dataset.sym));
  bindRows(v); $('#goScan').onclick = () => { S.tab = 'scan'; render(); runScan(); };
  v.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { S.scanFilter = b.dataset.q; S.tab = 'scan'; render(); if (!S.scan[S.mkt]) runScan(); });
  setupSearch(); const mb = $('#msBan'); if (mb) mb.onclick = () => $('#gear').click();
  m.idx().forEach(async x => {
    try { const { meta } = await chart(x[2], '1d', '5m'); const p = meta.regularMarketPrice, pc = meta.chartPreviousClose || meta.previousClose;
      $('#ix_' + x[0]).textContent = fmt(p); $('#ixc_' + x[0]).innerHTML = pct((p / pc - 1) * 100); } catch (e) { const el = $('#ix_' + x[0]); if (el) el.innerHTML = '<span class="mu" style="font-size:12px">offline</span>'; }
  });
  if (!navigator.onLine) v.insertAdjacentHTML('afterbegin', '<div class="warn">You are offline.</div>');
}
function picksHTML(sc) {
  if (!sc || !sc.rows) return '<div class="empty">Run a scan to rank stocks by setup quality.</div>';
  const top = rated(sc.rows, 'top').filter(x => x.rating >= 58).slice(0, 8);
  return `<div class="list">${top.map((x, k) => rowHTML(x.r.sym, nameOf(x.r.sym), x.r.price, x.r.chg, x.rating, x.label, tagsOf(x.r), k + 1)).join('') || '<div class="empty">No strong buys in the last scan.</div>'}</div><p class="note">Ranked by rating (trend + momentum + setups + news) · scan at ${new Date(sc.at).toLocaleTimeString()}.</p>`;
}
function tagsOf(r) {
  const t = [];
  (r.cross || []).slice(0, 1).forEach(c => t.push(`<span class="tag ${c.dir > 0 ? 'p' : 'n'}">${esc(c.name.split(' ')[0])} ${c.days ? '~' + Math.max(1, Math.round(c.days)) + 'd' : 'crossed'}</span>`));
  (r.setups || []).slice(0, 2).forEach(s => t.push(`<span class="tag ${s.b > 0 ? 'p' : 'n'}">${esc(s.n.replace(/^SMC: /, 'SMC ').replace(' (Minervini template)', ''))}</span>`));
  if (!(r.setups || []).length) (r.patterns || []).filter(p => p.b).slice(0, 1).forEach(p => t.push(`<span class="tag ${p.b > 0 ? 'p' : 'n'}">${esc(p.n)}</span>`));
  if (r.news && r.news.n && Math.abs(r.news.s) >= 0.15) t.push(`<span class="tag ${r.news.s > 0 ? 'p' : 'n'}">📰 ${r.news.s > 0 ? 'Positive' : 'Negative'} news</span>`);
  return t.length ? `<div>${t.join('')}</div>` : '';
}
function setupSearch() {
  const q = $('#q'), out = $('#sres'); let tm;
  q.oninput = () => {
    clearTimeout(tm); const s = q.value.trim().toUpperCase();
    if (!s) { out.innerHTML = ''; return; }
    let local = [];
    if (S.mkt === 'IN') local = [...window.IDX_IN.map(x => [x[0], x[1]]), ...S.nse.eq].filter(x => x[0].startsWith(s) || x[1].toUpperCase().includes(s)).sort((a, b) => (b[0] === s) - (a[0] === s) || (b[0].startsWith(s)) - (a[0].startsWith(s))).slice(0, 15);
    else local = window.US_LIST.filter(x => x[0].startsWith(s) || x[1].toUpperCase().includes(s)).slice(0, 8);
    const draw = (extra = []) => { out.innerHTML = `<div class="list">${[...local, ...extra].map(x => rowHTML(x[0], x[1], null, null, null)).join('') || '<div class="empty">No match</div>'}</div>`; bindRows(out); };
    draw();
    tm = setTimeout(async () => {
      try {
        const r = await ysearch(s); const have = new Set(local.map(x => x[0]));
        const extra = r.filter(x => S.mkt === 'IN' ? /\.(NS|BO)$/.test(x.symbol) : !/\.(NS|BO)$/.test(x.symbol))
          .map(x => [S.mkt === 'IN' && x.symbol.endsWith('.NS') ? baseSym(x.symbol) : x.symbol, (x.shortname || x.longname || '') + (x.exchDisp ? ' · ' + x.exchDisp : '')]).filter(x => !have.has(x[0]));
        if (q.value.trim().toUpperCase() === s) draw(extra);
      } catch (e) {}
    }, 350);
  };
}

async function msQuotes(syms, mkt) {
  if (mkt !== 'IN' || !window.MS || !MS.ok()) return null;
  try { return await MS.quotes(syms); } catch (e) { MS.lastError = e.message; return null; }
}
async function dailyQuick(sym, mkt, Q) {
  const { D, meta } = await chart(ySym(sym, mkt), '1y', '1d');
  let price = meta.regularMarketPrice, prev = null;
  const o = Q && MS.overlay(D, Q[sym]); if (o) { price = o.price; prev = o.prev; }
  const q = Engine.quick(D, { tick: MK[mkt].tick, canShort: mkt === 'US' || isFno(sym), price });
  if (!q.err && prev) q.chg = (q.price / prev - 1) * 100;
  return q;
}
// ---------- scanner ----------
const FILTERS = [['top', '⭐ Top rated'], ['swing', 'Swing buys'], ['intra', 'Intraday'], ['setups', 'SMC / VCP'], ['cross', 'EMA cross'], ['news', '📰 News'], ['sell', '🔻 Sells']];
const newsAdj = r => r.news && r.news.n ? Math.round(8 * r.news.s) : 0;
const clamp100 = x => Math.max(0, Math.min(100, Math.round(x)));
// Every list is ranked by the rating it displays, highest first.
function rated(rows, f) {
  const ok = rows.filter(Boolean), out = [];
  for (const r of ok) {
    const na = newsAdj(r), bull = (r.setups || []).filter(s => s.b > 0);
    let x = null;
    if (f === 'top') x = { rating: clamp100(r.overall + na), label: shortAct(r.act) };
    else if (f === 'swing' && r.swing.score >= 58) x = { rating: clamp100(r.swing.score + na), label: shortAct(r.swing.action) };
    else if (f === 'intra' && r.intraday && r.intraday.score >= 58) x = { rating: clamp100(r.intraday.score + 1.5 * na), label: 'INTRA' };
    else if (f === 'setups' && bull.length) x = { rating: clamp100(bull[0].q + (r.swing.score - 50) / 10 + na / 2), label: bull[0].k };
    else if (f === 'cross' && (r.cross || []).some(c => c.dir > 0)) x = { rating: clamp100(r.short.score + na), label: 'X-OVER' };
    else if (f === 'news' && r.news && r.news.n) x = { rating: clamp100(50 + 50 * r.news.s), label: r.news.s > 0.15 ? 'POS' : r.news.s < -0.15 ? 'NEG' : 'MIXED' };
    else if (f === 'sell' && r.swing.score <= 42) x = { rating: clamp100(100 - r.swing.score - na), label: 'SELL', bear: true };
    if (x) out.push(Object.assign(x, { r }));
  }
  return out.sort((a, b) => b.rating - a.rating || b.r.overall - a.r.overall);
}
function universes() {
  if (S.mkt === 'US') return [['us', `US large caps (${window.US_LIST.length})`]];
  const fo = Object.keys(S.nse.fo || {}).length;
  return [['large', `Large caps (${window.SEED_IN.length})`], ...(fo ? [['fo', `F&O stocks (${fo})`]] : []), ['all', `All NSE (${S.nse.eq.length}, slow)`]];
}
function uniSyms(u) {
  if (u === 'us') return window.US_LIST.map(x => x[0]);
  if (u === 'fo') return Object.keys(S.nse.fo);
  if (u === 'all') return S.nse.eq.map(x => x[0]);
  return window.SEED_IN.map(x => x[0]);
}
function vScan() {
  const sc = S.scan[S.mkt], f = S.scanFilter || 'top';
  $('#view').innerHTML = `<div class="card"><div style="display:flex;gap:8px"><select id="uni" style="flex:1">${universes().map(u => `<option value="${u[0]}" ${sc && sc.uni === u[0] ? 'selected' : ''}>${u[1]}</option>`).join('')}</select><button class="btn" id="run">Scan</button></div>
  <div class="prog" id="prog" style="display:none"><div style="width:0"></div></div><div class="note" id="pmsg">${sc ? `Last scan ${new Date(sc.at).toLocaleString()} · ${sc.rows.length} stocks · ${sc.src || 'Yahoo Finance'}` : 'Scores every stock on 5 time frames, patterns and EMA crosses.'}</div></div>
  <div class="chips sticky">${FILTERS.map(x => `<button data-f="${x[0]}" class="${x[0] === f ? 'on' : ''}">${x[1]}</button>`).join('')}</div><div id="sl"></div>`;
  $('#run').onclick = runScan;
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.scanFilter = b.dataset.f; vScan(); });
  drawScan();
}
function drawScan() {
  const sc = S.scan[S.mkt], el = $('#sl'); if (!el) return;
  if (!sc) { el.innerHTML = '<div class="empty">Pick a list and tap <b>Scan</b>.<br>Every stock is rated 0–100; lists are ranked highest first.</div>'; return; }
  const f = S.scanFilter || 'top', rows = rated(sc.rows, f).slice(0, 100);
  el.innerHTML = rows.length ? `<div class="list">${rows.map((x, k) => rowHTML(x.r.sym, nameOf(x.r.sym), x.r.price, x.r.chg, x.rating, x.label, tagsOf(x.r), k + 1, x.bear)).join('')}</div>` : `<div class="empty">Nothing in "${FILTERS.find(z => z[0] === f)[1]}" right now.${f === 'news' ? '<br>News loads for the top-rated stocks after each scan.' : ''}</div>`;
  bindRows(el);
}
async function enrichNews(mkt, rows) { // news for the strongest candidates, then re-rank
  if (!window.News) return;
  const pick = [...rated(rows, 'top').slice(0, 25), ...rated(rows, 'sell').slice(0, 10), ...rated(rows, 'setups').slice(0, 10)].map(x => x.r);
  const uniq = [...new Set(pick)];
  await pool(uniq, 4, async r => { try { const n = await News.get(ySym(r.sym, mkt), nameOf(r.sym, mkt), mkt === 'IN'); r.news = { s: +(n.score * Math.min(1, n.n / 3)).toFixed(2), n: n.n, top: (n.items.find(i => i.s) || {}).title || '' }; } catch (e) {} },
    (d, n) => { const m = $('#pmsg'); if (m && S.mkt === mkt) m.textContent = `Reading news ${d}/${n}…`; });
}
async function runScan() {
  const sel = $('#uni'), uni = sel ? sel.value : (S.mkt === 'US' ? 'us' : 'large'), syms = uniSyms(uni), mkt = S.mkt;
  if (uni === 'all' && !confirm(`Scan all ${syms.length} stocks? This takes several minutes and a lot of data.`)) return;
  const pg = $('#prog'); if (pg) pg.style.display = '';
  const m0 = $('#pmsg'); if (m0 && mkt === 'IN' && window.MS && MS.ok()) m0.textContent = 'Getting live prices from mStock…';
  const Q = await msQuotes(syms, mkt);
  const rows = await pool(syms, 6, async sym => {
    const q = await dailyQuick(sym, mkt, Q);
    return q.err ? null : Object.assign({ sym }, q);
  }, (d, n) => { const p = $('#prog div'); if (p) p.style.width = (100 * d / n) + '%'; const m = $('#pmsg'); if (m) m.textContent = `Scanning ${d}/${n}…`; });
  const good = rows.filter(Boolean);
  S.scan[mkt] = { at: Date.now(), uni, rows: good, src: Q ? 'mStock live prices' : 'Yahoo Finance' };
  if (S.tab === 'scan' && S.mkt === mkt) drawScan();
  await enrichNews(mkt, good);
  S.scan[mkt].at = Date.now(); store.set('scan', S.scan);
  if (S.tab === 'scan' && S.mkt === mkt) { vScan(); if (!good.length) $('#pmsg').textContent = 'Could not load data. Live data works in the installed Android app (browsers block it).'; }
}

// ---------- F&O ----------
function vFno() {
  const sc = S.scan.IN, fo = sc && sc.uni === 'fo' ? sc.rows.filter(Boolean) : null, lots = Object.keys(S.nse.fo || {}).length;
  $('#view').innerHTML = `<h3>Indices</h3><div class="list">${window.IDX_IN.map(x => rowHTML(x[0], x[1] + (foLot(x[0]) ? ' · lot ' + foLot(x[0]) : ''), null, null, null)).join('')}</div>
  <h3>F&O stock setups <a id="fscan">${lots ? 'Scan F&O stocks' : ''}</a></h3>
  ${!lots ? '<div class="warn">F&O list and lot sizes load in the installed app build.</div>' : ''}
  ${fo ? `<h3>Long ideas · highest rated first</h3><div class="list">${rated(fo, 'swing').slice(0, 30).map((x, k) => rowHTML(x.r.sym, `Lot ${foLot(x.r.sym)} · ${nameOf(x.r.sym)}`, x.r.price, x.r.chg, x.rating, 'LONG', tagsOf(x.r), k + 1)).join('') || '<div class="empty">No long setups.</div>'}</div>
     <h3>Short ideas · strongest first</h3><div class="list">${rated(fo, 'sell').slice(0, 30).map((x, k) => rowHTML(x.r.sym, `Lot ${foLot(x.r.sym)} · ${nameOf(x.r.sym)}`, x.r.price, x.r.chg, x.rating, 'SHORT', tagsOf(x.r), k + 1, true)).join('') || '<div class="empty">No short setups.</div>'}</div>`
    : '<div class="empty">Scan the F&O list to rank futures longs and shorts.</div>'}
  <p class="note">Signals are on the underlying. Option premiums, OI and IV are not available from free data, so check the option chain in your broker before trading. Options can lose 100% quickly.</p>`;
  bindRows($('#view'));
  const b = $('#fscan'); if (b) b.onclick = async () => { b.innerHTML = '<span class="spin"></span>'; S.tab = 'scan'; render(); $('#uni').value = 'fo'; await runScan(); };
}

// ---------- saved ----------
function vSaved() {
  const L = S.saved[S.mkt];
  $('#view').innerHTML = L.length ? `<div class="list" id="svl">${L.map(s => rowHTML(s, nameOf(s), null, null, null)).join('')}</div><p class="note">Overall rating, highest first.</p>` : '<div class="empty">Nothing saved yet. Open any stock and tap ☆.</div>';
  bindRows($('#view'));
  const mkt = S.mkt;
  const got = {};
  msQuotes(L, mkt).then(Q => pool(L, 4, async sym => {
    const q = await dailyQuick(sym, mkt, Q);
    const row = document.querySelector(`#svl .row[data-sym="${CSS.escape(sym)}"]`);
    if (row && !q.err) { got[sym] = q.overall; row.outerHTML = rowHTML(sym, nameOf(sym), q.price, q.chg, q.overall, shortAct(q.act), tagsOf(q)); bindRows($('#svl')); }
  })).then(() => { const box = $('#svl'); if (!box || S.tab !== 'saved') return; [...box.children].sort((a, b) => (got[b.dataset.sym] ?? -1) - (got[a.dataset.sym] ?? -1)).forEach(n => box.appendChild(n)); });
}

// ---------- broker (mStock) ----------
function vBroker() {
  const c = MS.cfg(), ok = MS.ok();
  $('#view').innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">mStock live data</div><div class="f">Mirae Asset · Type A API</div></div></div>
  <div class="card"><div style="display:flex;align-items:center;gap:10px"><span class="live ${ok ? 'on' : ''}"><i></i><span></span></span><b>${esc(MS.status())}</b></div>
  <p class="note" style="margin:8px 0 0">${ok ? 'India prices, candles and scans now use mStock live data. Yahoo is the fallback.' : 'Log in once per trading day. mStock sessions expire daily.'}</p></div>
  <div class="card"><h3 style="margin-top:0">1 · API key</h3>
   <input id="apik" type="password" placeholder="mStock API key" value="${esc(c.apiKey)}" class="inp">
   <label class="note"><input type="checkbox" id="totp" ${c.totp ? 'checked' : ''}> I use an authenticator app (TOTP) instead of SMS OTP</label>
   <details style="margin-top:6px"><summary class="note">Advanced</summary><input id="cks" placeholder="checksum" value="${esc(c.checksum || 'L')}" class="inp"><p class="note">mStock's docs use "L" as the checksum. Change it only if mStock support tells you to.</p></details>
   <button class="btn g w" id="saveK" style="margin-top:8px">Save key on this phone</button></div>
  <div class="card"><h3 style="margin-top:0">2 · Log in</h3>
   <input id="usr" placeholder="mStock client ID / username" value="${esc(c.user || '')}" class="inp" autocomplete="username">
   <input id="pwd" type="password" placeholder="Password (never saved)" class="inp" autocomplete="current-password">
   <button class="btn w" id="doLogin">${c.totp ? 'Log in' : 'Log in & send OTP'}</button>
   <div id="otpBox" style="display:none;margin-top:10px"><input id="otp" inputmode="numeric" placeholder="${c.totp ? 'Authenticator code' : 'OTP from SMS'}" class="inp"><button class="btn w" id="doOtp">Verify</button></div>
   <div id="bmsg" class="note" style="margin-top:8px"></div></div>
  ${ok ? '<div class="card"><button class="btn g w" id="testQ">Test: fetch RELIANCE live price</button><div id="tmsg" class="note" style="margin-top:8px"></div></div>' : ''}
  <div class="card"><button class="btn g w" id="lout">Log out</button><button class="btn g w" id="forget" style="margin-top:8px;color:var(--dn)">Remove key & data from this phone</button></div>
  <div class="warn">🔒 Your key, client ID and the day's session token are stored only inside this app on this phone. They are never uploaded, never put in the APK, and the password is never stored. Don't share screenshots of this screen. mStock recommends a server for API keys; this on-device setup is for your personal phone only.</div>`;
  $('#back').onclick = () => { S.tab = S.prevTab || 'home'; render(); };
  const msg = (t, bad) => { $('#bmsg').innerHTML = `<span class="${bad ? 'dn' : 'up'}">${esc(t)}</span>`; };
  const saveCfg = () => { const n = { apiKey: $('#apik').value.trim(), user: $('#usr').value.trim(), checksum: ($('#cks').value || 'L').trim(), totp: $('#totp').checked }; MS.saveCfg(n); return n; };
  $('#saveK').onclick = () => { const n = saveCfg(); msg(n.apiKey ? 'Key saved on this phone.' : 'Enter your API key first.', !n.apiKey); };
  $('#totp').onchange = () => { saveCfg(); vBroker(); };
  $('#doLogin').onclick = async () => {
    const n = saveCfg(); if (!n.apiKey || !n.user || !$('#pwd').value) return msg('Enter API key, client ID and password.', true);
    const b = $('#doLogin'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try { await MS.login(n.user, $('#pwd').value); $('#pwd').value = ''; $('#otpBox').style.display = ''; msg(n.totp ? 'Password OK. Enter your authenticator code.' : 'OTP sent to your registered mobile.'); $('#otp').focus(); }
    catch (e) { msg('Login failed: ' + e.message, true); }
    b.disabled = false; b.textContent = n.totp ? 'Log in' : 'Log in & send OTP';
  };
  $('#doOtp').onclick = async () => {
    const code = $('#otp').value.trim(); if (!code) return;
    try { MS.cfg().totp ? await MS.verifyTotp(code) : await MS.verifyOtp(code); msg('Connected. Live mStock data is on.'); setTimeout(vBroker, 700); }
    catch (e) { msg('Verification failed: ' + e.message, true); }
  };
  const tq = $('#testQ'); if (tq) tq.onclick = async () => {
    $('#tmsg').innerHTML = '<span class="spin"></span>';
    try { const q = await MS.quotes(['RELIANCE']); const r = q.RELIANCE; $('#tmsg').innerHTML = r ? `<span class="up">RELIANCE ₹${r.last_price} (prev close ${r.ohlc ? r.ohlc.close : '–'})</span>` : '<span class="wa">Connected, but no quote returned for RELIANCE.</span>'; }
    catch (e) { $('#tmsg').innerHTML = `<span class="dn">${esc(e.message)}</span>`; }
  };
  $('#lout').onclick = () => { MS.logout(); vBroker(); };
  $('#forget').onclick = () => { if (confirm('Remove your mStock key and session from this phone?')) { MS.forget(); vBroker(); } };
  setLive();
}

// ---------- detail ----------
function openDetail(sym) { S.detail = { sym, mkt: S.mkt }; S.prevTab = S.tab === 'detail' ? S.prevTab : S.tab; S.tab = 'detail'; S.chartMode = 'daily'; render(); }
async function loadDetail() {
  const { sym, mkt } = S.detail, ys = ySym(sym, mkt), useMS = mkt === 'IN' && window.MS && MS.ok();
  let d = null, it = null, src = 'Yahoo Finance', msErr = null, prev = null;
  if (useMS) {
    try {
      const [D, I] = await Promise.all([MS.candles(sym, 'day', 730), MS.candles(sym, '5minute', 6).catch(() => null)]);
      if (D.c.length >= 60) { d = { D, meta: {} }; it = I && { D: I }; src = 'mStock'; }
    } catch (e) { msErr = e.message; }
  }
  if (!d) [d, it] = await Promise.all([chart(ys, '2y', '1d'), chart(ys, '5d', '5m').catch(() => null)]);
  let price = d.meta.regularMarketPrice || d.D.c[d.D.c.length - 1];
  if (useMS) {
    try { const q = (await MS.quotes([sym]))[sym]; const o = MS.overlay(d.D, q); if (o) { price = o.price; prev = o.prev; src = src === 'mStock' ? 'mStock live' : 'Yahoo history + mStock live price'; } }
    catch (e) { msErr = msErr || e.message; }
  }
  const fno = mkt === 'IN' && isFno(sym);
  let news = S.detail.news;
  if (!news || Date.now() - news.at > 5 * 60e3) { try { news = Object.assign(await News.get(ys, nameOf(sym, mkt), mkt === 'IN'), { at: Date.now() }); } catch (e) { news = { items: [], score: 0, n: 0, err: e.message, at: Date.now() }; } }
  const A = Engine.analyze(d.D, { intra: it && it.D, tick: MK[mkt].tick, canShort: mkt === 'US' || fno, backtest: true, price, fnoSym: fno ? sym : null, lot: foLot(sym), news: news.n ? news.score * Math.min(1, news.n / 3) : 0 });
  if (prev && !A.err) A.chg = (A.price / prev - 1) * 100;
  Object.assign(S.detail, { A, D: d.D, intra: it && it.D, meta: d.meta, at: Date.now(), src, msErr, news });
}
async function vDetail() {
  const v = $('#view'), { sym } = S.detail;
  v.innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">${esc(sym)}</div><div class="f">${esc(nameOf(sym))}</div></div><button class="star" id="star">${S.saved[S.mkt].includes(sym) ? '★' : '☆'}</button></div><div id="dbody"><div class="empty"><span class="spin"></span> Analysing ${esc(sym)}…</div></div>`;
  $('#back').onclick = () => { S.tab = S.prevTab || 'home'; render(); };
  $('#star').onclick = () => { const L = S.saved[S.mkt], i = L.indexOf(sym); i < 0 ? L.push(sym) : L.splice(i, 1); store.set('saved', S.saved); $('#star').textContent = i < 0 ? '★' : '☆'; };
  try { await loadDetail(); } catch (e) {
    $('#dbody').innerHTML = `<div class="warn">Could not load live data for ${esc(sym)} (${esc(e.message)}).<br>Live data works in the installed Android app; browsers block Yahoo Finance. Check the symbol if you're in the app.</div>`; return;
  }
  if (S.tab !== 'detail' || S.detail.sym !== sym) return;
  drawDetail();
  if (marketOpen(S.detail.mkt)) S.timer = setInterval(async () => { try { await loadDetail(); if (S.tab === 'detail' && S.detail.sym === sym) drawDetail(true); } catch (e) {} }, 30000);
}
function ring(sc) {
  const c = 2 * Math.PI * 40, col = sc >= 58 ? 'var(--up)' : sc <= 42 ? 'var(--dn)' : 'var(--wa)';
  return `<div class="ring"><svg width="92" height="92"><circle cx="46" cy="46" r="40" stroke="#1e2935" stroke-width="9" fill="none"/><circle cx="46" cy="46" r="40" stroke="${col}" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="${c * sc / 100} ${c}"/></svg><div class="v">${sc}<small>/ 100</small></div></div>`;
}
function drawDetail(isRefresh) {
  const { A, sym, meta, at } = S.detail, H = A.horizons, c = cur();
  if (A.err) { $('#dbody').innerHTML = `<div class="warn">${esc(A.err)}</div>`; return; }
  const k = S.hz, h = H[k];
  const hzChips = Object.keys(H).map(x => `<button data-h="${x}" class="${x === k ? 'on' : ''}"><span class="d" style="background:${H[x].na ? '#555' : H[x].dir > 0 ? 'var(--up)' : H[x].dir < 0 ? 'var(--dn)' : 'var(--wa)'}"></span>${H[x].label}</button>`).join('');
  const L = h.levels, lvl = (l, x) => `<div><div class="l">${l}</div><div class="v">${fmt(x)}</div><div class="p">${L && l !== 'Entry' ? pct((x / L.entry - 1) * 100) : '&nbsp;'}</div></div>`;
  const pillCls = h.dir > 0 ? 'b1' : h.dir < 0 ? 'b-1' : 'b0';
  const odds = h.bt && h.bt.odds != null ? `<b class="${h.bt.odds >= 50 ? 'up' : h.bt.odds >= 40 ? 'wa' : 'dn'}">${h.bt.odds}%</b> win odds <span class="mu">(${h.bt.wins}/${h.bt.n} past signals hit T1 before stop)</span>` : h.bt ? '<span class="mu">Too few past signals to estimate win odds</span>' : '';
  const st = A.stats;
  $('#dbody').innerHTML = `
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="price">${c}${fmt(A.price)}</div><div>${pct(A.chg)} <span class="mu" style="font-size:12px">today · ${isRefresh ? 'updated ' : ''}${new Date(at).toLocaleTimeString()}</span></div><div style="font-size:11px;margin-top:3px" class="${/mStock/.test(S.detail.src) ? 'up' : 'mu'}">Source: ${esc(S.detail.src)}${S.detail.msErr ? ` <span class="wa">· mStock: ${esc(S.detail.msErr)}</span>` : ''}</div></div>
  <span class="live ${marketOpen(S.detail.mkt) ? 'on' : ''}"><i></i><span>${marketOpen(S.detail.mkt) ? 'Live · 30s' : 'Market closed'}</span></span></div></div>
  <div class="card hero">${ring(A.overall)}<div><div class="sub">Overall setup score</div><div class="verdict ${cls(A.overall) === 'b1' ? 'up' : cls(A.overall) === 'b-1' ? 'dn' : 'wa'}">${A.overallAction}</div>
  <div class="sub">${Object.values(H).filter(x => !x.na).map(x => `${x.label.split(' ')[0]} <b class="${x.dir > 0 ? 'up' : x.dir < 0 ? 'dn' : 'wa'}">${x.score}</b>`).join(' · ')}</div></div></div>
  <h3>What to do</h3><div class="chips">${hzChips}</div>
  <div class="card hz">${h.na ? `<div class="empty">Not enough history for ${h.label.toLowerCase()} analysis.</div>` : `
   <div class="top2"><span class="pill ${pillCls}">${h.action}</span><div style="flex:1"><div style="font-weight:800;font-size:18px">${h.score}<span class="mu" style="font-size:13px">/100 setup score</span></div><div class="sub">⏱ ${h.dur}</div></div></div>
   <div class="meter"><i style="left:calc(${h.score}% - 2px)"></i></div>
   <div style="font-size:13px;margin-top:6px">${odds}</div>${h.dir && h.bt && h.bt.odds != null && h.bt.odds < 100 / (1 + (h.levels ? h.levels.rr1 : 1.5)) ? `<div class="warn" style="margin:8px 0 0">⚠ Weak edge: on ${esc(S.detail.sym)} this signal hit Target 1 less often than the ${Math.round(100 / (1 + h.levels.rr1))}% needed to break even. Trade smaller, or wait for a pattern trigger.</div>` : ''}
   ${L ? `<div class="lv">${lvl('Entry', L.entry)}${lvl('Stop loss', L.stop)}${lvl('Target 1', L.t1)}${lvl('Target 2', L.t2)}</div>
   <div class="sub">Risk ${L.riskPct.toFixed(1)}% · Reward:risk 1:${L.rr1} / 1:${L.rr2}${L.vwap ? ` · VWAP ${fmt(L.vwap)}` : ''}${h.noShort ? ' · Exit longs or avoid. Shorting needs F&O.' : ''}${k === 'intraday' && S.detail.mkt === 'IN' ? ' · Square off by 3:15 PM' : ''}</div>
   ${A.fno && h.dir && (k === 'intraday' || k === 'swing') ? `<div class="sub" style="margin-top:6px">Futures: ${h.dir > 0 ? 'BUY' : 'SELL'} 1 lot${A.fno.lot ? ` (${A.fno.lot} qty) · risk ≈ ${c}${fmt(Math.abs(L.entry - L.stop) * A.fno.lot, 0)}` : ''}</div>` : ''}`
     : '<div class="sub">No clear edge. Wait for the score to move above 58 (buy) or below 42 (sell).</div>'}
   <ul class="why">${h.why.map(w => `<li>${w.w > 0 ? '<span class="up">✓</span>' : '<span class="dn">✗</span>'} ${esc(w.t)}</li>`).join('')}</ul>`}</div>
  <div class="card pvcard"><div class="pvhead"><b>Chart</b><span class="note">Daily · EMA 20/50/200 · levels</span><button class="btn sm" id="openChart">⛶ Live chart</button></div><div id="pv" class="pv"></div><div class="note" style="margin-top:6px">Tap the chart for full screen: 1m → monthly, EMAs, VWAP, RSI, MACD, free scrolling.</div></div>
  <h3>Setups <span class="note">SMC · VCP · trend</span></h3><div class="card">${A.setups.length ? A.setups.map(s => `<div class="setup"><div class="sh"><span class="tag ${s.b > 0 ? 'p' : 'n'}">${esc(s.k)}</span><b>${esc(s.n.replace(/^SMC: /, ''))}</b><span class="q ${s.q >= 70 ? 'up' : s.q >= 55 ? 'wa' : 'mu'}">${s.q}</span></div>
     <div class="qbar"><i style="width:${s.q}%;background:${s.b > 0 ? 'var(--up)' : 'var(--dn)'}"></i></div><div class="x">${esc(s.note)}</div>
     ${s.entry ? `<div class="lv3"><span>Entry <b>${fmt(s.entry)}</b></span><span>SL <b class="dn">${fmt(s.stop)}</b></span><span>Target <b class="up">${fmt(s.target)}</b></span></div>` : ''}</div>`).join('') : '<div class="note">No SMC, VCP or trend setup active on the daily chart today.</div>'}</div>
  <h3>News <span class="note">${newsHead(S.detail.news)}</span></h3><div class="card">${newsHTML(S.detail.news)}</div>
  ${A.fno ? `<h3>F&O</h3><div class="card"><div class="kv"><div><div class="l">Lot size</div><div class="v">${A.fno.lot || '–'}</div></div><div><div class="l">ATM strike (approx.)</div><div class="v">${fmt(A.fno.atm, 0)}</div></div>
   <div><div class="l">Expected 1-day move</div><div class="v">±${fmt(A.fno.moveDay)}</div></div><div><div class="l">Expected 1-week move</div><div class="v">±${fmt(A.fno.moveWeek)}</div></div></div>
   <p style="margin:10px 0 4px;font-weight:700">${esc(A.fno.idea)}</p><p class="note">Use the underlying's stop and targets above to exit the option. Strike gaps are approximate, so confirm in the option chain. Buy near-expiry options only on high scores; time decay is brutal.</p></div>` : ''}
  <h3>Chart patterns</h3><div class="card">${A.patterns.length ? A.patterns.map(p => `<div class="pat"><div class="ic">${p.b > 0 ? '🟢' : p.b < 0 ? '🔴' : '🟡'}</div><div><div class="n">${esc(p.n)}</div><div class="x">${esc(p.note)}</div>${p.target || p.stop ? `<div class="x">${p.target ? 'Pattern target <b>' + fmt(p.target) + '</b>' : ''}${p.target && p.stop ? ' · ' : ''}${p.stop ? 'Invalid below/above <b>' + fmt(p.stop) + '</b>' : ''}</div>` : ''}</div></div>`).join('') : '<div class="note">No clear pattern on the daily chart right now.</div>'}</div>
  <h3>EMA crossovers</h3><div class="card">${A.cross.length ? A.cross.map(x => `<div class="pat"><div class="ic">${x.dir > 0 ? '⬆️' : '⬇️'}</div><div><div class="n">${esc(x.name)}</div><div class="x">${esc(x.status)}${x.gap != null ? ` · gap ${x.gap.toFixed(2)}%` : ''} · matters for ${x.hz}</div></div></div>`).join('') : '<div class="note">No EMA cross recent or expected soon.</div>'}</div>
  <h3>Key stats</h3><div class="kv">
   <div><div class="l">RSI 14</div><div class="v">${fmt(st.rsi, 0)}</div></div><div><div class="l">ADX (trend strength)</div><div class="v">${fmt(st.adx, 0)}</div></div>
   <div><div class="l">Daily range (ATR)</div><div class="v">${fmt(st.atr)} · ${st.atrPct.toFixed(1)}%</div></div><div><div class="l">Volume vs 20-day</div><div class="v">${isFinite(st.volx) ? st.volx.toFixed(1) + '×' : '–'}</div></div>
   <div><div class="l">52-week low</div><div class="v">${fmt(st.lo52)}</div></div><div><div class="l">52-week high</div><div class="v">${fmt(st.hi52)}</div></div>
   <div><div class="l">EMA 20 / 50</div><div class="v">${fmt(st.e20, 0)} / ${fmt(st.e50, 0)}</div></div><div><div class="l">EMA 200</div><div class="v">${fmt(st.e200, 0)}</div></div></div>
  <p class="note" style="margin-top:14px">Scores are technical only (price, volume, trend, momentum, patterns), not fundamentals or news. "Win odds" come from this stock's own last ~3 years of signals. They describe the past, not a promise. Data: Yahoo Finance (may be delayed). Not investment advice.</p>`;
  document.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { S.hz = b.dataset.h; drawDetail(); });
  const oc = () => ChartView.open({ sym: S.detail.sym, mkt: S.detail.mkt, levels: (A.horizons[S.hz] || {}).levels });
  $('#openChart').onclick = oc; $('#pv').onclick = oc;
  drawPreview();
}
function newsHead(N) {
  if (!N || !N.n) return N && N.err ? 'unavailable' : 'no rated headlines';
  const s = N.score; return `${s > 0.15 ? '<span class="up">Positive</span>' : s < -0.15 ? '<span class="dn">Negative</span>' : 'Neutral'} · ${N.n} headlines`;
}
function ago(t) { const m = (Date.now() - t) / 6e4; return m < 60 ? Math.max(1, m | 0) + 'm' : m < 1440 ? (m / 60 | 0) + 'h' : (m / 1440 | 0) + 'd'; }
function newsHTML(N) {
  if (!N || !N.items.length) return `<div class="note">${N && N.err ? 'News could not be loaded (works in the installed app).' : 'No recent news found.'}</div>`;
  return N.items.slice(0, 10).map(it => `<a class="news" href="${esc(it.url)}" target="_blank" rel="noopener"><i class="${it.s > 0 ? 'p' : it.s < 0 ? 'n' : ''}"></i><div><div class="nt">${esc(it.title)}</div><div class="x">${esc(it.src || '')} · ${it.t ? ago(it.t) + ' ago' : ''}</div></div></a>`).join('')
    + '<div class="note" style="margin-top:6px">Green = positive keywords, red = negative. Sentiment nudges ratings by up to ±8 points.</div>';
}
function drawPreview() {
  const el = $('#pv'); if (!el || !window.LightweightCharts) return;
  const { A, D, mkt } = S.detail; el.innerHTML = '';
  const LW = window.LightweightCharts, ch = LW.createChart(el, { autoSize: true, height: 230, layout: { background: { color: '#0d131a' }, textColor: '#8a97a6', fontSize: 10, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: '#141c26' } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
    handleScroll: false, handleScale: false, crosshair: { mode: 2 } });
  const n = D.c.length, s0 = Math.max(0, n - 130), B = [];
  for (let i = s0; i < n; i++) B.push({ time: D.t[i], open: D.o[i], high: D.h[i], low: D.l[i], close: D.c[i] });
  const cs = ch.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false });
  cs.setData(B);
  [['e20', '#4c9aff'], ['e50', '#f5b301'], ['e200', '#c084fc']].forEach(([k, color]) => { const ls = ch.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); ls.setData(B.map((b, j) => ({ time: b.time, value: A.I[k][s0 + j] })).filter(p => isFinite(p.value))); });
  const L = (A.horizons[S.hz] || {}).levels; if (L) [[L.stop, '#ef4444', 'SL'], [L.t1, '#22c55e', 'T1'], [L.t2, '#22c55e', 'T2']].forEach(([price, color, title]) => cs.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, title }));
  ch.timeScale().fitContent();
}
window.App = { ySym, chart, fmt, marketOpen };

// ---------- boot ----------
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { S.mkt = b.dataset.m; store.set('mkt', S.mkt); if (S.tab === 'detail' || (S.tab === 'fno' && S.mkt === 'US')) S.tab = 'home'; render(); });
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => { if (b.dataset.t === 'desk') { location.href = 'desk.html'; return; } S.tab = b.dataset.t; render(); });
$('#gear').onclick = () => { if (S.tab !== 'broker') S.prevTab = S.tab; S.tab = 'broker'; render(); };

loadNSE().then(render);
