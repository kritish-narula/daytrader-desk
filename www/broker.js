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

    async _req(method, path, { form, params, auth = true } = {}) {
      const headers = { 'X-Mirae-Version': '1' };
      const c = this.cfg(), s = get('session');
      if (auth && s && s.token) headers.Authorization = `token ${c.apiKey}:${s.token}`;
      let url = BASE + path, body;
      if (params) url += '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      const r = await fetch(url, { method, headers, body });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch (e) { if (r.ok) return txt; throw new Error(`HTTP ${r.status}`); }
      if (j.status !== 'success') {
        const m = j.message || `HTTP ${r.status}`;
        if (/token|session|unauthori/i.test(m) && r.status >= 400) set('session', null);
        throw new Error(m);
      }
      return j.data;
    },

    // Step 1: username + password -> OTP sent to registered mobile
    async login(user, password) {
      const d = await this._req('POST', 'connect/login', { form: { username: user, password }, auth: false });
      this._pending = { user, name: d && d.nm };
      return d;
    },
    // Step 2a: OTP (request_token) + checksum -> access token
    async verifyOtp(otp) {
      const c = this.cfg();
      const d = await this._req('POST', 'session/token', { form: { api_key: c.apiKey, request_token: otp, checksum: c.checksum || 'L' }, auth: false });
      return this._store(d);
    },
    // Step 2b: authenticator TOTP -> access token
    async verifyTotp(code) {
      const d = await this._req('POST', 'session/verifytotp', { form: { api_key: this.cfg().apiKey, totp: code }, auth: false });
      return this._store(d);
    },
    _store(d) {
      if (!d || !d.access_token) throw new Error('No access token in response');
      set('session', { token: d.access_token, day: istDay(), user: (this._pending || {}).user, name: d.user_name || (this._pending || {}).name });
      return d;
    },

    // Script master -> NSE equity tradingsymbol + instrument_token (cached per day)
    async map() {
      const m = get('map'); if (m && m.day === istDay()) return m;
      const csv = await this._req('GET', 'instruments/scriptmaster');
      const text = typeof csv === 'string' ? csv : JSON.stringify(csv);
      const lines = text.split(/\r?\n/), hd = lines[0].split(',').map(x => x.trim().toLowerCase());
      const ix = n => hd.indexOf(n), iTok = ix('instrument_token'), iSym = ix('tradingsymbol'), iEx = ix('exchange'), iSeg = ix('segment'), iTyp = ix('instrument_type'), iName = ix('name');
      if (iTok < 0 || iSym < 0) throw new Error('Unexpected script master format');
      const eq = {}, idx = {};
      for (let k = 1; k < lines.length; k++) {
        const r = lines[k].split(','); if (r.length < hd.length - 1) continue;
        const ex = (r[iEx] || '').trim(), ts = (r[iSym] || '').trim(), seg = (r[iSeg] || '').toUpperCase(), typ = (r[iTyp] || '').toUpperCase();
        if (ex !== 'NSE') continue;
        if (/IND/.test(seg) || /IND/.test(typ)) { idx[((r[iName] || ts) + '').trim().toUpperCase()] = [ts, r[iTok].trim()]; continue; }
        const base = ts.replace(/-EQ$/, '');
        if (/-EQ$/.test(ts) || !eq[base]) eq[base] = [ts, r[iTok].trim()];
      }
      const out = { day: istDay(), eq, idx };
      set('map', out); return out;
    },
    async key(sym) { // "NSE:RELIANCE-EQ"
      const IDX = { NIFTY: ['NIFTY 50', 'NIFTY'], BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'], FINNIFTY: ['NIFTY FIN SERVICE', 'FINNIFTY'], MIDCPNIFTY: ['NIFTY MID SELECT', 'MIDCPNIFTY'] };
      let m = null; try { m = await this.map(); } catch (e) {}
      if (IDX[sym]) { if (!m) return null; for (const n of IDX[sym]) if (m.idx[n]) return { k: 'NSE:' + m.idx[n][0], tok: m.idx[n][1] }; return null; }
      if (m && m.eq[sym]) return { k: 'NSE:' + m.eq[sym][0], tok: m.eq[sym][1] };
      return { k: `NSE:${sym}-EQ`, tok: null };
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
