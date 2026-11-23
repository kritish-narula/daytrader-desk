/* News + headline sentiment. Sources: Yahoo Finance search news and Google News RSS (via native HTTP in the app). */
'use strict';
(function () {
  const POS = ['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'rally', 'rallies', 'record', 'upgrade', 'upgrades', 'upgraded', 'outperform', 'buy rating', 'overweight', 'order win', 'bags order', 'wins order', 'wins contract', 'bags contract', 'secures', 'profit rises', 'profit jumps', 'net profit up', 'revenue up', 'raises guidance', 'raises target', 'target raised', 'dividend', 'bonus', 'buyback', 'approval', 'approves', 'launch', 'expansion', 'acquire', 'acquires', 'stake buy', 'all-time high', '52-week high', 'strong', 'growth', 'gains', 'gain', 'rises', 'climbs', 'up ', 'positive', 'boost', 'partnership', 'tie-up', 'inflows', 'turnaround', 'block deal buy'];
  const NEG = ['miss', 'misses', 'missed', 'fall', 'falls', 'plunge', 'plunges', 'slump', 'slumps', 'tumble', 'tumbles', 'crash', 'downgrade', 'downgrades', 'downgraded', 'underperform', 'sell rating', 'underweight', 'loss', 'losses', 'net loss', 'profit falls', 'profit drops', 'decline', 'declines', 'drops', 'slides', 'sinks', 'weak', 'cut', 'cuts', 'slashes', 'target cut', 'fraud', 'probe', 'raid', 'penalty', 'fine', 'sebi notice', 'ed ', 'resigns', 'resignation', 'default', 'pledge', 'lawsuit', 'ban', 'recall', 'warning', 'layoff', 'layoffs', 'outflows', 'negative', 'concern', 'risk', 'block deal sell', 'stake sale', 'ofs', '52-week low'];
  const score = title => {
    const t = ' ' + title.toLowerCase() + ' ';
    let p = 0, n = 0; for (const w of POS) if (t.includes(' ' + w)) p++; for (const w of NEG) if (t.includes(' ' + w)) n++;
    return p + n ? (p - n) / (p + n) : 0;
  };
  async function txt(u) { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }
  async function yahoo(ysym) {
    const j = JSON.parse(await txt(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ysym)}&quotesCount=0&newsCount=12`));
    return (j.news || []).map(x => ({ title: x.title, src: x.publisher, url: x.link, t: (x.providerPublishTime || 0) * 1000 }));
  }
  async function google(q, india) {
    const x = await txt(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=${india ? 'en-IN&gl=IN&ceid=IN:en' : 'en-US&gl=US&ceid=US:en'}`);
    const doc = new DOMParser().parseFromString(x, 'text/xml');
    return [...doc.querySelectorAll('item')].slice(0, 15).map(it => {
      const g = s => (it.querySelector(s) || {}).textContent || '';
      let title = g('title'); const src = g('source'); if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
      return { title, src, url: g('link'), t: Date.parse(g('pubDate')) || 0 };
    });
  }
  // returns {items:[{title,src,url,t,s}], score:-1..1, n}
  async function get(ysym, name, india) {
    const q = india ? `"${name || ysym.replace(/\.(NS|BO)$/, '')}" share` : `${ysym} stock`;
    const res = await Promise.allSettled([yahoo(ysym), google(q, india)]);
    const seen = new Set(), items = [];
    for (const r of res) if (r.status === 'fulfilled') for (const it of r.value) {
      const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (!it.title || seen.has(k)) continue; seen.add(k);
      items.push(Object.assign(it, { s: score(it.title) }));
    }
    if (!items.length && res.every(r => r.status === 'rejected')) throw new Error('News unavailable');
    items.sort((a, b) => b.t - a.t);
    const now = Date.now(); let s = 0, w = 0;
    for (const it of items.slice(0, 20)) { if (!it.s) continue; const age = Math.max(0, now - it.t) / 864e5, wt = Math.pow(0.5, age / 2); s += it.s * wt; w += wt; }
    const agg = w ? Math.max(-1, Math.min(1, s / Math.max(w, 1))) : 0;
    return { items: items.slice(0, 20), score: agg, n: items.filter(x => x.s).length };
  }
  window.News = { get, score };
})();
