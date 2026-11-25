// Shared by validate.js and learn.js: universes, cached Yahoo daily fetch, helpers.
const fs = require('fs');
const TRAIN = ['RELIANCE','TCS','HDFCBANK','ICICIBANK','INFY','BHARTIARTL','SBIN','ITC','LT','HINDUNILVR','KOTAKBANK','AXISBANK','BAJFINANCE','MARUTI','SUNPHARMA','HCLTECH','M&M','TITAN','ASIANPAINT','ULTRACEMCO','NTPC','POWERGRID','ONGC','TATASTEEL','JSWSTEEL','ADANIPORTS','COALINDIA','WIPRO','TECHM','NESTLEIND','BAJAJFINSV','HINDALCO','CIPLA','DRREDDY','EICHERMOT','BRITANNIA','APOLLOHOSP','INDUSINDBK','TRENT','BEL'];
const TEST = ['TATAPOWER','IOC','BPCL','GAIL','PNB','BANKBARODA','CANBK','BHEL','SAIL','NMDC','PFC','RECLTD','SIEMENS','ABB','PIDILITIND','DABUR','GODREJCP','HAVELLS','DMART','NAUKRI','POLYCAB','DIVISLAB','LUPIN','AUROPHARMA','TVSMOTOR','ASHOKLEY','CHOLAFIN','MUTHOOTFIN','FEDERALBNK','IDFCFIRSTB','PERSISTENT','COFORGE','MPHASIS','DIXON','IRCTC','HINDZINC','VOLTAS','TATACOMM','PAGEIND','BALKRISIND'];
const CACHE = process.env.YF_CACHE || '/tmp/yfcache';
async function fetchDaily(s) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.startsWith('^') ? s : s + '.NS')}?range=5y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const R = (await r.json()).chart.result[0], q = R.indicators.quote[0], D = { t: [], o: [], h: [], l: [], c: [], v: [] };
  R.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null)) return; D.t.push(t); D.o.push(q.open[i]); D.h.push(q.high[i]); D.l.push(q.low[i]); D.c.push(q.close[i]); D.v.push(q.volume[i] || 0); });
  return D;
}
async function daily(s) {
  const f = `${CACHE}/${s.replace(/[^A-Z0-9]/gi, '_')}.json`;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  const D = await fetchDaily(s);
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(D)); } catch (e) {}
  return D;
}
const slice = (D, a, b) => ({ t: D.t.slice(a, b), o: D.o.slice(a, b), h: D.h.slice(a, b), l: D.l.slice(a, b), c: D.c.slice(a, b), v: D.v.slice(a, b) });
function outcome(D, i, dir, stop, target, hold = 30) { for (let j = i + 1; j <= Math.min(D.c.length - 1, i + hold); j++) { if (dir > 0 ? D.l[j] <= stop : D.h[j] >= stop) return -1; if (dir > 0 ? D.h[j] >= target : D.l[j] <= target) return 1; } return 0; }
function corr(x, y) { const n = x.length; if (n < 3) return 0; const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let a = 0, b = 0, c = 0; for (let k = 0; k < n; k++) { a += (x[k] - mx) * (y[k] - my); b += (x[k] - mx) ** 2; c += (y[k] - my) ** 2; } return b && c ? a / Math.sqrt(b * c) : 0; }
module.exports = { TRAIN, TEST, daily, slice, outcome, corr };
