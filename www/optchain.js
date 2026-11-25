/* DayTrader Desk — option chain data + maths (options agent, round 4).
   window.OC in the app; in Node `require('./www/optchain.js')` gives the pure maths (tools/optchain.test.js).

   Data sources, best first:
   1. NSE option chain JSON (www.nseindia.com, phone only: native HTTP bypasses CORS; needs a cookie from the
      /option-chain page first). Current API (2025-26): /api/option-chain-contract-info?symbol=X (expiry list) +
      /api/option-chain-v3?type=Indices|Equity&symbol=X&expiry=DD-Mon-YYYY. Older API kept as fallback:
      /api/option-chain-indices?symbol=X · /api/option-chain-equities?symbol=X (all expiries in one reply).
      Gives LTP, change, OI, change in OI, volume, IV, best bid/ask. Cached 30 s.
   2. mStock (when logged in): live LTP overlaid on the NSE rows on screen; mStock-only chain when NSE fails
      (strikes from the script master, LTP + previous close from the quote API; no OI/volume/IV from mStock).
   3. Model (neither available): Black-Scholes premiums from India VIX / historical volatility, clearly labelled
      "estimated premiums".
   IV is solved from the LTP when the source has none; Greeks are Black-Scholes (r = 6.5 %, q = 0), time to expiry
   in calendar time to 15:30 IST on expiry day (the convention NSE uses for its IV column). Nothing here places orders. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const OC = {};
  // exact listed contract (for the trade tracker): {k:'NFO:…', lot, exp, strike} from mStock's contract list, or null
  OC.contract = async function (und, exp, strike, cp) {
    if (typeof MS === 'undefined' || !MS.optContracts) return null;
    const L = await MS.optContracts(und).catch(() => null); if (!L) return null;
    const r = L.find(x => x[2] === exp && Math.abs(+x[3] - +strike) < 1e-6 && x[4] === cp); return r ? { k: r[6] + ':' + r[0], lot: r[5], exp: r[2], strike: +r[3] } : null;
  };
  const ok = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r2 = x => Math.round(x * 100) / 100;
  const r05 = x => Math.round(x * 20) / 20; // NSE option tick = ₹0.05
  const f2 = x => (+x).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  OC.RF = 0.065;
  OC.INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX'];
  OC.BSE = ['SENSEX', 'BANKEX', 'SENSEX50']; // not on NSE's option chain: mStock or model only
  OC.isIndex = u => OC.INDICES.includes(u) || u === 'SENSEX50';

  // ======================================================================================================
  // 1. Black-Scholes, implied volatility, time to expiry
  // ======================================================================================================
  function ncdf(x) { // Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  const npdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  OC.ncdf = ncdf;
  // S spot, K strike, T years, sig annual vol (0.15 = 15 %), cp 'CE'|'PE'
  // → {p, delta, gamma (per ₹1 of spot), theta (₹ per calendar day), vega (₹ per 1 vol point), pitm (risk-neutral N(d2))}
  OC.bs = function (S, K, T, sig, cp, r = OC.RF, q = 0) {
    const intr = cp === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    if (!(S > 0) || !(K > 0)) return { p: 0, delta: 0, gamma: 0, theta: 0, vega: 0, pitm: 0 };
    if (!(T > 0) || !(sig > 0)) return { p: intr, delta: intr > 0 ? (cp === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, pitm: intr > 0 ? 1 : 0 };
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T), pd = npdf(d1);
    const p = cp === 'CE' ? S * dq * ncdf(d1) - K * dr * ncdf(d2) : K * dr * ncdf(-d2) - S * dq * ncdf(-d1);
    const delta = cp === 'CE' ? dq * ncdf(d1) : dq * (ncdf(d1) - 1);
    const gamma = dq * pd / (S * sig * sq);
    const th = -S * dq * pd * sig / (2 * sq) + (cp === 'CE' ? q * S * dq * ncdf(d1) - r * K * dr * ncdf(d2) : -q * S * dq * ncdf(-d1) + r * K * dr * ncdf(-d2));
    return { p: Math.max(p, 0), delta, gamma, theta: th / 365, vega: S * dq * pd * sq / 100, pitm: cp === 'CE' ? ncdf(d2) : ncdf(-d2) };
  };
  // implied vol from a premium: Newton steps kept inside a shrinking bisection bracket. null when the price is
  // below intrinsic (stale / illiquid quote) or above the no-arbitrage ceiling.
  OC.iv = function (price, S, K, T, cp, r = OC.RF, q = 0) {
    if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
    const dr = Math.exp(-r * T), dq = Math.exp(-q * T);
    const lower = cp === 'CE' ? Math.max(0, S * dq - K * dr) : Math.max(0, K * dr - S * dq), upper = cp === 'CE' ? S * dq : K * dr;
    if (price <= lower + 1e-9 || price >= upper) return null;
    let lo = 1e-4, hi = 5, x = 0.25;
    if (OC.bs(S, K, T, hi, cp, r, q).p < price) return null;
    for (let i = 0; i < 100; i++) {
      const b = OC.bs(S, K, T, x, cp, r, q), f = b.p - price;
      if (Math.abs(f) < 1e-6) return x;
      if (f > 0) hi = x; else lo = x;
      const vg = b.vega * 100; // ∂p/∂σ
      let nx = vg > 1e-10 ? x - f / vg : (lo + hi) / 2;
      if (!(nx > lo && nx < hi)) nx = (lo + hi) / 2;
      if (Math.abs(nx - x) < 1e-8) return nx;
      x = nx;
    }
    return x;
  };
  const expMs = exp => Date.parse(exp + 'T15:30:00+05:30');
  // years to expiry (calendar time to 15:30 IST on expiry day)
  OC.tYears = (exp, now = Date.now()) => Math.max(0, expMs(exp) - now) / (365 * 864e5);
  const istParts = (t = Date.now()) => { const d = new Date(t + 5.5 * 3600e3); return { day: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const addDay = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const holidays = () => (typeof NSE_HOLIDAYS !== 'undefined' ? NSE_HOLIDAYS : (root && root.NSE_HOLIDAYS) || new Set()); // eslint-disable-line no-undef
  OC.isTradingDay = s => { const w = new Date(s + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6 && !holidays().has(s); };
  // trading sessions left including today's (if it has not closed) and the expiry day itself
  OC.tradingDaysLeft = function (exp, now = Date.now()) {
    const p = istParts(now); let d = p.day, n = 0;
    if (p.mins >= 930) d = addDay(d, 1);
    for (let k = 0; d <= exp && k < 400; k++, d = addDay(d, 1)) if (OC.isTradingDay(d)) n++;
    return n;
  };
  OC.calDaysLeft = (exp, now = Date.now()) => Math.max(0, (expMs(exp) - now) / 864e5);

  // ======================================================================================================
  // 2. Chain analytics
  // ======================================================================================================
  OC.INTERP = { LB: 'Long build-up', SB: 'Short build-up', SC: 'Short covering', LU: 'Long unwinding' };
  // price change × change in OI → who is active at this strike
  OC.interpret = (chg, doi) => !(chg) || !(doi) ? '' : chg > 0 ? (doi > 0 ? 'LB' : 'SC') : (doi > 0 ? 'SB' : 'LU');
  // max pain: the expiry level at which option BUYERS collect the least (writers pay out least)
  OC.maxPain = function (rows) {
    let best = null, bestV = Infinity;
    for (const x of rows) {
      let v = 0;
      for (const r of rows) {
        if (r.ce && r.ce.oi) v += r.ce.oi * Math.max(0, x.k - r.k);
        if (r.pe && r.pe.oi) v += r.pe.oi * Math.max(0, r.k - x.k);
      }
      if (v < bestV) { bestV = v; best = x.k; }
    }
    return rows.some(r => (r.ce && r.ce.oi) || (r.pe && r.pe.oi)) ? best : null;
  };
  // fill iv (solved when missing), Greeks and OI interpretation on every side of every row
  OC.enrich = function (ch, now = Date.now()) {
    const T = OC.tYears(ch.exp, now), S = ch.spot; ch.T = T;
    for (const r of ch.rows) for (const cp of ['CE', 'PE']) {
      const x = r[cp.toLowerCase()]; if (!x) continue;
      if (!(x.ivSrc > 0)) x.iv = x.ltp > 0 ? OC.iv(x.ltp, S, r.k, T, cp) : null; else x.iv = x.ivSrc;
      x.g = x.iv ? OC.bs(S, r.k, T, x.iv, cp) : null;
      x.interp = OC.interpret(x.chg, x.doi);
      x.itm = cp === 'CE' ? r.k < S : r.k > S;
    }
    return ch;
  };
  OC.analytics = function (ch) {
    const R = ch.rows, S = ch.spot; if (!R.length) return {};
    const sum = (f) => R.reduce((a, r) => a + (f(r) || 0), 0);
    const ceOI = sum(r => r.ce && r.ce.oi), peOI = sum(r => r.pe && r.pe.oi), ceV = sum(r => r.ce && r.ce.vol), peV = sum(r => r.pe && r.pe.vol);
    const atmR = R.reduce((b, r) => !b || Math.abs(r.k - S) < Math.abs(b.k - S) ? r : b, null);
    const argmax = f => { let b = null; for (const r of R) { const v = f(r); if (v > 0 && (!b || v > f(b))) b = r; } return b ? b.k : null; };
    const step = R.length > 1 ? Math.min(...R.slice(1).map((r, i) => r.k - R[i].k).filter(d => d > 0)) : 0;
    const straddle = atmR && atmR.ce && atmR.pe && atmR.ce.ltp > 0 && atmR.pe.ltp > 0 ? atmR.ce.ltp + atmR.pe.ltp : null;
    const ivs = atmR ? [atmR.ce && atmR.ce.iv, atmR.pe && atmR.pe.iv].filter(v => v > 0) : [];
    const atmIV = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
    const sigMove = atmIV && ch.T ? S * atmIV * Math.sqrt(ch.T) : null;
    // skew: OTM put IV − OTM call IV about one expected move away (vol points)
    let skew = null;
    if (atmR && step) {
      const d = Math.max(step, Math.round((straddle || sigMove || step) / step) * step), pr = R.find(r => r.k === atmR.k - d), cr = R.find(r => r.k === atmR.k + d);
      if (pr && cr && pr.pe && cr.ce && pr.pe.iv && cr.ce.iv) skew = { pts: r2((pr.pe.iv - cr.ce.iv) * 100), d, put: pr.pe.iv, call: cr.ce.iv };
    }
    const hasOI = ceOI + peOI > 0;
    return {
      atm: atmR && atmR.k, step, hasOI,
      pcr: hasOI && ceOI ? peOI / ceOI : null, pcrVol: ceV ? peV / ceV : null, ceOI, peOI,
      maxPain: hasOI ? OC.maxPain(R) : null,
      straddle, expMove: straddle, sigMove, atmIV,
      res: argmax(r => r.ce && r.ce.oi), sup: argmax(r => r.pe && r.pe.oi),
      buildCE: argmax(r => r.ce && r.ce.doi), buildPE: argmax(r => r.pe && r.pe.doi),
      unwindCE: argmax(r => r.ce && -r.ce.doi), unwindPE: argmax(r => r.pe && -r.pe.doi),
      skew, maxCeOI: Math.max(0, ...R.map(r => (r.ce && r.ce.oi) || 0)), maxPeOI: Math.max(0, ...R.map(r => (r.pe && r.pe.oi) || 0)),
    };
  };
  // compact Indian number: 1.2K · 3.4L · 1.1Cr
  OC.cmp = function (n, d = 1) {
    if (n == null || !isFinite(n)) return '–';
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e7) return s + (a / 1e7).toFixed(a >= 1e8 ? 0 : d) + 'Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(a >= 1e6 ? 0 : d) + 'L';
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : d) + 'K';
    return s + Math.round(a);
  };
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  OC.toNse = iso => `${iso.slice(8, 10)}-${MONS[+iso.slice(5, 7) - 1]}-${iso.slice(0, 4)}`; // 2026-11-25 → 25-Nov-2026
  OC.fromNse = s => { const m = String(s || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/); if (!m) return null; const mo = MONS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); return mo < 0 ? null : `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`; };
  OC.expLabel = iso => { const d = new Date(iso + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  OC.dayName = iso => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T00:00:00Z').getUTCDay()];

  // ======================================================================================================
  // 3. Professional call: contract selection + premium plan from real chain data
  // ======================================================================================================
  OC.CFG = {
    deltaLo: 0.45, deltaHi: 0.65, deltaAim: 0.55,
    minSlPct: 0.15,   // premium stop at least 15 % below entry (noise)
    maxSlPct: 0.45,   // and never more than 45 % (cap: exit on the premium even if spot hasn't hit its stop)
    maxSpreadPct: 0.03, minOIShare: 0.08, minRR: 1.2, minConf: 60,
    holdDays: { intraday: 0.2, swing: 3 },   // calendar days of theta charged to targets (half to the stop)
    minDaysLeft: { intraday: 2, swing: 4 },  // trading days to expiry; nearer → next expiry
  };
  // Premium after the underlying moves dS (to S1) and `days` calendar days pass.
  // Taylor: P0 + Δ·dS + ½Γ·dS² + Θ·days (Θ per calendar day, negative for a long option).
  // When the IV and time are known (m = {iv, T, S0}) the premium is ALSO fully re-priced with Black-Scholes at (S1, T − days)
  // plus the market-vs-model basis; for targets the lower of the two is used (the constant-gamma Taylor term overshoots
  // badly for big moves near expiry), for the stop the re-priced value (where the stop really triggers). Never below intrinsic.
  OC.project = function (P0, g, dS, days, K, S1, cp, m) {
    const intr = cp === 'CE' ? Math.max(0, S1 - K) : Math.max(0, K - S1);
    let p = P0 + g.delta * dS + 0.5 * g.gamma * dS * dS + g.theta * days;
    if (m && m.iv > 0 && m.T > 0 && m.S0 > 0) {
      const T1 = Math.max(m.T - days / 365, 1 / (365 * 1440)), basis = P0 - OC.bs(m.S0, K, m.T, m.iv, cp).p, full = OC.bs(S1, K, T1, m.iv, cp).p + basis;
      p = (cp === 'CE' ? S1 - m.S0 : m.S0 - S1) > 0 ? Math.min(p, full) : full;
    }
    return Math.max(intr, 0.05, p);
  };
  // which expiry to trade: nearest with enough sessions left
  OC.pickExpiry = function (expiries, hz, now = Date.now(), cfg) {
    const need = ((cfg || OC.CFG).minDaysLeft[hz]) || 2;
    return expiries.find(e => OC.tradingDaysLeft(e, now) >= need) || expiries[expiries.length - 1] || null;
  };
  // o: analysis from indexOption() {sym, side, ce, pe, L:{entry,stop,t1,t2}, hzKey:'intraday'|'swing', open, late}
  // ch: enriched chain with analytics; ctx: {hv (annual), vix (pts), now}
  OC.buildCall = function (o, ch, ctx = {}) {
    const C = ctx.cfg || OC.CFG, tune = ctx.tune || null, now = ctx.now || Date.now(), hz = o.hzKey === 'intraday' ? 'intraday' : 'swing'; // ctx.cfg / ctx.tune: tuned parameters (data/fno_params.json); absent → today's constants
    const res = { sym: o.sym, side: o.side, hz, conv: Math.max(o.ce || 0, o.pe || 0), why: [], warn: [], at: now };
    const no = t => Object.assign(res, { notrade: t });
    if (!o.side) return no(o.blockWhy || `Neither side is rated ${o.thr || 65}+ (CALL ${o.ce} · PUT ${o.pe}). Without an edge, time decay beats option buyers. Wait.`);
    if (o.late) return no('Last hour of the session: theta decay is fastest and there is no time for the move. No fresh option buys today.');
    if (!o.L) return no(`The ${o.side === 'CE' ? 'bullish' : 'bearish'} rating has no valid entry/stop/target on the ${hz} chart yet.`);
    if (!ch || !ch.rows || !ch.rows.length) return no('No option prices available for this underlying right now.');
    const cp = o.side, sd = cp.toLowerCase(), dir = cp === 'CE' ? 1 : -1, S = ch.spot, L = o.L, an = ch.an || {};
    res.exp = ch.exp; res.daysLeft = OC.tradingDaysLeft(ch.exp, now); res.calDays = OC.calDaysLeft(ch.exp, now); res.lot = ch.lot; res.src = ch.src; res.est = ch.src === 'Model';
    // ---- candidates: right side, priced, Greeks known, within ±12 strikes of ATM
    const near = ch.rows.filter(r => r[sd] && r[sd].ltp > 0 && r[sd].g && Math.abs(r.k - S) <= 12 * (an.step || S * 0.01));
    const maxOI = Math.max(0, ...near.map(r => r[sd].oi || 0)), ois = near.map(r => r[sd].oi || 0).filter(v => v > 0).sort((a, b) => a - b), medOI = ois.length ? ois[ois.length >> 1] : 0;
    const liq = r => {
      const x = r[sd], why = [];
      if (medOI > 0 && (x.oi || 0) < C.minOIShare * medOI * 3) why.push('low OI'); // < 25 % of the typical strike's OI
      if (x.bid > 0 && x.ask > 0 && (x.ask - x.bid) / ((x.ask + x.bid) / 2) > C.maxSpreadPct && x.ask - x.bid > 0.5) why.push('wide bid/ask');
      if (ch.src !== 'Model' && ch.hasVol && !(x.vol > 0) && o.open) why.push('no volume');
      return why;
    };
    const scored = near.map(r => { const d = Math.abs(r[sd].g.delta), lw = liq(r); return { r, d, lw, inBand: d >= C.deltaLo && d <= C.deltaHi, score: -Math.abs(d - C.deltaAim) * 10 + (maxOI ? (r[sd].oi || 0) / maxOI : 0) * 0.6 - lw.length * 3 }; });
    let pick = ctx.lockK != null ? scored.find(x => x.r.k === ctx.lockK && !x.lw.length) : null; // live ticks keep the chosen strike
    if (!pick) pick = scored.filter(x => x.inBand && !x.lw.length).sort((a, b) => b.score - a.score)[0];
    if (!pick) {
      pick = scored.filter(x => !x.lw.length && x.d >= 0.35 && x.d <= 0.75).sort((a, b) => b.score - a.score)[0];
      if (pick) res.warn.push(`No liquid strike inside delta ${C.deltaLo}–${C.deltaHi}; nearest liquid one has delta ${pick.d.toFixed(2)}.`);
    }
    if (!pick) return no(`No liquid ${cp} strike near delta ${C.deltaLo}–${C.deltaHi} (low OI / wide spreads). Illiquid options cost you on entry and exit.`);
    const r = pick.r, x = r[sd], g = x.g, K = r.k, P0 = x.ltp;
    res.k = K; res.cp = cp; res.key = x.key || null; res.ltp = P0; res.g = g; res.iv = x.iv; res.oi = x.oi; res.doi = x.doi; res.vol = x.vol; res.bid = x.bid; res.ask = x.ask;
    res.strikeWhy = `Delta ${Math.abs(g.delta).toFixed(2)} (aim ${C.deltaLo}–${C.deltaHi}: moves ~${Math.round(Math.abs(g.delta) * 100)} paise per ₹1 of ${o.sym}, cheaper than ITM, decays slower than OTM)` +
      (x.oi ? ` · OI ${OC.cmp(x.oi)}${maxOI ? ` (${Math.round(x.oi / maxOI * 100)}% of the side's max)` : ''}` : '') +
      (x.bid > 0 && x.ask > 0 ? ` · spread ₹${r2(x.ask - x.bid)}` : '') + (res.daysLeft != null ? ` · ${res.daysLeft} trading day${res.daysLeft === 1 ? '' : 's'} to expiry` : '');
    // ---- entry range from live LTP ± half spread / slippage
    const half = x.bid > 0 && x.ask > x.bid ? (x.ask - x.bid) / 2 : 0, slip = Math.max(half, P0 * 0.005, 0.05);
    res.entryLo = r05(Math.max(0.05, P0 - slip)); res.entryHi = r05(P0 + slip); const E = res.entryHi;
    // ---- premium plan from the underlying plan (Δ + ½Γ·ΔS² + θ·days)
    const hd = C.holdDays[hz];
    const M = { iv: x.iv, T: OC.tYears(ch.exp, now), S0: S };
    const slRaw = OC.project(P0, g, L.stop - S, hd / 2, K, L.stop, cp, M);
    let sl = Math.min(slRaw, P0 * (1 - C.minSlPct)); res.slCapped = false;
    if (sl < P0 * (1 - C.maxSlPct)) { sl = P0 * (1 - C.maxSlPct); res.slCapped = true; }
    res.sl = r05(sl); res.t1 = r05(OC.project(P0, g, L.t1 - S, hd / 2, K, L.t1, cp, M)); res.t2 = r05(OC.project(P0, g, L.t2 - S, hd, K, L.t2, cp, M));
    res.slU = L.stop; res.t1U = L.t1; res.t2U = L.t2; res.entryU = L.entry; res.spot = S;
    if (tune) { // tuned exits (backtested by tools/fno_research.js): underlying stop in ATR, target as premium multiple / ATR, fixed premium stop already applied via C
      const atr = ctx.atr > 0 ? ctx.atr : null, mid = hd / 2;
      if (tune.stopU != null && tune.stopU !== 'lvl' && atr) { res.slU = r2(S - dir * tune.stopU * atr); const s2 = OC.project(P0, g, res.slU - S, mid, K, res.slU, cp, M); res.sl = r05(Math.min(s2, P0 * (1 - C.minSlPct))); if (res.sl < P0 * (1 - C.maxSlPct)) { res.sl = r05(P0 * (1 - C.maxSlPct)); res.slCapped = true; } }
      else if (tune.stopU === null) res.warn.push('Tuned exit: no underlying stop, only the premium stop (' + Math.round(C.maxSlPct * 100) + '%).');
      if (tune.tgt && tune.tgt.kind === 'prem') { res.t1 = r05(P0 * (1 + tune.tgt.v)); res.t2 = r05(P0 * (1 + 1.5 * tune.tgt.v)); res.warn.push(`Tuned exit: book everything at +${Math.round(tune.tgt.v * 100)}% premium (Target 1).`); }
      else if (tune.tgt && tune.tgt.kind === 'und' && atr) { res.t1U = r2(S + dir * tune.tgt.v * atr); res.t2U = r2(S + dir * tune.tgt.v * 1.6 * atr); res.t1 = r05(OC.project(P0, g, res.t1U - S, mid, K, res.t1U, cp, M)); res.t2 = r05(OC.project(P0, g, res.t2U - S, hd, K, res.t2U, cp, M)); res.warn.push(`Tuned exit: book everything at ${tune.tgt.v}×ATR move in ${o.sym} (Target 1).`); }
      else if (tune.tgt && tune.tgt.kind === 'none') res.warn.push('Tuned exit: no profit target, exit on the premium stop or the time limit.');
    }
    res.rr = E > res.sl ? (res.t1 - E) / (E - res.sl) : 0; res.rr2 = E > res.sl ? (res.t2 - E) / (E - res.sl) : 0;
    const lot = ch.lot || 0; res.perLot = P0 * lot; res.capLot = E * lot; res.maxLossLot = (E - res.sl) * lot; res.t1Lot = (res.t1 - E) * lot; res.t2Lot = (res.t2 - E) * lot;
    res.be = K + dir * P0; // at expiry
    res.pitm = g.pitm;
    // ---- confidence: engine conviction ± chain context
    let conf = res.conv; const add = (d, t, w) => { conf += d; res.why.push({ t, w: d === 0 ? w || 0 : d }); };
    add(0, `${o.hzLabel || hz} rating: ${cp === 'CE' ? 'CALL' : 'PUT'} side ${res.conv}/100 (≥65 needed)`, 1);
    if (o.why && o.why.length) for (const w of o.why.slice(0, 2)) res.why.push({ t: w.t, w: w.w });
    if (an.pcr != null) {
      const p = an.pcr, sup = dir > 0 ? p >= 1.1 : p <= 0.8, agst = dir > 0 ? p <= 0.7 : p >= 1.3;
      if (sup) add(3, `PCR ${p.toFixed(2)}: ${dir > 0 ? 'put writers dominate (support below)' : 'call writers dominate (cap above)'}`);
      else if (agst) add(-4, `PCR ${p.toFixed(2)} is against the trade`);
      else add(0, `PCR ${p.toFixed(2)}: neutral`, 0);
    }
    const wall = dir > 0 ? an.res : an.sup;
    if (wall && (dir > 0 ? wall > S && wall < L.t1 : wall < S && wall > L.t1)) add(-5, `Biggest ${dir > 0 ? 'call' : 'put'} OI wall at ${wall} sits before Target 1 (${f2(r2(L.t1))}): expect selling ${dir > 0 ? 'pressure' : 'support'} there`);
    else if (wall) add(2, `${dir > 0 ? 'Resistance (max call OI)' : 'Support (max put OI)'} at ${wall} is beyond Target 1`);
    const opp = dir > 0 ? an.sup : an.res;
    if (opp && Math.abs(opp - S) <= 2 * (an.step || 1)) add(2, `${dir > 0 ? 'Put' : 'Call'} OI cushion at ${opp}, close to spot`);
    if (x.interp) { const good = x.interp === 'LB' || x.interp === 'SC', bad = x.interp === 'SB' || x.interp === 'LU'; add(good ? 3 : bad ? -3 : 0, `At ${K} ${cp}: ${OC.INTERP[x.interp]}${x.doi ? ` (ΔOI ${OC.cmp(x.doi)})` : ''}`); }
    // IV rich?
    const hv = ctx.hv, vix = ctx.vix, iv = x.iv || an.atmIV;
    let rich = false, richWhy = '';
    if (iv && an.atmIV && iv > an.atmIV * 1.2) { rich = true; richWhy = `strike IV ${(iv * 100).toFixed(1)}% is ${Math.round((iv / an.atmIV - 1) * 100)}% above ATM IV`; }
    if (iv && hv && iv / hv >= 1.35) { rich = true; richWhy = `IV ${(iv * 100).toFixed(1)}% vs ${(hv * 100).toFixed(1)}% realised (20-day)`; }
    if (tune && tune.ivSpread != null && ctx.vixPct != null && ctx.vixPct > tune.ivSpread) { rich = true; richWhy = `India VIX is at its ${Math.round(ctx.vixPct)}th 1-year percentile (tuned limit ${tune.ivSpread})`; }
    if (an.atmIV && vix && o.sym === 'NIFTY' && an.atmIV * 100 > vix * 1.25) { rich = true; richWhy = `ATM IV ${(an.atmIV * 100).toFixed(1)}% vs India VIX ${vix.toFixed(1)}`; }
    if (rich) add(-5, `IV is rich: ${richWhy}`);
    else if (iv) add(0, `IV ${(iv * 100).toFixed(1)}%${an.atmIV ? ` (ATM ${(an.atmIV * 100).toFixed(1)}%)` : ''}${hv ? ` · realised ${(hv * 100).toFixed(1)}%` : ''}: fair`, 0);
    res.rich = rich; res.conf = Math.round(clamp(conf, 0, 100));
    // ---- debit spread when IV is rich: buy the picked strike, sell the strike at/just beyond Target 1
    if (rich) {
      const cands = ch.rows.filter(q => q[sd] && q[sd].ltp > 0 && (dir > 0 ? q.k > K && q.k >= L.t1 : q.k < K && q.k <= L.t1)).sort((a, b) => dir * (a.k - b.k));
      const sr = cands[0] || ch.rows.filter(q => q[sd] && q[sd].ltp > 0 && dir * (q.k - K) > 0).sort((a, b) => dir * (a.k - b.k))[1];
      if (sr) {
        const sx = sr[sd], buyPx = x.ask > 0 ? x.ask : E, sellPx = sx.bid > 0 ? sx.bid : sx.ltp, debit = r05(buyPx - sellPx), width = Math.abs(sr.k - K);
        if (debit > 0 && width > debit) res.spread = { buyK: K, sellK: sr.k, buyPx: r05(buyPx), sellPx: r05(sellPx), sellKey: sx.key || null, debit, width, maxProfit: r2(width - debit), maxLoss: debit, maxProfitLot: r2((width - debit) * lot), maxLossLot: r2(debit * lot), be: K + dir * debit, rr: r2((width - debit) / debit) };
      }
    }
    // ---- timing
    const m = ctx.mins != null ? ctx.mins : istParts(now).mins;
    if (hz === 'intraday') {
      res.window = !o.open ? 'Next session 9:45–11:30 AM, only after the first 15-min candle closes in the trade direction' : m < 585 ? '9:45–11:30 AM, after the 9:15–9:30 candle closes in the trade direction' : m < 690 ? `Now until 11:30 AM` : m < 810 ? 'Now until 1:30 PM (smaller size: less time for the move)' : 'Window closed for today';
      res.exitBy = 'Square off by 3:10 PM. Do not hold overnight.';
      res.valid = `Valid until ${m < 690 || !o.open ? '11:30 AM' : '1:30 PM'} and only while ${o.sym} stays ${dir > 0 ? 'above' : 'below'} ${f2(r2(L.entry - dir * 0.5 * Math.abs(L.entry - L.stop)))}`;
    } else {
      res.window = !o.open ? 'Next session 9:45–11:30 AM (or 2:45–3:15 PM if the trend holds into the close)' : m < 585 ? '9:45–11:30 AM after the first 15-min candle' : m < 870 ? 'Now, or near the close 2:45–3:15 PM' : 'Near the close 2:45–3:15 PM, or next session';
      res.exitBy = `Swing: hold up to ${(tune && tune.hold) || 3} sessions; exit by 3:15 PM the session before expiry (${res.exp}).` + (tune && tune.trail ? ` Trail: after +${Math.round(tune.trail.act * 100)}% keep the stop ${Math.round(tune.trail.off * 100)}% below the peak premium.` : '');
      res.valid = `Valid next 2 sessions while ${o.sym} closes ${dir > 0 ? 'above' : 'below'} ${f2(r2(L.stop))}`;
    }
    // ---- verdict
    if (hz === 'intraday' && o.open && m >= 810) return no('Intraday window closed (after 1:30 PM): not enough time left for the move.');
    if (!res.spread && res.rr < C.minRR) return no(`Reward:risk on the premium is only 1:${res.rr.toFixed(2)} (needs ≥ 1:${C.minRR}) after decay to Target 1. Skip.`);
    if (res.conf < C.minConf) return no(`Engine says ${cp === 'CE' ? 'CALL' : 'PUT'} ${res.conv}, but the chain cuts confidence to ${res.conf} (< ${C.minConf}). Skip.`);
    if (rich && !res.spread) res.warn.push('IV is rich and no sensible spread leg found: size down.');
    if (tune && ctx.tuned) res.tuned = ctx.tuned;
    return res;
  };

  // ======================================================================================================
  // 3b. Tuned parameters (data/fno_params.json, weekly walk-forward research by tools/fno_research.js)
  //     Missing file / missing keys → today's constants. Premiums in that research are SIMULATED, so everything here is labelled "backtest".
  // ======================================================================================================
  const TUNE_META = ['enabled', 'sim', 'stats'];
  OC.tunedFor = function (und, P) { P = P || root.FNO_PARAMS; const t = P && P.index && P.index[und]; return t && typeof t === 'object' ? t : null; };
  OC.hasTuned = t => !!t && Object.keys(t).some(k => !TUNE_META.includes(k));
  OC.needsVix = t => !!t && (t.vixMax != null || t.vixMin != null || t.vixPctMax != null || t.ivSpread != null);
  // OC.CFG with the tuned strike band / expiry / stop / hold applied (a copy; OC.CFG itself is never modified)
  OC.cfgFor = function (t) {
    const C = JSON.parse(JSON.stringify(OC.CFG)); if (!t) return C;
    if (t.strike) { const a = t.strike.mode === 'delta' ? t.strike.aim : ({ 1: 0.62, 0: 0.5, '-1': 0.4 })[t.strike.n]; if (a > 0) { C.deltaAim = a; C.deltaLo = r2(clamp(a - 0.1, 0.2, 0.9)); C.deltaHi = r2(clamp(a + 0.1, 0.3, 0.9)); } }
    if (t.minDays != null) { C.minDaysLeft.swing = t.minDays; C.minDaysLeft.intraday = Math.min(C.minDaysLeft.intraday, t.minDays); }
    if (t.hold != null) C.holdDays.swing = Math.max(1, Math.round(t.hold * 1.4 * 10) / 10);
    if (t.sl != null) { C.minSlPct = t.sl; C.maxSlPct = t.sl; }
    return C;
  };
  // reason string when a tuned entry filter blocks the signal, else null.
  // f: {price, e20, e50, e200, adx, vix, vixPct, gapPct (open vs previous close, % signed in price terms; null if unknown), dow (1=Mon … 5=Fri, entry day), ret1 (ln), sig20}
  OC.filterSignal = function (side, t, f) {
    if (!t || !side) return null; const dir = side === 'CE' ? 1 : -1, c = f.price, nm = side === 'CE' ? 'bullish' : 'bearish';
    switch (t.trend) {
      case 'e20': if (dir * (c - f.e20) <= 0) return `Tuned filter: price is ${dir > 0 ? 'below' : 'above'} the 20 EMA, against a ${nm} trade.`; break;
      case 'e50': if (dir * (c - f.e50) <= 0) return `Tuned filter: price is ${dir > 0 ? 'below' : 'above'} the 50 EMA, against a ${nm} trade.`; break;
      case 'e2050': if (dir * (f.e20 - f.e50) <= 0 || dir * (c - f.e20) <= 0) return 'Tuned filter: 20/50 EMA trend does not support this trade.'; break;
      case 'e200': if (dir * (c - f.e200) <= 0) return `Tuned filter: price is ${dir > 0 ? 'below' : 'above'} the 200 EMA.`; break;
      case 'adx20': if (!(f.adx > 20)) return `Tuned filter: ADX ${Math.round(f.adx || 0)} < 20 (no trend).`; break;
      case 'adx25': if (!(f.adx > 25)) return `Tuned filter: ADX ${Math.round(f.adx || 0)} < 25 (weak trend).`; break;
      case 'e50adx': if (dir * (c - f.e50) <= 0 || !(f.adx > 20)) return 'Tuned filter: needs price on the trade side of the 50 EMA and ADX > 20.'; break;
      default:
    }
    if (t.vixMax != null && f.vix > t.vixMax) return `Tuned filter: India VIX ${f.vix.toFixed(1)} is above ${t.vixMax} (options too expensive).`;
    if (t.vixMin != null && f.vix < t.vixMin) return `Tuned filter: India VIX ${f.vix.toFixed(1)} is below ${t.vixMin} (too little movement).`;
    if (t.vixPctMax != null && f.vixPct > t.vixPctMax) return `Tuned filter: VIX at its ${Math.round(f.vixPct)}th 1-year percentile (limit ${t.vixPctMax}).`;
    if (f.gapPct != null) { const g = dir * f.gapPct; if (t.gapAgainst != null && g < -t.gapAgainst) return `Tuned filter: the open gapped ${Math.abs(f.gapPct).toFixed(2)}% against the trade.`; if (t.gapWith != null && g > t.gapWith) return `Tuned filter: the open already gapped ${Math.abs(f.gapPct).toFixed(2)}% with the trade (chasing).`; }
    if (t.dowSkip && t.dowSkip.length && t.dowSkip.includes(f.dow)) return `Tuned filter: backtest skips entries on ${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][f.dow]}s.`;
    if (t.bigSkip != null && f.sig20 > 0 && dir * f.ret1 >= t.bigSkip * f.sig20) return `Tuned filter: last session already moved ${Math.abs(f.ret1 / f.sig20).toFixed(1)}σ in the trade direction (exhaustion risk).`;
    return null;
  };
  // one line of measured backtest stats for the card; label makes clear it is simulated
  OC.tuneInfo = function (t) {
    const st = t && t.stats && t.stats.test; if (!st || !(st.n > 0)) return null;
    return { tuned: OC.hasTuned(t), n: st.n, hit: st.hit, avgR: st.avgR, expPct: st.expPct, from: t.stats.from, to: t.stats.to, ci: st.ci95R || null, enabled: t.enabled !== false };
  };
  OC.tuneText = function (i) {
    if (!i) return ''; const f = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);
    return `${i.tuned ? 'Tuned on 5y data' : 'Defaults checked on 5y data (nothing beat them)'} · backtest out-of-sample (simulated premiums, after costs): ${f(i.expPct)}% per trade, avg ${f(i.avgR, 2)}R, hit ${Math.round(i.hit)}% over ${i.n} trades. Not a live track record.`;
  };
  // stock F&O gate from the same file: which side the research found an edge on
  OC.stockGate = function (side, P) { // side: 'long' | 'short'
    P = P || root.FNO_PARAMS; const s = P && P.stocks; if (!s) return { ok: true, tuned: false };
    if (s.enabled === false) return { ok: false, tuned: true, why: `Backtest (5y, out-of-sample ${s.stats && s.stats.test ? s.stats.test.n : '?'} trades) found no after-cost edge in stock futures signals.` };
    const sd = s.signal && s.signal.sides; if (sd && sd !== 'both' && sd !== side) return { ok: false, tuned: true, why: `Backtest found an edge only on the ${sd} side for stock futures.` };
    return { ok: true, tuned: true };
  };

  // HV20 (annualised, close-to-close) from a daily close series
  OC.hv = function (c, n = 20) {
    if (!c || c.length < n + 2) return null; const r = [];
    for (let i = c.length - n; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1]));
    const m = r.reduce((a, b) => a + b, 0) / r.length, v = r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1);
    return Math.sqrt(v * 252);
  };

  if (isNode) { module.exports = OC; return; }

  // ======================================================================================================
  // 4. Data: NSE (native HTTP + cookies), mStock overlay / fallback, model fallback
  // ======================================================================================================
  const NSE = 'https://www.nseindia.com';
  const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
  const nativeHttp = () => { const C = root.Capacitor; return C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.CapacitorHttp; };
  let cookie = '', warmAt = 0;
  async function httpGet(url, accept) {
    const N = nativeHttp();
    if (N) {
      const headers = { 'User-Agent': UA, Accept: accept || 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9', Referer: NSE + '/option-chain' };
      if (cookie) headers.Cookie = cookie;
      const r = await N.request({ url, method: 'GET', headers, connectTimeout: 10000, readTimeout: 15000 });
      return { status: r.status, data: r.data, headers: r.headers || {} };
    }
    const r = await fetch(url, { headers: { Accept: accept || 'application/json' } });
    const t = await r.text(); let d = t; try { d = JSON.parse(t); } catch (e) {}
    return { status: r.status, data: d, headers: {} };
  }
  function keepCookies(h) {
    let v = null; for (const k in h) if (k.toLowerCase() === 'set-cookie') v = h[k]; if (!v) return;
    const parts = (Array.isArray(v) ? v : String(v).split(/,(?=\s*[A-Za-z0-9_\-]+=)/)).map(s => s.split(';')[0].trim()).filter(s => s.includes('='));
    const jar = new Map(cookie ? cookie.split('; ').map(s => [s.split('=')[0], s]) : []); for (const p of parts) jar.set(p.split('=')[0], p);
    cookie = [...jar.values()].join('; ');
  }
  async function warm(force) {
    if (!nativeHttp()) return; // browser: cookies can't be set by script; the request works only where CORS allows it (tests)
    if (!force && Date.now() - warmAt < 4 * 60e3 && cookie) return;
    try { const r = await httpGet(NSE + '/option-chain', 'text/html,application/xhtml+xml'); keepCookies(r.headers); warmAt = Date.now(); } catch (e) {}
  }
  let nseDown = 0, nseWhy = ''; // circuit breaker: after a block / network failure, don't hammer NSE for 2 minutes
  async function nseJSON(path) {
    if (Date.now() < nseDown) throw new Error(nseWhy + ', retry after ' + new Date(nseDown).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    try { return await nseJSON_(path); }
    catch (e) { if (!/empty reply|chain empty/.test(e.message)) { nseDown = Date.now() + 120e3; nseWhy = e.message === 'Failed to fetch' ? 'NSE not reachable' : e.message; } throw e; }
  }
  async function nseJSON_(path) {
    await warm();
    let r = await httpGet(NSE + path);
    if (r.status === 401 || r.status === 403 || (r.status === 200 && typeof r.data !== 'object')) { await warm(true); r = await httpGet(NSE + path); }
    if (r.status !== 200) throw new Error('NSE HTTP ' + r.status);
    let d = r.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { throw new Error('NSE sent no JSON (blocked?)'); } }
    if (!d || typeof d !== 'object' || !Object.keys(d).length) throw new Error('NSE sent an empty reply');
    return d;
  }
  const nseSym = u => encodeURIComponent(u);
  const API = () => store_.get('ocApi', null);
  const store_ = { get: (k, d) => { try { const v = localStorage.getItem('dtd2_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem('dtd2_' + k, JSON.stringify(v)); } catch (e) {} } };
  const cache = new Map(); // key → {at, v}
  const cached = async (k, ttl, fn) => { const c = cache.get(k); if (c && Date.now() - c.at < ttl) return c.v; const v = await fn(); cache.set(k, { at: Date.now(), v }); return v; };
  OC.clear = () => { cache.clear(); nseDown = 0; };

  const nseNum = v => { const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : +v; return isFinite(n) ? n : 0; };
  function nseSide(x) {
    if (!x) return null;
    const bid = nseNum(x.buyPrice1 ?? x.bidprice ?? x.bidPrice), ask = nseNum(x.sellPrice1 ?? x.askPrice ?? x.askprice), iv = nseNum(x.impliedVolatility);
    return { ltp: nseNum(x.lastPrice), chg: nseNum(x.change), pchg: nseNum(x.pChange), oi: nseNum(x.openInterest), doi: nseNum(x.changeinOpenInterest), vol: nseNum(x.totalTradedVolume), ivSrc: iv > 0 ? iv / 100 : null, bid, ask, src: 'NSE' };
  }
  const nseTime = s => { const m = String(s || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (!m) return null; const iso = OC.fromNse(`${m[1]}-${m[2]}-${m[3]}`); return iso ? Date.parse(`${iso}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}+05:30`) : null; };
  // NSE reply (either API) → {spot, ts, expiries, rows (one expiry)}
  function parseNse(d, exp) {
    const rec = d.records || d, data = rec.data || (d.filtered && d.filtered.data) || [];
    const expiries = (d.expiryDates || rec.expiryDates || []).map(OC.fromNse).filter(Boolean);
    const by = new Map(); let spot = nseNum(rec.underlyingValue) || 0;
    for (const r of data) {
      const e = OC.fromNse(r.expiryDates || r.expiryDate || (r.CE || {}).expiryDate || (r.PE || {}).expiryDate || '');
      if (exp && e && e !== exp) continue;
      const k = nseNum(r.strikePrice); if (!(k > 0)) continue;
      const row = by.get(k) || { k, ce: null, pe: null }; if (r.CE) row.ce = nseSide(r.CE); if (r.PE) row.pe = nseSide(r.PE); by.set(k, row);
      if (!spot) spot = nseNum((r.CE || {}).underlyingValue) || nseNum((r.PE || {}).underlyingValue);
    }
    return { spot, ts: nseTime(rec.timestamp || d.timestamp), expiries, rows: [...by.values()].sort((a, b) => a.k - b.k), exp: exp || expiries[0] };
  }
  async function nseLegacy(und) {
    return cached('L|' + und, 30e3, () => nseJSON(`/api/option-chain-${OC.isIndex(und) ? 'indices' : 'equities'}?symbol=${nseSym(und)}`));
  }
  OC.nseExpiries = async function (und) {
    if (API() !== 'legacy') {
      try {
        const d = await cached('E|' + und, 300e3, () => nseJSON(`/api/option-chain-contract-info?symbol=${nseSym(und)}`));
        const e = (d.expiryDates || (d.records || {}).expiryDates || []).map(OC.fromNse).filter(Boolean).sort();
        if (e.length) { store_.set('ocApi', 'v3'); return e; }
      } catch (e) { if (API() === 'v3') throw e; }
    }
    const L = await nseLegacy(und), p = parseNse(L, null); if (!p.expiries.length) throw new Error('NSE gave no expiries');
    store_.set('ocApi', 'legacy'); return p.expiries.sort();
  };
  OC.nseChain = async function (und, exp) {
    if (API() !== 'legacy') {
      try {
        const d = await cached(`V|${und}|${exp}`, 30e3, () => nseJSON(`/api/option-chain-v3?type=${OC.isIndex(und) ? 'Indices' : 'Equity'}&symbol=${nseSym(und)}&expiry=${OC.toNse(exp)}`));
        const p = parseNse(d, exp); if (p.rows.length) { p.api = 'v3'; return p; }
      } catch (e) { if (API() === 'v3') throw e; }
    }
    const p = parseNse(await nseLegacy(und), exp); if (!p.rows.length) throw new Error('NSE chain empty for ' + exp);
    p.api = 'legacy'; return p;
  };

  // ---- mStock pieces
  const msOn = () => root.MS && MS.ok && MS.ok();
  OC.contracts = async function (und) { if (!msOn() || !MS.optContracts) return []; return cached('C|' + und, 600e3, () => MS.optContracts(und)); };
  async function msQuotesFor(keys) { // {key: {ltp, prev}} via the OHLC quote (one call per 50 keys)
    const out = {};
    for (let i = 0; i < keys.length; i += 50) {
      const part = keys.slice(i, i + 50).map(k => ({ k })), q = await MS.optionQuotes(part);
      for (const k in q) { const v = q[k]; if (v && v.last_price) out[k] = { ltp: +v.last_price, prev: v.ohlc && +v.ohlc.close > 0 ? +v.ohlc.close : null }; }
    }
    return out;
  }
  async function spotOf(und) {
    if (msOn()) {
      try {
        if (OC.isIndex(und)) { const q = await MS.index(und); return { price: q.price, prev: q.prev, key: q.key && q.key.k, src: 'mStock' }; }
        const Q = await MS.quotes([und]), q = Q[und]; const kk = await MS.key(und);
        if (q && q.last_price) return { price: +q.last_price, prev: q.ohlc && +q.ohlc.close || null, key: kk && kk.k, src: 'mStock' };
      } catch (e) {}
    }
    if (typeof chart === 'function' && typeof ySym === 'function') { // eslint-disable-line no-undef
      const d = await chart(ySym(und, 'IN'), '3mo', '1d'), c = d.D.c; // eslint-disable-line no-undef
      return { price: d.meta.regularMarketPrice || c[c.length - 1], prev: c.length > 1 ? c[c.length - 2] : null, D: d.D, src: 'Yahoo' };
    }
    throw new Error('No price for ' + und);
  }
  const lotOf = (und, C) => (C && C.length && C[0][5]) || (typeof foLot === 'function' ? foLot(und, 'IN') : 0) || ((root.Paper && Paper.IDX_LOT) || {})[und] || 0; // eslint-disable-line no-undef
  const stepOf = (und, px) => root.Engine && Engine.strikeStep ? Engine.strikeStep(und, px) : 50;

  // build rows from mStock contracts for one expiry, ±n strikes around spot
  function msRows(C, exp, spot, n = 20) {
    const by = new Map();
    for (const c of C) if (c[2] === exp) { const row = by.get(c[3]) || { k: c[3], ce: null, pe: null }; row[c[4] === 'CE' ? 'ceC' : 'peC'] = c; by.set(c[3], row); }
    const all = [...by.values()].sort((a, b) => a.k - b.k); if (!all.length) return [];
    let ai = 0; all.forEach((r, i) => { if (Math.abs(r.k - spot) < Math.abs(all[ai].k - spot)) ai = i; });
    return all.slice(Math.max(0, ai - n), ai + n + 1);
  }
  const keyOfC = c => c ? (c[6] || 'NFO') + ':' + c[0] : null;
  function attachKeys(ch, C) {
    if (!C || !C.length) return;
    const m = new Map(); for (const c of C) if (c[2] === ch.exp) m.set(c[3] + c[4], c);
    for (const r of ch.rows) { const ce = m.get(r.k + 'CE'), pe = m.get(r.k + 'PE'); if (r.ce && ce) r.ce.key = keyOfC(ce); if (r.pe && pe) r.pe.key = keyOfC(pe); }
  }
  // overlay mStock LTP on the strikes around ATM (and the spot); returns true when anything changed
  OC.overlay = async function (ch, n = 10) {
    if (!msOn()) return false;
    const atm = ch.an && ch.an.atm != null ? ch.an.atm : ch.spot, rows = ch.rows.slice().sort((a, b) => Math.abs(a.k - atm) - Math.abs(b.k - atm)).slice(0, 2 * n + 1);
    const keys = []; for (const r of rows) for (const s of [r.ce, r.pe]) if (s && s.key) keys.push(s.key);
    if (ch.spotKey) keys.push(ch.spotKey);
    if (!keys.length) return false;
    const q = await MS.ltp([...new Set(keys)]); let any = false;
    for (const r of rows) for (const s of [r.ce, r.pe]) if (s && s.key && q[s.key] > 0) {
      const lp = q[s.key]; if (s.prev == null && s.src === 'NSE' && s.ltp > 0) s.prev = s.ltp - (s.chg || 0); // NSE prev close
      if (s.prev > 0) { s.chg = lp - s.prev; s.pchg = (lp / s.prev - 1) * 100; }
      s.ltp = lp; s.live = 1; if (s.src === 'NSE') s.ivSrc = null; // re-solve IV from the live price
      any = true;
    }
    if (ch.spotKey && q[ch.spotKey] > 0) { ch.spot = q[ch.spotKey]; if (ch.spotPrev) ch.spotChg = (ch.spot / ch.spotPrev - 1) * 100; any = true; }
    if (any) { ch.liveAt = Date.now(); OC.enrich(ch); ch.an = OC.analytics(ch); }
    return any;
  };

  async function vixNow() {
    try { if (typeof chart !== 'function') return null; return await cached('VIX', 300e3, async () => { const d = await chart('^INDIAVIX', '1mo', '1d'); return d.meta.regularMarketPrice || d.D.c[d.D.c.length - 1]; }); } catch (e) { return null; } // eslint-disable-line no-undef
  }
  OC.vix = vixNow;
  // India VIX now / previous close / 1-year percentile (for the tuned VIX filters and the IV-rich → spread rule)
  OC.vixInfo = async function () {
    try { if (typeof chart !== 'function') return null; return await cached('VIXI', 300e3, async () => { const d = await chart('^INDIAVIX', '1y', '1d'), c = d.D.c.filter(x => x > 0), now = d.meta.regularMarketPrice || c[c.length - 1]; const w = c.slice(-252); return { now, prev: c.length > 1 ? c[c.length - 2] : null, pct: w.length ? w.filter(x => x <= now).length / w.length * 100 : 50 }; }); } catch (e) { return null; } // eslint-disable-line no-undef
  };
  OC.hvOf = async function (und) { try { if (typeof chart !== 'function') return null; return await cached('HV|' + und, 3600e3, async () => OC.hv((await chart(ySym(und, 'IN'), '3mo', '1d')).D.c)); } catch (e) { return null; } }; // eslint-disable-line no-undef

  // model chain (no NSE, no mStock): BS premiums from VIX (indices) or HV20 (stocks) with a mild put skew
  async function modelChain(und, exp, sp) {
    const S = sp.price, step = stepOf(und, S), atm = Math.round(S / step) * step, T = OC.tYears(exp);
    let base = null; if (OC.isIndex(und)) { const v = await vixNow(); if (v) base = v / 100 * ({ BANKNIFTY: 1.15, FINNIFTY: 1.05, MIDCPNIFTY: 1.25, BANKEX: 1.15 }[und] || 1); }
    if (!base) base = (sp.D ? OC.hv(sp.D.c) : null) || (await OC.hvOf(und)) || 0.25; base = clamp(base, 0.08, 1.2);
    const rows = [];
    for (let i = -20; i <= 20; i++) {
      const k = atm + i * step; if (k <= 0) continue; const z = Math.log(k / S) / (base * Math.sqrt(Math.max(T, 1 / 365))), iv = base * clamp(1 - 0.08 * z + 0.015 * z * z, 0.7, 1.8);
      const mk = cp => ({ ltp: r05(Math.max(0.05, OC.bs(S, k, T, iv, cp).p)), chg: 0, pchg: 0, oi: 0, doi: 0, vol: 0, ivSrc: iv, bid: 0, ask: 0, src: 'Model' });
      rows.push({ k, ce: mk('CE'), pe: mk('PE') });
    }
    return rows;
  }
  function modelExpiries(und) {
    const P = root.Paper; if (!P || !P.expiries) return [];
    const today = istParts().day, u = OC.isIndex(und) ? und : 'STOCK';
    return P.expiries(u === 'STOCK' ? 'BANKNIFTY' : u, today, 3).filter(e => e > today || istParts().mins < 930); // stocks: monthly, last Tuesday (same rule as BANKNIFTY)
  }

  // MAIN: full chain for one underlying + expiry (exp null → nearest). Returns
  // {und, exp, expiries, spot, spotPrev, spotChg, spotKey, lot, rows, an, src, srcNote, ts, at, notes[], hasOI, hasVol}
  OC.get = async function (und, exp, opt = {}) {
    und = String(und).toUpperCase(); if (opt.force) OC.clear();
    const notes = [], onNse = !OC.BSE.includes(und);
    const [sp, C] = await Promise.all([spotOf(und), OC.contracts(und).catch(e => { notes.push('mStock contracts: ' + e.message); return []; })]);
    let expiries = [], ch = null;
    if (onNse && !opt.noNse) {
      try {
        expiries = await OC.nseExpiries(und);
        const e = exp && expiries.includes(exp) ? exp : expiries[0];
        const p = await OC.nseChain(und, e);
        ch = { exp: e, rows: p.rows, nseSpot: p.spot, ts: p.ts, src: 'NSE', api: p.api };
      } catch (e) { notes.push('NSE option chain unavailable (' + e.message + ')'); }
    } else if (!onNse) notes.push(und + ' trades on BSE: NSE has no chain for it');
    const msExp = [...new Set(C.map(c => c[2]))].sort();
    if (!expiries.length) expiries = msExp;
    if (!ch && C.length) {
      const e = exp && expiries.includes(exp) ? exp : expiries[0], R = msRows(C, e, sp.price, 20), keys = [];
      for (const r of R) { if (r.ceC) keys.push(keyOfC(r.ceC)); if (r.peC) keys.push(keyOfC(r.peC)); }
      try {
        const Q = await msQuotesFor(keys), side = c => { if (!c) return null; const q = Q[keyOfC(c)]; return q ? { ltp: q.ltp, prev: q.prev, chg: q.prev ? q.ltp - q.prev : 0, pchg: q.prev ? (q.ltp / q.prev - 1) * 100 : 0, oi: null, doi: null, vol: null, ivSrc: null, bid: 0, ask: 0, key: keyOfC(c), src: 'mStock', live: 1 } : { ltp: 0, key: keyOfC(c), src: 'mStock' }; };
        ch = { exp: e, rows: R.map(r => ({ k: r.k, ce: side(r.ceC), pe: side(r.peC) })), src: 'mStock', ts: Date.now() };
      } catch (err) { notes.push('mStock quotes: ' + err.message); }
    }
    if (!ch) {
      if (!expiries.length) expiries = modelExpiries(und);
      const e = exp && expiries.includes(exp) ? exp : expiries[0]; if (!e) throw new Error('No expiry found for ' + und);
      ch = { exp: e, rows: await modelChain(und, e, sp), src: 'Model', ts: Date.now() };
    }
    Object.assign(ch, { und, expiries, spot: sp.price || ch.nseSpot, spotPrev: sp.prev, spotKey: sp.key || null, spotSrc: sp.src, lot: lotOf(und, C.filter(c => c[2] === ch.exp)), notes, at: Date.now() });
    if (!(ch.spot > 0) && ch.nseSpot) ch.spot = ch.nseSpot;
    if (ch.src === 'NSE' && sp.src !== 'mStock' && ch.nseSpot) ch.spot = ch.nseSpot; // NSE's own underlying value is fresher than Yahoo
    ch.spotChg = ch.spotPrev ? (ch.spot / ch.spotPrev - 1) * 100 : null;
    ch.hasOI = ch.rows.some(r => (r.ce && r.ce.oi) || (r.pe && r.pe.oi)); ch.hasVol = ch.rows.some(r => (r.ce && r.ce.vol) || (r.pe && r.pe.vol));
    attachKeys(ch, C);
    OC.enrich(ch); ch.an = OC.analytics(ch);
    if (ch.src === 'NSE' && msOn() && !opt.noOverlay) { try { if (await OC.overlay(ch, 10)) ch.src = 'NSE + mStock LTP'; } catch (e) { notes.push('mStock LTP: ' + e.message); } }
    ch.srcNote = ch.src === 'Model' ? 'Estimated premiums (Black-Scholes model): NSE and mStock unavailable' : ch.src === 'mStock' ? 'mStock live premiums · OI/volume not available from mStock' : ch.src === 'NSE' ? 'NSE option chain' + (msOn() ? '' : ' · log in to mStock for tick-by-tick premiums') : 'NSE chain (OI, IV, volume) + mStock live LTP';
    return ch;
  };

  // professional call for an indexOption() result: chain on the right expiry → buildCall
  OC.callFor = async function (o) {
    if (!o.side) return { call: OC.buildCall(o, null), ch: null };
    const hz = o.hzKey === 'intraday' ? 'intraday' : 'swing';
    let ch = await OC.get(o.sym);
    const want = OC.pickExpiry(ch.expiries, hz, Date.now(), o.tp ? OC.cfgFor(o.tp) : null);
    if (want && want !== ch.exp) ch = await OC.get(o.sym, want);
    const [hv, vix] = await Promise.all([OC.hvOf(o.sym), o.sym === 'NIFTY' ? vixNow() : null]);
    const tp = o.tp || null, ctx = { hv, vix };
    if (tp) { ctx.cfg = OC.cfgFor(tp); ctx.tune = tp; ctx.atr = o.atr || null; ctx.vixPct = o.vixPct != null ? o.vixPct : null; ctx.tuned = OC.tuneInfo(tp); }
    const call = OC.buildCall(o, ch, ctx);
    if (ch.exp !== ch.expiries[0]) call.expWhy = `Nearest expiry ${ch.expiries[0]} has fewer than ${(ctx.cfg || OC.CFG).minDaysLeft[hz]} trading days left: using the next one.`;
    call.ctx = { hv, vix };
    return { call, ch };
  };

  // tuned parameters: cached copy first (instant), then refreshed from GitHub (same pattern as morning.js; CSP already allows raw.githubusercontent.com)
  root.FNO_PARAMS = store_.get('fnoParams', null);
  OC.loadParams = async function () {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return root.FNO_PARAMS;
      const r = await fetch('https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/data/fno_params.json?v=' + Math.floor(Date.now() / 3600e3), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json();
      if (j && j.index) { root.FNO_PARAMS = j; store_.set('fnoParams', j); }
    } catch (e) {}
    return root.FNO_PARAMS;
  };
  OC.paramsReady = OC.loadParams();

  root.OC = OC;
})(typeof window !== 'undefined' ? window : globalThis);
