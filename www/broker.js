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
      const m = get('map'); if (m && m.day === istDay() && m.v === 3) return m;
      const csv = await this._req('GET', 'instruments/scriptmaster');
      const text = typeof csv === 'string' ? csv : JSON.stringify(csv);
      const lines = text.split(/\r?\n/), hd = lines[0].split(',').map(x => x.trim().toLowerCase().replace(/"/g, ''));
      const ix = n => hd.indexOf(n), iTok = ix('instrument_token'), iSym = ix('tradingsymbol'), iEx = ix('exchange'), iSeg = ix('segment'), iTyp = ix('instrument_type'), iName = ix('name'), iExp = ix('expiry'), iStk = ix('strike'), iLot = ix('lot_size');
      if (iTok < 0 || iSym < 0) throw new Error('Unexpected script master format');
      const eq = {}, idx = {}, opt = {}, today = istDay(), OPT = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX'];
      for (const n of OPT) opt[n] = [];
      for (let k = 1; k < lines.length; k++) {
        const r = lines[k].split(','); if (r.length < hd.length - 1) continue;
        const cl = i => i < 0 ? '' : String(r[i] || '').trim().replace(/"/g, '');
        const ex = cl(iEx).toUpperCase(), ts = cl(iSym), seg = cl(iSeg).toUpperCase(), typ = cl(iTyp).toUpperCase();
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
      const out = { v: 3, day: istDay(), eq, idx, opt, counts: Object.fromEntries(Object.entries(opt).map(([k, v]) => [k, v.length])) };
      set('map', out); return out;
    },
    // index quote key: NIFTY → NSE:NIFTY 50, SENSEX → BSE:SENSEX
    async key(sym) {
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
