# DayTrader Desk — UI rehaul brief (for all agents)

## Goal
Make the app look and feel like a polished finance app — inspiration: **Google Finance** (clean cards, big readable price, range tabs, market summary carousel, "compare" chips) and **Yahoo Finance** (quote header, large interactive chart with range tabs 1D/5D/1M/6M/YTD/1Y/5Y/Max, key statistics table, news list with thumbnails-less clean rows). Mobile only (Android WebView, 360–430 px wide). Dark theme default; also support a light theme via `html[data-theme="light"]`.

## Hard constraints (user feedback — do not violate)
1. The user REJECTED a previous "compact" redesign that hid things behind dropdowns. Keep the list filters (Overall, Leaders, Breakouts, Near breakout, Patterns, Intraday, Swing, Short, Medium, Long, SMC/VCP, EMA cross, News, Sells) **visible as one-tap chips**, and keep indicator/pattern **tags visible in list rows**. Horizon switching (Overall / Intraday / Swing / Short / Medium / Long) must stay one tap.
2. Charts were "too short". The stock-page chart must be **big (≥ 340 px tall on a 860 px screen)**, interactive (touch pan/zoom), with **range tabs** and a full-screen button.
3. Do not remove any feature. Every number currently shown (ratings, levels, setups + evidence, chart patterns, EMA crosses, risk profile, news, F&O/option cards, sizing) must still be shown.
4. Chart labels stay short: E, SL, T1, T2, S, R, PT.
5. No new network hosts (CSP). Data only through existing helpers.

## Architecture (how to change the UI without merge conflicts)
`www/app.js` defines global functions (classic script). Later scripts can **redefine** a top-level function (e.g. `function drawDetail(){…}`) and the app will call the new one. Each agent owns ONE new file and must NOT edit `app.js`, `app.css`, `chart.js`, `engine.js` (except the strategy agent, which owns `engine.js`).

Load order (already wired in index.html by the manager):
`app.css` → `theme.css` → `home.css` → `detail.css` · scripts: `seed.js, vendor/lightweight-charts.js, engine.js, news.js, security.js, alerts.js, broker.js, app.js, chart.js, ui-home.js, ui-detail.js, boot.js`

| Owner | Files | Scope |
|---|---|---|
| Theme agent (Opus) | `www/theme.css`, `www/ui-theme.js` | Design tokens, typography, header, bottom nav, cards, list rows, chips, badges, buttons, inputs, settings/alerts/F&O screens styling, light/dark toggle |
| Home agent (Sonnet) | `www/ui-home.js`, `www/home.css` | Redefine `vHome()` (+ helpers) and `drawScan()`/`rowHTML()` visuals |
| Stock page agent (Opus) | `www/ui-detail.js`, `www/detail.css` | Redefine `vDetail()`, `drawDetail()`, `drawPreview()` |
| Strategy agent (Opus) | `www/engine.js` only | Strategy/setup logic polish |

## Design tokens (theme agent defines in theme.css; others USE these names)
```
--bg, --bg2 (page), --card, --card2 (raised), --line (hairlines), --text, --text2 (secondary), --text3 (tertiary)
--accent (brand blue), --up (green), --down (red), --warn (amber), --up-bg, --down-bg, --warn-bg (10–14% tints)
--r-sm 10px, --r 16px, --r-lg 22px; --pad 14px; --shadow (subtle)
font: system-ui / Roboto; tabular numerals for prices (font-variant-numeric: tabular-nums)
```
Existing variable names used across app.css (`--bg --pn --pn2 --ln --tx --mu --up --dn --ac --wa --upb --dnb --wab`) must keep working — the theme agent maps them onto the new tokens.

## Shared component class names (keep these — app.js emits them)
`.card .list .row .nm .s .f .px .sc(.b1/.b0/.b-1) .tag(.p/.n) .chips .btn .pill .note .warn .kv .lv .hzrow .hzc .ring .verdict .sub .why .pat .setup .evd .news .opt .cp .buyline .stk .seg .nav .top .toprow .gear .bell .search .idx .regime .pick2 .sheet .lock .pad`

## Useful globals in app.js
State `S` (S.mkt 'IN'|'US', S.tab, S.detail {sym, mkt, A, R, D, intra, news, src}, S.scan[mkt].rows, S.saved[mkt], S.hz), `MK[mkt]` (cur, tick, idx()), helpers `$ esc fmt pct cls badge cur marketOpen chart(ysym, range, interval) ySym nameOf rated(rows, filter, mkt) rateRow hzRate tagsOf rowFromA riskCard sizeLine evidence newsHTML newsHead ring go back openDetail bindRows store toast`, `Engine.*` (analyze, rating, hzRating, setups, chartPatterns, levels, risk, riskLabel, setupEdge), `ChartView.open({sym, mkt, levels, hz})`, `window.LightweightCharts` (v4.2).

## Testing
Each agent gets its own static server copy so you don't clash:
```
rm -rf /tmp/srv_<you> && cp -r /home/claude/daytrader-desk/www /tmp/srv_<you> && cp /tmp/srv/nse.json /tmp/srv/us.json /tmp/srv_<you>/ && cd /tmp/srv_<you> && (python3 -m http.server <port> >/dev/null 2>&1 &)
```
Re-copy your files after edits. Use Playwright with Chrome at `/usr/bin/google-chrome`, viewport 400×860, scale 2. Mock market data: `exec(open('/home/claude/v3.py').read().split('with sync_playwright()')[0])` gives `handle` (route for `**/*yahoo.com/**`) and `gnews` (route for `**/news.google.com/**`). Look at your screenshots with the Read tool and iterate until it looks genuinely good. Report pageerrors — there must be none.
Do NOT git commit or push. Do not edit files you don't own.
