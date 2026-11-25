/* Portfolio screen (inside the "Portfolio" tab, next to the Watchlist), add/import sheets, Home card. */
(() => {
  const vWatch = window.vSaved; // original watchlist view
  const cur = mkt => mkt === 'US' ? '$' : '₹';
  const money = (x, mkt) => { if (x == null || !isFinite(x)) return '–'; const a = Math.abs(x), c = cur(mkt); return (x < 0 ? '−' : '') + c + (mkt === 'IN' && a >= 1e7 ? (a / 1e7).toFixed(2) + ' Cr' : mkt === 'IN' && a >= 1e5 ? (a / 1e5).toFixed(2) + ' L' : a.toLocaleString(mkt === 'IN' ? 'en-IN' : 'en-US', { maximumFractionDigits: a < 100 ? 2 : 0 })); };
  const sgn = x => (x >= 0 ? '+' : '') ;
  const cls = x => x > 0 ? 'up' : x < 0 ? 'dn' : '';
  const TONE = { good: 'pf-good', bad: 'pf-bad', warn: 'pf-warn', neutral: 'pf-neu' };

  window.vSaved = function () {
    const seg = S.savedSeg || 'pf';
    $('#view').innerHTML = `<div class="chips pf-seg" id="pfSeg"><button class="chip ${seg === 'pf' ? 'on' : ''}" data-v="pf">💼 Portfolio</button><button class="chip ${seg === 'tr' ? 'on' : ''}" data-v="tr">📈 Trades</button><button class="chip ${seg === 'wl' ? 'on' : ''}" data-v="wl">⭐ Watchlist</button></div><div id="pfBody"></div>`;
    document.querySelectorAll('#pfSeg .chip').forEach(b => b.onclick = () => { S.savedSeg = b.dataset.v; vSaved(); });
    if (seg === 'wl') { const v = $('#view'), keep = v.innerHTML; vWatch(); v.insertAdjacentHTML('afterbegin', keep.replace('<div id="pfBody"></div>', '')); document.querySelectorAll('#pfSeg .chip').forEach(b => b.onclick = () => { S.savedSeg = b.dataset.v; vSaved(); }); return; }
    if (seg === 'tr' && window.vTrades) return vTrades($('#pfBody')); // trades agent hook: 📈 Trades segment
    vPortfolio();
  };

  function vPortfolio() {
    const mkt = S.mkt, L = Portfolio.list(mkt), box = $('#pfBody');
    const tools = `<div class="pf-tools"><button class="btn sm" id="pfAdd">＋ Add stock</button><button class="btn sm g" id="pfImp">📄 Import CSV</button><button class="btn sm g" id="pfPaste">📋 Paste</button>${mkt === 'IN' ? '<button class="btn sm g" id="pfMs">🔗 From mStock</button>' : ''}<button class="btn sm g" id="pfMore">⋯</button></div>`;
    if (!L.length) {
      box.innerHTML = `<div class="card pf-empty"><div class="pf-big">💼</div><b>Add your holdings</b><div class="note">Get a buy more / hold / book profit / sell call for every stock, with stop-loss, targets and when to act. Checked again every 10 minutes while the market is open, with alerts when the advice changes.</div>${tools}
        <div class="note" style="margin-top:10px">Import works with Zerodha Console, Groww, Upstox, Angel One, mStock and most broker CSV/Excel-saved-as-CSV exports, or a simple list like <code>RELIANCE 10 2450</code>. Holdings stay on this phone${window.Sec && Sec.hasPin() ? ', encrypted with your PIN' : ' (set a PIN in Settings to encrypt them)'}.</div></div>`;
      bindTools(); return;
    }
    const D = S.pf && S.pf[mkt];
    box.innerHTML = `<div id="pfSum">${D ? sumHTML(D.sum, mkt) : '<div class="card"><span class="spin"></span> Analysing your holdings…</div>'}</div>${tools}
      <div class="chips" id="pfF">${['All', 'Action needed', 'Sell / trim', 'Buy more', 'Hold'].map(f => `<button class="chip ${(S.pfF || 'All') === f ? 'on' : ''}">${f}</button>`).join('')}</div>
      <div id="pfList">${D ? listHTML(D.rows, mkt) : L.map(h => `<div class="card pf-row"><b>${esc(h.sym)}</b> <span class="mu">${h.qty} × ${cur(mkt)}${h.avg}</span> <span class="spin"></span></div>`).join('')}</div>
      <div id="pfSec">${D ? secHTML(D.sum) : ''}</div>
      <div class="note pf-foot">Advice uses the same engine as the scanner (trend, momentum, setups, chart patterns, news, your position size and profit). Stops trail upward. Not investment advice: you decide and place orders in your broker app.</div>`;
    bindTools(); bindList();
    document.querySelectorAll('#pfF .chip').forEach(b => b.onclick = () => { S.pfF = b.textContent; vPortfolio(); });
    if (!D || Date.now() - D.sum.at > 60e3) Portfolio.refresh(mkt).then(d => { if (S.tab === 'saved' && (S.savedSeg || 'pf') === 'pf' && S.mkt === mkt) { $('#pfSum').innerHTML = sumHTML(d.sum, mkt); $('#pfList').innerHTML = listHTML(d.rows, mkt); $('#pfSec').innerHTML = secHTML(d.sum); bindList(); } Portfolio.check && Portfolio.check(mkt).catch(() => {}); }).catch(e => toast(e.message));
  }

  function sumHTML(s, mkt) {
    if (!s) return '';
    const warn = []; for (const [k, v] of Object.entries(s.secW || {})) if (v > 40) warn.push(`${k} is ${v.toFixed(0)}% of the portfolio`);
    if (s.beta > 1.25) warn.push(`high beta ${s.beta.toFixed(2)}: moves ~${(s.beta * 2).toFixed(1)}% when the index moves 2%`);
    return `<div class="card pf-sum"><div class="pf-s1"><div><div class="note">Current value</div><div class="pf-v">${money(s.total, mkt)}</div></div>
      <div style="text-align:right"><div class="note">Total P&amp;L</div><div class="pf-p ${cls(s.pnl)}">${sgn(s.pnl)}${money(s.pnl, mkt)} <small>(${sgn(s.pnlPct)}${s.pnlPct.toFixed(2)}%)</small></div></div></div>
      <div class="pf-s2"><span>Today <b class="${cls(s.day)}">${sgn(s.day)}${money(s.day, mkt)} (${sgn(s.dayPct)}${s.dayPct.toFixed(2)}%)</b></span><span>Invested <b>${money(s.cost, mkt)}</b></span><span>${s.n} stocks${s.beta != null ? ` · β ${s.beta.toFixed(2)}` : ''}</span></div>
      ${s.actions ? `<div class="pf-act">⚡ ${s.actions} need${s.actions === 1 ? 's' : ''} action${s.sells ? ` · ${s.sells} to sell/trim` : ''}</div>` : '<div class="pf-ok">✓ No action needed right now</div>'}
      ${warn.length ? `<div class="note wa" style="margin-top:6px">⚠ ${warn.map(esc).join(' · ')}</div>` : ''}
      <div class="note" style="margin-top:6px">${marketOpen(mkt) ? 'Live' : 'Market closed'} · checked ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>`;
  }
  const FILT = { 'Action needed': r => r.rec && r.rec.act !== 'HOLD', 'Sell / trim': r => r.rec && /SELL|TRIM|REDUCE|BOOK/.test(r.rec.act), 'Buy more': r => r.rec && r.rec.act === 'BUY MORE', 'Hold': r => r.rec && r.rec.act === 'HOLD' };
  const ORDER = { SELL: 0, TRIM: 1, REDUCE: 2, 'BOOK PARTIAL': 3, 'BUY MORE': 4, HOLD: 5 };
  function listHTML(rows, mkt) {
    const f = FILT[S.pfF] || (() => true), c = cur(mkt);
    const R = rows.filter(f).sort((a, b) => (ORDER[a.rec ? a.rec.act : 'HOLD'] ?? 9) - (ORDER[b.rec ? b.rec.act : 'HOLD'] ?? 9) || b.val - a.val);
    if (!R.length) return '<div class="card note">Nothing in this filter.</div>';
    return R.map(r => {
      const h = r.h, x = r.rec, pnl = r.val - r.cost, pp = h.avg > 0 ? (r.px / h.avg - 1) * 100 : 0, open = S.pfOpen === h.id;
      if (r.q.err || !r.px) return `<div class="card pf-row" data-id="${h.id}"><div class="pf-h"><b>${esc(h.sym)}</b><span class="mu">${h.qty} × ${c}${h.avg}</span></div><div class="note dn">No price data: ${esc(r.q.err || 'unknown symbol')}. Tap to edit.</div></div>`;
      return `<div class="card pf-row ${open ? 'open' : ''}" data-id="${h.id}">
        <div class="pf-h"><div><b>${esc(h.sym)}</b> <span class="pf-badge ${TONE[x.tone]}">${x.act}${x.sellQty ? ' ' + x.sellQty : x.addQty ? ' +' + x.addQty : ''}</span><div class="mu pf-n">${esc(nameOf(h.sym) || '')}</div></div>
          <div style="text-align:right"><b>${c}${fmt(r.px)}</b> <span class="${cls(r.q.chg)}">${sgn(r.q.chg)}${(r.q.chg || 0).toFixed(2)}%</span><div class="${cls(pnl)} pf-pl">${sgn(pnl)}${money(pnl, mkt)} (${sgn(pp)}${pp.toFixed(1)}%)</div></div></div>
        <div class="pf-why">${esc(x.why[0])}</div>
        <div class="pf-lv"><span>SL <b class="dn">${c}${fmt(x.stop)}</b></span><span>T1 <b class="up">${c}${fmt(x.t1)}</b></span><span>T2 <b class="up">${c}${fmt(x.t2)}</b></span><span>${h.qty} × ${c}${fmt(h.avg)} · ${r.w.toFixed(1)}%</span></div>
        <div class="pf-when">⏱ ${esc(x.when)}</div>
        ${open ? `<div class="pf-more">${x.why.slice(1).map(w => `<div>• ${esc(w)}</div>`).join('')}
          <div class="pf-hz">${['swing', 'short', 'medium', 'long'].map(k => { const v = (r.q.horizons || {})[k]; return v && !v.na ? `<span>${k} <b>${v.score}</b></span>` : ''; }).join('')}${r.R ? `<span>rating <b>${r.R.rating}</b></span>` : ''}</div>
          <div class="note">Confidence ${x.conf} · ${x.horizon}${h.stop ? ` · your stop ${c}${h.stop}` : ''}${h.date ? ` · bought ${esc(h.date)}` : ''}</div>
          <div class="pf-btns"><button class="btn sm" data-a="open">Chart & analysis</button><button class="btn sm g" data-a="edit">Edit</button><button class="btn sm g" data-a="del" style="color:var(--dn)">Remove</button></div></div>` : ''}
      </div>`;
    }).join('');
  }
  function secHTML(s) {
    const e = Object.entries(s.secW || {}).sort((a, b) => b[1] - a[1]); if (e.length < 2) return '';
    return `<div class="card"><h3 style="margin-top:0">Sector mix</h3>${e.map(([k, v]) => `<div class="pf-sec"><span>${esc(k)}</span><div class="pf-bar"><i style="width:${Math.min(100, v)}%" class="${v > 40 ? 'hot' : ''}"></i></div><b>${v.toFixed(0)}%</b></div>`).join('')}</div>`;
  }
  function bindList() {
    document.querySelectorAll('#pfList .pf-row').forEach(el => el.onclick = ev => {
      const id = el.dataset.id, a = ev.target.closest('[data-a]'), mkt = S.mkt, h = Portfolio.list(mkt).find(x => x.id === id); if (!h) return;
      if (a) { ev.stopPropagation(); if (a.dataset.a === 'open') openDetail(h.sym); else if (a.dataset.a === 'edit') sheetAdd(h); else if (a.dataset.a === 'del' && confirm(`Remove ${h.sym} from your portfolio?`)) { Portfolio.remove(mkt, id); if (S.pf) delete S.pf[mkt]; vPortfolio(); } return; }
      S.pfOpen = S.pfOpen === id ? null : id; const D = S.pf && S.pf[mkt]; if (D) { $('#pfList').innerHTML = listHTML(D.rows, mkt); bindList(); }
    });
  }
  function bindTools() {
    const on = (id, f) => { const b = $('#' + id); if (b) b.onclick = f; };
    on('pfAdd', () => sheetAdd()); on('pfImp', () => sheetImport('file')); on('pfPaste', () => sheetImport('paste'));
    on('pfMs', async () => {
      if (!(window.MS && MS.ok())) { toast('Log in to mStock first (Settings → mStock)'); return go('broker'); }
      const b = $('#pfMs'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try { const items = await Portfolio.fromMStock(); if (!items.length) toast('mStock returned no holdings'); else review(items, 'mStock holdings'); } catch (e) { toast('mStock: ' + e.message); }
      b.disabled = false; b.textContent = '🔗 From mStock';
    });
    on('pfMore', () => sheet(`<h3>Portfolio options</h3><div class="pf-opts">
      <button class="btn g w" id="oExp">⬆ Export as CSV (copy)</button><button class="btn g w" id="oTpl">📄 Copy CSV template</button>
      <button class="btn g w" id="oRef">↻ Re-check all now</button><button class="btn g w" id="oClr" style="color:var(--dn)">🗑 Remove all ${S.mkt === 'IN' ? 'India' : 'US'} holdings</button></div>
      <div class="note">Template columns: symbol, qty, avg_price, buy_date (optional). Symbols like RELIANCE, NSE:RELIANCE, RELIANCE.NS, company names and ISINs all work.</div>`, () => {
      $('#oExp').onclick = () => copyOut(Portfolio.toCSV(S.mkt), 'Portfolio CSV copied'); $('#oTpl').onclick = () => copyOut(Portfolio.template, 'Template copied — paste it into a note or sheet');
      $('#oRef').onclick = () => { closeSheet(); if (S.pf) delete S.pf[S.mkt]; vPortfolio(); };
      $('#oClr').onclick = () => { if (confirm('Remove every holding in this market from the app?')) { Portfolio.clear(S.mkt); if (S.pf) delete S.pf[S.mkt]; closeSheet(); vPortfolio(); } };
    }));
  }
  function copyOut(text, msg) {
    const done = () => toast(msg);
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text).then(done) : Promise.reject()).catch(() => sheet(`<h3>Copy this</h3><textarea class="inp" style="height:220px;font-family:monospace;font-size:12px">${esc(text)}</textarea>`));
  }

  // ---------- sheets ----------
  function sheet(html, bind) {
    closeSheet();
    document.body.insertAdjacentHTML('beforeend', `<div class="pf-sheetbg" id="pfBg"><div class="pf-sheet" id="pfSheet"><button class="pf-x" id="pfX">✕</button>${html}</div></div>`);
    $('#pfX').onclick = closeSheet; $('#pfBg').onclick = e => { if (e.target.id === 'pfBg') closeSheet(); };
    S.sheetOpen = true; bind && bind();
  }
  function closeSheet() { const b = $('#pfBg'); if (b) b.remove(); S.sheetOpen = false; }
  window.closePfSheet = closeSheet;

  function sheetAdd(h) {
    const mkt = S.mkt, c = cur(mkt), ed = !!h;
    sheet(`<h3>${ed ? 'Edit ' + esc(h.sym) : 'Add a stock'}</h3>
      ${ed ? '' : `<input id="aSym" class="inp" placeholder="Search symbol or company (e.g. RELIANCE, Tata Motors)" autocomplete="off" autocapitalize="characters"><div id="aSug" class="pf-sug"></div>`}
      <div class="pf-2"><label>Quantity<input id="aQty" class="inp" inputmode="decimal" value="${ed ? h.qty : ''}"></label><label>Avg buy price (${c})<input id="aAvg" class="inp" inputmode="decimal" value="${ed ? h.avg : ''}"></label></div>
      <div class="pf-2"><label>Buy date (optional)<input id="aDate" class="inp" type="date" value="${ed ? esc(h.date || '') : ''}"></label><label>Your stop-loss (optional)<input id="aStop" class="inp" inputmode="decimal" value="${ed && h.stop ? h.stop : ''}" placeholder="auto"></label></div>
      <input id="aNote" class="inp" placeholder="Note (optional)" value="${ed ? esc(h.note || '') : ''}">
      ${ed ? '' : '<div class="note" id="aPx"></div>'}
      <button class="btn w" id="aGo">${ed ? 'Save changes' : 'Add to portfolio'}</button><div class="note" id="aMsg"></div>`, () => {
      let sym = ed ? h.sym : null;
      if (!ed) {
        const inp = $('#aSym'), sug = $('#aSug');
        inp.oninput = () => {
          const s = inp.value.trim().toUpperCase(); if (!s) { sug.innerHTML = ''; return; }
          const L = mkt === 'IN' ? (S.nse && S.nse.eq || window.SEED_IN) : ((S.us && S.us.eq) || window.US_LIST || []);
          const hits = L.filter(x => x[0].startsWith(s) || String(x[1]).toUpperCase().includes(s)).sort((a, b) => (b[0] === s) - (a[0] === s) || b[0].startsWith(s) - a[0].startsWith(s)).slice(0, 8);
          sug.innerHTML = hits.map(x => `<div data-s="${esc(x[0])}"><b>${esc(x[0])}</b> <span class="mu">${esc(x[1])}</span></div>`).join('') || (mkt === 'US' && /^[A-Z.]{1,6}$/.test(s) ? `<div data-s="${esc(s)}"><b>${esc(s)}</b> <span class="mu">use this ticker</span></div>` : '<div class="mu">No match</div>');
          sug.querySelectorAll('[data-s]').forEach(d => d.onclick = async () => {
            sym = d.dataset.s; inp.value = sym + ' — ' + (nameOf(sym) || ''); sug.innerHTML = ''; $('#aPx').innerHTML = '<span class="spin"></span>';
            try { const Q = await msQuotes([sym], mkt), q = await dailyQuick(sym, mkt, Q); if (q.price) { $('#aPx').innerHTML = `Now ${c}${fmt(q.price)} · <a href="#" id="aUse">use as buy price</a>`; $('#aUse').onclick = e => { e.preventDefault(); $('#aAvg').value = q.price.toFixed(2); }; } else $('#aPx').textContent = ''; } catch (e) { $('#aPx').textContent = ''; }
            $('#aQty').focus();
          });
        };
        inp.focus();
      }
      $('#aGo').onclick = () => {
        const qty = Portfolio.num($('#aQty').value), avg = Portfolio.num($('#aAvg').value), stop = Portfolio.num($('#aStop').value);
        if (!sym) return ($('#aMsg').textContent = 'Pick a stock from the list.');
        if (!(qty > 0)) return ($('#aMsg').textContent = 'Enter the quantity.');
        if (!(avg > 0)) return ($('#aMsg').textContent = 'Enter your average buy price.');
        const rec = { sym, qty, avg, date: $('#aDate').value || '', note: $('#aNote').value.trim(), stop: stop > 0 ? stop : undefined, src: 'manual' };
        if (ed) Portfolio.update(mkt, h.id, rec);
        else { const ex = Portfolio.list(mkt).find(x => x.sym === sym); if (ex && !confirm(`${sym} is already in your portfolio (${ex.qty} @ ${c}${ex.avg}). Add to it and average the price? (Cancel = replace it)`)) Portfolio.upsert(mkt, rec, 'replace'); else Portfolio.upsert(mkt, rec, 'merge'); }
        if (S.pf) delete S.pf[mkt]; closeSheet(); toast(ed ? 'Saved' : `${sym} added`); vPortfolio();
      };
    });
  }

  function sheetImport(how) {
    sheet(`<h3>${how === 'file' ? 'Import a CSV file' : 'Paste your holdings'}</h3>
      ${how === 'file' ? `<label class="pf-file"><input type="file" id="iFile" accept=".csv,.txt,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel"><span>📄 Choose CSV file</span></label>
        <div class="note">Download holdings from your broker (Zerodha Console → Holdings → Download, Groww → Holdings → Download report, Upstox/Angel/mStock → Holdings → Export). If it is Excel (.xlsx), open it in Google Sheets and save as CSV.</div>`
      : `<textarea id="iText" class="inp" style="height:170px;font-family:monospace;font-size:13px" placeholder="Paste CSV or simple lines:\nRELIANCE 10 2450\nTCS 5 3820\nHDFCBANK 20 1610.25"></textarea><button class="btn w" id="iGo">Read holdings</button>`}
      <div class="note" id="iMsg"></div>`, () => {
      const go2 = text => { const r = Portfolio.importText(text, S.mkt); if (!r.items.length) { $('#iMsg').innerHTML = '<span class="dn">No holdings found. The file needs a symbol/name column and a quantity column.</span>'; return; } review(r.items, r.format); };
      if (how === 'file') $('#iFile').onchange = e => { const f = e.target.files[0]; if (!f) return; if (/\.xlsx?$/i.test(f.name)) { $('#iMsg').innerHTML = '<span class="wa">That is an Excel file. Open it in Google Sheets or Excel and save/download as CSV, then import that.</span>'; return; } const rd = new FileReader(); rd.onload = () => go2(String(rd.result)); rd.readAsText(f); };
      else $('#iGo').onclick = () => go2($('#iText').value);
    });
  }

  // preview: matched / needs a pick / skipped, then merge / replace / new-only
  function review(items, format) {
    const mkt = S.mkt, c = cur(mkt), ok = items.filter(i => i.sym).length;
    sheet(`<h3>Review ${items.length} holdings</h3><div class="note">Read as: ${esc(format)} · ${ok} matched${ok < items.length ? ` · <span class="wa">${items.length - ok} need you to pick</span>` : ''}</div>
      <div class="pf-rev">${items.map((it, i) => `<div class="pf-ri ${it.sym ? '' : 'miss'}"><div><b>${esc(it.sym || it.token || it.isin)}</b>${it.sym && it.token && it.token.toUpperCase() !== it.sym ? ` <span class="mu">from "${esc(it.token)}"${it.how ? ' by ' + it.how : ''}</span>` : ''}
        ${it.sym ? '' : `<select data-i="${i}" class="inp"><option value="">Pick the stock…</option>${(it.guesses || []).map(g => `<option value="${esc(g[0])}">${esc(g[0])} — ${esc(g[1])}</option>`).join('')}<option value="__type">Type the symbol…</option><option value="__skip">Skip this row</option></select>`}</div>
        <div class="mu">${it.qty} × ${isFinite(it.avg) ? c + it.avg : '<span class="wa">no price</span>'}</div></div>`).join('')}</div>
      <div class="note">Rows without an average price are added at ${c}0 cost (P&amp;L can't be shown); edit them later.</div>
      <div class="pf-mode"><label><input type="radio" name="iMode" value="merge" checked> Add to existing (average the price)</label><label><input type="radio" name="iMode" value="replace-all"> Replace my whole ${mkt === 'IN' ? 'India' : 'US'} portfolio</label><label><input type="radio" name="iMode" value="new-only"> Only add stocks I don't have</label></div>
      <button class="btn w" id="rGo">Import</button>`, () => {
      document.querySelectorAll('.pf-rev select').forEach(sel => sel.onchange = () => {
        const it = items[+sel.dataset.i];
        if (sel.value === '__type') { const t = prompt('Symbol (e.g. RELIANCE)'); const r = t && Portfolio.resolve(t, mkt); if (r && r.sym) { it.sym = r.sym; sel.outerHTML = `<span class="up">→ ${esc(r.sym)}</span>`; } else { toast('Not found'); sel.value = ''; } }
        else if (sel.value === '__skip') it.skip = true; else it.sym = sel.value || null;
      });
      $('#rGo').onclick = () => {
        const mode = document.querySelector('input[name=iMode]:checked').value, use = items.filter(i => i.sym && !i.skip);
        if (mode === 'replace-all' && !confirm(`Replace all ${Portfolio.list(mkt).length} current holdings with these ${use.length}?`)) return;
        const n = Portfolio.apply(mkt, use, mode); if (S.pf) delete S.pf[mkt]; closeSheet(); toast(`${n} holdings imported`); S.savedSeg = 'pf'; if (S.tab !== 'saved') go('saved'); else vPortfolio();
      };
    });
  }

  // ---------- Home card ----------
  window.pfCardHTML = () => {
    const s = (store.get('pfSum', {}) || {})[S.mkt]; if (!s || !Portfolio.list(S.mkt).length) return '';
    return `<div class="card pf-home" id="pfHome"><div class="pf-s1"><div><div class="note">💼 My portfolio</div><b class="pf-v">${money(s.total, S.mkt)}</b></div><div style="text-align:right"><div class="${cls(s.day)}">Today ${sgn(s.day)}${money(s.day, S.mkt)}</div><div class="${cls(s.pnl)}">Total ${sgn(s.pnlPct)}${(s.pnlPct || 0).toFixed(1)}%</div></div></div>
      ${s.actions ? `<div class="pf-act">⚡ ${s.actions} need${s.actions === 1 ? 's' : ''} action${s.sells ? ` · ${s.sells} sell/trim` : ''} — tap to see</div>` : ''}</div>`;
  };
  window.bindPfCard = () => { const c = $('#pfHome'); if (c) c.onclick = () => { S.savedSeg = 'pf'; S.pfF = 'Action needed'; go('saved'); }; };
  window.vPortfolio = vPortfolio;
})();
