// Self-improvement loop (runs in CI on every build and every Sunday):
//  1. Replays 5 years of daily data for a TRAIN and an out-of-sample TEST universe, walk-forward, no look-ahead.
//  2. Tunes each rating factor's weight multiplier (coordinate search, small steps from the current champion).
//  3. Champion/challenger: the new weights are adopted only if they beat the current ones on the TEST stocks.
//  4. Re-measures every score band (how often it actually hit Target 1 before the stop, average return) and
//     every setup/pattern's hit rate, then writes www/model.json, which the app loads (bundled + fetched weekly).
// Each run starts from the last adopted model, so improvements compound and bad changes are rejected.
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js');
const { TRAIN, TEST, daily, slice, outcome, corr } = require('./universe.js');
const OUT = path.join(__dirname, '../www/model.json');
const HZS = ['swing', 'short', 'medium'];
const STEP_F = 4, STEP_P = 2, MAXM = 2.5, MOVE = 0.5, MIN_GAIN = 0.002;

let champ = { v: 0, w: {} };
try { champ = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
E.setModel(Object.assign({}, champ, { v: champ.v || 1 })); // setup stats from the champion feed setupScore
E.MODEL.w = {}; // factors are read raw; multipliers are applied here

async function collect(SYMS, g, S, pat) {
  let stocks = 0;
  for (const s of SYMS) {
    let D; try { D = await daily(s); } catch (e) { continue; } if (!D || D.c.length < 600) continue; stocks++;
    const seen = new Set();
    for (let i = 320; i < D.c.length - 11; i += STEP_P) {
      const W = slice(D, i - 299, i + 1), I = E.indicators(W), k = W.c.length - 1, px = W.c[k];
      // setups & chart patterns: did they hit target before stop (same rules as validate.js)
      const items = [...E.chartPatterns(I, 0.05).filter(p => p.status !== 'forming').map(p => ({ n: p.n, b: p.b, stop: p.stop, target: p.target, key: p.n + p.id })),
                     ...E.setups(I, k, 0.05).filter(x => x.entry && x.stop && x.target && x.k !== 'PRE').map(x => ({ n: x.n, b: x.b, stop: x.stop, target: x.target, key: x.n + Math.floor(i / 10) }))];
      for (const it of items) { if (!it.b || seen.has(it.key)) continue; seen.add(it.key);
        const o = outcome(D, i, it.b, it.stop, it.target), P = pat[it.n] = pat[it.n] || { tr: { n: 0, w: 0, l: 0, rr: 0 }, te: { n: 0, w: 0, l: 0, rr: 0 } }, Q = P[g];
        Q.n++; Q.rr += Math.min(10, Math.abs(it.target - px) / Math.max(1e-9, Math.abs(px - it.stop))); if (o > 0) Q.w++; else if (o < 0) Q.l++; }
      if (i % STEP_F) continue;
      for (const hz of HZS) {
        const hold = E.HORIZONS[hz].hold; if (i + hold >= D.c.length) continue;
        if (hz === 'medium' && W.c.length < 160) continue;
        const f = E._rawFactors(I, k, hz); if (!f.length) continue;
        const L = E._levels(I, k, hz, 1, 1e-9, px);
        const o = outcome(D, i, 1, L.stop, L.t1, hold), ret = (D.c[i + hold] / px - 1) * 100;
        S.push({ g, hz, f: f.map(x => [x[4], x[5], x[1]]), hit: o > 0 ? 1 : 0, ret, retR: Math.max(-4, Math.min(4, ret / Math.max(0.1, L.riskPct))) });
      }
    }
  }
  return stocks;
}
const comp = (smp, m) => { let s = 0, w = 0; for (const [key, w0, x] of smp.f) { const ww = w0 * (m[key] == null ? 1 : m[key]); s += ww * x; w += ww; } return w ? s / w : 0; };
// objective: does the composite separate winners from losers? (mean of correlation with risk-adjusted return and with T1 hit)
function obj(smps, m) { if (smps.length < 50) return 0; const c = smps.map(x => comp(x, m)); return (corr(c, smps.map(x => x.retR)) + corr(c, smps.map(x => x.hit))) / 2; }

(async () => {
  const S = [], pat = {};
  const nTr = await collect(TRAIN, 'tr', S, pat), nTe = await collect(TEST, 'te', S, pat);
  console.log(`Self-learning run · champion v${champ.v || 0} · ${nTr} train + ${nTe} test stocks · ${S.length} samples`);
  if (S.length < 500) { console.log('Not enough data — keeping the current model.'); return; }
  const W = Object.assign({}, champ.w || {}), metrics = {};
  for (const hz of HZS) {
    const tr = S.filter(x => x.hz === hz && x.g === 'tr'), te = S.filter(x => x.hz === hz && x.g === 'te');
    const keys = [...new Set(tr.flatMap(x => x.f.map(y => y[0])))];
    const cur = {}; for (const k of keys) cur[k] = W[k] == null ? 1 : W[k];
    const chal = Object.assign({}, cur); let best = obj(tr, chal);
    for (let pass = 0; pass < 3; pass++) for (const k of keys) {
      for (const d of [-0.5, -0.25, 0.25, 0.5]) {
        const v = Math.round(Math.max(0, Math.min(MAXM, chal[k] + d)) * 100) / 100;
        if (Math.abs(v - cur[k]) > MOVE + 1e-9 || v === chal[k]) continue;
        const t = Object.assign({}, chal, { [k]: v }), o = obj(tr, t);
        if (o > best + 0.0005) { best = o; chal[k] = v; }
      }
    }
    const trC = obj(tr, cur), teC = obj(te, cur), teN = obj(te, chal);
    const adopt = teN >= teC + MIN_GAIN && best > trC;
    const use = adopt ? chal : cur; Object.assign(W, use);
    metrics[hz] = { train: +trC.toFixed(4), trainNew: +best.toFixed(4), test: +teC.toFixed(4), testNew: +teN.toFixed(4), adopted: adopt, n: tr.length + te.length };
    console.log(`\n[${hz}] quality (train/test): champion ${trC.toFixed(4)}/${teC.toFixed(4)} · challenger ${best.toFixed(4)}/${teN.toFixed(4)} → ${adopt ? 'ADOPTED' : 'kept champion'}`);
    for (const k of keys) if (use[k] !== 1) console.log(`   ${k.padEnd(58)} ×${use[k]}`);
  }
  // score bands → real hit rate and return, with the adopted weights
  const calib = {}, B = E.calibBins;
  for (const hz of HZS) {
    const bins = B.slice(0, -1).map((lo, k) => ({ lo, hi: B[k + 1], n: 0, h: 0, r: 0, u: 0 }));
    for (const x of S) if (x.hz === hz) { const sc = E._toScore(comp(x, W)), b = bins[E.binOf(sc)]; b.n++; b.h += x.hit; b.r += x.ret; b.u += x.ret > 0; }
    calib[hz] = bins.filter(b => b.n >= 20).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, p: +(b.h / b.n).toFixed(3), ret: +(b.r / b.n).toFixed(2), up: +(b.u / b.n).toFixed(3) }));
    console.log(`\n[${hz}] score band → hit T1 first · avg ${E.HORIZONS[hz].hold}-day return · n`);
    for (const b of calib[hz]) console.log(`   ${String(b.lo).padStart(3)}–${String(b.hi - 1).padEnd(3)} ${(b.p * 100).toFixed(0).padStart(4)}%  ${b.ret >= 0 ? '+' : ''}${b.ret.toFixed(2)}%  n=${b.n}`);
  }
  // setups & patterns: train+test pooled, edge only if it beat break-even in both
  const setups = {};
  console.log('\nSetup / pattern                               signals  hit  R:R  edge');
  for (const [n, P] of Object.entries(pat)) {
    const s = x => ({ wr: 100 * x.w / Math.max(1, x.w + x.l), rr: x.rr / Math.max(1, x.n) }), a = s(P.tr), b = s(P.te), N = P.tr.n + P.te.n; if (N < 20) continue;
    const hit = Math.round((a.wr * P.tr.n + b.wr * P.te.n) / N), rr = +((a.rr * P.tr.n + b.rr * P.te.n) / N).toFixed(2);
    const edge = P.tr.n >= 10 && P.te.n >= 10 && a.wr >= 100 / (1 + a.rr) && b.wr >= 100 / (1 + b.rr) ? 1 : 0;
    setups[n] = [N, hit, rr, edge]; console.log(`   ${n.padEnd(44)} ${String(N).padStart(5)} ${String(hit).padStart(3)}% ${rr.toFixed(2)} ${edge ? 'EDGE' : '-'}`);
  }
  const v = (champ.v || 0) + 1, date = new Date().toISOString().slice(0, 10);
  const w = {}; for (const [k, x] of Object.entries(W)) if (x !== 1) w[k] = x;
  const hist = [...(champ.history || []), { v, date, samples: S.length, metrics }].slice(-26);
  const labels = {}; for (const k of Object.keys(w)) if (E.LBL[k]) labels[k] = E.LBL[k];
  const model = { v, date, labels, trainedOn: { stocks: nTr + nTe, samples: S.length }, w, calib, setups, metrics, history: hist };
  // merge: keep keys other tools own (tools/research.js writes lin / thresholds / btst / research into the same file)
  fs.writeFileSync(OUT, JSON.stringify(Object.assign({}, champ, model), null, 1));
  console.log(`\nWrote model v${v} (${Object.keys(w).length} tuned weights) → www/model.json`);
})();
