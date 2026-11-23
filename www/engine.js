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
  function factors(I, i, hz) {
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
      add(1.5, sgn(c - I.e20[i]), 'Price above 20 EMA', 'Price below 20 EMA');
      add(1.5, mh > 0 ? (mh > mp ? 1 : 0.3) : (mh > mp ? -0.3 : -1), 'MACD momentum rising', 'MACD momentum falling');
      add(1.5, r > 78 ? -0.5 : r > 68 ? 0.3 : r >= 50 ? 1 : r >= 40 ? -0.3 : r >= 30 ? -0.7 : 0.2, `RSI ${r | 0} in bullish zone`, r > 78 ? `RSI ${r | 0} overbought` : `RSI ${r | 0} weak`);
      add(1.5, I.st.dir[i], 'Supertrend bullish', 'Supertrend bearish');
      add(1, volx > 1.5 ? sgn(c - C[i - 1]) : 0, `Volume ${volx.toFixed(1)}× average on an up day`, `Volume ${volx.toFixed(1)}× average on a down day`);
      add(1, c > hi20 ? 1 : c < lo20 ? -1 : 0, 'Closed above 20-day high', 'Closed below 20-day low');
      add(1, sgn(c - I.e50[i]), 'Above 50 EMA (trend support)', 'Below 50 EMA');
    } else if (hz === 'short') {
      add(2, sgn(I.e20[i] - I.e50[i]), '20 EMA above 50 EMA', '20 EMA below 50 EMA');
      add(1.5, sgn(c - I.e50[i]), 'Price above 50 EMA', 'Price below 50 EMA');
      add(1.5, trendStrong ? sgn(I.pdi[i] - I.mdi[i]) : 0, `ADX ${I.adx[i] | 0}: strong uptrend`, `ADX ${I.adx[i] | 0}: strong downtrend`);
      add(1.5, roc(20) / 10, `+${roc(20).toFixed(1)}% in 1 month`, `${roc(20).toFixed(1)}% in 1 month`);
      add(1, sgn(mh), 'MACD above signal', 'MACD below signal');
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
    return f;
  }
  function combine(f) {
    let s = 0, w = 0; for (const x of f) { s += x[0] * x[1]; w += x[0]; }
    return w ? s / w : 0;
  }
  function intradayFactors(I, i, intra) {
    const f = [], add = (w, x, up, dn) => { if (ok(x)) f.push([w, clamp(x), up, dn]); };
    add(1, combine(factors(I, i, 'swing')), 'Daily trend supportive', 'Daily trend against');
    if (!intra || !intra.c.length) return f;
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
      for (let j = i - k; j <= i + k; j++) { if (D.h[j] > D.h[i]) H1 = false; if (D.l[j] < D.l[i]) L1 = false; }
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
      const f = k === 'intraday' ? intradayFactors(I, i, opts.intra) : factors(I, i, k);
      const score = toScore(combine(f)), act = action(score, k, opts.canShort);
      const why = f.map(x => ({ w: x[0] * x[1], t: x[1] >= 0 ? x[2] : x[3] })).filter(x => Math.abs(x.w) > 0.2).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 4);
      const lv = act.d ? levels(I, i, k, act.d, tick, price) : null;
      if (lv && k === 'intraday' && ok(f.vwap)) lv.vwap = roundTick(f.vwap, tick);
      const bt = opts.backtest && k !== 'intraday' && k !== 'long' ? backtest(I, k) : null;
      hz[k] = { label: H[k].label, dur: H[k].dur, score, action: act.a, dir: act.d, noShort: act.noShort, levels: lv, why, bt };
    }
    const wts = { intraday: 0.15, swing: 0.3, short: 0.25, medium: 0.2, long: 0.1 };
    let s = 0, w = 0; for (const k in wts) if (!hz[k].na) { s += wts[k] * hz[k].score; w += wts[k]; }
    const overall = Math.round(s / w);
    const pats = E.patterns(I, tick), cross = E.emaCross(I);
    const hi52 = maxIn(D.h, i - 251, i), lo52 = minIn(D.l, i - 251, i);
    const res = {
      price, prev: D.c[i - 1], chg: (price / D.c[i - 1] - 1) * 100, overall, overallAction: action(overall, 'swing', opts.canShort).a,
      horizons: hz, patterns: pats, cross,
      stats: { rsi: I.rsi[i], adx: I.adx[i], atr: I.atr[i], atrPct: I.atr[i] / price * 100, volx: I.v20[i - 1] ? D.v[i] / I.v20[i - 1] : NaN, hi52, lo52, e20: I.e20[i], e50: I.e50[i], e200: I.e200[i], st: I.st.dir[i] },
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

  // Lightweight scan for many symbols (no backtest, no intraday)
  E.quick = function (D, opts = {}) {
    const r = E.analyze(D, Object.assign({}, opts, { backtest: false }));
    if (r.err) return r;
    const H2 = r.horizons; delete r.I;
    return { price: r.price, chg: r.chg, overall: r.overall, act: r.overallAction, swing: H2.swing, short: H2.short, intraday: H2.intraday, long: H2.long, medium: H2.medium, patterns: r.patterns.map(p => ({ n: p.n, b: p.b })), cross: r.cross, volx: r.stats.volx, rsi: r.stats.rsi };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E; else root.Engine = E;
})(typeof self !== 'undefined' ? self : this);
