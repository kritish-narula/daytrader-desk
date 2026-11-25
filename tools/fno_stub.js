// Test helper for tools/fno_research.js: stub fetch serving deterministic weekday-only synthetic Yahoo daily data (indices, India VIX, stocks). Use: node -r ./tools/fno_stub.js tools/fno_research.js --quick --out /tmp/x
let hash = s => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
function gen(sym) {
  let seed = hash(sym) % 2147483646 + 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const N = 1850, end = Date.UTC(2026, 10, 24), days = []; for (let d = end; days.length < N; d -= 864e5) { const w = new Date(d).getUTCDay(); if (w !== 0 && w !== 6) days.unshift(d); }
  const vixSym = /INDIAVIX/.test(sym), idx = /^\^/.test(sym) || /NIFTY/.test(sym);
  const ts = [], o = [], h = [], l = [], c = [], v = []; let p = vixSym ? 15 : idx ? 18000 : 100 + rnd() * 2000, sv = 0.009;
  // common market factor so VIX moves against the indices
  const mk = hash('MKT') % 1000 + 1; let ms = mk; const mr = () => { ms = (ms * 16807) % 2147483647; return ms / 2147483647; };
  const mg = () => { let u = 0, w = 0; while (!u) u = mr(); while (!w) w = mr(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
  for (let i = 0; i < N; i++) {
    const m = mg(); sv = Math.max(0.004, Math.min(0.03, sv * (1 + 0.08 * g()) + 0.03 * (0.009 - sv)));
    const op = p * (1 + g() * 0.002);
    if (vixSym) { p = Math.max(9, Math.min(60, p * Math.exp(-0.9 * m * 0.03 + 0.03 * g() + 0.03 * (Math.log(15) - Math.log(p))))); h.push(Math.max(op, p) * 1.01); l.push(Math.min(op, p) * 0.99); }
    else { p *= Math.exp(0.0004 + (idx ? 0.8 : 0.5) * sv * m + (idx ? 0.5 : 0.85) * sv * g()); h.push(Math.max(op, p) * (1 + Math.abs(g()) * sv * 0.4)); l.push(Math.min(op, p) * (1 - Math.abs(g()) * sv * 0.4)); }
    ts.push(Math.floor(days[i] / 1000) + 3600 * 4); o.push(op); c.push(p); v.push(vixSym ? 0 : Math.round(1e6 * Math.exp(0.4 * g())));
  }
  return { ts, o, h, l, c, v };
}
global.fetch = async (u) => {
  const m = /chart\/([^?]+)\?/.exec(String(u)); const sym = decodeURIComponent(m ? m[1] : 'X'), x = gen(sym);
  return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: x.c[x.c.length - 1] }, timestamp: x.ts, indicators: { quote: [{ open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v }] } }] } }) };
};
