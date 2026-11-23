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
try:
    for r in csv.reader(io.StringIO(get('https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv'))):
        r = [x.strip() for x in r]
        if len(r) < 3 or not r[1] or r[1].upper() == 'SYMBOL':
            continue
        lot = next((int(x) for x in r[2:] if x.isdigit()), None)
        if not lot:
            continue
        if r[1] in ('NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'):
            idx[r[1]] = lot
        else:
            fo[r[1]] = lot
    print('fno stocks', len(fo), 'indices', idx)
except Exception as e:
    print('fo lots failed:', e)
if len(eq) < 500:
    print('keeping existing nse.json / seed'); sys.exit(0)
OUT.write_text(json.dumps({'eq': eq, 'fo': fo, 'idx': idx, 'updated': datetime.date.today().isoformat()}, separators=(',', ':')))
print('wrote', OUT)
