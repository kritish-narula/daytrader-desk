/* Money-flow screen (vFlows) + Home card. Data: www/flows.js */
'use strict';
(function () {
  const F = () => window.Flows;
  const st = { type: 'index', sort: 'today', sel: null, liveRes: {}, busy: false };
  const SORTS = [['today', 'Today flow'], ['vsy', 'vs Yesterday'], ['vsa', 'vs 9-day avg'], ['tv', 'Turnover ×']];
  const sortVal = (g, k, fr) => k === 'today' ? g.today : k === 'vsy' ? g.today - g.yday * fr : k === 'vsa' ? g.today - g.avg9 * fr : (g.ratio == null ? -1e9 : g.tvToday / Math.max(1e-9, g.tvAvg9 * fr));
  const cls = x => x > 0 ? 'up' : x < 0 ? 'dn' : 'mu';
  const times = (a, b) => (b && a / b > 0 && isFinite(a / b)) ? (a / b).toFixed(1) + '×' : (b ? 'flipped' : '–');
  const newsOf = (N, id) => N && N.groups && N.groups[id];
  const dot = n => !n ? '' : `<i class="fdot ${n.flag === 'negative' ? 'neg' : n.score <= -0.15 ? 'neg2' : n.score >= 0.15 ? 'pos' : 'neu'}" title="News pulse ${n.score}"></i>`;
  function bar(g, fr) {
    const a = g.today, b = g.yday * fr, c = g.avg9 * fr, m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), 1e-9);
    const seg = (v, lab) => `<div class="fb"><span class="fl">${lab}</span><div class="ft"><div class="fv ${v >= 0 ? 'p' : 'n'}" style="width:${Math.max(1, Math.abs(v) / m * 100).toFixed(0)}%"></div></div></div>`;
    return `<div class="fbars">${seg(a, 'Today')}${seg(b, 'Yday')}${seg(c, '9d avg')}</div>`;
  }
  function rowHTML(g, fr, N) {
    const Fl = F(), n = newsOf(N, g.id), dy = g.today - g.yday * fr, da = g.today - g.avg9 * fr, tvr = g.tvAvg9 ? g.tvToday / (g.tvAvg9 * fr) : null;
    return `<div class="row frow" data-id="${esc(g.id)}"><div class="fmain"><div class="fh"><b class="fn">${esc(g.name)}</b>${dot(n)}<span class="fcnt">${g.n} stocks</span><b class="fnet ${cls(g.today)}">${Fl.cr(g.today)}</b></div>
      <div class="fsub"><span>vs yday <b class="${cls(dy)}">${Fl.dcr(dy)}</b></span><span>vs 9d avg <b class="${cls(da)}">${Fl.dcr(da)}</b> <small>(${times(g.today, g.avg9 * fr)})</small></span><span>Turnover <b>${tvr ? tvr.toFixed(1) + '×' : '–'}</b></span><span>Adv <b class="${g.adv >= 50 ? 'up' : 'dn'}">${g.adv}%</b></span><span class="${cls(g.chg)}">${g.chg >= 0 ? '+' : ''}${g.chg.toFixed(2)}%</span></div>
      ${bar(g, fr)}</div></div>`;
  }
  const defsHTML = (D) => `<details class="fdef"><summary>How is this calculated? (proxy, not FII/DII data)</summary>
    <p><b>Net flow (₹ Cr)</b> = Σ over the group's stocks of <i>close × volume × sign(close − previous close)</i>. Money traded on up-days counts as inflow, on down-days as outflow. It measures where trading activity is going, not who is buying: it is a market-activity proxy.</p>
    <p><b>vs yesterday</b> = today − previous session. <b>vs 9-day avg</b> = today − average of the 9 sessions before today (× shows today ÷ that average). <b>Turnover ×</b> = traded value today ÷ its 9-day average. <b>Adv</b> = % of stocks up. The % change is the <b>equal-weighted</b> average of the stocks.</p>
    <p>Real FII/DII sector-wise flows are only published fortnightly by NSDL, so they cannot be shown daily. Delivery % is not shown: NSE delivery files can't be fetched reliably. Prices: Yahoo Finance; index/industry lists: NSE. Intraday runs are partial-day; the yesterday / 9-day columns are scaled to the share of the session elapsed so they compare like-for-like.</p></details>`;

  async function vFlows() {
    const v = $('#view'), Fl = F(); Fl.cached();
    const draw = () => { if (S.tab !== 'flows') return; st.sel ? drawSel() : drawList(); };
    if (!Fl.data.flows) v.innerHTML = '<div class="empty"><span class="spin"></span> Loading money flow…</div>';
    draw();
    Fl.load().then(draw).catch(() => {});
  }
  function drawList() {
    const v = $('#view'), Fl = F(), D = Fl.data, FD = D.flows, N = D.news;
    if (!FD) { v.innerHTML = `<h3>Money flow</h3><div class="empty">Money-flow data isn't published yet${D.err ? ' (' + esc(D.err) + ')' : ''}.<br>The CI job runs after market close on weekdays.</div>`; return; }
    const fr = Fl.frac(FD), gs = FD.groups.filter(g => g.type === st.type).sort((a, b) => sortVal(b, st.sort, fr) - sortVal(a, st.sort, fr));
    const neg = FD.groups.filter(g => (newsOf(N, g.id) || {}).flag === 'negative' && g.type === st.type);
    v.innerHTML = `<h3>Money flow <a id="fRef">Refresh</a></h3>
      <div class="seg fseg"><button data-t="index" class="${st.type === 'index' ? 'on' : ''}">Indices</button><button data-t="industry" class="${st.type === 'industry' ? 'on' : ''}">Industries</button></div>
      <div class="chips wrap fsort">${SORTS.map(([k, l]) => `<button data-s="${k}" class="${st.sort === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="note">Net flow = close × volume × direction, ₹ crore (activity proxy, <b>not</b> FII/DII). Data: ${esc(Fl.asOfLabel(FD))}.${FD.intraday ? ' Partial day: yesterday / 9-day figures scaled to session progress.' : ''}</p>
      ${neg.length ? `<div class="warn">Negative news flagged (${neg.length}): ${neg.slice().sort((a, b) => newsOf(N, a.id).score - newsOf(N, b.id).score).slice(0, 4).map(g => esc(g.name)).join(', ')}${neg.length > 4 ? ' +' + (neg.length - 4) + ' more' : ''}</div>` : ''}
      <div class="list">${gs.map(g => rowHTML(g, fr, N)).join('') || '<div class="empty">No groups.</div>'}</div>${defsHTML()}`;
    v.querySelectorAll('.fseg button').forEach(b => b.onclick = () => { st.type = b.dataset.t; drawList(); });
    v.querySelectorAll('.fsort button').forEach(b => b.onclick = () => { st.sort = b.dataset.s; drawList(); });
    v.querySelectorAll('.frow').forEach(r => r.onclick = () => { st.sel = r.dataset.id; drawSel(); window.scrollTo(0, 0); });
    $('#fRef').onclick = async () => { toast('Refreshing…'); await Fl.load(true); drawList(); };
  }
  function drawSel() {
    const v = $('#view'), Fl = F(), D = Fl.data, FD = D.flows, N = D.news; if (!FD) { st.sel = null; return drawList(); }
    const base = FD.groups.find(x => x.id === st.sel); if (!base) { st.sel = null; return drawList(); }
    const lv = st.liveRes[base.id], g = lv ? Object.assign({}, base, lv) : base, fr = lv ? 1 : Fl.frac(FD), n = newsOf(N, g.id);
    const dy = g.today - g.yday * fr, da = g.today - g.avg9 * fr, tvr = g.tvAvg9 ? g.tvToday / (g.tvAvg9 * fr) : null;
    const chgOf = s => (base.chgs || {})[s];
    const stk = (s, val) => `<div class="row fstk" data-s="${esc(s)}"><div class="nm"><div class="s">${esc(s)}</div></div><div class="px"><b class="${cls(val)}">${Fl.cr(val)}</b>${chgOf(s) != null && !lv ? `<small class="${cls(chgOf(s))}">${chgOf(s) >= 0 ? '+' : ''}${chgOf(s)}%</small>` : ''}</div></div>`;
    const ins = (g.top_in || []).map((s, i) => stk(s, g.top_in_v[i])).join('') || '<div class="empty">None</div>', outs = (g.top_out || []).map((s, i) => stk(s, g.top_out_v[i])).join('') || '<div class="empty">None</div>';
    const when = n && n.top && n.top[0] ? '' : '';
    v.innerHTML = `<div class="dh"><button class="back" id="fBack">←</button><div class="t"><div class="s">${esc(g.name)} ${dot(n)}</div><div class="f">${base.n} stocks · ${base.type === 'index' ? 'index' : 'industry'}</div></div></div>
      <div class="card fstat"><div class="fbig ${cls(g.today)}">${Fl.cr(g.today)}</div><div class="note">${lv ? `Live estimate ${new Date(lv.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} (Yahoo, ${lv.n} stocks, delayed)` : esc(Fl.asOfLabel(FD))}</div>
        <div class="fgrid"><div><small>Yesterday</small><b class="${cls(g.yday)}">${Fl.cr(g.yday)}</b></div><div><small>9-day avg / day</small><b class="${cls(g.avg9)}">${Fl.cr(g.avg9)}</b></div><div><small>vs yesterday</small><b class="${cls(dy)}">${Fl.dcr(dy)} Cr</b></div><div><small>vs 9-day avg</small><b class="${cls(da)}">${Fl.dcr(da)} Cr <span class="mu">(${times(g.today, g.avg9 * fr)})</span></b></div><div><small>Turnover vs 9d avg</small><b>${tvr ? tvr.toFixed(2) + '×' : '–'}</b></div><div><small>Advancing</small><b class="${g.adv >= 50 ? 'up' : 'dn'}">${g.adv}%</b></div><div><small>Avg change (equal-wt)</small><b class="${cls(g.chg)}">${g.chg >= 0 ? '+' : ''}${(+g.chg).toFixed(2)}%</b></div><div><small>Traded value</small><b>₹${Math.round(g.tvToday).toLocaleString('en-IN')} Cr</b></div></div>
        ${bar(g, fr)}
        ${marketOpen('IN') ? `<button class="fbtn" id="fLive">${lv ? 'Re-run live estimate' : 'Live estimate now'}</button>` : ''}${lv ? ' <a id="fLiveOff" class="note">use CI data</a>' : ''}</div>
      <h3>Top inflow stocks today</h3><div class="list">${ins}</div><h3>Top outflow stocks today</h3><div class="list">${outs}</div>
      <h3>Sector news ${n ? `<span class="note">score ${n.score >= 0 ? '+' : ''}${n.score} · ${n.n} scored</span>` : ''}</h3>
      ${n && n.flag === 'negative' ? `<div class="warn">Heavy negative news flow for this group (${n.neg24} negative headlines in the last 24h). Check the stocks before adding.</div>` : ''}
      <div class="list">${n && n.top && n.top.length ? n.top.map(t => `<a class="row fnews" href="${esc(t.link)}" target="_blank" rel="noopener"><i class="fdot ${t.score < 0 ? 'neg' : t.score > 0 ? 'pos' : 'neu'}"></i><div class="nm"><div class="f2">${esc(t.title)}</div><div class="f">${t.date ? new Date(t.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''} · ${t.score > 0 ? 'positive' : t.score < 0 ? 'negative' : 'neutral'}</div></div></a>`).join('') : '<div class="empty">No sector headlines yet.</div>'}</div>
      <p class="note">Headline sentiment is keyword-based and approximate. Source: Google News RSS.</p>${defsHTML()}`;
    $('#fBack').onclick = () => { st.sel = null; drawList(); window.scrollTo(0, 0); };
    v.querySelectorAll('.fstk').forEach(r => r.onclick = () => { if (typeof openDetail === 'function') openDetail(r.dataset.s, 'IN'); });
    const lb = $('#fLive'); if (lb) lb.onclick = async () => { lb.disabled = true; lb.innerHTML = '<span class="spin"></span> Fetching…'; try { st.liveRes[base.id] = await Fl.live(base); drawSel(); } catch (e) { toast(e.message); lb.disabled = false; lb.textContent = 'Live estimate now'; } };
    const lo = $('#fLiveOff'); if (lo) lo.onclick = () => { delete st.liveRes[base.id]; drawSel(); };
  }
  // ---- Home card ----
  function cardBody() {
    const Fl = F(), FD = Fl.cached().flows; if (!FD) return '<div class="note">Money-flow data not published yet.</div>';
    const fr = Fl.frac(FD), gs = FD.groups.filter(g => g.n >= 5).slice().sort((a, b) => b.today - a.today);
    const line = g => { const da = g.today - g.avg9 * fr; return `<div class="fcl" data-id="${esc(g.id)}"><span class="fcn">${esc(g.name)}</span><b class="${cls(g.today)}">${Fl.cr(g.today)}</b><small class="${cls(da)}">${Fl.dcr(da)} vs 9d avg</small></div>`; };
    const ins = gs.filter(g => g.today > 0).slice(0, 3), outs = gs.slice().reverse().filter(g => g.today < 0).slice(0, 3);
    return `<div class="fcols"><div><div class="fch up">Inflow</div>${ins.map(line).join('') || '<small class="mu">none</small>'}</div><div><div class="fch dn">Outflow</div>${outs.map(line).join('') || '<small class="mu">none</small>'}</div></div><div class="note">${esc(Fl.asOfLabel(FD))} · activity proxy, not FII/DII</div>`;
  }
  window.flowsCardHTML = function () { return `<h3>Money flow <a id="fcAll">All sectors</a></h3><div class="card fcard" id="fcard">${cardBody()}</div>`; };
  window.bindFlowsCard = function () {
    const wire = () => { const c = $('#fcard'); if (!c) return; c.onclick = e => { const l = e.target.closest('.fcl'); if (l) st.sel = l.dataset.id; else st.sel = null; go('flows'); }; };
    wire(); const a = $('#fcAll'); if (a) a.onclick = () => { st.sel = null; go('flows'); };
    F().load().then(() => { const c = $('#fcard'); if (c) { c.innerHTML = cardBody(); wire(); } }).catch(() => {});
  };
  window.vFlows = vFlows;
})();
