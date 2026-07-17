# Probable Interview Demo Checklist

## Demo Flow

1. Open `https://probable.live` and enter the app.
2. Show groups are private contexts, not one global public market.
3. Open a market and explain the price chart as the market-implied probability path from actual trades.
4. Place a small buy and show probability, balance, positions, leaderboard, and chart update.
5. Show a sell and explain cash-out value vs mark value.
6. Open admin resolution and explain manual settlement/payout guardrails.
7. Show bracket as a seasonal contest layer, separate from regular group markets.

## Quant Talking Points

- Prices are probabilities: a 63 cent YES is displayed as roughly 63% implied probability.
- Probabilities across multi-outcome events are kept coherent through one event-level pricing state.
- Buying one outcome pushes its probability up and pushes alternatives down.
- Liquidity controls sensitivity: smaller groups need more movement per trade than Polymarket, but not so much that one user can trivially pin prices.
- The app separates mark value from cash-out value. Mark value is good for leaderboard/social competition; cash-out is conservative and includes price impact.
- Trade history is append-only and used to render charts, recent activity, positions, and leaderboard state.

## Reliability Checks Before Demo

- Run `npm run build`.
- Run `node --check src/main.js`.
- Run `.venv/bin/python -m py_compile backend/main.py`.
- Hit `https://probable-fun.onrender.com/api/health` before the call so Render is awake.
- Confirm Supabase Google auth redirect includes `https://probable.live`.
- Do not show local `.env.local`; rotate any API key that has been pasted into chat or screenshots.

## Honest Caveats

- This is fake-money only.
- Manual verification is the default operating mode for now.
- Render free-tier cold starts are a deployment constraint, not a pricing-engine issue.
- The next production hardening step is server-side auth enforcement/RLS lockdown plus always-on backend hosting.
