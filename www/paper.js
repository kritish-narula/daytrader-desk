/* DayTrader Desk — paper-trading league (shared by the app and the CI runner tools/paper.js).
   Every strategy has fixed rules (entry trigger, stop, targets, max holding days, position size, costs).
   CI (GitHub Actions, Yahoo daily bars, no broker credentials) runs the league every trading day after the close and
   writes data/paper*.json; the app shows the league and, when mStock is connected, marks open trades to live prices.
   Nothing here places orders. All results are PAPER results; F&O premiums in CI are SIMULATED with Black-Scholes. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const E = isNode ? require('./engine.js') : root.Engine;
  const P = {};
  const ok = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r2 = x => Math.round(x * 100) / 100;

  // ======================================================================================================
  // 1. Constants (all in ₹). Change these, not the code.
  // ======================================================================================================
  P.CAPITAL = { EQ: 100000, FNO: 1000000 };     // paper account per strategy: equity ₹1 lakh, F&O ₹10 lakh (F&O margins are large)
  P.RISK = { EQ: 1000, FNO: 10000 };             // fixed ₹ risk per trade = 1% of the strategy's paper account
  P.EQ_MAX_NOTIONAL = 25000;                     // one equity position may use at most 25% of the account (no leverage, delivery)
  P.FUT_MARGIN = 0.20;                           // approx. SPAN+exposure margin for stock futures (~20% of contract value)
  // Stock futures: one NSE lot is worth ≥ ₹15 lakh (SEBI minimum since Nov-2024), so futures strategies get a ₹20 lakh paper
  // account and risk ~₹40,000 (2%) per trade; a signal is skipped if ONE lot would risk more than ₹60,000 (3%).
  P.FUT_CAPITAL = 2000000; P.FUT_RISK = 40000; P.FUT_MAX_RISK_LOT = 60000;
  P.OPT_PREM_STOP = 0.5;                         // option buys: also exit if the premium halves
  P.OPT_MAX_OUTLAY = 0.2;                        // option buys: premium paid ≤ 20% of the F&O account per trade
  P.MAX_NEW_PER_DAY = { EQ: 3, FNO: 2 };         // new trades per strategy per day (best-ranked signals first)
  P.ORDER_VALID = 3;                             // stop / limit entry orders live for 3 sessions, then are cancelled
  P.MIN_TRADES = 8;                              // a strategy is not ranked until it has this many closed trades
  P.RF = 0.06;                                   // risk-free rate for Black-Scholes (≈ 91-day T-bill)
  P.DIV = { NIFTY: 0.012, BANKNIFTY: 0.008, SENSEX: 0.012 }; // index dividend yields (BSM q)
  // Index lot sizes (NSE circular, effective from the Jan 2026 contracts; SENSEX lot 20 on BSE). CI overrides with fo_mktlots.csv when it downloads.
  P.IDX_LOT = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120, SENSEX: 20 };
  P.IDX_Y = { NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', SENSEX: '^BSESN' };
  // IV model: India VIX is the 30-day implied vol of NIFTY. Fudge per index (Bank Nifty trades ~15% richer than VIX, Sensex ≈ Nifty)
  // plus a simple put skew (lower strikes get more vol). This is an ESTIMATE, not the real option chain.
  P.IV_MULT = { NIFTY: 1.0, BANKNIFTY: 1.15, SENSEX: 1.0 };
  P.SKEW = { slope: -0.08, curve: 0.015 };      // iv = base·(1 + slope·z + curve·z²), z = ln(K/S)/(base·√T); clamped to 0.7–1.8× base

  // ---- costs (Indian retail rates; verify against your broker's contract note) ----
  // brokerage: ₹20 per executed order is the common discount-broker cap (mStock plans differ: some charge ₹0 on delivery).
  // STT: delivery 0.1% buy+sell · intraday 0.025% sell · futures 0.02% sell (0.05% from 1-Apr-2026, Budget 2026) ·
  //      options 0.1% of premium on sell (0.15% from 1-Apr-2026); ITM options exercised at expiry 0.125% (0.15%) of intrinsic.
  // exchange txn: NSE cash 0.00297% · NSE futures 0.00173% · NSE options 0.03503% of premium (BSE options ≈ 0.0325%).
  // stamp duty (buy side): delivery 0.015% · intraday 0.003% · futures 0.002% · options 0.003%. SEBI fee ₹10/crore. GST 18% on brokerage+txn+SEBI.
  // DP charge ≈ ₹16 per scrip sold from demat (delivery).  Slippage: added to fill prices (see SLIP).
  P.COST = {
    BROKERAGE: 20, GST: 0.18, SEBI: 1e-6, DP: 16,
    EQ: { stt: 0.001, sttSellOnly: false, txn: 0.0000297, stamp: 0.00015, brkPct: 0 },
    EQI: { stt: 0.00025, sttSellOnly: true, txn: 0.0000297, stamp: 0.00003, brkPct: 0.0003 },
    FUT: { stt: 0.0002, stt26: 0.0005, sttSellOnly: true, txn: 0.0000173, stamp: 0.00002, brkPct: 0.0003 },
    OPT: { stt: 0.001, stt26: 0.0015, sttSellOnly: true, txn: 0.0003503, stamp: 0.00003, brkPct: 0, exStt: 0.00125, exStt26: 0.0015 },
    STT_HIKE: '2026-04-01',
  };
  P.SLIP = { EQ: 0.0005, FUT: 0.0003, OPT: 0.01, OPT_MIN: 0.5 }; // per side: 0.05% liquid stocks, 0.03% futures, 1% of premium (min ₹0.50) options

  // cost in ₹ of ONE order. kind: EQ (delivery) | EQI (intraday) | FUT | OPT. side: 'B' | 'S'. value = price × quantity (premium × qty for options).
  P.orderCost = function (kind, side, value, date, exIntrinsic) {
    const C = P.COST, k = C[kind]; if (!k || !(value >= 0)) return 0;
    const late = date && date >= C.STT_HIKE;
    const sttRate = late && k.stt26 != null ? k.stt26 : k.stt;
    let stt = (!k.sttSellOnly || side === 'S') ? sttRate * value : 0;
    if (exIntrinsic) stt = (late ? k.exStt26 : k.exStt) * exIntrinsic; // long ITM option settled at expiry
    const brk = value > 0 ? (k.brkPct ? Math.min(C.BROKERAGE, k.brkPct * value) : C.BROKERAGE) : 0;
    const txn = k.txn * value, sebi = C.SEBI * value, stamp = side === 'B' ? k.stamp * value : 0;
    const dp = kind === 'EQ' && side === 'S' ? C.DP : 0;
    return brk + stt + txn + sebi + stamp + dp + C.GST * (brk + txn + sebi);
  };
  P.slip = function (kind, px, side) { // adverse fill: buy higher, sell lower
    const s = kind === 'OPT' ? Math.max(P.SLIP.OPT_MIN, P.SLIP.OPT * px) : (P.SLIP[kind === 'EQI' ? 'EQ' : kind] || 0) * px;
    return side === 'B' ? px + s : Math.max(0.05, px - s);
  };

  // ======================================================================================================
  // 2. Calendar: NSE/BSE holidays and F&O expiries
  // ======================================================================================================
  // Weekday trading holidays 2026 (NSE circular, Dec 2025). Past dates in CI are also checked against the actual bars.
  P.HOLIDAYS = new Set(['2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
    '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01', '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25']);
  const dU = s => new Date(s + 'T00:00:00Z');
  const sD = d => d.toISOString().slice(0, 10);
  P.addDays = (s, n) => { const d = dU(s); d.setUTCDate(d.getUTCDate() + n); return sD(d); };
  P.dow = s => dU(s).getUTCDay(); // 0 Sun … 6 Sat
  P.isTradingDay = (s, extra) => { const w = P.dow(s); return w !== 0 && w !== 6 && !P.HOLIDAYS.has(s) && !(extra && extra.has(s)); };
  P.nextTradingDay = (s, extra) => { let d = P.addDays(s, 1); while (!P.isTradingDay(d, extra)) d = P.addDays(d, 1); return d; };
  P.prevTradingDay = (s, extra) => { let d = P.addDays(s, -1); while (!P.isTradingDay(d, extra)) d = P.addDays(d, -1); return d; };
  P.tradingDaysBetween = (a, b, extra) => { let n = 0, d = a; while (d < b) { d = P.nextTradingDay(d, extra); n++; } return n; }; // sessions after a up to and including b
  P.isoWeek = s => { const d = dU(s), day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(), j = new Date(Date.UTC(y, 0, 4)); return y * 100 + 1 + Math.round(((d - j) / 864e5 - 3 + ((j.getUTCDay() + 6) % 7)) / 7); };
  // Expiry rules. From 1-Sep-2025 (SEBI/NSE circular): NIFTY weekly + monthly on TUESDAY (monthly = last Tuesday);
  // BANKNIFTY monthly only (weeklies stopped Nov-2024), last Tuesday; stock F&O monthly, last Tuesday; BSE SENSEX weekly THURSDAY.
  // Before that: NSE Thursday (BANKNIFTY monthly last Thursday), SENSEX weekly Tuesday (Jan–Aug 2025).
  // If the expiry day is a holiday the contract expires on the previous trading day.
  const RULE_SWITCH = '2025-09-01';
  function lastWeekdayOfMonth(y, m, wd) { const d = new Date(Date.UTC(y, m + 1, 0)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1); return sD(d); }
  function shiftHol(s, extra) { while (!P.isTradingDay(s, extra)) s = P.addDays(s, -1); return s; }
  P.expiryWeekday = (und, date) => { const nw = date >= RULE_SWITCH; return und === 'SENSEX' ? (nw ? 4 : 2) : (nw ? 2 : 4); };
  P.weekly = und => und === 'NIFTY' || und === 'SENSEX';
  // list of expiries (YYYY-MM-DD) on/after `from`, nearest first
  P.expiries = function (und, from, count = 4, extra) {
    const out = [], weekly = P.weekly(und);
    if (weekly) {
      let d = from; for (let k = 0; out.length < count && k < 80; k++) { const wd = P.expiryWeekday(und, d); if (P.dow(d) === wd) { const e = shiftHol(d, extra); if (e >= from && !out.includes(e)) out.push(e); } d = P.addDays(d, 1); }
    } else {
      let y = +from.slice(0, 4), m = +from.slice(5, 7) - 1;
      for (let k = 0; out.length < count && k < 24; k++) { const probe = `${y}-${String(m + 1).padStart(2, '0')}-15`, e = shiftHol(lastWeekdayOfMonth(y, m, P.expiryWeekday(und, probe)), extra); if (e >= from) out.push(e); m++; if (m > 11) { m = 0; y++; } }
    }
    return out;
  };
  // first expiry with at least `minSessions` trading sessions after the entry day (we never buy an option that expires in ≤ 1 day)
  P.pickExpiry = (und, entryDay, minSessions = 2, extra) => P.expiries(und, entryDay, 6, extra).find(e => P.tradingDaysBetween(entryDay, e, extra) >= minSessions);

  // ======================================================================================================
  // 3. Black-Scholes-Merton pricing
  // ======================================================================================================
  function ncdf(x) { // Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  P.ncdf = ncdf;
  // cp: 'CE' | 'PE'; T in years; returns {p, delta, theta (per calendar day), vega (per 1 vol pt)}
  P.bs = function (S, K, T, sig, cp, r = P.RF, q = 0) {
    if (!(S > 0) || !(K > 0)) return { p: 0, delta: 0, theta: 0, vega: 0 };
    const intr = cp === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    if (!(T > 0) || !(sig > 0)) return { p: intr, delta: intr > 0 ? (cp === 'CE' ? 1 : -1) : 0, theta: 0, vega: 0 };
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T), pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
    const p = cp === 'CE' ? S * dq * ncdf(d1) - K * dr * ncdf(d2) : K * dr * ncdf(-d2) - S * dq * ncdf(-d1);
    const delta = cp === 'CE' ? dq * ncdf(d1) : dq * (ncdf(d1) - 1);
    const th = -S * dq * pdf * sig / (2 * sq) + (cp === 'CE' ? q * S * dq * ncdf(d1) - r * K * dr * ncdf(d2) : -q * S * dq * ncdf(-d1) + r * K * dr * ncdf(-d2));
    return { p: Math.max(p, 0), delta, theta: th / 365, vega: S * dq * pdf * sq / 100 };
  };
  // implied vol from India VIX with the per-index multiplier and put skew (documented above)
  P.iv = function (und, vix, S, K, T) {
    const base = clamp((ok(vix) ? vix : 14) / 100 * (P.IV_MULT[und] || 1), 0.05, 1.5);
    const z = Math.log(K / S) / (base * Math.sqrt(Math.max(T, 1 / 365)));
    return base * clamp(1 + P.SKEW.slope * z + P.SKEW.curve * z * z, 0.7, 1.8);
  };
  // years to expiry from a session moment: 'open' 09:15, 'mid' 12:30, 'close' 15:30 IST; expiry at 15:30 IST on expiry day
  const MOM = { open: 555, mid: 750, close: 930 };
  P.tYears = function (day, mom, exp) {
    const mins = (dU(exp) - dU(day)) / 60000 + (930 - (MOM[mom] || 930));
    return Math.max(mins, 15) / (365 * 1440);
  };
  P.optPrice = function (o, S, day, mom, vix) { // o: {und, k, cp, exp}
    const T = P.tYears(day, mom, o.exp);
    if (day >= o.exp && mom === 'close') return Math.max(0, o.cp === 'CE' ? S - o.k : o.k - S);
    const sig = P.iv(o.und, vix, S, o.k, T);
    return Math.max(0.05, P.bs(S, o.k, T, sig, o.cp, P.RF, P.DIV[o.und] || 0.01).p);
  };

  // ======================================================================================================
  // 4. Strategies (fixed rules). seg EQ = equity cash (delivery), FNO = futures & options. kind = how entries are made.
  // ======================================================================================================
  const SETUP = (id, name, short, src, hold, extra = {}) => Object.assign({ id, seg: 'EQ', kind: 'setup', setup: name, src, short, hold,
    name: short, rules: [`Entry: the app's "${name}" signal on a daily close (Nifty 200 + F&O stocks). Order placed for the next session${src === 'chart' ? ' (confirmed / breaking-out patterns only)' : ''}.`,
      'Fill: at the next open if the planned entry is within ¼ ATR of the close, otherwise a buy-stop (above) or buy-limit (below) order valid for 3 sessions.',
      'Stop and target: the levels the app shows for the setup. Half exits at Target 1, stop moves to entry, the rest rides to Target 2 (2× the first target distance).',
      `Time exit: at the close after ${hold} sessions.`, `Size: risk ₹${P.RISK.EQ.toLocaleString('en-IN')} per trade (1% of ₹1 lakh), max ₹25,000 per position, cash only.`] }, extra);
  P.STRATS = [
    SETUP('pb20', 'Pullback to 20 EMA in uptrend', 'Pullback to 20 EMA', 'setup', 10),
    SETUP('fvg', 'SMC: Retest of bullish fair value gap', 'Bullish FVG retest', 'setup', 10),
    SETUP('choch', 'SMC: Change of character (bullish)', 'Bullish CHoCH', 'setup', 10),
    SETUP('bflag', 'Bull flag', 'Bull flag', 'chart', 15),
    SETUP('dbot', 'Double bottom', 'Double bottom', 'chart', 20),
    SETUP('gapup', 'Gap-up and go', 'Gap-up and go', 'setup', 5),
    SETUP('vcp', 'VCP', 'VCP', 'setup', 20, { match: n => /^VCP/.test(n) }),
    SETUP('brk', 'Clean volume breakout', 'Clean breakout', 'setup', 10),
    SETUP('nbrk', 'Near breakout (coiling under resistance)', 'Near breakout', 'setup', 10),
    SETUP('mr', 'Oversold dip in long-term uptrend', 'Oversold bounce', 'setup', 10),
    { id: 'sw70', seg: 'EQ', kind: 'band', hz: 'swing', min: 70, hold: 10, short: 'Swing rating ≥70', name: 'Swing rating ≥70',
      rules: ['Entry: the app\'s Swing rating (same number as the stock page) is 70 or more at the daily close. Buy at the next open; highest ratings first.', 'Stop / Target 1 / Target 2: the Swing plan levels (1.5 ATR stop or recent swing low; T1 1.5R, T2 3R). Half at T1, stop to entry.', 'Time exit: 10 sessions.', 'Size: ₹1,000 risk, max ₹25,000 per position.'] },
    { id: 'sh70', seg: 'EQ', kind: 'band', hz: 'short', min: 70, hold: 30, short: 'Short-term rating ≥70', name: 'Short-term rating ≥70',
      rules: ['Entry: Short-term (2–6 weeks) rating ≥70 at the close; buy at the next open.', 'Levels: the Short-term plan (2.5 ATR / 20-day swing low stop, T1 1.5R, T2 3R). Half at T1, stop to entry.', 'Time exit: 30 sessions.', 'Size: ₹1,000 risk, max ₹25,000 per position.'] },
    { id: 'md75', seg: 'EQ', kind: 'band', hz: 'medium', min: 75, hold: 60, short: 'Medium rating ≥75', name: 'Medium-term rating ≥75',
      rules: ['Entry: Medium-term (2–6 months) rating ≥75 at the close; buy at the next open.', 'Levels: the Medium plan (4 ATR / 60-day swing low stop, T1 1.5R, T2 3R). Half at T1, stop to entry.', 'Time exit: 60 sessions (the paper league reviews faster than the 2–6 month horizon).', 'Size: ₹1,000 risk, max ₹25,000 per position.'] },
    { id: 'ema', seg: 'EQ', kind: 'ema', hold: 40, short: 'EMA 20/50 cross', name: 'EMA 20/50 bullish cross',
      rules: ['Entry: the 20 EMA crosses above the 50 EMA today and the close is above the 200 EMA. Buy at the next open.', 'Stop: 2 ATR below the entry. Target 1: 2 ATR above, Target 2: 4 ATR above. Half at T1, stop to entry.', 'Also exits at the close if the 20 EMA crosses back below the 50 EMA. Time exit 40 sessions.', 'Size: ₹1,000 risk, max ₹25,000 per position.'] },
    { id: 'meta_eq', seg: 'EQ', kind: 'meta', hold: 20, short: 'Best-of league (auto)', name: 'Best-of league: equity',
      rules: ['The self-improving strategy: each day it takes the signals of the strategies that are PROMOTED at the latest weekly review (best score first, max 3 a day).', 'Each trade keeps the source strategy\'s rules (entry, stop, targets, time exit).', 'If nothing is promoted it stays in cash. Its result shows whether picking strategies by their track record actually adds value.', 'Size: ₹1,000 risk, max ₹25,000 per position.'] },
    { id: 'nifty_bh', seg: 'EQ', kind: 'bench', hold: 1e9, short: 'Nifty buy & hold', name: 'Benchmark: Nifty 50 buy & hold',
      rules: ['Buys ₹1 lakh of the Nifty 50 index (like an index ETF) at the open of the first day and never sells.', 'Costs: one delivery buy. Dividends are ignored (Yahoo index prices exclude them).', 'Not ranked: it is the bar every equity strategy should beat.'] },
    // ---------- F&O ----------
    { id: 'opt_app', seg: 'FNO', kind: 'idxopt', pick: 'app', hold: 3, short: 'Index options · app pick', name: 'Index options: app pick (CE/PE)',
      rules: ['Underlyings: NIFTY, BANKNIFTY, SENSEX. At the close the app\'s call/put rating is computed exactly like the F&O tab (market closed: 30% intraday + 70% swing).', 'Entry: buy a CE if the CALL side is 65+, a PE if the PUT side is 65+, at the next open. Strike chosen like the app: ATM, or 1 strike OTM when the rating is 78+ and Target 1 lies beyond it.', 'Expiry: nearest expiry with at least 2 sessions left (NIFTY weekly Tue, SENSEX weekly Thu, BANKNIFTY monthly last Tue).', 'Exit: underlying hits the swing Stop (or the premium halves) → out; underlying hits Target 1 → half out, rest at Target 2; else out at the close after 3 sessions or the day before expiry.', 'Size: lots so that a 50% premium loss ≈ ₹10,000 (1% of ₹10 lakh); premium outlay ≤ ₹2 lakh. Premiums are SIMULATED (Black-Scholes on India VIX).'] },
    { id: 'opt_itm', seg: 'FNO', kind: 'idxopt', pick: 'itm', hold: 3, short: 'Index options · 1 ITM', name: 'Index options: always 1 strike ITM',
      rules: ['Same signal, expiry, exits and sizing as "app pick", but always buys the strike one step in the money (higher delta, less time decay).', 'Premiums are SIMULATED (Black-Scholes on India VIX).'] },
    { id: 'opt_otm', seg: 'FNO', kind: 'idxopt', pick: 'otm', hold: 3, short: 'Index options · 1 OTM', name: 'Index options: always 1 strike OTM',
      rules: ['Same signal, expiry, exits and sizing as "app pick", but always buys the strike one step out of the money (cheaper, more leverage, more decay).', 'Premiums are SIMULATED (Black-Scholes on India VIX).'] },
    { id: 'fut_sw', seg: 'FNO', kind: 'fut', cap: 2000000, src: 'swing', hold: 10, short: 'Stock futures · swing ≥70/≤30', name: 'Stock futures: swing rating long/short',
      rules: ['Universe: F&O stocks. Long the near-month future when the Swing rating is ≥70, short it when ≤30 (shorting allowed in futures). Next-open entry, strongest first.', 'Levels: the Swing plan (stop, T1 1.5R, T2 3R). Half at T1 when 2+ lots, stop to entry. Time exit 10 sessions.', 'Size: ₹20 lakh paper account (one stock-futures lot is ₹15 lakh+). Lots so the stop risks ≈ ₹40,000 (2%), max 3; skipped if one lot risks more than ₹60,000. Margin ≈ 20% of contract value must fit the account.', 'Futures priced at the stock\'s cash price (basis/rollover not modelled).'] },
    { id: 'fut_rt', seg: 'FNO', kind: 'fut', cap: 2000000, src: 'rating', hold: 15, short: 'Stock futures · overall ≥70/≤30', name: 'Stock futures: overall rating long/short',
      rules: ['Same as the swing futures strategy but triggered by the overall stock rating (swing to long blend, the big number on the stock page) ≥70 long / ≤30 short.', 'Swing plan levels (stop, T1 1.5R, T2 3R). Time exit 15 sessions.', 'Futures priced at the stock\'s cash price (basis/rollover not modelled).'] },
    { id: 'ic', seg: 'FNO', kind: 'condor', hold: 6, short: 'NIFTY iron condor', name: 'NIFTY weekly iron condor (hedged selling)',
      rules: ['When NIFTY has no trend (Swing score 43–57) and no condor is open: at the next open sell the call and put about 1 expected move (VIX-based) away and buy wings 200 points further out (defined risk). Expiry: nearest weekly with 2+ sessions left.', 'Exit at the close if the loss reaches 1.5× the credit or 50% of the credit is captured; otherwise held to expiry and settled at the closing index level.', 'Size: lots so the maximum loss ≈ ₹10,000–₹20,000. Checks happen on daily closes only: intraday spikes are not modelled, so real losses can be larger.', 'Premiums are SIMULATED (Black-Scholes on India VIX with put skew).'] },
    { id: 'meta_fno', seg: 'FNO', kind: 'meta', hold: 10, short: 'Best-of league (auto)', name: 'Best-of league: F&O',
      rules: ['Each day takes the signals of the F&O strategies PROMOTED at the latest weekly review (max 2 a day), with the source strategy\'s rules.', 'Stays flat if none is promoted.'] },
  ];
  P.byId = Object.fromEntries(P.STRATS.map(s => [s.id, s]));
  P.CHART_NAMES = { bflag: 'Bull flag', dbot: 'Double bottom' };

  // ======================================================================================================
  // 5. Per-symbol preparation (Node / CI): indicators once, horizon scores cached, the engine's backtest replayed
  //    at any past bar — everything at bar i uses only bars 0..i (no look-ahead).
  // ======================================================================================================
  const HZS = ['swing', 'short', 'medium', 'long'];
  P.prep = function (sym, D, extra = {}) {
    const I = E.indicators(D), idx = new Map(D.day.map((d, i) => [d, i]));
    return Object.assign({ sym, D, I, idx, sc: { swing: [], short: [], medium: [], long: [] } }, extra);
  };
  P.score = function (X, hz, i) {
    const a = X.sc[hz]; if (a[i] !== undefined) return a[i];
    if ((hz === 'medium' && i + 1 < 160) || (hz === 'long' && i + 1 < 210) || i < 60) return (a[i] = null);
    return (a[i] = E._toScore(E._combine(E._factors(X.I, i, hz))));
  };
  // identical to engine.js backtest(I, hz) evaluated on bars 0..n-1
  P.bt = function (X, hz, n) {
    const H = E.HORIZONS[hz], C = X.D.c; let wins = 0, losses = 0;
    const start = Math.max(210, n - 750);
    for (let i = start; i < n - 2;) {
      const sc = P.score(X, hz, i), d = sc >= 58 ? 1 : sc != null && sc <= 42 ? -1 : 0;
      if (!d || !ok(X.I.atr[i])) { i++; continue; }
      const L = E._levels(X.I, i, hz, d, 1e-9, C[i]); let res = 0, j = i + 1;
      for (; j < Math.min(n, i + 1 + H.hold); j++) {
        if (d > 0 ? X.D.l[j] <= L.stop : X.D.h[j] >= L.stop) { res = -1; break; }
        if (d > 0 ? X.D.h[j] >= L.t1 : X.D.l[j] <= L.t1) { res = 1; break; }
      }
      if (j >= n) break;
      if (res > 0) wins++; else losses++;
      i = j + 1;
    }
    const tot = wins + losses;
    return { n: tot, wins, odds: tot >= 4 ? Math.round(100 * (wins + 1) / (tot + 2)) : null };
  };
  // horizon ratings exactly like the app (E.hzRating / E.rating) at bar i; ctx = {regime, canShort}
  P.ratings = function (X, i, ctx = {}) {
    const H = {}; for (const hz of HZS) { const s = P.score(X, hz, i); H[hz] = s == null ? { na: true } : { score: s, bt: hz === 'long' ? null : P.bt(X, hz, i + 1) }; }
    const out = { H }; for (const hz of HZS) out[hz] = H[hz].na ? null : E.hzRating(H[hz], hz, ctx);
    out.rating = E.rating({ horizons: H }, ctx); return out;
  };
  // engine view of bars 0..i (for detectors that look at the last bar: chartPatterns)
  P.trunc = function (I, n) {
    const o = {}; for (const k in I) { const v = I[k]; o[k] = Array.isArray(v) ? v.slice(0, n) : v && typeof v === 'object' && k !== 'D' ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, Array.isArray(b) ? b.slice(0, n) : b])) : v; }
    o.D = Object.fromEntries(Object.entries(I.D).map(([a, b]) => [a, Array.isArray(b) ? b.slice(0, n) : b])); o.n = n; return o;
  };

  // ======================================================================================================
  // 6. Signals at the close of bar i  →  orders for the next session
  // ======================================================================================================
  // order: {s, sym, b, type:'open'|'stop'|'limit', entry, stop, t1, t2, hold, q (quality, for ranking), why}
  function mkOrder(s, X, i, b, entry, stop, t1, t2, q, why, hold) {
    if (![entry, stop, t1].every(ok) || b * (entry - stop) <= 0 || b * (t1 - entry) <= 0) return null;
    if (!ok(t2) || b * (t2 - t1) <= 0) t2 = entry + 2 * (t1 - entry);
    const at = X.I.atr[i] || X.D.c[i] * 0.02, c = X.D.c[i];
    const type = Math.abs(entry - c) <= 0.25 * at ? 'open' : b * (entry - c) > 0 ? 'stop' : 'limit';
    return { s: s.id, sym: X.sym, seg: s.seg === 'EQ' ? 'EQ' : 'FUT', b, type, entry: r2(entry), stop: r2(stop), t1: r2(t1), t2: r2(t2), hold: hold || s.hold, q: r2(q), why, sig: X.D.day[i] };
  }
  // equity strategies for one stock at bar i. cache: per (stock,i) computed setups / chart patterns / ratings
  P.eqSignals = function (X, i, ctx, wantIds) {
    const out = [], D = X.D, I = X.I, c = D.c[i], want = id => !wantIds || wantIds.has(id);
    if (i < 210 || !ok(I.atr[i])) return out;
    let sets = null, cps = null, R = null;
    const getSets = () => sets || (sets = E.setups(I, i, 0.05));
    const getCps = () => cps || (cps = E.chartPatterns(P.trunc(I, i + 1), 0.05).filter(p => p.status !== 'forming'));
    const getR = () => R || (R = P.ratings(X, i, ctx));
    for (const s of P.STRATS) {
      if (s.seg !== 'EQ' || !want(s.id)) continue;
      if (s.kind === 'setup') {
        const list = s.src === 'chart' ? getCps().filter(p => p.n === s.setup && p.b > 0) : getSets().filter(x => x.b > 0 && (s.match ? s.match(x.n) : x.n === s.setup));
        for (const x of list.slice(0, 1)) { const o = mkOrder(s, X, i, 1, x.entry != null ? x.entry : c, x.stop, x.target, null, x.q, x.n); if (o) out.push(o); }
      } else if (s.kind === 'band') {
        const r = getR()[s.hz]; if (!r || r.rating < s.min) continue;
        const L = E._levels(I, i, s.hz, 1, 0.05, c); const o = mkOrder(s, X, i, 1, c, L.stop, L.t1, L.t2, r.rating, `${E.HORIZONS[s.hz].label} rating ${r.rating}`); if (o) { o.type = 'open'; out.push(o); }
      } else if (s.kind === 'ema') {
        if (I.e20[i] > I.e50[i] && I.e20[i - 1] <= I.e50[i - 1] && c > I.e200[i]) { const a = I.atr[i]; const o = mkOrder(s, X, i, 1, c, c - 2 * a, c + 2 * a, c + 4 * a, 60 + (I.adx[i] || 0) / 2, '20 EMA crossed above 50 EMA'); if (o) { o.type = 'open'; o.emaExit = 1; out.push(o); } }
      }
    }
    return out;
  };
  // stock futures signals (long and short) for an F&O stock
  P.futSignals = function (X, i, ctx, lot) {
    const out = [], c = X.D.c[i]; if (i < 210 || !lot) return out;
    const R = P.ratings(X, i, Object.assign({}, ctx, { canShort: true }));
    for (const s of P.STRATS.filter(s => s.kind === 'fut')) {
      const r = s.src === 'swing' ? R.swing : R.rating; if (!r) continue;
      const v = r.rating, b = v >= 70 ? 1 : v <= 30 ? -1 : 0; if (!b) continue;
      const L = E._levels(X.I, i, 'swing', b, 0.05, c); if (Math.abs(c - L.stop) * lot > P.FUT_MAX_RISK_LOT) continue; // one lot too risky for the account: not a candidate
      const o = mkOrder(s, X, i, b, c, L.stop, L.t1, L.t2, b > 0 ? v : 100 - v, `${s.src === 'swing' ? 'Swing' : 'Overall'} rating ${v} → ${b > 0 ? 'long' : 'short'}`);
      if (o) { o.type = 'open'; o.seg = 'FUT'; o.lot = lot; out.push(o); }
    }
    return out;
  };
  // index option signal exactly like the app's F&O card when the market is closed (bull = 0.3·intraday + 0.7·swing; side at 65+)
  P.idxSignal = function (und, D, i, vix) {
    const W = { t: D.t.slice(0, i + 1), o: D.o.slice(0, i + 1), h: D.h.slice(0, i + 1), l: D.l.slice(0, i + 1), c: D.c.slice(0, i + 1), v: D.v.slice(0, i + 1), day: D.day.slice(0, i + 1) };
    const A = E.analyze(W, { tick: 0.05, canShort: true, backtest: true, fnoSym: und });
    if (A.err) return null;
    const ctx = { regime: 50, news: 0, canShort: true }, H = A.horizons;
    const ri = E.hzRating(H.intraday, 'intraday', ctx), rs = E.hzRating(H.swing, 'swing', ctx);
    const bull = Math.round(0.3 * ri.rating + 0.7 * rs.rating), ce = bull, pe = 100 - bull;
    const side = ce >= 65 ? 'CE' : pe >= 65 ? 'PE' : null, step = E.strikeStep(und, A.price), atm = Math.round(A.price / step) * step;
    const dirN = side === 'CE' ? 1 : -1, L = side ? (H.swing.levels && H.swing.dir === dirN ? H.swing.levels : E._levels(A.I, i, 'swing', dirN, 0.05, A.price)) : null; // app shows no levels when swing disagrees: use the swing plan for that side
    const strikes = side ? { itm: atm - dirN * step, atm, otm: atm + dirN * step } : null, conv = side ? Math.max(ce, pe) : 0;
    const appPick = side && conv >= 78 && L && (dirN > 0 ? L.t1 >= strikes.otm : L.t1 <= strikes.otm) ? 'otm' : 'atm';
    return { und, day: D.day[i], price: A.price, ce, pe, side, dirN, step, atm, strikes, L, conv, appPick, swingScore: H.swing.score, vix, why: (H.swing.why || []).slice(0, 3).map(w => w.t) };
  };

  // ======================================================================================================
  // 7. Simulator: accounts, fills, exits, mark-to-market
  // ======================================================================================================
  P.newState = function (start) {
    const acc = {}; for (const s of P.STRATS) acc[s.id] = { realised: 0, costs: 0 };
    return { v: 1, start, lastDay: null, liveFrom: null, seq: 0, acc, open: [], pending: [], closed: [], hist: { days: [], eq: {} }, status: {}, reviews: [], scores: {}, log: [] };
  };
  const CAP = s => P.byId[s].cap || P.CAPITAL[P.byId[s].seg];
  P.capital = CAP;
  // ₹ deployed by open positions of a strategy (equity: cost basis; futures: margin; options: premium; condor: max loss)
  function used(st, sid) { let u = 0; for (const t of st.open) if (t.s === sid) u += t.block || 0; return u; }

  // ---- entries ----
  // try to fill a pending order on bar j of its symbol. returns trade or null; sets o.dead when cancelled
  P.tryFill = function (st, o, bar, day, ctxF) {
    const b = o.b, { o: op, h, l } = bar;
    if (o.seg === 'IC') return P.open(st, o, op, day, bar, ctxF);
    if (b > 0 ? op <= o.stop : op >= o.stop) { o.dead = 'opened beyond the stop'; return null; }
    let px = null;
    if (o.type === 'open') { if (b > 0 ? op >= o.t1 : op <= o.t1) { o.dead = 'gapped past Target 1'; return null; } px = op; }
    else if (o.type === 'stop') { if (b > 0 ? h >= o.entry : l <= o.entry) px = b > 0 ? Math.max(op, o.entry) : Math.min(op, o.entry); if (px != null && (b > 0 ? px >= o.t1 : px <= o.t1)) { o.dead = 'triggered above Target 1'; return null; } }
    else if (o.type === 'limit') { if (b > 0 ? l <= o.entry : h >= o.entry) px = b > 0 ? Math.min(op, o.entry) : Math.max(op, o.entry); }
    if (px == null) return null;
    return P.open(st, o, px, day, bar, ctxF);
  };
  // open a position at underlying price px. Sizing by the strategy's fixed ₹ risk.
  P.open = function (st, o, px, day, bar, ctxF) {
    const s = P.byId[o.s], seg = s.seg, kind = o.seg || 'EQ', cap = CAP(o.s), acc = st.acc[o.s];
    const t = { id: `${o.s}:${o.sym}:${day}:${++st.seq}`, s: o.s, sym: o.sym, seg: kind, b: o.b, sig: o.sig, d0: day, u0: r2(px), stop: o.stop, stop0: o.stop, t1: o.t1, t2: o.t2, hold: o.hold, held: 0, why: o.why, src: o.src || null, bf: !!st.bfMode, parts: [], costs: 0, fillDay: true, openFill: o.type === 'open', emaExit: o.emaExit };
    if (kind === 'EQ') {
      const fill = P.slip('EQ', px, o.b > 0 ? 'B' : 'S'), risk1 = Math.abs(fill - o.stop); if (!(risk1 > 0)) return null;
      const want = Math.min(Math.floor(P.RISK.EQ / risk1), Math.floor(P.EQ_MAX_NOTIONAL / fill));
      const free = cap + acc.realised - used(st, o.s), qty = Math.min(want, Math.floor((free - 50) / fill));
      if (want < 1) { o.dead = 'one share is above the size limit'; return null; }
      if (qty < Math.max(1, Math.ceil(want / 2))) { o.dead = 'not enough paper cash (account fully invested)'; return null; } // no token positions: fixed costs would dominate
      const cost = P.orderCost('EQ', 'B', fill * qty, day);
      Object.assign(t, { px0: r2(fill), qty, q0: qty, risk: r2(risk1 * qty), block: fill * qty, costs: cost, mark: fill });
    } else if (kind === 'FUT') {
      const fill = P.slip('FUT', px, o.b > 0 ? 'B' : 'S'), lot = o.lot, riskLot = Math.abs(fill - o.stop) * lot;
      if (!(riskLot > 0) || riskLot > P.FUT_MAX_RISK_LOT) { o.dead = `one lot would risk more than ₹${P.FUT_MAX_RISK_LOT.toLocaleString('en-IN')}`; return null; }
      let lots = clamp(Math.floor(P.FUT_RISK / riskLot), 1, 3); const mLot = P.FUT_MARGIN * fill * lot;
      const free = cap + acc.realised - used(st, o.s); lots = Math.min(lots, Math.floor(free / mLot)); if (lots < 1) { o.dead = 'not enough paper margin'; return null; }
      const qty = lots * lot, cost = P.orderCost('FUT', o.b > 0 ? 'B' : 'S', fill * qty, day);
      Object.assign(t, { px0: r2(fill), qty, q0: qty, lot, lots, risk: r2(Math.abs(fill - o.stop) * qty), block: mLot * lots, costs: cost, mark: fill });
    } else if (kind === 'OPT') {
      const opt = o.opt, prem = P.optPrice(opt, px, day, 'open', ctxF.vix(day, 'open')), fill = P.slip('OPT', prem, 'B'), lot = opt.lot;
      let lots = clamp(Math.floor(P.RISK.FNO / (P.OPT_PREM_STOP * fill * lot)), 1, 10);
      lots = Math.min(lots, Math.floor(P.OPT_MAX_OUTLAY * cap / (fill * lot)));
      const free = cap + acc.realised - used(st, o.s); lots = Math.min(lots, Math.floor(free / (fill * lot))); if (lots < 1) { o.dead = 'premium too large for the paper account'; return null; }
      const qty = lots * lot, cost = P.orderCost('OPT', 'B', fill * qty, day);
      Object.assign(t, { opt: Object.assign({}, opt), px0: r2(fill), qty, q0: qty, lot, lots, risk: r2(P.OPT_PREM_STOP * fill * qty), block: fill * qty, costs: cost, mark: fill, iv0: r2(P.iv(opt.und, ctxF.vix(day, 'open'), px, opt.k, P.tYears(day, 'open', opt.exp)) * 100), prem: 'sim' });
    } else if (kind === 'IC') {
      if (!o.legs) o.legs = P.icLegs(px, day, o.exp, ctxF.vix(day, 'open'), o.und, o.width, 50, o.lot);
      const legs = o.legs.map(L => Object.assign({}, L)), vx = ctxF.vix(day, 'open'); let credit = 0;
      for (const L of legs) { const p = P.optPrice(L, px, day, 'open', vx); L.px0 = r2(P.slip('OPT', p, L.side > 0 ? 'B' : 'S')); credit += -L.side * L.px0; }
      const width = o.width, lot = o.lot, maxLossLot = (width - credit) * lot; if (!(credit > 0) || !(maxLossLot > 0)) { o.dead = 'no credit at the open'; return null; }
      const lots = clamp(Math.floor(2 * P.RISK.FNO / maxLossLot), 1, 5), qty = lots * lot;
      let cost = 0; for (const L of legs) cost += P.orderCost('OPT', L.side > 0 ? 'B' : 'S', L.px0 * qty, day);
      Object.assign(t, { legs, credit: r2(credit), width, px0: r2(credit), qty, q0: qty, lot, lots, risk: r2(maxLossLot * lots), block: maxLossLot * lots, costs: cost, mark: credit, prem: 'sim', exp: o.exp, und: o.und });
    }
    acc.costs += t.costs; st.open.push(t); return t;
  };

  // ---- exits ----
  function close(st, t, part, qty, px, day, why, extraCost = 0) {
    const kind = t.seg, b = t.b; let gross, cost;
    if (kind === 'IC') { gross = (t.px0 - px) * qty; cost = extraCost; }
    else if (kind === 'OPT') { gross = (px - t.px0) * qty; cost = P.orderCost('OPT', 'S', px * qty, day) + extraCost; }
    else { gross = b * (px - t.px0) * qty; cost = P.orderCost(kind === 'FUT' ? 'FUT' : 'EQ', b > 0 ? 'S' : 'B', px * qty, day); }
    t.parts.push({ d: day, px: r2(px), q: qty, why, g: r2(gross) }); t.qty -= qty; t.costs = r2(t.costs + cost);
    const acc = st.acc[t.s]; acc.realised += gross - cost; acc.costs += cost;
    if (t.qty > 0 && t.block) t.block *= t.qty / (t.qty + qty);
    if (t.qty <= 0) {
      const gAll = t.parts.reduce((a, p) => a + p.g, 0); t.pnl = r2(gAll - t.costs); t.R = t.risk > 0 ? r2(t.pnl / t.risk) : 0; t.d1 = day; t.exitWhy = why;
      st.open = st.open.filter(x => x !== t); delete t.block; delete t.mark; delete t.fillDay; st.closed.push(t);
    }
  }
  // entry cost is charged to realised P&L at the open (so equity reflects it immediately)
  function chargeEntry(st, t) { if (!t.entryCostCharged) { st.acc[t.s].realised -= t.costs; t.entryCostCharged = 1; } }
  P._chargeEntry = chargeEntry;

  // process one open trade on day `day` with underlying bar {o,h,l,c}. ctxF: {vix(day, mom)}
  P.step = function (st, t, bar, day, ctxF, nextIsExpiryOrLater) {
    chargeEntry(st, t);
    const b = t.b, kind = t.seg, fresh = t.fillDay; t.fillDay = false; if (!fresh) t.held++;
    if (kind === 'IC') return stepIC(st, t, bar, day, ctxF);
    const half = () => (t.q0 >= 2 && (kind === 'EQ' || t.lots >= 2) ? (kind === 'EQ' ? Math.floor(t.q0 / 2) : Math.floor(t.lots / 2) * t.lot) : t.qty);
    const val = (S, mom) => kind === 'OPT' ? P.optPrice(t.opt, S, day, mom, ctxF.vix(day, mom)) : S;
    const sell = (px, mom) => kind === 'OPT' ? P.slip('OPT', val(px, mom), 'S') : P.slip(kind, px, b > 0 ? 'S' : 'B');
    const premStop = kind === 'OPT' ? P.OPT_PREM_STOP * t.px0 : null;
    // 1) gap at the open (not on the fill bar: we entered at/after the open)
    if (!fresh) {
      if (b * (bar.o - t.stop) <= 0) return close(st, t, 'all', t.qty, sell(bar.o, 'open'), day, t.stop === t.u0 ? 'breakeven stop (gap)' : 'stop (gapped through, filled at open)');
      if (kind === 'OPT' && val(bar.o, 'open') <= premStop) return close(st, t, 'all', t.qty, sell(bar.o, 'open'), day, 'premium stop (gap)');
      if (!t.hitT1 && b * (bar.o - t.t1) >= 0) { const q = half(); t.hitT1 = 1; close(st, t, 't1', q, sell(bar.o, 'open'), day, 'Target 1 (gap, filled at open)'); if (t.qty <= 0) return; t.stop = t.u0; }
      if (t.hitT1 && b * (bar.o - t.t2) >= 0) return close(st, t, 'all', t.qty, sell(bar.o, 'open'), day, 'Target 2 (gap, filled at open)');
    }
    // 2) intraday: stop first (conservative when both levels are inside the day's range)
    const adverse = b > 0 ? bar.l : bar.h, favour = b > 0 ? bar.h : bar.l;
    const stopHit = b * (adverse - t.stop) <= 0;
    if (kind === 'OPT') {
      const worstPrem = val(adverse, 'mid'), premHit = worstPrem <= premStop;
      if (stopHit || premHit) { const pUs = stopHit ? P.slip('OPT', val(t.stop, 'mid'), 'S') : 0, pPs = premHit ? P.slip('OPT', premStop, 'S') : 0; const px = stopHit && premHit ? Math.max(pUs, pPs) : stopHit ? pUs : pPs; return close(st, t, 'all', t.qty, px, day, stopHit && (!premHit || pUs >= pPs) ? (t.hitT1 ? 'breakeven stop' : 'underlying hit stop') : 'premium halved'); }
    } else if (stopHit) return close(st, t, 'all', t.qty, P.slip(kind, t.stop, b > 0 ? 'S' : 'B'), day, t.hitT1 ? 'breakeven stop' : 'stop');
    // targets: on the fill bar only for next-open entries (for stop/limit fills the order of prices inside the bar is unknown)
    if (!fresh || t.openFill) {
      if (!t.hitT1 && b * (favour - t.t1) >= 0) { const q = half(); t.hitT1 = 1; close(st, t, 't1', q, sell(t.t1, 'mid'), day, 'Target 1'); if (t.qty <= 0) return; t.stop = t.u0; }
      if (t.hitT1 && b * (favour - t.t2) >= 0) return close(st, t, 'all', t.qty, sell(t.t2, 'mid'), day, 'Target 2');
    }
    // 3) rule exits at the close
    if (t.emaExit && ctxF.emaCrossDown && ctxF.emaCrossDown(t.sym, day)) return close(st, t, 'all', t.qty, sell(bar.c, 'close'), day, '20 EMA crossed back below 50 EMA');
    if (kind === 'OPT' && nextIsExpiryOrLater) return close(st, t, 'all', t.qty, sell(bar.c, 'close'), day, 'exit the day before expiry');
    if (t.held >= t.hold) return close(st, t, 'all', t.qty, sell(bar.c, 'close'), day, `time exit (${t.hold} sessions)`);
    t.mark = val(bar.c, 'close'); t.uMark = bar.c;
  };
  function icValue(t, S, day, mom, vx) { let v = 0; for (const L of t.legs) v += -L.side * P.optPrice(L, S, day, mom, vx); return v; } // cost to buy back (per unit)
  function stepIC(st, t, bar, day, ctxF) {
    const vx = ctxF.vix(day, 'close'), qty = t.qty;
    if (day >= t.exp) { // settle at the expiry close: intrinsic values; STT on long ITM legs exercised
      let v = 0, exStt = 0; for (const L of t.legs) { const intr = Math.max(0, L.cp === 'CE' ? bar.c - L.k : L.k - bar.c); v += -L.side * intr; if (L.side > 0 && intr > 0) exStt += P.orderCost('OPT', 'S', 0, day, intr * qty); }
      return close(st, t, 'all', qty, v, day, 'settled at expiry', exStt);
    }
    const v = icValue(t, bar.c, day, 'close', vx), buyBack = v + t.legs.length * Math.max(P.SLIP.OPT_MIN, 0) * 0.5;
    const legCost = () => t.legs.reduce((a, L) => a + P.orderCost('OPT', L.side > 0 ? 'S' : 'B', P.optPrice(L, bar.c, day, 'close', vx) * qty, day), 0);
    if (v - t.credit >= 1.5 * t.credit) return close(st, t, 'all', qty, buyBack, day, 'stop: loss ≥ 1.5× credit (checked at close)', legCost());
    if (v <= 0.5 * t.credit) return close(st, t, 'all', qty, buyBack, day, '50% of credit captured', legCost());
    t.mark = v; t.uMark = bar.c;
  }
  // iron condor legs at the entry open: shorts ≈ 1 expected move (S·σ·√T) away, long wings `width` further out
  P.icLegs = function (S, day, exp, vix, und = 'NIFTY', width = 200, step = 50, lot = P.IDX_LOT.NIFTY) {
    const T = P.tYears(day, 'open', exp), em = S * P.iv(und, vix, S, S, T) * Math.sqrt(T);
    const kc = Math.ceil((S + em) / step) * step, kp = Math.floor((S - em) / step) * step;
    return [{ und, cp: 'CE', k: kc, side: -1, exp }, { und, cp: 'CE', k: kc + width, side: 1, exp }, { und, cp: 'PE', k: kp, side: -1, exp }, { und, cp: 'PE', k: kp - width, side: 1, exp }].map(L => Object.assign(L, { lot }));
  };
  // unrealised P&L of an open trade at its last mark
  P.unreal = t => t.seg === 'IC' ? (t.px0 - (t.mark != null ? t.mark : t.px0)) * t.qty : t.seg === 'OPT' ? ((t.mark != null ? t.mark : t.px0) - t.px0) * t.qty : t.b * ((t.mark != null ? t.mark : t.px0) - t.px0) * t.qty;

  // ======================================================================================================
  // 8. Stats, ranking and the weekly review (the "recursion": the league re-grades itself every week)
  // ======================================================================================================
  P.stats = function (trades, eqSeries, cap) {
    const n = trades.length, R = trades.map(t => t.R || 0), pnl = trades.map(t => t.pnl || 0);
    const wins = pnl.filter(x => x > 0), loss = pnl.filter(x => x <= 0);
    const sumR = R.reduce((a, b) => a + b, 0), gp = wins.reduce((a, b) => a + b, 0), gl = -loss.reduce((a, b) => a + b, 0);
    const o = { n, win: n ? Math.round(100 * wins.length / n) : null, avgR: n ? r2(sumR / n) : null, exp: n ? Math.round(pnl.reduce((a, b) => a + b, 0) / n) : null, pf: gl > 0 ? r2(gp / gl) : (gp > 0 ? 99 : null), pnl: Math.round(pnl.reduce((a, b) => a + b, 0)) };
    const last = trades.slice(-20); o.form = last.map(t => (t.pnl > 0 ? 'W' : 'L')).join(''); o.formR = last.length ? r2(last.reduce((a, t) => a + (t.R || 0), 0) / last.length) : null;
    o.shrunkR = r2(sumR / (n + 10));                              // expectancy shrunk toward 0 (10 phantom break-even trades): small samples can't look great
    if (eqSeries && eqSeries.length) {
      const e = eqSeries.filter(ok); let peak = -Infinity, mdd = 0; const rets = [];
      for (let k = 0; k < e.length; k++) { peak = Math.max(peak, e[k]); mdd = Math.min(mdd, e[k] / peak - 1); if (k) rets.push(e[k] / e[k - 1] - 1); }
      const last1 = e[e.length - 1], days = e.length;
      o.ret = r2((last1 / cap - 1) * 100); o.mdd = r2(-mdd * 100); o.days = days;
      o.cagr = days >= 40 ? r2((Math.pow(last1 / cap, 252 / days) - 1) * 100) : null;
      const m = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0, sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) : 0;
      o.sharpe = sd > 0 && rets.length >= 20 ? r2(m / sd * Math.sqrt(252)) : null;
    }
    // robust score: shrunk expectancy (R) × √n, divided by a drawdown penalty. Needs MIN_TRADES to be ranked.
    o.score = n >= P.MIN_TRADES ? r2(o.shrunkR * Math.sqrt(n) / (1 + (o.mdd || 0) / 10)) : null;
    return o;
  };
  // status rules with hysteresis (applied every week). Demoted strategies keep paper-trading so they can recover.
  P.judge = function (prev, x) {
    if (x.n < P.MIN_TRADES) return { st: 'New', why: `${x.n}/${P.MIN_TRADES} trades: not enough to judge` };
    const promoteOK = x.score >= 0.5 && x.shrunkR >= 0.1 && (x.pf || 0) >= 1.2 && (x.formR == null || x.formR > -0.2);
    const demote = x.shrunkR < -0.05 || (x.pf != null && x.pf < 0.9) || (x.formR != null && x.formR < -0.3 && x.n >= 15);
    if (demote) return { st: 'Demoted', why: x.shrunkR < -0.05 ? `losing ${x.avgR}R per trade` : x.pf < 0.9 ? `profit factor ${x.pf}` : `last 20 trades ${x.formR}R avg` };
    if (prev === 'Promoted') return x.score >= 0.25 ? { st: 'Promoted', why: 'still has an edge' } : { st: 'Watch', why: 'edge faded (score < 0.25)' };
    if (promoteOK) return prev === 'Watch' || prev === 'Promoted' ? { st: 'Promoted', why: `score ${x.score}, ${x.avgR}R/trade, PF ${x.pf}` } : { st: 'Watch', why: 'qualifies for promotion: needs to hold up one more week' };
    return { st: 'Watch', why: 'positive but not yet convincing' };
  };
  P.review = function (st, day) {
    const changes = [], rows = {};
    for (const s of P.STRATS) {
      if (s.kind === 'bench') { st.status[s.id] = { st: 'Benchmark', since: st.status[s.id] ? st.status[s.id].since : day, why: 'reference' }; continue; }
      const tr = st.closed.filter(t => t.s === s.id), ser = (st.hist.eq[s.id] || []).filter(ok), x = P.stats(tr, ser, CAP(s.id)); rows[s.id] = x;
      const prev = (st.status[s.id] || {}).st || 'New', j = P.judge(prev, x);
      if (j.st !== prev) changes.push({ id: s.id, from: prev, to: j.st, why: j.why });
      st.status[s.id] = { st: j.st, since: j.st !== prev ? day : (st.status[s.id] || {}).since || day, why: j.why };
      st.scores[s.id] = x.score;
    }
    st.reviews.push({ d: day, changes, bf: !!st.bfMode }); if (st.reviews.length > 60) st.reviews = st.reviews.slice(-60);
    return changes;
  };
  P.promoted = (st, seg) => P.STRATS.filter(s => s.seg === seg && s.kind !== 'meta' && s.kind !== 'bench' && (st.status[s.id] || {}).st === 'Promoted').sort((a, b) => (st.scores[b.id] || 0) - (st.scores[a.id] || 0)).map(s => s.id);

  // setup win-rates measured by the league (for the engine's self-learning: E.SETUP_STATS format [n, hit%, avgRR, edge])
  P.setupStats = function (closed) {
    const out = {};
    for (const s of P.STRATS.filter(s => s.kind === 'setup')) {
      const tr = closed.filter(t => t.s === s.id); if (!tr.length) continue;
      const w = tr.filter(t => t.pnl > 0).length, rr = tr.reduce((a, t) => a + Math.abs(t.t1 - t.u0) / Math.max(1e-9, Math.abs(t.u0 - t.stop0)), 0) / tr.length;
      out[s.setup] = [tr.length, Math.round(100 * w / tr.length), r2(rr), tr.reduce((a, t) => a + (t.R || 0), 0) / tr.length > 0.05 ? 1 : 0];
    }
    return out;
  };

  // ======================================================================================================
  // 9. Helpers for the app's live session (mStock prices while the app is open)
  // ======================================================================================================
  // live P&L of a CI trade given a live underlying price (equity/futures) or live premium (options)
  P.livePnl = function (t, live) {
    if (!ok(live)) return null;
    if (t.seg === 'OPT') return (live - t.px0) * t.qty;
    if (t.seg === 'IC') return null;
    return t.b * (live - t.px0) * t.qty;
  };

  if (isNode) module.exports = P; else root.Paper = P;
})(typeof self !== 'undefined' ? self : this);
