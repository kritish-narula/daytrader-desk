/* F&O research simulator (pure functions, no I/O): used by tools/fno_research.js and tools/fno_research.test.js.
   Index options: Black-Scholes premiums with India-VIX-based IV (reuses www/paper.js helpers: BS, IV skew, expiry calendar, costs, slippage),
   real expiry calendar (NIFTY weekly Tue, SENSEX weekly Thu, BANKNIFTY/FINNIFTY monthly), STT 0.15% on premium from 1-Apr-2026.
   Everything is SIMULATED (no real option prices): treat results as a relative ranking of rules, not as live P&L. */
'use strict';
const E = require('../www/engine.js'), P = require('../www/paper.js');

const ok = x => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const IDX = {
  NIFTY: { y: '^NSEI', mult: 1.0 }, BANKNIFTY: { y: '^NSEBANK', mult: 1.15 }, SENSEX: { y: '^BSESN', mult: 1.0 }, FINNIFTY: { y: 'NIFTY_FIN_SERVICE.NS', mult: 1.05, opt: true },
};
// today's app behaviour (www/app.js indexOption + www/optchain.js CFG) expressed as a research config
const DEFAULT_CFG = {
  sig: { wI: 0.3, wS: 0.7, wH: 0, thr: 65, trend: 'none', vixPctMax: 100, vixMax: 99, vixMin: 0, gapAgainst: null, gapWith: null, dowSkip: [], bigSkip: null },
  strike: { mode: 'delta', aim: 0.55 },
  exit: { minDays: 4, hold: 3, sl: 0.5, stopU: 'lvl', tgt: { kind: 'lvl', v: 0 }, trail: null, ivSpread: 100 },
};
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- premium model ----------
function ivOf(sim, vix, S, K, T) {
  const base = clamp((ok(vix) ? vix : 14) / 100 * sim.ivm, 0.05, 1.5), z = Math.log(K / S) / (base * Math.sqrt(Math.max(T, 1 / 365)));
  return base * clamp(1 + P.SKEW.slope * z + P.SKEW.curve * z * z, 0.7, 1.8);
}
function optPx(M, sim, c, S, day, mom, j) { // c: {k, cp, exp}; j = bar index (for the VIX of that moment)
  if (day >= c.exp && mom === 'close') return Math.max(0, c.cp === 'CE' ? S - c.k : c.k - S);
  const T = P.tYears(day, mom, c.exp), vix = M.vixAt(j, mom);
  return Math.max(0.05, P.bs(S, c.k, T, ivOf(sim, vix, S, c.k, T), c.cp, P.RF, P.DIV[M.und] || 0.01).p);
}
function deltaOf(M, sim, S, K, cp, day, exp, j) { const T = P.tYears(day, 'open', exp); return P.bs(S, K, T, ivOf(sim, M.vixAt(j, 'open'), S, K, T), cp, P.RF, P.DIV[M.und] || 0.01).delta; }
function pickStrike(M, sim, S, side, rule, day, exp, j) {
  const step = E.strikeStep(M.und, S), atm = Math.round(S / step) * step, dir = side === 'CE' ? 1 : -1;
  if (rule.mode === 'steps') return atm - dir * rule.n * step; // n: 1 = one strike in the money, 0 = ATM, -1 = one out of the money
  let best = atm, bd = 9;
  for (let q = -12; q <= 12; q++) { const K = atm + q * step, d = Math.abs(deltaOf(M, sim, S, K, side, day, exp, j)), e = Math.abs(d - rule.aim); if (e < bd) { bd = e; best = K; } }
  return best;
}
const expCache = new Map();
function expiryOf(M, day, minSessions) {
  const key = M.und + '|' + day + '|' + minSessions; let v = expCache.get(key); if (v !== undefined) return v;
  v = P.pickExpiry(M.und, day, minSessions, M.extra) || null; expCache.set(key, v); return v;
}

// ---------- one outright option trade ----------
// M: {und, D (o,h,l,c,day), atr[], lot, extra, vixAt(j, mom), lv(i, dir) → {stop,t1,t2}}; entry at the OPEN of bar i+1 (signal at the close of bar i).
function simOption(M, sim, i, side, cfg) {
  const D = M.D, e = i + 1, n = D.c.length; if (e >= n - 1) return null;
  const X = cfg.exit, day = D.day[e], exp = expiryOf(M, day, X.minDays); if (!exp) return null;
  const dir = side === 'CE' ? 1 : -1, u0 = D.o[e], K = pickStrike(M, sim, u0, side, cfg.strike, day, exp, e), c = { k: K, cp: side, exp }, qty = M.lot;
  const fill = P.slip('OPT', optPx(M, sim, c, u0, day, 'open', e), 'B'); if (!(fill > 0)) return null;
  const costs0 = P.orderCost('OPT', 'B', fill * qty, day), L = (X.stopU === 'lvl' || X.tgt.kind === 'lvl') ? M.lv(i, dir) : null;
  let stopU = X.stopU === 'lvl' ? L.stop : ok(X.stopU) ? u0 - dir * X.stopU * M.atr[i] : null;
  let tgtPrem = X.tgt.kind === 'prem' ? fill * (1 + X.tgt.v) : null, tgtU = X.tgt.kind === 'und' ? u0 + dir * X.tgt.v * M.atr[i] : X.tgt.kind === 'lvl' ? L.t1 : null;
  const t2U = X.tgt.kind === 'lvl' ? L.t2 : null, premStop = fill * (1 - X.sl);
  let rem = 1, gross = 0, costs = costs0, trailStop = 0, peak = fill, hitT1 = false, why = '', exitDay = day, held = 0;
  const sell = (px, frac, d) => { const sp = P.slip('OPT', px, 'S'); gross += (sp - fill) * qty * frac; costs += P.orderCost('OPT', 'S', sp * qty * frac, d); rem -= frac; };
  for (let j = e; j < n && rem > 1e-9; j++) {
    const d = D.day[j], fresh = j === e; held = j - e + 1; exitDay = d; const o = D.o[j], h = D.h[j], l = D.l[j], cl = D.c[j];
    if (d >= exp) { // settle at intrinsic (expiry-day close); ITM exercise STT on intrinsic
      const intr = Math.max(0, side === 'CE' ? cl - K : K - cl); gross += (intr - fill) * qty * rem; costs += P.orderCost('OPT', 'S', intr * qty * rem, d, intr > 0 ? intr * qty * rem : 0); rem = 0; why = 'expiry'; break;
    }
    const curStop = Math.max(premStop, trailStop);
    if (!fresh) {
      const po = optPx(M, sim, c, o, d, 'open', j);
      if (po <= curStop || (stopU != null && dir * (o - stopU) <= 0)) { sell(po, rem, d); why = 'gap stop'; break; }
      if (tgtPrem != null && po >= tgtPrem) { sell(po, rem, d); why = 'gap target'; break; }
      if (X.tgt.kind === 'und' && dir * (o - tgtU) >= 0) { sell(po, rem, d); why = 'gap target'; break; }
      if (X.tgt.kind === 'lvl') {
        if (!hitT1 && dir * (o - L.t1) >= 0) { hitT1 = true; sell(po, rem > 0.99 ? 0.5 : rem, d); stopU = u0; if (rem <= 1e-9) { why = 'T1 (gap)'; break; } }
        if (hitT1 && dir * (o - t2U) >= 0) { sell(po, rem, d); why = 'T2 (gap)'; break; }
      }
    }
    const adv = dir > 0 ? l : h, fav = dir > 0 ? h : l, worst = optPx(M, sim, c, adv, d, 'mid', j);
    const sHit = stopU != null && dir * (adv - stopU) <= 0, pHit = worst <= curStop;
    if (sHit || pHit) { // stop first (conservative); when both trigger the better exit price is used, like paper.js
      const a = sHit ? optPx(M, sim, c, stopU, d, 'mid', j) : 0, b2 = pHit ? curStop : 0; sell(Math.max(0.05, Math.max(a, b2)), rem, d); why = hitT1 ? 'breakeven/trail stop' : 'stop'; break; }
    const best = optPx(M, sim, c, fav, d, 'mid', j);
    if (tgtPrem != null && best >= tgtPrem) { sell(tgtPrem, rem, d); why = 'target'; break; }
    if (tgtU != null && X.tgt.kind === 'und' && dir * (fav - tgtU) >= 0) { sell(optPx(M, sim, c, tgtU, d, 'mid', j), rem, d); why = 'target'; break; }
    if (X.tgt.kind === 'lvl') {
      if (!hitT1 && dir * (fav - L.t1) >= 0) { hitT1 = true; const f = rem > 0.99 ? 0.5 : rem; sell(optPx(M, sim, c, L.t1, d, 'mid', j), f, d); stopU = u0; if (rem <= 1e-9) { why = 'T1'; break; } }
      if (hitT1 && dir * (fav - t2U) >= 0) { sell(optPx(M, sim, c, t2U, d, 'mid', j), rem, d); why = 'T2'; break; }
    }
    peak = Math.max(peak, best); if (X.trail && peak >= fill * (1 + X.trail.act)) trailStop = Math.max(trailStop, peak * (1 - X.trail.off));
    if (held >= X.hold || P.tradingDaysBetween(d, exp, M.extra) <= 1) { sell(optPx(M, sim, c, cl, d, 'close', j), rem, d); why = held >= X.hold ? 'time' : 'day before expiry'; break; }
  }
  if (rem > 1e-9) { const j = n - 1; sell(optPx(M, sim, c, D.c[j], D.day[j], 'close', j), rem, D.day[j]); why = 'end of data'; }
  const pnl = gross - costs, risk = X.sl * fill * qty;
  return { i, e, day, side, k: K, exp, fill, pnl, pct: pnl / (fill * qty) * 100, R: pnl / risk, why, held, costs, exitDay };
}

// ---------- debit spread (used when IV is rich): buy the picked strike, sell `w` strikes further out. Close-based exits (simple) ----------
function simSpread(M, sim, i, side, cfg) {
  const D = M.D, e = i + 1, n = D.c.length; if (e >= n - 1) return null;
  const X = cfg.exit, day = D.day[e], exp = expiryOf(M, day, X.minDays); if (!exp) return null;
  const dir = side === 'CE' ? 1 : -1, u0 = D.o[e], K1 = pickStrike(M, sim, u0, side, cfg.strike, day, exp, e), step = E.strikeStep(M.und, u0), w = Math.max(2, Math.round(u0 * 0.01 / step)) * step, K2 = K1 + dir * w;
  const c1 = { k: K1, cp: side, exp }, c2 = { k: K2, cp: side, exp }, qty = M.lot;
  const b0 = P.slip('OPT', optPx(M, sim, c1, u0, day, 'open', e), 'B'), s0 = P.slip('OPT', optPx(M, sim, c2, u0, day, 'open', e), 'S'), debit = b0 - s0; if (!(debit > 0.5) || debit >= w) return null;
  let costs = P.orderCost('OPT', 'B', b0 * qty, day) + P.orderCost('OPT', 'S', s0 * qty, day), p1 = null, p2 = null, why = '', held = 0, exitDay = day;
  const legs = (S, d, mom, j) => [optPx(M, sim, c1, S, d, mom, j), optPx(M, sim, c2, S, d, mom, j)];
  for (let j = e; j < n; j++) {
    const d = D.day[j]; held = j - e + 1; exitDay = d; const cl = D.c[j];
    if (d >= exp) { p1 = Math.max(0, side === 'CE' ? cl - K1 : K1 - cl); p2 = Math.max(0, side === 'CE' ? cl - K2 : K2 - cl); why = 'expiry'; break; }
    const [a1, a2] = legs(cl, d, 'close', j);
    if (a1 - a2 <= debit * (1 - X.sl)) { p1 = a1; p2 = a2; why = 'stop'; break; }
    if (held >= X.hold || P.tradingDaysBetween(d, exp, M.extra) <= 1) { p1 = a1; p2 = a2; why = 'time'; break; }
  }
  if (p1 == null) return null;
  const x1 = why === 'expiry' ? p1 : P.slip('OPT', p1, 'S'), x2 = why === 'expiry' ? p2 : P.slip('OPT', p2, 'B');
  costs += P.orderCost('OPT', 'S', x1 * qty, exitDay, why === 'expiry' && p1 > 0 ? p1 * qty : 0) + (why === 'expiry' ? 0 : P.orderCost('OPT', 'B', x2 * qty, exitDay));
  const pnl = ((x1 - x2) - debit) * qty - costs, risk = X.sl * debit * qty;
  return { i, e, day, side, k: K1, exp, fill: debit, pnl, pct: pnl / (debit * qty) * 100, R: pnl / risk, why: 'spread ' + why, held, costs, exitDay, spread: true };
}

// ---------- signal generation ----------
// T: per-bar feature table {sI, rS, rSh, c, e20, e50, e200, adx, ret1, sig20, vix, vixPct, o} (arrays). Signal at the close of bar i.
function bullOf(T, s, i) { const w = s.wI + s.wS + s.wH; return (s.wI * T.sI[i] + s.wS * T.rS[i] + s.wH * T.rSh[i]) / w; }
function sideAt(T, s, i) {
  if (!(T.sI[i] >= 0) || !(T.rS[i] >= 0) || !(T.rSh[i] >= 0)) return null;
  const bull = bullOf(T, s, i), side = bull >= s.thr ? 'CE' : 100 - bull >= s.thr ? 'PE' : null; if (!side) return null;
  const dir = side === 'CE' ? 1 : -1, c = T.c[i];
  switch (s.trend) {
    case 'e20': if (dir * (c - T.e20[i]) <= 0) return null; break;
    case 'e50': if (dir * (c - T.e50[i]) <= 0) return null; break;
    case 'e2050': if (dir * (T.e20[i] - T.e50[i]) <= 0 || dir * (c - T.e20[i]) <= 0) return null; break;
    case 'e200': if (dir * (c - T.e200[i]) <= 0) return null; break;
    case 'adx20': if (!(T.adx[i] > 20)) return null; break;
    case 'adx25': if (!(T.adx[i] > 25)) return null; break;
    case 'e50adx': if (dir * (c - T.e50[i]) <= 0 || !(T.adx[i] > 20)) return null; break;
    default:
  }
  if (T.vix[i] > s.vixMax || T.vix[i] < s.vixMin || T.vixPct[i] > s.vixPctMax) return null;
  const g = dir * (T.o[i + 1] / c - 1) * 100; // gap at the entry open, in the trade direction
  if (s.gapAgainst != null && g < -s.gapAgainst) return null;
  if (s.gapWith != null && g > s.gapWith) return null;
  if (s.dowSkip && s.dowSkip.length && s.dowSkip.includes(T.dow[i + 1])) return null;
  if (s.bigSkip != null && dir * T.ret1[i] >= s.bigSkip * T.sig20[i]) return null;
  return side;
}
function signalList(T, s, a, b) { const out = []; for (let i = a; i < b; i++) { const side = sideAt(T, s, i); if (side) out.push({ i, side }); } return out; }

// ---------- trade-set statistics ----------
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }
function stats(tr) {
  const n = tr.length; if (!n) return { n: 0, hit: null, avgR: 0, expPct: 0, pf: null, mdd: 0, t: 0, se: 0, worst: 0, sumR: 0 };
  const R = tr.map(t => t.R), pct = tr.map(t => t.pct), w = tr.filter(t => t.pnl > 0), gp = w.reduce((a, t) => a + t.pnl, 0), gl = -tr.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  let eq = 0, pk = 0, mdd = 0; for (const t of tr) { eq += t.R; pk = Math.max(pk, eq); mdd = Math.max(mdd, pk - eq); }
  const s = sd(R), se = s / Math.sqrt(n);
  return { n, hit: w.length / n * 100, avgR: mean(R), expPct: mean(pct), pf: gl > 0 ? gp / gl : gp > 0 ? 99 : null, mdd, t: se > 0 ? mean(R) / se : 0, se, worst: Math.min(...R), sumR: R.reduce((a, b) => a + b, 0) };
}
// seeded bootstrap 95% CI of the mean
function bootCI(v, B = 400, seed = 7) {
  if (v.length < 8) return [NaN, NaN]; let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }, m = [];
  for (let b = 0; b < B; b++) { let x = 0; for (let k = 0; k < v.length; k++) x += v[Math.floor(rnd() * v.length)]; m.push(x / v.length); }
  m.sort((a, b) => a - b); return [m[Math.floor(B * 0.025)], m[Math.floor(B * 0.975)]];
}

module.exports = { IDX, DEFAULT_CFG, clone, ivOf, optPx, pickStrike, expiryOf, simOption, simSpread, bullOf, sideAt, signalList, mean, sd, stats, bootCI, ok, clamp };
