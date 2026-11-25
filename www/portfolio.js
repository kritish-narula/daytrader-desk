/* Portfolio: your holdings (stored on this phone, encrypted with the app PIN), CSV / paste / mStock import,
   and a recommendation for every holding — BUY MORE / HOLD / BOOK PARTIAL / TRIM / REDUCE / SELL — with stop,
   targets and when to act. Logic is pure where possible so it can be tested in Node. Not investment advice. */
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n').filter(l => l.trim()).slice(0, 15); // title lines first in many broker exports: use the busiest line
    const cnt = c => Math.max(0, ...lines.map(l => (l.match(new RegExp('\\' + c, 'g')) || []).length));
    const delim = [',', '\t', ';'].sort((a, b) => cnt(b) - cnt(a))[0];
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"') q = true; else if (ch === delim) { row.push(f); f = ''; } else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += ch;
    }
    if (f.length || row.length) { row.push(f); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
  }
  const num = v => { if (v == null) return NaN; const s = String(v).replace(/[₹$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'); return s === '' ? NaN : +s; };
  const H = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const COLS = {
    sym: ['symbol', 'tradingsymbol', 'instrument', 'scrip', 'scripname', 'ticker', 'stock', 'stocksymbol', 'scripcode', 'nsesymbol', 'nsecode', 'code'],
    name: ['stockname', 'companyname', 'name', 'security', 'securityname', 'company', 'scriptname', 'instrumentname'],
    isin: ['isin', 'isincode', 'isinno'],
    qty: ['qty', 'quantity', 'shares', 'units', 'netqty', 'holdingqty', 'availableqty', 'totalqty', 'qtyheld', 'noofshares', 'balance', 'freeqty', 'quantityavailable'],
    avg: ['avgcost', 'avgprice', 'averageprice', 'averagebuyprice', 'avgbuyprice', 'buyavg', 'buyprice', 'avg', 'costprice', 'purchaseprice', 'avgrate', 'averagecost', 'buyavgprice', 'avgtradedprice', 'buyrate'],
    date: ['buydate', 'date', 'purchasedate', 'tradedate', 'acquisitiondate'],
    ex: ['exchange', 'exch', 'market'],
  };
  const find = (hdr, keys) => { for (const k of keys) { const i = hdr.indexOf(k); if (i >= 0) return i; } for (const k of keys) { const i = hdr.findIndex(h => h.startsWith(k)); if (i >= 0) return i; } return -1; };
  // finds the header row (broker exports often have title lines first), maps columns, returns raw items
  function readTable(text) {
    const rows = parseCSV(text); if (!rows.length) return { items: [], format: 'empty' };
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      const hdr = rows[i].map(H), m = {}; for (const k in COLS) m[k] = find(hdr, COLS[k]);
      if ((m.sym >= 0 || m.name >= 0 || m.isin >= 0) && m.qty >= 0) { hi = i; map = m; break; }
    }
    if (hi < 0) { // no header: "SYMBOL QTY AVG [DATE]" lines (comma, tab or spaces)
      const items = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(/[\s,;\t]+/)).filter(p => p.length >= 2 && isFinite(num(p[1])))
        .map(p => ({ token: p[0], qty: num(p[1]), avg: num(p[2]), date: p[3] || '' }));
      return { items, format: 'Simple list (symbol qty avg)' };
    }
    const hdr = rows[hi].map(H).join(','), format = /avgcost/.test(hdr) && /instrument/.test(hdr) ? 'Zerodha Console' : /averagebuyprice/.test(hdr) && /stockname/.test(hdr) ? 'Groww' : /isin/.test(hdr) ? 'Broker export (with ISIN)' : 'CSV';
    const items = [];
    for (const r of rows.slice(hi + 1)) {
      const g = k => map[k] >= 0 ? r[map[k]] : '';
      const qty = num(g('qty')); if (!isFinite(qty) || qty <= 0) continue;
      const token = g('sym') || g('name'); if (!token && !g('isin')) continue;
      if (/^(total|grand total|net)/i.test(token)) continue;
      items.push({ token, name: map.sym >= 0 && map.name >= 0 ? g('name') : '', isin: g('isin'), qty, avg: num(g('avg')), date: g('date'), ex: g('ex') });
    }
    return { items, format };
  }

  // ---------- symbol resolution ----------
  const normName = s => String(s || '').toUpperCase().replace(/\b(LIMITED|LTD|THE|INC|CORP|CORPORATION|CO|COMPANY|INDIA|OF|AND)\b/g, '').replace(/&/g, '').replace(/[^A-Z0-9]/g, '');
  function makeResolver(eqList, usList) { // eqList: [[sym, name, isin]], usList: [[sym, name]]
    const bySym = new Map(), byIsin = new Map(), byName = [];
    for (const x of eqList || []) { bySym.set(x[0].toUpperCase(), x[0]); if (x[2]) byIsin.set(x[2].toUpperCase(), x[0]); byName.push([normName(x[1]), x[0], x[1]]); }
    const us = new Map((usList || []).map(x => [String(x[0]).toUpperCase(), x[0]]));
    return function resolve(it, mkt) {
      const clean = t => String(t || '').toUpperCase().trim().replace(/^(NSE|BSE|NASDAQ|NYSE)[:\s]+/, '').replace(/\.(NS|BO|NSE|BSE)$/, '').replace(/-(EQ|BE|BZ|SM|ST)$/, '').replace(/\s+/g, '');
      if (mkt === 'US') { const t = clean(it.token); return us.has(t) || /^[A-Z.]{1,6}$/.test(t) ? { sym: us.get(t) || t, how: 'symbol' } : { sym: null, guesses: [] }; }
      if (it.isin && byIsin.has(it.isin.toUpperCase())) return { sym: byIsin.get(it.isin.toUpperCase()), how: 'ISIN' };
      const t = clean(it.token);
      if (bySym.has(t)) return { sym: bySym.get(t), how: 'symbol' };
      const nn = normName(it.name || it.token); if (!nn) return { sym: null, guesses: [] };
      const exact = byName.filter(x => x[0] === nn); if (exact.length === 1) return { sym: exact[0][1], how: 'name' };
      const starts = byName.filter(x => x[0].startsWith(nn) || nn.startsWith(x[0]) && x[0].length >= 4);
      if (starts.length === 1) return { sym: starts[0][1], how: 'name' };
      const contains = starts.length ? starts : byName.filter(x => x[0].includes(nn.slice(0, Math.max(4, Math.floor(nn.length * 0.6)))));
      return { sym: null, guesses: contains.slice(0, 5).map(x => [x[1], x[2]]) };
    };
  }

  // ---------- recommendation ----------
  const rnd = (x, t = 0.05) => x == null || !isFinite(x) ? null : +(Math.round(x / t) * t).toFixed(2);
  /* h: {qty, avg}; q: Engine.quick result (+ R = {rating, action}); ctx: {weight %, open: bool, mkt, news: {s,n}, sectorW %}
     returns {act, tone, why[], stop, t1, t2, zone, sellQty, addQty, when, conf, pnlPct} */
  function advise(h, q, ctx = {}) {
    const px = q.price, H2 = q.horizons || {}, m = H2.medium || {}, l = H2.long || {}, s = H2.swing || {}, sh = H2.short || {};
    const pnlPct = h.avg > 0 ? (px / h.avg - 1) * 100 : 0, w = ctx.weight || 0, tick = ctx.mkt === 'US' ? 0.01 : 0.05, cur = ctx.mkt === 'US' ? '$' : '₹';
    const e20 = q.e20, e50 = q.e50, e200 = q.e200, atr = q.atr || px * 0.02;
    let stop = m.lvL && m.lvL.sl; if (!(stop < px)) stop = e50 && e50 < px ? e50 - 0.5 * atr : px - 2.5 * atr;
    if (pnlPct > 15 && e20 && e20 < px) stop = Math.max(stop, Math.min(e20 - 0.5 * atr, h.avg * 1.02)); // trail: protect the gain, at least breakeven+2%
    if (pnlPct > 40 && e20 < px) stop = Math.max(stop, e20 - 0.3 * atr);
    const prev = ctx.prevStop > 0 ? ctx.prevStop : null; // trailing: a stop only moves up (yours, or the last one we gave)
    if (prev && prev < px) stop = Math.max(stop, prev);
    stop = rnd(stop, tick);
    let t1 = m.lvL && m.lvL.t1 > px ? m.lvL.t1 : px + 2 * atr, t2 = (l.lvL && l.lvL.t1 > t1 ? l.lvL.t1 : null) || (m.lvL && m.lvL.t2 > t1 ? m.lvL.t2 : t1 + 2 * atr);
    t1 = rnd(t1, tick); t2 = rnd(t2, tick);
    const trendUp = e50 && e200 && px > e50 && e50 > e200, trendDown = e50 && e200 && px < e200 && e50 < e200;
    const bearPat = (q.chartPats || []).find(p => p.b < 0 && p.status !== 'forming'), bullSet = (q.setups || []).find(x => x.b > 0 && x.q >= 70);
    const news = ctx.news && ctx.news.n >= 2 ? ctx.news.s : 0, mS = m.score ?? 50, lS = l.score ?? 50, sS = s.score ?? 50;
    const why = [], add = t => why.push(t);
    let act = 'HOLD', tone = 'neutral', sellQty = 0, addQty = 0, conf = 'medium';

    if (prev && px <= prev) { act = 'SELL'; tone = 'bad'; sellQty = h.qty; stop = rnd(prev, tick); add(`Price ${cur}${px.toFixed(2)} broke the ${h.stop ? 'stop you set' : 'trailing stop'} ${cur}${stop}.`); conf = 'high'; }
    else if (trendDown && mS <= 40) { act = 'SELL'; tone = 'bad'; sellQty = h.qty; add(`Downtrend: below the 200-day average and the 50 is under the 200; medium-term score ${mS}.`); conf = lS <= 40 ? 'high' : 'medium'; }
    else if (pnlPct <= -15 && mS < 45 && lS < 50) { act = 'SELL'; tone = 'bad'; sellQty = h.qty; add(`Down ${Math.abs(pnlPct).toFixed(1)}% and the trend is weak (medium ${mS}, long ${lS}). Don't average down a weak stock.`); }
    else if (w > 25) { act = 'TRIM'; tone = 'warn'; sellQty = Math.max(1, Math.ceil(h.qty * (w - 20) / w)); add(`It is ${w.toFixed(0)}% of your portfolio. Trim to about 20% to limit single-stock risk.`); }
    else if (bearPat && mS < 55) { act = 'REDUCE'; tone = 'warn'; sellQty = Math.max(1, Math.floor(h.qty / 2)); add(`${bearPat.n} (${bearPat.status}) on the chart with a soft medium-term score ${mS}.`); }
    else if (pnlPct >= 25 && (sS <= 45 || q.rsi > 75)) { act = 'BOOK PARTIAL'; tone = 'warn'; sellQty = Math.max(1, Math.floor(h.qty / 3)); add(`Up ${pnlPct.toFixed(1)}% and short-term momentum is fading${q.rsi > 75 ? ` (RSI ${q.rsi.toFixed(0)} overbought)` : ` (swing score ${sS})`}. Lock in a third, trail the rest.`); }
    else if (mS >= 65 && lS >= 55 && trendUp && (px <= e20 * 1.03 || bullSet) && w < 15 && !(news < -0.4)) {
      act = 'BUY MORE'; tone = 'good'; const room = Math.max(0, (15 - w) / 100 * (ctx.total || 0)); addQty = Math.max(1, Math.floor(Math.min(room, (ctx.total || px * h.qty) * 0.05) / px));
      add(`Strong uptrend (medium ${mS}, long ${lS}) and price is near a good entry${bullSet ? ` — ${bullSet.n}` : ' (close to the 20-day average)'}.`); conf = mS >= 72 ? 'high' : 'medium';
    } else { act = 'HOLD'; tone = mS >= 55 ? 'good' : 'neutral'; add(mS >= 55 ? `Trend intact (medium ${mS}, long ${lS}). Let it run with the stop below.` : `No clear edge either way (medium ${mS}, long ${lS}). Hold, but respect the stop.`); }
    if (trendUp && act !== 'BUY MORE' && act !== 'SELL') add('Above the 50- and 200-day averages (uptrend).');
    if (news <= -0.4) add('Recent news is negative — watch closely.'); else if (news >= 0.5) add('Recent news is positive.');
    if (ctx.sectorW > 40) add(`Your ${ctx.sector || 'sector'} exposure is ${ctx.sectorW.toFixed(0)}% — concentrated.`);
    const zoneLo = rnd(Math.max(stop * 1.01, Math.min(e20 || px, px) - 0.3 * atr), tick), zoneHi = rnd(Math.min(px, (e20 || px) + 0.3 * atr), tick);
    const r1 = rnd(px + 0.8 * atr, tick);
    const next = ctx.open ? '' : 'Next session: ';
    const when = ctx.mkt === 'US'
      ? (act === 'SELL' ? `${next}sell after the first 30 min (10:00 ET) — or into a bounce toward $${r1}; don't hold through the close below $${stop}.` : act === 'BUY MORE' ? `${next}buy on a dip to $${zoneLo}–${zoneHi} (limit order) after 10:00 ET.` : sellQty ? `${next}sell ${sellQty} into strength near $${r1}; keep a stop at $${stop}.` : `Hold. Exit if a daily close is below $${stop}; book some near $${t1}.`)
      : (act === 'SELL' ? `${next}sell after 9:45 am (skip the opening swing). If it bounces toward ₹${r1}, sell into it; if it is still below ₹${stop} at 3:15 pm, exit.` : act === 'BUY MORE' ? `${next}add ${addQty} on a dip to ₹${zoneLo}–${zoneHi} with a limit order, or on a 15-min close above ₹${rnd(px + 0.2 * atr, tick)} after 9:45 am. Skip if it opens above ₹${rnd(px + atr, tick)}.` : sellQty ? `${next}sell ${sellQty} shares into strength near ₹${r1} (limit order after 9:45 am). Keep a stop at ₹${stop} for the rest.` : `Hold. Exit if a daily close is below ₹${stop}. Book a part near ₹${t1}.`);
    return { act, tone, why, stop, t1, t2, sellQty, addQty, when, conf, pnlPct, zone: [zoneLo, zoneHi], horizon: 'medium-term view (1–3 months), checked daily' };
  }

  const api = { parseCSV, readTable, makeResolver, advise, num };
  if (isNode) { module.exports = api; return; }

  // ---------- app side ----------
  const KEY = 'pf', LAST = 'pfLast';
  let pf = null;
  const load = () => { const v = window.Sec ? Sec.get(KEY) : JSON.parse(localStorage.getItem('dtd2_ms_' + KEY) || 'null'); return v && typeof v === 'object' ? { IN: v.IN || [], US: v.US || [] } : { IN: [], US: [] }; };
  const all = () => (pf = pf || load());
  const save = () => { window.Sec ? Sec.set(KEY, pf) : localStorage.setItem('dtd2_ms_' + KEY, JSON.stringify(pf)); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const resolver = mkt => makeResolver(mkt === 'US' ? [] : (S.nse && S.nse.eq) || window.SEED_IN || [], mkt === 'US' ? ((S.us && S.us.eq) || window.US_LIST || []) : []);
  const P = {
    list: mkt => all()[mkt || S.mkt],
    reload() { pf = null; return all(); },
    // mode: 'merge' (add qty, average the price) | 'replace' (overwrite this symbol)
    upsert(mkt, h, mode = 'merge') {
      const L = all()[mkt], ex = L.find(x => x.sym === h.sym);
      if (ex && mode === 'merge') { const q = ex.qty + h.qty; ex.avg = q > 0 && h.avg > 0 && ex.avg > 0 ? (ex.avg * ex.qty + h.avg * h.qty) / q : ex.avg || h.avg; ex.qty = q; if (h.date && (!ex.date || h.date < ex.date)) ex.date = h.date; }
      else if (ex) Object.assign(ex, h, { id: ex.id });
      else L.push(Object.assign({ id: uid(), added: Date.now() }, h));
      save();
    },
    update(mkt, id, patch) { const h = all()[mkt].find(x => x.id === id); if (h) { Object.assign(h, patch); save(); } },
    remove(mkt, id) { const L = all()[mkt]; const i = L.findIndex(x => x.id === id); if (i >= 0) { L.splice(i, 1); save(); } },
    clear(mkt) { all()[mkt] = []; save(); },
    importText(text, mkt) { const t = readTable(text), res = resolver(mkt); return { format: t.format, items: t.items.map(it => Object.assign(it, res(it, mkt))) }; },
    apply(mkt, items, mode) { // mode: merge | replace-all | new-only
      if (mode === 'replace-all') all()[mkt] = [];
      let n = 0; for (const it of items) { if (!it.sym || !(it.qty > 0)) continue; if (mode === 'new-only' && all()[mkt].some(x => x.sym === it.sym)) continue;
        P.upsert(mkt, { sym: it.sym, qty: it.qty, avg: isFinite(it.avg) ? it.avg : 0, date: it.date || '', src: it.src || 'csv' }, mode === 'replace-all' ? 'replace' : 'merge'); n++; }
      save(); return n;
    },
    toCSV(mkt) { return 'symbol,qty,avg_price,buy_date,note\n' + all()[mkt].map(h => [h.sym, h.qty, h.avg, h.date || '', (h.note || '').replace(/[,\n]/g, ' ')].join(',')).join('\n'); },
    template: 'symbol,qty,avg_price,buy_date\nRELIANCE,10,2450.50,2025-01-15\nTCS,5,3820,2024-11-02\nHDFCBANK,20,1610.25,\n',
    resolve: (tok, mkt) => resolver(mkt)({ token: tok }, mkt),

    // analyse every holding with the same engine as the scanner; returns {rows, sum}
    async refresh(mkt, onRow) {
      const L = all()[mkt]; if (!L.length) return { rows: [], sum: null };
      await regime(mkt); const syms = [...new Set(L.map(h => h.sym))], Q = await msQuotes(syms, mkt), out = {};
      await pool(syms, 4, async sym => { try { out[sym] = await dailyQuick(sym, mkt, Q); } catch (e) { out[sym] = { err: e.message }; } onRow && onRow(sym, out[sym]); });
      const cat = catOf(mkt), rows = L.map(h => { const q = out[h.sym] || {}; const px = q.price || 0; return { h, q, px, val: px * h.qty, cost: h.avg * h.qty, day: q.chg != null && px ? h.qty * px * q.chg / (100 + q.chg) : 0, sector: (cat[h.sym] || [])[1] || 'Other' }; });
      const total = rows.reduce((a, r) => a + r.val, 0), cost = rows.reduce((a, r) => a + (r.h.avg > 0 ? r.cost : r.val), 0), day = rows.reduce((a, r) => a + r.day, 0);
      const secW = {}; for (const r of rows) secW[r.sector] = (secW[r.sector] || 0) + (total ? 100 * r.val / total : 0);
      const open = marketOpen(mkt);
      for (const r of rows) {
        r.w = total ? 100 * r.val / total : 0;
        if (r.q.err || !r.px) { r.rec = null; continue; }
        const R = rateRow(Object.assign({ sym: r.h.sym }, r.q), mkt); r.R = R;
        const ls = (store.get(LAST, {})[mkt + ':' + r.h.sym] || {}).stop;
        r.rec = advise(r.h, r.q, { prevStop: r.h.stop || ls, weight: r.w, total, open, mkt, news: newsOf(mkt, r.h.sym), sector: r.sector, sectorW: secW[r.sector] });
      }
      const betas = rows.filter(r => r.q.risk && isFinite(r.q.risk.beta)), beta = betas.length ? betas.reduce((a, r) => a + r.q.risk.beta * r.w, 0) / betas.reduce((a, r) => a + r.w, 0) : null;
      const sum = { total, cost, pnl: total - cost, pnlPct: cost ? (total / cost - 1) * 100 : 0, day, dayPct: total - day ? 100 * day / (total - day) : 0, n: rows.length, beta, secW, at: Date.now(),
        actions: rows.filter(r => r.rec && r.rec.act !== 'HOLD').length, sells: rows.filter(r => r.rec && /SELL|TRIM|REDUCE|BOOK/.test(r.rec.act)).length };
      S.pf = S.pf || {}; S.pf[mkt] = { rows, sum };
      try { store.set('pfSum', Object.assign(store.get('pfSum', {}), { [mkt]: { total, pnl: sum.pnl, pnlPct: sum.pnlPct, day, dayPct: sum.dayPct, n: sum.n, actions: sum.actions, sells: sum.sells, at: sum.at } })); } catch (e) {}
      return S.pf[mkt];
    },
    // background check: alert when a holding's advice changes or the stop/target is hit
    async check(mkt) {
      if (!all()[mkt].length) return;
      const { rows } = await P.refresh(mkt), last = store.get(LAST, {}), cur = mkt === 'US' ? '$' : '₹';
      for (const r of rows) {
        if (!r.rec || !window.Alerts || !Alerts.add) continue;
        const k = mkt + ':' + r.h.sym, prev = last[k];
        if (prev && prev.act !== r.rec.act && r.rec.act !== 'HOLD') Alerts.add({ sym: r.h.sym, mkt, kind: 'pf:' + r.rec.act, title: `💼 ${r.h.sym}: ${r.rec.act}${r.rec.sellQty ? ' ' + r.rec.sellQty : r.rec.addQty ? ' +' + r.rec.addQty : ''}`, body: `${r.rec.why[0]} ${r.rec.when}` });
        if (prev && prev.px > prev.stop && r.px <= r.rec.stop) Alerts.add({ sym: r.h.sym, mkt, kind: 'pf:stop', title: `💼 ${r.h.sym} hit your stop ${cur}${r.rec.stop}`, body: `Now ${cur}${r.px.toFixed(2)}. ${r.rec.when}` });
        if (prev && prev.px < prev.t1 && r.px >= prev.t1) Alerts.add({ sym: r.h.sym, mkt, kind: 'pf:t1', title: `💼 ${r.h.sym} reached target ${cur}${prev.t1}`, body: `Consider booking part. New stop ${cur}${r.rec.stop}.` });
        last[k] = { act: r.rec.act, px: r.px, stop: r.rec.stop, t1: r.rec.t1, at: Date.now() };
      }
      store.set(LAST, last); Alerts.save && Alerts.save(); Alerts.flush && Alerts.flush(); window.updBell && updBell();
    },
    async fromMStock() { const rows = await MS.holdings(), res = resolver('IN'); return rows.map(x => Object.assign({ token: x.sym, isin: x.isin, qty: x.qty, avg: x.avg, src: 'mStock' }, res({ token: x.sym, isin: x.isin }, 'IN'))); },
  };
  window.Portfolio = P;
  // keep checking while the app is open (every 10 min in market hours); the background watch also calls check()
  setInterval(() => { for (const m of ['IN', 'US']) if (marketOpen(m) && all()[m].length && !S.scanning) P.check(m).catch(() => {}); }, 10 * 60e3);
  Object.assign(P, api);
})(typeof window !== 'undefined' ? window : globalThis);
