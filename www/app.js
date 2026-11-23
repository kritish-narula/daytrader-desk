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
  ({ home: vHome, scan: vScan, fno: vFno, saved: vSaved, detail: vDetail })[S.tab]();
}
function rowHTML(sym, name, price, chg, sc, lbl, tags = '') {
  return `<div class="row" data-sym="${esc(sym)}">${sc != null ? badge(sc, lbl) : ''}<div class="nm"><div class="s">${esc(sym)}</div><div class="f">${esc(name)}</div>${tags}</div>
  <div class="px">${price != null ? cur() + fmt(price) : ''}<small>${chg != null ? pct(chg) : ''}</small></div></div>`;
}
function bindRows(el) { el.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym)); }

function vHome() {
  const m = MK[S.mkt], sc = S.scan[S.mkt];
  const v = $('#view');
  v.innerHTML = `<div class="search"><input id="q" placeholder="Search ${S.mkt === 'IN' ? 'any NSE stock or index' : 'any global stock, e.g. AAPL'}" autocomplete="off"></div>
  <div id="sres"></div>
  <div class="idx" id="idx">${m.idx().map(x => `<div class="card" data-sym="${x[0]}"><div class="n">${x[1]}</div><div class="p" id="ix_${x[0]}"><span class="spin"></span></div><div id="ixc_${x[0]}" style="font-size:12px"></div></div>`).join('')}</div>
  <h3>Top setups today <a id="goScan">${sc ? 'Rescan' : 'Run scan'}</a></h3><div id="picks">${picksHTML(sc)}</div>
  <h3>Watchlist</h3><div id="wl">${S.saved[S.mkt].length ? '<div class="list">' + S.saved[S.mkt].map(s => rowHTML(s, nameOf(s), null, null, null)).join('') + '</div>' : '<div class="empty">Tap ☆ on any stock to save it here.</div>'}</div>
  <h3>Popular</h3><div class="chips" style="flex-wrap:wrap">${(S.mkt === 'IN' ? window.SEED_IN.slice(0, 24) : window.US_LIST.slice(0, 24)).map(x => `<button data-sym="${x[0]}">${x[0]}</button>`).join('')}</div>
  ${S.mkt === 'IN' && S.nse.seed ? '<p class="note">Showing a starter list. The full NSE list loads in the installed app build.</p>' : S.mkt === 'IN' ? `<p class="note">${S.nse.eq.length.toLocaleString()} NSE stocks · ${Object.keys(S.nse.fo || {}).length} F&O stocks · list from ${S.nse.updated}</p>` : ''}`;
  v.querySelectorAll('.idx .card, .chips button').forEach(b => b.onclick = () => openDetail(b.dataset.sym));
  bindRows(v); $('#goScan').onclick = () => { S.tab = 'scan'; render(); runScan(); };
  setupSearch();
  m.idx().forEach(async x => {
    try { const { meta } = await chart(x[2], '1d', '5m'); const p = meta.regularMarketPrice, pc = meta.chartPreviousClose || meta.previousClose;
      $('#ix_' + x[0]).textContent = fmt(p); $('#ixc_' + x[0]).innerHTML = pct((p / pc - 1) * 100); } catch (e) { const el = $('#ix_' + x[0]); if (el) el.innerHTML = '<span class="mu" style="font-size:12px">offline</span>'; }
  });
  if (!navigator.onLine) v.insertAdjacentHTML('afterbegin', '<div class="warn">You are offline.</div>');
}
function picksHTML(sc) {
  if (!sc || !sc.rows) return '<div class="empty">Run a scan to rank stocks by setup quality.</div>';
  const top = sc.rows.filter(r => r.swing && r.swing.score >= 58).sort((a, b) => b.swing.score - a.swing.score).slice(0, 6);
  return `<div class="list">${top.map(r => rowHTML(r.sym, nameOf(r.sym), r.price, r.chg, r.swing.score, shortAct(r.swing.action), tagsOf(r))).join('') || '<div class="empty">No strong buys in the last scan.</div>'}</div><p class="note">Swing scores from scan at ${new Date(sc.at).toLocaleTimeString()}.</p>`;
}
function tagsOf(r) {
  const t = [];
  (r.cross || []).slice(0, 1).forEach(c => t.push(`<span class="tag ${c.dir > 0 ? 'p' : 'n'}">${esc(c.name.split(' ')[0])} ${c.days ? '~' + Math.max(1, Math.round(c.days)) + 'd' : 'crossed'}</span>`));
  (r.patterns || []).filter(p => p.b).slice(0, 2).forEach(p => t.push(`<span class="tag ${p.b > 0 ? 'p' : 'n'}">${esc(p.n)}</span>`));
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

// ---------- scanner ----------
const FILTERS = [['buy', 'Top buys'], ['intra', 'Intraday movers'], ['cross', 'EMA cross soon'], ['pat', 'Patterns'], ['sell', 'Top sells'], ['all', 'All']];
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
  const sc = S.scan[S.mkt], f = S.scanFilter || 'buy';
  $('#view').innerHTML = `<div class="card"><div style="display:flex;gap:8px"><select id="uni" style="flex:1">${universes().map(u => `<option value="${u[0]}" ${sc && sc.uni === u[0] ? 'selected' : ''}>${u[1]}</option>`).join('')}</select><button class="btn" id="run">Scan</button></div>
  <div class="prog" id="prog" style="display:none"><div style="width:0"></div></div><div class="note" id="pmsg">${sc ? `Last scan ${new Date(sc.at).toLocaleString()} · ${sc.rows.length} stocks` : 'Scores every stock on 5 time frames, patterns and EMA crosses.'}</div></div>
  <div class="chips">${FILTERS.map(x => `<button data-f="${x[0]}" class="${x[0] === f ? 'on' : ''}">${x[1]}</button>`).join('')}</div><div id="sl"></div>`;
  $('#run').onclick = runScan;
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.scanFilter = b.dataset.f; vScan(); });
  drawScan();
}
function filterRows(rows, f) {
  const ok = rows.filter(Boolean);
  if (f === 'buy') return ok.filter(r => r.swing.score >= 58).sort((a, b) => b.swing.score - a.swing.score).map(r => [r, r.swing]);
  if (f === 'sell') return ok.filter(r => r.swing.score <= 42).sort((a, b) => a.swing.score - b.swing.score).map(r => [r, r.swing]);
  if (f === 'intra') return ok.filter(r => Math.abs(r.chg) > 0.8 && r.volx > 1.2).sort((a, b) => Math.abs(b.chg) * b.volx - Math.abs(a.chg) * a.volx).map(r => [r, r.intraday]);
  if (f === 'cross') return ok.filter(r => r.cross.some(c => c.dir > 0)).sort((a, b) => (Math.min(...a.cross.filter(c => c.dir > 0).map(c => c.days)) - Math.min(...b.cross.filter(c => c.dir > 0).map(c => c.days))) || b.short.score - a.short.score).map(r => [r, r.short]);
  if (f === 'pat') return ok.filter(r => r.patterns.some(p => p.b)).sort((a, b) => b.swing.score - a.swing.score).map(r => [r, r.swing]);
  return ok.sort((a, b) => b.overall - a.overall).map(r => [r, { score: r.overall, action: r.act }]);
}
function drawScan() {
  const sc = S.scan[S.mkt], el = $('#sl'); if (!el) return;
  if (!sc) { el.innerHTML = '<div class="empty">Pick a universe and tap Scan.</div>'; return; }
  const rows = filterRows(sc.rows, S.scanFilter || 'buy').slice(0, 80);
  el.innerHTML = rows.length ? `<div class="list">${rows.map(([r, h]) => rowHTML(r.sym, nameOf(r.sym), r.price, r.chg, h.score, shortAct(h.action), tagsOf(r))).join('')}</div>` : '<div class="empty">Nothing matches this filter right now.</div>';
  bindRows(el);
}
async function runScan() {
  const sel = $('#uni'), uni = sel ? sel.value : (S.mkt === 'US' ? 'us' : 'large'), syms = uniSyms(uni), mkt = S.mkt;
  if (uni === 'all' && !confirm(`Scan all ${syms.length} stocks? This takes several minutes and a lot of data.`)) return;
  const pg = $('#prog'); if (pg) pg.style.display = '';
  const rows = await pool(syms, 6, async sym => {
    const { D, meta } = await chart(ySym(sym, mkt), '1y', '1d');
    const q = Engine.quick(D, { tick: MK[mkt].tick, canShort: mkt === 'US' || isFno(sym), price: meta.regularMarketPrice });
    return q.err ? null : Object.assign({ sym }, q);
  }, (d, n) => { const p = $('#prog div'); if (p) p.style.width = (100 * d / n) + '%'; const m = $('#pmsg'); if (m) m.textContent = `Scanning ${d}/${n}…`; });
  const good = rows.filter(Boolean);
  S.scan[mkt] = { at: Date.now(), uni, rows: good }; store.set('scan', S.scan);
  if (S.tab === 'scan' && S.mkt === mkt) { vScan(); if (!good.length) $('#pmsg').textContent = 'Could not load data. Live data works in the installed Android app (browsers block it).'; }
}

// ---------- F&O ----------
function vFno() {
  const sc = S.scan.IN, fo = sc && sc.uni === 'fo' ? sc.rows.filter(Boolean) : null, lots = Object.keys(S.nse.fo || {}).length;
  $('#view').innerHTML = `<h3>Indices</h3><div class="list">${window.IDX_IN.map(x => rowHTML(x[0], x[1] + (foLot(x[0]) ? ' · lot ' + foLot(x[0]) : ''), null, null, null)).join('')}</div>
  <h3>F&O stock setups <a id="fscan">${lots ? 'Scan F&O stocks' : ''}</a></h3>
  ${!lots ? '<div class="warn">F&O list and lot sizes load in the installed app build.</div>' : ''}
  ${fo ? `<div class="chips"><button class="on">Long ideas</button></div><div class="list">${fo.filter(r => r.swing.score >= 60).sort((a, b) => b.swing.score - a.swing.score).slice(0, 25).map(r => rowHTML(r.sym, `Lot ${foLot(r.sym)} · ${nameOf(r.sym)}`, r.price, r.chg, r.swing.score, shortAct(r.swing.action), tagsOf(r))).join('')}</div>
     <h3>Short ideas</h3><div class="list">${fo.filter(r => r.swing.score <= 40).sort((a, b) => a.swing.score - b.swing.score).slice(0, 25).map(r => rowHTML(r.sym, `Lot ${foLot(r.sym)} · ${nameOf(r.sym)}`, r.price, r.chg, r.swing.score, shortAct(r.swing.action), tagsOf(r))).join('')}</div>`
    : '<div class="empty">Scan the F&O list to rank futures longs and shorts.</div>'}
  <p class="note">Signals are on the underlying. Option premiums, OI and IV are not available from free data, so check the option chain in your broker before trading. Options can lose 100% quickly.</p>`;
  bindRows($('#view'));
  const b = $('#fscan'); if (b) b.onclick = async () => { b.innerHTML = '<span class="spin"></span>'; S.tab = 'scan'; render(); $('#uni').value = 'fo'; await runScan(); };
}

// ---------- saved ----------
function vSaved() {
  const L = S.saved[S.mkt];
  $('#view').innerHTML = L.length ? `<div class="list" id="svl">${L.map(s => rowHTML(s, nameOf(s), null, null, null)).join('')}</div><p class="note">Live scores load below.</p>` : '<div class="empty">Nothing saved yet. Open any stock and tap ☆.</div>';
  bindRows($('#view'));
  pool(L, 4, async sym => {
    const { D, meta } = await chart(ySym(sym), '1y', '1d');
    const q = Engine.quick(D, { tick: MK[S.mkt].tick, canShort: S.mkt === 'US' || isFno(sym), price: meta.regularMarketPrice });
    const row = document.querySelector(`#svl .row[data-sym="${CSS.escape(sym)}"]`);
    if (row && !q.err) { row.outerHTML = rowHTML(sym, nameOf(sym), q.price, q.chg, q.swing.score, shortAct(q.swing.action), tagsOf(q)); bindRows($('#svl')); }
  });
}

// ---------- detail ----------
function openDetail(sym) { S.detail = { sym, mkt: S.mkt }; S.prevTab = S.tab === 'detail' ? S.prevTab : S.tab; S.tab = 'detail'; S.chartMode = 'daily'; render(); }
async function loadDetail() {
  const { sym, mkt } = S.detail, ys = ySym(sym, mkt);
  const [d, it] = await Promise.all([chart(ys, '2y', '1d'), chart(ys, '5d', '5m').catch(() => null)]);
  const fno = mkt === 'IN' && isFno(sym);
  const A = Engine.analyze(d.D, { intra: it && it.D, tick: MK[mkt].tick, canShort: mkt === 'US' || fno, backtest: true, price: d.meta.regularMarketPrice, fnoSym: fno ? sym : null, lot: foLot(sym) });
  Object.assign(S.detail, { A, D: d.D, intra: it && it.D, meta: d.meta, at: Date.now() });
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
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="price">${c}${fmt(A.price)}</div><div>${pct(A.chg)} <span class="mu" style="font-size:12px">today · ${isRefresh ? 'updated ' : ''}${new Date(at).toLocaleTimeString()}</span></div></div>
  <span class="live ${marketOpen(S.detail.mkt) ? 'on' : ''}"><i></i><span>${marketOpen(S.detail.mkt) ? 'Live · 30s' : 'Market closed'}</span></span></div></div>
  <div class="card hero">${ring(A.overall)}<div><div class="sub">Overall setup score</div><div class="verdict ${cls(A.overall) === 'b1' ? 'up' : cls(A.overall) === 'b-1' ? 'dn' : 'wa'}">${A.overallAction}</div>
  <div class="sub">${Object.values(H).filter(x => !x.na).map(x => `${x.label.split(' ')[0]} <b class="${x.dir > 0 ? 'up' : x.dir < 0 ? 'dn' : 'wa'}">${x.score}</b>`).join(' · ')}</div></div></div>
  <h3>What to do</h3><div class="chips">${hzChips}</div>
  <div class="card hz">${h.na ? `<div class="empty">Not enough history for ${h.label.toLowerCase()} analysis.</div>` : `
   <div class="top2"><span class="pill ${pillCls}">${h.action}</span><div style="flex:1"><div style="font-weight:800;font-size:18px">${h.score}<span class="mu" style="font-size:13px">/100 setup score</span></div><div class="sub">⏱ ${h.dur}</div></div></div>
   <div class="meter"><i style="left:calc(${h.score}% - 2px)"></i></div>
   <div style="font-size:13px;margin-top:6px">${odds}</div>
   ${L ? `<div class="lv">${lvl('Entry', L.entry)}${lvl('Stop loss', L.stop)}${lvl('Target 1', L.t1)}${lvl('Target 2', L.t2)}</div>
   <div class="sub">Risk ${L.riskPct.toFixed(1)}% · Reward:risk 1:${L.rr1} / 1:${L.rr2}${L.vwap ? ` · VWAP ${fmt(L.vwap)}` : ''}${h.noShort ? ' · Exit longs or avoid. Shorting needs F&O.' : ''}${k === 'intraday' && S.detail.mkt === 'IN' ? ' · Square off by 3:15 PM' : ''}</div>
   ${A.fno && h.dir && (k === 'intraday' || k === 'swing') ? `<div class="sub" style="margin-top:6px">Futures: ${h.dir > 0 ? 'BUY' : 'SELL'} 1 lot${A.fno.lot ? ` (${A.fno.lot} qty) · risk ≈ ${c}${fmt(Math.abs(L.entry - L.stop) * A.fno.lot, 0)}` : ''}</div>` : ''}`
     : '<div class="sub">No clear edge. Wait for the score to move above 58 (buy) or below 42 (sell).</div>'}
   <ul class="why">${h.why.map(w => `<li>${w.w > 0 ? '<span class="up">✓</span>' : '<span class="dn">✗</span>'} ${esc(w.t)}</li>`).join('')}</ul>`}</div>
  <div class="card"><div class="chips" style="margin:0 0 8px"><button data-c="daily" class="${S.chartMode === 'daily' ? 'on' : ''}">6 months</button><button data-c="intra" class="${S.chartMode === 'intra' ? 'on' : ''}">Today 5-min</button></div><canvas id="cv" height="260"></canvas>
  <div class="note" style="margin-top:6px">${S.chartMode === 'daily' ? '<span style="color:#4c9aff">— EMA 20</span> · <span style="color:#f5b301">— EMA 50</span> · <span style="color:#c084fc">— EMA 200</span> · ' : '<span style="color:#f5b301">— VWAP</span> · '}dashed = stop / targets of the selected time frame</div></div>
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
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { S.chartMode = b.dataset.c; drawDetail(); });
  drawChart();
}
function drawChart() {
  const { A, D, intra } = S.detail, cv = $('#cv'); if (!cv) return;
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, Hh = 260; cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  let B, lines = [];
  if (S.chartMode === 'intra' && intra) {
    const day = intra.day[intra.day.length - 1]; const idx = intra.day.map((d, i) => d === day ? i : -1).filter(i => i >= 0);
    B = idx.map(i => ({ o: intra.o[i], h: intra.h[i], l: intra.l[i], c: intra.c[i], v: intra.v[i] }));
    let pv = 0, vv = 0; lines.push({ col: '#f5b301', a: B.map(b => { pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v; return vv ? pv / vv : b.c; }) });
  } else {
    const n = D.c.length, s = Math.max(0, n - 126);
    B = []; for (let i = s; i < n; i++) B.push({ o: D.o[i], h: D.h[i], l: D.l[i], c: D.c[i] });
    const I = A.I; lines = [['e20', '#4c9aff'], ['e50', '#f5b301'], ['e200', '#c084fc']].map(([k, col]) => ({ col, a: I[k].slice(s) }));
  }
  if (!B.length) { g.fillStyle = '#8a97a6'; g.fillText('No intraday bars yet today.', 12, 24); return; }
  const L = A.horizons[S.hz] && A.horizons[S.hz].levels;
  let hi = Math.max(...B.map(b => b.h)), lo = Math.min(...B.map(b => b.l));
  if (L) { hi = Math.max(hi, L.t1, L.stop); lo = Math.min(lo, L.t1, L.stop); }
  const pad = (hi - lo) * 0.06; hi += pad; lo -= pad;
  const left = 4, right = 54, top = 8, bot = 14, cw = (W - left - right) / B.length;
  const y = v => top + (hi - v) / (hi - lo) * (Hh - top - bot), x = i => left + i * cw + cw / 2;
  g.font = '10px system-ui'; g.fillStyle = '#8a97a6';
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; g.strokeStyle = '#1e2935'; g.beginPath(); g.moveTo(left, y(v)); g.lineTo(W - right, y(v)); g.stroke(); g.fillText(fmt(v), W - right + 4, y(v) + 3); }
  B.forEach((b, i) => { const u = b.c >= b.o; g.strokeStyle = g.fillStyle = u ? '#22c55e' : '#ef4444'; g.beginPath(); g.moveTo(x(i), y(b.h)); g.lineTo(x(i), y(b.l)); g.stroke();
    g.fillRect(x(i) - Math.max(0.5, cw * 0.35), Math.min(y(b.o), y(b.c)), Math.max(1, cw * 0.7), Math.max(1, Math.abs(y(b.o) - y(b.c)))); });
  lines.forEach(Ln => { g.strokeStyle = Ln.col; g.lineWidth = 1.3; g.beginPath(); let st = false; Ln.a.forEach((v, i) => { if (!isFinite(v)) return; st ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); st = true; }); g.stroke(); g.lineWidth = 1; });
  if (L) [[L.stop, '#ef4444', 'SL'], [L.t1, '#22c55e', 'T1'], [L.t2, '#22c55e', 'T2'], [L.entry, '#8a97a6', 'E']].forEach(([v, col, t]) => {
    if (v > hi || v < lo) return; g.strokeStyle = col; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(left, y(v)); g.lineTo(W - right, y(v)); g.stroke(); g.setLineDash([]); g.fillStyle = col; g.fillText(t, left + 2, y(v) - 3); });
}

// ---------- boot ----------
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { S.mkt = b.dataset.m; store.set('mkt', S.mkt); if (S.tab === 'detail' || (S.tab === 'fno' && S.mkt === 'US')) S.tab = 'home'; render(); });
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => { if (b.dataset.t === 'desk') { location.href = 'desk.html'; return; } S.tab = b.dataset.t; render(); });
addEventListener('resize', () => { if (S.tab === 'detail' && S.detail && S.detail.A) drawChart(); });
loadNSE().then(render);
