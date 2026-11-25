// Tomorrow (BTST) filter — track record. For 80 NSE stocks × ~5 years: score every day's close with E.btstAt (no look-ahead),
// then measure what the NEXT session actually did: gap at the open, close-to-close return, whether Target 1 (+max(1R,1.5%))
// was reached before the stop (stop checked first; a gap below the stop exits at the open). Writes data/btst_stats.json.
const fs = require('fs'), path = require('path');
const E = require('../www/engine.js');
const { TRAIN, TEST, daily } = require('./universe.js');
try { E.setModel(JSON.parse(fs.readFileSync(path.join(__dirname, '../www/model.json'), 'utf8'))); } catch (e) {}
const BANDS = [[80, 101, '80+'], [70, 80, '70–79'], [60, 70, '60–69'], [0, 60, 'below 60']];
const COST = 0.12; // % round trip (delivery STT 0.1%×2 is higher; most BTST sells are T+1 delivery → use 0.25 below)
(async () => {
  let nifty = null; try { nifty = await daily('^NSEI'); } catch (e) {}
  const nchg = {}; if (nifty) for (let i = 1; i < nifty.c.length; i++) nchg[nifty.day ? nifty.day[i] : nifty.t[i]] = (nifty.c[i] / nifty.c[i - 1] - 1) * 100;
  const B = BANDS.map(b => ({ label: b[2], lo: b[0], hi: b[1], n: 0, up: 0, sum: 0, gap: 0, t1: 0, sl: 0 })); let stocks = 0;
  for (const s of [...TRAIN, ...TEST]) {
    let D; try { D = await daily(s); } catch (e) { continue; } if (!D || D.c.length < 300) continue; stocks++;
    const I = E.indicators(D);
    for (let i = 210; i < D.c.length - 1; i++) {
      const key = D.day ? D.day[i] : D.t[i], x = E.btstAt(D, I, i, null, { frac: 1, nifChg: nchg[key] }); if (!x) continue;
      const b = B.find(z => x.score >= z.lo && x.score < z.hi), c = D.c[i], o1 = D.o[i + 1], h1 = D.h[i + 1], l1 = D.l[i + 1], c1 = D.c[i + 1];
      const ret = (c1 / c - 1) * 100; b.n++; b.sum += ret; b.up += ret > 0; b.gap += (o1 / c - 1) * 100;
      if (o1 <= x.stop || l1 <= x.stop) b.sl++; else if (h1 >= x.t1) b.t1++;
    }
  }
  const bands = B.map(b => ({ band: b.label, n: b.n, upPct: b.n ? +(100 * b.up / b.n).toFixed(1) : null, avgRet: b.n ? +(b.sum / b.n).toFixed(3) : null, avgGap: b.n ? +(b.gap / b.n).toFixed(3) : null, t1Pct: b.n ? +(100 * b.t1 / b.n).toFixed(1) : null, stopPct: b.n ? +(100 * b.sl / b.n).toFixed(1) : null }));
  const out = { generatedAt: new Date().toISOString(), stocks, costNote: 'Returns are before costs; a BTST round trip costs roughly 0.25% (delivery STT both sides + charges).', bands };
  fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../data/btst_stats.json'), JSON.stringify(out, null, 1));
  console.log(`BTST track record · ${stocks} stocks`); for (const b of bands) console.log(`  ${b.band.padEnd(9)} n=${String(b.n).padStart(6)}  next day up ${b.upPct}%  avg ${b.avgRet}%  gap ${b.avgGap}%  T1 first ${b.t1Pct}%  stop ${b.stopPct}%`);
})().catch(e => { console.error(e); process.exitCode = 1; });
