# Wealthsimple Application Video

Prompt: “Tell us about a project you built or contributed to that you're genuinely proud of. What was your role, what did you ship, and what was the impact?”

Maximum: 90 seconds. Target: 80–85 seconds.

## Final script

I became interested in prediction markets and wanted to understand how they worked. Most platforms focus on public events, so I built Probable for private markets between friends.

I owned the project end to end: the user flow, data model, pricing engine, and deployment. I built the interface in JavaScript with Vite, and the trading path in Python and PostgreSQL, with Supabase for authentication and persistence.

The hardest problem was liquidity. Small groups rarely have buyers and sellers arrive at the same time, so a traditional order book does not work. I implemented an LMSR market maker so every trade receives an immediate price.

Each transaction updates the user's balance, position, market probability, volume, and recorded trade history together. Those updates then power the chart, portfolio, and leaderboard you're seeing here.

During development and testing, the system processed more than 350 recorded transactions across 36 markets. Watching people use it taught me that correct math is not enough. Market products also need understandable rules, visible price impact, and trustworthy settlement.

I'm proud because I turned curiosity into a working transactional system—and became a much stronger technical builder in the process.

## Delivery beats

1. Curiosity about prediction markets; private groups were the gap.
2. End-to-end ownership from interface to deployment.
3. The small-group liquidity problem.
4. LMSR provides an immediate price without a matching counterparty.
5. One transaction updates balance, position, probability, volume, and history.
6. 350+ recorded transactions across 36 markets during development and testing.
7. Correct math still has to feel understandable and trustworthy.

## Product recording sequence

- Open `/demo/wealthsimple` and show the Sporty Boys group.
- Open the prepared Arsenal market.
- Pause on the $1,000 order preview and visible price impact.
- Execute the order and hold on the transaction receipt.
- Open Portfolio, then Leaderboard.
- Use **Reset demo** before recording another take.

All values on this route are labelled synthetic and remain entirely in the browser. No production data is modified.
