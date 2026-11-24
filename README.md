# DayTrader Desk
Stock analysis app for India (NSE, all listed stocks + F&O) and global markets.

- **Separate India 🇮🇳 and Global 🌎 screens**, search across every NSE stock and any global ticker.
- **Score out of 100 for 5 time frames**: Intraday (today), Swing (3–10 days), Short (2–6 weeks), Medium (2–6 months), Long (1 yr+). Each gives BUY / SELL / HOLD with entry, stop loss, Target 1 and Target 2.
- **Win odds**: how often the same signal hit Target 1 before the stop on that stock's own last ~3 years.
- **Engine**: EMA 9/20/21/50/150/200, RSI, MACD, ADX/DI, Supertrend, ATR, Bollinger squeeze, VWAP and opening range (intraday), volume surges, 52-week position.
- **Setups**: SMC (break of structure, change of character, order blocks, fair value gaps, liquidity sweeps), VCP (volatility contraction pattern), Minervini Stage 2 trend template, pullback to 20 EMA, oversold dip in uptrend. Each has a quality score, entry, stop and target, and feeds the ratings.
- **News**: Yahoo Finance + Google News headlines with positive/negative sentiment; moves ratings by up to ±8.
- **Live chart**: full screen, 1m/2m/3m/5m/15m/30m/1h/4h/1D/1W/1M, live ticks, EMA 9/10/20/50/100/200, VWAP, Bollinger, Supertrend, volume, RSI, MACD, SL/target lines. Free pan in any direction or sideways-only with auto-fit; pinch zoom; drag either axis to stretch. Charts by TradingView Lightweight Charts (Apache-2.0).
- **One rating, everywhere**: each stock gets an overall rating plus a rating per horizon (intraday, swing, short, medium, long). Each = technical signal blended with how that exact signal performed on that stock (backtest), plus market trend (Nifty/S&P) and news. Lists and the stock page always show the same number.
- **Horizon lists**: Swing, Intraday, Short, Medium, Long each show only stocks rated BUY for that horizon, highest first. Sells are lowest-rated first.
- **Browse by size and sector**: large / mid / small / micro cap (NSE index files), F&O, and sectors (IT, Auto, Finance, Pharma, FMCG, Metals…). Scan once, then filter instantly.
- **Background scans**: a scan keeps running when you leave the app; swiping the app out of Recents stops it.
- **Alerts**: phone notifications for new strong buys, SMC/VCP setups, EMA crosses, strong news and price alerts; optional background watch of saved stocks every 5 min in market hours.
- **Security**: app PIN (AES-256-GCM encrypted mStock credentials, PBKDF2 210k), auto-lock, optional screenshot/Recents blocking, no Android backup, WebView debugging off, content security policy.
- **Breakouts**: clean volume breakouts, near-breakout (coiling under resistance) candidates, pocket pivots, gap-and-go, filtered to stocks beating the index over 3 months (relative strength).
- **Alpha, beta & risk**: beta, alpha, upside/downside beta, volatility, Sharpe, Sortino, max drawdown and R² vs Nifty/S&P on every stock, with plain-language explanations (tap any number); ratings adjust for market trend in proportion to each stock's beta; 🏆 Leaders list; breakout lists require positive alpha; watchlist beta; suggested position size from capital and risk %.
- **Nifty / Bank Nifty / Sensex options**: names the exact contract to buy (e.g. BUY NIFTY 23100 CE) with safer ITM / balanced ATM / aggressive OTM alternatives and the reason for the pick; CALL and PUT rated 0–100 from intraday + swing signals, with BUY CALL / BUY PUT / NO TRADE, ATM strike, index SL/targets, and live premiums plus premium SL/targets when mStock is connected.
- **Chart patterns drawn on charts**: head & shoulders (and inverse), double top/bottom, bull/bear flags with pole, ascending/descending/symmetrical triangles, plus support/resistance levels — strict shape rules, labelled points, necklines, targets; toggle all or each pattern; 📐 Patterns scanner list; alerts when a saved stock completes one.
- **Validation**: every build runs a walk-forward test on 5 years of real NSE data (pattern hit rates vs break-even, rating buckets vs forward returns).
- **Patterns**: engulfing, hammer, shooting star, inside bar, NR7, 20-day breakout/breakdown, 52-week-high breakout, bull/bear flag, double bottom/top, trend structure, Supertrend flips — with pattern targets and invalidation levels.
- **EMA cross forecast**: 9/21, 20/50, 50/200 crosses that just happened or are projected within days.
- **Scanner**: large caps, all F&O stocks, or all NSE; filters for top buys, intraday movers, EMA cross soon, patterns, top sells.
- **F&O**: lot sizes (from NSE), futures sizing, ATM strike and option idea, expected 1-day / 1-week move.
- **ORB Desk**: the original opening-range-breakout + Time Machine tool from the MIT [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill).

**mStock (Mirae Asset) live data:** tap 🔌 in the app, enter your API key and client ID, then log in with OTP or TOTP (once per trading day). India prices, daily and 5-minute candles, scans and watchlist then use mStock; Yahoo is the fallback. The key and the day's token stay on your phone; the password is never stored; nothing is placed as an order.

Without mStock, live data comes from Yahoo Finance through native HTTP in the Android app (no API keys). Browsers block it, so use the APK.

**Install:** Releases → latest `app-debug.apk`.

Not investment advice. Technical signals only; most traders lose money.
