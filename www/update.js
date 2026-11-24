/* In-app updates: checks GitHub for a newer build, shows "Update available", and opens the APK download.
   Android then offers "Update" over the installed app (same signing key, higher version code). */
const Updater = (() => {
  const API = 'https://api.github.com/repos/kritish-narula/daytrader-desk/releases/latest';
  let cur = { build: 0, signed: false }, latest = null;
  const ready = fetch('version.json', { cache: 'no-store' }).then(r => r.json()).then(v => { cur = v; }).catch(() => {});
  async function check(force) {
    await ready;
    const last = store.get('updChecked', 0);
    if (!force && latest) return latest;
    if (!force && Date.now() - last < 3 * 3600e3) { latest = store.get('updLatest', null); return latest; }
    try {
      const r = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } }), j = await r.json();
      const n = +String(j.tag_name || '').replace(/\D/g, ''), a = (j.assets || []).find(x => /\.apk$/i.test(x.name));
      latest = n && a ? { build: n, url: a.browser_download_url, notes: String(j.body || '').split('\n')[0].slice(0, 160), date: (j.published_at || '').slice(0, 10) } : null;
      store.set('updChecked', Date.now()); store.set('updLatest', latest);
    } catch (e) { latest = store.get('updLatest', null); }
    return latest;
  }
  const available = () => latest && cur.build && latest.build > cur.build ? latest : null;
  function install() { const u = available() || latest; if (u) location.href = u.url; } // opens the browser download; tap it → Update
  function banner() {
    const u = available(); if (!u || document.querySelector('#updBar') || S.tab !== 'home') return;
    const v = document.querySelector('#view'); if (!v) return;
    v.insertAdjacentHTML('afterbegin', `<div class="card upd" id="updBar"><div><b>⬆️ Update available · build ${u.build}</b><div class="note">${esc(u.notes || 'New version ready')}</div></div><button class="btn sm" id="updGo">Update</button></div>`);
    document.querySelector('#updGo').onclick = install;
  }
  setTimeout(() => check().then(banner), 4000);
  return { check, available, install, banner, current: () => cur };
})();
window.Updater = Updater;
(() => { const f = window.vHome; if (typeof f === 'function') window.vHome = function () { const r = f.apply(this, arguments); setTimeout(() => Updater.banner(), 60); return r; }; })();
