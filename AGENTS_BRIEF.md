# DayTrader Desk — agent brief (round 3)

Repo: /home/claude/daytrader-desk (Capacitor Android app; static web app in `www/`, built by GitHub Actions into an APK; releases `build-N`; in-app updater installs over the old app).
Lead: Opus (main session). Agents edit files; **do not commit, push, or run gh**. The lead integrates, tests and ships.

## Hard rules
- Never embed, log, print or upload mStock keys/tokens/passwords. Credentials stay on the phone (broker.js + security.js vault). The app never places real orders.
- CI jobs (GitHub Actions) have NO broker credentials. CI data = Yahoo Finance / NSE public files / Google News RSS only.
- Keep the UI the user likes: filter chips and row tags visible, horizon one tap, short chart labels (E, S, R, SL, T1, T2, PT), no row sparklines, tags wrap (no sideways scroll).
- Honest numbers only: never present simulated/backtested results as live results; label them.
- Plain JS (no build step, no frameworks). Each new screen = a global `vXxx()` function that renders into `#view` (see app.js `render()` router and existing views). Helpers available globally: `$`, `esc`, `fmt`, `pct`, `toast`, `store.get/set`, `S` (state), `go(tab)`, `back()`, `chart(ySym,range,interval)` (Yahoo, returns {D:{t,o,h,l,c,v,day},meta}), `ySym(sym,mkt)`, `pool(list,n,fn)`, `marketOpen(mkt)`, `Engine` (www/engine.js), `MS` (mStock, www/broker.js), `rowHTML`, `bindRows`.
- CSS: theme tokens in www/theme.css (`--up`, `--dn`, `--wa`, `--mu`, `--card`, `--card2`, `--line`, `--up-bg`, `--down-bg`…). Add styles in your own CSS file or append a clearly marked block.

## File ownership (edit only your files; if you must touch another, make a minimal, clearly commented hook and say so in your report)
| Agent | Owns |
|---|---|
| prices (Sonnet) | www/broker.js, www/live.js, www/chart.js; in www/app.js only `dailyQuick`, `loadDetail`, `regime`, `msQuotes`; www/ui-detail.js price header only |
| fno-ui (Sonnet) | IPO removal (www/ipo.js, IPO bits of app.js/index.html/alerts.js), F&O universe (tools/nse_symbols.py, F&O parts of app.js `vFno`, `isFno`, `foLot`), nav + router in app.js/index.html, www/ui-home.js, www/home.css cleanup |
| paper (Opus) | NEW www/paper.js, www/ui-paper.js, www/paper.css, tools/paper.js, .github/workflows/paper.yml, data/paper*.json |
| flows (Sonnet) | NEW www/flows.js, www/ui-flows.js, www/flows.css, tools/flows.js, .github/workflows/flows.yml, data/flows*.json |

## Integration contract (so the pieces fit without the agents editing each other's files)
- Bottom nav after this round: **Home · Scanner · F&O · Paper · Saved** (IPO removed). Router keys: `paper: () => vPaper()`, `flows: () => vFlows()` (fno-ui agent adds both keys + the Paper nav button; paper/flows agents define the functions).
- Home shows a money-flow card: fno-ui agent calls `window.flowsCardHTML ? flowsCardHTML() : ''` in vHome and `window.bindFlowsCard && bindFlowsCard()` after render. flows agent defines both.
- Home shows a paper-trading summary: `window.paperCardHTML ? paperCardHTML() : ''` + `window.bindPaperCard && bindPaperCard()`. paper agent defines both.
- CI data files are committed to `data/` on main and fetched by the app from `https://raw.githubusercontent.com/kritish-narula/daytrader-desk/main/data/<file>.json` (already allowed in CSP via raw.githubusercontent.com). Cache last good copy in `store`.
- CI commits from workflows: `git pull --rebase` + retry push loop (3 tries), message ends with `[skip ci]`. Workflows need `permissions: contents: write`.
- New `<script>`/`<link>` tags: fno-ui agent owns index.html; paper/flows agents list the tags they need in their report (lead adds them). Load order: after app.js, before boot.js.

## Testing
- Local static server + Playwright harness: `python3 /home/claude/qa/qa.py` (mocks Yahoo; report at /home/claude/qa/report.txt, screenshots /home/claude/qa/shots/). Chrome at /usr/bin/google-chrome. No outbound internet to Yahoo/NSE here, so test CI scripts with a stub fetch (see /home/claude/strat/fakefetch.js: `node -r /home/claude/strat/fakefetch.js tools/x.js`) and Playwright route mocks (examples: /tmp/dbg_fno.py, /tmp/dbg_ms.py for mStock mocks).
- `node --check` every JS file you touch. End with a report: what changed, files, how tested, known limits.

## Round 4 (options desk + trade tracker)
| Agent | Owns |
|---|---|
| options (Opus) | NEW www/optchain.js, www/ui-options.js, www/options.css; in www/app.js: `vFno`, `indexOption`, `optCard`, `bindOpt` and F&O helpers (replace the old index option cards); index.html CSP (may add https://www.nseindia.com) and script/link tags for its files |
| trades (Sonnet) | NEW www/trades.js, www/ui-trades.js, www/trades.css; minimal hooks in www/ui-portfolio.js (add a "📈 Trades" segment to the Portfolio tab), www/app.js `watchTick` and `back()` (one line each), index.html script/link tags for its files |
Contract: options agent's "Track this trade" buttons call `window.Trades && Trades.openAdd(prefill)` where prefill = `{kind:'OPT'|'FUT'|'EQ', mkt:'IN', und, sym, exp:'YYYY-MM-DD', strike, cp:'CE'|'PE', k (mStock key e.g. 'NFO:NIFTY2612524000CE'), lot, lots, qty, side:'BUY'|'SELL', entry, sl, t1, t2, slU, t1U, t2U (underlying levels), note, source:'call'|'chain'}`.
Today's state: Portfolio tab segments are 💼 Portfolio | ⭐ Watchlist (www/ui-portfolio.js). MS (broker.js) has: map() (scriptmaster: m.opt[NAME] = [ts, token, expYYYY-MM-DD, strike, 'CE'|'PE', lot, exch] for NIFTY/BANKNIFTY/SENSEX/FINNIFTY/MIDCPNIFTY/BANKEX only — first 2 expiries; m.fo = all F&O underlyings), option(name, strike, cp, n?) → {k, ts, exp, lot, strike}, ltp(keys) → {key: price}, quotes(syms), index(sym), candles(), basis(), foUniverse(), holdings(). Paper.js has Black-Scholes helpers (Paper.bs*, expiry calendar, lot sizes, costs) usable in the browser.
