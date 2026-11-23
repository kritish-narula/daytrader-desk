# DayTrader Desk
Stock analysis app for India (NSE, all listed stocks + F&O) and global markets.

- **Separate India 🇮🇳 and Global 🌎 screens**, search across every NSE stock and any global ticker.
- **Score out of 100 for 5 time frames**: Intraday (today), Swing (3–10 days), Short (2–6 weeks), Medium (2–6 months), Long (1 yr+). Each gives BUY / SELL / HOLD with entry, stop loss, Target 1 and Target 2.
- **Win odds**: how often the same signal hit Target 1 before the stop on that stock's own last ~3 years.
- **Engine**: EMA 9/20/21/50/150/200, RSI, MACD, ADX/DI, Supertrend, ATR, Bollinger squeeze, VWAP and opening range (intraday), volume surges, 52-week position.
- **Patterns**: engulfing, hammer, shooting star, inside bar, NR7, 20-day breakout/breakdown, 52-week-high breakout, bull/bear flag, double bottom/top, trend structure, Supertrend flips — with pattern targets and invalidation levels.
- **EMA cross forecast**: 9/21, 20/50, 50/200 crosses that just happened or are projected within days.
- **Scanner**: large caps, all F&O stocks, or all NSE; filters for top buys, intraday movers, EMA cross soon, patterns, top sells.
- **F&O**: lot sizes (from NSE), futures sizing, ATM strike and option idea, expected 1-day / 1-week move.
- **ORB Desk**: the original opening-range-breakout + Time Machine tool from the MIT [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill).

Live data comes from Yahoo Finance through native HTTP in the Android app (no API keys). Browsers block it, so use the APK.

**Install:** Releases → latest `app-debug.apk`.

Not investment advice. Technical signals only; most traders lose money.
