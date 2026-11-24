"""Build www/us.json: every US-listed common stock (Nasdaq Trader symbol directory)
plus S&P 500 / 400 / 600 membership with GICS sectors (large / mid / small cap). Keeps the old file on failure."""
import html, json, pathlib, re, sys, urllib.request, datetime
OUT = pathlib.Path(__file__).resolve().parent.parent / 'www' / 'us.json'
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', 'Accept': '*/*'}
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=40) as r:
        return r.read().decode('utf-8', 'replace')

def y(s):  # Yahoo uses '-' for share classes (BRK.B -> BRK-B)
    return s.strip().replace('.', '-').replace('/', '-')
BAD = re.compile(r'\b(warrant|warrants|unit|units|right|rights|notes?|debentures?|preferred|depositary shares? representing.*preferred|% )', re.I)

eq = {}
try:
    for line in get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt').splitlines()[1:]:
        p = line.split('|')
        if len(p) < 7 or p[0].startswith('File Creation'): continue
        sym, name, test, etf = p[0], p[1], p[3], p[6]
        if test == 'Y' or etf == 'Y' or BAD.search(name): continue
        eq[y(sym)] = re.sub(r'\s*-\s*(Class [A-Z]\s+)?(Common Stock|Ordinary Shares|American Depositary Shares).*$', '', name).strip()
    for line in get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt').splitlines()[1:]:
        p = line.split('|')
        if len(p) < 7 or p[0].startswith('File Creation'): continue
        sym, name, etf, test = p[0], p[1], p[4], p[6]
        if test == 'Y' or etf == 'Y' or BAD.search(name) or '$' in sym: continue
        eq[y(sym)] = re.sub(r'\s+(Common Stock|Ordinary Shares|Class [A-Z] Common Stock).*$', '', name).strip()
    print('US listed stocks', len(eq))
except Exception as e:
    print('nasdaqtrader failed:', e)

def tables(page):
    out = []
    for tm in re.finditer(r'<table[\s\S]*?</table>', page):
        rows = [[html.unescape(re.sub(r'<[^>]+>', ' ', c)).strip() for c in re.findall(r'<t[hd][^>]*>([\s\S]*?)</t[hd]>', r)] for r in re.findall(r'<tr[\s\S]*?</tr>', tm.group(0))]
        rows = [[re.sub(r'\s+', ' ', c) for c in r] for r in rows if r]
        if rows: out.append(rows)
    return out

cat = {}
for code, title in [('L', 'List_of_S%26P_500_companies'), ('M', 'List_of_S%26P_400_companies'), ('S', 'List_of_S%26P_600_companies')]:
    try:
        n = 0
        for rows in tables(get('https://en.wikipedia.org/wiki/' + title)):
            hdr = [h.lower() for h in rows[0]]
            si = next((k for k, h in enumerate(hdr) if h in ('symbol', 'ticker symbol', 'ticker')), -1)
            gi = next((k for k, h in enumerate(hdr) if 'gics sector' in h), -1)
            ni = next((k for k, h in enumerate(hdr) if h in ('security', 'company')), -1)
            if si < 0 or gi < 0: continue
            for r in rows[1:]:
                if len(r) <= max(si, gi): continue
                s = y(r[si]); cat.setdefault(s, [code, r[gi]]); n += 1
                if s not in eq and ni >= 0: eq[s] = r[ni]
            if n: break
        print('cap', code, n)
    except Exception as e:
        print('cap', code, 'failed:', e)

if len(eq) < 2000 and len(cat) < 400:
    print('keeping existing us.json / seed'); sys.exit(0)
OUT.write_text(json.dumps({'eq': sorted([[k, v] for k, v in eq.items()]), 'cat': cat, 'updated': datetime.date.today().isoformat()}, separators=(',', ':')))
print('wrote', OUT, len(eq), 'stocks,', len(cat), 'categorised')
