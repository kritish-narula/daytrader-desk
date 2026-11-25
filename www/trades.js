/* Trades: your own trade tracker (equity / futures / options), live P&L, rules engine (SL / targets / trailing /
   underlying levels / expiry-day / intraday square-off reminders) and a journal with stats.
   Data stays on this phone, encrypted with the app PIN (Sec 'trades'). The app never places orders: it only
   SUGGESTS exits, you exit in your broker app and then tap Exit here to record it. Not investment advice. */
'use strict';
(function () {
  const KEY = 'trades', MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
  const r2 = x => Math.round(x * 100) / 100, num = v => { if (v == null || v === '') return NaN; const s = String(v).replace(/[₹,\s]/g, ''); return s === '' ? NaN : +s; };
  const ist = () => { const d = new Date(Date.now() + 5.5 * 3600e3); return { day: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

  // ---------- storage (PIN-encrypted via Sec, like the portfolio) ----------
  let DB = null;
  const locked = () => window.Sec && Sec.hasPin() && !Sec.isUnlocked();
  function load() {
    if (DB) return DB; if (locked()) return { v: 1, list: [] };
    let d = null; try { d = window.Sec ? Sec.get(KEY) : null; } catch (e) {}
    DB = d && Array.isArray(d.list) ? d : { v: 1, list: [] }; return DB;
  }
  function save() { if (locked() || !DB) return; try { Sec.set(KEY, DB); } catch (e) {} }
  const LIVE = {}; // id -> {px, u, at, err}  (in memory; the last mark is also stored on the trade)

  // ---------- costs (Indian charges) ----------
  // Reuses Paper.orderCost (brokerage ₹20/order or 0.03% for intraday/F&O whichever lower, STT, exchange txn, SEBI, stamp, GST, DP).
  // Fallback below is only used if paper.js is missing: rough all-in rates per side on turnover.
  const costKind = t => t.kind === 'EQ' ? (t.prod === 'INTRA' ? 'EQI' : 'EQ') : t.kind;
  function oc(t, side, px, q, day) {
    const v = px * q; if (!(v > 0)) return 0;
    if (window.Paper && Paper.orderCost) return Paper.orderCost(costKind(t), side, v, day);
    const brk = Math.min(20, v * 0.0003), stt = { EQ: 0.001, EQI: side === 'S' ? 0.00025 : 0, FUT: side === 'S' ? 0.0005 : 0, OPT: side === 'S' ? 0.0015 : 0 }[costKind(t)] || 0;
    const txn = (costKind(t) === 'OPT' ? 0.00035 : 0.00003) * v, sebi = 1e-6 * v, stamp = side === 'B' ? 0.00003 * v : 0;
    return brk + stt * v + txn + sebi + stamp + 0.18 * (brk + txn + sebi);
  }
  const dirOf = t => t.side === 'SELL' ? -1 : 1;
  const exitSide = t => dirOf(t) > 0 ? 'S' : 'B', entrySide = t => dirOf(t) > 0 ? 'B' : 'S';

  // realised numbers for what has been exited so far
  function realised(t) {
    const d = dirOf(t), day = (t.openDay || ist().day); let gross = 0, ex = 0, q = 0, exCost = 0;
    for (const p of t.parts || []) { gross += d * (p.px - t.entry) * p.q; q += p.q; exCost += oc(t, exitSide(t), p.px, p.q, p.day || day); }
    const entryCost = oc(t, entrySide(t), t.entry, t.q0, day);
    const charges = t.fixedCharges != null ? t.fixedCharges : (t.status === 'closed' ? entryCost : entryCost * (q / (t.q0 || 1))) + exCost;
    const risk = Math.abs(t.entry - (t.sl0 != null ? t.sl0 : NaN)) * q;
    const netv = gross - charges;
    return { gross: r2(gross), charges: r2(charges), net: r2(netv), q, R: risk > 0 ? r2(gross / risk) : null, netR: risk > 0 ? r2(netv / risk) : null, exitAvg: q ? (t.parts || []).reduce((a, p) => a + p.px * p.q, 0) / q : null };
  }
  const holdMs = t => (t.closedAt || Date.now()) - (t.t0 || Date.now());

  function label(t) {
    if (t.kind === 'OPT') return `${t.und} ${t.strike} ${t.cp}${t.exp ? ' ' + t.exp.slice(8) + ' ' + MON[+t.exp.slice(5, 7) - 1] : ''}`;
    if (t.kind === 'FUT') return `${t.und || t.sym} FUT${t.exp ? ' ' + MON[+t.exp.slice(5, 7) - 1] : ''}`;
    return t.sym;
  }

  // ---------- CRUD ----------
  function normalise(o) {
    const kind = ['EQ', 'FUT', 'OPT'].includes(o.kind) ? o.kind : 'EQ', lot = +o.lot > 0 ? +o.lot : 1;
    let qty = +o.qty; if (!(qty > 0) && +o.lots > 0) qty = +o.lots * lot;
    const side = o.side === 'SELL' ? 'SELL' : 'BUY', e = num(o.entry);
    if (!(qty > 0)) throw new Error('Enter the quantity');
    if (!(e > 0)) throw new Error('Enter the entry price');
    const n = v => { const x = num(v); return x > 0 ? x : null; };
    const t = {
      id: o.id || 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind, mkt: 'IN', prod: o.prod === 'INTRA' ? 'INTRA' : 'POS',
      sym: String(o.sym || o.und || '').toUpperCase(), und: String(o.und || (kind === 'EQ' ? '' : o.sym) || '').toUpperCase(), exp: o.exp || '', strike: kind === 'OPT' ? +o.strike || 0 : 0, cp: kind === 'OPT' ? o.cp : '',
      k: o.k || '', kGuess: !!o.kGuess, lot, lots: +o.lots || (kind === 'EQ' ? 0 : Math.round(qty / lot)), qty, q0: qty, side, entry: r2(e), t0: o.t0 || Date.now(), openDay: o.openDay || ist().day,
      sl: n(o.sl), sl0: n(o.sl0 != null ? o.sl0 : o.sl), t1: n(o.t1), t2: n(o.t2), slU: n(o.slU), t1U: n(o.t1U), t2U: n(o.t2U),
      trail: o.trail && o.trail.type && o.trail.type !== 'none' ? { type: o.trail.type, v: +o.trail.v || 0 } : { type: 'none', v: 0 },
      tag: String(o.tag || '').trim(), note: String(o.note || '').trim(), src: o.source || o.src || '', status: 'open', parts: [], ev: {}, best: r2(e),
    };
    if (kind === 'EQ') { t.und = ''; t.exp = ''; }
    return t;
  }
  const Trades = {
    KINDS: { EQ: 'Equity', FUT: 'Future', OPT: 'Option' },
    INDICES, label, realised, dirOf, holdMs, LIVE,
    all: () => load().list.slice(),
    open: () => load().list.filter(t => t.status === 'open'),
    closed: () => load().list.filter(t => t.status === 'closed').sort((a, b) => b.closedAt - a.closedAt),
    get: id => load().list.find(t => t.id === id),
    locked,
    add(o) { const t = normalise(o); load().list.push(t); save(); this.tick({ force: true }).catch(() => {}); return t; },
    update(id, patch) {
      const t = this.get(id); if (!t) return null;
      for (const k of ['sl', 't1', 't2', 'slU', 't1U', 't2U']) if (k in patch) { const x = num(patch[k]); t[k] = x > 0 ? x : null; if (k === 'sl' && t.sl0 == null) t.sl0 = t.sl; if (k === 'sl') { delete t.ev.sl; delete t.ev.trail; } else delete t.ev[{ t1: 'tg1', t2: 'tg2', slU: 'slU', t1U: 'tg1U', t2U: 'tg2U' }[k]]; }
      for (const k of ['tag', 'note', 'prod', 'k']) if (k in patch) t[k] = String(patch[k] || '').trim();
      if (patch.trail) t.trail = patch.trail; if (patch.k) t.kGuess = false;
      save(); return t;
    },
    remove(id) { const D = load(); D.list = D.list.filter(t => t.id !== id); delete LIVE[id]; save(); },
    // record an exit (partial or full). Never called automatically.
    exit(id, q, px, why) {
      const t = this.get(id); if (!t || t.status !== 'open') throw new Error('Trade is not open');
      q = Math.min(+q, t.qty); px = num(px); if (!(q > 0)) throw new Error('Enter the quantity to exit'); if (!(px > 0)) throw new Error('Enter the exit price');
      t.parts.push({ t: Date.now(), day: ist().day, px: r2(px), q, why: why || 'manual' }); t.qty -= q;
      if (t.qty <= 0) { t.qty = 0; t.status = 'closed'; t.closedAt = Date.now(); }
      save(); return realised(t);
    },
    reopen(id) { const t = this.get(id); if (t && t.status === 'closed') { const p = t.parts.pop(); t.qty += p.q; t.status = 'open'; delete t.closedAt; save(); } },

    // ---------- statistics (net of charges; a "win" = net P&L > 0) ----------
    stats(list) {
      const rows = list.map(t => ({ t, r: realised(t) })), n = rows.length;
      const W = rows.filter(x => x.r.net > 0), L = rows.filter(x => x.r.net < 0), sum = a => a.reduce((s, x) => s + x.r.net, 0);
      const out = { n, wins: W.length, losses: L.length, total: r2(sum(rows)), gross: r2(rows.reduce((s, x) => s + x.r.gross, 0)), charges: r2(rows.reduce((s, x) => s + x.r.charges, 0)) };
      out.winRate = n ? W.length / n * 100 : 0; out.avgWin = W.length ? sum(W) / W.length : 0; out.avgLoss = L.length ? sum(L) / L.length : 0;
      out.pf = L.length ? sum(W) / Math.abs(sum(L)) : (W.length ? Infinity : 0); out.exp = n ? sum(rows) / n : 0;
      const Rs = rows.map(x => x.r.netR).filter(x => x != null); out.expR = Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : null;
      out.best = n ? rows.reduce((a, b) => b.r.net > a.r.net ? b : a) : null; out.worst = n ? rows.reduce((a, b) => b.r.net < a.r.net ? b : a) : null;
      const grp = f => { const g = {}; for (const x of rows) { const k = f(x.t) || '–'; (g[k] = g[k] || { n: 0, net: 0, w: 0 }); g[k].n++; g[k].net += x.r.net; if (x.r.net > 0) g[k].w++; } return g; };
      out.byTag = grp(t => t.tag); out.byType = grp(t => t.kind === 'EQ' ? 'Equity' : 'F&O');
      const sorted = rows.slice().sort((a, b) => a.t.closedAt - b.t.closedAt); let c = 0; out.curve = sorted.map(x => ({ t: x.t.closedAt, v: (c += x.r.net, r2(c)) }));
      return out;
    },
    // open book: live unrealised P&L (only trades we could price)
    summary() {
      const L = this.open(); let pnl = 0, priced = 0;
      for (const t of L) { const lv = LIVE[t.id], px = lv && lv.px != null ? lv.px : null; if (px != null) { pnl += dirOf(t) * (px - t.entry) * t.qty; priced++; } }
      return { n: L.length, pnl: r2(pnl), priced };
    },

    // ---------- CSV ----------
    CSV_HEAD: ['id', 'opened', 'closed', 'type', 'product', 'side', 'symbol', 'underlying', 'expiry', 'strike', 'cp', 'key', 'lot', 'qty', 'entry', 'exit', 'sl', 't1', 't2', 'gross', 'charges', 'net', 'r', 'tag', 'note'],
    toCSV(list) {
      const q = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const rows = (list || this.closed()).map(t => { const r = realised(t); return [t.id, new Date(t.t0).toISOString(), t.closedAt ? new Date(t.closedAt).toISOString() : '', t.kind, t.prod, t.side, t.sym, t.und, t.exp, t.strike || '', t.cp, t.k, t.lot, t.q0, t.entry, r.exitAvg != null ? r2(r.exitAvg) : '', t.sl0 ?? '', t.t1 ?? '', t.t2 ?? '', r.gross, r.charges, r.net, r.R ?? '', t.tag, t.note].map(q).join(','); });
      return [this.CSV_HEAD.join(','), ...rows].join('\n');
    },
    importCSV(text) {
      const rows = []; let row = [], f = '', qt = false; text = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      for (let i = 0; i < text.length; i++) { const ch = text[i]; if (qt) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else qt = false; } else f += ch; continue; } if (ch === '"') qt = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += ch; }
      if (f.length || row.length) { row.push(f); rows.push(row); }
      const clean = rows.filter(r => r.some(x => x.trim())); if (clean.length < 2) return { added: 0, skipped: 0 };
      const H = clean[0].map(h => h.trim().toLowerCase()), ix = n => H.indexOf(n), g = (r, n) => { const i = ix(n); return i < 0 ? '' : (r[i] || '').trim(); };
      if (ix('entry') < 0 || ix('qty') < 0) throw new Error('CSV needs at least the columns: symbol, type, side, qty, entry (and exit for closed trades)');
      const D = load(); let added = 0, skipped = 0;
      for (const r of clean.slice(1)) {
        try {
          const id = g(r, 'id'); if (id && D.list.some(t => t.id === id)) { skipped++; continue; }
          const kind = (g(r, 'type') || 'EQ').toUpperCase().slice(0, 3), exit = num(g(r, 'exit')), opened = Date.parse(g(r, 'opened')) || Date.now(), closed = Date.parse(g(r, 'closed')) || (exit > 0 ? opened : 0);
          const t = normalise({ id: id || undefined, kind: kind === 'OPT' || kind === 'FUT' ? kind : 'EQ', prod: g(r, 'product'), side: (g(r, 'side') || 'BUY').toUpperCase(), sym: g(r, 'symbol'), und: g(r, 'underlying'), exp: g(r, 'expiry'), strike: g(r, 'strike'), cp: g(r, 'cp'), k: g(r, 'key'), lot: g(r, 'lot') || 1, qty: g(r, 'qty'), entry: g(r, 'entry'), sl: g(r, 'sl'), t1: g(r, 't1'), t2: g(r, 't2'), tag: g(r, 'tag'), note: g(r, 'note'), t0: opened });
          if (exit > 0) { t.parts.push({ t: closed, day: new Date(closed).toISOString().slice(0, 10), px: exit, q: t.q0, why: 'import' }); t.qty = 0; t.status = 'closed'; t.closedAt = closed; const ch = num(g(r, 'charges')); if (isFinite(ch)) t.fixedCharges = ch; }
          D.list.push(t); added++;
        } catch (e) { skipped++; }
      }
      save(); return { added, skipped };
    },
  };

  // ---------- live prices ----------
  const yCache = {};
  async function yahooPx(sym) { // equity / index fallback (delayed)
    const c = yCache[sym]; if (c && Date.now() - c.at < 20e3) return c.px;
    try { const d = await chart(ySym(sym, 'IN'), '1d', '5m'); const px = d.meta && d.meta.regularMarketPrice || (d.D && d.D.c[d.D.c.length - 1]); if (px > 0) { yCache[sym] = { px, at: Date.now() }; return px; } } catch (e) {}
    return null;
  }
  async function keyOf(sym) { try { const k = await MS.key(sym); return k && k.k; } catch (e) { return null; } }
  let busy = false;
  async function prices(list) {
    const msOk = !!(window.MS && MS.ok && MS.ok()), need = new Map(); // key -> [{t,field}]
    const want = (k, t, f) => { if (!k) return; if (!need.has(k)) need.set(k, []); need.get(k).push([t, f]); };
    for (const t of list) {
      if (msOk) {
        if (t.kind === 'EQ') want(await keyOf(t.sym), t, 'px'); else want(t.k, t, 'px');
        if (t.kind !== 'EQ' && t.und) want(await keyOf(t.und), t, 'u');
      }
    }
    const got = {}; let msErr = null;
    if (need.size) { try { Object.assign(got, await MS.ltp([...need.keys()])); } catch (e) { msErr = e.message; } }
    for (const t of list) {
      const lv = LIVE[t.id] = LIVE[t.id] || {}, had = lv.px, hadU = lv.u; lv.px = null; lv.u = null; lv.err = null; lv.stale = false;
      for (const [k, a] of need) for (const [x, f] of a) if (x === t && got[k] > 0) lv[f] = +got[k];
      if (lv.px > 0) lv.src = 'mStock';
      else if (t.kind === 'EQ') { const y = await yahooPx(t.sym); if (y) { lv.px = y; lv.src = 'Yahoo (delayed)'; } }
      else lv.err = msOk ? (t.k ? 'No live quote for ' + t.k + (msErr ? ' (' + msErr + ')' : '') : 'No contract key') : 'Log in to mStock (Settings) for live F&O prices';
      if (t.kind !== 'EQ' && t.und && !(lv.u > 0)) { const y = await yahooPx(t.und); if (y) lv.u = y; }
      if (lv.px > 0) { lv.at = Date.now(); t.mark = lv.px; }
      else if (had > 0) { lv.px = had; lv.stale = true; if (!(lv.u > 0)) lv.u = hadU; } // keep showing the last price, marked stale (rules skip it)
    }
  }

  // ---------- rules engine ----------
  function rules(t, lv, now) {
    const ev = [], d = dirOf(t), px = lv.px, u = lv.u, c = '₹', f = x => r2(x).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const fire = (k, title, body) => { if (!t.ev[k]) { t.ev[k] = Date.now(); ev.push({ sym: t.und || t.sym, mkt: 'IN', kind: 'trade:' + t.id + ':' + k, title: `${label(t)}: ${title}`, body }); } };
    const lab = label(t);
    if (!(lv.fresh && px > 0)) { // time rules still run without a price
      timeRules(); return ev;
    }
    // best price since entry (for trailing)
    t.best = d > 0 ? Math.max(t.best || t.entry, px) : Math.min(t.best || t.entry, px);
    // targets first so "SL to cost" is in place before the SL check
    if (t.t1 && d * (px - t.t1) >= 0) {
      const first = !t.ev.tg1;
      fire('tg1', `T1 hit ${c}${f(t.t1)}`, `LTP ${c}${f(px)}. Consider booking part of the position.` + (t.trail.type === 'cost' ? ` SL moved to cost ${c}${f(t.entry)}.` : ''));
      if (first && t.trail.type === 'cost' && (t.sl == null || d * (t.entry - t.sl) > 0)) { t.sl = t.entry; t.trailed = true; }
    }
    if (t.t2 && d * (px - t.t2) >= 0) fire('tg2', `T2 hit ${c}${f(t.t2)}`, `LTP ${c}${f(px)}. Full target reached: consider exiting the rest.`);
    // trailing by % / points: starts after T1 (if there is one) else straight away
    if ((t.trail.type === 'pct' || t.trail.type === 'pts') && t.trail.v > 0 && (!t.t1 || t.ev.tg1)) {
      const dist = t.trail.type === 'pct' ? t.best * t.trail.v / 100 : t.trail.v, cand = r2(d > 0 ? t.best - dist : t.best + dist);
      if (t.sl == null || d * (cand - t.sl) > 0) { t.sl = cand; t.trailed = true; }
    }
    if (t.trailed && !t.ev.trail && t.sl != null) fire('trail', `SL trailed to ${c}${f(t.sl)}`, `Stop moved ${t.trail.type === 'cost' ? 'to cost after T1' : 'with your trailing rule'}. LTP ${c}${f(px)}.`);
    if (t.sl && d * (px - t.sl) <= 0) fire('sl', `SL hit ${c}${f(t.sl)}`, `LTP ${c}${f(px)}. Exit now (open your broker app); then tap Exit here to record it.`);
    // underlying levels: exposure direction b (long call / short put = up)
    if (u > 0) {
      const b = d * (t.kind === 'OPT' && t.cp === 'PE' ? -1 : 1);
      if (t.slU && b * (u - t.slU) <= 0) fire('slU', `${t.und} at SL level ${f(t.slU)}`, `${t.und} is ${f(u)}, through your underlying stop ${f(t.slU)}. Exit ${lab} now.`);
      if (t.t1U && b * (u - t.t1U) >= 0) fire('tg1U', `${t.und} reached T1 ${f(t.t1U)}`, `${t.und} is ${f(u)}. Consider booking ${lab}.`);
      if (t.t2U && b * (u - t.t2U) >= 0) fire('tg2U', `${t.und} reached T2 ${f(t.t2U)}`, `${t.und} is ${f(u)}. Consider exiting ${lab}.`);
    }
    timeRules();
    return ev;
    function timeRules() {
      if ((t.kind === 'OPT' || t.kind === 'FUT') && t.exp === now.day && now.mins >= 870) fire('expday', 'expires today', `${lab} expires today. Square off before the close (3:30 pm) or it settles${t.kind === 'OPT' ? ' (ITM options are cash-settled, OTM expire worthless)' : ''}.`);
      if (t.prod === 'INTRA' && now.mins >= 915 && now.mins < 930) fire('sqoff', 'square off (3:15 pm)', `${lab} is an intraday trade: close it before the broker auto-squares it off.`);
    }
  }

  // one pass: fetch live prices, update marks, run rules, fire alerts. Returns the open trades.
  Trades.tick = async function (o) {
    o = o || {}; const L = this.open(); if (!L.length || busy) return L;
    const now = ist(), live = marketOpen('IN');
    if (!live && !o.force) return L;
    busy = true;
    try {
      await prices(L); const fired = [];
      for (const t of L) {
        const lv = LIVE[t.id]; lv.fresh = live && lv.px > 0 && Date.now() - (lv.at || 0) < 20e3 && !lv.stale;
        if (live) fired.push(...rules(t, lv, now));
      }
      if (fired.length && window.Alerts) { for (const a of fired) Alerts.add(a); Alerts.flush(); }
      if (fired.length || L.some(t => t.trailed && !t._saved)) save();
      if (Date.now() - (Trades._saved || 0) > 30e3) { Trades._saved = Date.now(); save(); }
    } finally { busy = false; }
    if (Trades.onTick) try { Trades.onTick(L); } catch (e) {}
    return L;
  };
  Trades.check = async function () { try { return await Trades.tick(); } catch (e) { return []; } }; // for watchTick
  // background pass while the app is open in market hours
  setInterval(() => { if (Trades.open().length && marketOpen('IN')) Trades.check(); }, 15e3);

  // distances for the UI: progress between SL (0%) and T2/T1 (100%)
  Trades.progress = function (t, px) {
    const d = dirOf(t), sl = t.sl != null ? t.sl : t.sl0, tg = t.t2 || t.t1; if (!(px > 0) || sl == null || !tg) return null;
    const lo = d > 0 ? sl : tg, hi = d > 0 ? tg : sl; if (hi === lo) return null;
    const p = (d > 0 ? px - sl : sl - px) / Math.abs(tg - sl); return Math.max(0, Math.min(1, p));
  };
  Trades.ist = ist; Trades.dayDiff = dayDiff; Trades.num = num; Trades.fallbackKey = function (und, exp, strike, cp) {
    const ex = (window.S && S.fo && S.fo[und] && S.fo[und].ex) || 'NFO', yy = exp.slice(2, 4), m = MON[+exp.slice(5, 7) - 1];
    return `${ex}:${und}${yy}${m}${cp ? strike + cp : 'FUT'}`; // monthly-contract format; weekly contracts use a different code (so it is flagged "unverified")
  };
  window.Trades = Trades;
})();
