// ui-theme.js — light/dark theme toggle (theme agent). Public API: window.Theme
(function () {
  const KEY = 'theme', root = document.documentElement;
  const get = () => { try { return store.get(KEY, 'dark') === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; } };
  const COLORS = { dark: '#0b0e13', light: '#ffffff' };
  function apply(t, animate) {
    if (animate) { root.classList.add('theme-anim'); clearTimeout(apply._h); apply._h = setTimeout(() => root.classList.remove('theme-anim'), 350); }
    root.dataset.theme = t;
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', COLORS[t]);
    const b = document.getElementById('themeBtn');
    if (b) { b.textContent = t === 'light' ? '🌙' : '☀️'; b.title = t === 'light' ? 'Dark theme' : 'Light theme'; b.setAttribute('aria-label', b.title); }
  }
  function set(t) {
    t = t === 'light' ? 'light' : 'dark';
    try { store.set(KEY, t); } catch (e) {}
    apply(t, true);
    try { window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: t } })); } catch (e) {}
  }
  // chart palette other modules can use (full-screen chart stays dark)
  const css = n => getComputedStyle(root).getPropertyValue(n).trim();
  window.Theme = { get, set, toggle: () => set(get() === 'light' ? 'dark' : 'light'), isLight: () => get() === 'light', css,
    chart: () => get() === 'light'
      ? { bg: '#ffffff', text: '#5d6672', grid: '#eef1f5', border: '#e1e5eb', up: '#0f8a46', down: '#d32f2f' }
      : { bg: '#141920', text: '#8a97a6', grid: '#1a2028', border: '#232c37', up: '#22c56c', down: '#f25c5c' } };
  apply(get());
  // expose the sticky header height so list headers can stick just under it
  function topH() { const t = document.querySelector('.top'); if (t) root.style.setProperty('--topH', t.offsetHeight + 'px'); }
  window.addEventListener('resize', topH); window.addEventListener('load', topH); setTimeout(topH, 400); setTimeout(topH, 1500);
  function addBtn() {
    if (document.getElementById('themeBtn')) return;
    const bell = document.getElementById('bell'); if (!bell || !bell.parentNode) return;
    const b = document.createElement('button'); b.id = 'themeBtn'; b.className = 'tbtn'; b.type = 'button';
    b.onclick = () => window.Theme.toggle();
    bell.parentNode.insertBefore(b, bell); apply(get());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBtn); else addBtn();
})();
