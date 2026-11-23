/* Alerts: rating upgrades, new setups, EMA crosses, strong news, price levels.
   Shows phone notifications (native plugin) and keeps an in-app alert list. */
'use strict';
(function () {
  const K = 'dtd2_al_';
  const rd = (k, d) => { try { const v = localStorage.getItem(K + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const wr = (k, v) => { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch (e) {} };
  const SK = () => window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ScanKeeper;
  const day = () => new Date().toISOString().slice(0, 10);
  let list = rd('list', []), snap = rd('snap', {}), prefs = rd('prefs', { notify: true, watch: false, strong: 75 }), prices = rd('prices', {});
  let sentThisRun = 0, queued = [], onChange = () => {};

  async function notifyPhone(title, body, sym) {
    try {
      const p = SK(); if (p) { await p.notify({ title, body, sym }); return; }
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    } catch (e) {}
  }
  function push(a) {
    const dk = `${a.mkt}:${a.sym}:${a.kind}:${day()}`;
    if (list.some(x => x.dk === dk)) return;
    a = Object.assign({ id: Date.now() + Math.random(), t: Date.now(), read: false, dk }, a);
    list.unshift(a); list = list.slice(0, 150); wr('list', list); onChange();
    if (!prefs.notify) return;
    if (sentThisRun < 4) { sentThisRun++; notifyPhone(a.title, a.body, a.sym); } else queued.push(a);
  }
  function flush() {
    if (queued.length) notifyPhone(`${queued.length} more alerts`, queued.slice(0, 4).map(a => a.title).join(' · '));
    queued = []; sentThisRun = 0;
  }
  // q: {sym, mkt, price, rating, action, setups[], cross[], news:{s,n,top}}, watched: bool
  function evaluate(q, watched) {
    q = Object.assign({}, q, { setups: [...(q.setups || []), ...((q.chartPats || []).filter(p => p.status !== 'forming').map(p => ({ n: `${p.n} ${p.status}`, b: p.b, q: p.q })))] });
    const key = q.mkt + ':' + q.sym, prev = snap[key], cur = { r: q.rating, set: (q.setups || []).filter(s => s.q >= 70).map(s => s.n), x: (q.cross || []).filter(c => !c.days).map(c => c.name + c.dir), ns: q.news ? q.news.s : 0, t: Date.now() };
    const name = q.sym, cur$ = q.mkt === 'IN' ? '₹' : '$';
    if (prev) {
      if (q.rating >= 70 && prev.r < 70 && (watched || q.rating >= prefs.strong)) push({ sym: q.sym, mkt: q.mkt, kind: 'up', title: `${name}: upgraded to ${q.action} (${q.rating})`, body: `Rating rose from ${prev.r} to ${q.rating} at ${cur$}${q.price}.` });
      if (watched && q.rating <= 35 && prev.r > 35) push({ sym: q.sym, mkt: q.mkt, kind: 'down', title: `${name}: downgraded to ${q.action} (${q.rating})`, body: `Rating fell from ${prev.r} to ${q.rating}. Review your position.` });
      for (const s of (q.setups || [])) if (s.q >= (watched ? 70 : prefs.strong) && !prev.set.includes(s.n)) push({ sym: q.sym, mkt: q.mkt, kind: 'set:' + s.n, title: `${name}: ${s.n.replace(/^SMC: /, 'SMC ')}`, body: `New ${s.b > 0 ? 'bullish' : 'bearish'} setup, quality ${s.q}/100. Rating ${q.rating}.` });
      if (watched) for (const c of (q.cross || [])) if (!c.days && !prev.x.includes(c.name + c.dir)) push({ sym: q.sym, mkt: q.mkt, kind: 'x:' + c.name, title: `${name}: ${c.dir > 0 ? 'bullish' : 'bearish'} ${c.name} cross`, body: `${c.status}. Rating ${q.rating}.` });
      if (q.news && Math.abs(q.news.s) >= 0.5 && q.news.n >= 2 && Math.abs(prev.ns || 0) < 0.5 && (watched || q.rating >= 65)) push({ sym: q.sym, mkt: q.mkt, kind: 'news', title: `${name}: ${q.news.s > 0 ? 'positive' : 'negative'} news`, body: q.news.top || 'Strong news sentiment.' });
    }
    const pa = prices[key];
    if (pa && q.price) {
      if (pa.above && q.price >= pa.above) { push({ sym: q.sym, mkt: q.mkt, kind: 'pa' + pa.above, title: `${name} crossed above ${cur$}${pa.above}`, body: `Now ${cur$}${q.price}.` }); delete pa.above; }
      if (pa.below && q.price <= pa.below) { push({ sym: q.sym, mkt: q.mkt, kind: 'pb' + pa.below, title: `${name} fell below ${cur$}${pa.below}`, body: `Now ${cur$}${q.price}.` }); delete pa.below; }
      if (!pa.above && !pa.below) delete prices[key]; wr('prices', prices);
    }
    snap[key] = cur;
  }
  function save() { const ks = Object.keys(snap); if (ks.length > 4000) ks.sort((a, b) => snap[a].t - snap[b].t).slice(0, ks.length - 4000).forEach(k => delete snap[k]); wr('snap', snap); }

  window.Alerts = {
    list: () => list, unread: () => list.filter(a => !a.read).length,
    markRead() { list.forEach(a => a.read = true); wr('list', list); onChange(); },
    clear() { list = []; wr('list', list); onChange(); },
    prefs: () => prefs, setPrefs(p) { Object.assign(prefs, p); wr('prefs', prefs); },
    priceAlert: (mkt, sym) => prices[mkt + ':' + sym] || {},
    setPriceAlert(mkt, sym, pa) { const k = mkt + ':' + sym; if (!pa.above && !pa.below) delete prices[k]; else prices[k] = pa; wr('prices', prices); },
    notifyNow: (title, body) => prefs.notify && notifyPhone(title, body),
    evaluate, flush, save, onChange: f => { onChange = f; },
    async requestPermission() {
      try { const p = SK(); if (p) return (await p.requestNotify()).granted; if ('Notification' in window) return (await Notification.requestPermission()) === 'granted'; } catch (e) {}
      return false;
    },
    // keep-alive service: runs while the app is in Recents; swiping it away stops everything
    async keepAlive(on, text) { try { const p = SK(); if (!p) return; on ? await p.start({ text }) : await p.stop(); } catch (e) {} },
    setSecure(on) { try { const p = SK(); if (p) p.setSecure({ on }); } catch (e) {} },
  };
})();
