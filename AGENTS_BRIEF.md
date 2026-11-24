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
