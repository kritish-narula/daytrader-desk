/* Live lists: rows on screen tick with the latest price, get re-analysed on fresh daily bars, and stale scans re-run.
   - every 15 s (market open): latest price + day change for the rows you can see (mStock if connected, else Yahoo 1-min)
   - every 3 min: visible rows whose analysis is >5 min old are re-analysed (same engine as the scan) and the list re-ranked
   - opening the Scanner with a scan from an earlier session (or >30 min old while the market is open) re-runs it */
const Live = (() => {
  const TICK = 15e3, RERATE = 3 * 60e3, RERATE_AGE = 5 * 60e3, STALE = 30 * 60e3;
  let lastRerate = 0, busy = false, reBusy = false;
  const onList = () => ['scan', 'home', 'saved'].includes(S.tab) && !document.hidden && !document.querySelector('.lock');
  const visible = () => [...document.querySelectorAll('.row.gf[data-sym]')].filter(r => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; });
  async function quotes(syms, mkt) {
    const out = {};
    if (mkt === 'IN' && window.MS && MS.ok()) {
      try { const Q = await MS.quotes(syms); for (const s of syms) { const q = Q && Q[s]; if (q && q.last_price) { const pc = q.ohlc && q.ohlc.close; out[s] = { p: q.last_price, chg: pc ? (q.last_price / pc - 1) * 100 : null }; } } } catch (e) {}
    }
    await pool(syms.filter(s => !out[s]), 5, async s => {
      try { const { meta } = await chart(ySym(s, mkt), '1d', '1m'); const p = meta.regularMarketPrice, pc = meta.chartPreviousClose || meta.previousClose; if (p) out[s] = { p, chg: pc ? (p / pc - 1) * 100 : null }; } catch (e) {}
    });
    return out;
  }
  function paint(row, o) {
    const px = row.querySelector('.px'); if (!px) return;
    const old = parseFloat(row.dataset.lp || 'NaN');
    px.innerHTML = `<b>${cur()}${fmt(o.p)}</b>${chgPill(o.chg)}`; delete row.dataset.nopx;
    if (isFinite(old) && old !== o.p) { row.classList.remove('flu', 'fld'); void row.offsetWidth; row.classList.add(o.p > old ? 'flu' : 'fld'); }
    row.dataset.lp = o.p;
  }
  async function tick() {
    if (busy || !onList() || !marketOpen(S.mkt)) return;
    busy = true; const mkt = S.mkt;
    try {
      const rows = visible().slice(0, 18); if (!rows.length) return;
      const Q = await quotes([...new Set(rows.map(r => r.dataset.sym))], mkt); if (S.mkt !== mkt) return;
      const sc = S.scan[mkt];
      for (const r of rows) { const o = Q[r.dataset.sym]; if (!o || !r.isConnected) continue; paint(r, o);
        const sr = sc && sc.rows.find(x => x.sym === r.dataset.sym); if (sr) { sr.price = o.p; if (o.chg != null) sr.chg = o.chg; } }
      stamp();
      if (Date.now() - lastRerate > RERATE) rerate();
    } finally { busy = false; }
  }
  // re-run the full analysis on the rows on screen with the latest daily bars (today's candle included)
  async function rerate() {
    if (reBusy || S.scanning || S.tab !== 'scan') return; const mkt = S.mkt, sc = S.scan[mkt]; if (!sc) return;
    reBusy = true; lastRerate = Date.now();
    try {
      const syms = visible().map(r => r.dataset.sym).filter(s => { const r = sc.rows.find(x => x.sym === s); return r && Date.now() - (r.at || sc.at) > RERATE_AGE; }).slice(0, 15);
      if (!syms.length) return;
      const Q = await msQuotes(syms, mkt); let n = 0;
      await pool(syms, 4, async s => { try { const q = await dailyQuick(s, mkt, Q); if (!q.err) { upsertRow(mkt, Object.assign({ sym: s, at: Date.now() }, q)); n++; } } catch (e) {} });
      if (n && S.tab === 'scan' && S.mkt === mkt) { const y = scrollY; drawScan(); scrollTo(0, y); store.set('scan', S.scan); }
    } finally { reBusy = false; }
  }
  function stamp() { const el = document.querySelector('#liveStamp'); if (el) el.textContent = 'Live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function staleScan(mkt) {
    const sc = S.scan[mkt]; if (!sc) return false;
    const age = Date.now() - sc.at, sameDay = new Date(sc.at).toDateString() === new Date().toDateString();
    return marketOpen(mkt) ? age > STALE : !sameDay && age > 12 * 3600e3;
  }
  // after a list renders: live badge, stale banner / auto re-scan
  function onRender() {
    const mkt = S.mkt, hd = document.querySelector('#sl .lhd .note');
    if (hd && !document.querySelector('#liveStamp') && marketOpen(mkt)) hd.insertAdjacentHTML('afterend', '<span class="livepill" id="liveStamp">Live</span>');
    if (S.tab !== 'scan' || S.scanning || !staleScan(mkt)) return;
    const n = uniSyms().length, ago = Math.round((Date.now() - S.scan[mkt].at) / 60e3);
    if (n <= 800) { toast(`Scan was ${ago >= 120 ? Math.round(ago / 60) + ' h' : ago + ' min'} old — re-analysing with the latest data…`); runScan(); }
    else if (!document.querySelector('#staleBar')) { const sl = document.querySelector('#sl'); if (sl) { sl.insertAdjacentHTML('afterbegin', `<div class="warn" id="staleBar">⏱ This scan is ${ago >= 120 ? Math.round(ago / 60) + ' hours' : ago + ' minutes'} old. <button class="btn sm" id="staleGo">Re-scan now</button></div>`); document.querySelector('#staleGo').onclick = () => runScan(); } }
  }
  setInterval(() => { tick().catch(() => {}); }, TICK);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => tick().catch(() => {}), 500); });
  return { tick, rerate, onRender, staleScan };
})();
// hook list renders (drawScan / vHome / vSaved are redefined by earlier scripts; wrap the final versions)
(() => {
  const wrap = name => { const f = window[name]; if (typeof f !== 'function') return; window[name] = function () { const r = f.apply(this, arguments); setTimeout(() => { Live.onRender(); Live.tick().catch(() => {}); }, 50); return r; }; };
  ['drawScan', 'vHome', 'vSaved'].forEach(wrap);
})();
