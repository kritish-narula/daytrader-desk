/* DayTrader Desk — professional option chain + F&O call cards (options agent, round 4).
   vChain(): full chain screen (router key 'chain'; open with openChain(und, exp)).
   callCardHTML(o): the BUY/NO-TRADE card used by the F&O tab (app.js optCard → here for India).
   Contract sheet (tap a strike), call calculator ("Buy CE/PE"), "Track this trade" → Trades.openAdd(prefill).
   Data + maths: www/optchain.js (window.OC). Nothing here places orders. */
'use strict';
(function () {
  const IDXN = { NIFTY: 'Nifty 50', BANKNIFTY: 'Bank Nifty', FINNIFTY: 'Fin Nifty', MIDCPNIFTY: 'Midcap Select', SENSEX: 'Sensex', BANKEX: 'Bankex', NIFTYNXT50: 'Nifty Next 50' };
  const nm = u => IDXN[u] || u;
  const R = x => '₹' + fmt(x);
  const k0 = k => fmt(k, k % 1 ? 2 : 0);
  const tm = t => t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  const expTxt = (e, now) => `${OC.expLabel(e)} · ${OC.dayName(e)} · ${OC.tradingDaysLeft(e, now)}d left`;
  const srcCls = s => s === 'Model' ? 'oc-src est' : /mStock/.test(s) ? 'oc-src oc-on' : 'oc-src';
  const TRK = {}; let trkN = 0;
  const trackBtn = (pre, label = '📈 Track this trade') => { const id = 't' + (++trkN); TRK[id] = pre; return `<button class="btn sm" data-track="${id}">${label}</button>`; };
  function track(pre) {
    if (window.Trades && Trades.openAdd) { const sh = document.querySelector('.sheet'); if (sh) sh.remove(); Trades.openAdd(pre); }
    else toast('Trade tracker is not available in this build yet');
  }
  const contractName = (und, exp, k, cp) => `${und} ${OC.expLabel(exp).toUpperCase()} ${k0(k)} ${cp}`;
  function prefill(o) { // o: {und, exp, k, cp, key, lot, entry, sl, t1, t2, slU, t1U, t2U, note, source}
    const lot = o.lot || 0;
    return { kind: 'OPT', mkt: 'IN', und: o.und, sym: contractName(o.und, o.exp, o.k, o.cp), exp: o.exp, strike: o.k, cp: o.cp, k: o.key || null, lot, lots: 1, qty: lot, side: 'BUY',
      entry: o.entry != null ? +(+o.entry).toFixed(2) : null, sl: o.sl != null ? +(+o.sl).toFixed(2) : null, t1: o.t1 != null ? +(+o.t1).toFixed(2) : null, t2: o.t2 != null ? +(+o.t2).toFixed(2) : null,
      slU: o.slU != null ? +(+o.slU).toFixed(2) : null, t1U: o.t1U != null ? +(+o.t1U).toFixed(2) : null, t2U: o.t2U != null ? +(+o.t2U).toFixed(2) : null, note: o.note || '', source: o.source || 'chain' };
  }
  // clicks anywhere: [data-oc] → chain, [data-track] → tracker (capture: wins over the list row's own click)
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-oc]'); if (a) { e.preventDefault(); e.stopPropagation(); openChain(a.dataset.oc, a.dataset.exp || null); return; }
    const t = e.target.closest('[data-track]'); if (t && TRK[t.dataset.track]) { e.preventDefault(); e.stopPropagation(); track(TRK[t.dataset.track]); }
  }, true);

  // =====================================================================================================
  // Option chain screen
  // =====================================================================================================
  const COLS = {
    oi: { h: 'OI', bar: 1 }, doi: { h: 'ΔOI' }, vol: { h: 'Vol' }, iv: { h: 'IV' }, delta: { h: 'Δ' }, theta: { h: 'Θ/d' }, ba: { h: 'Bid/Ask' }, ltp: { h: 'LTP' },
  };
  const ORDER = ['oi', 'doi', 'vol', 'iv', 'delta', 'theta', 'ba', 'ltp']; // outer → inner (LTP next to the strike)
  window.openChain = function (und, exp) { S.chainReq = { und: String(und).toUpperCase(), exp: exp || null }; if (S.tab === 'chain') render(); else go('chain'); };
  function colsFor(ch) {
    let c = store.get('ocCols', ['oi', 'doi', 'ltp']).filter(x => COLS[x]);
    if (!ch.hasOI) c = c.filter(x => x !== 'oi' && x !== 'doi');
    if (!ch.hasVol) c = c.filter(x => x !== 'vol');
    for (const x of ['ltp', 'iv', 'delta']) if (c.length < 3 && !c.includes(x)) c.push(x);
    return ORDER.filter(x => c.includes(x)).slice(-3);
  }
  function cell(c, x, sd, ch) {
    if (!x) return `<i class="oc-c"></i>`;
    const an = ch.an || {}, it = x.itm ? ' itm' : '';
    switch (c) {
      case 'oi': { const mx = sd === 'ce' ? an.maxCeOI : an.maxPeOI, w = mx ? Math.round((x.oi || 0) / mx * 100) : 0; return `<i class="oc-c oi${it}"><b style="width:${w}%"></b><span>${OC.cmp(x.oi)}</span></i>`; }
      case 'doi': return `<i class="oc-c${it}"><span class="${x.doi > 0 ? 'up' : x.doi < 0 ? 'dn' : ''}">${x.doi > 0 ? '+' : ''}${OC.cmp(x.doi)}</span>${x.interp ? `<small class="it ${x.interp}">${x.interp}</small>` : ''}</i>`;
      case 'vol': return `<i class="oc-c${it}">${OC.cmp(x.vol)}</i>`;
      case 'iv': return `<i class="oc-c${it}">${x.iv ? (x.iv * 100).toFixed(1) : '–'}</i>`;
      case 'delta': return `<i class="oc-c${it}">${x.g ? x.g.delta.toFixed(2) : '–'}</i>`;
      case 'theta': return `<i class="oc-c${it}">${x.g ? x.g.theta.toFixed(1) : '–'}</i>`;
      case 'ba': return `<i class="oc-c ba${it}"><span>${x.bid ? fmt(x.bid) : '–'}</span><span>${x.ask ? fmt(x.ask) : '–'}</span></i>`;
      case 'ltp': return `<i class="oc-c ltp${it}"><b>${x.ltp ? fmt(x.ltp) : '–'}</b>${x.pchg ? `<small class="${x.pchg >= 0 ? 'up' : 'dn'}">${x.pchg >= 0 ? '+' : ''}${x.pchg.toFixed(1)}%</small>` : ''}</i>`;
    }
    return '<i class="oc-c"></i>';
  }
  function ladderHTML(ch) {
    const C = S.chain, cols = colsFor(ch), an = ch.an || {}, n = C.all ? 999 : 10;
    const atmI = ch.rows.findIndex(r => r.k === an.atm), lo = Math.max(0, atmI - n), rows = ch.rows.slice(lo, atmI + n + 1);
    const grid = `grid-template-columns:${'1fr '.repeat(cols.length)}62px ${'1fr '.repeat(cols.length)}`;
    let out = `<div class="oc-h" style="${grid}"><span style="grid-column:span ${cols.length}">CALLS</span><span></span><span style="grid-column:span ${cols.length}">PUTS</span></div>
      <div class="oc-sh" style="${grid}">${cols.map(c => `<span>${COLS[c].h}</span>`).join('')}<span>Strike</span>${cols.slice().reverse().map(c => `<span>${COLS[c].h}</span>`).join('')}</div>`;
    let spotDone = false;
    rows.forEach((r, i) => {
      if (!spotDone && r.k > ch.spot) { out += `<div class="oc-spot"><span>${esc(ch.und)} ${fmt(ch.spot)}</span></div>`; spotDone = true; }
      const tags = (r.k === an.res ? '<small class="oc-tg r">R</small>' : '') + (r.k === an.sup ? '<small class="oc-tg s">S</small>' : '') + (r.k === an.maxPain ? '<small class="oc-tg mp">MP</small>' : '');
      out += `<div class="oc-r${r.k === an.atm ? ' atm' : ''}" data-k="${r.k}" style="${grid}">${cols.map(c => cell(c, r.ce, 'ce', ch)).join('')}<i class="oc-k"><b>${k0(r.k)}</b>${tags}</i>${cols.slice().reverse().map(c => cell(c, r.pe, 'pe', ch)).join('')}</div>`;
    });
    if (!spotDone) out += `<div class="oc-spot"><span>${esc(ch.und)} ${fmt(ch.spot)}</span></div>`;
    return out;
  }
  function headHTML(ch) {
    const an = ch.an || {}, now = Date.now(), pc = an.pcr, ivp = an.atmIV ? (an.atmIV * 100).toFixed(1) + '%' : '–';
    const em = an.expMove || an.sigMove;
    return `<div class="oc-top"><div><div class="oc-u">${esc(nm(ch.und))}${ch.lot ? ` <span class="mu">· lot ${ch.lot}</span>` : ''}</div><div class="oc-px"><b>${fmt(ch.spot)}</b> ${ch.spotChg != null ? pct(ch.spotChg) : ''}</div></div>
      <label class="oc-exp"><span>Expiry</span><select id="ocExp">${ch.expiries.map(e => `<option value="${e}" ${e === ch.exp ? 'selected' : ''}>${expTxt(e, now)}</option>`).join('')}</select></label></div>
     <div class="oc-stats">
      <div><span>PCR (OI)</span><b class="${pc == null ? '' : pc >= 1.1 ? 'up' : pc <= 0.8 ? 'dn' : ''}">${pc == null ? '–' : pc.toFixed(2)}</b>${an.pcrVol ? `<small>Vol ${an.pcrVol.toFixed(2)}</small>` : ''}</div>
      <div><span>Max pain</span><b>${an.maxPain != null ? k0(an.maxPain) : '–'}</b></div>
      <div><span>ATM IV</span><b>${ivp}</b>${an.skew ? `<small>skew ${an.skew.pts > 0 ? '+' : ''}${an.skew.pts}</small>` : ''}</div>
      <div><span>Exp. move</span><b>±${em ? fmt(em, 0) : '–'}</b><small>${em ? `${fmt(ch.spot - em, 0)}–${fmt(ch.spot + em, 0)}` : ''}</small></div>
      <div><span>Support</span><b class="up">${an.sup != null ? k0(an.sup) : '–'}</b><small>${an.buildPE != null ? 'PE OI ↑ ' + k0(an.buildPE) : 'max PE OI'}</small></div>
      <div><span>Resistance</span><b class="dn">${an.res != null ? k0(an.res) : '–'}</b><small>${an.buildCE != null ? 'CE OI ↑ ' + k0(an.buildCE) : 'max CE OI'}</small></div>
     </div>
     <div class="${srcCls(ch.src)}" id="ocSrc">${esc(ch.src === 'Model' ? 'ESTIMATED PREMIUMS' : ch.src)} · ${tm(ch.liveAt || ch.ts || ch.at)}${S.chain.every ? ` · auto ${S.chain.every}s` : ''}<div class="oc-srcn">${esc(ch.srcNote || '')}</div>${ch.notes.length ? `<div class="oc-srcn">${ch.notes.map(esc).join(' · ')}</div>` : ''}</div>`;
  }
  function drawChain() {
    const C = S.chain, ch = C.ch, box = $('#ocBox'); if (!box || !ch) return;
    const cols = colsFor(ch);
    box.innerHTML = `<div class="card oc-hd">${headHTML(ch)}</div>
     <div class="oc-cols"><span class="note">Columns (pick up to 3 per side)</span><div class="chips wrap">${ORDER.filter(c => (ch.hasOI || (c !== 'oi' && c !== 'doi')) && (ch.hasVol || c !== 'vol')).map(c => `<button data-col="${c}" class="${cols.includes(c) ? 'on' : ''}">${COLS[c].h}</button>`).join('')}</div></div>
     <div class="oc-tbl" id="ocTbl">${ladderHTML(ch)}</div>
     <button class="btn g w" id="ocAll" style="margin-top:8px">${C.all ? 'Show ±10 strikes' : `Show all ${ch.rows.length} strikes`}</button>
     <div class="oc-leg note">Shaded = in the money · <b class="oc-tg r">R</b> max call OI (resistance) · <b class="oc-tg s">S</b> max put OI (support) · <b class="oc-tg mp">MP</b> max pain ·
      ${ch.hasOI ? '<b class="it LB">LB</b> long build-up (price↑ OI↑) · <b class="it SB">SB</b> short build-up (price↓ OI↑) · <b class="it SC">SC</b> short covering (price↑ OI↓) · <b class="it LU">LU</b> long unwinding (price↓ OI↓) · ' : ''}
      IV and Greeks: Black-Scholes, r 6.5%, time to 15:30 IST on expiry day${ch.src !== 'Model' && ch.rows.some(r => r.ce && r.ce.ivSrc) ? ' (IV from NSE; solved from the live price when mStock updates it)' : ' (IV solved from the premium)'}. Expected move = ATM straddle. Tap a strike for the contract, Greeks and payoff.</div>
     <p class="note">Not investment advice. Options can lose 100% of the premium quickly.</p>`;
    bindChain();
  }
  function bindChain() {
    const C = S.chain;
    const ex = $('#ocExp'); if (ex) ex.onchange = () => loadChain(ex.value);
    document.querySelectorAll('[data-col]').forEach(b => b.onclick = () => {
      let c = colsFor(C.ch); const x = b.dataset.col;
      if (c.includes(x)) { if (c.length > 1) c = c.filter(y => y !== x); } else { c.push(x); if (c.length > 3) c = c.slice(1); }
      store.set('ocCols', c); drawChain();
    });
    const a = $('#ocAll'); if (a) a.onclick = () => { C.all = !C.all; drawChain(); };
    const t = $('#ocTbl'); if (t) t.onclick = e => { const r = e.target.closest('.oc-r'); if (r) contractSheet(C.ch, +r.dataset.k); };
  }
  async function loadChain(exp, force) {
    const C = S.chain, box = $('#ocBox'); if (!box) return;
    if (!C.ch || C.ch.exp !== exp) box.innerHTML = `<div class="empty"><span class="spin"></span> Loading ${esc(C.und)} option chain…</div>`;
    try {
      const ch = await OC.get(C.und, exp, { force });
      if (S.tab !== 'chain' || S.chain !== C) return;
      C.ch = ch; C.exp = ch.exp; drawChain(); startTimer();
    } catch (e) { box.innerHTML = `<div class="card"><b>${esc(C.und)}</b><div class="note dn">Could not load the option chain: ${esc(e.message)}</div><button class="btn sm" id="ocRetry" style="margin-top:8px">Retry</button></div>`; $('#ocRetry').onclick = () => loadChain(exp, true); }
  }
  function startTimer() {
    const C = S.chain; clearInterval(S.timer); S.timer = null; C.every = 0;
    if (!marketOpen('IN')) return;
    const live = window.MS && MS.ok() && C.ch && C.ch.src !== 'Model' && C.ch.rows.some(r => (r.ce && r.ce.key) || (r.pe && r.pe.key));
    C.every = live ? 3 : 30; let k = 0, busy = false;
    S.timer = setInterval(async () => {
      if (S.tab !== 'chain' || document.hidden || busy) return; busy = true;
      try {
        k++;
        if (!live || k % 10 === 0) { // NSE refresh every 30 s (OI, volume, IV)
          const ch = await OC.get(C.und, C.exp, { force: true }); if (S.tab === 'chain' && S.chain === C) { C.ch = ch; redraw(); }
        } else if (await OC.overlay(C.ch, C.all ? 25 : 10)) { if (!/mStock/.test(C.ch.src)) C.ch.src = 'NSE + mStock LTP'; redraw(); }
      } catch (e) {} finally { busy = false; }
    }, live ? 3000 : 30000);
  }
  function redraw() { // keep scroll position; only the head + ladder
    const hd = document.querySelector('.oc-hd'), t = $('#ocTbl'); if (!hd || !t) return drawChain();
    const sel = $('#ocExp'), open = document.activeElement === sel; if (open) return; // don't yank the expiry picker
    hd.innerHTML = headHTML(S.chain.ch); t.innerHTML = ladderHTML(S.chain.ch); const ex = $('#ocExp'); if (ex) ex.onchange = () => loadChain(ex.value);
  }
  window.vChain = function () {
    const req = S.chainReq || { und: 'NIFTY' }, prev = S.chain;
    S.chain = prev && prev.und === req.und ? Object.assign(prev, { ch: prev.ch }) : { und: req.und, exp: req.exp, all: false };
    if (req.exp) S.chain.exp = req.exp;
    document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.t === 'fno'));
    const und = S.chain.und, isStock = !OC.isIndex(und);
    const quick = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
    $('#view').innerHTML = `<div class="oc-nav"><button class="back" id="ocBack">‹</button><b>Option chain</b>${isStock ? `<a class="note" id="ocDet">${esc(und)} analysis ›</a>` : ''}</div>
     <div class="chips wrap" id="ocU">${quick.map(u => `<button data-u="${u}" class="${u === und ? 'on' : ''}">${esc(nm(u))}</button>`).join('')}${isStock ? `<button class="on">${esc(und)}</button>` : ''}</div>
     <div class="search oc-q"><input id="ocQ" placeholder="Any F&O stock, e.g. RELIANCE" autocomplete="off" autocapitalize="characters"></div>
     <div id="ocBox"><div class="empty"><span class="spin"></span> Loading ${esc(und)} option chain…</div></div>`;
    $('#ocBack').onclick = () => back();
    const d = $('#ocDet'); if (d) d.onclick = () => openDetail(und, 'swing');
    document.querySelectorAll('#ocU [data-u]').forEach(b => b.onclick = () => openChain(b.dataset.u));
    const q = $('#ocQ'); q.onkeydown = e => { if (e.key === 'Enter') { const s = q.value.trim().toUpperCase(); if (!s) return; if (typeof isFno === 'function' && !isFno(s)) { toast(s + ' is not in the F&O list'); return; } openChain(s); } };
    if (S.chain.ch && S.chain.ch.und === und && (!req.exp || S.chain.ch.exp === req.exp)) { drawChain(); startTimer(); } else loadChain(S.chain.exp || null);
  };

  // =====================================================================================================
  // Contract sheet (tap a strike)
  // =====================================================================================================
  function payoffSVG(K, cp, prem, lot, S0, em, W = 340, H = 120) {
    const span = Math.max(em * 2.2 || 0, S0 * 0.03, Math.abs(K - S0) * 1.6), lo = S0 - span, hi = S0 + span, q = Math.max(lot, 1);
    const pay = s => ((cp === 'CE' ? Math.max(0, s - K) : Math.max(0, K - s)) - prem) * q;
    const xs = []; for (let i = 0; i <= 60; i++) xs.push(lo + (hi - lo) * i / 60);
    const ys = xs.map(pay), yMax = Math.max(...ys, prem * q * 0.5), yMin = Math.min(...ys), pad = 14;
    const X = s => pad + (s - lo) / (hi - lo) * (W - 2 * pad), Y = v => pad + (yMax - v) / (yMax - yMin || 1) * (H - 2 * pad);
    const be = K + (cp === 'CE' ? prem : -prem), path = xs.map((s, i) => `${i ? 'L' : 'M'}${X(s).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join('');
    return `<svg class="oc-pay" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">
      <line x1="${pad}" x2="${W - pad}" y1="${Y(0)}" y2="${Y(0)}" class="z"/>
      <path d="${path}" class="pl"/>
      <line x1="${X(S0)}" x2="${X(S0)}" y1="${pad}" y2="${H - pad}" class="sp"/><text x="${X(S0) + 3}" y="${pad + 8}">spot</text>
      ${be > lo && be < hi ? `<circle cx="${X(be)}" cy="${Y(0)}" r="3" class="be"/><text x="${X(be) + 4}" y="${Y(0) - 5}">BE ${fmt(be, 0)}</text>` : ''}
      <text x="${pad}" y="${H - 2}">${fmt(lo, 0)}</text><text x="${W - pad}" y="${H - 2}" text-anchor="end">${fmt(hi, 0)}</text>
      <text x="${W - pad}" y="${Y(ys[cp === 'CE' ? 60 : 0]) + (cp === 'CE' ? 12 : -4)}" text-anchor="end" class="up">${cp === 'CE' ? '+' + OC.cmp(ys[60]) : ''}</text>
      <text x="${pad}" y="${Y(ys[cp === 'CE' ? 0 : 60]) - 4}" class="dn">${cp === 'CE' ? '−' + OC.cmp(prem * q) : ''}</text></svg>`;
  }
  function sideBlock(ch, r, cp) {
    const x = cp === 'CE' ? r.ce : r.pe; if (!x) return `<div class="oc-sd"><b>${cp}</b><div class="note">Not listed</div></div>`;
    const g = x.g || {}, lot = ch.lot || 0, be = r.k + (cp === 'CE' ? 1 : -1) * x.ltp;
    const L = [['LTP', `${x.ltp ? R(x.ltp) : '–'} ${x.pchg ? pct(x.pchg) : ''}`], ['Bid / Ask', x.bid || x.ask ? `${fmt(x.bid)} / ${fmt(x.ask)}` : '–'],
      ['OI', x.oi != null ? OC.cmp(x.oi) : '–'], ['ΔOI', x.doi != null ? `${x.doi > 0 ? '+' : ''}${OC.cmp(x.doi)}${x.interp ? ` <small class="it ${x.interp}">${OC.INTERP[x.interp]}</small>` : ''}` : '–'],
      ['Volume', x.vol != null ? OC.cmp(x.vol) : '–'], ['IV', x.iv ? (x.iv * 100).toFixed(2) + '%' : '–'],
      ['Delta', g.delta != null ? g.delta.toFixed(3) : '–'], ['Gamma', g.gamma != null ? g.gamma.toFixed(5) : '–'], ['Theta /day', g.theta != null ? R(g.theta) : '–'], ['Vega /1%', g.vega != null ? R(g.vega) : '–'],
      ['Premium /lot', lot && x.ltp ? R(x.ltp * lot) : '–'], ['Breakeven', x.ltp ? fmt(be) : '–'], ['P(ITM) ≈', g.pitm != null ? Math.round(g.pitm * 100) + '%' : '–']];
    return `<div class="oc-sd ${cp === 'CE' ? 'ce' : 'pe'}"><b>${k0(r.k)} ${cp}</b>${x.itm ? ' <span class="tag">ITM</span>' : ''}<dl>${L.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl></div>`;
  }
  function contractSheet(ch, k) {
    const r = ch.rows.find(x => x.k === k); if (!r) return;
    const o = document.createElement('div'); o.className = 'sheet';
    const em = (ch.an || {}).expMove || (ch.an || {}).sigMove || ch.spot * 0.02;
    let cp = r.ce && r.ce.ltp ? (r.k >= ch.spot ? 'CE' : 'PE') : 'PE';
    const pf = side => { const x = side === 'CE' ? r.ce : r.pe; return x && x.ltp ? prefill({ und: ch.und, exp: ch.exp, k, cp: side, key: x.key, lot: ch.lot, entry: x.ltp, note: `From option chain ${tm(Date.now())} (${ch.src})`, source: 'chain' }) : null; };
    const draw = () => {
      const x = cp === 'CE' ? r.ce : r.pe;
      o.innerHTML = `<div class="sh-in oc-sheet"><div class="sh-h"><b>${esc(ch.und)} ${k0(k)} · ${OC.expLabel(ch.exp)}</b><button class="back" id="shx">✕</button></div>
        <div class="note">${OC.dayName(ch.exp)} · ${OC.tradingDaysLeft(ch.exp)} trading days left · spot ${fmt(ch.spot)} · lot ${ch.lot || '–'} · ${esc(ch.src === 'Model' ? 'estimated premiums' : ch.src)} ${tm(ch.liveAt || ch.ts || ch.at)}</div>
        <div class="oc-2">${sideBlock(ch, r, 'CE')}${sideBlock(ch, r, 'PE')}</div>
        <div class="oc-payh"><span>Payoff at expiry, 1 lot</span><div class="seg sm">${['CE', 'PE'].map(s => `<button data-cp="${s}" class="${s === cp ? 'on' : ''}">${s}</button>`).join('')}</div></div>
        ${x && x.ltp ? payoffSVG(k, cp, x.ltp, ch.lot, ch.spot, em) : '<div class="note">No price for this side.</div>'}
        <div class="oc-btns"><button class="btn" data-buy="CE" ${r.ce && r.ce.ltp ? '' : 'disabled'}>Buy CE</button><button class="btn" data-buy="PE" ${r.pe && r.pe.ltp ? '' : 'disabled'}>Buy PE</button></div>
        <div class="oc-btns">${pf('CE') ? trackBtn(pf('CE'), '📈 Track CE') : ''}${pf('PE') ? trackBtn(pf('PE'), '📈 Track PE') : ''}</div>
        <p class="note">P(ITM) is the risk-neutral probability N(d2), close to |delta|. Breakeven = strike ± premium at expiry. Not investment advice.</p></div>`;
      o.querySelector('#shx').onclick = () => o.remove();
      o.querySelectorAll('[data-cp]').forEach(b => b.onclick = () => { cp = b.dataset.cp; draw(); });
      o.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => { o.remove(); calcSheet(ch, k, b.dataset.buy); });
    };
    draw(); o.onclick = e => { if (e.target === o) o.remove(); }; document.body.appendChild(o);
  }

  // =====================================================================================================
  // Call calculator: plan the premium SL / targets from underlying levels
  // =====================================================================================================
  function calcSheet(ch, k, cp, plan) {
    const r = ch.rows.find(x => x.k === k), x = r && (cp === 'CE' ? r.ce : r.pe); if (!x || !x.g) { toast('No live price / Greeks for this contract'); return; }
    const dir = cp === 'CE' ? 1 : -1, S0 = ch.spot, em = (ch.an || {}).expMove || (ch.an || {}).sigMove || S0 * 0.015;
    const A = S.optO && S.optO[ch.und], L = plan || (A && A.L && A.side === cp ? A.L : null);
    const P = { slU: L ? L.stop : S0 - dir * 0.3 * em, t1U: L ? L.t1 : S0 + dir * 0.5 * em, t2U: L ? L.t2 : S0 + dir * em, hold: A && A.hzKey === 'intraday' ? 0.2 : 3, lots: 1 };
    const o = document.createElement('div'); o.className = 'sheet';
    const inp = (id, v, lbl) => `<label><span>${lbl}</span><input class="inp" id="${id}" type="number" inputmode="decimal" step="any" value="${+(+v).toFixed(2)}"></label>`;
    o.innerHTML = `<div class="sh-in oc-sheet"><div class="sh-h"><b>BUY ${esc(contractName(ch.und, ch.exp, k, cp))}</b><button class="back" id="shx">✕</button></div>
      <div class="note">${OC.dayName(ch.exp)} · ${OC.tradingDaysLeft(ch.exp)} trading days left · LTP ${R(x.ltp)} · Δ ${x.g.delta.toFixed(2)} · Γ ${x.g.gamma.toFixed(5)} · Θ ${R(x.g.theta)}/day · IV ${x.iv ? (x.iv * 100).toFixed(1) + '%' : '–'}${L ? ` · levels from the app's ${esc(A.hzLabel || 'analysis')} plan` : ' · levels from the expected move (edit them)'}</div>
      <div class="oc-form">${inp('cSl', P.slU, `${esc(ch.und)} stop`)}${inp('cT1', P.t1U, `${esc(ch.und)} target 1`)}${inp('cT2', P.t2U, `${esc(ch.und)} target 2`)}
       <label><span>Holding</span><select class="inp" id="cHold">${[[0.2, 'Intraday'], [1, '1 day'], [3, '3 days'], [5, '5 days']].map(([v, t]) => `<option value="${v}" ${v === P.hold ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
       ${inp('cLots', 1, 'Lots')}</div>
      <div id="cOut"></div></div>`;
    document.body.appendChild(o); o.onclick = e => { if (e.target === o) o.remove(); }; o.querySelector('#shx').onclick = () => o.remove();
    const calc = () => {
      const v = id => +o.querySelector('#' + id).value, slU = v('cSl'), t1U = v('cT1'), t2U = v('cT2'), hd = v('cHold'), lots = Math.max(1, Math.round(v('cLots')) || 1), lot = ch.lot || 1;
      const t05 = v => Math.round(v * 20) / 20, P0 = x.ltp, half = x.bid > 0 && x.ask > x.bid ? (x.ask - x.bid) / 2 : 0, slip = Math.max(half, P0 * 0.005, 0.05), eLo = t05(Math.max(0.05, P0 - slip)), eHi = t05(P0 + slip);
      const M = { iv: x.iv, T: OC.tYears(ch.exp), S0 };
      let sl = OC.project(P0, x.g, slU - S0, hd / 2, k, slU, cp, M); sl = t05(Math.max(Math.min(sl, P0 * (1 - OC.CFG.minSlPct)), P0 * (1 - OC.CFG.maxSlPct)));
      const t1 = t05(OC.project(P0, x.g, t1U - S0, hd / 2, k, t1U, cp, M)), t2 = t05(OC.project(P0, x.g, t2U - S0, hd, k, t2U, cp, M)), q = lots * lot, rr = (t1 - eHi) / Math.max(0.01, eHi - sl);
      const bad = dir * (slU - S0) >= 0 || dir * (t1U - S0) <= 0;
      o.querySelector('#cOut').innerHTML = bad ? `<div class="warn">For a ${cp} the stop must be ${dir > 0 ? 'below' : 'above'} spot (${fmt(S0)}) and the targets ${dir > 0 ? 'above' : 'below'} it.</div>` : `
       <div class="pc-grid"><div><span>Entry</span><b>${R(eLo)}–${fmt(eHi)}</b></div><div><span>Stop-loss</span><b class="dn">${R(sl)}</b></div><div><span>Target 1</span><b class="up">${R(t1)}</b></div><div><span>Target 2</span><b class="up">${R(t2)}</b></div></div>
       <div class="pc-grid"><div><span>Capital (${lots} lot${lots > 1 ? 's' : ''})</span><b>${R(eHi * q)}</b></div><div><span>Max loss</span><b class="dn">${R((eHi - sl) * q)}</b></div><div><span>At T1</span><b class="up">+${R((t1 - eHi) * q)}</b></div><div><span>Reward:risk</span><b class="${rr >= 1.5 ? 'up' : rr < 1.2 ? 'dn' : ''}">1:${rr.toFixed(2)}</b></div></div>
       <div class="note">Breakeven at expiry ${fmt(k + dir * P0)} · premium path = LTP + Δ·ΔS + ½Γ·ΔS² + Θ·days, capped by a full Black-Scholes re-price at the same IV (SL/T1 charged half the holding days). SL kept between ${Math.round(OC.CFG.minSlPct * 100)}% and ${Math.round(OC.CFG.maxSlPct * 100)}% below entry.</div>
       <div class="oc-btns">${trackBtn(prefill({ und: ch.und, exp: ch.exp, k, cp, key: x.key, lot: ch.lot, entry: P0, sl, t1, t2, slU, t1U, t2U, note: `Calculator ${tm(Date.now())} (${ch.src})`, source: 'chain' }))}</div>`;
      const pre = TRK['t' + trkN]; if (pre) { pre.lots = lots; pre.qty = q; }
    };
    o.querySelectorAll('input,select').forEach(i => i.oninput = i.onchange = calc); calc();
  }
  window.ocCalc = calcSheet;

  // =====================================================================================================
  // F&O call card (index + stock)
  // =====================================================================================================
  window.callCardHTML = function (o) {
    const A = o.A, c = o.call, ch = o.ch, dir = o.side === 'CE' ? 1 : -1;
    const head = `<div class="ohead"><div><b>${esc(nm(o.sym))}</b> <span class="mu">${fmt(ch ? ch.spot : A.price)} ${pct(ch && ch.spotChg != null ? ch.spotChg : A.chg)}</span></div>
      <span class="${ch ? srcCls(ch.src) : 'note wa'} pill">${ch ? (ch.src === 'Model' ? 'Estimated' : esc(ch.src.replace(' LTP', ''))) + ' ' + tm(ch.liveAt || ch.ts || ch.at) : esc(o.dataSrc || '')}</span></div>`;
    const scores = `<div class="cp"><div class="${o.side === 'CE' ? 'on' : ''}"><span>CALL (CE)</span><b class="${o.ce >= 65 ? 'up' : o.ce <= 40 ? 'dn' : 'wa'}">${o.ce}</b></div><div class="${o.side === 'PE' ? 'on' : ''}"><span>PUT (PE)</span><b class="${o.pe >= 65 ? 'up' : o.pe <= 40 ? 'dn' : 'wa'}">${o.pe}</b></div></div>`;
    const links = `<div class="oc-btns"><button class="btn g sm" data-oc="${esc(o.sym)}"${ch ? ` data-exp="${ch.exp}"` : ''}>⛓ Option chain</button><button class="btn g sm optOpen" data-sym="${esc(o.sym)}">Full analysis</button></div>`;
    if (!c || c.notrade) {
      return `<div class="card opt pc" id="opt_${o.sym}">${head}
        <div class="buyline b0"><b>NO TRADE</b><span>${esc(c ? c.notrade : o.callErr ? 'Option data error: ' + o.callErr : 'Analysing…')}</span></div>${scores}
        ${o.why && o.why.length ? `<ul class="why">${o.why.slice(0, 3).map(w => `<li>${w.w > 0 ? '<span class="up">▲</span>' : '<span class="dn">▼</span>'} ${esc(w.t)}</li>`).join('')}</ul>` : ''}
        ${!o.open ? '<div class="note">Market closed: plan for the next session. Re-check after 9:45 AM.</div>' : ''}${links}</div>`;
    }
    const sp = c.spread, lot = c.lot || 0, title = sp ? `BUY ${contractName(o.sym, c.exp, c.k, c.cp)} / SELL ${k0(sp.sellK)} ${c.cp}` : `BUY ${contractName(o.sym, c.exp, c.k, c.cp)}`;
    const pre = prefill({ und: o.sym, exp: c.exp, k: c.k, cp: c.cp, key: c.key, lot, entry: sp ? sp.buyPx : (c.entryLo + c.entryHi) / 2, sl: c.sl, t1: c.t1, t2: c.t2, slU: c.slU, t1U: c.t1U, t2U: c.t2U,
      note: `${c.hz === 'intraday' ? 'Intraday' : 'Swing'} call · conf ${c.conf} · R:R 1:${c.rr.toFixed(2)}${sp ? ` · debit spread: also SELL ${k0(sp.sellK)} ${c.cp} @ ${fmt(sp.sellPx)} (net ${fmt(sp.debit)})` : ''} · ${c.src}`, source: 'call' });
    return `<div class="card opt pc" id="opt_${o.sym}">${head}
      <div class="buyline ${dir > 0 ? 'b1' : 'b-1'}"><b>${esc(title)}</b><span>${OC.dayName(c.exp)} ${OC.expLabel(c.exp)} · ${c.daysLeft} trading day${c.daysLeft === 1 ? '' : 's'} left · lot ${lot || '–'} · ${c.hz === 'intraday' ? 'INTRADAY' : 'SWING'}${c.est ? ' · <b class="wa">ESTIMATED PREMIUMS</b>' : ''}</span></div>
      ${c.expWhy ? `<div class="note">${esc(c.expWhy)}</div>` : ''}
      ${sp ? `<div class="warn">IV is rich, so buy a <b>debit spread</b> instead of a naked ${c.cp}: BUY ${k0(sp.buyK)} ${c.cp} @ ₹${fmt(sp.buyPx)} + SELL ${k0(sp.sellK)} ${c.cp} @ ₹${fmt(sp.sellPx)} → net debit <b>₹${fmt(sp.debit)}</b> (₹${fmt(sp.maxLossLot, 0)}/lot = max loss) · max profit ₹${fmt(sp.maxProfit)} (₹${fmt(sp.maxProfitLot, 0)}/lot) at ${c.cp === 'CE' ? '≥' : '≤'} ${k0(sp.sellK)} · breakeven ${fmt(sp.be)} · R:R 1:${sp.rr}</div>` : ''}
      <div class="pc-grid"><div><span>Entry premium</span><b>₹${fmt(c.entryLo)}–${fmt(c.entryHi)}</b></div><div><span>Stop-loss</span><b class="dn">₹${fmt(c.sl)}</b></div><div><span>Target 1</span><b class="up">₹${fmt(c.t1)}</b></div><div><span>Target 2</span><b class="up">₹${fmt(c.t2)}</b></div></div>
      <div class="lv3"><span>${esc(o.sym)} entry <b>${fmt(c.entryU)}</b></span><span>SL <b class="dn">${fmt(c.slU)}</b></span><span>T1 <b class="up">${fmt(c.t1U)}</b></span><span>T2 <b class="up">${fmt(c.t2U)}</b></span><span>spot <b>${fmt(c.spot)}</b></span></div>
      <div class="pc-grid sm"><div><span>Prem/lot</span><b>₹${fmt(c.perLot, 0)}</b></div><div><span>Cap/lot</span><b>₹${fmt(c.capLot, 0)}</b></div><div><span>Loss/lot</span><b class="dn">₹${fmt(c.maxLossLot, 0)}</b></div><div><span>R:R</span><b class="${c.rr >= 1.5 ? 'up' : ''}">1:${c.rr.toFixed(2)}</b><small>T2 1:${c.rr2.toFixed(1)}</small></div></div>
      <div class="note pc-g">Δ ${c.g.delta.toFixed(2)} · Γ ${c.g.gamma.toFixed(4)} · Θ ₹${fmt(c.g.theta)}/day · Vega ₹${fmt(c.g.vega)} · IV ${c.iv ? (c.iv * 100).toFixed(1) + '%' : '–'}${c.oi ? ` · OI ${OC.cmp(c.oi)}` : ''}${c.vol ? ` · Vol ${OC.cmp(c.vol)}` : ''}${c.bid && c.ask ? ` · bid/ask ${fmt(c.bid)}/${fmt(c.ask)}` : ''} · BE ${fmt(c.be)} at expiry · P(ITM) ≈ ${Math.round(c.pitm * 100)}%</div>
      ${c.slCapped ? `<div class="note wa">Premium SL is capped at ${Math.round(OC.CFG.maxSlPct * 100)}% of entry: exit at ₹${fmt(c.sl)} even if ${esc(o.sym)} hasn't reached ${fmt(c.slU)}.</div>` : ''}
      <div class="pc-time"><div><span>⏱ Entry</span>${esc(c.window)}</div><div><span>🚪 Exit</span>${esc(c.exitBy)}</div><div><span>✅ Valid</span>${esc(c.valid)}</div></div>
      <div class="pc-conf"><span>Confidence</span><i><b style="width:${c.conf}%" class="${c.conf >= 70 ? 'up' : 'wa'}"></b></i><b>${c.conf}</b></div>
      <ul class="why">${c.why.slice(0, 7).map(w => `<li>${w.w > 0 ? '<span class="up">▲</span>' : w.w < 0 ? '<span class="dn">▼</span>' : '<span class="mu">•</span>'} ${esc(w.t)}</li>`).join('')}
       <li><span class="mu">•</span> Strike: ${esc(c.strikeWhy)}</li>${c.warn.map(w => `<li><span class="wa">!</span> ${esc(w)}</li>`).join('')}</ul>
      <div class="oc-btns">${trackBtn(pre)}<button class="btn g sm" data-oc="${esc(o.sym)}" data-exp="${c.exp}">⛓ Option chain</button><button class="btn g sm optOpen" data-sym="${esc(o.sym)}">Analysis</button></div></div>`;
  };

  // top F&O stocks from the latest scan (strongest intraday/swing ratings either way)
  window.topFoCalls = function (n = 10) {
    const sc = S.scan.IN; if (!sc || !sc.rows) return [];
    const out = [];
    for (const r of sc.rows) {
      if (r.err || !isFno(r.sym) || OC.isIndex(r.sym) || ((S.fo || {})[r.sym] || {}).bseOnly) continue;
      let best = 0; for (const hz of ['swing', 'intraday']) { try { const x = hzRate(r, hz, 'IN'); if (x && isFinite(x.rating)) best = Math.max(best, Math.abs(x.rating - 50)); } catch (e) {} }
      if (best >= 15) out.push([r.sym, best]);
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
  };
})();
