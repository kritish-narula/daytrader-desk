/* Live lists: rows on screen tick with the latest price, get re-analysed on fresh daily bars, and stale scans re-run.
   - every 15 s (market open): latest price + day change for the rows you can see (mStock if connected, else Yahoo 1-min)
   - every 3 min: visible rows whose analysis is >5 min old are re-analysed (same engine as the scan) and the list re-ranked
   - opening the Scanner with a scan from an earlier session (or >30 min old while the market is open) re-runs it */
const Live = (() => {
  const TICK = 15e3, TICK_MS = 4e3, RERATE = 3 * 60e3, RERATE_AGE = 5 * 60e3, STALE = 30 * 60e3;
  let lastRerate = 0, busy = false, reBusy = false;
  const onList = () => ['scan', 'home', 'saved', 'fno'].includes(S.tab) && !document.hidden && !document.querySelector('.lock');
  const visible = () => [...document.querySelectorAll('.row.gf[data-sym]')].filter(r => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; });
  // live prices for the rows on screen: mStock LTP when connected (prev close = mStock ohlc.close), else Yahoo 1-min (marked src yf).
  // Yahoo meta.chartPreviousClose is only the previous close for range=1d, which is the only range used here.
  async function quotes(syms, mkt, prevOf) {
    const out = {};
    if (mkt === 'IN' && window.MS && MS.ok()) {
      try {
        const Q = await MS.pxNow(syms, mkt);
        for (const s of syms) { const o = Q[s]; if (!o) continue; const pc = o.pc || (prevOf && prevOf(s)) || null; out[s] = { ms: 1, p: o.p, chg: pc ? (o.p / pc - 1) * 100 : null, pc }; }
      } catch (e) { MS.lastError = e.message; }
    }
    await pool(syms.filter(s => !out[s]), 5, async s => {
      try { const { meta } = await chart(ySym(s, mkt), '1d', '1m'); const p = meta.regularMarketPrice, pc = meta.chartPreviousClose || meta.previousClose; if (p) out[s] = { p, chg: pc ? (p / pc - 1) * 100 : null, pc }; } catch (e) {}
    });
    return out;
  }
  // Home index tiles: mStock index quotes (NSE:NIFTY 50, BSE:SENSEX ...) every tick when connected
  async function tiles(mkt) {
    if (S.tab !== 'home' || mkt !== 'IN' || !(window.MS && MS.ok())) return;
    const ids = (MK[mkt].idx() || []).map(x => x[0]).filter(s => document.querySelector('#ix_' + s)); if (!ids.length) return;
    const Q = await MS.pxNow(ids, mkt); if (S.mkt !== mkt) return;
    for (const s of ids) { const o = Q[s], el = document.querySelector('#ix_' + s), c = document.querySelector('#ixc_' + s); if (!o || !el) continue;
      el.innerHTML = fmt(o.p) + ' <span class="up" title="mStock live" style="font-size:9px">●</span>';
      if (c && o.chg != null) c.innerHTML = chgPill(o.chg); }
  }
  function paint(row, o) {
    const px = row.querySelector('.px'); if (!px) return;
    const old = parseFloat(row.dataset.lp || 'NaN');
    px.innerHTML = `<b>${cur()}${fmt(o.p)}</b>${chgPill(o.chg)}`; delete row.dataset.nopx;
    if (isFinite(old) && old !== o.p) { row.classList.remove('flu', 'fld'); void row.offsetWidth; row.classList.add(o.p > old ? 'flu' : 'fld'); }
    row.dataset.lp = o.p; row.dataset.src = o.ms ? 'ms' : 'yf';
  }
  async function tick() {
    if (busy || !onList() || !marketOpen(S.mkt)) return;
    busy = true; const mkt = S.mkt;
    try {
      await tiles(mkt);
      const rows = visible().slice(0, 18); if (!rows.length) return;
      const sc = S.scan[mkt], prevOf = s => { const x = sc && sc.rows.find(r => r.sym === s); return x && x.prev; };
      const Q = await quotes([...new Set(rows.map(r => r.dataset.sym))], mkt, prevOf); if (S.mkt !== mkt) return;
      for (const r of rows) { const o = Q[r.dataset.sym]; if (!o || !r.isConnected) continue; paint(r, o);
        const sr = sc && sc.rows.find(x => x.sym === r.dataset.sym); if (sr) { sr.price = o.p; if (o.chg != null) sr.chg = o.chg; if (o.pc) sr.prev = o.pc; sr.src = o.ms ? 'ms' : 'yf'; sr.srcAt = Date.now(); } }
      stamp();
    } finally { busy = false; }
  }
  // re-run the full analysis on the rows on screen with the latest daily bars (today's candle included)
  // Rolling refresh: while the market is open, keep re-analysing stocks with fresh daily bars + live price, ~25 a minute,
  // most important first: rows on screen → your holdings/watchlist/open trades → the current list → the rest (oldest first).
  // Ratings therefore keep updating even if the GitHub auto scan is late. List order stays frozen (see drawScan).
  const ageOf = (r, sc) => Date.now() - (r.at || sc.at || 0);
  async function rerate() {
    const mkt = S.mkt, sc = S.scan[mkt];
    if (reBusy || S.scanning || !sc || document.hidden || !marketOpen(mkt)) return;
    reBusy = true; lastRerate = Date.now();
    try {
      const by = new Map(sc.rows.map(r => [r.sym, r])), pick = [], seen = new Set();
      const add = (s, minAge) => { if (seen.has(s) || pick.length >= 25) return; const r = by.get(s); if (r && ageOf(r, sc) < minAge) return; seen.add(s); pick.push(s); };
      visible().forEach(r => add(r.dataset.sym, 3 * 60e3));
      const mine = [...(window.Portfolio ? Portfolio.list(mkt).map(h => h.sym) : []), ...(S.saved[mkt] || []), ...((window.Trades && Trades.openSyms) ? Trades.openSyms(mkt) : [])];
      mine.forEach(s => add(s, 5 * 60e3));
      if (S.tab === 'scan') [...document.querySelectorAll('#sl .row.gf[data-sym]')].forEach(r => add(r.dataset.sym, 10 * 60e3));
      const uni = new Set(uniSyms()); sc.rows.filter(r => uni.has(r.sym)).sort((a, b) => (a.at || sc.at || 0) - (b.at || sc.at || 0)).forEach(r => add(r.sym, 30 * 60e3));
      if (!pick.length) return;
      const Q = await msQuotes(pick, mkt); let n = 0;
      await pool(pick, 4, async s => { try { const q = await dailyQuick(s, mkt, Q); if (!q.err) { if (by.has(s)) upsertRow(mkt, Object.assign({ sym: s, at: Date.now() }, q)); n++; } } catch (e) {} });
      sc.refreshedAt = Date.now();
      if (n && S.mkt === mkt && !S.sheetOpen) { if (S.tab === 'scan') { const y = scrollY; drawScan(); scrollTo(0, y); } else if (S.tab === 'fno' && window.drawFoList) drawFoList(); }
    } finally { reBusy = false; }
  }
  setInterval(() => rerate().catch(() => {}), 60e3);
  function stamp() { const el = document.querySelector('#liveStamp'); if (el) el.textContent = 'Live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function staleScan(mkt) {
    const sc = S.scan[mkt]; if (!sc) return false;
    const age = Date.now() - sc.at, sameDay = new Date(sc.at).toDateString() === new Date().toDateString();
    return marketOpen(mkt) ? age > STALE : !sameDay && age > 12 * 3600e3;
  }
  // after a list renders: live badge, stale banner / auto re-scan
  function onRender() {
    if (S.mkt === 'IN') { const sc = S.scan.IN, idx = sc ? new Map(sc.rows.map(r => [r.sym, r])) : null, C = window.MS && MS.cov;
      document.querySelectorAll('.row.gf[data-sym]').forEach(r => { if (r.dataset.src) return; const x = idx && idx.get(r.dataset.sym), s = r.dataset.sym;
        // the row's own source wins (set when its price was computed); 'cl' = official close; no source known -> mStock if it answered recently
        const fresh = x && Date.now() - (x.srcAt || 0) < 10 * 60e3, ms = C && C.ok[s] && Date.now() - C.ok[s] < 10 * 60e3;
        r.dataset.src = x && x.src === 'cl' ? 'cl' : x && x.src === 'ms' && (fresh || !marketOpen('IN')) ? 'ms' : x && x.src ? (x.src === 'ms' ? (ms ? 'ms' : 'yf') : 'yf') : ms ? 'ms' : ''; });
      const rows = [...document.querySelectorAll('#sl .row.gf[data-sym]')], n = rows.filter(r => r.dataset.src === 'ms' || r.dataset.src === 'cl').length, hd = document.querySelector('#sl .lhd');
      if (hd && rows.length && !document.querySelector('#covNote')) hd.insertAdjacentHTML('afterend', `<div class="note" id="covNote" style="margin:-2px 2px 8px"><span class="${n === rows.length ? 'up' : 'wa'}">●</span> ${n} of ${rows.length} prices from mStock / official close${n < rows.length ? ' · <span class="wa">●</span> = Yahoo fallback' : ''}</div>`); }
    const mkt = S.mkt, hd = document.querySelector('#sl .lhd .note');
    if (hd && !document.querySelector('#liveStamp') && marketOpen(mkt)) hd.insertAdjacentHTML('afterend', '<span class="livepill" id="liveStamp">Live</span>');
    if (S.tab !== 'scan' || S.scanning || !staleScan(mkt)) return;
    const n = uniSyms().length, ago = Math.round((Date.now() - S.scan[mkt].at) / 60e3);
    if (n <= 800) { toast(`Scan was ${ago >= 120 ? Math.round(ago / 60) + ' h' : ago + ' min'} old — re-analysing with the latest data…`); runScan(); }
    else if (!document.querySelector('#staleBar')) { const sl = document.querySelector('#sl'); if (sl) { sl.insertAdjacentHTML('afterbegin', `<div class="warn" id="staleBar">⏱ This scan is ${ago >= 120 ? Math.round(ago / 60) + ' hours' : ago + ' minutes'} old. <button class="btn sm" id="staleGo">Re-scan now</button></div>`); document.querySelector('#staleGo').onclick = () => runScan(); } }
  }
  let last = 0; setInterval(() => { const fast = window.MS && MS.ok() && S.mkt === 'IN'; if (Date.now() - last >= (fast ? TICK_MS : TICK) - 50) { last = Date.now(); tick().catch(() => {}); } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => tick().catch(() => {}), 500); });
  return { tick, rerate, onRender, staleScan };
})();
// hook list renders (drawScan / vHome / vSaved are redefined by earlier scripts; wrap the final versions)
(() => {
  const wrap = name => { const f = window[name]; if (typeof f !== 'function') return; window[name] = function () { const r = f.apply(this, arguments); setTimeout(() => { Live.onRender(); Live.tick().catch(() => {}); }, 50); return r; }; };
  ['drawScan', 'vHome', 'vSaved'].forEach(wrap);
})();
// 'cl' rows = official close (market closed): neutral dot. Injected here so home.css (another owner) stays untouched.
(() => { const st = document.createElement('style'); st.textContent = '.row.gf[data-src=cl] .px b::after{content:" ●";color:var(--mu,#8a97a6);font-size:9px;vertical-align:middle}'; document.head.appendChild(st); })();
// Stock page: price + change tick every 3 s from mStock between the 30-s full re-analyses.
// Previous close = the page's own basis (A.prev from MS.basis), so header, rows and chart agree. If mStock fails, the status line says so.
(() => {
  let busy = false;
  const hm = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  setInterval(async () => {
    if (busy || S.tab !== 'detail' || document.hidden || !S.detail || S.detail.mkt !== 'IN' || !(window.MS && MS.ok()) || !marketOpen('IN')) return;
    const A = S.detail.A, big = document.querySelector('.dq-big'), ch = document.querySelector('.dq-chg'); if (!A || !big || !ch) return;
    busy = true; const st = document.querySelector('.dq-st .mu'), sym = S.detail.sym;
    try {
      const kk = await MS.key(sym), q = await MS.ltp([kk.k]), px = q[kk.k]; if (S.detail.sym !== sym) return;
      if (!px) { if (st) st.innerHTML = '· <span class="wa">mStock tick failed, showing the last refresh (' + hm() + ')</span>'; return; }
      const prev = A.prev || A.price / (1 + (A.chg || 0) / 100), d = px - prev, c = d / prev * 100, up = d >= 0;
      const old = parseFloat(big.dataset.v || A.price); big.dataset.v = px;
      big.textContent = cur() + fmt(px);
      ch.className = 'dq-chg ' + (up ? 'up' : 'dn');
      ch.innerHTML = `${up ? '+' : '−'}${fmt(Math.abs(d))} (${up ? '+' : '−'}${Math.abs(c).toFixed(2)}%) <span class="dq-arr">${up ? '▲' : '▼'}</span>`;
      if (px !== old) { big.classList.remove('flu', 'fld'); void big.offsetWidth; big.classList.add(px > old ? 'flu' : 'fld'); }
      S.detail.px = Object.assign(S.detail.px || {}, { price: px, prev, src: 'ms', at: Date.now(), official: false }); // the full-screen chart header reads this
      if (st) st.textContent = '· ' + hm() + ' · mStock · full refresh every 30s';
    } catch (e) { if (st) st.innerHTML = '· <span class="wa">mStock tick failed: ' + esc(e.message || '') + '</span>'; } finally { busy = false; }
  }, 3000);
})();
