/* Trades screens: Portfolio tab "Trades" segment (open trades + journal), add-trade sheet (Trades.openAdd), exit / edit sheets, Home card.
   Logic and storage live in trades.js. Numbers are updated in place every tick (no list re-render). */
'use strict';
(() => {
  const inr = (x, d) => { if (x == null || !isFinite(x)) return '–'; const a = Math.abs(x); return (x < 0 ? '−' : '') + '₹' + a.toLocaleString('en-IN', { minimumFractionDigits: d == null ? (a < 1000 ? 2 : 0) : d, maximumFractionDigits: d == null ? (a < 1000 ? 2 : 0) : d }); };
  const px2 = x => x == null || !isFinite(x) ? '–' : '₹' + (+x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sg = x => x > 0 ? '+' : '', cl = x => x > 0 ? 'up' : x < 0 ? 'dn' : '';
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dmy = ts => { const d = new Date(ts + 5.5 * 3600e3); return d.getUTCDate() + ' ' + MONS[d.getUTCMonth()] + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  const dur = ms => { const m = Math.max(0, Math.round(ms / 60e3)); if (m < 60) return m + 'm'; if (m < 1440) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; return Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h'; };
  const expShort = e => e ? +e.slice(8) + ' ' + MONS[+e.slice(5, 7) - 1] : '';

  // ---------- bottom sheet (same look as the portfolio sheet; own ids so phone-back can close it) ----------
  function sheet(html, bind) {
    closeTrSheet();
    document.body.insertAdjacentHTML('beforeend', `<div class="pf-sheetbg tr-bg" id="trBg"><div class="pf-sheet tr-sheet" id="trSheet"><button class="pf-x" id="trX">✕</button>${html}</div></div>`);
    $('#trX').onclick = closeTrSheet; $('#trBg').onclick = e => { if (e.target.id === 'trBg') closeTrSheet(); };
    S.sheetOpen = true; bind && bind();
  }
  function closeTrSheet() { const b = $('#trBg'); if (b) b.remove(); S.sheetOpen = false; }
  window.closeTrSheet = closeTrSheet;
  function copyOut(text, msg) {
    const done = () => toast(msg);
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text).then(done) : Promise.reject()).catch(() => sheet(`<h3>Copy this</h3><textarea class="inp" style="height:220px;font-family:monospace;font-size:12px">${esc(text)}</textarea>`));
  }

  // ---------- suggestions (computed from the live price, never auto-exit) ----------
  function suggest(t, lv) {
    const out = [], d = Trades.dirOf(t), px = lv && lv.px, u = lv && lv.u, fresh = lv && lv.px > 0 && !lv.stale, now = Trades.ist();
    if (lv && lv.err && t.kind !== 'EQ') out.push(['wa', `Can't price this contract: ${lv.err}`]);
    if (fresh) {
      if (t.sl && d * (px - t.sl) <= 0) out.push(['dn', `SL hit at ${px2(px)} (SL ${px2(t.sl)}) — exit now`]);
      if (t.t2 && d * (px - t.t2) >= 0) out.push(['up', `T2 ${px2(t.t2)} reached at ${px2(px)} — consider exiting the rest`]);
      else if (t.t1 && d * (px - t.t1) >= 0) out.push(['up', `T1 ${px2(t.t1)} reached at ${px2(px)} — consider booking part${t.trail.type === 'cost' ? ' (SL now at cost)' : ''}`]);
    }
    if (u > 0 && fresh) {
      const b = d * (t.kind === 'OPT' && t.cp === 'PE' ? -1 : 1);
      if (t.slU && b * (u - t.slU) <= 0) out.push(['dn', `${t.und} ${u.toLocaleString('en-IN')} through your underlying SL ${t.slU.toLocaleString('en-IN')} — exit now`]);
      if (t.t2U && b * (u - t.t2U) >= 0) out.push(['up', `${t.und} reached underlying T2 ${t.t2U.toLocaleString('en-IN')}`]);
      else if (t.t1U && b * (u - t.t1U) >= 0) out.push(['up', `${t.und} reached underlying T1 ${t.t1U.toLocaleString('en-IN')}`]);
    }
    if ((t.kind === 'OPT' || t.kind === 'FUT') && t.exp === now.day && now.mins >= 870) out.push(['wa', 'Expires today — square off before 3:30 pm']);
    if (t.prod === 'INTRA' && now.mins >= 915 && now.mins < 930) out.push(['wa', 'Intraday: square off now (3:15 pm)']);
    return out;
  }
  function barPos(t, p) { // 0..1 between SL and the farthest target, entry/T1 marker positions
    const d = Trades.dirOf(t), sl = t.sl != null ? t.sl : t.sl0, tg = t.t2 || t.t1; if (sl == null || !tg || sl === tg) return null;
    const f = v => Math.max(0, Math.min(1, (v - sl) / (tg - sl)));
    return { p: p > 0 ? f(p) : null, e: f(t.entry), t1: t.t1 && t.t2 ? f(t.t1) : null };
  }

  // ---------- Trades segment ----------
  window.vTrades = function (box) {
    box = box || $('#view'); const sub = S.trSub || 'open';
    box.innerHTML = `<div class="tr-top"><div class="chips tr-sub" id="trSub"><button class="chip ${sub === 'open' ? 'on' : ''}" data-v="open">Open</button><button class="chip ${sub === 'journal' ? 'on' : ''}" data-v="journal">Journal</button></div><button class="btn sm" id="trAdd">＋ Add trade</button></div><div id="trBody"></div>`;
    $('#trAdd').onclick = () => Trades.openAdd();
    document.querySelectorAll('#trSub .chip').forEach(b => b.onclick = () => { S.trSub = b.dataset.v; vTrades(box); });
    if (Trades.locked()) { $('#trBody').innerHTML = '<div class="card note">Unlock the app with your PIN to see your trades.</div>'; return; }
    if (sub === 'journal') return vJournal();
    drawOpen(); startLoop();
  };
  function drawOpen() {
    const L = Trades.open(), box = $('#trBody'); if (!box) return;
    if (!L.length) { box.innerHTML = `<div class="card pf-empty"><div class="pf-big">📈</div><b>Track your trades</b><div class="note">Log an equity, futures or options trade with SL and targets. The app watches the live price, tells you when SL or a target is hit, trails your stop, and keeps a journal with P&amp;L after charges. It never places orders.</div><div class="pf-tools"><button class="btn sm" id="trAdd2">＋ Add your first trade</button></div></div>`; $('#trAdd2').onclick = () => Trades.openAdd(); return; }
    box.innerHTML = `<div class="card tr-sum" id="trSum"></div><div id="trList">${L.map(cardHTML).join('')}</div><div class="note tr-foot" id="trFoot"></div>`;
    $('#trList').onclick = ev => {
      const b = ev.target.closest('[data-a]'), card = ev.target.closest('.tr-card'); if (!card) return; const t = Trades.get(card.dataset.id); if (!t) return;
      if (b) { ev.stopPropagation(); if (b.dataset.a === 'exit') sheetExit(t); else if (b.dataset.a === 'edit') sheetEdit(t); else if (b.dataset.a === 'del' && confirm(`Delete ${Trades.label(t)} without recording an exit?`)) { Trades.remove(t.id); drawOpen(); } else if (b.dataset.a === 'chart') openDetail(t.und || t.sym); return; }
      card.classList.toggle('open');
    };
    paintAll(); Trades.tick({ force: true }).catch(() => {});
  }
  function cardHTML(t) {
    const tg = t.kind === 'EQ' ? '' : `<span class="tr-tag">${t.kind === 'OPT' ? 'OPT' : 'FUT'}</span>`;
    return `<div class="card tr-card" data-id="${t.id}">
      <div class="tr-h"><div><b>${esc(Trades.label(t))}</b> <span class="pf-badge ${t.side === 'BUY' ? 'pf-good' : 'pf-bad'}">${t.side}</span>${tg}${t.prod === 'INTRA' ? '<span class="tr-tag">INTRA</span>' : ''}${t.src === 'call' ? '<span class="tr-tag call">📞 call</span>' : ''}${t.tag ? `<span class="tr-tag">${esc(t.tag)}</span>` : ''}
        <div class="mu tr-n">${t.q0 === t.qty ? t.qty : t.qty + ' of ' + t.q0}${t.kind !== 'EQ' && t.lot > 1 ? ` (${Math.round(t.qty / t.lot * 100) / 100} × ${t.lot})` : ''} @ ${px2(t.entry)} · <span class="tr-time"></span></div></div>
        <div class="tr-r1"><b class="tr-ltp">–</b><div class="tr-pnl pf-pl"></div></div></div>
      <div class="tr-bar"><i class="tr-fill"></i><u class="tr-me" title="entry"></u><u class="tr-m1" title="T1"></u></div>
      <div class="tr-lv"></div>
      <div class="tr-ban"></div>
      <div class="tr-more"><div class="tr-und note"></div>${t.note ? `<div class="note">📝 ${esc(t.note)}</div>` : ''}<div class="note tr-src"></div>
        <div class="pf-btns"><button class="btn sm" data-a="exit">Exit…</button><button class="btn sm g" data-a="edit">SL / targets</button><button class="btn sm g" data-a="chart">Chart</button><button class="btn sm g" data-a="del" style="color:var(--dn)">Delete</button></div></div>
      <div class="tr-acts"><button class="btn sm" data-a="exit">Exit…</button><span class="mu">tap card for more</span></div>
    </div>`;
  }
  function paintAll() {
    const L = Trades.open(), card = id => document.querySelector(`.tr-card[data-id="${id}"]`); let tot = 0, priced = 0, risk = 0;
    if (!$('#trList')) { paintHome(); return; }
    for (const t of L) {
      const el = card(t.id); if (!el) { drawOpen(); return; }
      const lv = Trades.LIVE[t.id] || {}, px = lv.px > 0 ? lv.px : (t.mark > 0 ? t.mark : null), d = Trades.dirOf(t), set = (c, v, k) => { const n = el.querySelector(c); if (n && n.textContent !== v) n.textContent = v; return n; };
      const live = lv.px > 0 && !lv.stale;
      set('.tr-ltp', px ? px2(px) : (t.kind === 'EQ' ? '…' : 'no price'));
      const ltpEl = el.querySelector('.tr-ltp'); ltpEl.className = 'tr-ltp' + (px && !live ? ' stale' : '');
      const pe = el.querySelector('.tr-pnl');
      if (px) {
        const pnl = d * (px - t.entry) * t.qty, pc = d * (px / t.entry - 1) * 100, risk1 = Math.abs(t.entry - (t.sl0 != null ? t.sl0 : NaN)), R = risk1 > 0 ? d * (px - t.entry) / risk1 : null;
        const txt = `${sg(pnl)}${inr(pnl)} (${sg(pc)}${pc.toFixed(1)}%)${R != null ? ' · ' + sg(R) + R.toFixed(2) + 'R' : ''}`;
        if (pe.textContent !== txt) { pe.textContent = txt; pe.className = 'tr-pnl pf-pl ' + cl(pnl); }
        if (live) { tot += pnl; priced++; }
        const bp = barPos(t, px), bar = el.querySelector('.tr-bar');
        if (bp && bp.p != null) { bar.style.display = ''; const f = el.querySelector('.tr-fill'); f.style.width = (bp.p * 100).toFixed(1) + '%'; f.className = 'tr-fill ' + (pnl >= 0 ? 'up' : 'dn'); el.querySelector('.tr-me').style.left = (bp.e * 100).toFixed(1) + '%'; const m1 = el.querySelector('.tr-m1'); m1.style.display = bp.t1 != null ? '' : 'none'; if (bp.t1 != null) m1.style.left = (bp.t1 * 100).toFixed(1) + '%'; } else bar.style.display = 'none';
        // distance to SL / T1 / T2 (in % of the current price)
        const dist = (v, nm, c) => v ? `<span>${nm} <b class="${c}">${px2(v)}</b> <small>${(((v - px) / px) * 100 >= 0 ? '+' : '') + (((v - px) / px) * 100).toFixed(1)}%</small></span>` : '';
        const lvh = dist(t.sl, 'SL' + (t.trailed ? '↗' : ''), 'dn') + dist(t.t1, 'T1', 'up') + dist(t.t2, 'T2', 'up') || '<span class="mu">no SL / targets set</span>';
        const lvEl = el.querySelector('.tr-lv'); if (lvEl.dataset.h !== lvh) { lvEl.dataset.h = lvh; lvEl.innerHTML = lvh; }
      } else { pe.textContent = lv.err || 'waiting for price…'; pe.className = 'tr-pnl pf-pl mu'; }
      if (t.sl0 != null && t.sl != null) risk += Math.abs(t.entry - t.sl) * t.qty;
      let tm = dur(Date.now() - t.t0); if (t.exp) { const dte = Trades.dayDiff(Trades.ist().day, t.exp); tm += ` · ${dte > 0 ? dte + 'd to expiry' : dte === 0 ? 'expires today' : 'expired'}`; } set('.tr-time', tm);
      const ban = el.querySelector('.tr-ban'), S1 = suggest(t, lv), bh = S1.map(([c, m]) => `<div class="tr-b ${c}">${c === 'dn' ? '🛑' : c === 'up' ? '🎯' : '⚠'} ${esc(m)}</div>`).join(''); if (ban.dataset.h !== bh) { ban.dataset.h = bh; ban.innerHTML = bh; }
      const ue = el.querySelector('.tr-und'); if (ue) { const parts = []; if (lv.u > 0) parts.push(`${esc(t.und)} <b>${lv.u.toLocaleString('en-IN')}</b>`); if (t.slU) parts.push(`SL ${t.slU.toLocaleString('en-IN')}`); if (t.t1U) parts.push(`T1 ${t.t1U.toLocaleString('en-IN')}`); if (t.t2U) parts.push(`T2 ${t.t2U.toLocaleString('en-IN')}`); const h = parts.length ? 'Underlying: ' + parts.join(' · ') : ''; if (ue.dataset.h !== h) { ue.dataset.h = h; ue.innerHTML = h; } }
      const se = el.querySelector('.tr-src'); if (se) se.textContent = (lv.src ? 'Price: ' + lv.src : '') + (t.trail.type !== 'none' ? ` · trail: ${t.trail.type === 'cost' ? 'SL to cost at T1' : t.trail.v + (t.trail.type === 'pct' ? '%' : ' pts')}` : '') + (t.kGuess ? ' · contract key unverified' : '');
    }
    const sum = $('#trSum');
    if (sum) {
      const h = `<div class="pf-s1"><div><div class="note">📈 ${L.length} open trade${L.length === 1 ? '' : 's'}</div><div class="pf-p ${cl(tot)}">${priced ? sg(tot) + inr(tot) : '–'}</div></div><div style="text-align:right"><div class="note">Live P&amp;L${priced < L.length ? ` (${priced}/${L.length} priced)` : ''}</div><div class="note">Risk to SL ${inr(risk, 0)}</div></div></div>`;
      if (sum.dataset.h !== h) { sum.dataset.h = h; sum.innerHTML = h; }
    }
    const foot = $('#trFoot'); if (foot) foot.textContent = (marketOpen('IN') ? 'Live: refreshing every 3 s' : 'Market closed: showing the last price') + '. Alerts fire once per event. The app only suggests; you exit in your broker app and record it here.';
    paintHome();
  }
  Trades.onTick = paintAll;
  function startLoop() {
    clearInterval(S._trT);
    S._trT = setInterval(() => { if (!$('#trList')) { clearInterval(S._trT); return; } if (document.hidden) return; if (marketOpen('IN')) Trades.tick().catch(() => {}); }, 3000);
  }

  // ---------- exit / edit sheets ----------
  function sheetExit(t) {
    const lv = Trades.LIVE[t.id] || {}, px = lv.px > 0 ? lv.px : t.mark || t.entry;
    sheet(`<h3>Exit ${esc(Trades.label(t))}</h3><div class="note">${t.side === 'BUY' ? 'Sell' : 'Buy back'} what you closed in your broker app, then record it here.</div>
      <div class="pf-2"><label>Quantity (open ${t.qty})<input id="xQ" class="inp" inputmode="decimal" value="${t.qty}"></label><label>Exit price (₹)<input id="xP" class="inp" inputmode="decimal" value="${(+px).toFixed(2)}"></label></div>
      <div class="tr-chips"><button class="chip" data-f="1">All</button><button class="chip" data-f=".5">Half</button><button class="chip" data-f=".25">25%</button>${lv.px > 0 ? '<button class="chip" id="xL">LTP</button>' : ''}</div>
      <div class="note" id="xEst"></div><button class="btn w" id="xGo">Record exit</button><div class="note" id="xMsg"></div>`, () => {
      const upd = () => { const q = Math.min(+Trades.num($('#xQ').value) || 0, t.qty), p = Trades.num($('#xP').value), d = Trades.dirOf(t); if (q > 0 && p > 0) { const g = d * (p - t.entry) * q; $('#xEst').innerHTML = `Gross <b class="${cl(g)}">${sg(g)}${inr(g)}</b> · ${q === t.qty ? 'closes the trade' : (t.qty - q) + ' stay open'}`; } else $('#xEst').textContent = ''; };
      document.querySelectorAll('#trSheet [data-f]').forEach(b => b.onclick = () => { let q = t.qty * +b.dataset.f; if (t.lot > 1 && t.kind !== 'EQ') q = Math.max(t.lot, Math.round(q / t.lot) * t.lot); else q = Math.max(1, Math.round(q)); $('#xQ').value = Math.min(q, t.qty); upd(); });
      if ($('#xL')) $('#xL').onclick = () => { $('#xP').value = (+lv.px).toFixed(2); upd(); };
      $('#xQ').oninput = $('#xP').oninput = upd; upd();
      $('#xGo').onclick = () => {
        try { const why = (suggest(t, lv)[0] || [])[1] || 'manual', r = Trades.exit(t.id, Trades.num($('#xQ').value), Trades.num($('#xP').value), /SL hit/.test(why) ? 'sl' : /T[12]/.test(why) ? 'target' : 'manual'); closeTrSheet(); toast(`Recorded: net ${sg(r.net)}${inr(r.net)} after charges`); drawOpen(); if (!Trades.open().length) { S.trSub = 'journal'; vTrades(); } }
        catch (e) { $('#xMsg').textContent = e.message; }
      };
    });
  }
  function levelsHTML(o, kind) {
    const u = kind !== 'EQ';
    return `<div class="pf-2"><label>Stop-loss${kind === 'OPT' ? ' (premium)' : ''}<input id="fSL" class="inp" inputmode="decimal" value="${o.sl || ''}"></label><label>Target 1<input id="fT1" class="inp" inputmode="decimal" value="${o.t1 || ''}"></label></div>
      <div class="pf-2"><label>Target 2<input id="fT2" class="inp" inputmode="decimal" value="${o.t2 || ''}"></label><label>Trailing stop<select id="fTr" class="inp"><option value="none">None</option><option value="cost">SL to cost at T1</option><option value="pct">Trail by % </option><option value="pts">Trail by points</option></select></label></div>
      <div id="fTrV" style="display:none"><label class="note">Trail distance (<span id="fTrU">%</span>) · starts after T1 if set<input id="fTrN" class="inp" inputmode="decimal" value="${o.trail && o.trail.v || ''}"></label></div>
      ${u ? `<details class="tr-det" ${o.slU || o.t1U || o.t2U ? 'open' : ''}><summary>Exit on the underlying (optional)</summary><div class="note">e.g. exit if ${esc(o.und || 'NIFTY')} falls below 24,000. Direction is worked out from your side${kind === 'OPT' ? ' and CE/PE' : ''}.</div>
        <div class="pf-2"><label>Underlying SL<input id="fSLU" class="inp" inputmode="decimal" value="${o.slU || ''}"></label><label>Underlying T1<input id="fT1U" class="inp" inputmode="decimal" value="${o.t1U || ''}"></label></div><label class="note">Underlying T2<input id="fT2U" class="inp" inputmode="decimal" value="${o.t2U || ''}"></label></details>` : ''}`;
  }
  function bindTrail(o) {
    const s = $('#fTr'); if (!s) return; s.value = (o.trail && o.trail.type) || 'none';
    const sh = () => { $('#fTrV').style.display = s.value === 'pct' || s.value === 'pts' ? '' : 'none'; $('#fTrU').textContent = s.value === 'pct' ? '%' : 'points'; }; s.onchange = sh; sh();
  }
  const readLevels = () => { const g = id => { const e = $(id); return e ? e.value : ''; }; return { sl: g('#fSL'), t1: g('#fT1'), t2: g('#fT2'), slU: g('#fSLU'), t1U: g('#fT1U'), t2U: g('#fT2U'), trail: { type: g('#fTr') || 'none', v: Trades.num(g('#fTrN')) || 0 } }; };
  function sheetEdit(t) {
    sheet(`<h3>${esc(Trades.label(t))}: levels</h3>${levelsHTML(t, t.kind)}<input id="eTag" class="inp" placeholder="Tag / strategy" value="${esc(t.tag)}"><input id="eNote" class="inp" placeholder="Note" value="${esc(t.note)}">
      ${t.kind !== 'EQ' ? `<label class="note">Contract key (mStock) for live price<input id="eK" class="inp" value="${esc(t.k)}"></label>` : ''}
      <label class="tr-chk"><input type="checkbox" id="eIn" ${t.prod === 'INTRA' ? 'checked' : ''}> Intraday (remind me to square off at 3:15 pm)</label><button class="btn w" id="eGo">Save</button>`, () => {
      bindTrail(t);
      $('#eGo').onclick = () => { const l = readLevels(); Trades.update(t.id, Object.assign(l, { tag: $('#eTag').value, note: $('#eNote').value, prod: $('#eIn').checked ? 'INTRA' : 'POS', k: $('#eK') ? $('#eK').value : t.k })); closeTrSheet(); toast('Saved'); drawOpen(); };
    });
  }

  // ---------- add trade ----------
  const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  async function quote(F) { // current price of the chosen instrument: {px, src} or null
    try {
      if (window.MS && MS.ok()) { const k = F.kind === 'EQ' ? await MS.key(F.sym).then(x => x.k) : F.k; if (k) { const m = await MS.ltp([k]); if (m[k] > 0) return { px: +m[k], src: 'mStock' }; } }
      if (F.kind === 'EQ' && F.sym) { const d = await chart(ySym(F.sym, 'IN'), '1d', '5m'), p = d.meta && d.meta.regularMarketPrice || d.D.c[d.D.c.length - 1]; if (p > 0) return { px: p, src: 'Yahoo (delayed)' }; }
    } catch (e) {}
    return null;
  }
  async function chainFor(und) { // from the mStock script master: {exps, strikes:{exp:[..]}} (indices only, first 2 expiries) or null
    try { if (!(window.MS && MS.ok())) return null; let L = MS.optContracts ? await MS.optContracts(und).catch(() => null) : null; if (!L || !L.length) { const m = await MS.map(); L = (m.opt || {})[und] || []; } /* every underlying + expiry when available */ if (!L.length) return null; const strikes = {}; for (const x of L) (strikes[x[2]] = strikes[x[2]] || new Set()).add(+x[3]); const exps = Object.keys(strikes).sort(); const o = { exps, strikes: {} }; for (const e of exps) o.strikes[e] = [...strikes[e]].sort((a, b) => a - b); return o; } catch (e) { return null; }
  }
  function foNames() { if (!S.fo && window.buildFo) buildFo(); return [...new Set([...Trades.INDICES, ...Object.keys(S.fo || {})])]; }
  const lotOf = und => (window.foLot ? foLot(und, 'IN') : 0) || ((S.fo || {})[und] || {}).lot || 0;

  Trades.openAdd = function (pre) {
    pre = pre || {};
    const F = { kind: ['EQ', 'FUT', 'OPT'].includes(pre.kind) ? pre.kind : 'EQ', side: pre.side === 'SELL' ? 'SELL' : 'BUY', prod: pre.prod || 'POS', sym: pre.sym || '', und: pre.und || '', exp: pre.exp || '', strike: pre.strike || 0, cp: pre.cp || 'CE', k: pre.k || '', kGuess: false,
      lot: pre.lot || 0, lots: pre.lots || (pre.qty && pre.lot ? Math.round(pre.qty / pre.lot) : 1), qty: pre.qty || '', entry: pre.entry || '', sl: pre.sl || '', t1: pre.t1 || '', t2: pre.t2 || '', slU: pre.slU || '', t1U: pre.t1U || '', t2U: pre.t2U || '', trail: pre.trail || { type: 'none', v: 0 },
      tag: pre.tag || (pre.source === 'call' ? 'call' : ''), note: pre.note || '', when: nowLocal(), source: pre.source || '', chain: null, ltp: null, spot: null };
    if (F.kind === 'OPT' && !F.und && F.sym) F.und = F.sym.replace(/\d.*$/, '');
    if (F.kind !== 'EQ' && F.und && !F.lot) F.lot = lotOf(F.und);
    const locked = !!(pre.k && F.kind !== 'EQ' && pre.strike || F.kind === 'FUT' && pre.k); // contract fixed by a call / chain
    F.fixed = locked && !!pre.exp;
    draw(F); resolveAll(F);
  };
  function grab(F) {
    const g = id => { const e = $(id); return e ? e.value : undefined; };
    if (g('#fEntry') !== undefined) { F.entry = g('#fEntry'); F.when = g('#fWhen') || F.when; F.tag = g('#fTag'); F.note = g('#fNote'); }
    if (g('#fLot') !== undefined) F.lot = +g('#fLot') || F.lot; if (g('#fLots') !== undefined) F.lots = g('#fLots'); if (g('#fQty') !== undefined) F.qty = g('#fQty');
    if (g('#fSL') !== undefined) Object.assign(F, readLevels());
    if (g('#fStrike') !== undefined && g('#fStrike') !== '') F.strike = +g('#fStrike');
  }
  async function resolveAll(F) { // fills chain, expiry, contract key, lot, spot, LTP
    if (F.kind !== 'EQ' && F.und) {
      if (!F.chain || F.chain.und !== F.und) {
        const c = await chainFor(F.und); if ($('#trBg')) grab(F); F.chain = c ? Object.assign(c, { und: F.und }) : { und: F.und, none: true };
        if (!F.exp) F.exp = c ? c.exps[0] : (window.Paper ? Paper.expiries(F.und, Trades.ist().day, 4)[0] : '');
        if (!F.lot) F.lot = lotOf(F.und);
        try { const ks = await MS.key(F.und), m = await MS.ltp([ks.k]); F.spot = m[ks.k] || null; } catch (e) { F.spot = null; }
        if (!$('#trBg')) return; draw(F, true);
      }
      if (F.kind === 'OPT' && F.strike && F.exp && !F.fixed) await resolveOpt(F);
      if (F.kind === 'FUT' && F.exp && !F.fixed && !F.k) { F.k = Trades.fallbackKey(F.und, F.exp); F.kGuess = true; if ($('#trBg')) draw(F, true); }
    }
    if ((F.kind === 'EQ' ? F.sym : F.k)) { const q = await quote(F); F.ltp = q; const el = $('#fLtp'); if ($('#trBg') && el) { el.innerHTML = ltpHTML(F); bindUse(F); } }
  }
  async function resolveOpt(F) {
    let hit = null; if ($('#trBg')) grab(F);
    try {
      if (window.OC && OC.contract) { const c = await OC.contract(F.und, F.exp, F.strike, F.cp); if (c && c.k) hit = c; }
      if (!hit && F.chain && F.chain.exps && F.chain.exps.includes(F.exp) && window.MS && MS.ok()) { const n = F.chain.exps.indexOf(F.exp), o = await MS.option(F.und, F.strike, F.cp, n); if (o && o.exp === F.exp && o.strike === +F.strike) hit = o; else if (o) { F._miss = `No ${F.strike} ${F.cp} on ${F.exp} (nearest ${o.strike})`; } }
    } catch (e) {}
    if (hit) { F.k = hit.k; F.kGuess = false; if (hit.lot) F.lot = hit.lot; F._miss = ''; }
    else if (!F.k || F.kGuess || !F.fixed) { F.k = Trades.fallbackKey(F.und, F.exp, F.strike, F.cp); F.kGuess = true; }
    F.ltp = null; if ($('#trBg')) { draw(F, true); }
  }
  const ltpHTML = F => F.ltp ? `LTP <b>${px2(F.ltp.px)}</b> <small class="mu">${esc(F.ltp.src)}</small> · <a href="#" id="fUse">use as entry</a>` : (F.kind === 'EQ' ? (F.sym ? '<span class="mu">no live price found</span>' : '') : F.k ? `<span class="mu">${window.MS && MS.ok() ? "no live quote for this contract key" : 'log in to mStock for live F&O prices'}</span>` : '');
  function bindUse(F) { const a = $('#fUse'); if (a) a.onclick = e => { e.preventDefault(); $('#fEntry').value = (+F.ltp.px).toFixed(2); F.entry = $('#fEntry').value; risk(F); }; }
  function risk(F) {
    const el = $('#fRisk'); if (!el) return; const lv = readLevels(), e = Trades.num($('#fEntry').value), sl = Trades.num(lv.sl), t1 = Trades.num(lv.t1), t2 = Trades.num(lv.t2);
    const q = F.kind === 'EQ' ? Trades.num($('#fQty') && $('#fQty').value) : (+F.lots || 0) * (+F.lot || 0); if (!(e > 0) || !(q > 0)) { el.textContent = ''; return; }
    const d = F.side === 'BUY' ? 1 : -1, parts = [`Qty ${q}`, `Value ${inr(e * q, 0)}`]; if (sl > 0) parts.push(`Risk <b class="dn">${inr(Math.abs(e - sl) * q, 0)}</b>`); if (t1 > 0) parts.push(`T1 <b class="up">${inr(d * (t1 - e) * q, 0)}</b>${sl > 0 ? ' (' + (d * (t1 - e) / Math.abs(e - sl)).toFixed(1) + 'R)' : ''}`); if (t2 > 0) parts.push(`T2 <b class="up">${inr(d * (t2 - e) * q, 0)}</b>${sl > 0 ? ' (' + (d * (t2 - e) / Math.abs(e - sl)).toFixed(1) + 'R)' : ''}`);
    el.innerHTML = parts.join(' · ');
  }
  function draw(F, nograb) {
    if ($('#trBg') && !nograb) grab(F);
    const eq = F.kind === 'EQ', opt = F.kind === 'OPT', fno = !eq, ch = F.chain && !F.chain.none ? F.chain : null;
    const exps = ch ? ch.exps : (fno && F.und && window.Paper ? Paper.expiries(F.und, Trades.ist().day, 4) : []);
    if (F.exp && !exps.includes(F.exp) && F.exp) exps.unshift(F.exp);
    let strikes = ch && F.exp && ch.strikes[F.exp] ? ch.strikes[F.exp] : [];
    if (strikes.length > 60 && F.spot) strikes = strikes.filter(s => Math.abs(s - F.spot) < F.spot * 0.1); // keep the list short: ±10% around spot
    const atm = F.spot && strikes.length ? strikes.reduce((a, b) => Math.abs(b - F.spot) < Math.abs(a - F.spot) ? b : a) : null;
    const badge = F.source === 'call' ? '<span class="tr-tag call">📞 from call</span>' : F.source === 'chain' ? '<span class="tr-tag call">⛓ from option chain</span>' : '';
    const q = eq ? '' : (+F.lots || 0) * (+F.lot || 0), tags = [...new Set(Trades.all().map(t => t.tag).filter(Boolean))];
    sheet(`<h3>Add a trade ${badge}</h3>
      <div class="chips tr-ty" id="fKind">${[['EQ', 'Equity'], ['FUT', 'Future'], ['OPT', 'Option']].map(([k, n]) => `<button class="chip ${F.kind === k ? 'on' : ''}" data-v="${k}">${n}</button>`).join('')}</div>
      <div class="chips tr-ty" id="fSide"><button class="chip ${F.side === 'BUY' ? 'on' : ''}" data-v="BUY">Buy / Long</button><button class="chip ${F.side === 'SELL' ? 'on sell' : ''}" data-v="SELL">Sell / Short</button><button class="chip ${F.prod === 'INTRA' ? 'on' : ''}" id="fProd">${eq ? 'Intraday' : 'Intraday (MIS)'}</button></div>
      ${eq ? `<input id="fSym" class="inp" placeholder="Search stock (e.g. RELIANCE)" autocomplete="off" autocapitalize="characters" value="${esc(F.sym)}"><div id="fSug" class="pf-sug"></div>`
        : `<input id="fUnd" class="inp" placeholder="Underlying (NIFTY, RELIANCE…)" autocomplete="off" autocapitalize="characters" value="${esc(F.und)}" ${F.fixed ? 'readonly' : ''}><div id="fSug" class="pf-sug"></div>
          ${F.und ? '' : `<div class="tr-chips">${Trades.INDICES.map(i => `<button class="chip" data-u="${i}">${i}</button>`).join('')}</div>`}
          ${F.und ? `<div class="pf-2"><label>Expiry<select id="fExp" class="inp" ${F.fixed ? 'disabled' : ''}>${exps.map(e => `<option value="${e}" ${e === F.exp ? 'selected' : ''}>${expShort(e)} ${e.slice(0, 4)}</option>`).join('')}</select></label>
            ${opt ? `<label>Type<span class="chips"><button class="chip ${F.cp === 'CE' ? 'on' : ''}" data-cp="CE">CE</button><button class="chip ${F.cp === 'PE' ? 'on' : ''}" data-cp="PE">PE</button></span></label>` : `<label>Lot size<input id="fLot" class="inp" inputmode="numeric" value="${F.lot || ''}"></label>`}</div>` : ''}
          ${opt && F.und && !F.fixed ? (strikes.length ? `<div class="note">Strike ${F.spot ? '· spot ' + F.spot.toLocaleString('en-IN') : ''}</div><div class="tr-strikes" id="fStr">${strikes.map(s => `<button class="chip ${+F.strike === s ? 'on' : ''} ${s === atm ? 'atm' : ''}" data-s="${s}">${s}</button>`).join('')}</div>` : `<label class="note">Strike<input id="fStrike" class="inp" inputmode="decimal" value="${F.strike || ''}"></label>`) : ''}
          ${opt && F.fixed ? `<div class="note">${esc(F.und)} ${F.strike} ${F.cp} · ${expShort(F.exp)}</div>` : ''}
          ${F._miss ? `<div class="note wa">${esc(F._miss)}</div>` : ''}
          ${fno && F.und ? `<label class="note">Contract key (mStock) ${F.kGuess ? '<span class="wa">· guessed, check it</span>' : ''}<input id="fKey" class="inp" value="${esc(F.k)}" placeholder="e.g. NFO:NIFTY26NOV24000CE"></label>` : ''}
          ${opt && F.und ? `<div class="pf-2"><label>Lot size<input id="fLot" class="inp" inputmode="numeric" value="${F.lot || ''}"></label><label>Lots<input id="fLots" class="inp" inputmode="numeric" value="${F.lots || 1}"></label></div>` : ''}
          ${F.kind === 'FUT' && F.und ? `<label class="note">Lots<input id="fLots" class="inp" inputmode="numeric" value="${F.lots || 1}"></label>` : ''}
          ${fno && F.und ? `<div class="note" id="fQ">Quantity ${q || '–'} (${F.lots || 0} × ${F.lot || 0})</div>` : ''}`}
      ${eq ? `<label class="note">Quantity<input id="fQty" class="inp" inputmode="numeric" value="${F.qty || ''}"></label>` : ''}
      <div class="pf-2"><label>Entry price (₹)<input id="fEntry" class="inp" inputmode="decimal" value="${F.entry || ''}"></label><label>Date &amp; time<input id="fWhen" class="inp" type="datetime-local" value="${F.when}"></label></div>
      <div class="note" id="fLtp">${ltpHTML(F)}</div>
      ${levelsHTML(Object.assign({}, F, { und: F.und }), F.kind)}
      <input id="fTag" class="inp" list="fTags" placeholder="Tag / strategy (e.g. breakout, call)" value="${esc(F.tag)}"><datalist id="fTags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      <input id="fNote" class="inp" placeholder="Notes (optional)" value="${esc(F.note)}">
      <div class="note tr-risk" id="fRisk"></div><button class="btn w" id="fGo">Track this trade</button><div class="note dn" id="fMsg"></div>`, () => bindAdd(F));
  }
  function bindAdd(F) {
    bindTrail(F); risk(F); bindUse(F);
    document.querySelectorAll('#fKind .chip').forEach(b => b.onclick = () => { grab(F); F.kind = b.dataset.v; F.k = ''; F.ltp = null; F.fixed = false; if (F.kind !== 'EQ' && !F.lot && F.und) F.lot = lotOf(F.und); F.source = F.source; draw(F); resolveAll(F); });
    document.querySelectorAll('#fSide .chip[data-v]').forEach(b => b.onclick = () => { grab(F); F.side = b.dataset.v; draw(F); });
    $('#fProd').onclick = () => { grab(F); F.prod = F.prod === 'INTRA' ? 'POS' : 'INTRA'; draw(F); };
    const sug = $('#fSug'), pick = v => { grab(F); if (F.kind === 'EQ') { F.sym = v; F.ltp = null; } else { F.und = v; F.chain = null; F.exp = ''; F.strike = 0; F.k = ''; F.lot = lotOf(v); F.ltp = null; F.spot = null; } draw(F); resolveAll(F); };
    const inp = $('#fSym') || $('#fUnd');
    if (inp && !F.fixed) inp.oninput = () => {
      const s = inp.value.trim().toUpperCase(); if (!s) { sug.innerHTML = ''; return; }
      const L = F.kind === 'EQ' ? (S.nse && S.nse.eq || window.SEED_IN).map(x => [x[0], x[1]]) : foNames().map(x => [x, nameOf(x, 'IN')]);
      const hits = L.filter(x => x[0].startsWith(s) || String(x[1]).toUpperCase().includes(s)).sort((a, b) => (b[0] === s) - (a[0] === s) || b[0].startsWith(s) - a[0].startsWith(s)).slice(0, 8);
      sug.innerHTML = hits.map(x => `<div data-s="${esc(x[0])}"><b>${esc(x[0])}</b> <span class="mu">${esc(x[1])}</span></div>`).join('') || '<div class="mu">No match</div>';
      sug.querySelectorAll('[data-s]').forEach(d => d.onclick = () => pick(d.dataset.s));
    };
    document.querySelectorAll('#trSheet [data-u]').forEach(b => b.onclick = () => pick(b.dataset.u));
    const ex = $('#fExp'); if (ex) ex.onchange = () => { grab(F); F.exp = ex.value; F.k = ''; F.ltp = null; draw(F); resolveAll(F); };
    document.querySelectorAll('#trSheet [data-cp]').forEach(b => b.onclick = () => { grab(F); F.cp = b.dataset.cp; F.k = ''; F.ltp = null; draw(F); resolveAll(F); });
    document.querySelectorAll('#fStr [data-s]').forEach(b => b.onclick = () => { grab(F); F.strike = +b.dataset.s; F.k = ''; F.ltp = null; F._miss = ''; draw(F); resolveAll(F); });
    const st = $('#fStrike'); if (st) st.onchange = () => { grab(F); F.k = ''; F.ltp = null; draw(F); resolveAll(F); };
    const lots = () => { const l = +($('#fLot') && $('#fLot').value) || 0, n = +($('#fLots') && $('#fLots').value) || 0; F.lot = l; F.lots = n; const e = $('#fQ'); if (e) e.textContent = `Quantity ${l * n || '–'} (${n} × ${l})`; risk(F); };
    if ($('#fLot')) $('#fLot').oninput = lots; if ($('#fLots')) $('#fLots').oninput = lots;
    const k = $('#fKey'); if (k) k.onchange = () => { grab(F); F.k = k.value.trim(); F.kGuess = false; F.ltp = null; resolveAll(F); };
    ['#fEntry', '#fSL', '#fT1', '#fT2', '#fQty'].forEach(i => { const e = $(i); if (e) e.oninput = () => risk(F); });
    $('#fGo').onclick = () => {
      grab(F); const msg = m => ($('#fMsg').textContent = m), eq = F.kind === 'EQ', e = Trades.num(F.entry), lv = readLevels(), sl = Trades.num(lv.sl), d = F.side === 'BUY' ? 1 : -1;
      if (eq ? !F.sym : !F.und) return msg(eq ? 'Pick a stock.' : 'Pick the underlying.');
      if (!eq && !F.exp) return msg('Pick an expiry.'); if (F.kind === 'OPT' && !(+F.strike > 0)) return msg('Pick a strike.');
      const qty = eq ? Trades.num(F.qty) : (+F.lots || 0) * (+F.lot || 0); if (!(qty > 0)) return msg(eq ? 'Enter the quantity.' : 'Enter lots and lot size.');
      if (!(e > 0)) return msg('Enter the entry price.');
      if (sl > 0 && d * (e - sl) <= 0) return msg(`For a ${F.side === 'BUY' ? 'buy' : 'sell'} trade the stop-loss must be ${F.side === 'BUY' ? 'below' : 'above'} the entry.`);
      for (const [n, v] of [['Target 1', lv.t1], ['Target 2', lv.t2]]) { const x = Trades.num(v); if (x > 0 && d * (x - e) <= 0) return msg(`${n} must be ${F.side === 'BUY' ? 'above' : 'below'} the entry.`); }
      const when = Date.parse(F.when) || Date.now(), openDay = new Date(when + 5.5 * 3600e3).toISOString().slice(0, 10);
      try {
        const t = Trades.add(Object.assign({ kind: F.kind, prod: F.prod, sym: eq ? F.sym : (F.kind === 'OPT' ? `${F.und}${F.strike}${F.cp}` : F.und + 'FUT'), und: F.und, exp: F.exp, strike: F.strike, cp: F.cp, k: F.k, kGuess: F.kGuess, lot: F.lot || 1, lots: F.lots, qty, side: F.side, entry: e, t0: when, openDay, tag: F.tag, note: F.note, source: F.source }, lv));
        closeTrSheet(); S.savedSeg = 'tr'; S.trSub = 'open'; if (S.tab !== 'saved') go('saved'); else vSaved(); toast(`Tracking ${Trades.label(t)}`);
      } catch (er) { msg(er.message); }
    };
  }

  // ---------- journal ----------
  function vJournal() {
    const per = S.trPer || 'month', box = $('#trBody'), now = Date.now(), ist = new Date(now + 5.5 * 3600e3), from = per === 'week' ? now - ((ist.getUTCDay() + 6) % 7) * 864e5 - ((ist.getUTCHours() * 60 + ist.getUTCMinutes()) * 60e3) : per === 'month' ? Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600e3 : 0;
    const L = Trades.closed().filter(t => t.closedAt >= from), s = Trades.stats(L), all = Trades.closed().length;
    const stat = (k, v, c) => `<div class="tr-st"><span>${k}</span><b class="${c || ''}">${v}</b></div>`, grp = g => Object.entries(g).sort((a, b) => b[1].net - a[1].net).map(([k, v]) => `<div class="tr-g"><span>${esc(k)}</span><span>${v.n} trades · ${Math.round(v.w / v.n * 100)}% win</span><b class="${cl(v.net)}">${sg(v.net)}${inr(v.net, 0)}</b></div>`).join('');
    box.innerHTML = `<div class="chips" id="jPer">${[['week', 'This week'], ['month', 'This month'], ['all', 'All']].map(([k, n]) => `<button class="chip ${per === k ? 'on' : ''}" data-v="${k}">${n}</button>`).join('')}</div>
      ${!s.n ? `<div class="card note">${all ? 'No closed trades in this period.' : 'Closed trades show up here with P&L after charges, R multiple and stats.'}</div>` : `
      <div class="card"><div class="pf-s1"><div><div class="note">Net P&amp;L (after charges)</div><div class="pf-p ${cl(s.total)}" id="jNet">${sg(s.total)}${inr(s.total)}</div></div><div style="text-align:right"><div class="note">Gross ${sg(s.gross)}${inr(s.gross)}</div><div class="note">Charges ${inr(s.charges)}</div></div></div>
        <div class="tr-stats">${stat('Trades', s.n)}${stat('Win rate', s.winRate.toFixed(0) + '%')}${stat('Avg win', inr(s.avgWin, 0), 'up')}${stat('Avg loss', inr(s.avgLoss, 0), 'dn')}${stat('Profit factor', s.pf === Infinity ? '∞' : s.pf.toFixed(2))}${stat('Expectancy', sg(s.exp) + inr(s.exp, 0) + (s.expR != null ? ' · ' + sg(s.expR) + s.expR.toFixed(2) + 'R' : ''), cl(s.exp))}${stat('Best', s.best ? inr(s.best.r.net, 0) + ' ' + esc(s.best.t.sym) : '–', 'up')}${stat('Worst', s.worst ? inr(s.worst.r.net, 0) + ' ' + esc(s.worst.t.sym) : '–', 'dn')}</div></div>
      <div class="card"><h3 style="margin-top:0">Equity curve</h3><div id="jCurve" class="tr-curve"></div></div>
      <div class="card"><h3 style="margin-top:0">By type</h3>${grp(s.byType)}<h3>By tag / strategy</h3>${grp(s.byTag)}</div>
      <div id="jList">${L.map(t => { const r = Trades.realised(t); return `<div class="card tr-j" data-id="${t.id}"><div class="tr-h"><div><b>${esc(Trades.label(t))}</b> <span class="pf-badge ${t.side === 'BUY' ? 'pf-good' : 'pf-bad'}">${t.side}</span>${t.tag ? `<span class="tr-tag">${esc(t.tag)}</span>` : ''}<div class="mu tr-n">${t.q0} · ${px2(t.entry)} → ${px2(r.exitAvg)} · ${dur(Trades.holdMs(t))}</div></div><div style="text-align:right"><b class="${cl(r.net)}">${sg(r.net)}${inr(r.net)}</b><div class="mu tr-n">${r.R != null ? sg(r.R) + r.R.toFixed(2) + 'R · ' : ''}${dmy(t.closedAt)}</div></div></div>
        <div class="tr-more"><div class="note">Gross ${sg(r.gross)}${inr(r.gross)} · charges ${inr(r.charges)} · net ${sg(r.net)}${inr(r.net)}${t.note ? '<br>📝 ' + esc(t.note) : ''}</div><div class="pf-btns"><button class="btn sm g" data-a="re">Reopen</button><button class="btn sm g" data-a="del" style="color:var(--dn)">Delete</button></div></div></div>`; }).join('')}</div>`}
      <div class="pf-tools"><button class="btn sm g" id="jExp">⬆ Export CSV (copy)</button><button class="btn sm g" id="jImpF">📄 Import CSV</button><button class="btn sm g" id="jImpP">📋 Paste CSV</button></div>
      <div class="note tr-foot">Charges are estimated (brokerage, STT, exchange, SEBI, stamp, GST) with current Indian retail rates; your contract note is the final word. A win means net P&amp;L above zero.</div>`;
    document.querySelectorAll('#jPer .chip').forEach(b => b.onclick = () => { S.trPer = b.dataset.v; vJournal(); });
    const jl = $('#jList'); if (jl) jl.onclick = ev => { const card = ev.target.closest('.tr-j'); if (!card) return; const a = ev.target.closest('[data-a]'); if (a) { if (a.dataset.a === 're') { Trades.reopen(card.dataset.id); vJournal(); } else if (confirm('Delete this journal entry?')) { Trades.remove(card.dataset.id); vJournal(); } return; } card.classList.toggle('open'); };
    $('#jExp').onclick = () => copyOut(Trades.toCSV(Trades.closed()), 'Journal CSV copied');
    $('#jImpF').onclick = () => sheet(`<h3>Import journal CSV</h3><label class="pf-file"><input type="file" id="iFile" accept=".csv,.txt,text/csv,text/plain"><span>📄 Choose CSV file</span></label><div class="note">Use a CSV exported from here (columns: symbol, type, side, qty, entry, exit …).</div><div class="note" id="iMsg"></div>`, () => { $('#iFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => doImport(String(rd.result)); rd.readAsText(f); }; });
    $('#jImpP').onclick = () => sheet(`<h3>Paste journal CSV</h3><textarea id="iText" class="inp" style="height:170px;font-family:monospace;font-size:12px" placeholder="symbol,type,side,qty,entry,exit,..."></textarea><button class="btn w" id="iGo">Import</button><div class="note" id="iMsg"></div>`, () => { $('#iGo').onclick = () => doImport($('#iText').value); });
    const c = $('#jCurve'); if (c && s.curve.length) drawCurve(c, s.curve);
  }
  function doImport(text) {
    try { const r = Trades.importCSV(text); closeTrSheet(); toast(`${r.added} imported${r.skipped ? ', ' + r.skipped + ' skipped' : ''}`); vJournal(); } catch (e) { const m = $('#iMsg'); if (m) m.textContent = e.message; }
  }
  function drawCurve(el, pts) {
    const LW = window.LightweightCharts; if (!LW) { el.textContent = pts.map(p => p.v).join(' → '); return; }
    const ch = LW.createChart(el, { autoSize: true, height: 170, layout: { background: { color: 'transparent' }, textColor: '#8a97a6', fontSize: 10, attributionLogo: false }, grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,.05)' } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true } });
    const up = pts[pts.length - 1].v >= 0, ls = ch.addLineSeries({ color: up ? '#22c56c' : '#f25c5c', lineWidth: 2, priceLineVisible: false });
    let last = 0; const data = [{ time: Math.floor(pts[0].t / 1000) - 60, value: 0 }]; last = data[0].time; for (const p of pts) { let t = Math.floor(p.t / 1000); if (t <= last) t = last + 1; last = t; data.push({ time: t, value: p.v }); }
    ls.setData(data); ch.timeScale().fitContent();
  }

  // ---------- Home card ----------
  window.tradesCardHTML = () => {
    const sm = Trades.summary(); if (!sm.n) return '';
    return `<div class="card pf-home tr-home" id="trHome"><div class="pf-s1"><div><div class="note">📈 Open trades</div><b class="pf-v">${sm.n}</b></div><div style="text-align:right"><div class="note">Live P&amp;L</div><b class="tr-hp ${cl(sm.pnl)}">${sm.priced ? sg(sm.pnl) + inr(sm.pnl) : '–'}</b></div></div></div>`;
  };
  function paintHome() {
    const c = $('#trHome'); if (!c) return; const sm = Trades.summary(), h = `${sm.n}|${sm.priced}|${sm.pnl}`; if (c.dataset.h === h) return; c.dataset.h = h;
    c.querySelector('.pf-v').textContent = sm.n; const p = c.querySelector('.tr-hp'); p.textContent = sm.priced ? sg(sm.pnl) + inr(sm.pnl) : '–'; p.className = 'tr-hp ' + cl(sm.pnl);
  }
  window.bindTradesCard = () => { const c = $('#trHome'); if (!c) return; c.onclick = () => { S.savedSeg = 'tr'; S.trSub = 'open'; go('saved'); }; Trades.tick({ force: true }).catch(() => {}); };
})();
