"""Download NSE's equity list and F&O lot sizes into www/nse.json. Keeps the old file on failure."""
import csv, io, json, pathlib, sys, urllib.request, datetime
OUT = pathlib.Path(__file__).resolve().parent.parent / 'www' / 'nse.json'
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', 'Accept': '*/*', 'Referer': 'https://www.nseindia.com/'}
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=40) as r:
        return r.read().decode('utf-8', 'replace')
eq, fo, idx = [], {}, {}
try:
    rows = list(csv.reader(io.StringIO(get('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv'))))
    for r in rows[1:]:
        if len(r) > 2 and r[2].strip() in ('EQ', 'BE', 'BZ', 'SM', 'ST'):
            eq.append([r[0].strip(), r[1].strip()])
    print('equities', len(eq))
except Exception as e:
    print('equity list failed:', e)
NSE_IDX = ('NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50')
BSE_IDX = ('SENSEX', 'BANKEX', 'SENSEX50')   # BSE derivatives indices (lots come from the mStock script master in the app)

def parse_mktlots(text):
    """fo_mktlots.csv: UNDERLYING,SYMBOL,<expiry month>,... with section rows ('Derivatives on Indices' / 'on Individual Securities').
    Lot = lot of the nearest month that has one. Tolerates header drift, blank/section rows, quotes, thousands separators."""
    stocks, indices, sec_idx = {}, {}, False
    for r in csv.reader(io.StringIO(text.replace('\ufeff', ''))):
        r = [x.strip().strip('"') for x in r]
        if not any(r):
            continue
        joined = ' '.join(r).lower()
        if len(r) < 3 or not r[1] or r[1].upper() in ('SYMBOL', 'SYMBOL '):
            if 'indices' in joined or 'index' in joined: sec_idx = True
            elif 'individual' in joined or 'securities' in joined or 'stock' in joined: sec_idx = False
            continue
        sym = r[1].upper().replace(' ', '')
        lot = next((int(x.replace(',', '')) for x in r[2:] if x.replace(',', '').isdigit() and int(x.replace(',', '')) > 0), None)
        if not lot:
            continue
        if sym in NSE_IDX or (sec_idx and sym.startswith('NIFTY')):
            indices[sym] = lot
        else:
            stocks[sym] = lot
    return stocks, indices

def get_with_cookie(u):
    """NSE website APIs need a cookie from the home page first."""
    import http.cookiejar
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [(k, v) for k, v in H.items()]
    op.open('https://www.nseindia.com/', timeout=30).read()
    return op.open(u, timeout=30).read().decode('utf-8', 'replace')

try:
    for u in ('https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv', 'https://archives.nseindia.com/content/fo/fo_mktlots.csv'):
        try:
            fo, idx = parse_mktlots(get(u))
            if len(fo) >= 100:
                print('fo_mktlots from', u); break
        except Exception as e:
            print('fo_mktlots failed', u, e)
except Exception as e:
    print('fo lots failed:', e)
if len(fo) < 100:  # fallback: NSE's underlying list (symbols only, no lot sizes) so the universe is still complete
    try:
        j = json.loads(get_with_cookie('https://www.nseindia.com/api/underlying-information'))['data']
        for x in j.get('UnderlyingList', []):
            if x.get('symbol') and x['symbol'] not in fo: fo[x['symbol'].upper()] = 0
        for x in j.get('IndexList', []):
            if x.get('symbol') and x['symbol'].upper() in NSE_IDX: idx.setdefault(x['symbol'].upper(), 0)
        print('fo universe from underlying-information API (no lots):', len(fo))
    except Exception as e:
        print('underlying-information failed:', e)
# BSE: index derivatives (SENSEX, BANKEX, SENSEX50) + stock derivatives (BSE added ~40 stocks Nov-2024 and more through 2026).
# BSE has no stable public CSV of its underlyings; the app reads the exact BFO list + lots from the mStock script master. Names only here.
bfo_idx = list(BSE_IDX)
print('fno stocks', len(fo), 'nse indices', idx, 'bse indices', bfo_idx)
# market-cap buckets + industry from NSE index constituent files
cat = {}
for code, files in [('L', ['ind_nifty100list.csv']), ('M', ['ind_niftymidcap150list.csv']), ('S', ['ind_niftysmallcap250list.csv']), ('U', ['ind_niftymicrocap250_list.csv', 'ind_niftymicrocap250list.csv'])]:
    done = False
    for f in files:
        for base in ('https://nsearchives.nseindia.com/content/indices/', 'https://www.niftyindices.com/IndexConstituent/', 'https://archives.nseindia.com/content/indices/'):
            try:
                rows = list(csv.DictReader(io.StringIO(get(base + f))))
                n = 0
                for r in rows:
                    r = {k.strip().lower(): (v or '').strip() for k, v in r.items() if k}
                    if r.get('symbol'):
                        cat.setdefault(r['symbol'], [code, r.get('industry', '')]); n += 1
                if n:
                    print('cap', code, f, n, 'from', base); done = True; break
            except Exception as e:
                print('cap file failed', base + f, e)
        if done:
            break
print('categorised', len(cat))
if len(eq) < 500:
    print('keeping existing nse.json / seed'); sys.exit(0)
OUT.write_text(json.dumps({'eq': eq, 'fo': fo, 'idx': idx, 'bidx': bfo_idx, 'cat': cat, 'updated': datetime.date.today().isoformat()}, separators=(',', ':')))
print('wrote', OUT)
