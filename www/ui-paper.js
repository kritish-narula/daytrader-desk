/* Paper-trading league screen (vPaper), Home card (paperCardHTML / bindPaperCard) and the on-device live session.
   Data: data/paper.json + data/paper_history.json written by GitHub Actions (tools/paper.js) after every NSE close.
   With mStock connected and the market open, open trades are marked to live prices; F&O trades opened today also get a
   "live premium" twin on this phone (the real premium the first time the app sees the trade). Paper only: no orders. */
(function () {
  'use strict';
  const BASE = 'https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/data/';
  const PP = { data: store.get('paperData', null), hist: store.get('paperHist', null), at: store.get('paperAt', 0), hAt: store.get('paperHAt', 0), err: null, live: {}, liveAt: 0, loading: null };
  const twins = () => store.get('paperLive', {});
  const inr = (x, d = 0) => x == null || !isFinite(x) ? '–' : '₹' + (+x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sgn = (x, d = 0, pre = '') => x == null || !isFinite(x) ? '–' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : '−'}${pre}${Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}</span>`;
  const pc = (x, d = 1) => x == null || !isFinite(x) ? '–' : sgn(x, d) + '<span class="mu">%</span>';
  const stCls = s => ({ Promoted: 'pro', Watch: 'wat', Demoted: 'dem', Benchmark: 'ben' }[s] || 'new');
  const badge = s => `<span class="pp-b ${stCls(s)}">${esc(s || 'New')}</span>`;
  const istNow = () => new Date(Date.now() + 19800e3);
  const todayIST = () => istNow().toISOString().slice(0, 10);
  const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const segOf = t => (t.seg === 'EQ' ? 'EQ' : 'FNO');
  const nameOfS = id => { const r = PP.data && PP.data.strategies.find(s => s.id === id); return r ? r.short : id; };

  // ---------- data ----------
  async function getJ(file) { const r = await fetch(BASE + file + '?t=' + Math.floor(Date.now() / 300000), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status === 404 ? 'not published yet' : 'HTTP ' + r.status); return r.json(); }
  async function load(force) {
    if (!force && PP.data && Date.now() - PP.at < 15 * 60e3) return PP.data;
    if (PP.loading) return PP.loading;
    PP.loading = (async () => {
      try { const j = await getJ('paper.json'); if (!j || j.v !== 1 || !Array.isArray(j.strategies)) throw new Error('bad file'); PP.data = j; PP.at = Date.now(); PP.err = null; store.set('paperData', j); store.set('paperAt', PP.at); }
      catch (e) { PP.err = e.message; }
      finally { PP.loading = null; }
      return PP.data;
    })();
    return PP.loading;
  }
  async function loadHist() {
    if (PP.hist && PP.data && PP.hist.days && PP.hist.days[PP.hist.days.length - 1] === PP.data.asOf) return PP.hist;
    try { const h = await getJ('paper_history.json'); PP.hist = h; PP.hAt = Date.now(); store.set('paperHist', h); store.set('paperHAt', PP.hAt); } catch (e) {}
    return PP.hist;
  }
  window.paperData = () => PP.data;
  // today's signals from promoted strategies for a symbol (hook for the stock page / scanner tags)
  window.paperSignalsFor = sym => ((PP.data && PP.data.leaders && PP.data.leaders.signals) || []).filter(x => x.sym === sym);

  // ---------- live session (mStock, while the app is open) ----------
  const liveOn = () => !!(window.MS && MS.ok && MS.ok() && marketOpen('IN'));
  async function optKey(t) {
    const o = t.opt; for (let n = 0; n < 4; n++) { const c = await MS.option(o.und, o.k, o.cp, n).catch(() => null); if (!c) return null; if (c.exp === o.exp && Math.abs(c.strike - o.k) < 1e-6) return c; if (c.exp > o.exp) return null; } return null;
  }
  async function refreshLive(trades) {
    if (!liveOn() || !trades.length) return false;
    const eq = [...new Set(trades.filter(t => t.seg === 'EQ' || t.seg === 'FUT').map(t => t.sym).filter(s => s !== 'NIFTY'))].slice(0, 40);
    try { if (eq.length) { const q = await MS.quotes(eq); for (const s of eq) if (q[s] && q[s].last_price) PP.live[s] = +q[s].last_price; } } catch (e) {}
    const opts = trades.filter(t => t.seg === 'OPT').slice(0, 12), keys = {};
    for (const t of opts) { const c = await optKey(t).catch(() => null); if (c) keys[t.id] = c.k; }
    try {
      const ks = Object.values(keys); if (ks.length) { const q = await MS.ltp(ks); for (const t of opts) if (keys[t.id] && q[keys[t.id]] != null) PP.live[t.id] = +q[keys[t.id]]; }
    } catch (e) {}
    // live-premium twins: F&O paper trades opened today get the REAL premium the first time this phone sees them
    const T = twins(), today = todayIST();
    for (const t of opts) { const p = PP.live[t.id]; if (p == null) continue; const w = T[t.id];
      if (!w && t.d0 === today) T[t.id] = { id: t.id, s: t.s, und: t.opt.und, k: t.opt.k, cp: t.opt.cp, exp: t.opt.exp, qty: t.q0, prem0: p, at: Date.now(), last: p, lastAt: Date.now() };
      else if (w && !w.closed) { w.last = p; w.lastAt = Date.now(); } }
    const openIds = new Set((PP.data.open || []).map(t => t.id));
    for (const id in T) if (!T[id].closed && !openIds.has(id)) { const c = (PP.data.closed || []).find(t => t.id === id); if (c) { T[id].closed = Date.now(); T[id].exitWhy = c.exitWhy; } }
    const keep = Object.values(T).sort((a, b) => b.at - a.at).slice(0, 60); store.set('paperLive', Object.fromEntries(keep.map(w => [w.id, w])));
    PP.liveAt = Date.now(); return true;
  }
  const livePx = t => t.seg === 'OPT' ? PP.live[t.id] : PP.live[t.sym];

  // ---------- pieces ----------
  function fresh(d) {
    if (!d) return '';
    const upd = d.updated ? new Date(d.updated) : null, ageH = upd ? (Date.now() - upd) / 36e5 : 99;
    return `<div class="pp-fresh ${ageH > 80 ? 'old' : ''}">Updated ${esc(d.updatedIST || '')} from CI · sessions up to <b>${esc(d.asOf)}</b>${d.liveFrom ? ` · live-forward since <b>${esc(d.liveFrom)}</b>` : ''}${ageH > 80 ? ' · <b>stale</b>: the daily job may have failed' : ''}</div>`;
  }
  function statLine(x, r) {
    const a = x.all, live = x.live.n, bf = x.bf.n;
    return `<span>${a.n} trades${bf ? ` <i class="mu">(${live} live · ${bf} backfill)</i>` : ''}</span><span>win ${a.win == null ? '–' : a.win + '%'}</span><span>exp ${a.avgR == null ? '–' : (a.avgR >= 0 ? '+' : '') + a.avgR + 'R'}${a.exp != null ? ` <i class="mu">${a.exp < 0 ? '−' : ''}${inr(Math.abs(a.exp))}</i>` : ''}</span><span>DD ${a.mdd == null ? '–' : a.mdd + '%'}</span>${a.pf != null ? `<span>PF ${a.pf}</span>` : ''}${r.openN ? `<span>${r.openN} open</span>` : ''}`;
  }
  function leagueRow(r, d) {
    const a = r.stats.all, bench = r.kind === 'bench';
    return `<div class="pp-row" data-id="${r.id}"><div class="pp-r1"><span class="pp-rk">${bench ? '—' : r.rank ? '#' + r.rank : '·'}</span><span class="pp-n">${esc(r.short)}</span>${badge(r.status)}<span class="pp-ret">${pc(a.ret)}</span></div>
      <div class="pp-r2">${bench ? `<span>Nifty 50 since ${esc(d.start)}</span><span>DD ${a.mdd == null ? '–' : a.mdd + '%'}</span>` : statLine(r.stats, r)}</div>${a.n && a.n < d.minTrades && !bench ? `<div class="pp-small">Small sample: needs ${d.minTrades}+ closed trades to be ranked.</div>` : ''}</div>`;
  }
  function tradeLine(t, d, opts = {}) {
    const S0 = nameOfS(t.s), dir = t.seg === 'IC' ? 'SELL' : t.b > 0 ? (t.seg === 'OPT' ? 'BUY' : 'LONG') : (t.seg === 'FUT' ? 'SHORT' : 'SELL');
    const inst = t.seg === 'OPT' ? `${t.opt.und} ${t.opt.k} ${t.opt.cp} <span class="mu">exp ${esc(t.opt.exp.slice(5))}</span>` : t.seg === 'IC' ? `${t.und || 'NIFTY'} iron condor <span class="mu">exp ${esc((t.exp || '').slice(5))}</span>` : `${esc(t.sym)}${t.seg === 'FUT' ? ' FUT' : ''}`;
    const closed = t.d1 != null, lp = !closed ? livePx(t) : null, livePnl = lp != null ? Paper.livePnl(t, lp) : null;
    const unreal = !closed && t.mark != null ? Paper.unreal(t) : null;
    const premTag = t.seg === 'OPT' || t.seg === 'IC' ? '<span class="pp-tag sim">simulated premium</span>' : '';
    const W = t.seg === 'OPT' ? twins()[t.id] : null;
    const twin = W ? `<div class="pp-twin"><span class="pp-tag live">live premium</span> opened ${inr(W.prem0, 2)} at ${hhmm(W.at)} on this phone → ${inr(W.last, 2)} (${hhmm(W.lastAt)}) · ${sgn((W.last - W.prem0) * W.qty, 0, '₹')}${W.closed ? ' · closed with the CI trade' : ''}</div>` : '';
    const lv = t.seg === 'IC' ? `credit ${inr(t.credit, 2)} · max loss ${inr(t.risk)}` : `${t.seg === 'OPT' ? `prem ${inr(t.px0, 2)} · ` : ''}E ${fmtP(t.u0)} · SL ${fmtP(t.stop)}${t.stop !== t.stop0 ? ' (moved to entry)' : ''} · T1 ${fmtP(t.t1)} · T2 ${fmtP(t.t2)}`;
    return `<div class="pp-t ${closed ? (t.pnl >= 0 ? 'w' : 'l') : ''}"><div class="pp-t1"><b class="${t.b > 0 ? 'up' : t.b < 0 ? 'dn' : 'wa'}">${dir}</b> ${inst}${opts.showS ? ` <span class="pp-s">${esc(S0)}${t.src ? ' ← ' + esc(nameOfS(t.src)) : ''}</span>` : ''}${t.bf ? '<span class="pp-tag bf">backfill</span>' : ''}${premTag}
      <span class="pp-pl">${closed ? sgn(t.pnl, 0, '₹') + ` <i class="mu">${t.R >= 0 ? '+' : ''}${t.R}R</i>` : livePnl != null ? sgn(livePnl, 0, '₹') + ' <span class="pp-tag live">live</span>' : unreal != null ? sgn(unreal, 0, '₹') + ' <i class="mu">at close</i>' : ''}</span></div>
      <div class="pp-t2">${esc(t.d0)}${closed ? ' → ' + esc(t.d1) + ' · ' + esc(t.exitWhy) : ` · held ${t.held} of ${t.hold > 1e6 ? '∞' : t.hold}`} · qty ${t.q0 != null ? (+t.q0).toLocaleString('en-IN') : ''}${t.lots ? ` (${t.lots} lot${t.lots > 1 ? 's' : ''})` : ''}</div>
      <div class="pp-t2">${lv}</div>${t.why ? `<div class="pp-t2 mu">${esc(t.why)}</div>` : ''}${twin}</div>`;
  }
  const fmtP = x => x == null || !isFinite(x) ? '–' : (+x).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  function orderLine(o) {
    const inst = o.seg === 'OPT' ? `${o.opt.und} ${o.opt.k} ${o.opt.cp} <span class="mu">exp ${esc(o.opt.exp.slice(5))} · ${esc((o.opt.pick || '').toUpperCase())}</span>` : o.seg === 'IC' ? `NIFTY iron condor <span class="mu">exp ${esc((o.exp || '').slice(5))}</span>` : `${esc(o.sym)}${o.seg === 'FUT' ? ' FUT' : ''}`;
    const how = o.type === 'open' ? 'at the open' : o.type === 'stop' ? `buy-stop ${fmtP(o.entry)}` : `limit ${fmtP(o.entry)}`;
    return `<div class="pp-t"><div class="pp-t1"><b class="${o.b > 0 ? 'up' : o.b < 0 ? 'dn' : 'wa'}">${o.seg === 'IC' ? 'SELL' : o.b > 0 ? 'BUY' : 'SHORT'}</b> ${inst} <span class="pp-s">${esc(nameOfS(o.s))}${o.src ? ' ← ' + esc(nameOfS(o.src)) : ''}</span></div>
      <div class="pp-t2">Next session, ${how}${o.seg === 'IC' ? '' : ` · SL ${fmtP(o.stop)} · T1 ${fmtP(o.t1)}`}</div><div class="pp-t2 mu">${esc(o.why || '')}</div></div>`;
  }

  // ---------- main screen ----------
  window.vPaper = function () {
    const d = PP.data, seg = S.paperSeg || 'EQ';
    if (S.paperSel && d && d.strategies.some(s => s.id === S.paperSel)) return vStrat(S.paperSel);
    const V = $('#view');
    if (!d) {
      const msg = e => `No league data yet (${esc(e)}). It appears after the first run of the GitHub job "Paper-trading league" (every trading day after 4:15 PM IST).`;
      V.innerHTML = `<div class="dh"><div class="t"><div class="s">📒 Paper league</div><div class="f">Strategies paper-trade every day; the best get promoted</div></div></div>
        <div class="card"><div class="empty" id="ppEmpty"><span class="spin"></span> Loading the paper league…</div></div>`;
      load(true).then(x => { if (S.tab !== 'paper') return; if (x) vPaper(); else { const e = $('#ppEmpty'); if (e) e.textContent = msg(PP.err || 'unknown error'); } });
      return;
    }
    const rows = d.strategies.filter(s => s.seg === seg), ranked = rows.filter(r => r.rank).sort((a, b) => a.rank - b.rank), rest = rows.filter(r => !r.rank && r.kind !== 'bench'), bench = rows.filter(r => r.kind === 'bench');
    const best = ranked.find(r => r.status === 'Promoted') || ranked[0];
    const todayOpen = [...d.open, ...d.closed].filter(t => t.d0 === d.asOf && segOf(t) === seg), orders = d.pending.filter(o => (o.seg === 'EQ' ? 'EQ' : 'FNO') === seg);
    const open = d.open.filter(t => segOf(t) === seg && t.s !== 'nifty_bh');
    const leaders = (d.leaders || {})[seg] || [];
    V.innerHTML = `<div class="dh"><div class="t"><div class="s">📒 Paper league</div><div class="f">Each strategy trades a paper account by fixed rules; the league re-grades itself every week</div></div><button class="btn sm" id="ppRef">↻</button></div>
      ${fresh(d)}
      <div class="chips" id="ppSeg"><button class="chip ${seg === 'EQ' ? 'on' : ''}" data-s="EQ">Equity</button><button class="chip ${seg === 'FNO' ? 'on' : ''}" data-s="FNO">F&amp;O</button></div>
      <div class="pp-warn">Paper results, not real trades. ${seg === 'FNO' ? 'Option premiums are <b>simulated</b> (Black-Scholes on India VIX) unless marked <b>live premium</b>. ' : ''}<b>Backfill</b> = replay of past sessions; only <b>live-forward</b> results are a fair test. Past results don't guarantee future returns.</div>
      ${best ? `<div class="card pp-hero"><div class="mu">Best ${seg === 'EQ' ? 'equity' : 'F&O'} strategy right now</div><div class="pp-hn">${esc(best.name)} ${badge(best.status)}</div><div class="pp-r2">${statLine(best.stats, best)}</div><div class="pp-hr">Return ${pc(best.stats.all.ret)} on ${inr(best.cap)} paper capital${bench[0] ? ` · Nifty buy &amp; hold ${pc(bench[0].stats.all.ret)}` : ''}</div></div>` : ''}
      <h3>League table</h3><div class="pp-fresh">Each strategy has its own paper account: ${seg === 'EQ' ? `₹${(d.capital.EQ / 1e5).toFixed(0)} lakh` : `₹${(d.capital.FNO / 1e5).toFixed(0)} lakh (stock futures ₹${((d.futCapital || 2e6) / 1e5).toFixed(0)} lakh)`}.</div>
      <div class="card pp-league">${[...ranked, ...rest, ...bench].map(r => leagueRow(r, d)).join('') || '<div class="empty">No strategies</div>'}
        <div class="note">Ranked by <b>score</b> = expectancy (R, shrunk toward 0 for small samples) × √trades ÷ drawdown penalty. Tap a strategy for its rules, equity curve and trades.</div></div>
      <h3>Today's paper trades <span class="mu">· ${esc(d.asOf)}</span></h3>
      <div class="card">${todayOpen.length ? todayOpen.map(t => tradeLine(t, d, { showS: 1 })).join('') : '<div class="note">No new fills on the last session.</div>'}
        ${orders.length ? `<div class="pp-sub">Orders for the next session (${orders.length})</div>${orders.slice(0, 12).map(orderLine).join('')}${orders.length > 12 ? `<div class="note">+${orders.length - 12} more: open a strategy to see all its orders</div>` : ''}` : ''}</div>
      ${leaders.length ? `<div class="note" style="padding:0 4px">Promoted: ${leaders.map(id => esc(nameOfS(id))).join(', ')}. Their signals are highlighted on Home.</div>` : ''}
      <h3>Open positions <span class="mu">· ${open.length}</span> <span id="ppLive" class="mu"></span></h3>
      <div class="card" id="ppOpen">${openHTML(open, d)}</div>
      ${seg === 'FNO' ? twinsHTML() : ''}
      <h3>Weekly reviews</h3><div class="card">${(d.reviews || []).slice(0, 8).map(rv => `<div class="pp-rv"><b>${esc(rv.d)}</b>${rv.bf ? ' <span class="pp-tag bf">backfill</span>' : ''} ${rv.changes.filter(c => (Paper.byId[c.id] || {}).seg === seg).map(c => `<div>${esc(nameOfS(c.id))}: ${badge(c.from)} → ${badge(c.to)} <span class="mu">${esc(c.why)}</span></div>`).join('') || '<span class="mu">no changes</span>'}</div>`).join('') || '<div class="note">The first review runs on the last session of the week.</div>'}
        <div class="note">Every week each strategy is re-graded. <b>Promoted</b>: positive shrunk expectancy, profit factor ≥ 1.2 and still working in its last 20 trades, for two reviews in a row. <b>Demoted</b>: losing or profit factor &lt; 0.9 — it keeps paper-trading so it can recover. The "Best-of league" strategy trades only promoted signals, so its result tests the selection itself.</div></div>
      <div class="note pp-notes">${(d.notes || []).map(n => `<p>${esc(n)}</p>`).join('')}<p>${esc(d.source || '')} · universe ${d.universe || '–'} stocks.</p></div>`;
    $('#ppRef').onclick = async e => { e.target.disabled = true; e.target.textContent = '…'; await load(true); vPaper(); };
    document.querySelectorAll('#ppSeg .chip').forEach(b => b.onclick = () => { S.paperSeg = b.dataset.s; vPaper(); });
    document.querySelectorAll('.pp-row[data-id]').forEach(r => r.onclick = () => { S.paperSel = r.dataset.id; vPaper(); });
    bindMore();
    liveLoop(open);
    if (Date.now() - PP.at > 15 * 60e3) load().then(x => { if (x && S.tab === 'paper' && !S.paperSel && x.updated !== d.updated) vPaper(); });
  };
  // open positions: newest first, 12 shown until "show all"
  function openHTML(open, d) {
    if (!open.length) return '<div class="note">No open paper positions.</div>';
    const L = open.slice().sort((a, b) => (b.d0 > a.d0) - (b.d0 < a.d0)), all = S.paperAllOpen;
    return L.slice(0, all ? 500 : 12).map(t => tradeLine(t, d, { showS: 1 })).join('') + (L.length > 12 && !all ? `<button class="btn sm" id="ppMore">Show all ${L.length}</button>` : '');
  }
  function bindMore() { const b = $('#ppMore'); if (b) b.onclick = () => { S.paperAllOpen = true; const box = $('#ppOpen'); if (box) box.innerHTML = openHTML(PP.data.open.filter(t => segOf(t) === (S.paperSeg || 'EQ') && t.s !== 'nifty_bh'), PP.data); }; }
  function twinsHTML() {
    const W = Object.values(twins()).sort((a, b) => b.at - a.at).slice(0, 10); if (!W.length) return '';
    return `<h3>Live-premium twins <span class="mu">· this phone</span></h3><div class="card">${W.map(w => `<div class="pp-t"><div class="pp-t1"><b class="up">BUY</b> ${esc(w.und)} ${w.k} ${esc(w.cp)} <span class="mu">exp ${esc(w.exp.slice(5))}</span> <span class="pp-tag live">live premium</span><span class="pp-pl">${sgn((w.last - w.prem0) * w.qty, 0, '₹')}</span></div>
      <div class="pp-t2">${inr(w.prem0, 2)} at ${new Date(w.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} → ${inr(w.last, 2)} (${hhmm(w.lastAt)})${w.closed ? ' · closed with the CI trade' + (w.exitWhy ? ' (' + esc(w.exitWhy) + ')' : '') + ' at the last premium this phone saw' : ''}</div></div>`).join('')}
      <div class="note">When the app is open during market hours with mStock connected, each F&amp;O paper trade opened that day is recorded with the <b>real</b> premium (mStock LTP) the first time the app sees it. Exits use the last premium seen in the app, so they can differ from the simulated CI exit.</div></div>`;
  }
  function liveLoop(open) {
    if (!liveOn() || !open.length) return;
    const tick = async () => { if (S.tab !== 'paper') return; const el = $('#ppLive'); if (el) el.textContent = '· updating live…'; const okk = await refreshLive(open); if (S.tab !== 'paper') return; const box = $('#ppOpen'); if (box && okk) { if (box.dataset.list === 'strat') box.innerHTML = open.map(t => tradeLine(t, PP.data)).join(''); else { box.innerHTML = openHTML(open, PP.data); bindMore(); } } const el2 = $('#ppLive'); if (el2) el2.innerHTML = okk ? `<span class="livepill">mStock ${hhmm(PP.liveAt)}</span>` : ''; };
    tick(); clearInterval(S.timer); S.timer = setInterval(tick, 60000);
  }

  // ---------- one strategy ----------
  function vStrat(id) {
    const d = PP.data, r = d.strategies.find(s => s.id === id), V = $('#view'), x = r.stats;
    const open = d.open.filter(t => t.s === id), closed = d.closed.filter(t => t.s === id), pend = d.pending.filter(o => o.s === id);
    const sk = Object.entries(r.skipped || {}).sort((a, b) => b[1] - a[1]);
    const cell = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
    const grid = (a, t) => `<div class="pp-sub">${t}</div><div class="pp-g">${cell('Trades', a.n)}${cell('Win rate', a.win == null ? '–' : a.win + '%')}${cell('Avg R', a.avgR == null ? '–' : (a.avgR >= 0 ? '+' : '') + a.avgR)}${cell('Expectancy', a.exp == null ? '–' : sgn(a.exp, 0, '₹'))}${cell('Profit factor', a.pf == null ? '–' : a.pf)}${cell('Net P&L', a.pnl == null ? '–' : sgn(a.pnl, 0, '₹'))}${a.ret != null ? cell('Return', pc(a.ret)) + cell('Max drawdown', a.mdd + '%') + cell('Sharpe', a.sharpe == null ? '–' : a.sharpe) + cell('CAGR-ish', a.cagr == null ? '–' : pc(a.cagr)) : ''}${a.form ? cell('Last 20', `<span class="pp-form">${a.form.split('').map(c => `<i class="${c === 'W' ? 'w' : 'l'}"></i>`).join('')}</span>`) : ''}</div>`;
    V.innerHTML = `<div class="dh"><button class="back" id="ppBack">←</button><div class="t"><div class="s">${esc(r.name)}</div><div class="f">${badge(r.status)} ${esc(r.statusWhy || '')}${r.since ? ` · since ${esc(r.since)}` : ''}</div></div></div>
      ${fresh(d)}
      <div class="card"><div class="pp-sub">Rules (fixed)</div><ul class="pp-rules">${r.rules.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
      <div class="card"><div class="pp-sub">Equity curve <span class="mu">· ${inr(r.cap)} paper account · <span class="pp-key bf"></span>backfill <span class="pp-key lv"></span>live-forward</span></div><div id="ppChart" class="pp-chart"><span class="spin"></span></div>
        <div class="pp-hr">Now ${inr(r.eq)} (${pc((r.eq / r.cap - 1) * 100)})${r.unreal ? ` · open P&amp;L at last close ${sgn(r.unreal, 0, '₹')}` : ''}</div></div>
      <div class="card">${grid(x.all, 'All closed trades')}${x.bf.n ? grid(x.live, 'Live-forward only') + grid(x.bf, 'Backfilled only') : ''}
        ${x.all.n < d.minTrades ? `<div class="pp-warn">Small sample (${x.all.n} trades): not ranked until ${d.minTrades}+. A few lucky or unlucky trades can swing these numbers a lot.</div>` : ''}</div>
      <h3>Open <span class="mu">· ${open.length}</span>${pend.length ? ` <span class="mu">· ${pend.length} orders for the next session</span>` : ''}</h3>
      <div class="card"><div id="ppOpen" data-list="strat">${open.map(t => tradeLine(t, d)).join('') || '<div class="note">No open trades.</div>'}</div>${pend.map(orderLine).join('')}</div>
      <h3>Recent closed <span class="mu">· last 90 days</span></h3><div class="card">${closed.slice(0, 40).map(t => tradeLine(t, d)).join('') || '<div class="note">No closed trades yet.</div>'}</div>
      ${sk.length ? `<div class="card"><div class="pp-sub">Signals not taken</div>${sk.map(([k, n]) => `<div class="pp-t2">${n} × ${esc(k)}</div>`).join('')}</div>` : ''}
      <div class="note pp-notes"><p>Paper results with simulated fills on daily bars. Past results don't guarantee future returns.</p></div>`;
    $('#ppBack').onclick = () => { S.paperSel = null; vPaper(); };
    loadHist().then(h => drawCurve(h, id, d));
    liveLoop(open);
  }
  function drawCurve(h, id, d) {
    const el = $('#ppChart'); if (!el) return;
    if (!h || !h.eq || !h.eq[id] || !window.LightweightCharts) { el.innerHTML = '<div class="note">Equity curve not available yet.</div>'; return; }
    el.innerHTML = '';
    const css = getComputedStyle(document.documentElement), col = n => (css.getPropertyValue(n) || '').trim();
    const ch = LightweightCharts.createChart(el, { autoSize: true, height: 200, layout: { background: { color: 'transparent' }, textColor: col('--text2') || '#8a97a6', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: col('--line') || '#1e2935' } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false }, handleScroll: false, handleScale: false, crosshair: { mode: 0 },
      localization: { priceFormatter: v => '₹' + (Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(2) + 'L' : (v / 1e3).toFixed(1) + 'k') } });
    const bfU = h.bfUntil || d.backfillUntil, pts = h.days.map((t, k) => ({ time: t, value: h.eq[id][k] })).filter(p => p.value != null);
    const bf = pts.filter(p => !bfU || p.time <= bfU), lv = pts.filter(p => bfU && p.time >= bfU);
    ch.addLineSeries({ color: '#7d8796', lineWidth: 2, priceLineVisible: false, lastValueVisible: !lv.length }).setData(bf);
    if (lv.length > 1) ch.addLineSeries({ color: col('--accent') || '#5b9dff', lineWidth: 2, priceLineVisible: false }).setData(lv);
    const bench = d.strategies.find(s => s.kind === 'bench'), segS = Paper.byId[id];
    if (bench && segS && segS.seg === 'EQ' && id !== bench.id && h.eq[bench.id]) ch.addLineSeries({ color: 'rgba(243,180,60,.65)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, title: 'Nifty' }).setData(h.days.map((t, k) => ({ time: t, value: h.eq[bench.id][k] })).filter(p => p.value != null));
    ch.timeScale().fitContent();
  }

  // ---------- Home card ----------
  window.paperCardHTML = function () {
    const d = PP.data;
    if (!d) return `<div class="card pp-home" id="ppHome"><div class="mst">📒 Paper league <span class="msd">loading…</span></div></div>`;
    const top = d.strategies.filter(s => s.rank).sort((a, b) => (b.status === 'Promoted') - (a.status === 'Promoted') || b.score - a.score).slice(0, 3);
    const nEq = [...d.open, ...d.closed].filter(t => t.d0 === d.asOf && t.s !== 'nifty_bh'), eqN = nEq.filter(t => t.seg === 'EQ').length, foN = nEq.length - eqN;
    const sig = (d.leaders && d.leaders.signals) || [];
    return `<div class="card pp-home" id="ppHome"><div class="mst">📒 Paper league <span class="msd">${esc(d.asOf)}</span></div>
      ${top.length ? top.map(r => `<div class="pp-hrow"><span class="pp-seg">${r.seg === 'EQ' ? 'EQ' : 'F&amp;O'}</span><span class="pp-n">${esc(r.short)}</span>${badge(r.status)}<span class="pp-ret">${pc(r.stats.all.ret)}</span></div>`).join('') : '<div class="note">Not enough closed trades to rank strategies yet.</div>'}
      <div class="note">${nEq.length} new paper trades on the last session (${eqN} equity · ${foN} F&amp;O)${sig.length ? ` · ${sig.length} signals from promoted strategies for the next session: ${sig.slice(0, 4).map(x => `<b>${esc(x.seg === 'OPT' ? x.opt.und + ' ' + x.opt.cp : x.sym)}</b>`).join(', ')}` : ''}. Paper results only.</div></div>`;
  };
  window.bindPaperCard = function () {
    const el = $('#ppHome'); if (!el) return;
    el.onclick = () => go('paper');
    load().then(x => { const e2 = $('#ppHome'); if (x && e2) { e2.outerHTML = paperCardHTML(); const e3 = $('#ppHome'); if (e3) e3.onclick = () => go('paper'); } });
  };
})();
