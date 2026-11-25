/* Stock page (Yahoo / Google Finance style). Owned by the stock-page agent.
   Redefines vDetail, drawDetail, drawPreview from app.js; adds dc* helpers. */
'use strict';

// ---------- small helpers ----------
const DC_RANGES = [['1D', '1d', '5m'], ['5D', '5d', '15m'], ['1M', '1mo', '1h'], ['6M', 'D', 182], ['YTD', 'D', 'ytd'], ['1Y', 'D', 365], ['5Y', '5y', '1wk'], ['MAX', 'max', '1mo']];
const DC_LBL = { '1D': 'today', '5D': 'past 5 days', '1M': 'past month', '6M': 'past 6 months', YTD: 'year to date', '1Y': 'past year', '5Y': 'past 5 years', MAX: 'all time' };
const DC_EMA = [['e20', 'EMA 20', '#4c9aff'], ['e50', 'EMA 50', '#f5b301'], ['e200', 'EMA 200', '#c084fc']];
const PAT_SHORT = { 'Head & shoulders': 'H&S', 'Inverse head & shoulders': 'iH&S', 'Double top': 'DT', 'Double bottom': 'DB', 'Bull flag': 'Flag', 'Bear flag': 'Flag', 'Ascending triangle': 'Tri', 'Descending triangle': 'Tri', 'Symmetrical triangle': 'Tri' };
function dcVar(n, d) { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || d; }
function dcAlpha(col, a) {
  col = String(col).trim();
  let m = col.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map(x => x + x).join(''); const n = parseInt(h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
  m = col.match(/^rgba?\(([^)]+)\)$/i); if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3); return `rgba(${p.join(',')},${a})`; }
  return col;
}
function dcTzOff(tz, tSec) {
  try { const d = new Date(tSec * 1000), p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) p[x.type] = x.value;
    return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 1000; } catch (e) { return 0; }
}
const dcTz = mkt => (S.detail && S.detail.meta && S.detail.meta.exchangeTimezoneName) || MK[mkt].tz;
function dcDay(D, k, tz) { if (D.day && D.day[k]) return D.day[k]; return new Date((D.t[k] + dcTzOff(tz, D.t[k])) * 1000).toISOString().slice(0, 10); }
function dcEma(a, n) { const o = [], k = 2 / (n + 1); let p = NaN, s = 0; a.forEach((x, i) => { if (i < n) { s += x; if (i === n - 1) p = s / n; } else p = x * k + p * (1 - k); o.push(i >= n - 1 ? p : NaN); }); return o; }
function dcVol(v, mkt) {
  if (!isFinite(v)) return '–';
  if (mkt === 'IN') return v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v) + '';
  return v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v) + '';
}
function dcExch(sym, mkt) {
  const m = (S.detail && S.detail.meta) || {};
  if (mkt === 'IN') return window.IDX_IN.some(x => x[0] === sym) ? 'NSE Index · INR' : 'NSE · INR';
  return `${m.fullExchangeName || m.exchangeName || 'US'} · ${m.currency || 'USD'}`;
}
function dcTimeStr(tSec, mkt, withDate) {
  try { return new Date(tSec * 1000).toLocaleString('en-IN', { timeZone: MK[mkt].tz, hour: 'numeric', minute: '2-digit', ...(withDate ? { day: 'numeric', month: 'short' } : {}) }) + (mkt === 'IN' ? ' IST' : ' ET'); } catch (e) { return ''; }
}

// ---------- page shell ----------
async function vDetail() {
  const v = $('#view'), { sym } = S.detail, mkt = S.detail.mkt || S.mkt, saved = S.saved[S.mkt].includes(sym);
  v.innerHTML = `<div class="dpage">
   <div class="dq-bar"><button class="back" id="back" aria-label="Back">←</button><div class="dq-sp"></div>
    <button class="dq-ic" id="palert" title="Price alert" aria-label="Price alert">⏰</button><button class="dq-ic star" id="star" title="Save" aria-label="Save">${saved ? '★' : '☆'}</button></div>
   <div class="dq-id"><div class="dq-sym">${esc(sym)}<span class="dq-ex" id="dqex">${esc(dcExch(sym, mkt))}</span></div><div class="dq-nm">${esc(nameOf(sym) || '')}</div></div>
   <div id="dbody"><div class="dq-skel"><div class="sk w40"></div><div class="sk w25"></div><div class="sk ch"></div><div class="empty"><span class="spin"></span> Analysing ${esc(sym)}…</div></div></div></div>`;
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

// ---------- quote block ----------
function dcQuote(isRefresh) {
  const { A, D, meta = {}, at, mkt } = S.detail, c = cur(), open = marketOpen(mkt);
  const prevC = isFinite(A.chg) ? A.price / (1 + A.chg / 100) : A.prev, dAbs = A.price - prevC, up = dAbs >= 0;
  const px = S.detail.px || {}, tm = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const srcTag = px.src === 'ms' ? 'mStock' : px.src === 'cl' ? 'official close' : 'Yahoo (delayed)';
  // closed market: show the SESSION date of the close (daily bars are stamped 09:15, which would read like a wrong time)
  const dayLbl = d => { try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch (e) { return d || ''; } };
  const closeDay = px.day || (D.day && D.day[D.day.length - 1]);
  const status = open ? `<span class="live on"><i></i><span>Live</span></span> <span class="mu">· ${tm} · ${srcTag} · ${isRefresh ? 'updated' : 'as of'} · full refresh every 30s</span>`
    : `<span class="live"><i></i><span>${px.idle ? 'Last close' : 'At close'}</span></span> <span class="mu">· ${px.official === false ? 'last price' : 'official close'} ${esc(dayLbl(closeDay))}${mkt === 'IN' ? ' · NSE' : ''}${px.idle ? ' · market not open yet' : ''}</span>`;
  const ex = $('#dqex'); if (ex) ex.textContent = dcExch(S.detail.sym, mkt);
  return `<div class="dq-px"><span class="dq-big">${c}${fmt(A.price)}</span>
    <span class="dq-chg ${up ? 'up' : 'dn'}">${up ? '+' : '−'}${fmt(Math.abs(dAbs))} (${up ? '+' : '−'}${Math.abs(A.chg).toFixed(2)}%) <span class="dq-arr">${up ? '▲' : '▼'}</span></span></div>
   <div class="dq-st">${status}</div>
   <div class="dq-src ${/mStock/.test(S.detail.src) ? 'up' : 'mu'}">Source: ${esc(S.detail.src)}${S.detail.msErr ? ` <span class="wa">· mStock: ${esc(S.detail.msErr)}</span>` : ''}</div>`;
}

// ---------- chart card (built once per stock, data swapped per range) ----------
function dcChartShell() {
  const ov = store.get('dcOv', { e20: 0, e50: 0, e200: 0, pat: 1, lv: 1 }), type = store.get('dcType', 'area');
  const cv = S.detail.cv || (S.detail.cv = { range: '6M', cache: {} });
  return `<div class="dc" id="dcCard">
   <div class="dc-tabs" id="dcTabs">${DC_RANGES.map(([k]) => `<button data-r="${k}" class="${k === cv.range ? 'on' : ''}">${k}</button>`).join('')}</div>
   <div class="dc-meta"><div class="dc-pc" id="dcPc">&nbsp;</div>
    <div class="dc-type" id="dcType"><button data-ty="area" class="${type === 'area' ? 'on' : ''}" title="Area">〰</button><button data-ty="candle" class="${type === 'candle' ? 'on' : ''}" title="Candles">▮▯</button></div>
    <button class="dc-fs" id="openChart" title="Full-screen chart" aria-label="Full-screen chart">⛶</button></div>
   <div class="dc-wrap"><div id="pv" class="dc-chart"></div><div class="dc-tip" id="dcTip"></div><div class="dc-load" id="dcLoad"><span class="spin"></span></div><div class="dc-msg" id="dcMsg"></div></div>
   <div class="dc-ov" id="dcOv">${DC_EMA.map(([k, n, col]) => `<button data-ov="${k}" class="${ov[k] ? 'on' : ''}"><i style="background:${col}"></i>${n}</button>`).join('')}
    <button data-ov="pat" class="${ov.pat ? 'on' : ''}"><i style="background:#e879f9"></i>Patterns</button><button data-ov="lv" class="${ov.lv ? 'on' : ''}"><i style="background:var(--ac)"></i>Levels</button></div>
  </div>`;
}
function dcBind() {
  const cv = S.detail.cv;
  document.querySelectorAll('#dcTabs [data-r]').forEach(b => b.onclick = () => { if (cv.range === b.dataset.r) return; cv.range = b.dataset.r; document.querySelectorAll('#dcTabs [data-r]').forEach(x => x.classList.toggle('on', x === b)); dcLoad(false); });
  document.querySelectorAll('#dcType [data-ty]').forEach(b => b.onclick = () => { store.set('dcType', b.dataset.ty); document.querySelectorAll('#dcType [data-ty]').forEach(x => x.classList.toggle('on', x === b)); drawPreview(true); });
  document.querySelectorAll('#dcOv [data-ov]').forEach(b => b.onclick = () => { const ov = store.get('dcOv', { e20: 0, e50: 0, e200: 0, pat: 1, lv: 1 }), k = b.dataset.ov; ov[k] = ov[k] ? 0 : 1; store.set('dcOv', ov); store.set('pvPat', !!ov.pat); b.classList.toggle('on', !!ov[k]); drawPreview(true); });
  $('#openChart').onclick = () => ChartView.open({ sym: S.detail.sym, mkt: S.detail.mkt, levels: S.detail.levels, hz: S.detail.levelsHz });
}
// range data → { bars, ema, daily, s0 (index into S.detail.D when sliced from it), intra, base }
async function dcData(range, force) {
  const cv = S.detail.cv, hit = cv.cache[range];
  if (hit && !force && Date.now() - hit.at < 5 * 60e3) return hit;
  const { D, A, sym, mkt } = S.detail, tz = dcTz(mkt), spec = DC_RANGES.find(x => x[0] === range);
  let out;
  const fromD = () => { // slice the 2y daily history the analysis used (same Yahoo endpoint) so patterns/EMAs line up
    const n = D.c.length, lastDay = dcDay(D, n - 1, tz);
    let s0 = 0;
    if (spec[2] === 'ytd') { const y = lastDay.slice(0, 4) + '-01-01'; s0 = n - 1; while (s0 > 0 && dcDay(D, s0 - 1, tz) >= y) s0--; }
    else { const days = typeof spec[2] === 'number' ? spec[2] : 31, cut = D.t[n - 1] - days * 86400; s0 = n - 1; while (s0 > 0 && D.t[s0 - 1] >= cut) s0--; }
    const bars = [], ema = { e20: [], e50: [], e200: [] }; let last = '';
    for (let k = s0; k < n; k++) { const t = dcDay(D, k, tz); if (t <= last) continue; last = t; bars.push({ time: t, open: D.o[k], high: D.h[k], low: D.l[k], close: D.c[k], volume: D.v[k] || 0, k }); for (const e of ['e20', 'e50', 'e200']) ema[e].push(A.I[e][k]); }
    return { bars, ema, daily: true, s0, base: s0 > 0 ? D.c[s0 - 1] : D.c[s0] };
  };
  if (spec[1] === 'D') out = fromD();
  else {
    try {
      const { D: F, meta } = await chart(ySym(sym, mkt), spec[1], spec[2]);
      const intra = /m$|h$/.test(spec[2]), off = intra && F.t.length ? dcTzOff(meta.exchangeTimezoneName || tz, F.t[F.t.length - 1]) : 0;
      const E = { e20: dcEma(F.c, 20), e50: dcEma(F.c, 50), e200: dcEma(F.c, 200) };
      let from = 0; if (range === '1D') { const ld = F.day[F.day.length - 1]; from = F.day.indexOf(ld); }
      const bars = [], ema = { e20: [], e50: [], e200: [] }; let last = null;
      for (let k = from; k < F.c.length; k++) { const t = intra ? F.t[k] + off : F.day[k]; if (last != null && t <= last) continue; last = t; bars.push({ time: t, open: F.o[k], high: F.h[k], low: F.l[k], close: F.c[k], volume: F.v[k] || 0 }); for (const e in E) ema[e].push(E[e][k]); }
      if (bars.length < 2) throw new Error('no bars');
      const prevC = isFinite(A.chg) ? A.price / (1 + A.chg / 100) : A.prev;
      out = { bars, ema, daily: false, intra, base: range === '1D' ? prevC : (from > 0 ? F.c[from - 1] : F.c[0]) };
      if (range === '1D' && !(Math.abs(bars[0].open / prevC - 1) < 0.25)) out.base = bars[0].open; // feed mismatch guard
      if (range === '1D') { out.prevClose = out.base; const lb = bars[bars.length - 1]; if (isFinite(A.price) && Math.abs(A.price / lb.close - 1) < 0.05) lb.close = A.price; }
    } catch (e) {
      if (range === '1D' || range === '5D') { // fall back to the intraday bars the analysis loaded
        const I = S.detail.intra; if (!I || !I.c || I.c.length < 2) throw e;
        const off = dcTzOff(tz, I.t[I.t.length - 1]), bars = [], ema = { e20: [], e50: [], e200: [] }, E = { e20: dcEma(I.c, 20), e50: dcEma(I.c, 50), e200: dcEma(I.c, 200) };
        const lastDay = Math.floor((I.t[I.t.length - 1] + off) / 86400); let last = null;
        for (let k = 0; k < I.c.length; k++) { const t = I.t[k] + off; if (range === '1D' && Math.floor(t / 86400) !== lastDay) continue; if (last != null && t <= last) continue; last = t; bars.push({ time: t, open: I.o[k], high: I.h[k], low: I.l[k], close: I.c[k], volume: I.v[k] || 0 }); for (const x in E) ema[x].push(E[x][k]); }
        const prevC = isFinite(A.chg) ? A.price / (1 + A.chg / 100) : A.prev;
        out = { bars, ema, daily: false, intra: true, base: range === '1D' ? prevC : bars[0].close, prevClose: range === '1D' ? prevC : null, note: 'Intraday bars from the analysis feed' };
      } else { out = fromD(); out.note = `${range} history unavailable (${e.message}); showing the 2-year daily history.`; }
    }
  }
  out.at = Date.now(); cv.cache[range] = out; return out;
}
async function dcLoad(keep, force) {
  const cv = S.detail.cv, my = cv.range, sym = S.detail.sym, ld = $('#dcLoad');
  if (ld && !keep) ld.style.display = '';
  try { const r = await dcData(my, force); if (S.detail.sym !== sym || cv.range !== my || !$('#pv')) return; cv.cur = r; drawPreview(keep); $('#dcMsg').textContent = r.note || ''; }
  catch (e) { if (S.detail.sym !== sym || cv.range !== my) return; cv.cur = null; drawPreview(false); const m = $('#dcMsg'); if (m) m.innerHTML = `Could not load ${my} chart: ${esc(e.message)}`; }
  const l2 = $('#dcLoad'); if (l2 && cv.range === my) l2.style.display = 'none';
}

// redraw the in-page chart from S.detail.cv.cur (keep = keep the user's zoom/pan)
function drawPreview(keep) {
  const el = $('#pv'), cv = S.detail && S.detail.cv; if (!el || !window.LightweightCharts || !cv) return;
  let vr = null; if (cv.ch) { try { if (keep) vr = cv.ch.timeScale().getVisibleLogicalRange(); } catch (e) {} try { cv.ch.remove(); } catch (e) {} cv.ch = null; }
  el.innerHTML = '';
  const r = cv.cur, pc = $('#dcPc'); if (!r || !r.bars.length) { if (pc) pc.innerHTML = '&nbsp;'; return; }
  const { A, D, mkt } = S.detail, LW = window.LightweightCharts, B = r.bars, n = B.length;
  const ov = store.get('dcOv', { e20: 0, e50: 0, e200: 0, pat: 1, lv: 1 }), type = store.get('dcType', 'area');
  const UP = dcVar('--up', '#22c55e'), DN = dcVar('--dn', '#ef4444'), TX2 = dcVar('--text2', '') || dcVar('--mu', '#8a97a6'), LN = dcVar('--line', '') || dcVar('--ln', '#1e2935'), AC = dcVar('--ac', '#4c9aff');
  const last = B[n - 1].close, chgAbs = last - r.base, chgP = (last / r.base - 1) * 100, upP = chgAbs >= 0, col = upP ? UP : DN;
  if (pc) pc.innerHTML = isFinite(chgP) ? `<b class="${upP ? 'up' : 'dn'}">${upP ? '+' : '−'}${Math.abs(chgP).toFixed(2)}%</b> <span class="${upP ? 'up' : 'dn'}">${upP ? '▲' : '▼'} ${cur()}${fmt(Math.abs(chgAbs))}</span> <span class="mu">${DC_LBL[cv.range]}</span>` : '&nbsp;';
  const ch = LW.createChart(el, {
    autoSize: true, layout: { background: { type: 'solid', color: 'transparent' }, textColor: TX2, fontSize: 11, fontFamily: 'system-ui, Roboto, sans-serif', attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: dcAlpha(LN, 0.35) } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.14 } },
    timeScale: { borderVisible: false, timeVisible: !!r.intra, secondsVisible: false, rightOffset: r.daily ? 4 : 1, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
    crosshair: { mode: 0, vertLine: { color: dcAlpha(TX2, 0.6), width: 1, style: 2, labelVisible: false }, horzLine: { color: dcAlpha(TX2, 0.45), width: 1, style: 2 } },
    localization: { priceFormatter: p => fmt(p) },
    handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false, pressedMouseMove: true },
    handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: true },
    kineticScroll: { touch: true, mouse: false },
  });
  cv.ch = ch;
  // volume (faint, bottom)
  const vs = ch.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  ch.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });
  vs.setData(B.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? dcAlpha(UP, 0.2) : dcAlpha(DN, 0.2) })));
  let main;
  if (type === 'candle') { main = ch.addCandlestickSeries({ upColor: UP, downColor: DN, wickUpColor: UP, wickDownColor: DN, borderVisible: false, priceLineColor: col, priceLineStyle: 2 }); main.setData(B.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))); }
  else { main = ch.addAreaSeries({ lineColor: col, topColor: dcAlpha(col, 0.32), bottomColor: dcAlpha(col, 0.0), lineWidth: 2, priceLineColor: col, priceLineStyle: 2, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: '#fff' }); main.setData(B.map(b => ({ time: b.time, value: b.close }))); }
  if (r.prevClose) main.createPriceLine({ price: r.prevClose, color: dcAlpha(TX2, 0.7), lineStyle: 1, lineWidth: 1, axisLabelVisible: false, title: 'Prev' });
  for (const [k, , c] of DC_EMA) if (ov[k]) { const ls = ch.addLineSeries({ color: c, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); ls.setData(B.map((b, j) => ({ time: b.time, value: r.ema[k][j] })).filter(p => isFinite(p.value))); }
  // levels from the selected horizon + support / resistance
  if (ov.lv) {
    const L = S.detail.levels; if (L) [[L.entry, AC, 'E', 0], [L.stop, DN, 'SL', 2], [L.t1, UP, 'T1', 2], [L.t2, UP, 'T2', 2]].forEach(([price, color, title, ls]) => isFinite(price) && main.createPriceLine({ price, color, lineStyle: ls, lineWidth: 1, title }));
    for (const z of A.srLevels || []) main.createPriceLine({ price: z.p, color: z.kind === 'R' ? dcAlpha(DN, 0.55) : dcAlpha(UP, 0.55), lineStyle: 1, lineWidth: 1, title: z.kind === 'R' ? 'R' : 'S' });
  }
  // chart patterns (daily ranges only: indexes refer to the daily history)
  const patBtn = document.querySelector('#dcOv [data-ov=pat]'); if (patBtn) patBtn.classList.toggle('na', !r.daily);
  if (ov.pat && r.daily) {
    const s0 = r.s0, tz = dcTz(mkt), nD = D.c.length, marks = [], tOf = k => dcDay(D, k, tz);
    for (const p of A.chartPats || []) {
      for (const Ln of p.lines) { const pts = []; let lk = -1; for (const [ix, val] of Ln.pts) { const k = Math.round(ix); if (k < s0 || k <= lk || k >= nD) continue; lk = k; pts.push({ time: tOf(k), value: val }); }
        if (pts.length >= 2) ch.addLineSeries({ color: Ln.color, lineWidth: Ln.w || 2, lineStyle: Ln.dash ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(pts); }
      for (const m of p.marks) if (m.i >= s0 && m.i < nD) marks.push({ time: tOf(m.i), position: m.pos === 'above' ? 'aboveBar' : 'belowBar', color: p.b > 0 ? UP : DN, shape: 'circle', text: m.t });
      const end = Math.round(Math.max(...p.lines.flatMap(Ln => Ln.pts.map(q => q[0])))); if (end >= s0) marks.push({ time: tOf(Math.min(end, nD - 1)), position: p.b < 0 ? 'aboveBar' : 'belowBar', color: '#e879f9', shape: p.b > 0 ? 'arrowUp' : p.b < 0 ? 'arrowDown' : 'square', text: PAT_SHORT[p.n] || p.n });
    }
    marks.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0); main.setMarkers(marks);
  }
  // crosshair read-out (Google-style: price, change from period start, date)
  const tip = $('#dcTip'), base = r.base;
  const tLabel = t => {
    if (typeof t === 'number') return new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const d = typeof t === 'string' ? new Date(t + 'T00:00:00Z') : new Date(Date.UTC(t.year, t.month - 1, t.day));
    return d.toLocaleDateString('en-GB', cv.range === 'MAX' ? { timeZone: 'UTC', month: 'short', year: 'numeric' } : { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };
  ch.subscribeCrosshairMove(p => {
    if (!tip) return; const d = p && p.time != null && p.seriesData && p.seriesData.get(main);
    if (!d) { tip.style.display = 'none'; return; }
    const v = d.value != null ? d.value : d.close, cp = (v / base - 1) * 100;
    tip.innerHTML = `<b>${cur()}${fmt(v)}</b> <span class="${cp >= 0 ? 'up' : 'dn'}">${cp >= 0 ? '+' : ''}${cp.toFixed(2)}%</span>${d.open != null ? `<div class="mu">O ${fmt(d.open)} · H ${fmt(d.high)} · L ${fmt(d.low)}</div>` : ''}<div class="mu">${esc(tLabel(p.time))}</div>`;
    tip.style.display = 'block';
  });
  if (vr) ch.timeScale().setVisibleLogicalRange(vr); else ch.timeScale().fitContent();
}

// ---------- stats ----------
function dcBar(lo, hi, v) { const p = hi > lo ? Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)) : 50; return `<div class="dk-bar"><i style="left:${p}%"></i></div>`; }
function dcStats() {
  const { A, D, mkt } = S.detail, st = A.stats, n = D.c.length, K = A.risk;
  const prevC = isFinite(A.chg) ? A.price / (1 + A.chg / 100) : A.prev;
  const dLo = Math.min(D.l[n - 1], A.price), dHi = Math.max(D.h[n - 1], A.price), v20 = A.I && A.I.v20 ? A.I.v20[n - 2] : NaN;
  const r1 = K && isFinite(K.ret) ? K.ret : n > 252 ? (D.c[n - 1] / D.c[n - 253] - 1) * 100 : NaN;
  const emaC = e => !isFinite(e) ? '' : A.price >= e ? 'up' : 'dn';
  const row = (l, v, extra = '', help, bar = '') => `<div class="dk"${help ? ` data-help="${help}"` : ''}><div class="dk-l">${l}${help ? ' <span class="qm">ⓘ</span>' : ''}</div><div class="dk-v">${v}${extra}</div>${bar}</div>`;
  const rsiT = st.rsi >= 70 ? '<span class="dk-t wa">Overbought</span>' : st.rsi <= 30 ? '<span class="dk-t wa">Oversold</span>' : '';
  const adxT = st.adx >= 25 ? '<span class="dk-t">Strong trend</span>' : st.adx < 18 ? '<span class="dk-t">No trend</span>' : '';
  const sgn = x => (x > 0 ? '+' : '') + x.toFixed(2) + '%';
  return `<h3>Key statistics</h3><div class="card dkv">
   ${row('Previous close', fmt(prevC))}
   ${row('Open', fmt(D.o[n - 1]))}
   ${row('Day range', `${fmt(dLo)} – ${fmt(dHi)}`, '', '', dcBar(dLo, dHi, A.price))}
   ${row('52-week range', `${fmt(st.lo52)} – ${fmt(st.hi52)}`, '', '', dcBar(st.lo52, st.hi52, A.price))}
   ${row('Volume', `${dcVol(D.v[n - 1], mkt)}${isFinite(st.volx) ? ` <span class="dk-t ${st.volx >= 1.5 ? 'up' : ''}">${st.volx.toFixed(1)}× avg</span>` : ''}`)}
   ${row('Avg volume (20D)', dcVol(v20, mkt))}
   ${row('Avg daily turnover', `${cur()}${fmt(st.turnover / (mkt === 'IN' ? 1e7 : 1e6), 2)} ${mkt === 'IN' ? 'Cr' : 'M'}`)}
   ${row('RSI (14)', fmt(st.rsi, 0), rsiT)}
   ${row('ADX (trend strength)', fmt(st.adx, 0), adxT)}
   ${row('ATR (daily range)', `${fmt(st.atr)} · ${isFinite(st.atrPct) ? st.atrPct.toFixed(1) : '–'}%`)}
   ${K ? row('Beta (β)', K.beta.toFixed(2), '', 'beta') + row('Alpha (α) / yr', `<span class="${K.alpha >= 0 ? 'up' : 'dn'}">${(K.alpha > 0 ? '+' : '') + K.alpha.toFixed(1)}%</span>`, '', 'alpha') : ''}
   ${row('1-year return', isFinite(r1) ? `<span class="${r1 >= 0 ? 'up' : 'dn'}">${sgn(r1)}</span>` : '–')}
   ${isFinite(st.ret126) ? row('6-month return', `<span class="${st.ret126 >= 0 ? 'up' : 'dn'}">${sgn(st.ret126)}</span>`) : ''}
   ${isFinite(st.ret63) ? row('3-month return', `<span class="${st.ret63 >= 0 ? 'up' : 'dn'}">${sgn(st.ret63)}</span>`) : ''}
   ${row('EMA 20', `<span class="${emaC(st.e20)}">${fmt(st.e20)}</span>`)}
   ${row('EMA 50', `<span class="${emaC(st.e50)}">${fmt(st.e50)}</span>`)}
   ${row('EMA 200', `<span class="${emaC(st.e200)}">${fmt(st.e200)}</span>`)}
   ${st.st ? row('Supertrend', st.st > 0 ? '<span class="up">Up</span>' : '<span class="dn">Down</span>') : ''}
   <div class="dk-foot note">EMA in green = price above it, red = below.</div></div>`;
}

// ---------- the page ----------
function drawDetail(isRefresh) {
  const { A, R, sym } = S.detail, c = cur();
  if (A.err) { $('#dbody').innerHTML = `<div class="warn">${esc(A.err)}</div>`; return; }
  const H = A.horizons, mkt = S.detail.mkt;
  const row = Object.assign({ sym }, rowFromA(A)), RH = {};
  for (const x of HZ) RH[x] = hzRate(row, x, mkt);
  const sel = S.hz === 'overall' || !RH[S.hz] ? 'overall' : S.hz;
  const top = sel === 'overall' ? Object.assign({ label: 'Overall rating' }, R) : Object.assign({ label: H[sel].label + ' rating' }, RH[sel]);
  const k = sel === 'overall' ? (HZ.filter(x => RH[x]).sort((a, b) => Math.abs(RH[b].rating - 50) - Math.abs(RH[a].rating - 50))[0] || 'swing') : sel, h = H[k], Rk = RH[k] || {};
  // levels only when the edge-adjusted action agrees with the raw signal direction
  const L = Rk.dir && h.levels && h.dir === Rk.dir ? h.levels : null;
  const lvl = (l, s, x, cl) => `<div class="${cl}"><div class="l">${l}<em>${s}</em></div><div class="v">${fmt(x)}</div><div class="p">${L && s !== 'E' ? pct((x / L.entry - 1) * 100) : '&nbsp;'}</div></div>`;
  const pillCls = Rk.dir > 0 ? 'b1' : Rk.dir < 0 ? 'b-1' : 'b0';
  const odds = h.bt && h.bt.odds != null ? `<b class="${h.bt.odds >= 50 ? 'up' : h.bt.odds >= 40 ? 'wa' : 'dn'}">${h.bt.odds}%</b> win odds <span class="mu">(${h.bt.wins}/${h.bt.n} past signals hit T1 before stop)</span>` : h.bt ? '<span class="mu">Too few past signals to estimate win odds</span>' : '';
  const vcls = sc => sc >= 58 ? 'up' : sc <= 42 ? 'dn' : 'wa';
  S.detail.levels = L; S.detail.levelsHz = h.label.replace(' term', '');

  const rest = `
  ${A.stats.turnover < (S.minTurnover[mkt] || 0) ? `<div class="warn">⚠ Thinly traded: about ${c}${fmt(A.stats.turnover / (mkt === 'IN' ? 1e7 : 1e6), 2)} ${mkt === 'IN' ? 'Cr' : 'M'} a day. Wide spreads and slippage can wipe out the edge.</div>` : ''}
  ${dcStats()}
  <h3>Rating <span class="note">tap a horizon</span></h3>
  <div class="card dr">
   <div class="hero">${ring(top.rating)}<div style="flex:1;min-width:0"><div class="sub">${esc(top.label)}</div><div class="verdict ${vcls(top.rating)}">${top.action}</div>
    <div class="dr-bd">
     <div><span>Signal</span><b>${top.signal}</b></div>
     <div><span>Proven edge</span><b class="${top.edge == null ? '' : top.edge >= 50 ? 'up' : 'dn'}">${top.edge == null ? 'n/a' : top.edge}</b>${top.bt ? `<small>${top.bt.wins}/${top.bt.n} wins</small>` : ''}</div>
     <div><span>Market</span><b>${top.regAdj >= 0 ? '+' : ''}${top.regAdj}</b>${A.risk ? `<small>β ${A.risk.beta.toFixed(1)}</small>` : ''}</div>
     <div><span>News</span><b>${top.newsAdj >= 0 ? '+' : ''}${top.newsAdj}</b></div>
    </div></div></div>
   <div class="hzrow">${['overall', ...HZ].map(x => { const v = x === 'overall' ? R : RH[x]; return `<button data-h="${x}" class="hzc ${x === sel ? 'on' : ''}"><span>${x === 'overall' ? 'Overall' : H[x].label.replace(' term', '')}</span><b class="${!v ? 'mu' : vcls(v.rating)}">${v ? v.rating : '–'}</b></button>`; }).join('')}</div>
  </div>
  <h3>What to do · ${esc(h.label)}${sel === 'overall' ? ' <span class="note">strongest horizon</span>' : ''}</h3>
  <div class="card hz">${h.na ? `<div class="empty">Not enough history for ${h.label.toLowerCase()} analysis.</div>` : `
   <div class="top2"><span class="pill ${pillCls}">${Rk.action}</span><div style="flex:1"><div class="dw-r">${Rk.rating}<span class="mu">/100 ${esc(h.label.toLowerCase())} rating</span></div><div class="sub">⏱ ${h.dur}</div></div></div>
   <div class="meter"><i style="left:calc(${Rk.rating}% - 2px)"></i></div><div class="dw-scale"><span>Sell ≤42</span><span>Wait</span><span>Buy ≥58</span></div>
   <div class="dw-odds">${odds}</div>${typeof calibLine === 'function' ? calibLine(h) : ''}${Rk.dir && h.bt && h.bt.odds != null && h.bt.odds < 100 / (1 + (h.levels ? h.levels.rr1 : 1.5)) ? `<div class="warn" style="margin:8px 0 0">⚠ Weak edge: on ${esc(sym)} this signal hit Target 1 less often than the ${Math.round(100 / (1 + h.levels.rr1))}% needed to break even. Trade smaller, or wait for a pattern trigger.</div>` : ''}
   ${(() => { const cp = (A.chartPats || []).find(p => p.status !== 'forming' && p.b && Rk.dir && p.b !== Rk.dir && p.q >= 70); return cp ? `<div class="warn" style="margin:8px 0 0">⚠ Conflict: a <b>${esc(cp.n)}</b> (${esc(cp.status)}) points the other way. Trade smaller or wait until it is resolved.</div>` : ''; })()}
   ${L ? `<div class="lv">${lvl('Entry', 'E', L.entry, 'e')}${lvl('Stop loss', 'SL', L.stop, 's')}${lvl('Target 1', 'T1', L.t1, 't')}${lvl('Target 2', 'T2', L.t2, 't')}</div>
   ${sizeLine(L, A, mkt)}<div class="sub">Risk ${L.riskPct.toFixed(1)}% · Reward:risk 1:${L.rr1} / 1:${L.rr2}${L.vwap ? ` · VWAP ${fmt(L.vwap)}` : ''}${Rk.noShort ? ' · Exit longs or avoid. Shorting needs F&O.' : ''}${k === 'intraday' && mkt === 'IN' ? ' · Square off by 3:15 PM' : ''}</div>
   ${A.fno && Rk.dir && (k === 'intraday' || k === 'swing') ? `<div class="sub dw-fut">Futures: ${Rk.dir > 0 ? 'BUY' : 'SELL'} 1 lot${A.fno.lot ? ` (${A.fno.lot} qty) · risk ≈ ${c}${fmt(Math.abs(L.entry - L.stop) * A.fno.lot, 0)}` : ''}</div>` : ''}`
     : `<div class="sub">${Rk.dir ? 'Signal and backtest disagree on direction, so there are no levels. Stand aside.' : `No trade: ${Rk.rating} is in the wait zone (43–57). Wait for 58+ to buy or 42- to sell.`} Raw signal ${h.score}.</div>`}
   <div class="dw-why">Why</div><ul class="why">${h.why.map(w => `<li>${w.w > 0 ? '<span class="up">✓</span>' : '<span class="dn">✗</span>'} ${esc(w.t)}</li>`).join('')}</ul>`}</div>
  <h3>Setups <span class="note">SMC · VCP · trend</span></h3><div class="card">${A.setups.length ? A.setups.map(s => `<div class="setup"><div class="sh"><span class="tag ${s.b > 0 ? 'p' : 'n'}">${esc(s.k)}</span><b>${esc(s.n.replace(/^SMC: /, ''))}</b><span class="q ${s.q >= 70 ? 'up' : s.q >= 55 ? 'wa' : 'mu'}">${s.q}</span></div>
     <div class="qbar"><i style="width:${s.q}%;background:${s.b > 0 ? 'var(--up)' : 'var(--dn)'}"></i></div><div class="x">${esc(s.note)}</div>${evidence(s.n)}
     ${s.entry ? `<div class="lv3"><span>Entry <b>${fmt(s.entry)}</b></span><span>SL <b class="dn">${fmt(s.stop)}</b></span><span>Target <b class="up">${fmt(s.target)}</b></span></div>` : ''}</div>`).join('') : '<div class="note">No SMC, VCP or trend setup active on the daily chart today.</div>'}</div>
  <h3>Chart patterns <span class="note">drawn on the chart</span></h3><div class="card">${(A.chartPats || []).length ? A.chartPats.map(p => `<div class="pat"><div class="ic">${p.b > 0 ? '🟢' : p.b < 0 ? '🔴' : '🟡'}</div><div style="flex:1"><div class="n">${esc(p.n)} <span class="tag ${p.status === 'forming' ? '' : p.b > 0 ? 'p' : 'n'}">${esc(p.status)}</span> <span class="mu" style="font-size:12px">quality ${p.q}</span></div><div class="x">${esc(p.note)}</div>
     <div class="x">Target <b>${fmt(p.target)}</b> · invalid beyond <b>${fmt(p.stop)}</b></div>${evidence(p.n)}</div></div>`).join('') + '' : '<div class="note">No head & shoulders, double top/bottom, flag or triangle that meets the rules right now.</div>'}</div>
  <h3>Candles & breakouts</h3><div class="card">${A.patterns.length ? A.patterns.map(p => `<div class="pat"><div class="ic">${p.b > 0 ? '🟢' : p.b < 0 ? '🔴' : '🟡'}</div><div><div class="n">${esc(p.n)}</div><div class="x">${esc(p.note)}</div>${p.target || p.stop ? `<div class="x">${p.target ? 'Pattern target <b>' + fmt(p.target) + '</b>' : ''}${p.target && p.stop ? ' · ' : ''}${p.stop ? 'Invalid below/above <b>' + fmt(p.stop) + '</b>' : ''}</div>` : ''}</div></div>`).join('') : '<div class="note">No clear pattern on the daily chart right now.</div>'}</div>
  <h3>EMA crossovers</h3><div class="card">${A.cross.length ? A.cross.map(x => `<div class="pat"><div class="ic">${x.dir > 0 ? '⬆️' : '⬇️'}</div><div><div class="n">${esc(x.name)}</div><div class="x">${esc(x.status)}${x.gap != null ? ` · gap ${x.gap.toFixed(2)}%` : ''} · matters for ${x.hz}</div></div></div>`).join('') : '<div class="note">No EMA cross recent or expected soon.</div>'}</div>
  ${riskCard(A, mkt)}
  ${A.fno ? `<h3>F&O</h3><div class="card"><div class="kv"><div><div class="l">Lot size</div><div class="v">${A.fno.lot || '–'}</div></div><div><div class="l">ATM strike (approx.)</div><div class="v">${fmt(A.fno.atm, 0)}</div></div>
   <div><div class="l">Expected 1-day move</div><div class="v">±${fmt(A.fno.moveDay)}</div></div><div><div class="l">Expected 1-week move</div><div class="v">±${fmt(A.fno.moveWeek)}</div></div></div>
   <p style="margin:10px 0 4px;font-weight:700">${esc(A.fno.idea)}</p><p class="note">Exit on the underlying's SL/targets. Confirm strikes in the option chain.</p>${mkt === 'IN' ? `<button class="btn sm" data-oc="${esc(sym)}" style="margin-top:6px">⛓ Option chain · professional call</button>` : ''}</div>` : ''}
  <h3>News <span class="note">${newsHead(S.detail.news)}</span></h3><div class="card dnews">${newsHTML(S.detail.news)}</div>
  <p class="note dfoot">Rating blends signal, past edge on this stock, market trend and news. Not investment advice.</p>`;

  // build the shell once per stock; later redraws keep the chart (and the user's zoom)
  const body = $('#dbody'), fresh = !$('#dcCard') || body.dataset.sym !== sym;
  if (fresh) { body.dataset.sym = sym; body.innerHTML = `<div id="dqp" class="dq"></div>${dcChartShell()}<div id="drest"></div>`; dcBind(); }
  $('#dqp').innerHTML = dcQuote(isRefresh);
  $('#drest').innerHTML = rest;
  document.querySelectorAll('#drest [data-h]').forEach(b => b.onclick = () => { S.hz = b.dataset.h; drawDetail(); });
  if (fresh) dcLoad(false);
  else if (isRefresh) { const cv = S.detail.cv; for (const r in cv.cache) if (DC_RANGES.find(x => x[0] === r)[1] === 'D') delete cv.cache[r]; dcLoad(true, cv.range === '1D' || cv.range === '5D'); }
  else drawPreview(true); // horizon change → new E/SL/T1/T2 lines
}

// keep chart colours in step with the light/dark theme
new MutationObserver(() => { if (S.tab === 'detail' && S.detail && S.detail.cv && $('#pv')) drawPreview(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
