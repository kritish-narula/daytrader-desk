/* DayTrader Desk app */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem('dtd2_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('dtd2_' + k, JSON.stringify(v)); } catch (e) {} } };
const MK = {
  IN: { name: 'India', tz: 'Asia/Kolkata', open: 555, close: 930, cur: '₹', tick: 0.05, idx: () => window.IDX_IN },
  US: { name: 'Global', tz: 'America/New_York', open: 570, close: 960, cur: '$', tick: 0.01, idx: () => window.IDX_US },
};
const S = { uniBy: store.get('uniBy', { IN: store.get('uni', { size: 'L', sector: '' }), US: { size: 'L', sector: '' } }), sizingBy: store.get('sizingBy', { IN: store.get('sizing', { capital: 100000, riskPct: 1 }), US: { capital: 2000, riskPct: 1 } }), mkt: store.get('mkt', 'IN'), tab: 'home', stack: [], nse: null, saved: store.get('saved', { IN: [], US: [] }), scan: store.get('scan', {}), detail: null, hz: 'swing', timer: null,
  news: store.get('news', {}), regime: {}, minTurnover: store.get('minTurnover', { IN: 1e7, US: 5e6 }), scanning: false, idxD: {}, rf: store.get('rf', { IN: 6, US: 4 }) };

// per-market selections: S.uni / S.sizing always refer to the current market
Object.defineProperty(S, 'uni', { get() { return S.uniBy[S.mkt]; }, set(v) { S.uniBy[S.mkt] = v; } });
Object.defineProperty(S, 'sizing', { get() { return S.sizingBy[S.mkt]; }, set(v) { S.sizingBy[S.mkt] = v; } });
// ---------- symbols ----------
async function loadNSE() {
  try { const r = await fetch('nse.json'); if (r.ok) { S.nse = await r.json(); buildFo(); return; } } catch (e) {}
  S.nse = { eq: window.SEED_IN, fo: {}, idx: {}, updated: null, seed: true }; buildFo();
}
async function loadUS() {
  try { const r = await fetch('us.json'); if (r.ok) { S.us = await r.json(); S.usMap = new Map(S.us.eq); return; } } catch (e) {}
  S.us = { eq: window.US_LIST, cat: {}, seed: true }; S.usMap = new Map(S.us.eq);
}
const IDX_OPT_US = [['SPY', 'S&P 500 ETF'], ['QQQ', 'Nasdaq-100 ETF'], ['IWM', 'Russell 2000 ETF']];
const ySym = (sym, mkt = S.mkt) => {
  if (mkt === 'US') return sym;
  const ix = window.IDX_IN.find(x => x[0] === sym) || (window.IDX_EXTRA || []).find(x => x[0] === sym); if (ix) return ix[2];
  return /\.(NS|BO)$|^\^/.test(sym) ? sym : sym + (((S.fo || {})[sym] || {}).bseOnly ? '.BO' : '.NS');
};
const baseSym = y => y.replace(/\.(NS|BO)$/, '');
const nameOf = (sym, mkt = S.mkt) => {
  if (mkt === 'US') { const x = window.US_LIST.find(z => z[0] === sym) || IDX_OPT_US.find(z => z[0] === sym); return x ? x[1] : (S.usMap && S.usMap.get(sym)) || ''; }
  const ix = window.IDX_IN.find(x => x[0] === sym) || (window.IDX_EXTRA || []).find(x => x[0] === sym); if (ix) return ix[1];
  const x = S.nse.eq.find(z => z[0] === sym); return x ? x[1] : '';
};
const foLot = (sym, mkt = S.mkt) => mkt === 'US' ? 100 : ((S.fo || {})[sym] || {}).lot || (S.nse.fo || {})[sym] || (S.nse.idx || {})[sym] || null;
const isFno = sym => !!(S.fo || {})[sym] || !!(S.nse.fo || {})[sym] || window.IDX_IN.some(x => x[0] === sym);

function tagsOf(r) {
  const t = [];
  (r.cross || []).slice(0, 1).forEach(c => t.push(`<span class="tag ${c.dir > 0 ? 'p' : 'n'}">${esc(c.name.split(' ')[0])} ${c.days ? '~' + Math.max(1, Math.round(c.days)) + 'd' : 'crossed'}</span>`));
  (r.chartPats || []).slice(0, 1).forEach(p => t.push(`<span class="tag ${p.b > 0 ? 'p' : p.b < 0 ? 'n' : ''}">📐 ${esc(p.n)}</span>`));
  (r.setups || []).slice(0, 2).forEach(s => t.push(`<span class="tag ${s.b > 0 ? 'p' : 'n'}">${esc(s.n.replace(/^SMC: /, 'SMC ').replace(' (Minervini template)', ''))}</span>`));
  if (!(r.setups || []).length) (r.patterns || []).filter(p => p.b).slice(0, 1).forEach(p => t.push(`<span class="tag ${p.b > 0 ? 'p' : 'n'}">${esc(p.n)}</span>`));
  const RLt = r.risk ? Engine.riskLabel(r.risk) : null; if (RLt && RLt.leader) t.push('<span class="tag p">🏆 Leader</span>');
  if (r.risk && r.risk.beta >= 1.4) t.push(`<span class="tag n">β ${r.risk.beta.toFixed(1)}</span>`);
  const rsv = relStr(r); if (rsv != null && Math.abs(rsv) >= 10) t.push(`<span class="tag ${rsv > 0 ? 'p' : 'n'}">RS ${rsv > 0 ? '+' : ''}${rsv.toFixed(0)}%</span>`);
  if (r.news && r.news.n && Math.abs(r.news.s) >= 0.15) t.push(`<span class="tag ${r.news.s > 0 ? 'p' : 'n'}">📰 ${r.news.s > 0 ? 'Positive' : 'Negative'} news</span>`);
  const seen = new Set(), u = t.filter(x => { const k = x.replace(/<[^>]+>|📐 /g, '').trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return u.length ? `<div>${u.join('')}</div>` : '';
}

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
  let lastYield = performance.now();
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } done++; onProg && onProg(done, items.length);
    if (performance.now() - lastYield > 40) { await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); } } })); // let taps, scrolling and the progress bar through
  return out;
}

// ---------- helpers ----------
function marketOpen(m = S.mkt) {
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: MK[m].tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value;
  const mins = +p.hour * 60 + +p.minute; if (['Sat', 'Sun'].includes(p.weekday) || mins < MK[m].open || mins >= MK[m].close) return false;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: MK[m].tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return !(m === 'IN' ? NSE_HOLIDAYS : US_HOLIDAYS).has(day);
}
// exchange holidays (weekdays). NSE 2026 per exchange calendar; US NYSE 2026.
const NSE_HOLIDAYS = new Set(['2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25']);
const US_HOLIDAYS = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
const cur = () => MK[S.mkt].cur;
const fmt = (x, d = 2) => x == null || !isFinite(x) ? '–' : (+x).toLocaleString(S.mkt === 'IN' ? 'en-IN' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = x => !isFinite(x) ? '' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${x.toFixed(2)}%</span>`;
const cls = sc => sc >= 58 ? 'b1' : sc <= 42 ? 'b-1' : 'b0';
const badge = (sc, lbl) => `<div class="sc ${cls(sc)}">${sc}<small>${esc(lbl || '')}</small></div>`;
const shortAct = a => ({ 'STRONG BUY': 'S.BUY', 'BUY': 'BUY', 'HOLD / WAIT': 'HOLD', 'SELL': 'SELL', 'STRONG SELL': 'S.SELL', 'SELL / EXIT': 'EXIT', 'AVOID': 'AVOID' }[a] || a);
function setLive() { const on = marketOpen(); $('#live').className = 'live' + (on ? ' on' : ''); $('#live span').textContent = on ? 'Market open' : 'Closed'; }

// ---------- navigation (also driven by the phone's back button) ----------
function go(tab) { if (tab !== S.tab) S.stack.push(S.tab); if (S.stack.length > 20) S.stack.shift(); S.tab = tab; render(); }
function back() {
  const sh = document.querySelector('.sheet'); if (sh) { sh.remove(); return true; }
  if (document.querySelector('#pfBg')) { window.closePfSheet && closePfSheet(); return true; }
  if (document.querySelector('#trBg')) { window.closeTrSheet && closeTrSheet(); return true; } // trades sheet
  if (window.ChartView && document.querySelector('.cfull')) { ChartView.close(); return true; }
  const sr = $('#sres'); if (sr && sr.innerHTML) { $('#q').value = ''; sr.innerHTML = ''; return true; }
  if (S.stack.length) { S.tab = S.stack.pop(); render(); return true; }
  if (S.tab !== 'home') { S.tab = 'home'; render(); return true; }
  return false;
}
// ---------- views ----------
function render() {
  clearInterval(S.timer); S.timer = null;
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mkt));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.t === S.tab));
  $('#navFno').style.display = ''; $('#navFno').lastChild.textContent = S.mkt === 'US' ? 'Options' : 'F&O'; updBell();
  setLive(); window.scrollTo(0, 0);
  try {
    ({ home: () => vHome(), scan: () => vScan(), fno: () => vFno(), saved: () => vSaved(), detail: () => vDetail(), broker: vBroker, alerts: vAlerts, ai: () => vAI(), settings: vSettings, learn: vLearn, paper: () => window.vPaper ? vPaper() : $('#view').innerHTML = '<div class="empty"><span class="spin"></span> Paper trading loading…</div>', flows: () => window.vFlows ? vFlows() : $('#view').innerHTML = '<div class="empty"><span class="spin"></span> Money flow loading…</div>', chain: () => window.vChain ? vChain() : $('#view').innerHTML = '<div class="empty"><span class="spin"></span> Option chain loading…</div>' })[S.tab](); // chain: options agent (ui-options.js)
  } catch (e) { if (e instanceof ReferenceError && !render._retry) { render._retry = 1; setTimeout(() => { render._retry = 0; render(); }, 60); return; } throw e; } // view scripts still loading
  const gb = $('#gear'); if (gb) gb.classList.toggle('on', !!(window.MS && MS.ok()));
}
function bindRows(el, hz) { el.querySelectorAll('.row[data-sym]').forEach(r => r.onclick = () => openDetail(r.dataset.sym, hz)); }
function upsertRow(mkt, row) { const sc = S.scan[mkt]; if (!sc) return; const i = sc.rows.findIndex(r => r.sym === row.sym); if (i >= 0) sc.rows[i] = Object.assign(sc.rows[i], row); }

function setupSearch() {
  const q = $('#q'), out = $('#sres'); let tm;
  q.oninput = () => {
    clearTimeout(tm); const s = q.value.trim().toUpperCase();
    if (!s) { out.innerHTML = ''; return; }
    let local = [];
    if (S.mkt === 'IN') local = [...window.IDX_IN.map(x => [x[0], x[1]]), ...S.nse.eq].filter(x => x[0].startsWith(s) || x[1].toUpperCase().includes(s)).sort((a, b) => (b[0] === s) - (a[0] === s) || (b[0].startsWith(s)) - (a[0].startsWith(s))).slice(0, 15);
    else local = [...window.US_LIST, ...((S.us && !S.us.seed) ? S.us.eq : [])].filter(x => x[0].startsWith(s) || String(x[1]).toUpperCase().includes(s)).filter((x, k, a) => a.findIndex(y => y[0] === x[0]) === k).sort((a, b) => (b[0] === s) - (a[0] === s) || (b[0].startsWith(s)) - (a[0].startsWith(s))).slice(0, 15);
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

function riskOf(D, mkt, sym) { if (mkt === 'IN' && window.IDX_IN.some(x => x[0] === sym)) return null; const k = Engine.risk(D, S.idxD[mkt], S.rf[mkt]); return k && !k.na ? k : null; }
const betaOf = r => r && r.risk && isFinite(r.risk.beta) ? r.risk.beta : undefined;
// relative strength: stock's 3-month return minus the index's (positive = outperforming)
function relStr(r, mkt = S.mkt) { const ix = S.regime[mkt]; return r && isFinite(r.ret63) && ix && isFinite(ix.ret63) ? r.ret63 - ix.ret63 : null; }
// ---------- unified rating: the same number everywhere ----------
const nkey = (mkt, sym) => mkt + ':' + sym;
function newsOf(mkt, sym) { const n = S.news[nkey(mkt, sym)]; return n && Date.now() - n.at < 6 * 3600e3 ? n : null; }
function putNews(mkt, sym, N) { S.news[nkey(mkt, sym)] = { s: +(N.score * Math.min(1, N.n / 3)).toFixed(2), n: N.n, top: (N.items.find(i => i.s) || {}).title || '', at: Date.now() }; store.set('news', S.news); }
async function regime(mkt) { // market trend from the index: nudges ratings ±5
  const r = S.regime[mkt]; if (r && S.idxD[mkt] && Date.now() - r.at < 15 * 60e3) return r.v;
  try { const { D } = await chart(mkt === 'IN' ? '^NSEI' : '^GSPC', '2y', '1d'); const q = Engine.quick(D, { tick: 0.05 }); const v = Engine.rating(q).signal; S.regime[mkt] = { v, at: Date.now(), ret63: q.ret63 }; S.idxD[mkt] = D; return v; }
  catch (e) { return 50; }
}
function rateRow(r, mkt = S.mkt) {
  if (!r || r.err) return null;
  const isIdx = mkt === 'IN' ? window.IDX_IN.some(x => x[0] === r.sym) : false, n = newsOf(mkt, r.sym);
  return Engine.rating(r, { regime: isIdx ? 50 : (S.regime[mkt] || {}).v, news: n ? n.s : 0, beta: betaOf(r) });
}
function hzRate(r, hz, mkt = S.mkt) {
  if (!r || !r[hz] || r[hz].na) return null;
  const n = newsOf(mkt, r.sym), isIdx = mkt === 'IN' && window.IDX_IN.some(x => x[0] === r.sym);
  return Engine.hzRating(r[hz], hz, { regime: isIdx ? 50 : (S.regime[mkt] || {}).v, news: n ? n.s : 0, canShort: mkt === 'US' || isFno(r.sym), beta: betaOf(r) });
}
const actLabel = a => ({ 'STRONG BUY': 'S.BUY', 'BUY': 'BUY', 'HOLD / WAIT': 'HOLD', 'SELL / AVOID': 'SELL', 'STRONG SELL': 'S.SELL', 'SELL': 'SELL', 'SELL / EXIT': 'EXIT', 'AVOID': 'AVOID' }[a] || a);
async function msQuotes(syms, mkt) {
  if (mkt !== 'IN' || !window.MS || !MS.ok()) return null;
  try { return await MS.quotes(syms); } catch (e) { MS.lastError = e.message; return null; }
}
async function dailyQuick(sym, mkt, Q) {
  const { D, meta } = await chart(ySym(sym, mkt), '2y', '1d');
  // one rule-set for price + previous close (see MS.basis in broker.js); meta.chartPreviousClose is NOT used (for a 2y range it is
  // the close before the range start). mStock quote when connected, else Yahoo's last price, marked src 'yf'.
  const mq = Q && Q[sym], hasMs = !!(mq && mq.last_price);
  const b = MS.basis(D, { mkt, lp: hasMs ? mq.last_price : meta.regularMarketPrice, pq: hasMs && mq.ohlc ? mq.ohlc.close : null, q: mq, ms: hasMs, ts: meta.regularMarketTime });
  const q = Engine.quick(D, { tick: MK[mkt].tick, canShort: mkt === 'US' || isFno(sym), price: b ? b.price : undefined });
  if (!q.err && b && b.prev) { q.chg = (q.price / b.prev - 1) * 100; q.prev = b.prev; }
  if (!q.err) { q.risk = riskOf(D, mkt, sym); q.src = b ? b.src : 'yf'; q.srcAt = Date.now(); if (b && b.official) q.closeDay = b.day; }
  if (!q.err && window.Learn) { Learn.resolve(sym, mkt, D); Learn.log(sym, mkt, q.horizons, q.t, q.price); }
  if (!q.err && q.horizons) for (const h of Object.values(q.horizons)) if (h && h.fv) delete h.fv;
  return q;
}
// ---------- scanner ----------
const FILTERS = [['top', '⭐ Overall'], ['leaders', '🏆 Leaders'], ['breakout', '🚀 Breakouts'], ['near', '⏳ Near breakout'], ['patterns', '📐 Patterns'], ['intraday', '⚡ Intraday'], ['swing', 'Swing'], ['short', 'Short term'], ['medium', 'Medium term'], ['long', 'Long term'], ['setups', '🧭 SMC / VCP'], ['cross', '✂️ EMA cross'], ['news', '📰 News'], ['sell', '🔻 Sells']];
const HZ = ['intraday', 'swing', 'short', 'medium', 'long'], HZL = { intraday: 'INTRA', swing: 'SWING', short: 'SHORT', medium: 'MEDIUM', long: 'LONG' };
// Overall lists show the overall rating; a horizon list (Swing, Intraday…) shows only stocks rated BUY on that
// horizon, ranked by that horizon's rating, high → low. The stock page opens on the same horizon with the same number.
function rated(rows, f, mkt = S.mkt) {
  const out = [], minT = S.minTurnover[mkt] || 0;
  for (const r of rows) {
    if (!r || r.err) continue;
    if (minT && r.turnover != null && r.turnover < minT) continue;
    if (HZ.includes(f)) {
      const Rh = hzRate(r, f, mkt); if (!Rh || Rh.rating < 58) continue;
      out.push({ r, rating: Rh.rating, label: HZL[f], R: Rh, sub: `${actLabel(Rh.action)} · signal ${Rh.signal}${Rh.edge != null ? ' · edge ' + Rh.edge : ''}`, hz: f });
      continue;
    }
    const R = rateRow(r, mkt); if (!R) continue;
    const proven = x => { const e = Engine.setupEdge(x.n); return e ? e.edge : true; };
    const n = newsOf(mkt, r.sym), bull = (r.setups || []).filter(s => s.b > 0 && proven(s));
    const brk = (r.setups || []).find(s => s.b > 0 && (s.k === 'BRK' || s.k === 'GAP' || /VCP breakout|Break of structure|Change of character/.test(s.n))) || ((r.patterns || []).find(p => /52-week high breakout|20-day range breakout/.test(p.n)) ? { n: (r.patterns.find(p => /breakout/.test(p.n)) || {}).n, q: 60 } : null);
    const pre = (r.setups || []).find(s => s.k === 'PRE' || /VCP \(volatility/.test(s.n));
    const rsv = relStr(r, mkt);
    const K = r.risk, RL = K ? Engine.riskLabel(K) : null;
    // breakout lists: only stocks outperforming — risk-adjusted (alpha) when available, else 3-month relative strength
    if ((f === 'breakout' || f === 'near') && (K ? K.alpha < 0 : rsv != null && rsv < 0)) continue;
    const cp = (r.chartPats || []).filter(proven)[0];
    const ok = f === 'top' ? true : f === 'patterns' ? !!cp : f === 'leaders' ? !!(RL && RL.leader) && R.rating >= 50 : f === 'breakout' ? !!brk && R.rating >= 50 : f === 'near' ? !!pre : f === 'setups' ? bull.length > 0 : f === 'cross' ? (r.cross || []).some(c => c.dir > 0)
      : f === 'news' ? n && Math.abs(n.s) >= 0.15 : f === 'sell' ? R.rating <= 42 : true;
    if (!ok) continue;
    const sub = f === 'patterns' ? `${cp.b > 0 ? '▲' : cp.b < 0 ? '▼' : '◆'} ${cp.n} · ${cp.status} · target ${fmt(cp.target)}` : f === 'leaders' ? `α ${K.alpha > 0 ? '+' : ''}${K.alpha.toFixed(0)}%/yr · β ${K.beta.toFixed(2)} · Sortino ${K.sortino.toFixed(1)}` : f === 'breakout' ? `${brk.n.replace(/^SMC: /, 'SMC ')}${rsv != null ? ` · RS +${rsv.toFixed(0)}% vs index` : ''}` : f === 'near' ? `${pre.n.replace(' (coiling under resistance)', '').replace(' (volatility contraction) forming', ' forming')} · quality ${pre.q}${rsv != null ? ` · RS +${rsv.toFixed(0)}%` : ''}` : f === 'setups' ? `${bull[0].n.replace(/^SMC: /, 'SMC ')} · quality ${bull[0].q}` : f === 'news' ? (n.top || '') : '';
    out.push({ r, rating: R.rating, label: actLabel(R.action), R, sub, hz: 'overall' });
  }
  return out.sort(f === 'sell' ? (a, b) => a.rating - b.rating : (a, b) => b.rating - a.rating || a.r.sym.localeCompare(b.r.sym));
}
const SIZES_IN = [['L', 'Large cap'], ['M', 'Mid cap'], ['S', 'Small cap'], ['U', 'Micro cap'], ['FO', 'F&O'], ['ALL', 'All NSE']];
const SIZES_US = [['L', 'Large cap (S&P 500)'], ['M', 'Mid cap (S&P 400)'], ['S', 'Small cap (S&P 600)'], ['POP', 'Popular & ETFs'], ['ALL', 'All US listed']];
const SIZES = new Proxy([], { get: (_, k) => (S.mkt === 'US' ? SIZES_US : SIZES_IN)[k] });
const catOf = (mkt = S.mkt) => (mkt === 'US' ? (S.us || {}).cat : S.nse.cat) || {};
const hasCat_ = (mkt = S.mkt) => Object.keys(catOf(mkt)).length > 0;
const SECTOR_ICON = { 'Information Technology': '💻 IT', 'Automobile and Auto Components': '🚗 Auto', 'Financial Services': '🏦 Finance', 'Healthcare': '💊 Pharma & Health', 'Fast Moving Consumer Goods': '🛒 FMCG', 'Capital Goods': '🏭 Capital goods',
  'Metals & Mining': '⛏️ Metals', 'Oil Gas & Consumable Fuels': '🛢️ Oil & gas', 'Power': '⚡ Power', 'Chemicals': '🧪 Chemicals', 'Realty': '🏢 Realty', 'Consumer Durables': '📺 Consumer durables', 'Construction': '🏗️ Construction',
  'Health Care': '💊 Health care', 'Financials': '🏦 Financials', 'Consumer Discretionary': '🛍️ Consumer discretionary', 'Communication Services': '📡 Communication', 'Industrials': '🏭 Industrials',
  'Consumer Staples': '🛒 Consumer staples', 'Energy': '🛢️ Energy', 'Real Estate': '🏢 Real estate', 'Materials': '⛏️ Materials',
  'Construction Materials': '🧱 Cement', 'Telecommunication': '📡 Telecom', 'Textiles': '🧵 Textiles', 'Services': '🧰 Services', 'Consumer Services': '🛍️ Consumer services', 'Media Entertainment & Publication': '🎬 Media', 'Diversified': '🔀 Diversified', 'Forest Materials': '🌲 Forest materials', 'Utilities': '🚰 Utilities' };
const secName = s => SECTOR_ICON[s] || s;
function sectors() { const C = catOf(), c = {}; for (const k in C) { const s = C[k][1]; if (s) c[s] = (c[s] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).map(x => x[0]); }
function uniSyms(sel = S.uni, mkt = S.mkt) {
  if (mkt === 'US') {
    const cat = catOf('US'), hc = Object.keys(cat).length > 0; let L;
    if (sel.size === 'POP' || !hc && sel.size !== 'ALL') L = window.US_LIST.map(x => x[0]);
    else if (sel.size === 'ALL') L = S.us.eq.map(x => x[0]);
    else L = Object.keys(cat).filter(s => cat[s][0] === sel.size);
    if (sel.sector && hc) L = L.filter(s => cat[s] && cat[s][1] === sel.sector);
    return L;
  }
  const cat = S.nse.cat || {}, hasCat = Object.keys(cat).length > 0;
  let L;
  if (sel.size === 'FO') L = foScannable();
  else if (sel.size === 'ALL') L = S.nse.eq.map(x => x[0]);
  else if (hasCat) L = Object.keys(cat).filter(s => cat[s][0] === sel.size);
  else L = window.SEED_IN.map(x => x[0]);
  if (sel.sector && hasCat) L = L.filter(s => cat[s] && cat[s][1] === sel.sector);
  return L;
}
function uniLabel(sel = S.uni) { return `${((S.mkt === 'US' ? SIZES_US : SIZES_IN).find(x => x[0] === sel.size) || [, 'Stocks'])[1]}${sel.sector ? ' · ' + secName(sel.sector) : ''}`; }
async function enrichNews(mkt, rows) { // news for the strongest candidates, then re-rank
  if (!window.News) return;
  const pick = [...rated(rows, 'top', mkt).slice(0, 25), ...rated(rows, 'sell', mkt).slice(0, 10), ...rated(rows, 'setups', mkt).slice(0, 10)].map(x => x.r);
  const uniq = [...new Set(pick)].filter(r => !newsOf(mkt, r.sym));
  await pool(uniq, 4, async r => { try { putNews(mkt, r.sym, await News.get(ySym(r.sym, mkt), nameOf(r.sym, mkt), mkt === 'IN')); } catch (e) {} },
    (d, n) => scanProgress(mkt, null, `Reading news ${d}/${n}…`));
}
function scanProgress(mkt, pct, msg) {
  if (pct != null) S.scanPct = pct; S.scanMsg = msg;
  if (S.mkt === mkt && S.tab === 'fno') { const f = $('#foProg'); if (f && pct != null) { f.style.display = ''; f.firstChild.style.width = pct + '%'; } return; }
  if (S.mkt !== mkt || S.tab !== 'scan') return;
  const p = $('#prog div'); if (p && pct != null) p.style.width = pct + '%'; const m = $('#pmsg'); if (m) m.textContent = msg;
}
async function runScan(syms) {
  if (S.scanning) return;
  const mkt = S.mkt; syms = syms || uniSyms();
  if (syms.length > 800 && !confirm(`Scan ${syms.length} stocks? It takes a few minutes. You can leave the app; it keeps scanning until you swipe it out of Recents.`)) return;
  S.scanning = true; S.scanPct = 0; S.frozen = {}; if (S.tab === 'scan') vScan();
  Alerts.keepAlive(true, `Scanning ${syms.length} stocks…`);
  try {
    await regime(mkt);
    scanProgress(mkt, 0, mkt === 'IN' && window.MS && MS.ok() ? 'Getting live prices from mStock…' : 'Starting…');
    const Q = await msQuotes(syms, mkt);
    let lastPing = 0;
    const rows = await pool(syms, 6, async sym => { const q = await dailyQuick(sym, mkt, Q); return q.err ? null : Object.assign({ sym }, q); },
      (d, n) => { scanProgress(mkt, 100 * d / n, `Scanning ${d}/${n}…`); if (d - lastPing >= 150) { lastPing = d; Alerts.keepAlive(true, `Scanning ${d}/${n} stocks…`); } });
    const good = rows.filter(Boolean), prev = S.scan[mkt];
    const merged = new Map((prev ? prev.rows : []).map(r => [r.sym, r])); good.forEach(r => merged.set(r.sym, r));
    S.scan[mkt] = { at: Date.now(), rows: [...merged.values()], src: Q ? 'mStock live prices' : 'Yahoo Finance' };
    if (S.tab === 'scan' && S.mkt === mkt) drawScan(); else if (S.tab === 'fno' && S.mkt === mkt) drawFoList();
    await enrichNews(mkt, good);
    S.scan[mkt].at = Date.now(); store.set('scan', S.scan);
    // alerts on fresh results
    const watched = new Set(S.saved[mkt]);
    for (const r of good) { const R = rateRow(r, mkt); if (R) Alerts.evaluate({ sym: r.sym, mkt, price: r.price, rating: R.rating, action: R.action, setups: r.setups, chartPats: r.chartPats, cross: r.cross, news: newsOf(mkt, r.sym) }, watched.has(r.sym)); }
    Alerts.save(); Alerts.flush();
    const top = rated(good, 'top', mkt)[0];
    if (document.hidden && good.length) Alerts.notifyNow && Alerts.notifyNow('Scan complete', `${good.length} stocks rated${top ? ` · top: ${top.r.sym} ${top.rating}` : ''}`);
    if (!good.length) scanProgress(mkt, 100, 'Could not load data. Check your internet connection.');
  } finally {
    S.scanning = false; Alerts.keepAlive(!!Alerts.prefs().watch, 'Watching your saved stocks');
    if (S.tab === 'scan' && S.mkt === mkt) vScan(); else if (S.tab === 'fno' && S.mkt === mkt) { const f = $('#foProg'); if (f) f.style.display = 'none'; drawFoList(); }
    if (S.tab === 'home' && S.mkt === mkt) render();
  }
}

// ---------- F&O universe (every NSE + BSE F&O underlying) ----------
// S.fo = { SYM: { lot, ex: 'NFO'|'BFO', type: 'stock'|'index', bse?: 1 (also on BSE), bseOnly?: 1 } }
// Sources: nse.json (CI, NSE fo_mktlots) -> overlaid with MS.foUniverse() (mStock script master, daily, authoritative) when logged in.
const FNO_IDX = [['NIFTY', 'Nifty 50'], ['BANKNIFTY', 'Bank Nifty'], ['FINNIFTY', 'Fin Nifty'], ['MIDCPNIFTY', 'Midcap Select'], ['SENSEX', 'Sensex'], ['BANKEX', 'Bankex']];
const istDayStr = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
function buildFo() {
  const fo = {}, n = S.nse || {};
  for (const [s, l] of Object.entries(n.fo || {})) fo[s] = { lot: l || 0, ex: 'NFO', type: 'stock' };
  for (const s of ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']) fo[s] = { lot: (n.idx || {})[s] || 0, ex: 'NFO', type: 'index' };
  for (const s of (n.bidx || ['SENSEX', 'BANKEX', 'SENSEX50'])) fo[s] = { lot: 0, ex: 'BFO', type: 'index' };
  let src = n.seed || !Object.keys(n.fo || {}).length ? null : 'NSE list ' + (n.updated || '');
  const c = store.get('foUni', null);
  if (c && c.u && c.day === istDayStr()) {
    const eq = new Set((n.eq || []).map(x => x[0]));
    for (const [s, v] of Object.entries(c.u)) {
      const e = fo[s];
      if (e) { if (v.lot > 0) e.lot = v.lot; if (v.ex === 'BFO' && e.type === 'stock') e.bse = 1; if (v.ex === 'NFO' && e.ex === 'BFO') e.ex = 'NFO'; }
      else fo[s] = { lot: v.lot || 0, ex: v.ex || 'NFO', type: v.type || 'stock', bseOnly: v.ex === 'BFO' && v.type !== 'index' && !eq.has(s) ? 1 : undefined };
    }
    src = 'mStock live';
  }
  S.fo = fo; S.foSrc = src; return fo;
}
async function refreshFoLive(force) { // true when the universe changed
  if (!(window.MS && MS.ok && MS.ok() && MS.foUniverse)) return false;
  const c = store.get('foUni', null); if (!force && c && c.day === istDayStr()) return false;
  try { const u = await MS.foUniverse(); if (u && Object.keys(u).length > 50) { store.set('foUni', { day: istDayStr(), u }); buildFo(); return true; } } catch (e) {}
  return false;
}
const foStocks = () => Object.keys(S.fo || {}).filter(s => S.fo[s].type === 'stock');
const foScannable = () => foStocks().filter(s => !S.fo[s].bseOnly);

// ---------- F&O screen ----------
function vFno() {
  if (S.mkt === 'US') return vOptUS();
  if (!S.fo) buildFo();
  const sel = store.get('fnoIdx', ['NIFTY', 'BANKNIFTY', 'SENSEX']).filter(s => FNO_IDX.some(x => x[0] === s));
  const st = S.fnoF = S.fnoF || { q: '', sec: '', side: 'all', n: 80 };
  const cat = S.nse.cat || {}, secs = [...new Set(foStocks().map(s => (cat[s] || [])[1]).filter(Boolean))].sort();
  const n = foStocks().length, nb = foStocks().filter(s => S.fo[s].bse || S.fo[s].bseOnly).length;
  const stk = window.topFoCalls ? topFoCalls(10) : [], scAt = S.scan.IN && S.scan.IN.at;
  $('#view').innerHTML = `<h3>⛓ Option chain</h3>
  <div class="chips wrap" id="ocIdx">${FNO_IDX.map(x => `<button data-oc="${x[0]}">${x[1]}</button>`).join('')}</div>
  <h3>Index option calls <a id="optRef">Refresh</a></h3>
  <div class="chips wrap" id="idxSel">${FNO_IDX.map(x => `<button data-i="${x[0]}" class="${sel.includes(x[0]) ? 'on' : ''}">${x[1]}</button>`).join('')}</div>
  <div id="optBox">${sel.map(s => `<div class="card" id="opt_${s}"><span class="spin"></span> ${s}…</div>`).join('')}</div>
  <h3>F&O stock calls <span class="note">${stk.length ? `top ${stk.length} from your scan${scAt ? ' · ' + new Date(scAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}` : ''}</span></h3>
  <div id="stkBox">${stk.length ? stk.map(s => `<div class="card" id="opt_${s}"><span class="spin"></span> ${s}…</div>`).join('') : '<div class="note" style="margin:0 2px 8px">Scan the F&O stocks (button below) to get option calls on the strongest ones.</div>'}</div>
  <p class="note" style="margin:0 2px 6px">Calls use real option-chain premiums (NSE, or mStock live) when available; otherwise premiums are labelled ESTIMATED. Not investment advice. Option buyers can lose 100% of the premium.</p>
  <h3>F&O stocks <span class="note" id="foCnt">${n ? `${n} · NSE${nb ? ' + ' + nb + ' on BSE' : ''}` : ''}</span> <a id="fscan">${n ? 'Scan all F&O' : ''}</a></h3>
  ${n ? `<div class="prog" id="foProg" style="display:${S.scanning ? '' : 'none'}"><div style="width:${S.scanPct || 0}%"></div></div>
  <div class="search" style="margin:0 0 8px"><input id="foQ" placeholder="Search F&O stocks" value="${esc(st.q)}" autocomplete="off"></div>
  <div class="pick2"><label><span>Sector</span><select id="foSec"><option value="">All sectors</option>${secs.map(s => `<option value="${esc(s)}" ${st.sec === s ? 'selected' : ''}>${esc(secName(s))}</option>`).join('')}</select></label>
   <label><span>Show</span><select id="foSide">${[['all', 'All'], ['long', 'Long ideas'], ['short', 'Short ideas']].map(x => `<option value="${x[0]}" ${st.side === x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label></div>
  <div id="foList"></div>`
  : '<div class="warn">F&O list loads in the installed app build. Log in to mStock for the live list.</div>'}`;
  S.optO = {};
  const loadOne = s => indexOption(s).then(o => { S.optO[s] = o; const el = $('#opt_' + s); if (el) el.outerHTML = optCard(o); bindOpt(); }).catch(e => { const el = $('#opt_' + s); if (el) el.innerHTML = `<b>${s}</b><div class="note dn">Could not analyse: ${esc(e.message)}</div>`; });
  const loadOpts = () => store.get('fnoIdx', sel).forEach(loadOne);
  loadOpts(); pool(stk, 2, s => loadOne(s)); $('#optRef').onclick = () => { store.get('fnoIdx', sel).forEach(s => { const el = $('#opt_' + s); if (el) el.innerHTML = '<span class="spin"></span>'; }); loadOpts(); };
  document.querySelectorAll('#idxSel [data-i]').forEach(b => b.onclick = () => {
    const cur_ = store.get('fnoIdx', sel), s = b.dataset.i, on = !cur_.includes(s), next = on ? FNO_IDX.map(x => x[0]).filter(x => x === s || cur_.includes(x)) : cur_.filter(x => x !== s);
    store.set('fnoIdx', next); b.classList.toggle('on', on);
    if (on) { $('#optBox').insertAdjacentHTML('beforeend', `<div class="card" id="opt_${s}"><span class="spin"></span> ${s}…</div>`); loadOne(s); }
    else { const el = $('#opt_' + s); if (el) el.remove(); delete S.optO[s]; }
  });
  if (n) {
    drawFoList();
    const q = $('#foQ'); q.oninput = () => { st.q = q.value.trim(); st.n = 80; drawFoList(); };
    $('#foSec').onchange = e => { st.sec = e.target.value; st.n = 80; drawFoList(); };
    $('#foSide').onchange = e => { st.side = e.target.value; st.n = 80; drawFoList(); };
    $('#fscan').onclick = () => { if (!S.scanning) { S.scanPct = 0; runScan(foScannable()); const p = $('#foProg'); if (p) p.style.display = ''; } };
  }
  refreshFoLive().then(ch => { if (ch && S.tab === 'fno') { buildFo(); drawFoList(); const c = $('#foCnt'); if (c) c.textContent = `${foStocks().length} · NSE + BSE`; } });
  if (marketOpen('IN')) { // live: premiums + spot every 3 s with mStock (same strike kept), chain re-read every 30 s, full re-analysis every 2 min
    let k = 0, busyT = false;
    S.timer = setInterval(async () => {
      if (S.tab !== 'fno' || document.hidden || busyT) return;
      if (++k % 40 === 0) return loadOpts();
      const ms = window.MS && MS.ok(); if (!ms && k % 10) return;
      busyT = true;
      try {
        for (const o of Object.values(S.optO || {})) {
          if (!o.ch || !window.OC || !$('#opt_' + o.sym)) continue;
          if (ms && k % 10) { if (!(await OC.overlay(o.ch, 2))) continue; } else o.ch = await OC.get(o.sym, o.ch.exp);
          const prev = o.call || {}; o.call = OC.buildCall(o, o.ch, Object.assign({}, prev.ctx, { lockK: prev.k })); o.call.ctx = prev.ctx; o.call.expWhy = prev.expWhy;
          const el = $('#opt_' + o.sym); if (el) el.outerHTML = optCard(o);
        }
        bindOpt();
      } catch (e) {} finally { busyT = false; }
    }, 3000);
  }
}
// the searchable, sector-filtered list of every F&O stock: rated ones first (best rating first), then unscanned A-Z
const done0 = items => items.some(x => x.R); // freeze only once ratings exist
function drawFoList() {
  const el = $('#foList'); if (!el) return;
  const st = S.fnoF, U = S.fo || {}, cat = S.nse.cat || {}, sc = S.scan.IN, by = new Map(sc ? sc.rows.map(r => [r.sym, r]) : []), q = st.q.toUpperCase();
  const items = [];
  for (const s of foStocks()) {
    if (st.sec && (cat[s] || [])[1] !== st.sec) continue;
    const nm = nameOf(s); if (q && !s.startsWith(q) && !nm.toUpperCase().includes(q)) continue;
    const r = by.get(s), R = r && !r.err ? rateRow(r, 'IN') : null;
    if (st.side === 'long' && !(R && R.rating >= 58)) continue;
    if (st.side === 'short' && !(R && R.rating <= 42)) continue;
    items.push({ s, nm, r, R });
  }
  items.sort((a, b) => (b.R ? b.R.rating : -1) - (a.R ? a.R.rating : -1) || a.s.localeCompare(b.s));
  if (st.side === 'short') items.reverse();
  // same frozen order as the scanner: opening a stock or a live refresh never moves/drops it (re-sorted by a new scan or filter change)
  { const fk = ['FO', st.sec, st.side, q].join('|'); S.frozen = S.frozen || {}; const fz = S.frozen[fk];
    if (fz && fz.length) { const pos = new Map(fz.map((x, i) => [x, i])), all = new Map(foStocks().map(x => [x, 1]));
      for (const x of fz) if (!items.some(i => i.s === x) && all.has(x)) { const r = by.get(x); items.push({ s: x, nm: nameOf(x), r, R: r && !r.err ? rateRow(r, 'IN') : null }); }
      items.sort((a, b) => (pos.has(a.s) ? pos.get(a.s) : 1e6) - (pos.has(b.s) ? pos.get(b.s) : 1e6)); }
    else if (done0(items)) S.frozen[fk] = items.map(x => x.s); }
  const shown = items.slice(0, st.n), done = items.filter(x => x.R).length;
  const lotTxt = s => U[s].lot ? `Lot ${U[s].lot} · ` : '';
  el.innerHTML = `<div class="note" style="margin:0 2px 8px">${items.length} stocks${done < items.length && !S.scanning ? ` · ${items.length - done} not scanned` : ''}${sc && done ? ` · scan ${new Date(sc.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}${S.foSrc ? ' · ' + esc(S.foSrc) : ''}</div>
  <div class="list">${shown.map((x, k) => { const sub = lotTxt(x.s) + x.nm + (U[x.s].bseOnly ? ' · BSE only' : ''); return x.R ? rowHTML(x.s, sub, x.r.price, x.r.chg, x.R.rating, actLabel(x.R.action), tagsOf(x.r)) : rowHTML(x.s, sub, null, null, null); }).join('') || '<div class="empty">No F&O stock matches.</div>'}</div>
  ${items.length > shown.length ? `<button class="btn w" id="foMore" style="margin-top:10px">Show ${Math.min(80, items.length - shown.length)} more (${items.length - shown.length} left)</button>` : ''}`;
  bindRows(el); el.querySelectorAll('.row[data-sym] .px').forEach(px => px.insertAdjacentHTML('afterend', `<button class="ocb" data-oc="${px.closest('.row').dataset.sym}" title="Option chain">⛓</button>`)); const m = $('#foMore'); if (m) m.onclick = () => { st.n += 80; drawFoList(); };
  if (window.hydrateRows) hydrateRows(el, 12, true);
}

function vOptUS() {
  const sc = S.scan.US, cat = catOf('US'), big = sc ? sc.rows.filter(r => !Object.keys(cat).length || (cat[r.sym] && cat[r.sym][0] === 'L') || window.US_LIST.some(x => x[0] === r.sym)) : [];
  $('#view').innerHTML = `<h3>ETF options · call or put? <a id="optRef">Refresh</a></h3><div id="optBox">${IDX_OPT_US.map(([s]) => `<div class="card" id="opt_${s}"><span class="spin"></span> ${s}…</div>`).join('')}</div>
  <h3>Stock options setups <a id="fscan">${big.length ? 'Rescan' : 'Scan S&P 500'}</a></h3>
  ${big.length ? `<h3>Long ideas (buy stock or calls) · highest rated first</h3><div class="list">${rated(big, 'top', 'US').filter(x => x.rating >= 58).slice(0, 30).map((x, k) => rowHTML(x.r.sym, `100 sh/contract · ${nameOf(x.r.sym, 'US')}`, x.r.price, x.r.chg, x.rating, 'LONG', tagsOf(x.r), k + 1)).join('') || '<div class="empty">No long setups.</div>'}</div>
     <h3>Short ideas (puts or short) · lowest rating first</h3><div class="list">${rated(big, 'sell', 'US').slice(0, 30).map((x, k) => rowHTML(x.r.sym, `100 sh/contract · ${nameOf(x.r.sym, 'US')}`, x.r.price, x.r.chg, x.rating, 'SHORT', tagsOf(x.r), k + 1)).join('') || '<div class="empty">No short setups.</div>'}</div>`
    : '<div class="empty">Scan the S&P 500 to rank stocks for calls (long) and puts (short).</div>'}
  <p class="note">Ratings come from each ETF's intraday + swing signals. One US option contract = 100 shares. Premiums, open interest and IV aren't included, so check the option chain in your broker. Option buyers can lose 100% quickly.</p>`;
  bindRows($('#view'));
  const loadOpts = () => IDX_OPT_US.forEach(([s]) => indexOption(s, 'US').then(o => { const el = $('#opt_' + s); if (el) el.outerHTML = optCard(o); bindOpt(); }).catch(e => { const el = $('#opt_' + s); if (el) el.innerHTML = `<b>${s}</b><div class="note dn">Could not analyse: ${esc(e.message)}</div>`; }));
  loadOpts(); $('#optRef').onclick = () => { IDX_OPT_US.forEach(([s]) => { const el = $('#opt_' + s); if (el) el.innerHTML = '<span class="spin"></span>'; }); loadOpts(); };
  if (marketOpen('US')) S.timer = setInterval(loadOpts, 60000);
  const b = $('#fscan'); if (b) b.onclick = () => { S.uni = { size: hasCat_('US') ? 'L' : 'POP', sector: '' }; store.set('uniBy', S.uniBy); go('scan'); runScan(); };
}

// ---------- index options (NIFTY / BANKNIFTY / SENSEX · SPY / QQQ / IWM) ----------
function mktMins(mkt) { const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: MK[mkt].tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value; return +p.hour * 60 + +p.minute; }
function istMins() { const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value; return +p.hour * 60 + +p.minute; }
async function indexOption(sym, mkt = 'IN') {
  const ys = ySym(sym, mkt), open = marketOpen(mkt), mins = mktMins(mkt), US = mkt === 'US';
  const T = US ? { late: 900, itm: 840, otm: 810 } : { late: 870, itm: 810, otm: 780 }; // ET: 3:00/2:00/1:30 PM · IST: 2:30/1:30/1:00 PM
  const useMS = !US && window.MS && MS.ok();
  const [d, it0, live] = await Promise.all([chart(ys, '2y', '1d'), chart(ys, '5d', '5m').catch(() => null), useMS ? MS.index(sym).catch(e => ({ err: e.message })) : null]);
  let it = it0, price = d.meta.regularMarketPrice, srcLbl = 'Yahoo (can lag)';
  if (live && !live.err) {
    const ov = MS.overlay(d.D, { last_price: live.price, ohlc: { open: live.open, high: live.high, low: live.low, close: live.prev } }); price = live.price; srcLbl = 'mStock live';
    if (ov && ov.prev) live.prev = ov.prev; // guarded previous close (mStock may switch ohlc.close to today's close after 15:30)
    if (open && live.key.tok) { try { const D5 = await MS.candles(sym, '5minute', 5); if (D5.c.length > 20) { D5.c[D5.c.length - 1] = live.price; it = { D: D5 }; srcLbl = 'mStock live · mStock 5-min bars'; } } catch (e) {} }
  }
  const A = Engine.analyze(d.D, { intra: open && it ? it.D : null, tick: US ? 0.01 : 0.05, canShort: true, backtest: true, price, fnoSym: sym, lot: foLot(sym, mkt) });
  if (A.err) throw new Error(A.err);
  if (live && !live.err && live.prev) A.chg = (live.price / live.prev - 1) * 100;
  const row = Object.assign({ sym }, rowFromA(A)), ctx = { regime: 50, news: 0, canShort: true };
  const ri = Engine.hzRating(row.intraday, 'intraday', ctx), rs = Engine.hzRating(row.swing, 'swing', ctx);
  const wI = open ? 0.6 : 0.3, bull = Math.round(wI * ri.rating + (1 - wI) * rs.rating);
  const late = open && mins >= T.late; // last hour: time decay hurts fresh option buys
  let ce = bull, pe = 100 - bull; if (late) { ce = Math.max(0, ce - 10); pe = Math.max(0, pe - 10); }
  const side = ce >= 65 ? 'CE' : pe >= 65 ? 'PE' : null, step = Engine.strikeStep(sym, A.price), atm = Math.round(A.price / step) * step;
  const H = A.horizons, dirN = side === 'CE' ? 1 : -1, src = open && H.intraday.levels && H.intraday.dir === dirN ? H.intraday : H.swing;
  const L = side && src.levels && src.dir === dirN ? src.levels : null;
  // three strikes: safer (1 ITM), balanced (ATM), aggressive (1 OTM)
  const strikes = side ? [['ITM', 'Safer', atm - dirN * step, 0.62], ['ATM', 'Balanced', atm, 0.5], ['OTM', 'Aggressive', atm + dirN * step, 0.4]] : [];
  const o = { sym, mkt, A, ce, pe, side, atm, step, L, late, open, why: (open ? H.intraday : H.swing).why, hzUsed: src.label, hzKey: src === H.intraday ? 'intraday' : 'swing', hzLabel: src.label, strikes, dataSrc: srcLbl, prev: live && !live.err ? live.prev : null, idxKey: live && !live.err ? live.key.k : null, liveErr: live && live.err };
  if (!US && window.OC) { // India: professional call from the real option chain (optchain.js); old guessed-delta premiums removed
    try { const r = await OC.callFor(o); o.call = r.call; o.ch = r.ch; } catch (e) { o.callErr = e.message; }
  } else if (useMS && side) { // exact contracts + live premiums from mStock
    try {
      const cs = await Promise.all(strikes.map(s => MS.option(sym, s[2], side))), q = await MS.ltp(cs.filter(Boolean).map(c => c.k));
      o.live = cs.map(c => c && { k: c.k, ts: c.ts, exp: c.exp, lot: c.lot, strike: c.strike, prem: q[c.k] != null ? q[c.k] : null });
      o.exp = (cs.find(Boolean) || {}).exp; o.liveAt = Date.now();
      if (!cs.some(Boolean)) o.premErr = 'mStock has no ' + sym + ' option contracts listed for these strikes';
    } catch (e) { o.premErr = e.message; }
  }
  // which strike to buy
  const conv = side ? Math.max(ce, pe) : 0, today = new Date().toISOString().slice(0, 10), expiryDay = o.exp && o.exp === today;
  let pick = 1, reason = 'Balanced: ATM has the best mix of cost and sensitivity (delta ≈ 0.5).';
  if (late || expiryDay || (open && mins >= T.itm)) { pick = 0; reason = expiryDay ? 'Expiry day: time value melts fast, so the in-the-money strike holds value better.' : 'Late session: in-the-money loses less to time decay.'; }
  else if (conv >= 78 && (!open || mins < T.otm) && L && (dirN > 0 ? L.t1 >= strikes[2][2] : L.t1 <= strikes[2][2])) { pick = 2; reason = `Strong signal (${conv}) and Target 1 lies beyond ${fmt(strikes[2][2], 0)}: a cheaper out-of-the-money strike gives more upside.`; }
  o.pick = pick; o.pickReason = reason;
  return o;
}
function optCard(o) { // India → professional call card (ui-options.js); US ETFs keep the simple card
  if (o.mkt !== 'US' && window.callCardHTML) return callCardHTML(o);
  const A = o.A, US = o.mkt === 'US', name = { NIFTY: 'Nifty 50', BANKNIFTY: 'Bank Nifty', FINNIFTY: 'Fin Nifty', MIDCPNIFTY: 'Midcap Select', SENSEX: 'Sensex', BANKEX: 'Bankex', SPY: 'SPY · S&P 500', QQQ: 'QQQ · Nasdaq-100', IWM: 'IWM · Russell 2000' }[o.sym] || o.sym;
  const SN = s => US ? (s === 'CE' ? 'CALL' : 'PUT') : s, cur$ = US ? '$' : '₹';
  const L = o.L, s = o.side ? o.strikes[o.pick] : null, lv = o.live && o.live[o.pick];
  const lot = (lv && lv.lot) || foLot(o.sym, o.mkt);
  const premAt = (prem, delta, x) => prem && L ? Math.max(0.05, prem + delta * (x - L.entry) * (o.side === 'CE' ? 1 : -1)) : null;
  const buyLine = s ? `BUY ${o.sym} ${fmt(s[2], s[2] % 1 ? 1 : 0)} ${SN(o.side)}` : 'NO TRADE';
  return `<div class="card opt" id="opt_${o.sym}"><div class="ohead"><div><b>${name}</b> <span class="mu">${fmt(A.price)} ${pct(A.chg)}</span></div>${!US ? `<span class="${o.dataSrc && o.dataSrc.startsWith('mStock') ? 'livepill' : 'note wa'}" style="margin-left:auto">${o.dataSrc && o.dataSrc.startsWith('mStock') ? 'mStock ' + new Date(o.tickAt || o.liveAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Yahoo · may lag'}</span>` : ''}</div>
   ${o.liveErr ? `<div class="note dn">mStock index quote failed: ${esc(o.liveErr)}. Showing Yahoo.</div>` : ''}
   <div class="buyline ${o.side === 'CE' ? 'b1' : o.side === 'PE' ? 'b-1' : 'b0'}"><b>${buyLine}</b><span>${s ? (o.exp || lv && lv.exp ? 'Expiry ' + (o.exp || lv.exp) : US ? 'Nearest expiry (SPY/QQQ/IWM have frequent expiries)' : 'Nearest expiry') + (lot ? (US ? ' · 1 contract = 100 shares' : ' · lot ' + lot) : '') : 'Neither side is rated 65+'}</span></div>
   <div class="cp"><div class="${o.side === 'CE' ? 'on' : ''}"><span>${US ? 'CALL' : 'CALL (CE)'}</span><b class="${o.ce >= 65 ? 'up' : o.ce <= 40 ? 'dn' : 'wa'}">${o.ce}</b><small>${o.ce >= 65 ? 'Buy' : 'Don\'t buy'}</small></div><div class="${o.side === 'PE' ? 'on' : ''}"><span>${US ? 'PUT' : 'PUT (PE)'}</span><b class="${o.pe >= 65 ? 'up' : o.pe <= 40 ? 'dn' : 'wa'}">${o.pe}</b><small>${o.pe >= 65 ? 'Buy' : 'Don\'t buy'}</small></div></div>
   ${s ? `<table class="stk"><tr><th>Strike</th><th>Style</th><th>${o.live ? 'Premium' : 'Delta'}</th><th>${o.live ? 'SL → T1' : ''}</th></tr>
     ${o.strikes.map((x, k) => { const lvk = o.live && o.live[k], pr = lvk && lvk.prem; return `<tr class="${k === o.pick ? 'pick' : ''}"><td><b>${fmt(x[2], x[2] % 1 ? 1 : 0)} ${SN(o.side)}</b>${k === o.pick ? ' ✓' : ''}</td><td>${x[1]} <span class="mu">${x[0]}</span></td><td>${o.live ? (pr ? '₹' + fmt(pr) : '–') : '≈' + x[3]}</td><td>${pr && L ? `₹${fmt(premAt(pr, x[3], L.stop))} → ₹${fmt(premAt(pr, x[3], L.t1))}` : ''}</td></tr>`; }).join('')}</table>
     <div class="note" style="margin-top:6px">✓ ${esc(o.pickReason)}</div>
     ${L ? `<div class="lv3" style="margin-top:6px"><span>${o.sym} entry <b>${fmt(L.entry)}</b></span><span>SL <b class="dn">${fmt(L.stop)}</b></span><span>T1 <b class="up">${fmt(L.t1)}</b></span><span>T2 <b class="up">${fmt(L.t2)}</b></span></div><div class="note">Exit the option when ${o.sym} hits these levels (${esc(o.hzUsed.toLowerCase())} plan).${o.live ? ' Premium SL/T1 ≈ index move × delta.' : ''}</div>` : ''}
     ${!o.live ? `<div class="note">${US ? 'Check the premium and expiry in your broker before buying.' : o.premErr ? 'mStock premium error: ' + esc(o.premErr) : 'Connect mStock (⚙️) for exact contracts, expiry and live premiums.'}</div>` : ''}`
   : `<div class="sub" style="margin-top:8px">Buying options without an edge loses to time decay, so wait for 65+ on one side.</div>`}
   ${o.late ? `<div class="warn" style="margin:8px 0 0">Last hour of trading (after ${US ? '3:00 PM ET' : '2:30 PM'}): theta decay is fastest, so ratings are cut by 10. Prefer no fresh option buys.</div>` : ''}
   ${!o.open ? `<div class="note" style="margin-top:6px">Market closed: this is the plan for the next session (mostly from the daily trend). Re-check ${US ? '15 minutes after the US open' : 'after 9:30 AM'}.</div>` : ''}
   <ul class="why">${o.why.slice(0, 4).map(w => `<li>${w.w > 0 ? '<span class="up">▲</span>' : '<span class="dn">▼</span>'} ${esc(w.t)}</li>`).join('')}</ul>
   <a class="note optOpen" data-sym="${o.sym}">Full analysis & live chart ›</a></div>`;
}
function bindOpt() { document.querySelectorAll('.optOpen').forEach(a => a.onclick = () => openDetail(a.dataset.sym, 'intraday')); }

// ---------- saved ----------
function vSaved() {
  const L = S.saved[S.mkt];
  $('#view').innerHTML = L.length ? `<div class="card" id="wbeta" data-help="wbeta"><span class="spin"></span> Measuring watchlist risk…</div><div class="list" id="svl">${L.map(s => rowHTML(s, nameOf(s), null, null, null)).join('')}</div>` : '<div class="empty">Nothing saved yet. Open any stock and tap ☆.</div>';
  bindRows($('#view'));
  const mkt = S.mkt;
  const got = {}; S.wrisk = {};
  regime(mkt).then(() => msQuotes(L, mkt)).then(Q => pool(L, 4, async sym => {
    const q = await dailyQuick(sym, mkt, Q);
    const row = document.querySelector(`#svl .row[data-sym="${CSS.escape(sym)}"]`);
    const R = rateRow(Object.assign({ sym }, q), mkt);
    if (R) { Alerts.evaluate({ sym, mkt, price: q.price, rating: R.rating, action: R.action, setups: q.setups, chartPats: q.chartPats, cross: q.cross, news: newsOf(mkt, sym) }, true); upsertRow(mkt, Object.assign({ sym }, q)); }
    if (q.risk) S.wrisk[sym] = q.risk;
    if (row && R) { got[sym] = R.rating; row.outerHTML = rowHTML(sym, nameOf(sym), q.price, q.chg, R.rating, actLabel(R.action), tagsOf(q)); bindRows($('#svl')); }
  })).then(() => { const box = $('#svl'); if (!box || S.tab !== 'saved') return; [...box.children].sort((a, b) => (got[b.dataset.sym] ?? -1) - (got[a.dataset.sym] ?? -1)).forEach(n => box.appendChild(n)); Alerts.save(); Alerts.flush();
    const W = Object.values(S.wrisk), wb = $('#wbeta'); if (!wb) return;
    if (!W.length) { wb.innerHTML = '<span class="note">Not enough history to measure watchlist beta.</span>'; return; }
    const b = W.reduce((x, k) => x + k.beta, 0) / W.length, a = W.reduce((x, k) => x + k.alpha, 0) / W.length, lead = W.filter(k => Engine.riskLabel(k).leader).length, idx = mkt === 'IN' ? 'Nifty' : 'S&P 500';
    wb.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div><div class="note">Watchlist beta <span class="qm">ⓘ</span></div><b style="font-size:22px" class="${b >= 1.25 ? 'dn' : b <= 0.85 ? 'up' : 'wa'}">${b.toFixed(2)}×</b> <span class="mu">${idx}</span></div><div style="text-align:right"><div class="note">Avg alpha</div><b class="${a >= 0 ? 'up' : 'dn'}">${a >= 0 ? '+' : ''}${a.toFixed(1)}%/yr</b><div class="note">${lead}/${W.length} leaders</div></div></div>
      <div class="note" style="margin-top:6px">If ${idx} falls 2%, your saved stocks tend to fall about ${(2 * b).toFixed(1)}%.${b >= 1.25 ? ' That is aggressive: add some low-beta names to balance it.' : ''}</div>`; });
}

// ---------- broker (mStock) ----------
function covHTML(list) {
  const C = MS.cov || { ok: {}, miss: {} }, ok = Object.keys(C.ok), miss = Object.keys(C.miss).filter(s => !C.ok[s]);
  if (list) { const got = list.filter(s => C.ok[s] && Date.now() - C.ok[s] < 60e3), bad = list.filter(s => !got.includes(s));
    return `<b class="${bad.length ? 'wa' : 'up'}">${got.length} of ${list.length} live from mStock</b>${bad.length ? `<br>No mStock price for: ${bad.map(esc).join(', ')} (these use Yahoo)${bad.some(x => (C.why || {})[x]) ? `<br><span class="mu">mStock said: ${esc((C.why || {})[bad.find(x => (C.why || {})[x])])}</span>` : ''}` : '<br>Every one returned a live mStock price.'}`; }
  if (!ok.length && !miss.length) return 'No prices fetched yet in this session. Run a scan or tap the check below.';
  return `This session: <b class="up">${ok.length} stocks priced live by mStock</b>${miss.length ? ` · <b class="wa">${miss.length} fell back to Yahoo</b>: ${miss.slice(0, 15).map(esc).join(', ')}${miss.length > 15 ? '…' : ''}` : ' · none fell back to Yahoo'}.<br>In lists, a <span class="up">●</span> after a price = mStock live, <span class="wa">●</span> = Yahoo.`;
}
function vBroker() {
  const c = MS.cfg(), ok = MS.ok(), T = !!c.totp, tail = c.apiKey ? '…' + c.apiKey.slice(-4) : '';
  $('#view').innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">mStock live data</div><div class="f">Mirae Asset · Type A API</div></div></div>
  <div class="card"><div style="display:flex;align-items:center;gap:10px"><span class="live ${ok ? 'on' : ''}"><i></i><span></span></span><b>${esc(MS.status())}</b></div>
  <p class="note" style="margin:8px 0 0">${ok ? 'India prices, candles and scans now use mStock live data. Yahoo is the fallback.' : 'Log in once per trading day. mStock sessions expire daily.'}</p></div>
  <div class="card"><h3 style="margin-top:0">1 · API key <span class="note">${c.apiKey ? `saved ${esc(tail)}` : 'not saved'}</span></h3>
   <div style="display:flex;gap:6px"><input id="apik" type="password" placeholder="Paste your Type A API key" value="${esc(c.apiKey)}" class="inp" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:1"><button class="btn sm g" id="showK" type="button">👁</button></div>
   <details style="margin-top:6px"><summary class="note">Advanced</summary><input id="cks" placeholder="checksum" value="${esc(c.checksum || 'L')}" class="inp"><p class="note">mStock's docs use "L" as the checksum. Change it only if mStock support tells you to.</p></details>
   <button class="btn g w" id="saveK" style="margin-top:8px">Save key on this phone</button></div>
  <div class="card"><h3 style="margin-top:0">2 · How do you verify login?</h3>
   <div class="chips" id="vmode"><button class="chip ${T ? '' : 'on'}" data-v="otp">📱 SMS OTP</button><button class="chip ${T ? 'on' : ''}" data-v="totp">🔐 Authenticator (TOTP)</button></div>
   ${T ? `<details class="note" style="margin-top:6px"><summary>First time? Set up the authenticator</summary><ol style="margin:6px 0 0 18px;padding:0;line-height:1.5">
     <li>Open <b>trade.mstock.com</b> in Chrome (Desktop site on) and log in.</li><li>☰ menu → <b>Trading APIs</b> → <b>Enable TOTP</b>.</li>
     <li>Scan the QR with Google Authenticator / Microsoft Authenticator. A new "mStock" entry appears.</li>
     <li>Use <b>that</b> 6-digit code below. Phone time must be set to automatic.</li></ol></details>` : ''}</div>
  <div class="card"><h3 style="margin-top:0">3 · Log in</h3>
   <input id="usr" placeholder="mStock client ID" value="${esc(c.user || '')}" class="inp" autocomplete="username" autocapitalize="characters" spellcheck="false">
   <input id="pwd" type="password" placeholder="Password${T ? ' (only if asked)' : ''} · never saved" class="inp" autocomplete="current-password">
   ${T ? `<input id="otp" inputmode="numeric" maxlength="6" placeholder="6-digit authenticator code" class="inp" autocomplete="one-time-code">
   <button class="btn w" id="doTotp">Connect</button>` : `<button class="btn w" id="doLogin">Log in & send OTP</button>
   <div id="otpBox" style="display:none;margin-top:10px"><input id="otp" inputmode="numeric" maxlength="6" placeholder="OTP from SMS" class="inp" autocomplete="one-time-code"><button class="btn w" id="doOtp">Verify</button></div>`}
   <div id="bmsg" class="note" style="margin-top:8px"></div></div>
  ${ok ? '<div class="card"><button class="btn g w" id="testQ">Test: fetch RELIANCE live price</button><div id="tmsg" class="note" style="margin-top:8px"></div></div>' : ''}
  ${ok ? `<div class="card"><h3 style="margin-top:0">Live price coverage</h3><div id="covBox" class="note">${covHTML()}</div><button class="btn g w" id="covGo" style="margin-top:8px">Check 25 popular stocks + indices now</button></div>` : ''}
  <div class="card"><details><summary class="note">Diagnostics</summary><div class="note" id="diag" style="margin-top:6px">${MS.lastCall ? `Last call: ${esc(MS.lastCall.path)} · HTTP ${MS.lastCall.status} · ${esc(MS.lastCall.note)} · ${esc(MS.lastCall.at)}` : 'No calls yet.'}<br>Last quote reply: <code style="word-break:break-all">${esc(MS.lastRaw || '–')}</code><br>Native HTTP: ${window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() ? 'yes' : 'no (browser)'} · Key length: ${c.apiKey ? c.apiKey.length : 0} · PIN vault: ${Sec.hasPin() ? (Sec.isUnlocked() ? 'unlocked' : 'locked') : 'off'}</div></details>
   <button class="btn g w" id="lout" style="margin-top:8px">Log out</button><button class="btn g w" id="forget" style="margin-top:8px;color:var(--dn)">Remove key & data from this phone</button></div>
  <div class="warn">🔒 Your key and the day's session token stay inside this app on this phone. ${Sec.hasPin() ? 'They are encrypted with your app PIN (AES-256).' : '<b>Set an app PIN in Settings to encrypt them.</b>'} The password is never stored and nothing is uploaded. Never share the key or codes with anyone.</div>`;
  $('#back').onclick = back;
  const msg = (t, bad) => { $('#bmsg').innerHTML = `<span class="${bad ? 'dn' : 'up'}">${esc(t)}</span>`; const d = $('#diag'); if (d && MS.lastCall) d.firstChild.textContent = `Last call: ${MS.lastCall.path} · HTTP ${MS.lastCall.status} · ${MS.lastCall.note} · ${MS.lastCall.at}`; };
  const clean = v => (v || '').replace(/\s+/g, '');
  const saveCfg = () => { const n = { apiKey: clean($('#apik').value), user: $('#usr').value.trim().toUpperCase(), checksum: ($('#cks').value || 'L').trim(), totp: MS.cfg().totp }; MS.saveCfg(n); return n; };
  const stored = n => MS.cfg().apiKey === n.apiKey;
  $('#showK').onclick = () => { const i = $('#apik'); i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#saveK').onclick = () => { const n = saveCfg(); if (!n.apiKey) return msg('Paste your API key first.', true); msg(stored(n) ? `Key saved (${n.apiKey.length} characters, ends …${n.apiKey.slice(-4)}).` : 'Could not save: unlock the app with your PIN and try again.', !stored(n)); };
  document.querySelectorAll('#vmode .chip').forEach(b => b.onclick = () => { const n = saveCfg(); n.totp = b.dataset.v === 'totp'; MS.saveCfg(n); vBroker(); });
  const need = n => { if (!n.apiKey) return 'Paste and save your API key (step 1).'; if (!stored(n)) return 'Key not saved: unlock the app with your PIN.'; if (!n.user) return 'Enter your mStock client ID.'; return ''; };
  const busy = (b, on, label) => { b.disabled = on; b.innerHTML = on ? '<span class="spin"></span>' : label; };
  const done = () => { msg('Connected. Live mStock data is on.'); toast('mStock connected'); setTimeout(vBroker, 800); };
  if (T) $('#doTotp').onclick = async () => {
    const n = saveCfg(), e = need(n); if (e) return msg(e, true);
    const code = $('#otp').value.replace(/\D/g, ''); if (code.length !== 6) return msg('Enter the 6-digit code from your authenticator.', true);
    const b = $('#doTotp'); busy(b, true);
    try { await MS.connectTotp(n.user, $('#pwd').value, code); $('#pwd').value = ''; done(); }
    catch (err) { msg(err.message, true); }
    busy(b, false, 'Connect');
  };
  else {
    $('#doLogin').onclick = async () => {
      const n = saveCfg(), e = need(n) || (!$('#pwd').value ? 'Enter your password.' : ''); if (e) return msg(e, true);
      const b = $('#doLogin'); busy(b, true);
      try { await MS.login(n.user, $('#pwd').value); $('#pwd').value = ''; $('#otpBox').style.display = ''; msg('OTP sent to your registered mobile.'); $('#otp').focus(); }
      catch (err) { msg(err.message, true); }
      busy(b, false, 'Log in & send OTP');
    };
    $('#doOtp').onclick = async () => {
      const code = $('#otp').value.trim(); if (!code) return;
      const b = $('#doOtp'); busy(b, true);
      try { await MS.verifyOtp(code); done(); } catch (err) { msg(err.message, true); }
      busy(b, false, 'Verify');
    };
  }
  const tq = $('#testQ'); if (tq) tq.onclick = async () => {
    $('#tmsg').innerHTML = '<span class="spin"></span>';
    try { const q = await MS.quotes(['RELIANCE']); const r = q.RELIANCE; $('#tmsg').innerHTML = r ? `<span class="up">RELIANCE ₹${fmt(r.last_price)} (prev close ${r.ohlc && r.ohlc.close ? fmt(r.ohlc.close) : '–'})</span>` : `<span class="wa">Connected, but mStock's reply had no price I could read. Reply: <code style="word-break:break-all">${esc(MS.lastRaw || '(empty)')}</code></span>`; }
    catch (e) { $('#tmsg').innerHTML = `<span class="dn">${esc(e.message)}</span>`; }
  };
  const cg = $('#covGo'); if (cg) cg.onclick = async () => {
    cg.disabled = true; cg.innerHTML = '<span class="spin"></span>';
    const L = [...(S.nse.pop || SEED_IN.map(x => x[0])).slice(0, 25), 'NIFTY', 'BANKNIFTY', 'SENSEX'];
    try { await MS.quotes(L); } catch (e) { toast(e.message); }
    $('#covBox').innerHTML = covHTML(L); cg.disabled = false; cg.textContent = 'Check again';
  };
  $('#lout').onclick = () => { MS.logout(); vBroker(); };
  $('#forget').onclick = () => { if (confirm('Remove your mStock key and session from this phone?')) { MS.forget(); vBroker(); } };
  setLive();
}

// ---------- settings ----------
function vSettings() {
  const P = Alerts.prefs(), pin = Sec.hasPin(), secure = store.get('secure', false), al = store.get('autolock', 60);
  $('#view').innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">Settings</div></div></div>
  <h3>Live data</h3><div class="list"><div class="row" id="goBroker"><div class="nm"><div class="s">🔌 mStock (Mirae Asset)</div><div class="f">${esc(MS.status())}</div></div><div class="px">›</div></div></div>
  <h3>Security</h3><div class="card">
   <div class="srow"><div><b>App PIN</b><div class="note">${pin ? 'On' : 'Off'}</div></div><button class="btn sm ${pin ? 'g' : ''}" id="pinBtn">${pin ? 'Change' : 'Set PIN'}</button></div>
   ${pin ? `<div class="srow"><div><b>Auto-lock</b><div class="note">Lock after background time</div></div><select id="autolock">${[[0, 'Immediately'], [60, '1 min'], [300, '5 min'], [1800, '30 min']].map(x => `<option value="${x[0]}" ${al == x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></div>
   <div class="srow"><div><b>Remove PIN</b></div><button class="btn sm g" id="pinOff">Remove</button></div>` : ''}
   <div class="srow"><div><b>Hide in Recents & block screenshots</b></div><input type="checkbox" class="tg" id="secure" ${secure ? 'checked' : ''}></div>
   <div class="srow"><div><b>Erase everything on this phone</b></div><button class="btn sm g" id="wipe" style="color:var(--dn)">Erase</button></div></div>
  <h3>Alerts</h3><div class="card">
   <div class="srow"><div><b>Phone notifications</b></div><input type="checkbox" class="tg" id="notify" ${P.notify ? 'checked' : ''}></div>
   <div class="srow"><div><b>Background watch</b><div class="note">Checks saved stocks every 5 min while the app is in Recents</div></div><input type="checkbox" class="tg" id="watch" ${P.watch ? 'checked' : ''}></div>
   <div class="srow"><div><b>Alert on non-saved stocks at rating</b></div><select id="strong">${[70, 75, 80, 85].map(x => `<option ${P.strong == x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
  <h3>Scanner</h3><div class="card">
   <div class="srow"><div><b>Skip illiquid stocks</b><div class="note">Daily value traded below</div></div><select id="liq">${(S.mkt === 'IN' ? [[0, 'Off'], [1e6, '₹10 lakh'], [1e7, '₹1 Cr'], [5e7, '₹5 Cr'], [1e8, '₹10 Cr']] : [[0, 'Off'], [1e6, '$1M'], [5e6, '$5M'], [2e7, '$20M']]).map(x => `<option value="${x[0]}" ${S.minTurnover[S.mkt] == x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></div></div>
  <h3>Position sizing & risk</h3><div class="card">
   <div class="srow"><div><b>Trading capital</b></div><input id="cap" class="inp" style="width:130px;margin:0" inputmode="numeric" value="${S.sizing.capital}"></div>
   <div class="srow"><div><b>Risk per trade</b><div class="note">% of capital</div></div><select id="rpct">${[0.25, 0.5, 1, 1.5, 2].map(x => `<option ${S.sizing.riskPct == x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
   <div class="srow"><div><b>Risk-free rate (${S.mkt === 'IN' ? 'India' : 'US'})</b><div class="note">% per year</div></div><input id="rf" class="inp" style="width:80px;margin:0" inputmode="decimal" value="${S.rf[S.mkt]}"></div></div>
  <h3>App</h3><div class="list"><div class="row" id="goUpd"><div class="nm"><div class="s">⬆️ App updates</div><div class="f" id="updF">Checking…</div></div><div class="px">›</div></div></div>
  <h3>Tools</h3><div class="list"><div class="row" id="goAI"><div class="nm"><div class="s">🧠 Self-learning</div><div class="f">How accurate each score band really is · what the app learned</div></div><div class="px">›</div></div><div class="row" id="goLearn"><div class="nm"><div class="s">📘 Alpha, beta & risk explained</div><div class="f">What each number means and where the app uses it</div></div><div class="px">›</div></div><div class="row" id="goDesk"><div class="nm"><div class="s">🧪 ORB Desk</div><div class="f">Opening-range breakout + 10,000-replay Time Machine</div></div><div class="px">›</div></div></div>
  <p class="note">DayTrader Desk · analysis only, never places orders. Not investment advice.</p>`;
  $('#back').onclick = back; $('#goBroker').onclick = () => go('broker'); $('#goDesk').onclick = () => { location.href = 'desk.html'; }; $('#goLearn').onclick = () => go('learn'); $('#goAI').onclick = () => go('ai');
  if (window.Updater) { const show = () => { const u = Updater.available(), c = Updater.current(), f = $('#updF'); if (f) f.innerHTML = u ? `<span class="up">Build ${u.build} available · tap to update</span>` : `You're on build ${c.build || '?'}${c.signed ? '' : ' · <span class="wa">needs one last reinstall to enable updates</span>'}`; };
    Updater.check().then(show); $('#goUpd').onclick = async () => { $('#updF').textContent = 'Checking…'; await Updater.check(true); show(); if (Updater.available()) Updater.install(); else toast('You have the latest build'); }; }
  $('#cap').onchange = e => { S.sizing.capital = Math.max(0, +e.target.value || 0); store.set('sizingBy', S.sizingBy); };
  $('#rpct').onchange = e => { S.sizing.riskPct = +e.target.value; store.set('sizingBy', S.sizingBy); };
  $('#rf').onchange = e => { const v = +e.target.value; if (isFinite(v) && v >= 0 && v < 20) { S.rf[S.mkt] = v; store.set('rf', S.rf); } };
  $('#pinBtn').onclick = async () => { const p1 = await pinPad(pin ? 'New PIN (4–8 digits)' : 'Choose a PIN (4–8 digits)'); if (!p1) return; const p2 = await pinPad('Enter it again'); if (p1 !== p2) return toast('PINs did not match.');
    if (pin) { const old = await pinPad('Current PIN'); if (!old) return; try { await Sec.unlock(old); } catch (e) { return toast(e.message); } }
    try { await Sec.setPin(p1); store.set('pinLen', p1.length); toast('PIN set. Your mStock key is now encrypted.'); } catch (e) { toast(e.message); } vSettings(); };
  const po = $('#pinOff'); if (po) po.onclick = async () => { const p = await pinPad('Current PIN'); if (!p) return; try { await Sec.removePin(p); toast('PIN removed.'); } catch (e) { toast(e.message); } vSettings(); };
  const alx = $('#autolock'); if (alx) alx.onchange = () => store.set('autolock', +alx.value);
  $('#secure').onchange = e => { store.set('secure', e.target.checked); Alerts.setSecure(e.target.checked); };
  $('#wipe').onclick = () => { if (confirm('Erase all app data on this phone? This cannot be undone.')) { MS.logout(); Sec.wipeAll(); location.reload(); } };
  $('#notify').onchange = async e => { Alerts.setPrefs({ notify: e.target.checked }); if (e.target.checked && !(await Alerts.requestPermission())) toast('Allow notifications for DayTrader Desk in Android settings.'); };
  $('#watch').onchange = async e => { Alerts.setPrefs({ watch: e.target.checked }); if (e.target.checked) { await Alerts.requestPermission(); startWatch(); toast('Background watch on.'); } else stopWatch(); };
  $('#strong').onchange = e => Alerts.setPrefs({ strong: +e.target.value });
  $('#liq').onchange = e => { S.minTurnover[S.mkt] = +e.target.value; store.set('minTurnover', S.minTurnover); };
}
// ---------- alerts ----------
function vAlerts() {
  const L = Alerts.list();
  $('#view').innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">Alerts</div><div class="f">${Alerts.prefs().watch ? '● Background watch on' : 'Background watch off · turn on in Settings'}</div></div>${L.length ? '<button class="btn sm g" id="aclr">Clear</button>' : ''}</div>
  ${L.length ? `<div class="list">${L.map(a => `<div class="row" data-asym="${esc(a.sym)}" data-amkt="${a.mkt}"><div class="aic ${a.read ? '' : 'new'}">${/down|news/.test(a.kind) && /negative|downgraded|below/.test(a.title) ? '🔻' : a.kind.startsWith('p') ? '⏰' : a.kind.startsWith('x') ? '✂️' : a.kind.startsWith('set') ? '🧭' : a.kind === 'news' ? '📰' : '⭐'}</div><div class="nm"><div class="s" style="font-size:14px">${esc(a.title)}</div><div class="f" style="white-space:normal">${esc(a.body)}</div></div><div class="px note">${ago(a.t)}</div></div>`).join('')}</div>`
    : '<div class="empty">No alerts yet.<br>They appear after scans, on saved stocks and when price alerts hit.</div>'}`;
  $('#back').onclick = back; const c = $('#aclr'); if (c) c.onclick = () => { Alerts.clear(); vAlerts(); };
  document.querySelectorAll('[data-asym]').forEach(r => r.onclick = () => { S.mkt = r.dataset.amkt; store.set('mkt', S.mkt); openDetail(r.dataset.asym); });
  Alerts.markRead();
}
function updBell() { const b = $('#bell'); if (!b) return; const n = Alerts.unread(), prev = +(b.dataset.c || 0); b.dataset.n = n > 99 ? '99+' : n || ''; b.dataset.c = n; b.title = n ? `${n} new alert${n > 1 ? 's' : ''}` : 'Alerts'; if (n > prev) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); } }
function toast(msg) { let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.className = 'show'; clearTimeout(t._h); t._h = setTimeout(() => t.className = '', 3200); }
function pinPad(title, lockMode) {
  return new Promise(res => {
    const o = document.createElement('div'); o.className = 'lock'; let v = '';
    o.innerHTML = `<div class="lk"><div class="lkt">🔒</div><div class="lkh">${esc(title)}</div><div class="dots" id="dots"></div><div class="lkm" id="lkm"></div>
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, lockMode ? '' : '✕', 0, '⌫'].map(k => `<button data-k="${k}" ${k === '' ? 'style="visibility:hidden"' : ''}>${k}</button>`).join('')}</div>${lockMode ? '' : '<button class="btn w" id="pinOk">OK</button>'}</div>`;
    document.body.appendChild(o);
    const draw = () => { o.querySelector('#dots').innerHTML = Array.from({ length: lockMode ? (store.get('pinLen', 0) || 4) : Math.max(4, v.length) }, (_, i) => `<i class="${i < v.length ? 'f' : ''}"></i>`).join(''); };
    const done = val => { o.remove(); res(val); };
    o.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
      const k = b.dataset.k; if (k === '✕') return done(null); if (k === '⌫') v = v.slice(0, -1); else if (v.length < 8) v += k; draw();
      if (lockMode && v.length === (store.get('pinLen', 0) || 4)) { try { await Sec.unlock(v); done(v); } catch (e) { o.querySelector('#lkm').textContent = e.message; v = ''; draw(); } }
    });
    const ok = o.querySelector('#pinOk'); if (ok) ok.onclick = () => /^\d{4,8}$/.test(v) ? done(v) : (o.querySelector('#lkm').textContent = 'Use 4–8 digits');
    o._close = () => done(null); draw();
  });
}
async function lockScreen() { if (!Sec.hasPin() || document.querySelector('.lock')) return; Sec.lock(); await pinPad('Enter your PIN', true); render(); }
// ---------- background watch ----------
let watchTimer = null;
function startWatch() { stopWatch(true); Alerts.keepAlive(true, 'Watching your saved stocks'); watchTimer = setInterval(watchTick, 5 * 60e3); }
function stopWatch(keep) { clearInterval(watchTimer); watchTimer = null; if (!keep && !S.scanning) Alerts.keepAlive(false); }
async function watchTick() {
  if (window.Morning) Morning.sync().catch(() => {});
  if (window.Trades) Trades.check(); // open trades: SL / target / expiry alerts (own 15 s timer also runs while the app is open)
  if (S.scanning) return;
  for (const mkt of ['IN', 'US']) {
    if (!marketOpen(mkt) || !S.saved[mkt].length) continue;
    await regime(mkt); const Q = await msQuotes(S.saved[mkt], mkt);
    await pool(S.saved[mkt], 3, async sym => { const q = await dailyQuick(sym, mkt, Q); if (q.err) return; const row = Object.assign({ sym }, q); upsertRow(mkt, row); const R = rateRow(row, mkt);
      Alerts.evaluate({ sym, mkt, price: q.price, rating: R.rating, action: R.action, setups: q.setups, chartPats: q.chartPats, cross: q.cross, news: newsOf(mkt, sym) }, true); });
  }
  for (const mkt of ['IN', 'US']) if (marketOpen(mkt) && window.Portfolio && Portfolio.list(mkt).length) await Portfolio.check(mkt).catch(() => {}); // holdings advice + stop/target alerts
  Alerts.save(); Alerts.flush(); updBell();
}

// ---------- detail ----------
function openDetail(sym, hz) { S.detail = { sym, mkt: S.mkt }; S.hz = hz || 'overall'; go('detail'); }
function rowFromA(A) { // same shape as a scan row, so the list shows the same rating
  const slim = h => h && !h.na ? { score: h.score, action: h.action, dir: h.dir, bt: h.bt } : h, H = A.horizons;
  return { price: A.price, chg: A.chg, overall: A.overall, act: A.overallAction, swing: slim(H.swing), short: slim(H.short), intraday: slim(H.intraday), medium: slim(H.medium), long: slim(H.long),
    horizons: { swing: slim(H.swing), short: slim(H.short), medium: slim(H.medium), long: slim(H.long) }, turnover: A.stats.turnover, ret63: A.stats.ret63, risk: A.risk || null, patterns: A.patterns.map(p => ({ n: p.n, b: p.b })), setups: A.setups.map(s => ({ n: s.n, k: s.k, b: s.b, q: s.q })), chartPats: (A.chartPats || []).map(p => ({ n: p.n, b: p.b, q: p.q, status: p.status, target: p.target })), cross: A.cross, volx: A.stats.volx, rsi: A.stats.rsi };
}
async function loadDetail() {
  const { sym, mkt } = S.detail, ys = ySym(sym, mkt), useMS = mkt === 'IN' && window.MS && MS.ok();
  let d = null, it = null, src = 'Yahoo Finance', msErr = null, prev = null;
  // same daily history as the scanner (Yahoo 2y) so the rating matches the list; mStock adds the live price
  try { d = await chart(ys, '2y', '1d'); } catch (e) {
    if (!useMS) throw e;
    try { const D = await MS.candles(sym, 'day', 730); d = { D, meta: {} }; src = 'mStock'; } catch (e2) { throw e; }
  }
  it = useMS ? await MS.candles(sym, '5minute', 6).then(D => ({ D })).catch(() => null) : null;
  if (!it) it = await chart(ys, '5d', '5m').catch(() => null);
  // price + previous close from one rule-set (MS.basis): mStock LTP when connected & live, official close after the session
  let mq = null;
  if (useMS) {
    try { mq = (await MS.quotes([sym]))[sym] || null; if (!mq) msErr = 'no quote for ' + sym + ' (' + ((MS.cov && MS.cov.why && MS.cov.why[sym]) || 'not in reply') + ')'; }
    catch (e) { msErr = e.message; }
  }
  const hasMs = !!(mq && mq.last_price);
  const bs = MS.basis(d.D, { mkt, lp: hasMs ? mq.last_price : (d.meta.regularMarketPrice || d.D.c[d.D.c.length - 1]), pq: hasMs && mq.ohlc ? mq.ohlc.close : null, q: mq, ms: hasMs, ts: d.meta.regularMarketTime });
  const price = bs ? bs.price : d.D.c[d.D.c.length - 1]; prev = bs ? bs.prev : null;
  if (bs && bs.src === 'ms') src = src === 'mStock' ? 'mStock live' : 'Yahoo history + mStock live price';
  else if (bs && bs.src === 'cl') src = bs.idle ? 'Last official close (market not open yet)' : 'Official close (NSE daily bar)';
  else if (useMS) src = 'Yahoo Finance (fallback, delayed)';
  const fno = mkt === 'IN' && isFno(sym);
  let news = S.detail.news;
  if (!news || Date.now() - news.at > 5 * 60e3) { try { news = Object.assign(await News.get(ys, nameOf(sym, mkt), mkt === 'IN'), { at: Date.now() }); putNews(mkt, sym, news); } catch (e) { news = { items: [], score: 0, n: 0, err: e.message, at: Date.now() }; } }
  await regime(mkt);
  const A = Engine.analyze(d.D, { intra: it && marketOpen(mkt) ? it.D : null, tick: MK[mkt].tick, canShort: mkt === 'US' || fno, backtest: true, price, fnoSym: fno ? sym : null, lot: foLot(sym) });
  if (prev && !A.err) { A.chg = (A.price / prev - 1) * 100; A.prev = prev; }
  if (!A.err) A.risk = riskOf(d.D, mkt, sym);
  if (!A.err && window.Learn) { Learn.resolve(sym, mkt, d.D); Learn.log(sym, mkt, A.horizons, d.D.t[d.D.t.length - 1], A.price); }
  let R = null;
  if (!A.err) { const row = Object.assign({ sym }, rowFromA(A)); R = rateRow(row, mkt); upsertRow(mkt, row); store.set('scan', S.scan);
    Alerts.evaluate({ sym, mkt, price: A.price, rating: R.rating, action: R.action, setups: A.setups, chartPats: A.chartPats, cross: A.cross, news: newsOf(mkt, sym) }, S.saved[mkt].includes(sym)); Alerts.save(); Alerts.flush(); }
  Object.assign(S.detail, { A, R, D: d.D, intra: it && it.D, meta: d.meta, at: Date.now(), src, msErr, news, px: bs ? { price: A.price, prev: A.prev, src: bs.src, official: bs.official, idle: bs.idle, day: bs.day, at: bs.at } : null });
}
async function vDetail() {
  const v = $('#view'), { sym } = S.detail;
  v.innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">${esc(sym)}</div><div class="f">${esc(nameOf(sym))}</div></div><button class="star" id="palert" title="Price alert">⏰</button><button class="star" id="star">${S.saved[S.mkt].includes(sym) ? '★' : '☆'}</button></div><div id="dbody"><div class="empty"><span class="spin"></span> Analysing ${esc(sym)}…</div></div>`;
  $('#back').onclick = back;
  $('#palert').onclick = () => {
    const pa = Alerts.priceAlert(S.mkt, sym), px = S.detail.A ? S.detail.A.price : '';
    const a = prompt(`Alert when ${sym} goes ABOVE (now ${px}). Leave empty for none:`, pa.above || ''); if (a === null) return;
    const b = prompt(`Alert when ${sym} goes BELOW. Leave empty for none:`, pa.below || ''); if (b === null) return;
    Alerts.setPriceAlert(S.mkt, sym, { above: +a || null, below: +b || null }); Alerts.requestPermission();
    if (!S.saved[S.mkt].includes(sym)) { S.saved[S.mkt].push(sym); store.set('saved', S.saved); $('#star').textContent = '★'; }
    toast(+a || +b ? `Price alert set for ${sym}. Checked whenever the app refreshes it (keep Background watch on).` : 'Price alert removed.');
  };
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
  const { A, R, sym, meta, at } = S.detail, H = A.horizons, c = cur();
  if (A.err) { $('#dbody').innerHTML = `<div class="warn">${esc(A.err)}</div>`; return; }
  const row = Object.assign({ sym }, rowFromA(A)), RH = {};
  for (const x of HZ) RH[x] = hzRate(row, x, S.detail.mkt);
  const sel = S.hz === 'overall' || !RH[S.hz] ? 'overall' : S.hz;
  const top = sel === 'overall' ? Object.assign({ label: 'Overall rating' }, R) : Object.assign({ label: H[sel].label + ' rating' }, RH[sel]);
  const k = sel === 'overall' ? (HZ.filter(x => RH[x]).sort((a, b) => Math.abs(RH[b].rating - 50) - Math.abs(RH[a].rating - 50))[0] || 'swing') : sel, h = H[k], Rk = RH[k] || {};
  // levels only when the edge-adjusted action agrees with the raw signal direction
  const L = Rk.dir && h.levels && h.dir === Rk.dir ? h.levels : null;
  const lvl = (l, x) => `<div><div class="l">${l}</div><div class="v">${fmt(x)}</div><div class="p">${L && l !== 'Entry' ? pct((x / L.entry - 1) * 100) : '&nbsp;'}</div></div>`;
  const pillCls = Rk.dir > 0 ? 'b1' : Rk.dir < 0 ? 'b-1' : 'b0';
  const odds = h.bt && h.bt.odds != null ? `<b class="${h.bt.odds >= 50 ? 'up' : h.bt.odds >= 40 ? 'wa' : 'dn'}">${h.bt.odds}%</b> win odds <span class="mu">(${h.bt.wins}/${h.bt.n} past signals hit T1 before stop)</span>` : h.bt ? '<span class="mu">Too few past signals to estimate win odds</span>' : '';
  const st = A.stats;
  $('#dbody').innerHTML = `
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="price">${c}${fmt(A.price)}</div><div>${pct(A.chg)} <span class="mu" style="font-size:12px">today · ${isRefresh ? 'updated ' : ''}${new Date(at).toLocaleTimeString()}</span></div><div style="font-size:11px;margin-top:3px" class="${/mStock/.test(S.detail.src) ? 'up' : 'mu'}">Source: ${esc(S.detail.src)}${S.detail.msErr ? ` <span class="wa">· mStock: ${esc(S.detail.msErr)}</span>` : ''}</div></div>
  <span class="live ${marketOpen(S.detail.mkt) ? 'on' : ''}"><i></i><span>${marketOpen(S.detail.mkt) ? 'Live · 30s' : 'Market closed'}</span></span></div></div>
  <div class="card hero">${ring(top.rating)}<div style="flex:1;min-width:0"><div class="sub">${esc(top.label)}</div><div class="verdict ${cls(top.rating) === 'b1' ? 'up' : cls(top.rating) === 'b-1' ? 'dn' : 'wa'}">${top.action}</div>
  <div class="sub">Signal <b>${top.signal}</b> · Proven edge <b class="${top.edge == null ? '' : top.edge >= 50 ? 'up' : 'dn'}">${top.edge == null ? 'n/a' : top.edge}</b>${top.bt ? ` <span class="mu">(${top.bt.wins}/${top.bt.n} wins)</span>` : ''} · Market <b>${top.regAdj >= 0 ? '+' : ''}${top.regAdj}</b>${A.risk ? ` <span class="mu">(β ${A.risk.beta.toFixed(1)})</span>` : ''} · News <b>${top.newsAdj >= 0 ? '+' : ''}${top.newsAdj}</b></div></div></div>
  ${A.stats.turnover < (S.minTurnover[S.detail.mkt] || 0) ? `<div class="warn">⚠ Thinly traded: about ${c}${fmt(A.stats.turnover / (S.detail.mkt === 'IN' ? 1e7 : 1e6), 2)} ${S.detail.mkt === 'IN' ? 'Cr' : 'M'} a day. Wide spreads and slippage can wipe out the edge.</div>` : ''}
  <div class="hzrow">${['overall', ...HZ].map(x => { const v = x === 'overall' ? R : RH[x]; return `<button data-h="${x}" class="hzc ${x === sel ? 'on' : ''}"><span>${x === 'overall' ? 'Overall' : H[x].label.replace(' term', '')}</span><b class="${!v ? 'mu' : v.rating >= 58 ? 'up' : v.rating <= 42 ? 'dn' : 'wa'}">${v ? v.rating : '–'}</b></button>`; }).join('')}</div>
  <h3>What to do · ${esc(h.label)}${sel === 'overall' ? ' <span class="note">(strongest horizon)</span>' : ''}</h3>
  <div class="card hz">${h.na ? `<div class="empty">Not enough history for ${h.label.toLowerCase()} analysis.</div>` : `
   <div class="top2"><span class="pill ${pillCls}">${Rk.action}</span><div style="flex:1"><div style="font-weight:800;font-size:18px">${Rk.rating}<span class="mu" style="font-size:13px">/100 ${esc(h.label.toLowerCase())} rating</span></div><div class="sub">⏱ ${h.dur}</div></div></div>
   <div class="meter"><i style="left:calc(${Rk.rating}% - 2px)"></i></div>
   <div style="font-size:13px;margin-top:6px">${odds}</div>${Rk.dir && h.bt && h.bt.odds != null && h.bt.odds < 100 / (1 + (h.levels ? h.levels.rr1 : 1.5)) ? `<div class="warn" style="margin:8px 0 0">⚠ Weak edge: on ${esc(S.detail.sym)} this signal hit Target 1 less often than the ${Math.round(100 / (1 + h.levels.rr1))}% needed to break even. Trade smaller, or wait for a pattern trigger.</div>` : ''}
   ${(() => { const cp = (A.chartPats || []).find(p => p.status !== 'forming' && p.b && Rk.dir && p.b !== Rk.dir && p.q >= 70); return cp ? `<div class="warn" style="margin:8px 0 0">⚠ Conflict: a <b>${esc(cp.n)}</b> (${esc(cp.status)}) points the other way. Trade smaller or wait until it is resolved.</div>` : ''; })()}
   ${L ? `<div class="lv">${lvl('Entry', L.entry)}${lvl('Stop loss', L.stop)}${lvl('Target 1', L.t1)}${lvl('Target 2', L.t2)}</div>
   ${sizeLine(L, A, S.detail.mkt)}<div class="sub">Risk ${L.riskPct.toFixed(1)}% · Reward:risk 1:${L.rr1} / 1:${L.rr2}${L.vwap ? ` · VWAP ${fmt(L.vwap)}` : ''}${Rk.noShort ? ' · Exit longs or avoid. Shorting needs F&O.' : ''}${k === 'intraday' && S.detail.mkt === 'IN' ? ' · Square off by 3:15 PM' : ''}</div>
   ${A.fno && Rk.dir && (k === 'intraday' || k === 'swing') ? `<div class="sub" style="margin-top:6px">Futures: ${Rk.dir > 0 ? 'BUY' : 'SELL'} 1 lot${A.fno.lot ? ` (${A.fno.lot} qty) · risk ≈ ${c}${fmt(Math.abs(L.entry - L.stop) * A.fno.lot, 0)}` : ''}</div>` : ''}`
     : `<div class="sub">${Rk.dir ? 'Signal and backtest disagree on direction, so there are no levels. Stand aside.' : `No trade: ${Rk.rating} is in the wait zone (43–57). Wait for 58+ to buy or 42- to sell.`} Raw signal ${h.score}.</div>`}
   <ul class="why">${h.why.map(w => `<li>${w.w > 0 ? '<span class="up">✓</span>' : '<span class="dn">✗</span>'} ${esc(w.t)}</li>`).join('')}</ul>`}</div>
  ${riskCard(A, S.detail.mkt)}
  <div class="card pvcard"><div class="pvhead"><b>Chart</b><label class="pvtg"><input type="checkbox" class="tg sm" id="pvPat" ${store.get('pvPat', true) ? 'checked' : ''}> Patterns</label><button class="btn sm" id="openChart">⛶ Live chart</button></div><div id="pv" class="pv"></div><div class="note" style="margin-top:6px">Tap the chart for full screen: 1m → monthly, EMAs, VWAP, RSI, MACD, free scrolling.</div></div>
  <h3>Setups <span class="note">SMC · VCP · trend</span></h3><div class="card">${A.setups.length ? A.setups.map(s => `<div class="setup"><div class="sh"><span class="tag ${s.b > 0 ? 'p' : 'n'}">${esc(s.k)}</span><b>${esc(s.n.replace(/^SMC: /, ''))}</b><span class="q ${s.q >= 70 ? 'up' : s.q >= 55 ? 'wa' : 'mu'}">${s.q}</span></div>
     <div class="qbar"><i style="width:${s.q}%;background:${s.b > 0 ? 'var(--up)' : 'var(--dn)'}"></i></div><div class="x">${esc(s.note)}</div>${evidence(s.n)}
     ${s.entry ? `<div class="lv3"><span>Entry <b>${fmt(s.entry)}</b></span><span>SL <b class="dn">${fmt(s.stop)}</b></span><span>Target <b class="up">${fmt(s.target)}</b></span></div>` : ''}</div>`).join('') : '<div class="note">No SMC, VCP or trend setup active on the daily chart today.</div>'}</div>
  <h3>News <span class="note">${newsHead(S.detail.news)}</span></h3><div class="card">${newsHTML(S.detail.news)}</div>
  ${A.fno ? `<h3>F&O</h3><div class="card"><div class="kv"><div><div class="l">Lot size</div><div class="v">${A.fno.lot || '–'}</div></div><div><div class="l">ATM strike (approx.)</div><div class="v">${fmt(A.fno.atm, 0)}</div></div>
   <div><div class="l">Expected 1-day move</div><div class="v">±${fmt(A.fno.moveDay)}</div></div><div><div class="l">Expected 1-week move</div><div class="v">±${fmt(A.fno.moveWeek)}</div></div></div>
   <p style="margin:10px 0 4px;font-weight:700">${esc(A.fno.idea)}</p><p class="note">Use the underlying's stop and targets above to exit the option. Strike gaps are approximate, so confirm in the option chain. Buy near-expiry options only on high scores; time decay is brutal.</p></div>` : ''}
  <h3>Chart patterns <span class="note">drawn on the chart</span></h3><div class="card">${(A.chartPats || []).length ? A.chartPats.map(p => `<div class="pat"><div class="ic">${p.b > 0 ? '🟢' : p.b < 0 ? '🔴' : '🟡'}</div><div style="flex:1"><div class="n">${esc(p.n)} <span class="tag ${p.status === 'forming' ? '' : p.b > 0 ? 'p' : 'n'}">${esc(p.status)}</span> <span class="mu" style="font-size:12px">quality ${p.q}</span></div><div class="x">${esc(p.note)}</div>
     <div class="x">Target <b>${fmt(p.target)}</b> · invalid beyond <b>${fmt(p.stop)}</b></div>${evidence(p.n)}</div></div>`).join('') + '<div class="note" style="margin-top:6px">Shown with lines on the chart above. Toggle "Patterns" to hide them; in the live chart you can hide each one.</div>' : '<div class="note">No head & shoulders, double top/bottom, flag or triangle that meets the rules right now.</div>'}</div>
  <h3>Candles & breakouts</h3><div class="card">${A.patterns.length ? A.patterns.map(p => `<div class="pat"><div class="ic">${p.b > 0 ? '🟢' : p.b < 0 ? '🔴' : '🟡'}</div><div><div class="n">${esc(p.n)}</div><div class="x">${esc(p.note)}</div>${p.target || p.stop ? `<div class="x">${p.target ? 'Pattern target <b>' + fmt(p.target) + '</b>' : ''}${p.target && p.stop ? ' · ' : ''}${p.stop ? 'Invalid below/above <b>' + fmt(p.stop) + '</b>' : ''}</div>` : ''}</div></div>`).join('') : '<div class="note">No clear pattern on the daily chart right now.</div>'}</div>
  <h3>EMA crossovers</h3><div class="card">${A.cross.length ? A.cross.map(x => `<div class="pat"><div class="ic">${x.dir > 0 ? '⬆️' : '⬇️'}</div><div><div class="n">${esc(x.name)}</div><div class="x">${esc(x.status)}${x.gap != null ? ` · gap ${x.gap.toFixed(2)}%` : ''} · matters for ${x.hz}</div></div></div>`).join('') : '<div class="note">No EMA cross recent or expected soon.</div>'}</div>
  <h3>Key stats</h3><div class="kv">
   <div><div class="l">RSI 14</div><div class="v">${fmt(st.rsi, 0)}</div></div><div><div class="l">ADX (trend strength)</div><div class="v">${fmt(st.adx, 0)}</div></div>
   <div><div class="l">Daily range (ATR)</div><div class="v">${fmt(st.atr)} · ${st.atrPct.toFixed(1)}%</div></div><div><div class="l">Volume vs 20-day</div><div class="v">${isFinite(st.volx) ? st.volx.toFixed(1) + '×' : '–'}</div></div>
   <div><div class="l">52-week low</div><div class="v">${fmt(st.lo52)}</div></div><div><div class="l">52-week high</div><div class="v">${fmt(st.hi52)}</div></div>
   <div><div class="l">EMA 20 / 50</div><div class="v">${fmt(st.e20, 0)} / ${fmt(st.e50, 0)}</div></div><div><div class="l">EMA 200</div><div class="v">${fmt(st.e200, 0)}</div></div></div>
  <p class="note" style="margin-top:14px">Rating = technical signal (trend, momentum, volume, SMC/VCP setups) blended with how that signal actually performed on this stock over ~3 years, plus market trend and news. Same number as in every list. It describes the past, not a promise. Not investment advice.</p>`;
  document.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { S.hz = b.dataset.h; drawDetail(); });
  const oc = () => ChartView.open({ sym: S.detail.sym, mkt: S.detail.mkt, levels: L, hz: h.label.replace(' term', '') });
  $('#openChart').onclick = oc; $('#pv').onclick = oc;
  $('#pvPat').onchange = e => { store.set('pvPat', e.target.checked); drawPreview(); };
  S.detail.levels = L; S.detail.levelsHz = h.label.replace(' term', ''); drawPreview();
}
const HELP = {
  beta: ['Beta (β): how much it moves with the market', 'Beta compares the stock with Nifty 50 (India) or the S&P 500 (US) over the last year.<br><b>1.0</b> moves in line with the index. <b>1.5</b> moves about 1.5×: Nifty +1% → stock ≈ +1.5%, and the same on the way down. <b>0.6</b> is defensive.<br><br><b>Where the app uses it</b><br>• Ratings: in a rising market high-beta stocks get a bigger boost, in a falling market a bigger cut (the "Market" number on the rating).<br>• Position size: high beta → trade smaller.<br>• Watchlist beta: how hard your saved stocks would fall if Nifty falls.'],
  alpha: ['Alpha (α): return beyond what the market explains', 'Alpha = the stock\'s yearly return − the risk-free rate − beta × (market return − risk-free rate).<br>Example: Nifty +10%, beta 1.2 → the market "explains" about +12%. If the stock made +20%, alpha ≈ +8%: genuine strength from the company or its sector.<br><br><b>Where the app uses it</b><br>• 🏆 Leaders list and the Breakout lists only show positive-alpha stocks.<br>• Risk profile on every stock.<br>Alpha is backward-looking: results or news can change it fast.'],
  updown: ['Upside vs downside beta', 'Beta measured separately on days the market rose and days it fell. The ideal stock has <b>upside beta > downside beta</b>: it rises more in rallies than it falls in sell-offs. This is one condition for 🏆 Leader.'],
  vol: ['Volatility', 'How wild the daily swings are, scaled to a year. 20% is calm for a large cap; 50%+ is very volatile. Higher volatility needs wider stops and smaller size.'],
  sharpe: ['Sharpe & Sortino ratios', '<b>Sharpe</b> = (yearly return − risk-free rate) ÷ volatility: return per unit of risk. Above 1 is good, above 2 is excellent.<br><b>Sortino</b> is the same but counts only downside swings, which is fairer for strong uptrends. Sortino > 1 is one condition for 🏆 Leader.'],
  mdd: ['Max drawdown', 'The worst fall from a peak to a bottom in the last year. It shows how much pain holding the stock would have caused. A swing stop far smaller than this will get hit often.'],
  r2: ['R² (how much the market explains)', 'The share of the stock\'s moves explained by the index (0–100%). High R² means beta is reliable. Low R² means company news dominates and beta matters less.'],
  leader: ['🏆 Leaders', 'Stocks with <b>positive alpha</b>, <b>Sortino above 1</b> and <b>upside beta above downside beta</b>: they beat what their risk explains, reward risk well, and resist sell-offs better than they lag rallies. Ranked by rating.'],
  wbeta: ['Watchlist beta', 'The average beta of your saved stocks. 1.3 means your watchlist tends to move about 1.3× Nifty: a 2% Nifty fall ≈ 2.6% for your basket. Add low-beta names if it is too high for your comfort.'],
  sizing: ['Suggested quantity', 'Quantity = (capital × risk %) ÷ (entry − stop loss). Every trade then risks the same amount of money, whatever the stock\'s price or volatility. High-beta stocks get a note to go smaller. Set capital and risk % in Settings.'],
};
function showHelp(k) {
  const h = HELP[k]; if (!h) return; const o = document.createElement('div'); o.className = 'sheet';
  o.innerHTML = `<div class="sh-in"><div class="sh-h"><b>${h[0]}</b><button class="back" id="shx">✕</button></div><div class="sh-b">${h[1]}</div><button class="btn g w" id="shall">All terms explained</button></div>`;
  document.body.appendChild(o); const close = () => o.remove(); o.onclick = e => { if (e.target === o) close(); }; o.querySelector('#shx').onclick = close;
  o.querySelector('#shall').onclick = () => { close(); go('learn'); }; S.sheet = close;
}
document.addEventListener('click', e => { const a = e.target.closest('[data-help]'); if (a) { e.preventDefault(); e.stopPropagation(); showHelp(a.dataset.help); } }, true);
function vLearn() {
  $('#view').innerHTML = `<div class="dh"><button class="back" id="back">←</button><div class="t"><div class="s">Alpha, beta & risk</div><div class="f">What they mean and where the app uses them</div></div></div>
  ${['beta', 'alpha', 'updown', 'vol', 'sharpe', 'mdd', 'r2', 'leader', 'wbeta', 'sizing'].map(k => `<div class="card"><b>${HELP[k][0]}</b><div class="note" style="font-size:13.5px;color:var(--tx);margin-top:6px;line-height:1.5">${HELP[k][1]}</div></div>`).join('')}`;
  $('#back').onclick = back;
}
function riskCard(A, mkt) {
  const K = A.risk; if (!K) return `<h3>Risk profile</h3><div class="card note">${A.horizons ? 'Not enough shared history with the index to measure alpha and beta (needs ~6 months).' : ''}</div>`;
  const RL = Engine.riskLabel(K), idx = mkt === 'IN' ? 'Nifty' : 'S&P 500', ab = x => (x > 0 ? '+' : '') + x.toFixed(1);
  const say = (K.r2 < 0.12 ? `${idx} explains little of its moves (R² ${Math.round(K.r2 * 100)}%), so beta is unreliable here; company news drives it. ` : `Moves about <b>${K.beta.toFixed(2)}×</b> ${idx}. `) + `${K.alpha >= 0 ? `Beat what its risk explains by <b class="up">${ab(K.alpha)}%</b> a year` : `Lagged what its risk explains by <b class="dn">${ab(K.alpha)}%</b> a year`}. ${K.upBeta > K.downBeta ? 'Rises more in rallies than it falls in sell-offs.' : 'Falls harder in sell-offs than it rises in rallies.'}`;
  const cell = (l, v, h, c = '') => `<div data-help="${h}"><div class="l">${l} <span class="qm">ⓘ</span></div><div class="v ${c}">${v}</div></div>`;
  return `<h3>Risk profile <span class="note">vs ${idx}, last year</span> <a class="help" data-help="beta">What is this?</a></h3><div class="card">
   <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="pill ${RL.style === 'Aggressive' ? 'b-1' : RL.style === 'Defensive' ? 'b1' : 'b0'}" style="font-size:13px">${RL.style}</span>${RL.leader ? '<span class="pill b1" style="font-size:13px">🏆 Leader</span>' : ''}</div>
   <div class="sub" style="color:var(--tx);margin-bottom:10px">${say}</div>
   <div class="kv">${cell('Beta (β)', K.beta.toFixed(2), 'beta')}${cell('Alpha (α) / yr', ab(K.alpha) + '%', 'alpha', K.alpha >= 0 ? 'up' : 'dn')}
    ${cell('Upside / downside β', `${K.upBeta.toFixed(2)} / ${K.downBeta.toFixed(2)}`, 'updown', K.upBeta > K.downBeta ? 'up' : 'dn')}${cell('Volatility / yr', K.vol.toFixed(0) + '%', 'vol')}
    ${cell('Sharpe · Sortino', `${K.sharpe.toFixed(2)} · ${K.sortino.toFixed(2)}`, 'sharpe', K.sortino >= 1 ? 'up' : '')}${cell('Max drawdown', K.mdd.toFixed(0) + '%', 'mdd', 'dn')}
    ${cell('R² with index', Math.round(K.r2 * 100) + '%', 'r2')}${cell('1-yr return vs index', `${ab(K.ret)}% vs ${ab(K.mret)}%`, 'alpha', K.ret >= K.mret ? 'up' : 'dn')}</div>
   <div class="note" style="margin-top:8px">Risk-free rate assumed ${S.rf[mkt]}% (change in Settings). Tap any box for an explanation.</div></div>`;
}
function sizeLine(L, A, mkt) {
  const Z = S.sizing, risk = Math.abs(L.entry - L.stop); if (!risk || !Z.capital) return '';
  let q = Math.floor(Z.capital * Z.riskPct / 100 / risk); q = Math.min(q, Math.floor(Z.capital / L.entry)); if (q < 1) return '';
  const hb = A.risk && A.risk.beta >= 1.3, c = cur();
  return `<div class="sizeln" data-help="sizing">📐 Suggested qty <b>${q}</b> · risk ${c}${fmt(q * risk, 0)} (${Z.riskPct}% of ${c}${fmt(Z.capital, 0)}) · needs ${c}${fmt(q * L.entry, 0)}${hb ? ` · <span class="wa">β ${A.risk.beta.toFixed(1)}: consider ~25% less</span>` : ''} <span class="qm">ⓘ</span></div>`;
}
function evidence(name) {
  const e = Engine.setupEdge(name); if (!e) return '<div class="evd mu">Not enough history to test this one yet.</div>';
  return `<div class="evd ${e.edge ? 'ok' : 'no'}">${e.edge ? '✅ Proven edge' : '⚠️ No proven edge (info only)'} · tested on 80 NSE stocks, 5 yrs: hit target first <b>${e.hit}%</b> of ${e.n.toLocaleString()} times (break-even ${e.be}%)</div>`;
}
function newsHead(N) {
  if (!N || !N.n) return N && N.err ? 'unavailable' : 'no rated headlines';
  const s = N.score; return `${s > 0.15 ? '<span class="up">Positive</span>' : s < -0.15 ? '<span class="dn">Negative</span>' : 'Neutral'} · ${N.n} headlines`;
}
function ago(t) { const m = (Date.now() - t) / 6e4; return m < 60 ? Math.max(1, m | 0) + 'm' : m < 1440 ? (m / 60 | 0) + 'h' : (m / 1440 | 0) + 'd'; }
function newsHTML(N) {
  if (!N || !N.items.length) return `<div class="note">${N && N.err ? 'News could not be loaded (works in the installed app).' : 'No recent news found.'}</div>`;
  return N.items.slice(0, 10).map(it => `<a class="news" href="${/^https?:\/\//i.test(it.url || '') ? esc(it.url) : '#'}" target="_blank" rel="noopener noreferrer"><i class="${it.s > 0 ? 'p' : it.s < 0 ? 'n' : ''}"></i><div><div class="nt">${esc(it.title)}</div><div class="x">${esc(it.src || '')} · ${it.t ? ago(it.t) + ' ago' : ''}</div></div></a>`).join('')
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
  const L = S.detail.levels, hzl = S.detail.levelsHz || ''; if (L) [[L.stop, '#ef4444', 'SL'], [L.t1, '#22c55e', 'T1'], [L.t2, '#22c55e', 'T2']].forEach(([price, color, title]) => cs.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, title }));
  if (store.get('pvPat', true)) {
    const marks = [];
    for (const p of A.chartPats || []) {
      for (const Ln of p.lines) { const pts = []; let last = -1; for (const [ix, val] of Ln.pts) { const k = Math.round(ix); if (k < s0 || k <= last) continue; last = k; pts.push({ time: D.t[k], value: val }); }
        if (pts.length >= 2) ch.addLineSeries({ color: Ln.color, lineWidth: Ln.w || 2, lineStyle: Ln.dash ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(pts); }
      for (const m of p.marks) if (m.i >= s0) marks.push({ time: D.t[m.i], position: m.pos === 'above' ? 'aboveBar' : 'belowBar', color: p.b > 0 ? '#22c55e' : '#ef4444', shape: 'circle', text: m.t });
      const end = Math.round(Math.max(...p.lines.flatMap(Ln => Ln.pts.map(q => q[0])))); if (end >= s0) marks.push({ time: D.t[Math.min(end, n - 1)], position: p.b < 0 ? 'aboveBar' : 'belowBar', color: '#e879f9', shape: p.b > 0 ? 'arrowUp' : p.b < 0 ? 'arrowDown' : 'square', text: ({ 'Head & shoulders': 'H&S', 'Inverse head & shoulders': 'iH&S', 'Double top': 'DT', 'Double bottom': 'DB', 'Bull flag': 'Flag', 'Bear flag': 'Flag', 'Ascending triangle': 'Tri', 'Descending triangle': 'Tri', 'Symmetrical triangle': 'Tri' }[p.n] || p.n) });
    }
    marks.sort((a, b) => a.time - b.time); cs.setMarkers(marks);
    for (const z of A.srLevels || []) cs.createPriceLine({ price: z.p, color: z.kind === 'R' ? 'rgba(239,68,68,.5)' : 'rgba(34,197,94,.5)', lineStyle: 1, lineWidth: 1, title: z.kind === 'R' ? 'R' : 'S' });
  }
  ch.timeScale().fitContent();
}
window.App = { ySym, chart, fmt, marketOpen };

// ---------- boot ----------
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { S.mkt = b.dataset.m; store.set('mkt', S.mkt); if (['detail', 'broker'].includes(S.tab)) { S.stack = []; S.tab = 'home'; } render(); });
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => { if (b.dataset.t === 'desk') { location.href = 'desk.html'; return; } S.stack = []; S.tab = b.dataset.t; render(); });
$('#gear').onclick = () => go('settings');
$('#bell').onclick = () => go('alerts');
Alerts.onChange(updBell);
const CapApp = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
if (CapApp) {
  CapApp.addListener('backButton', () => { const lk = document.querySelector('.lock'); if (lk) { if (lk._close && !Sec.hasPin()) lk._close(); else CapApp.minimizeApp(); return; } if (!back()) CapApp.minimizeApp(); });
  CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) { S.bgAt = Date.now(); return; }
    if (Sec.hasPin() && S.bgAt && Date.now() - S.bgAt >= store.get('autolock', 60) * 1000) lockScreen();
    updBell(); if (S.tab === 'scan') vScan();
  });
}
const learnFetch = async (s, m) => (await chart(ySym(s, m), '1y', '1d')).D;
const pageReady = document.readyState === 'complete' ? Promise.resolve() : new Promise(r => addEventListener('load', r)); // all view scripts (ui-home.js…) are loaded before the first render
Promise.all([loadNSE(), loadUS(), pageReady]).then(async () => {
  if (window.Learn) await Learn.ready;
  if (store.get('secure', false)) Alerts.setSecure(true);
  if (Sec.hasPin()) await pinPad('Enter your PIN', true);
  render();
  if (Alerts.prefs().watch) startWatch();
  if (window.Morning) Morning.init().catch(() => {}); // pull the latest all-NSE auto scan (pre-open + every 30 min)
  if (window.Learn) setTimeout(() => Learn.tick(learnFetch).catch(() => {}), 8000);
});
