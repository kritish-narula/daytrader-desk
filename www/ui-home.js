/* Home & lists (Google Finance style). Redefines vHome, rowHTML, drawScan, vScan and helpers from app.js */
window.SPK = window.SPK || {};
function spkKey(sym) { return S.mkt + ':' + sym; }
function sparkSVG(arr, up, w = 64, h = 26, fill = false, base = null) {
  if (!arr || arr.length < 2) return '';
  const mn = Math.min(...arr, base == null ? Infinity : base), mx = Math.max(...arr, base == null ? -Infinity : base), rg = mx - mn || 1, n = arr.length;
  const pts = arr.map((v, i) => [(i / (n - 1)) * w, 2 + (1 - (v - mn) / rg) * (h - 4)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const c = up ? 'var(--up,#22c55e)' : 'var(--down,var(--dn,#ef4444))';
  const by = base == null ? null : (2 + (1 - (base - mn) / rg) * (h - 4)).toFixed(1);
  return `<svg class="spk-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">${by ? `<line x1="0" x2="${w}" y1="${by}" y2="${by}" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="2 3" stroke-width="1"/>` : ''}${fill ? `<path d="${d}L${w} ${h}L0 ${h}Z" fill="${c}" opacity=".12"/>` : ''}<path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}
function chgPill(chg) {
  if (chg == null || !isFinite(chg)) return '<span class="gchg z"></span>';
  return `<span class="gchg ${chg >= 0 ? 'u' : 'd'}">${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%</span>`;
}
function cachedSpark(sym) { const c = SPK[spkKey(sym)], ttl = S.mkt === 'IN' && window.MS && MS.ok() && marketOpen('IN') ? 20e3 : 10 * 60e3; return c && Date.now() - c.at < ttl ? c : null; }
function sparkInner(sym) { const c = cachedSpark(sym); return c ? sparkSVG(c.c, c.up, 64, 26, false, c.pc) : ''; }
// fetch intraday data for a symbol (cached), returns {c, up, pc, p}
async function getSpark(sym) {
  const c = cachedSpark(sym); if (c) return c;
  const mkt = S.mkt, { D, meta } = await chart(ySym(sym, mkt), '1d', '5m');
  // Yahoo range=1d: chartPreviousClose IS the previous session's close (not valid for longer ranges)
  let p = meta.regularMarketPrice, pc = meta.chartPreviousClose || meta.previousClose, src = mkt === 'IN' && !marketOpen(mkt) ? 'cl' : 'yf';
  if (mkt === 'IN' && window.MS && MS.ok() && marketOpen(mkt)) { // connected + live: mStock number, else stay Yahoo (marked)
    try { const m = (await MS.pxNow([sym], mkt))[sym]; if (m) { p = m.p; if (m.pc) pc = m.pc; src = 'ms'; } } catch (e) { MS.lastError = e.message; }
  }
  const cs = D.c.slice(-80); if (src === 'ms' && cs.length) cs[cs.length - 1] = p;
  const o = { c: cs, up: p >= pc, pc, p, chg: pc ? (p / pc - 1) * 100 : null, src, at: Date.now() };
  SPK[spkKey(sym)] = o; return o;
}
// fill sparklines (and optionally price/chg when missing) for rows in `root`
function hydrateRows(root, max = 12, fillPx = false) {
  const rows = [...root.querySelectorAll('.row.gf[data-sym]')].filter(r => !r.querySelector('.spk-svg') || (fillPx && r.dataset.nopx)).slice(0, max);
  const mkt = S.mkt;
  pool(rows, 4, async r => {
    try {
      const o = await getSpark(r.dataset.sym); if (S.mkt !== mkt || !r.isConnected) return;
      const sp = r.querySelector('.spk'); if (sp) sp.innerHTML = sparkSVG(o.c, o.up, 64, 26, false, o.pc);
      if (fillPx && r.dataset.nopx) { const px = r.querySelector('.px'); if (px) { px.innerHTML = `<b>${cur()}${fmt(o.p)}</b>${chgPill(o.chg)}`; delete r.dataset.nopx; r.dataset.lp = o.p; if (S.mkt === 'IN') r.dataset.src = o.src; } }
    } catch (e) {}
  });
}
function rowHTML(sym, name, price, chg, sc, lbl, tags = '', rank, bear) {
  return `<div class="row gf" data-sym="${esc(sym)}"${price == null ? ' data-nopx="1"' : ''}><div class="rm">${rank ? `<div class="rk">${rank}</div>` : ''}${sc != null ? (bear ? `<div class="sc b-1">${sc}<small>${esc(lbl || '')}</small></div>` : badge(sc, lbl)) : ''}<div class="nm"><div class="s">${esc(sym)}</div><div class="f">${esc(name)}</div></div>
  <div class="px">${price != null ? `<b>${cur()}${fmt(price)}</b>${chgPill(chg)}` : ''}</div></div>${tags ? `<div class="rtags">${tags}</div>` : ''}</div>`;
}

function marketSummaryHTML(m) {
  return `<div class="card ms"><div class="mst"><span>Market summary</span><span class="msd">${marketOpen() ? '<i class="dot on"></i>Open' : '<i class="dot"></i>Closed'}</span></div>
  <div class="idxg" id="idx">${m.idx().map(x => `<div class="itile" data-sym="${x[0]}"><div class="n">${esc(x[1])}</div><div class="spk" id="isp_${x[0]}"></div><div class="p" id="ix_${x[0]}"><span class="spin"></span></div><div id="ixc_${x[0]}"></div></div>`).join('')}</div>
  <div class="card regime inner" id="regime"><span class="spin"></span></div>${S.mkt === 'US' ? usHoursHTML() : ''}</div>`;
}
function regimeHTML(v) {
  const t = v >= 60 ? ['up', 'Uptrend', 'longs get +' + Math.round((v - 50) / 10)] : v <= 40 ? ['dn', 'Downtrend', 'longs get ' + Math.round((v - 50) / 10)] : ['wa', 'Sideways', 'no adjustment'];
  return `<div class="rg"><div><div class="note">Market trend (${S.mkt === 'IN' ? 'Nifty 50' : 'S&amp;P 500'})</div><b class="${t[0]}">${t[1]} · ${v}</b></div><div class="rgm"><i style="width:${Math.max(2, Math.min(100, v))}%" class="${t[0]}"></i></div><div class="note" style="text-align:right">Ratings: ${t[2]}</div></div>`;
}
function usHoursHTML() {
  const d = new Date(), et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const toLocal = (h, m) => { const guess = new Date(`${et}T12:00:00Z`), offMin = (new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' })) - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60000;
    const utc = new Date(Date.UTC(+et.slice(0, 4), +et.slice(5, 7) - 1, +et.slice(8, 10), h, m) - offMin * 60000); return utc.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); };
  return `<div class="card regime inner ush"><div><div class="note">US market hours (your time, IST)</div><b>${toLocal(9, 30)} – ${toLocal(16, 0)}</b></div><div class="note" style="text-align:right">9:30 AM – 4:00 PM New York<br>${marketOpen('US') ? '<span class="up">● Open now</span>' : 'Closed now'}</div></div>`;
}
function moversList(sc, kind) {
  const minT = S.minTurnover[S.mkt] || 0;
  let rows = sc.rows.filter(r => r && !r.err && isFinite(r.chg) && !(minT && r.turnover != null && r.turnover < minT));
  if (kind === 'gain') rows = rows.filter(r => r.chg > 0).sort((a, b) => b.chg - a.chg);
  else if (kind === 'lose') rows = rows.filter(r => r.chg < 0).sort((a, b) => a.chg - b.chg);
  else rows = rows.filter(r => isFinite(r.volx)).sort((a, b) => b.volx - a.volx);
  return rows.slice(0, 5);
}
function moversHTML(sc, kind) {
  if (!sc || !sc.rows) return '<div class="empty">Run a scan to see top movers.</div>';
  const L = moversList(sc, kind);
  return L.length ? `<div class="list">${L.map((r, k) => { const R = rateRow(r); return rowHTML(r.sym, kind === 'act' ? `Volume ${r.volx.toFixed(1)}× avg · ${nameOf(r.sym)}` : nameOf(r.sym), r.price, r.chg, R ? R.rating : null, R ? actLabel(R.action) : '', '', k + 1); }).join('')}</div>` : '<div class="empty">Nothing to show.</div>';
}
function picksHTML(sc) {
  if (!sc || !sc.rows) return '<div class="empty">Run a scan to rank stocks by setup quality.</div>';
  const top = rated(sc.rows, 'top').filter(x => x.rating >= 58).slice(0, 8);
  return `<div class="list">${top.map((x, k) => rowHTML(x.r.sym, nameOf(x.r.sym), x.r.price, x.r.chg, x.rating, x.label, tagsOf(x.r), k + 1)).join('') || '<div class="empty">No buys rated 58+ in the last scan.</div>'}</div><p class="note">Scan ${new Date(sc.at).toLocaleTimeString()}</p>`;
}

function vHome() {
  const m = MK[S.mkt], sc = S.scan[S.mkt], v = $('#view'), mkt = S.mkt;
  const QUICK = [['top', '⭐ Overall'], ['leaders', '🏆 Leaders'], ['breakout', '🚀 Breakouts'], ['near', '⏳ Near breakout'], ['patterns', '📐 Patterns'], ['intraday', '⚡ Intraday'], ['swing', 'Swing'], ['short', 'Short'], ['medium', 'Medium'], ['long', 'Long'], ['setups', '🧭 SMC / VCP'], ['cross', '✂️ EMA cross'], ['news', '📰 News'], ['sell', '🔻 Sells']];
  S.homeMv = S.homeMv || 'gain';
  const saved = S.saved[mkt];
  v.innerHTML = `<div class="search"><input id="q" placeholder="Search ${mkt === 'IN' ? 'any NSE stock or index' : 'any global stock, e.g. AAPL'}" autocomplete="off"></div>
  <div id="sres"></div>${mkt === 'IN' && !MS.ok() ? `<div class="warn" id="msBan" style="cursor:pointer">${MS.cfg().apiKey ? 'mStock session expired. Tap to log in.' : 'Connect mStock for live prices. Tap to set up.'}</div>` : ''}
  ${marketSummaryHTML(m)}
  ${window.flowsCardHTML ? flowsCardHTML() : ''}
  ${window.morningCardHTML ? morningCardHTML() : ''}
  ${window.tradesCardHTML ? tradesCardHTML() : ''}
  ${window.pfCardHTML ? pfCardHTML() : ''}
  ${window.paperCardHTML ? paperCardHTML() : ''}
  <div class="chips quick" id="quick">${QUICK.map(x => `<button data-q="${x[0]}">${x[1]}</button>`).join('')}</div>
  <h3>Top rated today <a id="goScan">${sc ? 'Rescan' : 'Run scan'}</a></h3><div id="picks">${picksHTML(sc)}</div>
  <h3>Market movers</h3><div class="mvtabs" id="mvtabs">${[['gain', '▲ Top gainers'], ['lose', '▼ Top losers'], ['act', '🔥 Most active']].map(x => `<button data-mv="${x[0]}" class="${S.homeMv === x[0] ? 'on' : ''}">${x[1]}</button>`).join('')}</div><div id="movers">${moversHTML(sc, S.homeMv)}</div>
  <h3>Watchlist</h3><div id="wl">${saved.length ? '<div class="list">' + saved.map(s => rowHTML(s, nameOf(s), null, null, null)).join('') + '</div>' : '<div class="empty">Tap ☆ on any stock to save it here.</div>'}</div>`;
  v.querySelectorAll('.itile').forEach(b => b.onclick = () => openDetail(b.dataset.sym));
  bindRows(v); $('#goScan').onclick = () => { go('scan'); runScan(); };
  v.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { S.scanFilter = b.dataset.q; S.scanFilters = [b.dataset.q]; go('scan'); if (!S.scan[S.mkt]) runScan(); });
  v.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { S.homeMv = b.dataset.mv; v.querySelectorAll('[data-mv]').forEach(x => x.classList.toggle('on', x === b)); $('#movers').innerHTML = moversHTML(S.scan[S.mkt], S.homeMv); bindRows($('#movers')); });
  const rg = S.regime[mkt]; if (rg) { const el = $('#regime'); if (el) el.innerHTML = regimeHTML(rg.v); } else regime(mkt).then(x => { const el = $('#regime'); if (el) el.innerHTML = regimeHTML(x); });
  setupSearch(); const mb = $('#msBan'); if (mb) mb.onclick = () => $('#gear').click();
  m.idx().forEach(async x => {
    try {
      const o = await getSpark(x[0]); if (S.mkt !== mkt) return;
      const set = (id, h) => { const e = $(id); if (e) e.innerHTML = h; };
      set('#ix_' + x[0], fmt(o.p) + (S.mkt === 'IN' && window.MS && MS.ok() && o.src === 'yf' ? ' <span class="wa" title="Yahoo fallback (not mStock)" style="font-size:9px">●</span>' : S.mkt === 'IN' && o.src === 'ms' ? ' <span class="up" title="mStock live" style="font-size:9px">●</span>' : '')); set('#ixc_' + x[0], chgPill(o.chg)); set('#isp_' + x[0], sparkSVG(o.c, o.up, 90, 30, true, o.pc));
    } catch (e) { const el = $('#ix_' + x[0]); if (el) el.innerHTML = '<span class="mu" style="font-size:12px">offline</span>'; }
  });
  hydrateRows($('#wl'), 30, true); hydrateRows($('#picks'), 8); hydrateRows($('#movers'), 5);
  if (!navigator.onLine) v.insertAdjacentHTML('afterbegin', '<div class="warn">You are offline.</div>');
  window.bindMorningCard && bindMorningCard(); window.bindTradesCard && bindTradesCard(); window.bindPfCard && bindPfCard(); window.bindPaperCard && bindPaperCard(); window.bindFlowsCard && bindFlowsCard();
}

function vScan() {
  const sc = S.scan[S.mkt], f = S.scanFilter || 'top', hasCat = hasCat_();
  const syms = uniSyms(), have = sc ? new Set(sc.rows.map(r => r.sym)) : new Set(), missing = syms.filter(s => !have.has(s));
  $('#view').innerHTML = `<div class="pick2"><label><span>Market cap</span><select id="selSize">${(S.mkt === 'US' ? SIZES_US : SIZES_IN).filter(x => hasCat || !['M', 'S', 'U', 'L'].includes(x[0]) || (S.mkt === 'IN' && x[0] === 'L')).map(x => `<option value="${x[0]}" ${S.uni.size === x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select></label>
   <label><span>Sector</span><select id="selSec" ${!hasCat || S.uni.size === 'FO' ? 'disabled' : ''}><option value="">All sectors</option>${sectors().map(s => `<option value="${esc(s)}" ${S.uni.sector === s ? 'selected' : ''}>${esc(secName(s))}</option>`).join('')}</select></label></div>
  <div class="card scanhd"><div style="display:flex;gap:10px;align-items:center"><div style="flex:1;min-width:0"><b>${esc(uniLabel())}</b><div class="note">${syms.length.toLocaleString()} stocks${missing.length && sc ? ` · ${missing.length} not scanned yet` : ''}</div></div>
   <button class="btn" id="run" ${S.scanning ? 'disabled' : ''}>${S.scanning ? '<span class="spin"></span>' : missing.length < syms.length && sc ? `Scan ${missing.length ? missing.length + ' new' : 'again'}` : 'Scan'}</button></div>
  <div class="prog" id="prog" style="display:${S.scanning ? '' : 'none'}"><div style="width:${S.scanPct || 0}%"></div></div><div class="note" id="pmsg">${S.scanning ? S.scanMsg || 'Scanning…' : sc ? `Last scan ${new Date(sc.at).toLocaleString()} · ${sc.rows.length} stocks · ${sc.src || 'Yahoo Finance'}` : ''}</div></div>
  <div class="chips wrap fchips">${FILTERS.map(x => `<button data-f="${x[0]}" class="${scanFs().includes(x[0]) ? 'on' : ''}">${x[1]}</button>`).join('')}</div>
  ${scanFs().length > 1 ? `<div class="fmode"><span class="note">${scanFs().length} filters ·</span><button data-m="all" class="${S.scanMode !== 'any' ? 'on' : ''}">Match all</button><button data-m="any" class="${S.scanMode === 'any' ? 'on' : ''}">Match any</button><button data-m="clear">Clear</button></div>` : '<div class="note fhint">Tip: tap more than one filter to combine them (e.g. Intraday + Swing + Leaders).</div>'}<div id="sl"></div>`;
  $('#run').onclick = () => runScan(missing.length && sc && missing.length < syms.length ? missing : syms);
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { // tap = add/remove; Overall resets
    const k = b.dataset.f; let fs = scanFs().filter(x => x !== 'top');
    if (k === 'top') fs = ['top']; else fs = fs.includes(k) ? fs.filter(x => x !== k) : [...fs, k];
    S.scanFilters = fs.length ? fs : ['top']; S.scanFilter = S.scanFilters[0]; vScan(); });
  document.querySelectorAll('.fmode [data-m]').forEach(b => b.onclick = () => { if (b.dataset.m === 'clear') { S.scanFilters = ['top']; S.scanFilter = 'top'; } else S.scanMode = b.dataset.m; vScan(); });
  const ss = $('#selSize'); if (ss) ss.onchange = () => { S.uni = { size: ss.value, sector: ss.value === 'FO' ? '' : S.uni.sector }; store.set('uniBy', S.uniBy); vScan(); };
  const se = $('#selSec'); if (se) se.onchange = () => { S.uni.sector = se.value; store.set('uniBy', S.uniBy); vScan(); };
  drawScan();
}
// selected filters (several can be on at once)
function scanFs() { const a = Array.isArray(S.scanFilters) && S.scanFilters.length ? S.scanFilters : [S.scanFilter || 'top']; return a.includes(S.scanFilter || 'top') || a.length > 1 ? a : [S.scanFilter || 'top']; }
// combine filters: Match all = stock must pass every selected filter; Match any = at least one. Ranked by the average of the
// selected horizon ratings (Intraday/Swing/Short/Medium/Long); if no horizon is selected, by the overall rating.
function ratedMulti(rows, fs, mode) {
  const maps = fs.map(k => new Map(rated(rows, k).map(x => [x.r.sym, x]))), hz = fs.filter(k => HZ.includes(k)), out = [];
  const syms = new Set(); maps.forEach(m => m.forEach((_, s) => syms.add(s)));
  const SH = { intraday: 'I', swing: 'Sw', short: 'Sh', medium: 'M', long: 'L' };
  for (const s of syms) {
    const items = maps.map(m => m.get(s)); if (mode !== 'any' && items.some(x => !x)) continue;
    const r = (items.find(Boolean)).r;
    const hr = hz.map(k => { const x = items[fs.indexOf(k)]; if (x) return x.rating; const Rh = hzRate(r, k); return Rh ? Rh.rating : null; });
    const ok = hr.filter(x => x != null), sellOnly = fs.every(k => k === 'sell');
    const score = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : (rateRow(r) || {}).rating;
    if (score == null) continue;
    const parts = fs.map((k, i) => HZ.includes(k) ? `${SH[k]} ${hr[hz.indexOf(k)] ?? '–'}` : `${items[i] ? '✓' : '✗'} ${(FILTERS.find(z => z[0] === k) || [k, k])[1].replace(/^[^A-Za-z]+/, '')}`);
    out.push({ r, rating: score, label: hz.length > 1 ? 'AVG' : hz.length ? HZL[hz[0]] : 'COMBINED', sub: parts.join(' · '), hz: hz[0] || 'overall', match: items.filter(Boolean).length });
  }
  const sellOnly = fs.every(k => k === 'sell');
  return out.sort((a, b) => (mode === 'any' ? b.match - a.match : 0) || (sellOnly ? a.rating - b.rating : b.rating - a.rating));
}
// stocks a fresh list needs re-checked: top 40 candidates per selected filter (ignoring staleness) whose analysis is >5 min old,
// or (Intraday) not yet rated on today's 5-minute candles
function verifyNeed(fs, sc, inUni, all) {
  S.verified = S.verified || {}; const key = S.mkt + '|' + fs.join('+') + '|' + uniLabel();
  if (S.verified[key] && Date.now() - S.verified[key] < 3 * 60e3) return [];
  const rows = sc.rows.filter(r => inUni.has(r.sym) && !r.err), old = r => Date.now() - (r.at || sc.at || 0) > 5 * 60e3, need = new Set();
  for (const k of fs) {
    let cand;
    if (HZ.includes(k)) cand = rows.map(r => [r, (hzRate(r, k) || {}).rating || 0]).sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
    else cand = rated(rows, k).slice(0, 40).map(x => x.r);
    for (const r of cand) if (old(r) || (k === 'intraday' && !freshIntra(r))) need.add(r.sym);
  }
  for (const x of all.slice(0, 40)) if (old(x.r)) need.add(x.r.sym);
  return [...need].slice(0, 80);
}
function verifyHTML(fl) { const v = S.verifying || { done: 0, total: 0 }; return `<div class="card verify"><b>${esc(fl)}</b><div class="note" style="margin-top:6px"><span class="spin"></span> Updating ratings with live prices${S.mkt === 'IN' ? ' and today\'s 5-min candles' : ''}… ${v.done}/${v.total}</div><div class="prog"><div style="width:${v.total ? 100 * v.done / v.total : 0}%"></div></div><div class="note">So the list matches each stock's page. Takes a few seconds.</div></div>`; }
async function startVerify(need, fkey) {
  if (S.verifying) return; const mkt = S.mkt, key = mkt + '|' + scanFs().join('+') + '|' + uniLabel();
  S.verifying = { done: 0, total: need.length };
  try {
    const Q = await msQuotes(need, mkt);
    await pool(need, 6, async s => { try { const q = await dailyQuick(s, mkt, Q); if (!q.err) upsertRow(mkt, Object.assign({ sym: s, at: Date.now() }, q)); } catch (e) {}
      S.verifying.done++; const pr = document.querySelector('.verify .prog div'), n = document.querySelector('.verify .note'); if (pr) pr.style.width = (100 * S.verifying.done / S.verifying.total) + '%'; if (n) n.lastChild.textContent = ` Updating ratings with live prices… ${S.verifying.done}/${S.verifying.total}`; });
  } finally { S.verifying = null; S.verified = S.verified || {}; S.verified[key] = Date.now(); }
  if (S.tab === 'scan' && S.mkt === mkt) drawScan();
}
// Tomorrow filter: when to act + the measured track record (data/btst_stats.json from GitHub)
function btstNoteHTML() {
  const t = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()), open = marketOpen('IN');
  const when = open ? (t < '14:45' ? '⏳ Provisional — today\'s candle is still forming. The list firms up after 3:00 PM.' : '🌙 Near the close: buy 3:15–3:25 PM near the price shown. Next day: sell in the first 15 minutes after the open — on 5 years of data the edge is the opening gap and it fades by the close.')
    : '🌙 Based on the last session\'s close — for the next trading day. Buy only if it holds up into the close again; otherwise skip.';
  const st = store.get('btstStats', null), b = st && st.bands && st.bands.find(x => x.band === '70–79'), b8 = st && st.bands && st.bands.find(x => x.band === '80+'), base = st && st.bands && st.bands.find(x => x.band === 'below 60');
  const rec = b8 && b8.n ? `History (${st.stocks} stocks, ~5 yrs): score 80+ → next-day open avg ${b8.avgGap > 0 ? '+' : ''}${b8.avgGap}% (other days ${base ? (base.avgGap > 0 ? '+' : '') + base.avgGap + '%' : '–'}), but by the close only ${b8.avgRet > 0 ? '+' : ''}${b8.avgRet}% (up ${b8.upPct}% of days)${b ? ` · 70–79: open ${b.avgGap > 0 ? '+' : ''}${b.avgGap}%` : ''}. Costs ~0.25% a round trip, so this is a small edge — size small.` : 'Track record appears after the first GitHub run.';
  return `<div class="card btst-note"><div>${when}</div><div class="note" style="margin-top:6px">${esc(rec)}</div></div>`;
}
function drawScan() {
  const sc = S.scan[S.mkt], el = $('#sl'); if (!el) return;
  if (!sc) { el.innerHTML = '<div class="empty">Pick a group and tap <b>Scan</b>.<br>Lists are ranked by rating, highest first.</div>'; return; }
  const inUni = new Set(uniSyms()), fs = scanFs(), f = fs.length > 1 ? fs.join('+') + ':' + (S.scanMode || 'all') : fs[0], fl = fs.map(k => (FILTERS.find(z => z[0] === k) || [k, k])[1]).join(' + ');
  // Order is frozen once a list is shown: opening a stock (which re-analyses it with the latest data), live re-rating or a
  // background auto scan updates the numbers in place but never moves or drops a stock. Re-sorts only on a new scan you
  // run, the "Re-rank" button, or a different list/universe.
  const all = fs.length > 1 ? ratedMulti(sc.rows.filter(r => inUni.has(r.sym)), fs, S.scanMode || 'all') : rated(sc.rows.filter(r => inUni.has(r.sym)), f); let rows = all.slice(0, 150), fresh = 0;
  const fkey = [S.mkt, f, uniLabel(), S.minTurnover[S.mkt] || 0].join('|'); S.frozen = S.frozen || {};
  const fz = S.frozen[fkey];
  // market open + new list: re-check the candidates with the live price and today's 5-min candles BEFORE ranking, so the
  // number in the list is the number on the stock page (the list otherwise comes from a scan that can be 30+ min old)
  if (!fz && marketOpen(S.mkt) && !S.scanning) { const need = verifyNeed(fs, sc, inUni, all); if (need.length) { startVerify(need, fkey); el.innerHTML = verifyHTML(fl); return; } }
  if (fz) {
    const by = new Map(all.map(x => [x.r.sym, x])), rowBy = new Map(sc.rows.map(r => [r.sym, r]));
    const keep = s => { const x = by.get(s); if (x) return x; const r = rowBy.get(s); if (!r) return null;
      if (fs.length > 1) { const m = ratedMulti([r], fs, 'any')[0]; return m ? Object.assign(m, { sub: m.sub + ' · changed since the list was made' }) : null; }
      if (HZ.includes(f)) { const Rh = hzRate(r, f); return Rh && { r, rating: Rh.rating, label: HZL[f], R: Rh, sub: `${actLabel(Rh.action)} · changed since the list was made`, hz: f }; }
      const R = rateRow(r); return R && { r, rating: R.rating, label: actLabel(R.action), R, sub: 'Changed since the list was made', hz: 'overall' }; };
    rows = fz.map(keep).filter(Boolean); fresh = all.filter(x => !fz.includes(x.r.sym)).slice(0, 150 - rows.length).length;
  } else S.frozen[fkey] = rows.map(x => x.r.sym);
  const desc = f === 'sell' ? 'Lowest rating first.' : f === 'patterns' ? 'Only patterns with a proven edge. Open a stock to see the lines.' : f === 'leaders' ? 'Positive alpha, rises more than it falls with the market. <a class="help" data-help="leader">What is this?</a>' : f === 'near' ? 'Just under resistance; buy only on a breakout close.' : '';
  el.innerHTML = rows.length ? `<div class="lhd"><div><b>${esc(fl)}</b><span class="lcnt">${rows.length}${rows.length >= 150 ? '+' : ''} stocks</span></div><span class="note">${(() => { const ag = rows.map(x => Date.now() - (x.r.at || sc.at)).sort((p, q) => p - q), m = v => v < 60e3 ? 'just now' : v < 3600e3 ? Math.round(v / 60e3) + ' min' : Math.round(v / 3600e3) + ' h'; return ag.length ? `Ratings ${m(ag[0])}–${m(ag[ag.length - 1])} old${marketOpen() ? ' · refreshing ~25/min' : ''}` : 'Scan ' + new Date(sc.at).toLocaleTimeString(); })()}${fz ? ` · <a href="#" id="rerank">↻ Re-rank${fresh ? ` (+${fresh} new)` : ''}</a>` : ''}</span></div>${desc ? `<p class="note ldesc">${desc}</p>` : ''}<div class="list">${rows.map((x, k) => rowHTML(x.r.sym, x.sub || nameOf(x.r.sym), x.r.price, x.r.chg, x.rating, x.label, tagsOf(x.r), k + 1)).join('')}</div>`
    : `<div class="empty">Nothing in "${esc(fl)}" for ${esc(uniLabel())}.${f === 'news' ? '<br>News loads for the top-rated stocks after each scan.' : ''}</div>`;
  if (fs.includes('btst')) { const hd = el.querySelector('.lhd'); if (hd) hd.insertAdjacentHTML('afterend', btstNoteHTML()); }
  bindRows(el, fs.find(k => HZ.includes(k)) || 'overall');
  const rr = $('#rerank'); if (rr) rr.onclick = e => { e.preventDefault(); delete S.frozen[fkey]; drawScan(); };
  hydrateRows(el, 12);
}

// app.js may already have rendered the home tab with its own vHome before this file loaded; redraw with ours.
try { if (S.tab === 'home' && document.querySelector('#view .idx') && !document.querySelector('#view .ms')) vHome(); } catch (e) {}
