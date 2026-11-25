/* Auto scan: every NSE stock is re-priced and re-analysed on GitHub before the open (≈08:30 IST) and every 30 min until the
   close (tools/morning.js). Whenever this phone has internet — app opened, brought back, network returns, or every 5 min —
   the newest scan is pulled straight into the scanner lists, the portfolio advice is refreshed, and a morning summary is
   notified once a day. If the GitHub scan is missing for today, the phone scans the Nifty 500 itself. */
const Morning = (() => {
  const BASE = 'https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/data/', CACHE = 'dtd-data';
  let rep = store.get('morning', null), busy = false, last = 0;
  const istNow = () => new Date(Date.now() + 5.5 * 3600e3), today = () => istNow().toISOString().slice(0, 10), hm = () => istNow().toISOString().slice(11, 16);
  const tradingDay = d => window.Paper && Paper.isTradingDay ? Paper.isTradingDay(d) : ![0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay());

  async function getJSON(name, bust) {
    const url = BASE + name, r = await fetch(url + '?v=' + encodeURIComponent(bust), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text(); try { const c = await caches.open(CACHE); await c.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } })); } catch (e) {}
    return JSON.parse(text);
  }
  async function cached(name) { try { const c = await caches.open(CACHE), r = await c.match(BASE + name); return r ? await r.json() : null; } catch (e) { return null; } }

  // put the scan rows into the app's scanner (keeps any newer on-device analysis of a stock)
  function apply(j, from) {
    if (!j || !Array.isArray(j.rows) || !j.rows.length) return false;
    const at = Date.parse(j.generatedAt) || Date.now(), cur = S.scan.IN;
    if (cur && cur.ci === j.generatedAt) return false;
    const mine = new Map(((cur && cur.rows) || []).filter(r => (r.at || 0) > at || (!cur.ci && cur.at > at)).map(r => [r.sym, r]));
    const rows = j.rows.map(r => { if (mine.has(r.sym)) return mine.get(r.sym); for (const h of ['swing', 'short', 'medium', 'long']) if (r.horizons && r.horizons[h]) r[h] = r.horizons[h]; r.horizons = r.horizons || {}; return r; });
    for (const [s, r] of mine) if (!rows.some(x => x.sym === s)) rows.push(r);
    S.scan.IN = { at, rows, src: `Auto scan ${j.time} IST · all NSE${j.phase === 'pre-open' ? ' (pre-open)' : ''}`, ci: j.generatedAt };
    try { store.set('scan', Object.assign({}, S.scan, { IN: Object.assign({}, S.scan.IN, { rows: S.scan.IN.rows.slice(0, 400) }) })); } catch (e) {} // small copy; the full set lives in the cache
    if (S.mkt === 'IN' && !S.scanning) { if (S.tab === 'scan') window.drawScan && drawScan(); else if (S.tab === 'home') render(); else if (S.tab === 'fno') window.drawFoList && drawFoList(); }
    return true;
  }

  async function sync(force) {
    if (busy || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    if (!force && Date.now() - last < 4 * 60e3) return;
    busy = true; last = Date.now();
    try {
      const m = await getJSON('morning.json', Math.floor(Date.now() / 120e3));
      if (m && m.generatedAt) {
        const isNew = !rep || rep.generatedAt !== m.generatedAt; rep = m; store.set('morning', m);
        if (!(S.scan.IN && S.scan.IN.ci === m.generatedAt)) { const j = await getJSON('scan_in.json', m.generatedAt); if (apply(j) && window.Portfolio && Portfolio.list('IN').length) Portfolio.check('IN').catch(() => {}); }
        if (isNew && S.tab === 'home' && S.mkt === 'IN') render();
      }
      notifyOnce(); fallback();
    } catch (e) { fallback(); } finally { busy = false; }
  }
  // GitHub scan missing for today: scan the Nifty 500 on the phone once (after 09:40 IST)
  function fallback() {
    const d = today(); if (!tradingDay(d) || (rep && rep.date === d) || store.get('mfb', '') === d || S.scanning || hm() < '09:40' || hm() > '15:30') return;
    const cat = (S.nse && S.nse.cat) || {}, L = Object.keys(cat).filter(s => ['L', 'M', 'S'].includes(cat[s][0])); if (L.length < 50) return;
    store.set('mfb', d); if (S.mkt === 'IN') { toast('Auto scan: scanning the Nifty 500 on your phone…'); runScan(L.slice(0, 800)); }
  }
  // one morning summary alert per day (pre-open report, or the first one seen that day)
  function notifyOnce() {
    const d = today(); if (!rep || rep.date !== d || store.get('mnote', '') === d || !window.Alerts || !Alerts.add) return;
    store.set('mnote', d);
    const pf = (store.get('pfSum', {}) || {}).IN, top = (rep.top || []).slice(0, 4).map(x => `${x.sym} ${x.rating}`).join(', ');
    Alerts.add({ sym: (rep.top[0] || {}).sym || 'NIFTY', mkt: 'IN', kind: 'morning', title: `☀️ ${rep.phase === 'pre-open' ? 'Pre-market' : 'Morning'} scan: ${rep.mood} · ${rep.breadth.buys} buys, ${rep.breadth.sells} sells`, body: `Top: ${top}.${pf && pf.actions ? ` Your portfolio: ${pf.actions} need action.` : ''}` });
    Alerts.flush && Alerts.flush(); window.updBell && updBell();
  }
  async function init() {
    if (!S.scan.IN || !S.scan.IN.ci || S.scan.IN.rows.length < 500) { const j = await cached('scan_in.json'); if (j && (!S.scan.IN || Date.parse(j.generatedAt) >= (S.scan.IN.at || 0))) apply(j); }
    sync(true);
  }
  // triggers: internet comes back, app brought to front, every 5 min while open
  window.addEventListener('online', () => sync(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  setInterval(() => sync(), 5 * 60e3);

  // ---------- Home card ----------
  function cardHTML() {
    if (S.mkt !== 'IN' || !rep) return '';
    const d = today(), stale = rep.date !== d, b = rep.breadth || {}, tone = rep.regime >= 52 ? 'up' : rep.regime < 45 ? 'dn' : '';
    const age = Math.round((Date.now() - Date.parse(rep.generatedAt)) / 60e3), ago = age < 60 ? `${age} min ago` : age < 1440 ? `${Math.round(age / 60)} h ago` : rep.date;
    return `<div class="card mr-card" id="mrCard"><div class="mr-h"><div><b>☀️ ${rep.phase === 'pre-open' ? 'Pre-market scan' : 'Auto scan'}</b> <span class="note">all ${b.n || ''} NSE stocks · ${esc(rep.time)} IST · ${ago}</span></div><span class="mr-mood ${tone}">${esc(rep.mood)}</span></div>
      ${stale ? `<div class="note wa">Latest scan is from ${esc(rep.date)} — today's appears once GitHub runs it (pre-open ≈8:30).</div>` : ''}
      <div class="mr-b"><span><b class="up">${b.adv}</b>↑ <b class="dn">${b.dec}</b>↓</span><span>Above 50-DMA <b>${b.a50}%</b></span><span>52w highs <b>${b.hi52}</b> · lows <b>${b.lo52}</b></span><span><b class="up">${b.buys}</b> buy · <b class="dn">${b.sells}</b> sell signals</span></div>
      <div class="note" style="margin:6px 0 4px">Top picks</div><div class="mr-picks">${(rep.top || []).slice(0, 8).map(x => `<button class="mr-p" data-s="${esc(x.sym)}"><b>${esc(x.sym)}</b><span class="${x.rating >= 68 ? 'up' : ''}">${x.rating}</span></button>`).join('')}</div>
      ${(rep.sectors || []).length ? `<div class="note" style="margin-top:6px">Strongest sectors: ${(rep.sectors || []).slice(0, 3).map(s => `${esc(s.sector)} (${s.avg})`).join(' · ')}</div>` : ''}
      <button class="btn sm g" id="mrAll" style="margin-top:8px">All picks by horizon →</button></div>`;
  }
  function bindCard() {
    document.querySelectorAll('#mrCard .mr-p').forEach(b => b.onclick = e => { e.stopPropagation(); openDetail(b.dataset.s); });
    const a = $('#mrAll'); if (a) a.onclick = () => { S.scanFilter = 'top'; go('scan'); };
  }
  return { sync, init, report: () => rep, cardHTML, bindCard, apply };
})();
window.Morning = Morning;
window.morningCardHTML = Morning.cardHTML; window.bindMorningCard = Morning.bindCard;
