/* Self-learning on the phone.
   1. Every rating the app shows (scan or stock page) is written to a prediction journal: score, factor values, entry, stop, Target 1.
   2. As new daily bars arrive the journal is graded: did price hit Target 1 before the stop within the horizon? What was the return?
   3. Score bands are re-calibrated with these live outcomes (Beta-Binomial on top of the CI-trained model).
   4. Factor weights are re-tuned (older 70% of results to train, newest 30% to check). A change is kept only if it predicts the
      newest results better, and is rolled back automatically if later results get worse. Each round starts from the last kept one.
   The weekly CI model (tools/learn.js, 80 stocks × 5 years) is fetched from GitHub so the base model improves without reinstalling. */
const Learn = (() => {
  const E = Engine, KEY = 'learn', MAX = 2500, HZS = ['swing', 'short', 'medium'], DAY_CAP = 300;
  const REMOTE = 'https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/www/model.json';
  const blank = () => ({ on: true, keys: [], preds: [], adj: {}, prev: null, adoptedAt: 0, rounds: [], lastLearn: 0, lastTick: 0, daily: {} });
  let st = Object.assign(blank(), store.get(KEY, {}));
  let src = 'none';
  const save = () => { if (st.preds.length > MAX) { const res = st.preds.filter(p => p.done), pend = st.preds.filter(p => !p.done); st.preds = [...res.slice(Math.max(0, res.length - (MAX - pend.length))), ...pend].slice(-MAX); } store.set(KEY, st); };
  const ki = k => { let i = st.keys.indexOf(k); if (i < 0) { st.keys.push(k); i = st.keys.length - 1; } return i; };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function corr(x, y) { const n = x.length; if (n < 3) return 0; const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let a = 0, b = 0, c = 0; for (let k = 0; k < n; k++) { a += (x[k] - mx) * (y[k] - my); b += (x[k] - mx) ** 2; c += (y[k] - my) ** 2; } return b && c ? a / Math.sqrt(b * c) : 0; }

  // ---------- model ----------
  async function init() {
    let m = null;
    try { m = await (await fetch('model.json', { cache: 'no-store' })).json(); src = 'bundled'; } catch (e) {}
    const saved = store.get('modelRemote', null); if (saved && (!m || saved.v > m.v)) { m = saved; src = 'downloaded'; }
    if (m) E.setModel(m);
    apply();
    // paper-trading league → setup win rates measured going forward (blend into setup stats, weighted by sample size)
    (async () => { try { const pj = await (await fetch('https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/data/paper.json?d=' + new Date().toISOString().slice(0, 10))).json();
      for (const [n, a] of Object.entries((pj.leaders && pj.leaders.setups) || {})) { if (!Array.isArray(a) || a[0] < 30) continue; const b = E.SETUP_STATS[n];
        if (!b) { E.SETUP_STATS[n] = a; continue; } const w = a[0] / (a[0] + b[0]); E.SETUP_STATS[n] = [b[0] + a[0], Math.round(b[1] * (1 - w) + a[1] * w), +(b[2] * (1 - w) + a[2] * w).toFixed(2), a[3] && b[3] ? 1 : a[0] >= 60 ? a[3] : b[3]]; }
    } catch (e) {} })();
    // weekly retrained model from GitHub; only adopted if it is newer and passes the engine's checks
    const last = store.get('modelChecked', 0);
    if (Date.now() - last > 12 * 3600e3) (async () => { // in the background — never delays startup
      try { const r = await fetch(REMOTE + '?d=' + new Date().toISOString().slice(0, 10)); const rm = await r.json(); store.set('modelChecked', Date.now());
        if (rm && rm.v > (E.MODEL.v || 0) && E.setModel(rm)) { store.set('modelRemote', rm); src = 'downloaded'; apply(); } } catch (e) {}
    })();
  }
  function apply() { E.LOCAL.w = st.on ? Object.assign({}, st.adj) : {}; E.LOCAL.calib = st.on ? bands() : {}; }

  // ---------- journal ----------
  function log(sym, mkt, horizons, t, price) {
    if (!st.on || !horizons || !t) return;
    const day = new Date().toISOString().slice(0, 10); if (!st.daily[day]) st.daily = { [day]: 0 };
    let added = 0;
    for (const hz of HZS) {
      const h = horizons[hz]; if (!h || h.na || !h.fv || !h.lvL || !(price > 0)) continue;
      const id = `${mkt}|${sym}|${hz}|${t}`; if (st.preds.some(p => p.id === id)) continue;
      const sc = h.score, act = sc >= 58 || sc <= 42;
      if (!act && Math.random() > 0.15) continue; // middle bands are sampled; per-band rates stay unbiased
      if (st.daily[day] >= DAY_CAP * HZS.length) break;
      st.preds.push({ id, s: sym, m: mkt, hz, t, at: Date.now(), sc, px: price, sl: h.lvL.sl, t1: h.lvL.t1, hold: E.HORIZONS[hz].hold, pc: h.calib ? h.calib.p : null, f: Object.entries(h.fv).map(([k, x]) => [ki(k), x]) });
      st.daily[day]++; added++;
    }
    if (added) save();
  }
  // grade pending predictions with fresh daily bars D {t,h,l,c}
  function resolve(sym, mkt, D) {
    if (!D || !D.t) return 0; let n = 0;
    for (const p of st.preds) {
      if (p.done || p.s !== sym || p.m !== mkt) continue;
      let j0 = D.t.findIndex(x => x > p.t); if (j0 < 0) continue;
      const end = Math.min(D.t.length - 1, j0 + p.hold - 1);
      if (p.o == null) for (let j = j0; j <= end; j++) { if (D.l[j] <= p.sl) { p.o = 0; break; } if (D.h[j] >= p.t1) { p.o = 1; break; } }
      if (D.t.length - j0 >= p.hold) { if (p.o == null) p.o = 0; p.r = +((D.c[j0 + p.hold - 1] / p.px - 1) * 100).toFixed(2); p.done = Date.now(); n++; }
    }
    if (n) { save(); maybeLearn(); }
    return n;
  }
  // background: re-check symbols with pending predictions (fetcher(sym, mkt) → daily bars)
  async function tick(fetcher, force) {
    if (!st.on || (!force && Date.now() - st.lastTick < 3 * 3600e3)) return 0;
    st.lastTick = Date.now(); save();
    const due = new Map(); for (const p of st.preds) if (!p.done && Date.now() - p.at > 20 * 3600e3) due.set(p.m + '|' + p.s, [p.s, p.m]);
    let n = 0; for (const [s, m] of [...due.values()].slice(0, force ? 40 : 15)) { try { n += resolve(s, m, await fetcher(s, m)); } catch (e) {} }
    maybeLearn(force); return n;
  }

  // ---------- learning ----------
  function bands() {
    const out = {}; for (const hz of HZS) out[hz] = (E.calibBins.slice(0, -1)).map(() => ({ w: 0, l: 0, r: 0, n: 0 }));
    for (const p of st.preds) if (p.done && out[p.hz]) { const b = out[p.hz][E.binOf(p.sc)]; if (p.o) b.w++; else b.l++; if (p.r != null) { b.r += p.r; b.n++; } }
    return out;
  }
  const keyOf = i => st.keys[i];
  const comp = (p, adj) => { let s = 0, w = 0; for (const [i, x] of p.f) { const k = keyOf(i), w0 = E.W0[k] || 1, m = (E.MODEL.w[k] == null ? 1 : E.MODEL.w[k]) * (adj[k] == null ? 1 : adj[k]); s += w0 * m * x; w += w0 * m; } return w ? s / w : 0; };
  const rr = p => clamp(p.r / Math.max(0.1, (p.px - p.sl) / p.px * 100), -4, 4);
  const obj = (ps, adj) => { if (ps.length < 15) return 0; const c = ps.map(p => comp(p, adj)); return (corr(c, ps.map(rr)) + corr(c, ps.map(p => p.o))) / 2; };
  function maybeLearn(force) {
    const done = st.preds.filter(p => p.done);
    if (!force && Date.now() - st.lastLearn < 6 * 3600e3) { apply(); return; }
    st.lastLearn = Date.now();
    // 1) roll back the last change if results since then say the previous weights were better
    if (st.prev && st.adoptedAt) {
      const after = done.filter(p => p.at >= st.adoptedAt);
      if (after.length >= 30) { const a = obj(after, st.adj), b = obj(after, st.prev);
        if (b > a + 0.01) { st.rounds.unshift({ at: Date.now(), hz: 'all', n: after.length, before: +a.toFixed(3), after: +b.toFixed(3), what: 'rolled back' }); st.adj = st.prev; st.prev = null; st.adoptedAt = 0; }
        else if (after.length >= 60) st.prev = null; } // confirmed
    }
    // 2) tune: older 70% train, newest 30% check
    for (const hz of HZS) {
      const ps = done.filter(p => p.hz === hz).sort((a, b) => a.at - b.at); if (ps.length < 60) continue;
      const cut = Math.floor(ps.length * 0.7), tr = ps.slice(0, cut), va = ps.slice(cut);
      const keys = [...new Set(ps.flatMap(p => p.f.map(x => keyOf(x[0]))))];
      const cur = Object.assign({}, st.adj), chal = Object.assign({}, cur); let best = obj(tr, chal);
      for (let pass = 0; pass < 2; pass++) for (const k of keys) for (const d of [-0.25, 0.25]) {
        const v = +clamp((chal[k] == null ? 1 : chal[k]) + d, 0.5, 1.5).toFixed(2), t = Object.assign({}, chal, { [k]: v }), o = obj(tr, t);
        if (o > best + 0.002) { best = o; chal[k] = v; }
      }
      const vb = obj(va, cur), vn = obj(va, chal), ok = vn >= vb + 0.01;
      st.rounds.unshift({ at: Date.now(), hz, n: ps.length, before: +vb.toFixed(3), after: +vn.toFixed(3), what: ok ? 'adopted' : 'kept' });
      if (ok) { st.prev = cur; st.adj = chal; st.adoptedAt = Date.now(); }
    }
    st.rounds = st.rounds.slice(0, 30); save(); apply();
  }

  // ---------- report ----------
  function report() {
    const done = st.preds.filter(p => p.done), pend = st.preds.length - done.length, by = {};
    for (const hz of HZS) {
      const d = done.filter(p => p.hz === hz), buy = d.filter(p => p.sc >= 58), wait = d.filter(p => p.sc < 58);
      const hit = a => a.length ? Math.round(100 * a.filter(p => p.o).length / a.length) : null;
      const base = d.length ? d.filter(p => p.o).length / d.length : 0, cal = d.filter(p => p.pc != null);
      const brier = cal.length ? cal.reduce((s, p) => s + (p.pc / 100 - p.o) ** 2, 0) / cal.length : null, naive = cal.length ? cal.reduce((s, p) => s + (base - p.o) ** 2, 0) / cal.length : null;
      by[hz] = { n: d.length, buyN: buy.length, buyHit: hit(buy), waitHit: hit(wait), brier, naive };
    }
    const tuned = Object.entries(E.MODEL.w).map(([k, m]) => [k, m * (st.adj[k] || 1)]).concat(Object.entries(st.adj).filter(([k]) => E.MODEL.w[k] == null)).filter(x => Math.abs(x[1] - 1) > 0.01).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1));
    return { on: st.on, model: E.MODEL, src, total: st.preds.length, pending: pend, resolved: done.length, by, rounds: st.rounds, tuned, local: Object.keys(st.adj).length };
  }
  return {
    init, log, resolve, tick, report, maybeLearn,
    setOn(v) { st.on = !!v; save(); apply(); },
    reset() { const on = st.on; st = blank(); st.on = on; save(); apply(); },
  };
})();
Learn.ready = Learn.init().catch(() => {});
window.Learn = Learn;
