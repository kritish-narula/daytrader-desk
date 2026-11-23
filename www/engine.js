/* DayTrader Desk analysis engine — pure JS, runs in the browser and in Node. */
(function (root) {
  'use strict';
  const E = {};
  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
  const ok = x => typeof x === 'number' && isFinite(x);

  // ---------- indicators ----------
  function ema(a, n) {
    const o = new Array(a.length).fill(NaN), k = 2 / (n + 1);
    let p = NaN, s = 0, c = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (!ok(x)) { o[i] = p; continue; }
      if (!ok(p)) { s += x; c++; if (c === n) { p = s / n; o[i] = p; } }
      else { p = x * k + p * (1 - k); o[i] = p; }
    }
    return o;
  }
  function sma(a, n) {
    const o = new Array(a.length).fill(NaN); let s = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function wilder(a, n) { // Wilder smoothing (RMA)
    const o = new Array(a.length).fill(NaN); let p = NaN, s = 0, c = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]; if (!ok(x)) continue;
      if (!ok(p)) { s += x; c++; if (c === n) { p = s / n; o[i] = p; } }
      else { p = (p * (n - 1) + x) / n; o[i] = p; }
    }
    return o;
  }
  function rsi(c, n = 14) {
    const g = [NaN], l = [NaN];
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
    const ag = wilder(g, n), al = wilder(l, n);
    return ag.map((x, i) => ok(x) ? (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i])) : NaN);
  }
  function trueRange(h, l, c) { return h.map((x, i) => i ? Math.max(x - l[i], Math.abs(x - c[i - 1]), Math.abs(l[i] - c[i - 1])) : x - l[i]); }
  function atr(h, l, c, n = 14) { return wilder(trueRange(h, l, c), n); }
  function macd(c) {
    const a = ema(c, 12), b = ema(c, 26), line = a.map((x, i) => x - b[i]);
    const sig = ema(line, 9); return { line, sig, hist: line.map((x, i) => x - sig[i]) };
  }
  function adx(h, l, c, n = 14) {
    const pdm = [NaN], mdm = [NaN];
    for (let i = 1; i < h.length; i++) {
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    const tr = trueRange(h, l, c); tr[0] = NaN;
    const str = wilder(tr, n), sp = wilder(pdm, n), sm = wilder(mdm, n);
    const pdi = sp.map((x, i) => 100 * x / str[i]), mdi = sm.map((x, i) => 100 * x / str[i]);
    const dx = pdi.map((x, i) => ok(x) && x + mdi[i] > 0 ? 100 * Math.abs(x - mdi[i]) / (x + mdi[i]) : NaN);
    return { adx: wilder(dx, n), pdi, mdi };
  }
  function supertrend(h, l, c, at, m = 3) {
    const dir = new Array(c.length).fill(0), line = new Array(c.length).fill(NaN);
    let ub = NaN, lb = NaN, d = 1;
    for (let i = 0; i < c.length; i++) {
      if (!ok(at[i])) continue;
      const mid = (h[i] + l[i]) / 2, bu = mid + m * at[i], bl = mid - m * at[i];
      ub = ok(ub) && (bu > ub && c[i - 1] <= ub) ? ub : bu;
      lb = ok(lb) && (bl < lb && c[i - 1] >= lb) ? lb : bl;
      if (d === 1 && c[i] < lb) d = -1; else if (d === -1 && c[i] > ub) d = 1;
      dir[i] = d; line[i] = d === 1 ? lb : ub;
    }
    return { dir, line };
  }
  function bbWidth(c, n = 20) {
    const m = sma(c, n);
    return c.map((_, i) => {
      if (i < n - 1) return NaN; let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (c[j] - m[i]) ** 2;
      return 4 * Math.sqrt(s / n) / m[i];
    });
  }
  const maxIn = (a, s, e) => { let m = -Infinity; for (let i = Math.max(0, s); i <= e; i++) m = Math.max(m, a[i]); return m; };
  const minIn = (a, s, e) => { let m = Infinity; for (let i = Math.max(0, s); i <= e; i++) m = Math.min(m, a[i]); return m; };

  E.indicators = function (D) {
    const { h, l, c, v } = D;
    const at = atr(h, l, c), m = macd(c), ad = adx(h, l, c);
    return {
      D, n: c.length, atr: at, rsi: rsi(c), macd: m, adx: ad.adx, pdi: ad.pdi, mdi: ad.mdi,
      st: supertrend(h, l, c, wilder(trueRange(h, l, c), 10), 3), bbw: bbWidth(c),
      e9: ema(c, 9), e21: ema(c, 21), e20: ema(c, 20), e50: ema(c, 50), e150: ema(c, 150), e200: ema(c, 200),
      v20: sma(v.map(x => x || 0), 20),
    };
  };


  // ---------- setups (use bars up to index i only) ----------
  function pivotsUpTo(D, i0, i1, k) { // confirmed pivots need k bars after them, all <= i1
    const hi = [], lo = [];
    for (let j = Math.max(i0, k); j <= i1 - k; j++) {
      let H1 = true, L1 = true;
      for (let m = j - k; m <= j + k; m++) { if (m < j ? D.h[m] >= D.h[j] : D.h[m] > D.h[j]) H1 = false; if (m < j ? D.l[m] <= D.l[j] : D.l[m] < D.l[j]) L1 = false; }
      if (H1) hi.push(j); if (L1) lo.push(j);
    }
    return { hi, lo };
  }
  E.setups = function (I, i, tick = 0.05) {
    i = i == null ? I.n - 1 : i;
    const D = I.D, c = D.c, h = D.h, l = D.l, o = D.o, v = D.v, out = [], at = I.atr[i];
    if (i < 60 || !ok(at)) return out;
    const R = x => roundTick(x, tick), px = c[i];
    const add = (s) => { s.q = Math.round(clamp(s.q, 0, 100)); out.push(s); };
    const pv = pivotsUpTo(D, i - 120, i, 3);
    const lastH = pv.hi.slice(-3), lastL = pv.lo.slice(-3);
    // --- SMC: structure, BOS / CHoCH ---
    if (lastH.length >= 2 && lastL.length >= 2) {
      const [h1, h2] = lastH.slice(-2), [l1, l2] = lastL.slice(-2);
      const upStruct = h[h2] > h[h1] && l[l2] > l[l1], dnStruct = h[h2] < h[h1] && l[l2] < l[l1];
      const brokeUp = c[i] > h[h2] && c[i - 1] <= h[h2], brokeDn = c[i] < l[l2] && c[i - 1] >= l[l2];
      if (brokeUp) {
        const choch = dnStruct || (!upStruct && h[h2] < h[h1]);
        // order block = last red candle before the impulse that broke structure
        let ob = -1; for (let j = i - 1; j > Math.max(l2, i - 15) - 1; j--) if (c[j] < o[j]) { ob = j; break; }
        const stop = ob >= 0 ? l[ob] - 0.1 * at : l[l2] - 0.1 * at;
        add({ n: choch ? 'SMC: Change of character (bullish)' : 'SMC: Break of structure (bullish)', k: 'SMC', b: 1, q: (choch ? 62 : 70) + (I.v20[i - 1] && v[i] > 1.3 * I.v20[i - 1] ? 12 : 0) + (c[i] > I.e50[i] ? 8 : -8),
          note: `Closed above swing high ${R(h[h2])}.${ob >= 0 ? ` Order block ${R(l[ob])}–${R(h[ob])}: best entry on a retest.` : ''}`, entry: R(ob >= 0 ? h[ob] : px), stop: R(stop), target: R(px + 2 * (px - stop)) });
      }
      if (brokeDn) {
        const choch = upStruct || (!dnStruct && l[l2] > l[l1]);
        let ob = -1; for (let j = i - 1; j > Math.max(h2, i - 15) - 1; j--) if (c[j] > o[j]) { ob = j; break; }
        const stop = ob >= 0 ? h[ob] + 0.1 * at : h[h2] + 0.1 * at;
        add({ n: choch ? 'SMC: Change of character (bearish)' : 'SMC: Break of structure (bearish)', k: 'SMC', b: -1, q: (choch ? 62 : 70) + (I.v20[i - 1] && v[i] > 1.3 * I.v20[i - 1] ? 12 : 0) + (c[i] < I.e50[i] ? 8 : -8),
          note: `Closed below swing low ${R(l[l2])}.${ob >= 0 ? ` Supply order block ${R(l[ob])}–${R(h[ob])}.` : ''}`, entry: R(ob >= 0 ? l[ob] : px), stop: R(stop), target: R(px - 2 * (stop - px)) });
      }
      // --- liquidity sweep (stop hunt) ---
      const swL = Math.min(...lastL.map(j => l[j])), swH = Math.max(...lastH.map(j => h[j]));
      if (l[i] < l[l2] && c[i] > l[l2] && c[i] > o[i]) add({ n: 'SMC: Liquidity sweep below lows', k: 'SMC', b: 1, q: 60 + (c[i] > I.e200[i] ? 12 : 0) + (l[i] <= swL ? 6 : 0), note: `Took stops under ${R(l[l2])} and closed back above. Classic reversal trigger.`, entry: R(px), stop: R(l[i] - 0.1 * at), target: R(h[h2]) });
      if (h[i] > h[h2] && c[i] < h[h2] && c[i] < o[i]) add({ n: 'SMC: Liquidity sweep above highs', k: 'SMC', b: -1, q: 60 + (c[i] < I.e200[i] ? 12 : 0) + (h[i] >= swH ? 6 : 0), note: `Ran stops above ${R(h[h2])} and closed back below.`, entry: R(px), stop: R(h[i] + 0.1 * at), target: R(l[l2]) });
    }
    // --- SMC: unfilled fair value gaps near price ---
    for (let j = i; j >= Math.max(2, i - 25); j--) {
      if (l[j] > h[j - 2]) { // bullish FVG between h[j-2] and l[j]
        const top = l[j], bot = h[j - 2]; let filled = false; for (let m = j + 1; m <= i; m++) if (l[m] <= bot) { filled = true; break; }
        if (!filled && l[i] <= top && c[i] >= bot && j < i - 1) { add({ n: 'SMC: Retest of bullish fair value gap', k: 'SMC', b: 1, q: 58 + (c[i] > I.e50[i] ? 12 : 0) + (c[i] > o[i] ? 6 : 0), note: `Price is inside the imbalance ${R(bot)}–${R(top)}. Buyers often defend it.`, entry: R(px), stop: R(bot - 0.3 * at), target: R(Math.max(...h.slice(j, i + 1))) }); break; }
      }
      if (h[j] < l[j - 2]) {
        const top = l[j - 2], bot = h[j]; let filled = false; for (let m = j + 1; m <= i; m++) if (h[m] >= top) { filled = true; break; }
        if (!filled && h[i] >= bot && c[i] <= top && j < i - 1) { add({ n: 'SMC: Retest of bearish fair value gap', k: 'SMC', b: -1, q: 58 + (c[i] < I.e50[i] ? 12 : 0) + (c[i] < o[i] ? 6 : 0), note: `Price is inside the imbalance ${R(bot)}–${R(top)}. Sellers often defend it.`, entry: R(px), stop: R(top + 0.3 * at), target: R(Math.min(...l.slice(j, i + 1))) }); break; }
      }
    }
    // --- Minervini trend template ---
    const hi52 = maxIn(h, i - 251, i), lo52 = minIn(l, i - 251, i);
    const tt = [c[i] > I.e150[i] && c[i] > I.e200[i], I.e150[i] > I.e200[i], i >= 20 && I.e200[i] > I.e200[i - 20], I.e50[i] > I.e150[i], c[i] > I.e50[i], c[i] >= 1.25 * lo52, c[i] >= 0.75 * hi52];
    const ttN = tt.filter(Boolean).length;
    if (I.n > 210 && ttN === 7) add({ n: 'Stage 2 uptrend (Minervini template)', k: 'TREND', b: 1, q: 66 + Math.min(14, (c[i] / hi52 - 0.75) * 56), note: 'All 7 trend-template rules pass: the stock is in a leadership uptrend.' });
    // --- VCP ---
    if (ttN >= 6) {
      const base = pivotsUpTo(D, i - 65, i, 2);
      const seq = [...base.hi.map(j => [j, 'H']), ...base.lo.map(j => [j, 'L'])].sort((a, b) => a[0] - b[0]);
      const depths = []; let lastHi = null;
      for (const [j, k] of seq) { if (k === 'H') lastHi = j; else if (lastHi != null) { depths.push({ d: (h[lastHi] - l[j]) / h[lastHi], hi: lastHi, lo: j }); lastHi = null; } }
      const dd = depths.slice(-4);
      let contracting = dd.length >= 2; for (let k = 1; k < dd.length; k++) if (dd[k].d > dd[k - 1].d * 0.95) contracting = false;
      if (contracting && dd[dd.length - 1].d < 0.12) {
        const pivot = maxIn(h, dd[dd.length - 1].hi, i), lastLow = l[dd[dd.length - 1].lo];
        const v10 = v.slice(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10, v50 = v.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50;
        const dry = v50 > 0 && v10 < 0.85 * v50, near = c[i] >= pivot * 0.92, brk = c[i] > pivot * 0.999 && I.v20[i - 1] && v[i] > 1.4 * I.v20[i - 1];
        if (near) add({ n: brk ? 'VCP breakout' : 'VCP (volatility contraction) forming', k: 'VCP', b: 1,
          q: 62 + dd.length * 4 + (dry ? 8 : 0) + (brk ? 10 : 0) + (ttN === 7 ? 4 : 0),
          note: `${dd.length} contractions: ${dd.map(x => (x.d * 100).toFixed(0) + '%').join(' → ')}${dry ? ', volume drying up' : ''}. ${brk ? 'Broke the pivot on volume.' : `Buy above pivot ${R(pivot)}.`}`,
          entry: R(pivot * 1.001), stop: R(lastLow * 0.995), target: R(pivot * 1.001 + 2 * (pivot * 1.001 - lastLow * 0.995)) });
      }
    }
    // --- pullback to 20 EMA in a trend ---
    if (I.e20[i] > I.e50[i] && I.e50[i] > I.e200[i] && Math.min(l[i], l[i - 1]) <= I.e20[i] * 1.01 && c[i] > I.e20[i] && I.rsi[i] > 40 && I.rsi[i] < 62)
      add({ n: 'Pullback to 20 EMA in uptrend', k: 'TREND', b: 1, q: 64 + (c[i] > o[i] ? 8 : 0) + (I.adx[i] > 25 ? 8 : 0), note: 'Trend intact; price dipped to the 20 EMA and held. Low-risk continuation entry.', entry: R(h[i]), stop: R(Math.min(l[i], l[i - 1]) - 0.2 * at), target: R(h[i] + 2 * (h[i] - Math.min(l[i], l[i - 1]) + 0.2 * at)) });
    if (I.e20[i] < I.e50[i] && I.e50[i] < I.e200[i] && Math.max(h[i], h[i - 1]) >= I.e20[i] * 0.99 && c[i] < I.e20[i] && I.rsi[i] < 60)
      add({ n: 'Rally into 20 EMA in downtrend', k: 'TREND', b: -1, q: 62 + (c[i] < o[i] ? 8 : 0) + (I.adx[i] > 25 ? 8 : 0), note: 'Downtrend intact; bounce failed at the 20 EMA.', entry: R(l[i]), stop: R(Math.max(h[i], h[i - 1]) + 0.2 * at), target: R(l[i] - 2 * (Math.max(h[i], h[i - 1]) + 0.2 * at - l[i])) });
    // --- breakout family ---
    const v20 = I.v20[i - 1], volx = v20 ? v[i] / v20 : 0, rngPos = h[i] > l[i] ? (c[i] - l[i]) / (h[i] - l[i]) : 0.5;
    const lvl50 = maxIn(h, i - 50, i - 1), uptrend = c[i] > I.e50[i] && I.e50[i] > I.e200[i];
    // clean breakout: close through a 50-day high on volume, strong close, not already stretched
    if (c[i] > lvl50 && c[i - 1] <= lvl50 * 1.005 && volx >= 1.5 && rngPos >= 0.65 && (c[i] - lvl50) / at < 1.5)
      add({ n: 'Clean volume breakout', k: 'BRK', b: 1, q: 64 + Math.min(10, (volx - 1.5) * 8) + (c[i] >= hi52 * 0.995 ? 8 : 0) + (uptrend ? 6 : -6), note: `Closed above the 50-day high ${R(lvl50)} on ${volx.toFixed(1)}× volume, near the day's high.`, entry: R(px), stop: R(Math.max(lvl50 - at, l[i] - 0.2 * at)), target: R(px + 2 * (px - Math.max(lvl50 - at, l[i] - 0.2 * at))) });
    // near breakout: coiling just under a base high with shrinking range and quiet volume
    const base = maxIn(h, i - 60, i - 3), dist = (base - c[i]) / c[i];
    if (I.n > 80 && uptrend && dist >= 0 && dist <= 0.03) {
      let a10 = 0, a50 = 0; for (let j = i - 9; j <= i; j++) a10 += (h[j] - l[j]) / c[j]; for (let j = i - 49; j <= i; j++) a50 += (h[j] - l[j]) / c[j]; a10 /= 10; a50 /= 50;
      const vq = v.slice(i - 9, i + 1).reduce((x, y) => x + y, 0) / 10 < 0.9 * (I.v20[i] || 1e18), tight = a10 < 0.8 * a50;
      if (tight || vq) add({ n: 'Near breakout (coiling under resistance)', k: 'PRE', b: 1, q: 58 + (tight ? 9 : 0) + (vq ? 7 : 0) + (base >= hi52 * 0.99 ? 6 : 0) + (dist < 0.015 ? 4 : 0),
        note: `${(dist * 100).toFixed(1)}% below resistance ${R(base)}${tight ? ', ranges tightening' : ''}${vq ? ', volume drying up' : ''}. Buy only on a close above ${R(base)}.`, entry: R(base * 1.002), stop: R(minIn(l, i - 9, i) - 0.1 * at), target: R(base * 1.002 + 2 * (base * 1.002 - minIn(l, i - 9, i) + 0.1 * at)) });
    }
    // pocket pivot: up-day volume beats every down-day volume of the last 10 sessions, in an uptrend
    let maxDn = 0; for (let j = i - 10; j < i; j++) if (c[j] < c[j - 1]) maxDn = Math.max(maxDn, v[j]);
    if (uptrend && c[i] > c[i - 1] && maxDn > 0 && v[i] > maxDn && Math.abs(c[i] - I.e20[i]) / I.e20[i] < 0.05)
      add({ n: 'Pocket pivot', k: 'BRK', b: 1, q: 62 + (rngPos > 0.7 ? 6 : 0) + (volx > 1.5 ? 6 : 0), note: `Up-day volume beat every down-day volume of the last 10 sessions: institutional buying near the 20 EMA.`, entry: R(px), stop: R(Math.min(l[i], I.e20[i]) - 0.3 * at), target: R(px + 2 * (px - Math.min(l[i], I.e20[i]) + 0.3 * at)) });
    // gap and go / gap down
    if (o[i] > h[i - 1] * 1.01 && c[i] > o[i] && volx > 1.5) add({ n: 'Gap-up and go', k: 'GAP', b: 1, q: 60 + (rngPos > 0.75 ? 8 : 0) + (uptrend ? 6 : 0), note: `Gapped above yesterday's high and kept rising on ${volx.toFixed(1)}× volume. Gap low ${R(h[i - 1])} should hold.`, entry: R(px), stop: R(h[i - 1] - 0.2 * at), target: R(px + 2 * (px - h[i - 1] + 0.2 * at)) });
    if (o[i] < l[i - 1] * 0.99 && c[i] < o[i] && volx > 1.5) add({ n: 'Gap-down and go', k: 'GAP', b: -1, q: 60 + (rngPos < 0.25 ? 8 : 0) + (!uptrend ? 6 : 0), note: `Gapped below yesterday's low and kept falling on ${volx.toFixed(1)}× volume.`, entry: R(px), stop: R(l[i - 1] + 0.2 * at), target: R(px - 2 * (l[i - 1] + 0.2 * at - px)) });
    // --- oversold in uptrend ---
    if (I.rsi[i] < 32 && c[i] > I.e200[i] && I.e50[i] > I.e200[i]) add({ n: 'Oversold dip in long-term uptrend', k: 'MR', b: 1, q: 58 + (c[i] > o[i] ? 8 : 0), note: `RSI ${I.rsi[i] | 0} while above the 200 EMA: mean-reversion bounce setup.`, entry: R(h[i]), stop: R(l[i] - 0.5 * at), target: R(I.e20[i]) });
    for (const s of out) { const e = E.setupEdge(s.n); if (e) s.ev = e; }
    return out.sort((a, b) => (b.ev && b.ev.edge ? 1 : 0) - (a.ev && a.ev.edge ? 1 : 0) || b.q - a.q);
  };
  // Measured on real data (tools/validate.js: 40 NSE large caps, 5 years daily, walk-forward, target vs stop within 30 days).
  // [signals, target-first %, avg reward:risk]. Expectancy = p·RR − (1 − p) in R units.
  // [signals, target-first %, avg reward:risk, edge in BOTH train (40 large caps) and out-of-sample test (40 other stocks)]
  E.SETUP_STATS = {
    'SMC: Retest of bullish fair value gap': [2728, 51, 1.52, 1],
    'Pullback to 20 EMA in uptrend': [2609, 27, 4.23, 1],
    'SMC: Retest of bearish fair value gap': [2179, 40, 1.67, 1],
    'Double top': [1497, 47, 3.71, 1],
    'Double bottom': [1456, 73, 1.92, 1],
    'Pocket pivot': [1392, 35, 2.0, 1],
    'SMC: Liquidity sweep above highs': [1235, 32, 2.95, 1],
    'Rally into 20 EMA in downtrend': [1326, 19, 3.71, 0],
    'SMC: Liquidity sweep below lows': [1138, 40, 2.65, 1],
    'SMC: Break of structure (bullish)': [807, 32, 2.0, 0],
    'Head & shoulders': [746, 41, 8.44, 1],
    'Inverse head & shoulders': [755, 69, 2.99, 1],
    'SMC: Change of character (bullish)': [732, 37, 2.0, 1],
    'SMC: Change of character (bearish)': [705, 23, 2.0, 0],
    'Bull flag': [670, 24, 4.39, 1],
    'SMC: Break of structure (bearish)': [669, 20, 2.0, 0],
    'Bear flag': [575, 8, 4.81, 0],
    'Clean volume breakout': [519, 37, 2.0, 0],
    'VCP (volatility contraction) forming': [205, 20, 5.64, 1],
    'Gap-down and go': [148, 26, 2.0, 0],
    'Gap-up and go': [153, 42, 2.0, 1],
    'Oversold dip in long-term uptrend': [124, 28, 3.29, 0],
    'Ascending triangle': [82, 45, 2.2, 1],
    'Descending triangle': [74, 34, 1.88, 0],
    'Symmetrical triangle': [52, 0, 4.61, 0],
  };
  E.setupEdge = function (name) {
    const s = E.SETUP_STATS[name]; if (!s || s[0] < 60) return null;
    const p = s[1] / 100, ev = p * Math.min(s[2], 3) - (1 - p); // cap RR so rare huge targets don't dominate
    return { n: s[0], hit: s[1], rr: s[2], ev: Math.round(ev * 100) / 100, edge: !!s[3] && ev > 0.05, be: Math.round(100 / (1 + s[2])) };
  };
  function setupScore(I, i) {
    const s = E.setups(I, i, 1e-9); if (!s.length) return NaN;
    const w = x => { const e = E.setupEdge(x.n); return e ? (e.edge ? Math.min(1, 0.5 + e.ev / 2) : 0) : 0.5; }; // untested setups count half, no-edge ones count zero
    const bull = Math.max(0, ...s.filter(x => x.b > 0).map(x => x.q * w(x))), bear = Math.max(0, ...s.filter(x => x.b < 0).map(x => x.q * w(x)));
    return (bull - bear) / 85;
  }

  // ---------- horizons ----------
  const H = {
    intraday: { label: 'Intraday', dur: 'Today only — square off by close', riskAtr: 0.35, t1: 1.5, t2: 2.5, hold: 1 },
    swing:    { label: 'Swing', dur: '3–10 trading days', riskAtr: 1.5, t1: 1.5, t2: 3, hold: 10, swingLook: 5 },
    short:    { label: 'Short term', dur: '2–6 weeks', riskAtr: 2.5, t1: 1.5, t2: 3, hold: 30, swingLook: 20 },
    medium:   { label: 'Medium term', dur: '2–6 months', riskAtr: 4, t1: 1.5, t2: 3, hold: 120, swingLook: 60 },
    long:     { label: 'Long term', dur: '1 year +', riskAtr: 6, t1: 2, t2: 4, hold: 250, swingLook: 120 },
  };
  E.HORIZONS = H;

  // factor = [weight, value -1..1, bullish text, bearish text]
  function factors(I, i, hz, ex) {
    ex = ex || {};
    const D = I.D, C = D.c, c = C[i], f = [];
    const add = (w, x, up, dn) => { if (ok(x)) f.push([w, clamp(x), up, dn]); };
    const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;
    const roc = n => i >= n ? (c / C[i - n] - 1) * 100 : NaN;
    const r = I.rsi[i], mh = I.macd.hist[i], mp = I.macd.hist[i - 1];
    const hi20 = maxIn(D.h, i - 20, i - 1), lo20 = minIn(D.l, i - 20, i - 1);
    const hi52 = maxIn(D.h, i - 251, i), lo52 = minIn(D.l, i - 251, i);
    const volx = I.v20[i - 1] > 0 ? D.v[i] / I.v20[i - 1] : NaN;
    const trendStrong = I.adx[i] > 20;
    if (hz === 'swing') {
      add(2, sgn(I.e9[i] - I.e21[i]), 'EMA 9 above EMA 21', 'EMA 9 below EMA 21');
      add(0.75, sgn(c - I.e20[i]), 'Price above 20 EMA', 'Price below 20 EMA');
      add(0.25, mh > 0 ? (mh > mp ? 1 : 0.3) : (mh > mp ? -0.3 : -1), 'MACD momentum rising', 'MACD momentum falling'); // IC < 0 in both test sets: near-zero weight
      add(1.5, r > 78 ? -0.5 : r > 68 ? 0.3 : r >= 50 ? 1 : r >= 40 ? -0.3 : r >= 30 ? -0.7 : 0.2, `RSI ${r | 0} in bullish zone`, r > 78 ? `RSI ${r | 0} overbought` : `RSI ${r | 0} weak`);
      add(1.5, I.st.dir[i], 'Supertrend bullish', 'Supertrend bearish');
      add(1, volx > 1.5 ? sgn(c - C[i - 1]) : 0, `Volume ${volx.toFixed(1)}× average on an up day`, `Volume ${volx.toFixed(1)}× average on a down day`);
      add(1, c > hi20 ? 1 : c < lo20 ? -1 : 0, 'Closed above 20-day high', 'Closed below 20-day low');
      add(1, sgn(c - I.e50[i]), 'Above 50 EMA (trend support)', 'Below 50 EMA');
      // (a "chasing" penalty for stretched stocks was removed: on real data stretched stocks kept going — IC −0.04 in both test sets)
    } else if (hz === 'short') {
      add(2, sgn(I.e20[i] - I.e50[i]), '20 EMA above 50 EMA', '20 EMA below 50 EMA');
      add(1.5, sgn(c - I.e50[i]), 'Price above 50 EMA', 'Price below 50 EMA');
      add(1.5, trendStrong ? sgn(I.pdi[i] - I.mdi[i]) : 0, `ADX ${I.adx[i] | 0}: strong uptrend`, `ADX ${I.adx[i] | 0}: strong downtrend`);
      add(1.5, roc(20) / 10, `+${roc(20).toFixed(1)}% in 1 month`, `${roc(20).toFixed(1)}% in 1 month`);
      add(0.5, sgn(mh), 'MACD above signal', 'MACD below signal');
      add(1, c > hi20 ? 1 : c < lo20 ? -1 : 0, '20-day breakout', '20-day breakdown');
      add(1, r >= 50 && r <= 72 ? 1 : r > 72 ? 0 : -1, 'RSI supports trend', 'RSI below 50');

    } else if (hz === 'medium') {
      add(2, sgn(I.e50[i] - I.e150[i]), '50 EMA above 150 EMA', '50 EMA below 150 EMA');
      add(1.5, sgn(c - I.e150[i]), 'Above 30-week average', 'Below 30-week average');
      add(1.5, i >= 20 ? sgn(I.e150[i] - I.e150[i - 20]) : NaN, '30-week average rising', '30-week average falling');
      add(1.5, roc(126) / 25, `+${roc(126).toFixed(0)}% in 6 months`, `${roc(126).toFixed(0)}% in 6 months`);
      add(1.5, hi52 > lo52 ? 2 * (c - lo52) / (hi52 - lo52) - 1 : NaN, 'Upper part of 52-week range', 'Lower part of 52-week range');
      add(1, trendStrong ? sgn(I.pdi[i] - I.mdi[i]) : 0, 'Trend strength confirmed', 'Downtrend strength confirmed');
    } else if (hz === 'long') {
      add(2, sgn(c - I.e200[i]), 'Above 200 EMA', 'Below 200 EMA');
      add(2, sgn(I.e50[i] - I.e200[i]), 'Golden-cross structure (50 > 200)', 'Death-cross structure (50 < 200)');
      add(1.5, i >= 40 ? sgn(I.e200[i] - I.e200[i - 40]) : NaN, '200 EMA rising', '200 EMA falling');
      add(1.5, roc(250) / 40, `+${roc(250).toFixed(0)}% over 1 year`, `${roc(250).toFixed(0)}% over 1 year`);
      add(1, (c / hi52 - 0.725) / 0.125, 'Near 52-week high', 'Far below 52-week high');
    }
    if (hz !== 'long' && hz !== 'intraday') { const ss = ex.noSetup ? NaN : setupScore(I, i); if (ok(ss) && ss !== 0) add(hz === 'medium' ? 1 : 1.75, ss, 'Active bullish setup (SMC / VCP / trend)', 'Active bearish setup (SMC / trend)'); }

    return f;
  }
  function combine(f) {
    let s = 0, w = 0; for (const x of f) { s += x[0] * x[1]; w += x[0]; }
    return w ? s / w : 0;
  }
  function intradayFactors(I, i, intra, ex) {
    const f = [], add = (w, x, up, dn) => { if (ok(x)) f.push([w, clamp(x), up, dn]); };
    add(1, combine(factors(I, i, 'swing', { noSetup: true })), 'Daily trend supportive', 'Daily trend against');

    if (!intra || !intra.c.length) { // no 5-min bars (scanner): use today's daily bar
      const D = I.D, rg = D.h[i] - D.l[i], chg = (D.c[i] / D.c[i - 1] - 1) * 100, vx = I.v20[i - 1] ? D.v[i] / I.v20[i - 1] : NaN;
      add(2, rg > 0 ? 2 * (D.c[i] - D.l[i]) / rg - 1 : NaN, 'Closing near the day high', 'Closing near the day low');
      add(1.5, chg / 2, `Up ${chg.toFixed(2)}% today`, `Down ${Math.abs(chg).toFixed(2)}% today`);
      add(1, ok(vx) ? clamp((vx - 1) * Math.sign(chg)) : NaN, `Volume ${ok(vx) ? vx.toFixed(1) : ''}× normal behind the move`, `Volume ${ok(vx) ? vx.toFixed(1) : ''}× normal behind the drop`);
      return f;
    }
    const T = intra, n = T.c.length, last = T.c[n - 1];
    // today's bars
    const day = T.day[n - 1]; let s0 = n - 1; while (s0 > 0 && T.day[s0 - 1] === day) s0--;
    let pv = 0, vv = 0; for (let j = s0; j < n; j++) { const tp = (T.h[j] + T.l[j] + T.c[j]) / 3; pv += tp * (T.v[j] || 0); vv += T.v[j] || 0; }
    const vwap = vv ? pv / vv : NaN;
    const e9 = ema(T.c, 9), e21 = ema(T.c, 21), r = rsi(T.c)[n - 1];
    const orEnd = Math.min(n - 1, s0 + 2);
    const orH = maxIn(T.h, s0, orEnd), orL = minIn(T.l, s0, orEnd);
    const prevClose = s0 > 0 ? T.c[s0 - 1] : NaN, chg = (last / prevClose - 1) * 100;
    add(2, Math.sign(last - vwap), 'Trading above VWAP', 'Trading below VWAP');
    add(1.5, Math.sign(e9[n - 1] - e21[n - 1]), '5-min EMA 9 > 21', '5-min EMA 9 < 21');
    add(1, r >= 55 && r <= 75 ? 1 : r > 75 ? 0 : r < 45 ? -1 : 0, `5-min RSI ${r | 0} strong`, `5-min RSI ${r | 0} weak`);
    if (n - 1 > orEnd) add(1.5, last > orH ? 1 : last < orL ? -1 : 0, 'Above opening range (ORB long)', 'Below opening range (ORB short)');
    add(1, chg / 2, `Up ${chg.toFixed(2)}% today`, `Down ${Math.abs(chg).toFixed(2)}% today`);
    f.vwap = vwap; f.orH = orH; f.orL = orL;
    return f;
  }

  // ---------- levels ----------
  function roundTick(x, tick) { return +(Math.round(x / tick) * tick).toFixed(2); }
  function levels(I, i, hz, dir, tick, price) {
    const P = H[hz], D = I.D, at = I.atr[i];
    let risk = P.riskAtr * at;
    if (P.swingLook) { // structure stop: recent swing low/high if within 1–2.5× the ATR risk band
      const s = dir > 0 ? minIn(D.l, i - P.swingLook, i) : maxIn(D.h, i - P.swingLook, i);
      const r2 = Math.abs(price - s) * 1.005;
      if (r2 > 0.6 * risk && r2 < 1.6 * risk) risk = r2;
    }
    const e = price, sl = e - dir * risk;
    return {
      entry: roundTick(e, tick), stop: roundTick(sl, tick),
      t1: roundTick(e + dir * P.t1 * risk, tick), t2: roundTick(e + dir * P.t2 * risk, tick),
      riskPct: risk / e * 100, rr1: P.t1, rr2: P.t2,
    };
  }

  // ---------- verdicts ----------
  function action(score, hz, canShort) {
    if (score >= 68) return { a: 'STRONG BUY', d: 1 };
    if (score >= 58) return { a: 'BUY', d: 1 };
    if (score > 42) return { a: 'HOLD / WAIT', d: 0 };
    const strong = score <= 32;
    if (hz === 'intraday' || canShort) return { a: strong ? 'STRONG SELL' : 'SELL', d: -1 };
    return { a: hz === 'long' || hz === 'medium' ? 'AVOID' : 'SELL / EXIT', d: -1, noShort: true };
  }
  const toScore = s => Math.round(50 + 50 * s);

  function backtest(I, hz) {
    const P = H[hz], n = I.n, C = I.D.c; let wins = 0, losses = 0;
    const start = Math.max(210, n - 750);
    for (let i = start; i < n - 2;) {
      const sc = toScore(combine(factors(I, i, hz)));
      const d = sc >= 58 ? 1 : sc <= 42 ? -1 : 0;
      if (!d || !ok(I.atr[i])) { i++; continue; }
      const L = levels(I, i, hz, d, 1e-9, C[i]); let res = 0, j = i + 1;
      for (; j < Math.min(n, i + 1 + P.hold); j++) {
        if (d > 0 ? I.D.l[j] <= L.stop : I.D.h[j] >= L.stop) { res = -1; break; }
        if (d > 0 ? I.D.h[j] >= L.t1 : I.D.l[j] <= L.t1) { res = 1; break; }
      }
      if (j >= n) break; // still open
      if (res > 0) wins++; else losses++; // timed out counts as a loss
      i = j + 1;
    }
    const tot = wins + losses;
    return { n: tot, wins, odds: tot >= 4 ? Math.round(100 * (wins + 1) / (tot + 2)) : null };
  }

  // ---------- patterns ----------
  function pivots(D, i0, i1, k = 3) {
    const hi = [], lo = [];
    for (let i = i0 + k; i <= i1 - k; i++) {
      let H1 = true, L1 = true;
      for (let j = i - k; j <= i + k; j++) { if (j < i ? D.h[j] >= D.h[i] : D.h[j] > D.h[i]) H1 = false; if (j < i ? D.l[j] <= D.l[i] : D.l[j] < D.l[i]) L1 = false; }
      if (H1) hi.push(i); if (L1) lo.push(i);
    }
    return { hi, lo };
  }
  E.patterns = function (I, tick = 0.05) {
    const D = I.D, i = I.n - 1, o = D.o, h = D.h, l = D.l, c = D.c, P = [];
    const R = x => roundTick(x, tick);
    const body = k => Math.abs(c[k] - o[k]), rng = k => h[k] - l[k];
    // candles
    if (c[i] > o[i] && c[i - 1] < o[i - 1] && c[i] >= o[i - 1] && o[i] <= c[i - 1]) P.push({ n: 'Bullish engulfing', b: 1, note: 'Buyers overwhelmed the prior red candle.', stop: R(Math.min(l[i], l[i - 1])) });
    if (c[i] < o[i] && c[i - 1] > o[i - 1] && o[i] >= c[i - 1] && c[i] <= o[i - 1]) P.push({ n: 'Bearish engulfing', b: -1, note: 'Sellers overwhelmed the prior green candle.', stop: R(Math.max(h[i], h[i - 1])) });
    const lw = Math.min(o[i], c[i]) - l[i], uw = h[i] - Math.max(o[i], c[i]);
    if (rng(i) > 0 && lw > 2 * body(i) && uw < body(i) && c[i] < I.e20[i]) P.push({ n: 'Hammer', b: 1, note: 'Long lower wick after a pullback — dip buying.', stop: R(l[i]) });
    if (rng(i) > 0 && uw > 2 * body(i) && lw < body(i) && c[i] > I.e20[i]) P.push({ n: 'Shooting star', b: -1, note: 'Long upper wick after a rally — rejection.', stop: R(h[i]) });
    if (h[i] < h[i - 1] && l[i] > l[i - 1]) P.push({ n: 'Inside bar', b: 0, note: `Coiling. Buy above ${R(h[i - 1])}, sell below ${R(l[i - 1])}.` });
    let nr7 = true; for (let k = 1; k < 7; k++) if (rng(i - k) <= rng(i)) nr7 = false;
    if (nr7) P.push({ n: 'NR7 (narrowest range in 7 days)', b: 0, note: 'Volatility contraction — a sharp move often follows.' });
    // range breakout / breakdown
    const hi20 = maxIn(h, i - 20, i - 1), lo20 = minIn(l, i - 20, i - 1), ht = hi20 - lo20;
    if (c[i] > hi20) P.push({ n: '20-day range breakout', b: 1, note: `Measured move from a ${ht.toFixed(2)} range.`, target: R(hi20 + ht), stop: R((hi20 + lo20) / 2) });
    if (c[i] < lo20) P.push({ n: '20-day range breakdown', b: -1, note: `Measured move from a ${ht.toFixed(2)} range.`, target: R(lo20 - ht), stop: R((hi20 + lo20) / 2) });
    const hi52 = maxIn(h, i - 252, i - 1);
    if (c[i] > hi52 && I.n > 200) P.push({ n: '52-week high breakout', b: 1, note: 'No overhead supply — strongest momentum signal.', stop: R(c[i] - 2 * I.atr[i]) });
    // bull / bear flag
    for (let fl = 3; fl <= 10; fl++) {
      const pe = i - fl, ps = pe - 10; if (ps < 0) break;
      const pole = c[pe] - c[ps], fh = maxIn(h, pe + 1, i), flo = minIn(l, pe + 1, i);
      if (pole / c[ps] > 0.08 && fh - flo < 0.5 * pole && c[pe] - flo < 0.5 * pole && fh <= h[pe] * 1.01) {
        P.push({ n: 'Bull flag', b: 1, note: `Pole +${(pole / c[ps] * 100).toFixed(1)}%, tight ${fl}-day flag. Trigger above ${R(fh)}.`, target: R(fh + pole), stop: R(flo) }); break;
      }
      if (-pole / c[ps] > 0.08 && fh - flo < 0.5 * -pole && fh - c[pe] < 0.5 * -pole && flo >= l[pe] * 0.99) {
        P.push({ n: 'Bear flag', b: -1, note: `Pole ${(pole / c[ps] * 100).toFixed(1)}%, ${fl}-day flag. Trigger below ${R(flo)}.`, target: R(flo + pole), stop: R(fh) }); break;
      }
    }
    // double bottom / top from pivots over last 120 bars
    const pv = pivots(D, Math.max(0, i - 120), i);
    const lo = pv.lo.slice(-2), hi = pv.hi.slice(-2);
    if (lo.length === 2 && lo[1] - lo[0] >= 10 && Math.abs(l[lo[1]] / l[lo[0]] - 1) < 0.03) {
      const neck = maxIn(h, lo[0], lo[1]), depth = neck - Math.min(l[lo[0]], l[lo[1]]);
      if (c[i] > neck) P.push({ n: 'Double bottom (confirmed)', b: 1, note: `Closed above neckline ${R(neck)}.`, target: R(neck + depth), stop: R(Math.min(l[lo[0]], l[lo[1]])) });
      else if (c[i] > l[lo[1]] && i - lo[1] <= 25) P.push({ n: 'Double bottom (forming)', b: 1, note: `Needs a close above ${R(neck)} to confirm.`, target: R(neck + depth), stop: R(Math.min(l[lo[0]], l[lo[1]])) });
    }
    if (hi.length === 2 && hi[1] - hi[0] >= 10 && Math.abs(h[hi[1]] / h[hi[0]] - 1) < 0.03) {
      const neck = minIn(l, hi[0], hi[1]), depth = Math.max(h[hi[0]], h[hi[1]]) - neck;
      if (c[i] < neck) P.push({ n: 'Double top (confirmed)', b: -1, note: `Closed below neckline ${R(neck)}.`, target: R(neck - depth), stop: R(Math.max(h[hi[0]], h[hi[1]])) });
      else if (c[i] < h[hi[1]] && i - hi[1] <= 25) P.push({ n: 'Double top (forming)', b: -1, note: `A close below ${R(neck)} confirms.`, target: R(neck - depth), stop: R(Math.max(h[hi[0]], h[hi[1]])) });
    }
    // structure
    const ph = pv.hi.slice(-3), pl = pv.lo.slice(-3);
    if (ph.length === 3 && pl.length === 3) {
      if (h[ph[2]] > h[ph[1]] && h[ph[1]] > h[ph[0]] && l[pl[2]] > l[pl[1]] && l[pl[1]] > l[pl[0]]) P.push({ n: 'Higher highs & higher lows', b: 1, note: 'Clean uptrend structure.', stop: R(l[pl[2]]) });
      if (h[ph[2]] < h[ph[1]] && h[ph[1]] < h[ph[0]] && l[pl[2]] < l[pl[1]] && l[pl[1]] < l[pl[0]]) P.push({ n: 'Lower highs & lower lows', b: -1, note: 'Clean downtrend structure.', stop: R(h[ph[2]]) });
    }
    // squeeze & supertrend flip
    if (I.n > 140 && ok(I.bbw[i]) && I.bbw[i] <= minIn(I.bbw, i - 120, i) * 1.05) P.push({ n: 'Bollinger squeeze', b: 0, note: 'Tightest bands in 6 months — breakout pending, direction unknown.' });
    for (let k = 0; k < 3; k++) if (I.st.dir[i - k] !== I.st.dir[i - k - 1] && I.st.dir[i - k - 1]) {
      P.push({ n: `Supertrend flipped ${I.st.dir[i] > 0 ? 'bullish' : 'bearish'}`, b: I.st.dir[i], note: `${k ? k + ' day(s) ago' : 'Today'}.`, stop: R(I.st.line[i]) }); break;
    }
    return P;
  };

  // ---------- geometric chart patterns with drawable lines ----------
  // Returns [{id, n, b, q, status, note, target, stop, lines:[{pts:[[i,p],[i,p]...], color, dash}], marks:[{i, p, t, pos}]}]
  // Strict rules: only well-formed, recent patterns are returned.
  function fitLine(xs, ys) { const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; } const m = sxx ? sxy / sxx : 0; return { m, b: my - m * mx, at: x => my + m * (x - mx) }; }
  E.chartPatterns = function (I, tick = 0.05) {
    const D = I.D, n = I.n, i = n - 1, h = D.h, l = D.l, c = D.c, out = [];
    if (n < 60) return out;
    const R = x => roundTick(x, tick), at = I.atr[i] || (h[i] - l[i]);
    const GREEN = '#22c55e', RED = '#ef4444', BLUE = '#4c9aff', GOLD = '#f5b301';
    const pv = pivotsUpTo(D, Math.max(0, n - 160), i, 4), PH = pv.hi, PL = pv.lo;
    // ---- head & shoulders (top) and inverse ----
    const hs = (P, V, top) => {
      const val = top ? h : l, opp = top ? l : h, sg = top ? 1 : -1;
      for (let k = P.length - 1; k >= 2; k--) {
        const ls = P[k - 2], hd = P[k - 1], rs = P[k];
        if (i - rs > 40) break;
        const H = val[hd], LS = val[ls], RS = val[rs];
        if (sg * (H - LS) < 1.5 * at || sg * (H - RS) < 1.5 * at) continue;            // head clearly beyond both shoulders
        if (Math.abs(LS - RS) / H > 0.05) continue;                                      // shoulders roughly level
        const w1 = hd - ls, w2 = rs - hd; if (w1 < 5 || w2 < 5 || w2 / w1 > 2.2 || w1 / w2 > 2.2) continue; // time symmetry
        const t1 = V.filter(j => j > ls && j < hd), t2 = V.filter(j => j > hd && j < rs); if (!t1.length || !t2.length) continue;
        const n1 = t1.reduce((a, j) => (sg * opp[j] < sg * opp[a] ? j : a), t1[0]), n2 = t2.reduce((a, j) => (sg * opp[j] < sg * opp[a] ? j : a), t2[0]);
        const neck = fitLine([n1, n2], [opp[n1], opp[n2]]);
        if (Math.abs(neck.m) * (n2 - n1) > 0.6 * Math.abs(H - neck.at(hd))) continue;   // neckline not too steep
        // prior trend into the pattern
        const pre = Math.max(0, ls - 20); if (sg * (val[ls] - c[pre]) < 0) continue;
        const depth = Math.abs(H - neck.at(hd)), nk = neck.at(i);
        let broke = -1; for (let j = rs + 1; j <= i; j++) if (sg * (c[j] - neck.at(j)) < 0) { broke = j; break; }
        if (broke < 0 && sg * (c[i] - val[rs]) > 0) continue;                             // price back above right shoulder: invalid
        const status = broke >= 0 ? 'confirmed' : 'forming', tgt = nk - sg * depth;
        const q = 64 + (broke >= 0 ? 12 : 0) + (Math.abs(LS - RS) / H < 0.025 ? 6 : 0) + (I.v20[rs] && D.v[rs] < I.v20[rs] ? 4 : 0);
        out.push({ id: (top ? 'hs' : 'ihs') + hd, n: top ? 'Head & shoulders' : 'Inverse head & shoulders', b: -sg, q, status,
          note: `${status === 'confirmed' ? 'Neckline broken' : 'Neckline ' + R(nk) + ': a close ' + (top ? 'below' : 'above') + ' confirms'}. Pattern target ${R(tgt)}.`,
          target: R(tgt), stop: R(val[rs] + sg * 0.2 * at),
          lines: [{ pts: [[ls, LS], [n1, opp[n1]], [hd, H], [n2, opp[n2]], [rs, RS]], color: top ? RED : GREEN, w: 2 },
                  { pts: [[Math.max(0, n1 - 5), neck.at(Math.max(0, n1 - 5))], [i, nk]], color: GOLD, dash: 1, label: 'Neckline' }],
          marks: [{ i: ls, p: LS, t: 'LS', pos: top ? 'above' : 'below' }, { i: hd, p: H, t: 'H', pos: top ? 'above' : 'below' }, { i: rs, p: RS, t: 'RS', pos: top ? 'above' : 'below' }] });
        return;
      }
    };
    hs(PH, PL, true); hs(PL, PH, false);
    // ---- double top / bottom ----
    const dbl = (P, V, top) => {
      const val = top ? h : l, opp = top ? l : h, sg = top ? 1 : -1;
      if (P.length < 2) return; const a = P[P.length - 2], b2 = P[P.length - 1];
      if (b2 - a < 10 || i - b2 > 30 || Math.abs(val[a] - val[b2]) / val[a] > 0.03) return;
      const mid = V.filter(j => j > a && j < b2); if (!mid.length) return;
      const nkI = mid.reduce((x, j) => (sg * opp[j] < sg * opp[x] ? j : x), mid[0]), nk = opp[nkI], depth = Math.abs((val[a] + val[b2]) / 2 - nk);
      if (depth < 2 * at) return;
      let broke = false; for (let j = b2 + 1; j <= i; j++) if (sg * (c[j] - nk) < 0) broke = true;
      if (!broke && sg * (c[i] - Math.max(sg * val[a], sg * val[b2]) * sg) > 0) return;
      out.push({ id: (top ? 'dt' : 'db') + a, n: top ? 'Double top' : 'Double bottom', b: -sg, q: 60 + (broke ? 12 : 0) + (b2 - a >= 20 ? 4 : 0), status: broke ? 'confirmed' : 'forming',
        note: `Two ${top ? 'peaks' : 'troughs'} near ${R((val[a] + val[b2]) / 2)}; neckline ${R(nk)}. Target ${R(nk - sg * depth)}.`, target: R(nk - sg * depth), stop: R((top ? Math.max : Math.min)(val[a], val[b2]) + sg * 0.2 * at),
        lines: [{ pts: [[a, val[a]], [nkI, nk], [b2, val[b2]]], color: top ? RED : GREEN, w: 2 }, { pts: [[a, nk], [i, nk]], color: GOLD, dash: 1, label: 'Neckline' }],
        marks: [{ i: a, p: val[a], t: '1', pos: top ? 'above' : 'below' }, { i: b2, p: val[b2], t: '2', pos: top ? 'above' : 'below' }] });
    };
    dbl(PH, PL, true); dbl(PL, PH, false);
    // ---- flag with pole (bull and bear) ----
    for (let fl = 4; fl <= 15; fl++) {
      const pe = i - fl, ps = pe - 12; if (ps < 0) break;
      let lo = ps; for (let j = ps; j <= pe; j++) if (l[j] < l[lo]) lo = j;
      let hi = lo; for (let j = lo; j <= pe; j++) if (h[j] > h[hi]) hi = j;
      const poleUp = h[hi] - l[lo];
      if (hi >= lo + 3 && hi >= pe - 2 && poleUp / l[lo] > 0.08 && poleUp > 4 * at) {
        const xs = [], hs2 = [], ls2 = []; for (let j = hi; j <= i; j++) { xs.push(j); hs2.push(h[j]); ls2.push(l[j]); }
        if (xs.length < 4) continue;
        const up = fitLine(xs, hs2), dn = fitLine(xs, ls2), flagH = Math.max(...hs2) - Math.min(...ls2);
        const parallel = Math.abs(up.m - dn.m) * xs.length < 0.6 * flagH, retr = (h[hi] - Math.min(...ls2)) / poleUp;
        if (up.m <= at * 0.15 && parallel && retr < 0.5 && flagH < 0.6 * poleUp) {
          const brk = c[i] > up.at(i), tgt = (brk ? up.at(i) : h[hi]) + poleUp;
          out.push({ id: 'bf' + hi, n: 'Bull flag', b: 1, q: 64 + (brk ? 12 : 0) + (retr < 0.35 ? 6 : 0) + (I.v20[i] && D.v.slice(hi, i + 1).reduce((a2, b3) => a2 + b3, 0) / xs.length < I.v20[i] ? 4 : 0), status: brk ? 'breaking out' : 'forming',
            note: `Pole +${(poleUp / l[lo] * 100).toFixed(1)}%, ${xs.length}-bar flag retracing ${(retr * 100).toFixed(0)}%. ${brk ? 'Broke the flag top.' : 'Buy on a close above ' + R(up.at(i)) + '.'} Target ${R(tgt)}.`,
            target: R(tgt), stop: R(dn.at(i) - 0.2 * at),
            lines: [{ pts: [[lo, l[lo]], [hi, h[hi]]], color: GREEN, w: 3, label: 'Pole' }, { pts: [[hi, up.at(hi)], [i, up.at(i)]], color: BLUE }, { pts: [[hi, dn.at(hi)], [i, dn.at(i)]], color: BLUE }],
            marks: [{ i: hi, p: h[hi], t: 'Flag', pos: 'above' }] });
          break;
        }
      }
      let hiB = ps; for (let j = ps; j <= pe; j++) if (h[j] > h[hiB]) hiB = j;
      let loB = hiB; for (let j = hiB; j <= pe; j++) if (l[j] < l[loB]) loB = j;
      const poleDn = h[hiB] - l[loB];
      if (loB >= hiB + 3 && loB >= pe - 2 && poleDn / h[hiB] > 0.08 && poleDn > 4 * at) {
        const xs = [], hs2 = [], ls2 = []; for (let j = loB; j <= i; j++) { xs.push(j); hs2.push(h[j]); ls2.push(l[j]); }
        if (xs.length < 4) continue;
        const up = fitLine(xs, hs2), dn = fitLine(xs, ls2), flagH = Math.max(...hs2) - Math.min(...ls2);
        const parallel = Math.abs(up.m - dn.m) * xs.length < 0.6 * flagH, retr = (Math.max(...hs2) - l[loB]) / poleDn;
        if (dn.m >= -at * 0.15 && parallel && retr < 0.5 && flagH < 0.6 * poleDn) {
          const brk = c[i] < dn.at(i), tgt = (brk ? dn.at(i) : l[loB]) - poleDn;
          out.push({ id: 'brf' + loB, n: 'Bear flag', b: -1, q: 64 + (brk ? 12 : 0) + (retr < 0.35 ? 6 : 0), status: brk ? 'breaking down' : 'forming',
            note: `Pole −${(poleDn / h[hiB] * 100).toFixed(1)}%, ${xs.length}-bar flag. ${brk ? 'Broke the flag bottom.' : 'Sell on a close below ' + R(dn.at(i)) + '.'} Target ${R(tgt)}.`,
            target: R(tgt), stop: R(up.at(i) + 0.2 * at),
            lines: [{ pts: [[hiB, h[hiB]], [loB, l[loB]]], color: RED, w: 3, label: 'Pole' }, { pts: [[loB, up.at(loB)], [i, up.at(i)]], color: BLUE }, { pts: [[loB, dn.at(loB)], [i, dn.at(i)]], color: BLUE }],
            marks: [{ i: loB, p: l[loB], t: 'Flag', pos: 'below' }] });
          break;
        }
      }
    }
    // ---- triangles (ascending / descending / symmetrical) ----
    const rH = PH.filter(j => j >= i - 90), rL = PL.filter(j => j >= i - 90);
    if (rH.length >= 2 && rL.length >= 2) {
      const tH = rH.slice(-3), tL = rL.slice(-3), up = fitLine(tH, tH.map(j => h[j])), dn = fitLine(tL, tL.map(j => l[j]));
      const x0 = Math.min(tH[0], tL[0]), span = i - x0, w0 = up.at(x0) - dn.at(x0), wi = up.at(i) - dn.at(i);
      const flat = m => Math.abs(m) * span < 0.8 * at, rising = m => m * span > 1.2 * at, falling = m => m * span < -1.2 * at;
      let viol = 0; for (let j = x0; j <= i - 1; j++) if (c[j] > up.at(j) + 0.3 * at || c[j] < dn.at(j) - 0.3 * at) viol++;
      const touchesOk = tH.every(j => Math.abs(h[j] - up.at(j)) < 0.6 * at) && tL.every(j => Math.abs(l[j] - dn.at(j)) < 0.6 * at);
      const mono = (xs, v, s) => xs.every((x, k) => !k || s * (v[x] - v[xs[k - 1]]) > 0);
      let kind = null; if (!(flat(up.m) || mono(tH, h, -1)) || !(flat(dn.m) || mono(tL, l, 1))) kind = null; else if (flat(up.m) && rising(dn.m)) kind = ['Ascending triangle', 1]; else if (falling(up.m) && flat(dn.m)) kind = ['Descending triangle', -1]; else if (falling(up.m) && rising(dn.m)) kind = ['Symmetrical triangle', 0];
      if (kind && span >= 15 && w0 > 3 * at && wi > 0 && wi < 0.75 * w0 && viol <= 2 && touchesOk) {
        const bu = c[i] > up.at(i), bd = c[i] < dn.at(i), dir = bu ? 1 : bd ? -1 : kind[1];
        const tgt = dir >= 0 ? up.at(i) + w0 : dn.at(i) - w0;
        out.push({ id: 'tri' + x0, n: kind[0], b: dir, q: 60 + (bu || bd ? 14 : 0) + (tH.length + tL.length >= 5 ? 6 : 0), status: bu ? 'breaking out' : bd ? 'breaking down' : 'forming',
          note: `${tH.length} touches on top, ${tL.length} on the bottom. ${bu ? 'Broke out above ' + R(up.at(i)) : bd ? 'Broke down below ' + R(dn.at(i)) : 'Watch ' + R(up.at(i)) + ' (up) / ' + R(dn.at(i)) + ' (down)'}. Target ${R(tgt)}.`,
          target: R(tgt), stop: R(dir >= 0 ? dn.at(i) - 0.2 * at : up.at(i) + 0.2 * at),
          lines: [{ pts: [[x0, up.at(x0)], [i, up.at(i)]], color: RED, label: 'Resistance' }, { pts: [[x0, dn.at(x0)], [i, dn.at(i)]], color: GREEN, label: 'Support' }],
          marks: [] });
      }
    }
    // one pattern per stretch of chart: drop weaker patterns that mostly overlap a stronger one
    const span = p => { const xs = p.lines.flatMap(L => L.pts.map(q => q[0])); return [Math.min(...xs), Math.max(...xs)]; };
    const kept = [];
    for (const p of out) { const e = E.setupEdge && E.setupEdge(p.n); if (e) p.ev = e; }
    for (const p of out.filter(p => p.q >= 60).sort((a, b) => b.q - a.q)) {
      const [a1, a2] = span(p);
      if (kept.some(k => { const [b1, b2] = span(k), ov = Math.min(a2, b2) - Math.max(a1, b1); return ov > 0.6 * Math.min(a2 - a1, b2 - b1); })) continue;
      kept.push(p);
    }
    return kept;
  };
  // horizontal support / resistance: price zones touched 3+ times (pivot clusters), nearest above and below
  E.levels = function (I) {
    const D = I.D, i = I.n - 1, at = I.atr[i] || 1, pv = pivotsUpTo(D, Math.max(0, i - 250), i, 3);
    const pts = [...pv.hi.map(j => D.h[j]), ...pv.lo.map(j => D.l[j])].sort((a, b) => a - b), Z = [];
    for (const p of pts) { const z = Z.find(z => Math.abs(z.p - p) < 0.5 * at); if (z) { z.p = (z.p * z.n + p) / (z.n + 1); z.n++; } else Z.push({ p, n: 1 }); }
    const c = D.c[i], strong = Z.filter(z => z.n >= 3);
    const above = strong.filter(z => z.p > c).sort((a, b) => a.p - b.p).slice(0, 2), below = strong.filter(z => z.p < c).sort((a, b) => b.p - a.p).slice(0, 2);
    return [...above.map(z => ({ p: z.p, n: z.n, kind: 'R' })), ...below.map(z => ({ p: z.p, n: z.n, kind: 'S' }))];
  };

  // ---------- EMA cross forecast ----------
  E.emaCross = function (I) {
    const i = I.n - 1, out = [];
    const pairs = [['e9', 'e21', '9/21 EMA', 6, 'swing'], ['e20', 'e50', '20/50 EMA', 12, 'short'], ['e50', 'e200', '50/200 EMA (golden/death cross)', 25, 'long']];
    for (const [a, b, name, maxD, hz] of pairs) {
      const g = k => (I[a][k] - I[b][k]) / I[b][k];
      if (!ok(g(i)) || !ok(g(i - 5))) continue;
      let crossed = 0;
      for (let k = 0; k < 5; k++) if (Math.sign(g(i - k)) !== Math.sign(g(i - k - 1))) { crossed = k + 1; break; }
      if (crossed) { out.push({ name, dir: Math.sign(g(i)), status: `Crossed ${crossed === 1 ? 'today' : crossed - 1 + ' day(s) ago'}`, days: 0, hz }); continue; }
      const slope = (g(i) - g(i - 5)) / 5;
      if (g(i) < 0 && slope > 0) { const d = -g(i) / slope; if (d <= maxD) out.push({ name, dir: 1, status: `Bullish cross in ~${Math.max(1, Math.round(d))} day(s)`, days: d, gap: g(i) * 100, hz }); }
      if (g(i) > 0 && slope < 0) { const d = g(i) / -slope; if (d <= maxD) out.push({ name, dir: -1, status: `Bearish cross in ~${Math.max(1, Math.round(d))} day(s)`, days: d, gap: g(i) * 100, hz }); }
    }
    return out;
  };

  // ---------- options idea (F&O) ----------
  E.strikeStep = function (sym, price) {
    const idx = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100 };
    if (idx[sym]) return idx[sym];
    return price < 100 ? 2.5 : price < 250 ? 5 : price < 500 ? 10 : price < 1000 ? 20 : price < 2500 ? 50 : price < 5000 ? 100 : 250;
  };

  // ---------- full analysis ----------
  // D: {t,o,h,l,c,v} daily bars (oldest first); opts: {intra, tick, canShort, backtest, fnoSym, lot}
  E.analyze = function (D, opts = {}) {
    if (!D || D.c.length < 60) return { err: 'Not enough price history (need 60+ days).' };
    const tick = opts.tick || 0.05, I = E.indicators(D), i = I.n - 1;
    const price = opts.price || D.c[i];
    const hz = {};
    for (const k of Object.keys(H)) {
      if ((k === 'medium' && I.n < 160) || (k === 'long' && I.n < 210)) { hz[k] = { na: true, label: H[k].label, dur: H[k].dur }; continue; }
      const ex = { news: opts.news };
      const f = k === 'intraday' ? intradayFactors(I, i, opts.intra, ex) : factors(I, i, k, ex);
      const score = toScore(combine(f)), act = action(score, k, opts.canShort);
      const why = f.map(x => ({ w: x[0] * x[1], t: x[1] >= 0 ? x[2] : x[3] })).filter(x => Math.abs(x.w) > 0.2).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 4);
      const lv = act.d ? levels(I, i, k, act.d, tick, price) : null;
      if (lv && k === 'intraday' && ok(f.vwap)) lv.vwap = roundTick(f.vwap, tick);
      const bt = opts.backtest && k !== 'intraday' && k !== 'long' && (opts.backtest !== 'swing' || k === 'swing') ? backtest(I, k) : null;
      hz[k] = { label: H[k].label, dur: H[k].dur, score, action: act.a, dir: act.d, noShort: act.noShort, levels: lv, why, bt };
    }
    const wts = { intraday: 0.15, swing: 0.3, short: 0.25, medium: 0.2, long: 0.1 };
    let s = 0, w = 0; for (const k in wts) if (!hz[k].na) { s += wts[k] * hz[k].score; w += wts[k]; }
    const overall = Math.round(s / w);
    const pats = E.patterns(I, tick), cross = E.emaCross(I), sets = E.setups(I, i, tick);
    const hi52 = maxIn(D.h, i - 251, i), lo52 = minIn(D.l, i - 251, i);
    const res = {
      price, prev: D.c[i - 1], chg: (price / D.c[i - 1] - 1) * 100, overall, overallAction: action(overall, 'swing', opts.canShort).a,
      horizons: hz, patterns: pats, cross, setups: sets, chartPats: E.chartPatterns(I, tick), srLevels: E.levels(I),
      stats: { ret63: I.n > 63 ? (D.c[i] / D.c[i - 63] - 1) * 100 : NaN, ret126: I.n > 126 ? (D.c[i] / D.c[i - 126] - 1) * 100 : NaN, turnover: (() => { let s = 0, m = 0; for (let j = Math.max(0, i - 19); j <= i; j++) { s += D.c[j] * (D.v[j] || 0); m++; } return s / m; })(), rsi: I.rsi[i], adx: I.adx[i], atr: I.atr[i], atrPct: I.atr[i] / price * 100, volx: I.v20[i - 1] ? D.v[i] / I.v20[i - 1] : NaN, hi52, lo52, e20: I.e20[i], e50: I.e50[i], e200: I.e200[i], st: I.st.dir[i] },
      I,
    };
    if (opts.fnoSym) {
      const step = E.strikeStep(opts.fnoSym, price), atm = Math.round(price / step) * step;
      const pick = hz.intraday.dir || hz.swing.dir, src = hz.intraday.dir ? 'Intraday view' : 'Swing view';
      res.fno = {
        step, atm, lot: opts.lot || null,
        moveDay: I.atr[i], moveWeek: I.atr[i] * Math.sqrt(5),
        idea: (pick ? src + ' — ' : '') + (pick > 0 ? `Bullish: buy ${atm} CE or a ${atm}/${atm + 2 * step} bull call spread`
          : pick < 0 ? `Bearish: buy ${atm} PE or a ${atm}/${atm - 2 * step} bear put spread`
          : `Range-bound: avoid buying options; sellers may prefer a range outside ${Math.round((price - I.atr[i] * 2.2) / step) * step}–${Math.round((price + I.atr[i] * 2.2) / step) * step}`),
      };
    }
    return res;
  };

  // ---------- risk vs the index: beta, alpha, volatility, Sharpe, Sortino, drawdown ----------
  // D, M: daily bars with .day (YYYY-MM-DD). rf: risk-free rate % per year. Uses the last ~250 common sessions.
  E.risk = function (D, M, rf = 6) {
    if (!D || !M || !D.day || !M.day) return null;
    const mi = new Map(M.day.map((d, i) => [d, i])), rs = [], rm = [];
    for (let i = 1; i < D.c.length; i++) { const j = mi.get(D.day[i]), j0 = mi.get(D.day[i - 1]); if (j == null || j0 == null || j !== j0 + 1) continue; rs.push(D.c[i] / D.c[i - 1] - 1); rm.push(M.c[j] / M.c[j0] - 1); }
    const n0 = Math.max(0, rs.length - 250), S = rs.slice(n0), Mk = rm.slice(n0), n = S.length;
    if (n < 120) return { na: true, n };
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length, ms = mean(S), mm = mean(Mk);
    let cov = 0, vm = 0, vs = 0; for (let k = 0; k < n; k++) { cov += (S[k] - ms) * (Mk[k] - mm); vm += (Mk[k] - mm) ** 2; vs += (S[k] - ms) ** 2; }
    const beta = cov / vm, corr = cov / Math.sqrt(vm * vs);
    const sub = sgn => { const a = [], b = []; for (let k = 0; k < n; k++) if (sgn * Mk[k] > 0) { a.push(S[k]); b.push(Mk[k]); } const x = mean(a), y = mean(b); let c2 = 0, v2 = 0; for (let k = 0; k < a.length; k++) { c2 += (a[k] - x) * (b[k] - y); v2 += (b[k] - y) ** 2; } return c2 / v2; };
    const annS = ms * 250 * 100, annM = mm * 250 * 100, vol = Math.sqrt(vs / (n - 1)) * Math.sqrt(250) * 100;
    const down = S.filter(x => x < 0), dvol = Math.sqrt(down.reduce((x, y) => x + y * y, 0) / Math.max(1, n)) * Math.sqrt(250) * 100;
    let peak = -Infinity, mdd = 0, eq = 1; for (const x of S) { eq *= 1 + x; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
    const alpha = (annS - rf) - beta * (annM - rf);
    const r = v => Math.round(v * 100) / 100;
    return { beta: r(beta), alpha: r(alpha), corr: r(corr), r2: r(corr * corr), upBeta: r(sub(1)), downBeta: r(sub(-1)), vol: r(vol), sharpe: r((annS - rf) / vol), sortino: r((annS - rf) / (dvol || 1e-9)), mdd: r(mdd * 100), ret: r(annS), mret: r(annM), n };
  };
  E.riskLabel = function (k) {
    if (!k || k.na) return null;
    const style = k.r2 < 0.12 ? 'Moves independently' : k.beta >= 1.25 ? 'Aggressive' : k.beta <= 0.8 ? 'Defensive' : 'Market-like';
    const leader = k.alpha > 0 && k.sortino > 1 && k.upBeta > k.downBeta;
    return { style, leader, text: `${style} · beta ${k.beta.toFixed(2)}${leader ? ' · Leader' : ''}` };
  };

  // ---------- unified rating (identical in scanner and stock page) ----------
  // signal = trend/momentum/setup score across swing..long; edge = how this signal actually performed on this stock;
  // + market regime and news nudges. intraday is excluded so the number doesn't change with 5-min noise.
  E.rating = function (res, ctx = {}) {
    const H2 = res.horizons, W = { swing: 0.35, short: 0.3, medium: 0.2, long: 0.15 };
    let s = 0, w = 0; for (const k in W) if (H2[k] && !H2[k].na) { s += W[k] * H2[k].score; w += W[k]; }
    const signal = w ? s / w : 50;
    const bt = H2.swing && H2.swing.bt; let edge = null, ew = 0;
    if (bt && bt.n >= 6) { const p = (bt.wins + 1) / (bt.n + 2), ev = p * 1.5 - (1 - p); edge = clamp(50 + 40 * ev, 0, 100); ew = Math.min(0.45, bt.n / 60); }
    let r = edge == null ? 50 + (signal - 50) * 0.85 : (1 - ew) * signal + ew * edge;
    const reg = ok(ctx.regime) ? ctx.regime : 0, nw = ok(ctx.news) ? ctx.news : 0;
    const bt0 = ok(ctx.beta) ? clamp(ctx.beta, 0.3, 2) : 1, regAdj = Math.round(clamp((reg - 50) / 10 * bt0, -7, 7)), newsAdj = Math.round(8 * clamp(nw));
    r = Math.round(clamp(r + regAdj + newsAdj, 0, 100));
    const a = r >= 70 ? 'STRONG BUY' : r >= 58 ? 'BUY' : r > 42 ? 'HOLD / WAIT' : r > 30 ? 'SELL / AVOID' : 'STRONG SELL';
    return { rating: r, action: a, signal: Math.round(signal), edge: edge == null ? null : Math.round(edge), regAdj, newsAdj, bt };
  };

  // per-horizon rating: that horizon's signal blended with how that signal performed on this stock (its own backtest)
  E.hzRating = function (h, hz, ctx = {}) {
    if (!h || h.na) return null;
    const P = H[hz], bt = h.bt; let edge = null, ew = 0;
    if (bt && bt.n >= 6) { const p = (bt.wins + 1) / (bt.n + 2), ev = p * P.t1 - (1 - p); edge = clamp(50 + 40 * ev, 0, 100); ew = Math.min(0.45, bt.n / 60); }
    let r = edge == null ? 50 + (h.score - 50) * (hz === 'intraday' ? 1 : 0.85) : (1 - ew) * h.score + ew * edge;
    const regAdj = hz === 'long' ? 0 : Math.round(clamp(((ok(ctx.regime) ? ctx.regime : 50) - 50) / 10 * (ok(ctx.beta) ? clamp(ctx.beta, 0.3, 2) : 1), -7, 7));
    const newsAdj = hz === 'long' ? 0 : Math.round((hz === 'intraday' ? 10 : 8) * clamp(ok(ctx.news) ? ctx.news : 0));
    r = Math.round(clamp(r + regAdj + newsAdj, 0, 100));
    const a = action(r, hz, ctx.canShort);
    return { rating: r, action: a.a, dir: a.d, noShort: a.noShort, signal: h.score, edge: edge == null ? null : Math.round(edge), regAdj, newsAdj, bt };
  };
  // Scan: same history + same backtests as the stock page, no intraday bars
  E.quick = function (D, opts = {}) {
    const r = E.analyze(D, Object.assign({}, opts, { backtest: true }));
    if (r.err) return r;
    const H2 = r.horizons; delete r.I;
    const slim = h => h && !h.na ? { score: h.score, action: h.action, dir: h.dir, bt: h.bt } : h;
    return { price: r.price, chg: r.chg, overall: r.overall, act: r.overallAction, swing: slim(H2.swing), short: slim(H2.short), intraday: slim(H2.intraday), long: slim(H2.long), medium: slim(H2.medium), horizons: { swing: slim(H2.swing), short: slim(H2.short), medium: slim(H2.medium), long: slim(H2.long) }, turnover: r.stats.turnover, ret63: r.stats.ret63, patterns: r.patterns.map(p => ({ n: p.n, b: p.b })), setups: r.setups.map(s => ({ n: s.n, k: s.k, b: s.b, q: s.q })), chartPats: (r.chartPats || []).map(p => ({ n: p.n, b: p.b, q: p.q, status: p.status, target: p.target })), cross: r.cross, volx: r.stats.volx, rsi: r.stats.rsi };
  };

  E._factors = (I, i, hz) => factors(I, i, hz, {});
  if (typeof module !== 'undefined' && module.exports) module.exports = E; else root.Engine = E;
})(typeof self !== 'undefined' ? self : this);
