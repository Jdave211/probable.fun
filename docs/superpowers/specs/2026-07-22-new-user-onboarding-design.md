# New-User Onboarding: Learn-by-Doing Demo Market

**Date:** 2026-07-22
**Status:** Approved design

## Problem

New users meet real concepts — markets, odds in cents, buying YES/NO, resolution,
leaderboards — with no explanation. The only guidance today is empty-state text
("No open markets. Create the first active question for this group."). The result
is confusion at exactly the moment we need activation.

## Goal

A ~2-minute, learn-by-doing tutorial: the user places a practice bet in a
simulated demo market rendered by the real UI, watches the price move, sees the
market resolve and pay out, glimpses the leaderboard, and is handed off into
creating their own group.

## Decisions made

| Question | Decision |
|---|---|
| Format | Learn-by-doing demo market (not slides, not tooltips) |
| Trigger | Both: landing-page "Try the demo" (anonymous) AND auto-entry on first sign-in with zero groups |
| Backing | Fully client-side simulation — no API calls, no DB rows |
| Scope | Full loop: bet → price move → resolution → leaderboard → create-group handoff |
| Implementation | Demo-mode flag over the real render pipeline (not a standalone replica view) |

## UX flow

### Entry points

1. **Landing page** — "Try the demo" button alongside Create market / Join group
   on the welcome shell. Works without an account.
2. **First sign-in, no groups** — instead of the empty app, the user auto-enters
   the demo. Shown at most once (localStorage `probable_demo_done`).
3. **Replay** — "How it works" item in the account menu re-launches anytime.

### Demo content

- Fake group: **"The Football Crew"**, 4 members — the user plus 3 fictional
  friends with pre-existing positions and balances so the leaderboard has life.
- One self-contained binary market: **"Will Jordan show up late to five-a-side
  again?"** — no real-world data dependency; communicates the
  friends-betting-on-friends vibe.

### Tutorial arc (6 steps, every step skippable, Esc exits)

1. **This is a market** — coach bubble anchored to the market card: a question
   your group bets on.
2. **Prices are odds** — bubble on the Yes/No buttons: "62¢ on Yes means the
   group thinks it's 62% likely. Buy the side you believe."
3. **Your turn** — user taps Yes or No; the trade panel opens; bubble points at
   the amount input and payout preview ("each share pays $1 if you're right").
   Advances on the panel opening.
4. **The price moved** — after the simulated bet fills, bubble highlights the
   new price: your bet just shifted the group's odds. Advances on trade
   completion.
5. **Resolution** — "See how it ends" button fast-forwards: the market resolves
   **in the user's favor** (winner = whichever side they bought) so they
   experience the payout. Bubble notes the flip side: "bet the other way and
   your stake's gone — that's the game."
6. **Leaderboard + handoff** — glimpse of the leaderboard with their winnings,
   then a final card: "That's the loop. Now make it real." CTA → create your
   group. Anonymous users get the sign-in modal first (existing
   `pendingAuthAction` mechanism), then land in group creation.

Completing or skipping sets `probable_demo_done`; auto-entry never nags again.

## Architecture

### Demo mode & data

- New `state.demoMode` boolean.
- `demoGroup()` factory builds a synthetic group object shaped exactly like the
  API payload: group, members, balances, one `market_event` with Yes/No
  outcomes, seeded prices, and a few pre-existing trades from the fake friends.
- Demo group id is the sentinel `"demo"` so guards can recognize it.
- Entering the demo pushes the group into `state.groups`, sets
  `currentGroupId = "demo"`, switches to the app shell; the real `render()`
  pipeline draws everything untouched.

### Network guards (two choke points, not scattered)

1. **`api()`** — if `state.demoMode` and the URL references the demo
   group/market, short-circuit (no fetch). The trade call routes to a local
   `simulateDemoTrade()` that reuses the existing client-side AMM preview math
   (the functions behind `tradePreviewHtml`, `sellPreviewForShares`) to compute
   fills, mutates the demo group's prices/balances/positions, and returns the
   same `{groups}` shape as the real endpoint — so the trade submit handler's
   `setGroups(data.groups)` path runs unmodified.
2. **Background fetches** — `loadQuestionSuggestions` and group refresh/polling
   get a one-line early return on the demo group id.

### Tutorial engine

- New file **`src/tutorial.js`**, imported by main.js (deliberately not added to
  the 8k-line main file).
- Ordered array of step objects `{anchor: selector, text, advanceOn}`.
  `advanceOn` is either the Next button or a real user event: step 3 advances
  when the trade panel opens, step 4 when the simulated trade completes —
  observed via a tiny hook `onDemoEvent(name)` that main.js calls at those two
  points.
- One overlay: dimmed backdrop with a spotlight cutout over the anchored
  element (CSS `box-shadow` trick, no libraries) and a positioned coach bubble
  with Next/Skip.
- Re-anchors after each `render()` (DOM is rebuilt): re-run positioning after
  render calls while in demo mode.

### Resolution & leaderboard

Step 5 mutates the demo market to `resolved` with winner = the user's side,
credits payouts through the same balance fields, and calls `render()`. The
existing resolved-market card and leaderboard renderers do the rest.

### Teardown & handoff

Exiting (finish, skip, or Esc) removes the demo group from `state.groups`,
clears `demoMode`, sets `probable_demo_done`, and routes:

- Signed-in → group-creation modal.
- Anonymous → login modal with `pendingAuthAction = "create-group"`.

Demo state never touches the localStorage group keys, so a mid-demo refresh
lands the user back at welcome/app normally.

## Edge cases

- **Replay by a user with real groups:** demo group is appended alongside real
  groups; the group switcher is inert in demo mode (guard in the click
  handler); on exit they return to their previous group.
- **Bet on No:** resolution still favors the user (winner = their side).
- **Mobile:** coach bubbles clamp to the viewport; below 480px they fall back
  to bottom-sheet positioning.
- **Mid-demo refresh:** no demo persistence; user lands in the normal shell.

## Error handling

The demo makes zero network calls, so there are no failure states to surface.
The only defensive requirement: guards must be airtight so no `api()` fetch
fires against the sentinel id (a stray call would 404 and toast an error).

## Testing (manual browser pass)

- All three entry points.
- Bet on No — resolution still favors the user.
- Skip at each of the 6 steps; Esc mid-trade.
- Replay after completion (account menu).
- Refresh mid-demo.
- Network tab empty for the whole demo (no `api()` fetch fires).
- Mobile viewport (375px) bubble positioning.

## Out of scope

- Localized/translated tutorial copy.
- Multi-outcome (non-binary) demo markets.
- Server-side tracking of tutorial completion (localStorage only).
- Tutorial for admin/resolution flows beyond the scripted fast-forward.
