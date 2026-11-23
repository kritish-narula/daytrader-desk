/* Full-screen live chart (TradingView Lightweight Charts, Apache-2.0). */
'use strict';
(function () {
  const IV = [
    ['1m', 60], ['2m', 120], ['3m', 180], ['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600], ['4h', 14400], ['1D', 86400], ['1W', 604800], ['1M', 2592000],
  ];
  const IND = [
    ['e9', 'EMA 9', '#f472b6'], ['e10', 'EMA 10', '#22d3ee'], ['e20', 'EMA 20', '#4c9aff'], ['e50', 'EMA 50', '#f5b301'], ['e100', 'EMA 100', '#a3e635'], ['e200', 'EMA 200', '#c084fc'],
    ['pat', 'Patterns', '#e879f9'], ['sr', 'S/R levels', '#94a3b8'], ['vwap', 'VWAP', '#fb923c'], ['bb', 'Bollinger', '#64748b'], ['st', 'Supertrend', '#10b981'], ['vol', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD'], ['lv', 'SL / Targets'],
  ];
  const store = { get(k, d) { try { const v = localStorage.getItem('dtd2_ch_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('dtd2_ch_' + k, JSON.stringify(v)); } catch (e) {} } };
  const ema = (a, n) => { const o = [], k = 2 / (n + 1); let p = NaN, s = 0; a.forEach((x, i) => { if (i < n) { s += x; if (i === n - 1) p = s / n; } else p = x * k + p * (1 - k); o.push(i >= n - 1 ? p : NaN); }); return o; };
  const rma = (a, n) => { const o = []; let p = NaN, s = 0; a.forEach((x, i) => { if (i < n) { s += x; if (i === n - 1) p = s / n; } else p = (p * (n - 1) + x) / n; o.push(i >= n - 1 ? p : NaN); }); return o; };

  // ---- data ----
  function tzOffset(tz, tSec) { // seconds east of UTC for that zone at that instant
    const d = new Date(tSec * 1000), p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) p[x.type] = x.value;
    return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 1000;
  }
  function toBars(D, tz) {
    const off = D.t.length ? tzOffset(tz, D.t[D.t.length - 1]) : 0, out = [];
    for (let i = 0; i < D.c.length; i++) out.push({ time: D.t[i] + off, open: D.o[i], high: D.h[i], low: D.l[i], close: D.c[i], volume: D.v[i] || 0 });
    return out;
  }
  function bucketKey(t, sec) {
    if (sec === 604800) { const d = new Date(t * 1000), wd = (d.getUTCDay() + 6) % 7; return Math.floor(t / 86400 - wd) * 86400; }
    if (sec === 2592000) { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
    if (sec === 14400) { const day = Math.floor(t / 86400) * 86400, first = this && this.first || 0; return day + Math.floor((t - day - first) / sec) * sec + first; }
    return Math.floor(t / sec) * sec;
  }
  function aggregate(B, sec) {
    const out = []; let cur = null, k0 = null;
    for (const b of B) {
      let k;
      if (sec === 14400) { const day = Math.floor(b.time / 86400) * 86400; const first = B.find(x => x.time >= day).time - day; k = day + first + Math.floor((b.time - day - first) / sec) * sec; }
      else k = bucketKey(b.time, sec);
      if (k !== k0) { if (cur) out.push(cur); cur = { time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }; k0 = k; }
      else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
    }
    if (cur) out.push(cur); return out;
  }
  async function load(sym, mkt, iv) {
    const ys = window.App.ySym(sym, mkt), tz = mkt === 'IN' ? 'Asia/Kolkata' : 'America/New_York';
    const useMS = mkt === 'IN' && window.MS && MS.ok() && !/^\^|_/.test(ys);
    const msPlan = { '1m': ['minute', 3], '2m': ['minute', 3, 120], '3m': ['3minute', 10], '5m': ['5minute', 12], '15m': ['15minute', 35], '30m': ['30minute', 70], '1h': ['60minute', 140], '4h': ['60minute', 140, 14400], '1D': ['day', 1400], '1W': ['day', 1400, 604800], '1M': ['day', 1400, 2592000] }[iv];
    const yPlan = { '1m': ['5d', '1m'], '2m': ['1mo', '2m'], '3m': ['5d', '1m', 180], '5m': ['1mo', '5m'], '15m': ['1mo', '15m'], '30m': ['1mo', '30m'], '1h': ['6mo', '60m'], '4h': ['1y', '60m', 14400], '1D': ['5y', '1d'], '1W': ['10y', '1wk'], '1M': ['max', '1mo'] }[iv];
    let B = null, src = 'Yahoo Finance';
    if (useMS) {
      try { const D = await MS.candles(sym, msPlan[0], msPlan[1]); B = toBars(D, tz); if (msPlan[2]) B = aggregate(B, msPlan[2]); src = 'mStock'; } catch (e) { src = 'Yahoo Finance (mStock: ' + e.message + ')'; }
    }
    if (!B) { const { D } = await window.App.chart(ys, yPlan[0], yPlan[1]); B = toBars(D, tz); if (yPlan[2]) B = aggregate(B, yPlan[2]); }
    return { B, src, tz };
  }

  // ---- indicators on bars ----
  function calc(B) {
    const c = B.map(b => b.close), h = B.map(b => b.high), l = B.map(b => b.low), v = B.map(b => b.volume);
    const R = {}; for (const n of [9, 10, 20, 50, 100, 200]) R['e' + n] = ema(c, n);
    // VWAP resets each day
    let pv = 0, vv = 0, day = null; R.vwap = B.map((b, i) => { const d = Math.floor(b.time / 86400); if (d !== day) { pv = 0; vv = 0; day = d; } const tp = (h[i] + l[i] + c[i]) / 3; pv += tp * (v[i] || 1); vv += v[i] || 1; return pv / vv; });
    // Bollinger 20,2
    R.bbU = []; R.bbL = []; R.bbM = [];
    for (let i = 0; i < c.length; i++) { if (i < 19) { R.bbU.push(NaN); R.bbL.push(NaN); R.bbM.push(NaN); continue; } let s = 0, q = 0; for (let j = i - 19; j <= i; j++) s += c[j]; const m = s / 20; for (let j = i - 19; j <= i; j++) q += (c[j] - m) ** 2; const sd = Math.sqrt(q / 20); R.bbM.push(m); R.bbU.push(m + 2 * sd); R.bbL.push(m - 2 * sd); }
    // Supertrend 10,3
    const tr = B.map((b, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]), at = rma(tr, 10);
    R.st = []; R.stDir = []; let ub = NaN, lb = NaN, d = 1;
    for (let i = 0; i < c.length; i++) { if (isNaN(at[i])) { R.st.push(NaN); R.stDir.push(0); continue; } const mid = (h[i] + l[i]) / 2, bu = mid + 3 * at[i], bl = mid - 3 * at[i]; ub = !isNaN(ub) && bu > ub && c[i - 1] <= ub ? ub : bu; lb = !isNaN(lb) && bl < lb && c[i - 1] >= lb ? lb : bl; if (d === 1 && c[i] < lb) d = -1; else if (d === -1 && c[i] > ub) d = 1; R.st.push(d === 1 ? lb : ub); R.stDir.push(d); }
    // RSI 14
    const g = c.map((x, i) => i ? Math.max(x - c[i - 1], 0) : 0), lo = c.map((x, i) => i ? Math.max(c[i - 1] - x, 0) : 0), ag = rma(g, 14), al = rma(lo, 14);
    R.rsi = ag.map((x, i) => isNaN(x) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i]));
    const m12 = ema(c, 12), m26 = ema(c, 26), line = m12.map((x, i) => x - m26[i]), lv = line.filter(x => !isNaN(x)), sg = ema(lv, 9), pad = line.length - lv.length;
    R.macd = line; R.macdSig = line.map((_, i) => i < pad ? NaN : sg[i - pad]); R.macdH = line.map((x, i) => x - R.macdSig[i]);
    return R;
  }
  const pts = (B, a) => { const o = []; a.forEach((v, i) => { if (isFinite(v)) o.push({ time: B[i].time, value: v }); }); return o; };

  // ---- viewer ----
  let V = null;
  function close() {
    if (!V) return; clearInterval(V.timer); V.root.remove(); document.body.style.overflow = ''; V = null;
    if (history.state && history.state.chart) history.back();
  }
  addEventListener('popstate', () => { if (V) { const r = V; V = null; clearInterval(r.timer); r.root.remove(); document.body.style.overflow = ''; } });

  function open(opts) { // {sym, mkt, name, levels, iv}
    if (V) close();
    const on = Object.assign({ pat: 1, sr: 1 }, store.get('ind', { e20: 1, e50: 1, e200: 1, vol: 1, lv: 1 })), iv = opts.iv || store.get('iv', '1D');
    const root = document.createElement('div'); root.className = 'cfull';
    root.innerHTML = `<div class="ctop"><button class="cbtn" data-a="x">✕</button><div class="cttl"><b>${opts.sym}</b><span id="cpx"></span></div><button class="cbtn" data-a="fit" title="Reset view">⟲</button><button class="cbtn" data-a="mode" id="cmode"></button></div>
      <div class="cchips" id="civ">${IV.map(([k]) => `<button data-iv="${k}" class="${k === iv ? 'on' : ''}">${k}</button>`).join('')}</div>
      <div class="cchips sm" id="cind">${IND.map(([k, n, col]) => `<button data-ind="${k}" class="${on[k] ? 'on' : ''}">${col ? `<i style="background:${col}"></i>` : ''}${n}</button>`).join('')}</div>
      <div class="cchips sm" id="cpat" style="display:none"></div>
      <div class="cwrap"><div id="cmain" class="cmain"></div><div id="crsi" class="csub"></div><div id="cmacd" class="csub"></div><div class="cload" id="cload"><span class="spin"></span></div></div>
      <div class="cfoot" id="cfoot"></div>`;
    document.body.appendChild(root); document.body.style.overflow = 'hidden';
    history.pushState({ chart: 1 }, '');
    V = { root, opts, on, iv, free: store.get('free', true), series: {}, B: [], hidden: new Set(), patSeries: [] };
    root.querySelector('[data-a=x]').onclick = close;
    root.querySelector('[data-a=fit]').onclick = () => { V.main.timeScale().fitContent(); V.main.priceScale('right').applyOptions({ autoScale: true }); V.main.timeScale().scrollToRealTime(); };
    root.querySelector('[data-a=mode]').onclick = () => { V.free = !V.free; store.set('free', V.free); applyMode(); };
    root.querySelectorAll('[data-iv]').forEach(b => b.onclick = () => { root.querySelectorAll('[data-iv]').forEach(x => x.classList.toggle('on', x === b)); V.iv = b.dataset.iv; store.set('iv', V.iv); loadIv(); });
    root.querySelectorAll('[data-ind]').forEach(b => b.onclick = () => { const k = b.dataset.ind; V.on[k] = !V.on[k]; b.classList.toggle('on', !!V.on[k]); store.set('ind', V.on); build(); });
    build(); loadIv();
  }
  function chartOpts(el, sub) {
    return {
      width: el.clientWidth, height: el.clientHeight, autoSize: true,
      layout: { background: { color: '#0a0e13' }, textColor: '#8a97a6', fontSize: 11, attributionLogo: !sub },
      grid: { vertLines: { color: '#141c26' }, horzLines: { color: '#141c26' } },
      crosshair: { mode: 0 }, rightPriceScale: { borderColor: '#1e2935', minimumWidth: 72 },
      timeScale: { borderColor: '#1e2935', timeVisible: true, secondsVisible: false, rightOffset: 6, visible: !sub || true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    };
  }
  function applyMode() {
    const b = V.root.querySelector('#cmode');
    b.textContent = V.free ? '✥ Free' : '↔ Fit'; b.title = V.free ? 'Drag in any direction; price axis does not auto-fit' : 'Drag sideways; price auto-fits';
    V.main.priceScale('right').applyOptions({ autoScale: !V.free });
    V.main.applyOptions({ handleScroll: { vertTouchDrag: V.free, pressedMouseMove: true, horzTouchDrag: true, mouseWheel: true } });
  }
  function build() {
    const LW = window.LightweightCharts, r = V.root;
    ['main', 'rsiC', 'macdC'].forEach(k => { if (V[k]) { V[k].remove(); V[k] = null; } });
    const elM = r.querySelector('#cmain'), elR = r.querySelector('#crsi'), elD = r.querySelector('#cmacd');
    elR.style.display = V.on.rsi ? '' : 'none'; elD.style.display = V.on.macd ? '' : 'none';
    V.main = LW.createChart(elM, chartOpts(elM));
    V.series = {};
    V.series.c = V.main.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false, priceLineColor: '#4c9aff' });
    if (V.on.vol) { V.series.vol = V.main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }); V.main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); }
    for (const [k, , col] of IND) if (/^e\d/.test(k) && V.on[k]) V.series[k] = V.main.addLineSeries({ color: col, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    if (V.on.vwap) V.series.vwap = V.main.addLineSeries({ color: '#fb923c', lineWidth: 1.5, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    if (V.on.bb) ['bbU', 'bbM', 'bbL'].forEach(k => V.series[k] = V.main.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: k === 'bbM' ? 2 : 0, priceLineVisible: false, lastValueVisible: false }));
    if (V.on.st) V.series.st = V.main.addLineSeries({ color: '#10b981', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const subs = [];
    if (V.on.rsi) { V.rsiC = LW.createChart(elR, chartOpts(elR, 1)); V.series.rsi = V.rsiC.addLineSeries({ color: '#a78bfa', lineWidth: 1.5, priceLineVisible: false }); [70, 30].forEach(p => V.series.rsi.createPriceLine({ price: p, color: '#334155', lineStyle: 2, axisLabelVisible: false })); subs.push(V.rsiC); }
    if (V.on.macd) { V.macdC = LW.createChart(elD, chartOpts(elD, 1)); V.series.mh = V.macdC.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }); V.series.ml = V.macdC.addLineSeries({ color: '#4c9aff', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }); V.series.ms = V.macdC.addLineSeries({ color: '#f5b301', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }); subs.push(V.macdC); }
    // sync time scales
    const all = [V.main, ...subs]; let lock = false;
    all.forEach(ch => ch.timeScale().subscribeVisibleLogicalRangeChange(rg => { if (lock || !rg) return; lock = true; all.forEach(o => o !== ch && o.timeScale().setVisibleLogicalRange(rg)); lock = false; }));
    applyMode();
    V.patSeries = []; V.patLines = [];
    if (V.B.length) draw(true);
  }
  async function loadIv() {
    const r = V.root, my = V.iv; r.querySelector('#cload').style.display = '';
    clearInterval(V.timer);
    try {
      const { B, src, tz } = await load(V.opts.sym, V.opts.mkt, V.iv);
      if (!V || V.iv !== my) return;
      V.B = B; V.src = src; V.tz = tz; draw(true);
      V.timer = setInterval(tick, window.MS && MS.ok() && V.opts.mkt === 'IN' ? 3000 : 6000);
    } catch (e) { r.querySelector('#cfoot').innerHTML = `<span class="dn">Could not load ${V.iv} data: ${e.message}</span>`; }
    if (V) r.querySelector('#cload').style.display = 'none';
  }
  function findPatterns() {
    const B = V.B; if (!window.Engine || B.length < 60) { V.pats = []; V.levels = []; return; }
    const D = { t: B.map(b => b.time), o: B.map(b => b.open), h: B.map(b => b.high), l: B.map(b => b.low), c: B.map(b => b.close), v: B.map(b => b.volume || 0) };
    try { const I = Engine.indicators(D); V.pats = Engine.chartPatterns(I, V.opts.mkt === 'IN' ? 0.05 : 0.01); V.levels = Engine.levels(I); } catch (e) { V.pats = []; V.levels = []; }
  }
  const abbr = n => ({ 'Head & shoulders': 'H&S', 'Inverse head & shoulders': 'iH&S', 'Double top': 'DT', 'Double bottom': 'DB', 'Bull flag': 'Flag', 'Bear flag': 'Flag', 'Ascending triangle': 'Tri', 'Descending triangle': 'Tri', 'Symmetrical triangle': 'Tri' }[n] || n);
  function drawPatterns() {
    const S = V.series, B = V.B;
    V.patSeries.forEach(s => { try { V.main.removeSeries(s); } catch (e) {} }); V.patSeries = [];
    (V.patLines || []).forEach(l => { try { S.c.removePriceLine(l); } catch (e) {} }); V.patLines = [];
    const marks = [], bar = { CE: 1 };
    const box = V.root.querySelector('#cpat');
    if (V.on.pat && V.pats && V.pats.length) {
      box.style.display = ''; box.innerHTML = '<span class="cplab">Patterns:</span>' + V.pats.map(p => `<button data-pat="${p.id}" class="${V.hidden.has(p.id) ? '' : 'on'}"><i style="background:${p.b > 0 ? '#22c55e' : p.b < 0 ? '#ef4444' : '#f5b301'}"></i>${p.n} · ${p.status}</button>`).join('');
      box.querySelectorAll('[data-pat]').forEach(b => b.onclick = () => { const id = b.dataset.pat; V.hidden.has(id) ? V.hidden.delete(id) : V.hidden.add(id); drawPatterns(); });
      for (const p of V.pats) {
        if (V.hidden.has(p.id)) continue;
        for (const L of p.lines) {
          const pts = []; let last = -1;
          for (const [ix, val] of L.pts) { const k = Math.max(0, Math.min(B.length - 1, Math.round(ix))); if (k <= last || !isFinite(val)) continue; last = k; pts.push({ time: B[k].time, value: val }); }
          if (pts.length < 2) continue;
          const s = V.main.addLineSeries({ color: L.color, lineWidth: L.w || 2, lineStyle: L.dash ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
          s.setData(pts); V.patSeries.push(s);
        }
        for (const m of p.marks) { const k = Math.max(0, Math.min(B.length - 1, m.i)); marks.push({ time: B[k].time, position: m.pos === 'above' ? 'aboveBar' : 'belowBar', color: p.b > 0 ? '#22c55e' : p.b < 0 ? '#ef4444' : '#f5b301', shape: 'circle', text: m.t }); }
        const end = Math.max(...p.lines.flatMap(L => L.pts.map(q => q[0]))), k = Math.max(0, Math.min(B.length - 1, Math.round(end)));
        marks.push({ time: B[k].time, position: p.b < 0 ? 'aboveBar' : 'belowBar', color: '#e879f9', shape: p.b > 0 ? 'arrowUp' : p.b < 0 ? 'arrowDown' : 'square', text: abbr(p.n) });
        if (p.target) V.patLines.push(S.c.createPriceLine({ price: p.target, color: '#e879f9', lineStyle: 3, lineWidth: 1, title: 'PT' }));
      }
    } else box.style.display = 'none';
    if (V.on.sr) for (const z of V.levels || []) V.patLines.push(S.c.createPriceLine({ price: z.p, color: z.kind === 'R' ? 'rgba(239,68,68,.55)' : 'rgba(34,197,94,.55)', lineStyle: 1, lineWidth: 1, title: z.kind }));
    marks.sort((a, b) => a.time - b.time); S.c.setMarkers(marks);
  }
  function draw(fit) {
    const B = V.B, S = V.series, R = calc(B);
    S.c.setData(B.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    if (S.vol) S.vol.setData(B.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)' })));
    for (const k of ['e9', 'e10', 'e20', 'e50', 'e100', 'e200', 'vwap', 'bbU', 'bbM', 'bbL', 'st']) if (S[k]) S[k].setData(pts(B, R[k]));
    if (S.st) S.st.setData(B.map((b, i) => isFinite(R.st[i]) ? { time: b.time, value: R.st[i], color: R.stDir[i] > 0 ? '#22c55e' : '#ef4444' } : null).filter(Boolean));
    if (S.rsi) S.rsi.setData(pts(B, R.rsi));
    if (S.mh) { S.mh.setData(B.map((b, i) => isFinite(R.macdH[i]) ? { time: b.time, value: R.macdH[i], color: R.macdH[i] >= 0 ? 'rgba(34,197,94,.6)' : 'rgba(239,68,68,.6)' } : null).filter(Boolean)); S.ml.setData(pts(B, R.macd)); S.ms.setData(pts(B, R.macdSig)); }
    if (fit) {
      findPatterns(); drawPatterns();
      (V.lines || []).forEach(l => S.c.removePriceLine(l)); V.lines = [];
      const L = V.opts.levels; if (V.on.lv && L) [[L.stop, '#ef4444', 'SL'], [L.t1, '#22c55e', 'T1'], [L.t2, '#22c55e', 'T2'], [L.entry, '#8a97a6', 'E']].forEach(([p, color, title]) => p && V.lines.push(S.c.createPriceLine({ price: p, color, lineStyle: 2, lineWidth: 1, title })));
      const n = B.length, show = Math.min(n, /m$|h$/.test(V.iv) ? 120 : 150);
      V.main.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 4 });
      if (!V.free) V.main.priceScale('right').applyOptions({ autoScale: true });
      else { V.main.priceScale('right').applyOptions({ autoScale: true }); setTimeout(() => V && V.free && V.main.priceScale('right').applyOptions({ autoScale: false }), 60); }
    }
    const last = B[B.length - 1], prev = B[B.length - 2];
    if (last) { const ch = prev ? (last.close / prev.close - 1) * 100 : 0; V.root.querySelector('#cpx').innerHTML = ` ${window.App.fmt(last.close)} <small class="${ch >= 0 ? 'up' : 'dn'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</small>`; }
    const live = window.App.marketOpen(V.opts.mkt);
    V.root.querySelector('#cfoot').innerHTML = `<span class="live ${live ? 'on' : ''}"><i></i><span>${live ? 'Live' : 'Market closed'}</span></span> · ${V.iv} · ${V.src} · ${V.free ? 'drag any direction · pinch to zoom · drag the price axis to stretch' : 'drag sideways · pinch to zoom · price auto-fits'}`;
  }
  async function tick() {
    if (!V || !window.App.marketOpen(V.opts.mkt)) return;
    try {
      let px = null;
      if (window.MS && MS.ok() && V.opts.mkt === 'IN') { const q = (await MS.quotes([V.opts.sym]))[V.opts.sym]; px = q && +q.last_price; }
      if (!px) { const { meta } = await window.App.chart(window.App.ySym(V.opts.sym, V.opts.mkt), '1d', '1m'); px = meta.regularMarketPrice; }
      if (!V || !px) return;
      const sec = IV.find(x => x[0] === V.iv)[1], B = V.B, last = B[B.length - 1];
      const now = Math.floor(Date.now() / 1000), t = now + tzOffset(V.tz, now);
      let k = sec >= 86400 ? last.time : (sec === 14400 ? last.time + Math.floor((t - last.time) / sec) * sec : Math.floor(t / sec) * sec);
      const before = last.close;
      if (k > last.time) B.push({ time: k, open: px, high: px, low: px, close: px, volume: 0 });
      else { last.close = px; last.high = Math.max(last.high, px); last.low = Math.min(last.low, px); }
      draw(false);
      const el = V.root.querySelector('#cpx'); el.classList.remove('flash-up', 'flash-dn'); void el.offsetWidth; el.classList.add(px >= before ? 'flash-up' : 'flash-dn');
    } catch (e) { }
  }
  window.ChartView = { open, close, calc, aggregate };
})();
