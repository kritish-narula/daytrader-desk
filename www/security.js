/* App lock + encrypted vault for broker credentials.
   PIN -> PBKDF2-SHA256 (210k rounds, random salt) -> AES-GCM-256 key. The key lives only in memory while unlocked.
   Without a PIN, secrets fall back to app-private storage (as before). */
'use strict';
(function () {
  const LS = 'dtd2_sec_', PLAIN = 'dtd2_ms_', SECRET_KEYS = ['cfg', 'session'];
  const te = new TextEncoder(), td = new TextDecoder();
  const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u)));
  const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rd = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const wr = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let key = null, vault = {}, unlocked = false;

  async function derive(pin, salt) {
    const base = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function enc(k, obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(obj))); return b64(iv) + '.' + b64(ct); }
  async function dec(k, s) { const [iv, ct] = s.split('.'); return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, k, ub64(ct)))); }
  const meta = () => rd(LS + 'meta');
  let saving = Promise.resolve();
  function persist() { if (!key) return; const k = key, v = Object.assign({}, vault); saving = saving.then(async () => wr(LS + 'vault', await enc(k, v))); return saving; }

  const Sec = {
    hasPin: () => !!meta(),
    isUnlocked: () => !meta() || unlocked,
    lockedUntil() { const m = meta(); return m && m.until > Date.now() ? m.until : 0; },
    async setPin(pin) {
      if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4–8 digits');
      const salt = crypto.getRandomValues(new Uint8Array(16)), k = await derive(pin, salt);
      const moved = {}; for (const s of SECRET_KEYS) { const v = meta() ? vault[s] : rd(PLAIN + s); if (v != null) moved[s] = v; }
      wr(LS + 'meta', { salt: b64(salt), check: await enc(k, 'ok'), fails: 0, until: 0 });
      key = k; vault = moved; unlocked = true; await persist();
      for (const s of SECRET_KEYS) wr(PLAIN + s, null); // remove plaintext copies
    },
    async unlock(pin) {
      const m = meta(); if (!m) return true;
      if (m.until > Date.now()) throw new Error(`Too many tries. Wait ${Math.ceil((m.until - Date.now()) / 1000)}s.`);
      const k = await derive(pin, ub64(m.salt));
      try { if ((await dec(k, m.check)) !== 'ok') throw 0; }
      catch (e) { m.fails = (m.fails || 0) + 1; if (m.fails >= 5) m.until = Date.now() + 30000 * 2 ** (m.fails - 5); wr(LS + 'meta', m); throw new Error(m.fails >= 5 ? 'Wrong PIN. Locked for a while.' : `Wrong PIN (${5 - m.fails} tries left)`); }
      m.fails = 0; m.until = 0; wr(LS + 'meta', m);
      key = k; const v = localStorage.getItem(LS + 'vault'); vault = v ? await dec(k, JSON.parse(v)) : {}; unlocked = true; return true;
    },
    lock() { if (!meta()) return; key = null; vault = {}; unlocked = false; },
    async removePin(pin) {
      await Sec.unlock(pin);
      for (const s of SECRET_KEYS) if (vault[s] != null) wr(PLAIN + s, vault[s]);
      wr(LS + 'meta', null); wr(LS + 'vault', null); key = null; vault = {}; unlocked = false;
    },
    // secret storage used by broker.js
    get(k) { if (!SECRET_KEYS.includes(k)) return rd(PLAIN + k); return meta() ? (unlocked ? vault[k] ?? null : null) : rd(PLAIN + k); },
    set(k, v) {
      if (!SECRET_KEYS.includes(k) || !meta()) return wr(PLAIN + k, v);
      if (!unlocked) return; if (v == null) delete vault[k]; else vault[k] = v; persist();
    },
    wipeAll() { for (const k of Object.keys(localStorage)) if (k.startsWith('dtd2_')) localStorage.removeItem(k); key = null; vault = {}; unlocked = false; },
  };
  window.Sec = Sec;
})();
