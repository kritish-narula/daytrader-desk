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

  const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const ymd = (y, m, d) => (y < 100 ? 2000 + y : y) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  // expiry in any of: 2026-11-25 · 25-11-2026 · 25/11/2026 · 25-Nov-2026 · 25NOV2026 · 25 Nov 26 · epoch seconds
  function parseExpiry(x) {
    if (!x) return null; x = x.trim().toUpperCase(); let m;
    if ((m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = x.match(/^(\d{1,2})[-\/ ](\d{1,2})[-\/ ](\d{2,4})/))) return ymd(+m[3], +m[2], +m[1]);
    if ((m = x.match(/^(\d{1,2})[-\/ ]?([A-Z]{3})[A-Z]*[-\/ ]?(\d{2,4})/)) && MON[m[2]]) return ymd(+m[3], MON[m[2]], +m[1]);
    if ((m = x.match(/^\d{9,10}$/))) { const d = new Date(+x * 1000 + 5.5 * 3600e3); return d.toISOString().slice(0, 10); }
    const t = Date.parse(x); return isFinite(t) ? new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10) : null;
  }
  // NIFTY2672124150CE (weekly: YY M DD, M = 1-9/O/N/D) or NIFTY26NOV24150CE (monthly: last Tuesday/Thursday unknown → month end)
  function expiryFromSymbol(ts, base) {
    const r = ts.slice(base.length); let m;
    if ((m = r.match(/^(\d{2})([1-9OND])(\d{2})\d+(CE|PE)$/))) return ymd(+m[1], { O: 10, N: 11, D: 12 }[m[2]] || +m[2], +m[3]);
    if ((m = r.match(/^(\d{2})([A-Z]{3})\d+(CE|PE)$/)) && MON[m[2]]) { const y = 2000 + +m[1], mo = MON[m[2]]; return ymd(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()); }
    return null;
  }
  function strikeFromSymbol(ts) { const m = ts.match(/(\d+(?:\.\d+)?)(CE|PE)$/); if (!m) return 0; const d = m[1]; return +(d.length > 7 ? d.slice(-5) : d); }

  // mStock quote replies vary from the docs: find the price/ohlc whatever the field names, strings or nesting
  const num = v => { const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : +v; return isFinite(n) ? n : null; };
  function pick(o, names) {
    if (!o || typeof o !== 'object') return null;
    const L = {}; for (const k of Object.keys(o)) L[k.toLowerCase().replace(/[^a-z]/g, '')] = o[k];
    for (const n of names) { const v = num(L[n]); if (v != null && v !== 0) return v; }
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) { const v = pick(o[k], names); if (v != null) return v; }
    return null;
  }
  const P_LTP = ['lastprice', 'ltp', 'lasttradedprice', 'lasttradeprice', 'ltpprice', 'lp', 'lastrate', 'tradeprice', 'price'];
  function normQ(q) {
    if (q == null) return null; if (typeof q !== 'object') { const v = num(q); return v ? { last_price: v, ohlc: {} } : null; }
    const lp = pick(q, P_LTP); if (lp == null) return null;
    const src = q.ohlc || q.OHLC || q.Ohlc || q;
    const o = { open: pick(src, ['open', 'openprice', 'o']), high: pick(src, ['high', 'highprice', 'h']), low: pick(src, ['low', 'lowprice', 'l']),
      close: pick(src, ['close', 'prevclose', 'previousclose', 'closeprice', 'pclose', 'c']) || pick(q, ['prevclose', 'previousclose', 'pclose', 'closeprice', 'close']) };
    return { last_price: lp, ohlc: o, instrument_token: q.instrument_token || q.token || null };
  }
  // reply → {requestedKey: normalisedQuote}; tolerant of arrays, missing exchange prefix, token keys
  function normMap(d, wanted) {
    const out = {}, rows = Array.isArray(d) ? d.map(x => [String(x.exchange ? x.exchange + ':' : '') + (x.tradingsymbol || x.symbol || x.trading_symbol || ''), x]) : Object.entries(d || {});
    const bare = k => k.replace(/^[A-Z]+:/, '').toUpperCase();
    for (const w of wanted) {
      let hit = rows.find(([k]) => k === w) || rows.find(([k]) => bare(k) === bare(w)) || rows.find(([k]) => bare(k).replace(/-EQ$/, '') === bare(w).replace(/-EQ$/, ''));
      if (!hit && rows.length === 1 && wanted.length === 1) hit = rows[0];
      const q = hit && normQ(hit[1]); if (q) out[w] = q;
    }
    return out;
  }

  // candle time → epoch seconds: epoch s/ms, ISO with/without offset, "YYYY-MM-DD HH:MM:SS", "DD-MM-YYYY HH:MM" (IST wall time)
  function candleTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) { const n = +v; return Math.floor(n > 1e11 ? n / 1000 : n); }
    let x = String(v).trim(), m;
    if ((m = x.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) x = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${(m[4] || '00').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}`;
    else if ((m = x.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?(.*)$/))) {
      const tz = (m[3] || '').trim(), hasTz = /^(Z|[+-]\d{2}:?\d{2})/.test(tz);
      x = m[1] + 'T' + (m[2] ? (m[2].length === 5 ? m[2] + ':00' : m[2]) : '00:00:00') + (hasTz ? tz.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2').slice(0, 6) : '');
      if (hasTz) { const t = Date.parse(x); return isFinite(t) ? Math.floor(t / 1000) : null; }
    } else { const t = Date.parse(x); return isFinite(t) ? Math.floor(t / 1000) : null; }
    const t = Date.parse(x + '+05:30'); return isFinite(t) ? Math.floor(t / 1000) : null;
  }

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

    // Script master -> NSE equities, NSE/BSE indices, NFO/BFO index options (cached per day)
    async map() {
      // in-memory first: re-reading/parsing a multi-MB map per symbol froze big scans
      if (this._map && this._map.day === istDay()) return this._map;
      if (this._mapP) return this._mapP;
      const m = get('map'); if (m && m.day === istDay() && m.v === 4) { this._map = m; this._keys = new Map(); return m; }
      this._mapP = this._loadMap().finally(() => { this._mapP = null; });
      return this._mapP;
    },
    async _loadMap() {
      const csv = await this._req('GET', 'instruments/scriptmaster');
      const text = typeof csv === 'string' ? csv : JSON.stringify(csv);
      const lines = text.split(/\r?\n/), hd = lines[0].split(',').map(x => x.trim().toLowerCase().replace(/"/g, ''));
      const ix = n => hd.indexOf(n), iTok = ix('instrument_token'), iSym = ix('tradingsymbol'), iEx = ix('exchange'), iSeg = ix('segment'), iTyp = ix('instrument_type'), iName = ix('name'), iExp = ix('expiry'), iStk = ix('strike'), iLot = ix('lot_size');
      if (iTok < 0 || iSym < 0) throw new Error('Unexpected script master format');
      const eq = {}, idx = {}, opt = {}, fo = {}, today = istDay(), OPT = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX'];
      for (const n of OPT) opt[n] = [];
      for (let k = 1; k < lines.length; k++) {
        const r = lines[k].split(','); if (r.length < hd.length - 1) continue;
        const cl = i => i < 0 ? '' : String(r[i] || '').trim().replace(/"/g, '');
        const ex = cl(iEx).toUpperCase(), ts = cl(iSym), seg = cl(iSeg).toUpperCase(), typ = cl(iTyp).toUpperCase();
        // full F&O universe: every underlying with live NFO/BFO contracts (stocks + indices), lot from the master
        if ((ex === 'NFO' || ex === 'BFO') && (/^(FUT|OPT)(STK|IDX)$/.test(typ) || /^(CE|PE|FUT|FF)$/.test(typ) || /(CE|PE|FUT)$/.test(ts))) {
          const und = (cl(iName) || (ts.match(/^[A-Z&-]+/) || [''])[0]).toUpperCase().replace(/\s+/g, '');
          const ed0 = parseExpiry(cl(iExp)) || expiryFromSymbol(ts, und);
          if (und && (!ed0 || ed0 >= today)) {
            const isIdx = /IDX$/.test(typ) || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50'].includes(und), lot = +cl(iLot) || 0, cur = fo[und];
            if (!cur) fo[und] = { lot, ex, type: isIdx ? 'index' : 'stock' };
            else { if (ex === 'NFO' && cur.ex === 'BFO') { cur.ex = 'NFO'; if (lot) cur.lot = lot; } if (!cur.lot && lot) cur.lot = lot; }
          }
        }
        if ((ex === 'NFO' || ex === 'BFO') && (typ === 'CE' || typ === 'PE' || /(CE|PE)$/.test(ts))) {
          const nm = (cl(iName) || ts.match(/^[A-Z]+/)[0]).toUpperCase(), base = OPT.find(o => nm === o || (nm.startsWith(o) && !OPT.some(x => x !== o && x.length > o.length && nm.startsWith(x))));
          if (!base) continue;
          const ed = parseExpiry(cl(iExp)) || expiryFromSymbol(ts, base); if (!ed || ed < today) continue;
          opt[base].push([ts, cl(iTok), ed, +cl(iStk) || strikeFromSymbol(ts), typ === 'CE' || typ === 'PE' ? typ : ts.slice(-2), +cl(iLot) || 0, ex]);
          continue;
        }
        if (ex !== 'NSE' && ex !== 'BSE') continue;
        if (/IND/.test(seg) || /IND/.test(typ)) { idx[ex + ':' + (cl(iName) || ts).toUpperCase()] = [ex, ts, cl(iTok)]; idx[ex + ':' + ts.toUpperCase()] = [ex, ts, cl(iTok)]; continue; }
        if (ex !== 'NSE') continue;
        // equities: master lists "RELIANCE" + series EQ; the quote API wants "RELIANCE-EQ"
        const ser = (typ || seg || 'EQ').replace(/[^A-Z0-9]/g, '') || 'EQ', b2 = ts.replace(/-[A-Z0-9]{1,2}$/, '');
        if (!eq[b2] || ser === 'EQ') eq[b2] = [b2, cl(iTok), ser];
      }
      for (const k in opt) {
        // strikes in paise in some masters: normalise to rupees using the spread of strikes
        const st = opt[k].map(x => x[3]).filter(x => x > 0).sort((a, b) => a - b), med = st[st.length >> 1] || 0, cap = { NIFTY: 60000, BANKNIFTY: 150000, SENSEX: 200000, FINNIFTY: 60000, MIDCPNIFTY: 40000, BANKEX: 150000 }[k];
        if (med > cap) for (const x of opt[k]) x[3] = x[3] / 100;
        const exps = [...new Set(opt[k].map(x => x[2]))].sort().slice(0, 2); opt[k] = opt[k].filter(x => exps.includes(x[2]));
      }
      const out = { v: 4, day: istDay(), eq, idx, opt, fo, counts: Object.fromEntries(Object.entries(opt).map(([k, v]) => [k, v.length])) };
      this._map = out; this._keys = new Map(); set('map', out); return out;
    },
    // {SYM: {lot, ex:'NFO'|'BFO', type:'stock'|'index'}} — every NSE + BSE F&O underlying, from today's master
    async foUniverse() { const m = await this.map(); return m.fo || null; },
    // index quote key: NIFTY → NSE:NIFTY 50, SENSEX → BSE:SENSEX
    async key(sym) {
      const day = istDay(), f = get('symfmt') || 0, ck = sym + '|' + f;
      if (this._keys && this._keysDay === day && this._keys.has(ck)) return this._keys.get(ck);
      const r = await this._key(sym); if (!this._keys || this._keysDay !== day) { this._keys = new Map(); this._keysDay = day; } this._keys.set(ck, r); return r;
    },
    async _key(sym) {
      const IDX = { NIFTY: ['NSE:NIFTY 50', 'NSE:NIFTY'], BANKNIFTY: ['NSE:NIFTY BANK', 'NSE:BANKNIFTY'], FINNIFTY: ['NSE:NIFTY FIN SERVICE', 'NSE:FINNIFTY'], MIDCPNIFTY: ['NSE:NIFTY MID SELECT', 'NSE:MIDCPNIFTY'], SENSEX: ['BSE:SENSEX'], BANKEX: ['BSE:BANKEX'], INDIAVIX: ['NSE:INDIA VIX'] };
      let m = null; try { m = await this.map(); } catch (e) {}
      if (IDX[sym]) { for (const n of IDX[sym]) { const x = m && m.idx[n]; if (x) return { k: x[0] + ':' + x[1], tok: x[2], ex: x[0], idx: 1 }; } const n = IDX[sym][0]; return { k: n, tok: null, ex: n.split(':')[0], idx: 1 }; }
      const e = m && m.eq[sym], base = e ? e[0] : sym, ser = e && e[2] || 'EQ';
      const alt = [`NSE:${base}-${ser}`, `NSE:${base}`]; if (ser !== 'EQ') alt.push(`NSE:${base}-EQ`);
      const f = get('symfmt') || 0; // which form mStock accepted last time (learned)
      return { k: alt[Math.min(f, alt.length - 1)], alt, tok: e ? e[1] : null, ex: 'NSE' };
    },
    // fastest price call: {key: last_price}
    async ltp(keys) {
      const out = {};
      for (let i = 0; i < keys.length; i += 50) {
        const part = keys.slice(i, i + 50), d = await this._req('GET', 'instruments/quote/ltp', { params: part.map(k => ['i', k]) });
        this.lastRaw = JSON.stringify(d).slice(0, 400);
        const m = normMap(d, part); for (const k in m) out[k] = m[k].last_price;
      }
      return out;
    },
    // live index: {price, prev, open, high, low}
    async index(sym) {
      const kk = await this.key(sym), d = await this._req('GET', 'instruments/quote/ohlc', { params: [['i', kk.k]] }); this.lastRaw = JSON.stringify(d).slice(0, 400); const q = normMap(d, [kk.k])[kk.k];
      if (!q || !q.last_price) throw new Error('No live quote for ' + sym);
      const o = q.ohlc || {}; return { price: +q.last_price, prev: +o.close || null, open: +o.open || null, high: +o.high || null, low: +o.low || null, key: kk };
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
      const d = await this._req('GET', 'instruments/quote/ohlc', { params: part }); this.lastRaw = JSON.stringify(d).slice(0, 400); return normMap(d, part.map(x => x[1]));
    },
    // Live quotes for many symbols: {SYM: {last_price, ohlc:{open,high,low,close(prev)}}}
    async quotes(syms) {
      const keys = await Promise.all(syms.map(s => this.key(s))), out = {}, bad = {};
      const run = async (pairs) => { // pairs: [sym, key]
        for (let i = 0; i < pairs.length; i += 50) {
          const part = pairs.slice(i, i + 50), back = {}; for (const [s, k] of part) back[k] = s;
          const d = await this._req('GET', 'instruments/quote/ohlc', { params: part.map(([, k]) => ['i', k]) }); this.lastRaw = JSON.stringify(d).slice(0, 400);
          const m = normMap(d, Object.keys(back)); for (const k in m) out[back[k]] = m[k];
          for (const k in d || {}) { const v = d[k]; if (v && v.message && !m[k]) bad[back[k] || k] = String(v.message).slice(0, 80); }
        }
      };
      await run(syms.map((s, j) => keys[j] && [s, keys[j].k]).filter(Boolean));
      // second try for anything rejected, with the other key form (e.g. RELIANCE vs RELIANCE-EQ)
      const miss = syms.map((s, j) => [s, keys[j]]).filter(([s, kk]) => !out[s] && kk && kk.alt);
      if (miss.length) {
        const f0 = get('symfmt') || 0, tries = {};
        for (const [s, kk] of miss) kk.alt.forEach((k, i) => { if (i !== f0 && k !== kk.k) (tries[i] = tries[i] || []).push([s, k]); });
        for (const [i, pairs] of Object.entries(tries)) {
          const before = Object.keys(out).length; await run(pairs.filter(([s]) => !out[s]));
          if (Object.keys(out).length - before > pairs.length / 2) set('symfmt', +i); // most worked: remember this form
        }
      }
      const C = this.cov = this.cov || { ok: {}, miss: {}, why: {} }, now = Date.now();
      for (const s of syms) { if (out[s]) { C.ok[s] = now; delete C.miss[s]; delete C.why[s]; } else { C.miss[s] = now; if (bad[s]) C.why[s] = bad[s]; } }
      return out;
    },

    // Candles: interval in day|minute|3minute|5minute|... ; max 1000 bars per request
    async candles(sym, interval, days) {
      const kk = await this.key(sym); if (!kk || !kk.tok) throw new Error('No mStock instrument token for ' + sym);
      const to = new Date(), from = new Date(to - days * 864e5);
      const d = await this._req('GET', `instruments/historical/${kk.ex || 'NSE'}/${kk.tok}/${interval}`, { params: [['from', istStamp(from)], ['to', istStamp(to)]] });
      this.lastCandleRaw = JSON.stringify(d).slice(0, 300);
      const C = Array.isArray(d) ? d : (d && (d.candles || d.Candles || d.data || d.candle)) || [], rows = [];
      for (const x of C) {
        const a = Array.isArray(x) ? x : [x.time ?? x.timestamp ?? x.date ?? x.datetime ?? x.t, x.open ?? x.o, x.high ?? x.h, x.low ?? x.l, x.close ?? x.c, x.volume ?? x.v];
        const t = candleTime(a[0]); if (t == null) continue;
        const o = +a[1], h = +a[2], l = +a[3], c = +a[4]; if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
        rows.push([t, o, Math.max(h, o, c), Math.min(l, o, c), c, +a[5] || 0]);
      }
      rows.sort((p, q) => p[0] - q[0]); // mStock can send newest first; charts and indicators need oldest first
      const D = { t: [], o: [], h: [], l: [], c: [], v: [], day: [] };
      for (const r of rows) {
        if (D.t.length && D.t[D.t.length - 1] === r[0]) { const n = D.t.length - 1; D.o[n] = r[1]; D.h[n] = r[2]; D.l[n] = r[3]; D.c[n] = r[4]; D.v[n] = r[5]; continue; } // duplicate time
        D.t.push(r[0]); D.o.push(r[1]); D.h.push(r[2]); D.l.push(r[3]); D.c.push(r[4]); D.v.push(r[5]); D.day.push(istDay(new Date(r[0] * 1000)));
      }
      if (!D.c.length) throw new Error('No candles from mStock');
      return D;
    },

    // ---- PRICE BASIS: the single place that decides "last price" and "previous close" for a symbol ----
    // D: daily series ({t,o,h,l,c,v,day}, day = exchange-local date), mutated: today's bar is created / refreshed.
    // o: {lp: live last price (mStock LTP, or Yahoo regularMarketPrice), pq: mStock ohlc.close (prev close), q: mStock quote,
    //     ms: true when lp/pq come from mStock, ts: Yahoo regularMarketTime (s), mkt}
    // Rules (what a broker terminal / NSE shows):
    //  - market open: price = LTP; prev = mStock ohlc.close (unless it equals the LTP or today's close, then the prior daily bar)
    //  - market closed after a session: prev = the PRIOR daily bar (official close of the day before); price = LTP until
    //    close+30 min (NSE publishes its closing price ~15:40), after that the Yahoo/daily-bar close = official close
    //  - pre-open (before 09:15), weekends, holidays: price = last completed session's official close, prev = the bar before it;
    //    never yesterday's close shown as today's move
    // returns {price, prev, src: 'ms' | 'yf' | 'cl' (official close), official, live, idle, day, at}
    basis(D, o = {}) {
      const mkt = o.mkt || 'IN', M = (typeof MK !== 'undefined' && MK[mkt]) || { tz: 'Asia/Kolkata', open: 555, close: 930 };
      const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: M.tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value;
      const today = `${p.year}-${p.month}-${p.day}`, mins = +p.hour * 60 + +p.minute, wd = !['Sat', 'Sun'].includes(p.weekday);
      const live = typeof marketOpen === 'function' ? !!marketOpen(mkt) : wd && mins >= M.open && mins < M.close;
      const n0 = D.c.length - 1; if (n0 < 0) return null;
      const lp = +o.lp > 0 ? +o.lp : null, pq = +o.pq > 0 ? +o.pq : null, qo = (o.q && o.q.ohlc) || {}, at = Date.now();
      const same = (a, b, e = 1e-4) => a > 0 && b > 0 && Math.abs(a / b - 1) < e;
      const sessionToday = live || (wd && mins >= M.open);
      let hasToday = D.day[n0] === today, virtual = false;
      if (sessionToday && !hasToday && lp) {
        // provider's daily series has no bar for today yet: add one from the live quote (not on a holiday: quote == last session's bar)
        const tsDay = o.ts ? new Intl.DateTimeFormat('en-CA', { timeZone: M.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(o.ts * 1000)) : null;
        const holiday = o.ms ? (+qo.open > 0 && same(+qo.open, D.o[n0]) && same(+qo.high, D.h[n0]) && same(+qo.low, D.l[n0]) && same(lp, D.c[n0], 1e-6)) : tsDay !== today;
        if (!holiday) {
          D.t.push(Math.floor(at / 1000)); D.o.push(+qo.open > 0 ? +qo.open : lp); D.h.push(Math.max(+qo.high || lp, lp)); D.l.push(Math.min(+qo.low || lp, lp)); D.c.push(lp); D.v.push(0); D.day.push(today);
          hasToday = virtual = true;
        }
      }
      const n = D.c.length - 1;
      if (!sessionToday || !hasToday) { // pre-open / weekend / holiday: the last completed session
        return { price: D.c[n], prev: n > 0 ? D.c[n - 1] : null, src: 'cl', official: true, live: false, idle: true, day: D.day[n], at };
      }
      const PD = n > 0 ? D.c[n - 1] : null;
      let prev = PD;
      if (pq && (live || !PD)) { // broker's own previous close, unless it is really today's price / close
        const isToday = PD && same(pq, D.c[n]) && !same(pq, PD, 5e-4) && !virtual, isLp = lp && pq === lp && PD && PD !== lp;
        prev = !isToday && !isLp ? pq : PD || pq;
      }
      const official = !live && mins >= M.close + 30 && !virtual;
      let price = official ? D.c[n] : (lp || D.c[n]);
      if (!official && lp && lp > 0) { D.c[n] = lp; if (+qo.high > 0) D.h[n] = Math.max(D.h[n], +qo.high); if (+qo.low > 0) D.l[n] = Math.min(D.l[n], +qo.low); D.h[n] = Math.max(D.h[n], lp); D.l[n] = Math.min(D.l[n], lp); }
      return { price, prev, src: official ? 'cl' : (o.ms && lp ? 'ms' : 'yf'), official, live, idle: false, day: today, at };
    },
    // Back-compat wrapper (F&O index cards): patch a daily series with an mStock quote; returns price + previous close
    overlay(D, q) {
      if (!q || !q.last_price) return null;
      const b = this.basis(D, { lp: q.last_price, pq: q.ohlc && q.ohlc.close, q, ms: true, mkt: 'IN' });
      return b && { price: b.price, prev: b.prev, src: b.src, official: b.official };
    },
    // Live-only quick prices for list rows / tiles / chart ticks: {SYM: {p, pc, chg, ms:1, at}} (empty unless connected and the market is open)
    async pxNow(syms, mkt = 'IN') {
      const out = {}; if (mkt !== 'IN' || !this.ok() || !(typeof marketOpen === 'function' && marketOpen('IN'))) return out;
      const Q = await this.quotes(syms), at = Date.now();
      for (const s of syms) { const q = Q[s]; if (!q || !q.last_price) continue; const lp = +q.last_price, pc = q.ohlc && +q.ohlc.close > 0 && +q.ohlc.close !== lp ? +q.ohlc.close : null; out[s] = { ms: 1, p: lp, pc, chg: pc ? (lp / pc - 1) * 100 : null, at, q }; }
      return out;
    },
  };
  window.MS = MS;
})();
