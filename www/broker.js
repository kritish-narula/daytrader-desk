/* mStock (Mirae Asset) Type A API — live NSE prices and candles.
   Credentials stay on this phone only (app-private storage). The password is never saved.
   Endpoints and headers follow mStock's docs and official SDK (tradingapi_a). */
'use strict';
(function () {
  const BASE = 'https://api.mstock.trade/openapi/typea/';
  const K = 'dtd2_ms_';
  // credentials go through the encrypted vault when an app PIN is set (security.js)
  const get = k => window.Sec ? Sec.get(k) : (() => { try { return JSON.parse(localStorage.getItem(K + k)); } catch (e) { return null; } })();
  const set = (k, v) => window.Sec ? Sec.set(k, v) : (() => { try { v == null ? localStorage.removeItem(K + k) : localStorage.setItem(K + k, JSON.stringify(v)); } catch (e) {} })();
  const istDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const istStamp = d => { // "YYYY-MM-DD HH:MM:SS" in IST
    const p = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };

  const MS = {
    lastError: null,
    cfg() { return get('cfg') || { apiKey: '', user: '', checksum: 'L', totp: false }; },
    saveCfg(c) { set('cfg', c); },
    session() { return get('session'); },
    ok() { const s = get('session'); return !!(s && s.token && s.day === istDay()); },
    status() {
      const s = get('session');
      if (!this.cfg().apiKey) return 'Not set up';
      if (!s) return 'Not logged in';
      return s.day === istDay() ? `Connected as ${s.name || s.user || 'you'}` : 'Session expired: log in again today';
    },
    logout() {
      const s = get('session'); set('session', null);
      if (s && s.token) this._req('GET', 'logout').catch(() => {});
    },
    forget() { this.logout(); set('cfg', null); set('map', null); },

    // Native HTTP on the phone (exact form encoding, no CORS); browser fetch elsewhere.
    async _http(method, url, headers, form) {
      const N = window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.CapacitorHttp;
      if (N) {
        const r = await N.request({ url, method, headers, data: form || undefined, connectTimeout: 15000, readTimeout: 30000 });
        return { status: r.status, body: r.data };
      }
      const r = await fetch(url, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
      return { status: r.status, body: await r.text() };
    },
    async _req(method, path, { form, params, auth = true } = {}) {
      const headers = { 'X-Mirae-Version': '1', 'Accept': 'application/json' };
      const c = this.cfg(), s = get('session');
      if (auth && s && s.token) headers.Authorization = `token ${c.apiKey}:${s.token}`;
      if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      let url = BASE + path;
      if (params) url += '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      let r;
      try { r = await this._http(method, url, headers, form); }
      catch (e) { this._diag(path, 0, e.message); throw new Error('Could not reach mStock (' + (e.message || 'network error') + '). Check your internet.'); }
      let j = r.body;
      if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { if (r.status < 400) { this._diag(path, r.status, 'ok (text)'); return r.body; } j = null; } }
      const m = (j && (j.message || j.msg || (j.data && j.data.message))) || '';
      this._diag(path, r.status, j && j.status === 'success' ? 'ok' : m || 'no message');
      if (!j || j.status !== 'success') throw new Error(this._explain(path, r.status, m));
      return j.data;
    },
    // translate mStock failures into what to do
    _explain(path, status, m) {
      const t = (m || '').toLowerCase();
      if (status === 403 || /api.?key|invalid key|apikey/.test(t)) return `${m || 'Forbidden (403)'}. The API key was rejected: re-copy it from mStock → Trading APIs, make sure it is a Type A key and not expired.`;
      if (/ip/.test(t) && /(allow|white|register|mismatch|not)/.test(t)) return `${m}. Your current IP isn't allowed: update the Primary IP on mStock → Trading APIs to your phone's current IP.`;
      if (/totp/.test(path) && (status === 400 || /totp|invalid|incorrect/.test(t))) return `${m || 'Wrong code'}. Use the 6-digit code for the mStock *Trading API* entry in your authenticator (set up via Trading APIs → Enable TOTP), and make sure your phone's time is set to automatic.`;
      if (/session\/token/.test(path) && /otp|invalid|incorrect|expired/.test(t)) return `${m}. Check the latest SMS OTP and enter it within a few minutes.`;
      if (/connect\/login/.test(path) && /(password|credential|user|invalid)/.test(t)) return `${m}. Check your client ID and password (same as the mStock app).`;
      if (/token|session|unauthori|expired/.test(t) && status >= 400) { set('session', null); return `${m}. Session ended: log in again.`; }
      return m || `mStock returned HTTP ${status}`;
    },
    _diag(path, status, note) { this.lastCall = { path: path.replace(/\?.*$/, ''), status, note: String(note).slice(0, 160), at: new Date().toLocaleTimeString() }; },

    // Step 1: username + password -> OTP sent to registered mobile (no OTP when TOTP is enabled)
    async login(user, password) {
      const d = await this._req('POST', 'connect/login', { form: { username: user, password }, auth: false });
      this._pending = { user, name: d && (d.nm || d.user_name) };
      return d;
    },
    // Step 2a: OTP (request_token) + checksum -> access token
    async verifyOtp(otp) {
      const c = this.cfg();
      const d = await this._req('POST', 'session/token', { form: { api_key: c.apiKey, request_token: otp, checksum: c.checksum || 'L' }, auth: false });
      return this._store(d);
    },
    // Step 2b: authenticator TOTP -> access token (works without the OTP step)
    async verifyTotp(code) {
      const d = await this._req('POST', 'session/verifytotp', { form: { api_key: this.cfg().apiKey, totp: code }, auth: false });
      return this._store(d);
    },
    // TOTP one-shot: try the code directly; if mStock wants a password login first, do it and retry
    async connectTotp(user, password, code) {
      try { return await this.verifyTotp(code); }
      catch (e1) {
        if (!password) throw e1;
        try { await this.login(user, password); } catch (e2) { throw new Error('Login: ' + e2.message); }
        return await this.verifyTotp(code);
      }
    },
    _store(d) {
      if (!d || !d.access_token) throw new Error('mStock did not return an access token. Try again; if it repeats, check the key type is A.');
      set('session', { token: d.access_token, day: istDay(), user: (this._pending || {}).user || d.user_id, name: d.user_name || (this._pending || {}).name || d.user_id });
      return d;
    },

    // Script master -> NSE equity tradingsymbol + instrument_token (cached per day)
    async map() {
      const m = get('map'); if (m && m.day === istDay()) return m;
      const csv = await this._req('GET', 'instruments/scriptmaster');
      const text = typeof csv === 'string' ? csv : JSON.stringify(csv);
      const lines = text.split(/\r?\n/), hd = lines[0].split(',').map(x => x.trim().toLowerCase());
      const ix = n => hd.indexOf(n), iTok = ix('instrument_token'), iSym = ix('tradingsymbol'), iEx = ix('exchange'), iSeg = ix('segment'), iTyp = ix('instrument_type'), iName = ix('name'), iExp = ix('expiry'), iStk = ix('strike'), iLot = ix('lot_size');
      if (iTok < 0 || iSym < 0) throw new Error('Unexpected script master format');
      const eq = {}, idx = {}, opt = { NIFTY: [], BANKNIFTY: [], SENSEX: [] }, today = istDay();
      for (let k = 1; k < lines.length; k++) {
        const r = lines[k].split(','); if (r.length < hd.length - 1) continue;
        const ex = (r[iEx] || '').trim(), ts = (r[iSym] || '').trim(), seg = (r[iSeg] || '').toUpperCase(), typ = (r[iTyp] || '').toUpperCase();
        if ((ex === 'NFO' || ex === 'BFO') && (typ === 'CE' || typ === 'PE')) {
          const nm = ((r[iName] || '') + '').trim().toUpperCase().replace(/"/g, '');
          if (opt[nm]) { const e = new Date(Date.parse((r[iExp] || '').trim())); const ed = isFinite(e) ? e.toISOString().slice(0, 10) : '';
            if (ed && ed >= today) opt[nm].push([ts, r[iTok].trim(), ed, +r[iStk], typ, +(r[iLot] || 0), ex]); }
          continue;
        }
        if (ex !== 'NSE') continue;
        if (/IND/.test(seg) || /IND/.test(typ)) { idx[((r[iName] || ts) + '').trim().toUpperCase()] = [ts, r[iTok].trim()]; continue; }
        const base = ts.replace(/-EQ$/, '');
        if (/-EQ$/.test(ts) || !eq[base]) eq[base] = [ts, r[iTok].trim()];
      }
      for (const k in opt) { const exps = [...new Set(opt[k].map(x => x[2]))].sort().slice(0, 2); opt[k] = opt[k].filter(x => exps.includes(x[2])); }
      const out = { day: istDay(), eq, idx, opt };
      set('map', out); return out;
    },
    async key(sym) { // "NSE:RELIANCE-EQ"
      const IDX = { NIFTY: ['NIFTY 50', 'NIFTY'], BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'], FINNIFTY: ['NIFTY FIN SERVICE', 'FINNIFTY'], MIDCPNIFTY: ['NIFTY MID SELECT', 'MIDCPNIFTY'] };
      let m = null; try { m = await this.map(); } catch (e) {}
      if (IDX[sym]) { if (!m) return null; for (const n of IDX[sym]) if (m.idx[n]) return { k: 'NSE:' + m.idx[n][0], tok: m.idx[n][1] }; return null; }
      if (m && m.eq[sym]) return { k: 'NSE:' + m.eq[sym][0], tok: m.eq[sym][1] };
      return { k: `NSE:${sym}-EQ`, tok: null };
    },

    // Index option contract nearest to a strike on the nearest expiry: {k, ts, exp, strike, type, lot}
    async option(name, strike, type, nth = 0) {
      const m = await this.map(), L = (m.opt || {})[name] || []; if (!L.length) return null;
      const exp = [...new Set(L.map(x => x[2]))].sort()[nth] || L[0][2];
      let best = null; for (const x of L) if (x[2] === exp && x[4] === type && (!best || Math.abs(x[3] - strike) < Math.abs(best[3] - strike))) best = x;
      return best && { k: (best[6] || 'NFO') + ':' + best[0], ts: best[0], tok: best[1], exp: best[2], strike: best[3], type: best[4], lot: best[5] };
    },
    async optionQuotes(list) { // list of option() results -> {key: quote}
      const part = list.filter(Boolean).map(o => ['i', o.k]); if (!part.length) return {};
      return (await this._req('GET', 'instruments/quote/ohlc', { params: part })) || {};
    },
    // Live quotes for many symbols: {SYM: {last_price, ohlc:{open,high,low,close(prev)}}}
    async quotes(syms) {
      const keys = await Promise.all(syms.map(s => this.key(s))), out = {};
      for (let i = 0; i < syms.length; i += 50) {
        const part = [], back = {};
        for (let j = i; j < Math.min(syms.length, i + 50); j++) if (keys[j]) { part.push(['i', keys[j].k]); back[keys[j].k] = syms[j]; }
        if (!part.length) continue;
        const d = await this._req('GET', 'instruments/quote/ohlc', { params: part });
        for (const k in d || {}) if (back[k]) out[back[k]] = d[k];
      }
      return out;
    },

    // Candles: interval in day|minute|3minute|5minute|... ; max 1000 bars per request
    async candles(sym, interval, days) {
      const kk = await this.key(sym); if (!kk || !kk.tok) throw new Error('No mStock instrument token for ' + sym);
      const to = new Date(), from = new Date(to - days * 864e5);
      const d = await this._req('GET', `instruments/historical/NSE/${kk.tok}/${interval}`, { params: [['from', istStamp(from)], ['to', istStamp(to)]] });
      const C = (d && d.candles) || [], D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
      for (const x of C) {
        const ts = String(x[0]), local = ts.slice(0, 19); // treat as IST wall time
        const t = Date.parse(local + '+05:30') / 1000; if (!isFinite(t)) continue;
        D.t.push(t); D.o.push(+x[1]); D.h.push(+x[2]); D.l.push(+x[3]); D.c.push(+x[4]); D.v.push(+x[5] || 0); D.day.push(local.slice(0, 10));
      }
      if (!D.c.length) throw new Error('No candles from mStock');
      return D;
    },

    // Patch a daily series with a live quote; returns price + previous close
    overlay(D, q) {
      if (!q || !q.last_price) return null;
      const o = q.ohlc || {}, n = D.c.length - 1, today = istDay(), lp = +q.last_price;
      if (D.day[n] === today) { D.c[n] = lp; if (o.high) D.h[n] = Math.max(D.h[n], +o.high); if (o.low) D.l[n] = Math.min(D.l[n], +o.low); }
      else if (+o.open > 0 && D.day[n] < today && new Date().getUTCDay() % 6 && istStamp(new Date()).slice(11, 16) >= '09:15') {
        D.t.push(Math.floor(Date.now() / 1000)); D.o.push(+o.open); D.h.push(Math.max(+o.high || lp, lp)); D.l.push(Math.min(+o.low || lp, lp)); D.c.push(lp); D.v.push(0); D.day.push(today);
      }
      return { price: lp, prev: +o.close || null };
    },
  };
  window.MS = MS;
})();
