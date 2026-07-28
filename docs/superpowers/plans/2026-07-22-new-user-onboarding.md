# New-User Onboarding Demo Market Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ~2-minute learn-by-doing tutorial where new users place a practice bet in a fully client-side demo market rendered by the real UI, watch it resolve, and get handed off into creating their own group.

**Architecture:** A synthetic demo group (sentinel id `"demo"`) is injected into `state.groups` and rendered by the existing pipeline. All network calls for demo ids are intercepted at the `api()` choke point and served by local LMSR simulation. A small overlay engine (`src/tutorial.js`) anchors coach bubbles to real DOM elements and advances on render-time predicates — no event hooks inside handlers.

**Tech Stack:** Vanilla JS (ES modules, Vite), existing CSS in `src/styles.css`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-22-new-user-onboarding-design.md`

## Global Constraints

- Demo group id is exactly `"demo"`; event id `"demo-event"`; outcome/market ids `"demo-yes"`, `"demo-no"`. Ids must NOT start with `sample-` (an existing guard blocks trading on those).
- Zero network requests may fire for demo entities — the `api()` guard must catch every demo path.
- New logic lives in new files `src/demo.js` and `src/tutorial.js`; changes to `src/main.js` are minimal wiring. Neither new file imports from `main.js` (dependencies are injected) — no circular imports.
- localStorage completion flag key: `"probable_demo_done"`.
- No test framework exists in this repo. Test cycles use `node` smoke scripts (pure logic) and scripted browser verification (UI), consistent with prior plans in this repo.
- Frontend constants that must match existing code: `DEFAULT_BALANCE = 100000`, fee rate `0.015`.

## Existing code anchors (verified 2026-07-22)

| Anchor | Location |
|---|---|
| `api(path, opts)` | `src/main.js:8342` |
| `setGroups(groups)` | `src/main.js:7944` |
| Trade submit login check `if (!requireLogin()) return;` | `src/main.js:1792` |
| `loadQuestionSuggestions(groupId)` | `src/main.js:2393` |
| `visibleNavGroups()` | `src/main.js:3607` (approx — grep `function visibleNavGroups`) |
| Escape keydown handler | `src/main.js:714-726` |
| `render()` requestAnimationFrame tail | `src/main.js:3571-3574` |
| Welcome hero buttons (`data-create-market-welcome`) | `src/main.js:4147-4151` |
| Account menu popover (`data-account-signout`) | `src/main.js:3618-3626` |
| `init()` finally block | `src/main.js:770-780` |
| Pending auth action dispatch (`action === "welcome-create-market"`) | `src/main.js:~1906` (grep it) |
| `openModal(type)` / `closeModal(type)` | `src/main.js:8145/8161` |
| `emptyTrade()` | grep `function emptyTrade` |
| `authDisplayName()` | grep `function authDisplayName` |
| Quote fetch `api(\`/api/markets/${market.id}/quote\`)` | `src/main.js:5317` — returns `{quote: {shares, maxCash, price, isComplement}}` |
| Group payload shape | `backend/main.py:907-1048` (`assemble_event_markets`, `assemble_group`) |

---

### Task 1: `src/demo.js` — demo data factory and trade simulation

**Files:**
- Create: `src/demo.js`
- Test: `scratch node smoke script (not committed)`

**Interfaces:**
- Produces (consumed by Task 3):
  - `DEMO_GROUP_ID: "demo"`
  - `buildDemoGroup(memberName: string): Group` — full API-shaped group object
  - `simulateDemoApi(path: string, opts: {body?: string}, group: Group, allGroups: Group[]): object` — handles `/quote` and `/trade` paths, returns the same shapes as the backend
  - `resolveDemoMarket(group: Group, winningOutcomeId: string): void` — mutates group to resolved + pays out

- [ ] **Step 1: Write `src/demo.js`**

```js
// Client-side demo market for the new-user tutorial.
// Everything here is synthetic: no API calls, no persistence.

export const DEMO_GROUP_ID = "demo";
export const DEMO_EVENT_ID = "demo-event";
export const DEMO_YES_ID = "demo-yes";
export const DEMO_NO_ID = "demo-no";

const DEMO_B = 150; // small liquidity so a modest bet visibly moves the price
const DEMO_FEE_RATE = 0.015;
const DEMO_QUESTION = "Will Jordan show up late to five-a-side again?";

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function buildDemoGroup(memberName) {
  const created = nowIso(-86400000);
  const closes = nowIso(86400000);
  // Quantities chosen so softmax prices land at 62c / 38c with b = DEMO_B:
  // exp(0/150) / (exp(0/150) + exp(-73.4/150)) = 0.62
  const outcomes = [
    { id: DEMO_YES_ID, title: "Yes", price: 0.62, quantity: 0, sortOrder: 0 },
    { id: DEMO_NO_ID, title: "No", price: 0.38, quantity: -73.4, sortOrder: 1 },
  ];
  const positions = {
    Maya: { [DEMO_YES_ID]: 40 },
    Sam: { [DEMO_NO_ID]: 25 },
  };
  const markets = outcomes.map(outcome => ({
    id: outcome.id,
    eventId: DEMO_EVENT_ID,
    outcomeId: outcome.id,
    question: outcome.title,
    category: DEMO_QUESTION,
    description: "Kickoff is 6pm Thursday. Resolves Yes if Jordan arrives after kickoff. Source of truth: whoever runs the group timer. This is a practice market — nothing here is real.",
    imageUrl: null,
    creator: "Maya",
    status: "open",
    mode: "fake",
    oracleType: "manual",
    resolutionSource: "",
    edgeCases: "",
    verificationStatus: "not_started",
    verificationAttempts: [],
    resolvedBy: null,
    resolutionNotes: null,
    probability: outcome.price,
    pool_yes: null,
    pool_no: null,
    k: null,
    initialLiquidity: DEMO_B,
    totalBet: 0,
    yesSharesOutstanding: outcome.quantity,
    noSharesOutstanding: 0,
    closesAt: closes,
    createdAt: created,
    outcome: null,
    resolvedAt: null,
    oracleProposal: null,
    trades: [],
    eventTrades: [],
    outcomes,
    positions,
    probabilityHistory: [{ createdAt: created, probability: outcome.price }],
    volumeHistory: [{ createdAt: created, volume: 0 }],
    volume: 0,
    liquidity: DEMO_B,
  }));
  return {
    id: DEMO_GROUP_ID,
    name: "The Football Crew",
    emoji: "⚽",
    mode: "fake",
    createdAt: created,
    members: [memberName, "Maya", "Sam", "Riley"],
    balances: { [memberName]: 100000, Maya: 101200, Sam: 99100, Riley: 100450 },
    markets,
  };
}

function demoNetCash(amount) {
  return Math.max(0, Number(amount) || 0) * (1 - DEMO_FEE_RATE);
}

export function demoBuyShares(group, outcomeId, amount) {
  const outcomes = group.markets[0].outcomes;
  const target = outcomes.find(o => o.id === outcomeId) || outcomes[0];
  const sumExp = outcomes.reduce((s, o) => s + Math.exp(o.quantity / DEMO_B), 0);
  const targetExp = Math.exp(target.quantity / DEMO_B);
  const net = demoNetCash(amount);
  if (net <= 0) return 0;
  return DEMO_B * Math.log(1 + (sumExp / targetExp) * (Math.exp(net / DEMO_B) - 1));
}

function recomputeDemoPrices(group) {
  const outcomes = group.markets[0].outcomes;
  const sumExp = outcomes.reduce((s, o) => s + Math.exp(o.quantity / DEMO_B), 0);
  outcomes.forEach(o => { o.price = Math.exp(o.quantity / DEMO_B) / sumExp; });
  group.markets.forEach(m => {
    const own = outcomes.find(o => o.id === m.outcomeId);
    if (own) m.probability = own.price;
  });
}

export function applyDemoTrade(group, { participant, amount, outcomeId, side, action }) {
  if (action === "sell") return 0; // tutorial only guides buys; ignore sells safely
  const cash = Math.max(0, Number(amount) || 0);
  const outcomes = group.markets[0].outcomes;
  const target = outcomes.find(o => o.id === outcomeId) || outcomes[0];
  const shares = demoBuyShares(group, target.id, cash);
  if (shares <= 0) return 0;
  target.quantity += shares;
  recomputeDemoPrices(group);
  group.balances[participant] = Math.max(0, (group.balances[participant] ?? 0) - cash);
  const positions = group.markets[0].positions;
  positions[participant] = positions[participant] || {};
  positions[participant][target.id] = (positions[participant][target.id] || 0) + shares;
  const trade = {
    participant,
    side: side || "yes",
    action: "buy",
    cashAmount: cash,
    cash_amount: cash,
    shares,
    outcomeId: target.id,
    createdAt: new Date().toISOString(),
  };
  group.markets.forEach(m => {
    m.eventTrades = [...(m.eventTrades || []), trade];
    if (m.outcomeId === target.id) m.trades = [...(m.trades || []), trade];
    m.volume = (m.volume || 0) + cash;
    m.totalBet = m.volume;
    m.positions = positions;
    m.probabilityHistory = [...(m.probabilityHistory || []), { createdAt: trade.createdAt, probability: m.probability }];
    m.volumeHistory = [...(m.volumeHistory || []), { createdAt: trade.createdAt, volume: m.volume }];
  });
  return shares;
}

export function simulateDemoApi(path, opts, group, allGroups) {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  if (path.endsWith("/quote")) {
    const shares = demoBuyShares(group, body.outcomeId, body.amount);
    return {
      quote: {
        shares,
        maxCash: 0,
        price: shares > 0 ? Number(body.amount) / shares : 0,
        isComplement: false,
      },
    };
  }
  if (path.endsWith("/trade")) {
    applyDemoTrade(group, body);
    return { groups: allGroups };
  }
  return {};
}

export function resolveDemoMarket(group, winningOutcomeId) {
  const now = new Date().toISOString();
  const outcomes = group.markets[0].outcomes;
  const positions = group.markets[0].positions;
  outcomes.forEach(o => { o.price = o.id === winningOutcomeId ? 1 : 0; });
  Object.entries(positions).forEach(([member, held]) => {
    const winShares = Number(held?.[winningOutcomeId] || 0);
    if (winShares > 0) group.balances[member] = (group.balances[member] ?? 0) + winShares;
  });
  group.markets.forEach(m => {
    m.status = "resolved";
    m.outcome = winningOutcomeId;
    m.resolvedAt = now;
    m.resolvedBy = "Demo";
    m.resolutionNotes = "Practice market — resolved instantly for the tutorial.";
    m.probability = m.outcomeId === winningOutcomeId ? 1 : 0;
  });
}
```

- [ ] **Step 2: Smoke-test the module with node**

Run:

```bash
node --input-type=module -e "
import { buildDemoGroup, applyDemoTrade, resolveDemoMarket, simulateDemoApi, DEMO_YES_ID } from './src/demo.js';
const g = buildDemoGroup('You');
if (g.markets.length !== 2) throw new Error('expected 2 markets');
if (Math.abs(g.markets[0].outcomes[0].price - 0.62) > 0.01) throw new Error('yes price not ~0.62: ' + g.markets[0].outcomes[0].price);
const before = g.markets[0].outcomes[0].price;
const shares = applyDemoTrade(g, { participant: 'You', amount: 50, outcomeId: DEMO_YES_ID, side: 'yes', action: 'buy' });
if (!(shares > 60 && shares < 90)) throw new Error('unexpected shares: ' + shares);
if (!(g.markets[0].outcomes[0].price > before)) throw new Error('price did not move up');
if (Math.abs(g.balances.You - 99950) > 0.01) throw new Error('balance not debited: ' + g.balances.You);
const q = simulateDemoApi('/api/markets/demo-yes/quote', { body: JSON.stringify({ outcomeId: DEMO_YES_ID, amount: 25 }) }, g, [g]);
if (!(q.quote.shares > 0)) throw new Error('quote failed');
const balBefore = g.balances.You;
resolveDemoMarket(g, DEMO_YES_ID);
if (g.markets[0].status !== 'resolved') throw new Error('not resolved');
if (!(g.balances.You > balBefore)) throw new Error('payout not credited');
console.log('demo.js smoke OK — shares:', shares.toFixed(1), 'final balance:', g.balances.You.toFixed(2));
"
```

Expected: `demo.js smoke OK — shares: <60-90> final balance: <above 99950>`

- [ ] **Step 3: Commit**

```bash
git add src/demo.js
git commit -m "feat: add client-side demo group factory and trade simulation"
```

---

### Task 2: `src/tutorial.js` — overlay engine and step script

**Files:**
- Create: `src/tutorial.js`

**Interfaces:**
- Consumes: nothing from main.js at import time (deps injected at runtime).
- Produces (consumed by Task 3):
  - `startTutorial(deps)` where `deps = { getGroup(): Group, getMember(): string, resolveDemo(outcomeId: string): void, exitDemo(handoff: boolean): void }`
  - `stopTutorial(): void`
  - `tutorialOnRender(): void` — call after each render while in demo mode; re-anchors the bubble and advances predicate-based steps.

- [ ] **Step 1: Write `src/tutorial.js`**

```js
// Coach-mark overlay engine for the demo-market tutorial.
// No imports from main.js: all app access goes through the deps object.

import { DEMO_YES_ID, DEMO_NO_ID } from "./demo.js";

let deps = null;
let stepIndex = -1;
let spotlightEl = null;
let bubbleEl = null;
let repositionTimer = null;

function userShares() {
  const group = deps.getGroup();
  const member = deps.getMember();
  const positions = group?.markets?.[0]?.positions?.[member] || {};
  return Object.values(positions).reduce((s, v) => s + Number(v || 0), 0);
}

function userSideOutcomeId() {
  const group = deps.getGroup();
  const member = deps.getMember();
  const positions = group?.markets?.[0]?.positions?.[member] || {};
  const yes = Number(positions[DEMO_YES_ID] || 0);
  const no = Number(positions[DEMO_NO_ID] || 0);
  return no > yes ? DEMO_NO_ID : DEMO_YES_ID;
}

const STEPS = [
  {
    anchor: "[data-event-key]",
    title: "This is a market",
    text: "A question your group puts (pretend) money on. This one is a practice market — go wild.",
    nextLabel: "Next",
  },
  {
    anchor: '[data-buy="yes"]',
    title: "Prices are the group's odds",
    text: "62¢ on Yes means the group thinks there's a 62% chance it happens. Every share pays $1 if you're right — so buy the side you believe.",
    nextLabel: "Next",
  },
  {
    anchor: "[data-event-key]",
    title: "Your turn",
    text: "Tap Yes or No on the market — whichever way you'd actually bet.",
    advanceWhen: () => Boolean(document.querySelector(".trade-panel, .focused-market-shell")),
  },
  {
    anchor: ".trade-panel, .focused-market-shell",
    title: "Place your practice bet",
    text: "Pick an amount and hit Buy. The preview shows what you'd win if you're right.",
    advanceWhen: () => userShares() > 0,
  },
  {
    anchor: "[data-event-key]",
    title: "You moved the price",
    text: "Your bet just shifted the group's odds — that's the market updating its belief. Now let's skip ahead…",
    nextLabel: "See how it ends",
  },
  {
    anchor: "[data-event-key]",
    title: "It happened — you called it",
    text: "The market resolved on your side: every winning share pays $1, losing shares pay nothing. If you'd bet the other way, your stake would be gone. That's the game.",
    onEnter: () => deps.resolveDemo(userSideOutcomeId()),
    nextLabel: "Next",
  },
  {
    anchor: null,
    title: "That's the whole loop",
    text: "Create a group, drop a question, get your friends betting, settle it, crown the winner. Now make a real one.",
    ctaLabel: "Create your group",
  },
];

function ensureEls() {
  if (!spotlightEl) {
    spotlightEl = document.createElement("div");
    spotlightEl.className = "tutorial-spotlight";
    document.body.appendChild(spotlightEl);
  }
  if (!bubbleEl) {
    bubbleEl = document.createElement("div");
    bubbleEl.className = "tutorial-bubble";
    document.body.appendChild(bubbleEl);
    bubbleEl.addEventListener("click", e => {
      if (e.target.closest("[data-tutorial-next]")) advance();
      else if (e.target.closest("[data-tutorial-skip]")) deps.exitDemo(false);
      else if (e.target.closest("[data-tutorial-cta]")) deps.exitDemo(true);
    });
  }
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderBubble(step) {
  const buttons = [
    `<button class="btn btn-ghost btn-sm" type="button" data-tutorial-skip>Skip</button>`,
    step.nextLabel ? `<button class="btn btn-primary btn-sm" type="button" data-tutorial-next>${esc(step.nextLabel)}</button>` : "",
    step.ctaLabel ? `<button class="btn btn-primary btn-sm" type="button" data-tutorial-cta>${esc(step.ctaLabel)}</button>` : "",
  ].join("");
  bubbleEl.innerHTML = `
    <p class="tutorial-step-count">${stepIndex + 1} / ${STEPS.length}</p>
    <h4>${esc(step.title)}</h4>
    <p>${esc(step.text)}</p>
    <div class="tutorial-actions">${buttons}</div>
  `;
}

function position() {
  if (stepIndex < 0) return;
  const step = STEPS[stepIndex];
  const target = step.anchor ? document.querySelector(step.anchor) : null;
  if (!target) {
    spotlightEl.style.display = "none";
    bubbleEl.classList.add("centered");
    bubbleEl.style.left = "";
    bubbleEl.style.top = "";
    return;
  }
  bubbleEl.classList.remove("centered");
  const rect = target.getBoundingClientRect();
  const pad = 8;
  spotlightEl.style.display = "block";
  spotlightEl.style.left = `${rect.left - pad}px`;
  spotlightEl.style.top = `${rect.top - pad}px`;
  spotlightEl.style.width = `${rect.width + pad * 2}px`;
  spotlightEl.style.height = `${rect.height + pad * 2}px`;
  const bubbleRect = bubbleEl.getBoundingClientRect();
  const below = rect.bottom + pad + bubbleRect.height < window.innerHeight;
  const top = below ? rect.bottom + pad + 4 : Math.max(12, rect.top - bubbleRect.height - pad - 4);
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - bubbleRect.width - 12);
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.left = `${left}px`;
}

function showStep() {
  const step = STEPS[stepIndex];
  if (!step) return;
  if (step.onEnter) step.onEnter();
  renderBubble(step);
  position();
}

function advance() {
  if (stepIndex >= STEPS.length - 1) {
    deps.exitDemo(false);
    return;
  }
  stepIndex += 1;
  showStep();
}

export function startTutorial(d) {
  deps = d;
  stepIndex = 0;
  ensureEls();
  showStep();
}

export function stopTutorial() {
  stepIndex = -1;
  clearTimeout(repositionTimer);
  spotlightEl?.remove();
  bubbleEl?.remove();
  spotlightEl = null;
  bubbleEl = null;
  deps = null;
}

export function tutorialOnRender() {
  if (stepIndex < 0 || !deps) return;
  const step = STEPS[stepIndex];
  if (step?.advanceWhen && step.advanceWhen()) {
    stepIndex += 1;
    showStep();
  } else {
    position();
  }
  clearTimeout(repositionTimer);
  repositionTimer = setTimeout(position, 450);
}
```

- [ ] **Step 2: Smoke-test the module imports cleanly (no DOM access at module scope)**

Run:

```bash
node --input-type=module -e "
import * as t from './src/tutorial.js';
for (const name of ['startTutorial', 'stopTutorial', 'tutorialOnRender']) {
  if (typeof t[name] !== 'function') throw new Error(name + ' missing');
}
console.log('tutorial.js smoke OK');
"
```

Expected: `tutorial.js smoke OK` (would throw `document is not defined` if DOM were touched at module scope).

- [ ] **Step 3: Commit**

```bash
git add src/tutorial.js
git commit -m "feat: add tutorial overlay engine with predicate-advanced steps"
```

---

### Task 3: Wire demo mode into `src/main.js`

**Files:**
- Modify: `src/main.js` (imports, state, `api()`, trade submit, `setGroups`, `loadQuestionSuggestions`, `visibleNavGroups`, group-tab click guard, Escape handler, `render()` tail, pending-auth-action dispatch, `enterDemo`/`exitDemo`)

**Interfaces:**
- Consumes: everything exported by Tasks 1 and 2.
- Produces (consumed by Task 4): `enterDemo()` and `exitDemo(handoff)` functions in main.js scope.

- [ ] **Step 1: Add imports at the top of `src/main.js`** (next to the existing imports)

```js
import { DEMO_GROUP_ID, buildDemoGroup, simulateDemoApi, resolveDemoMarket } from "./demo.js";
import { startTutorial, stopTutorial, tutorialOnRender } from "./tutorial.js";
```

- [ ] **Step 2: Add demo fields to state** — in the `state` object (around line 330-370), next to `pendingUi`:

```js
  demoMode: false,
  demoPrevGroupId: null,
```

- [ ] **Step 3: Add `enterDemo` / `exitDemo`** — place directly above `function enterWelcomeShell` (grep it, ~line 8094):

```js
function enterDemo() {
  if (state.demoMode) return;
  const memberName = isLoggedIn() ? (authDisplayName() || "You") : "You";
  const group = buildDemoGroup(memberName);
  state.demoPrevGroupId = state.currentGroupId;
  state.groups = state.groups.filter(g => g.id !== DEMO_GROUP_ID).concat([group]);
  state.demoMode = true;
  state.shell = "app";
  state.view = "dashboard";
  state.currentGroupId = DEMO_GROUP_ID;
  state.activeMember = memberName;
  state.trade = emptyTrade();
  render();
  startTutorial({
    getGroup: () => state.groups.find(g => g.id === DEMO_GROUP_ID),
    getMember: () => memberName,
    resolveDemo: outcomeId => {
      const demoGroup = state.groups.find(g => g.id === DEMO_GROUP_ID);
      if (demoGroup) resolveDemoMarket(demoGroup, outcomeId);
      render();
    },
    exitDemo: handoff => exitDemo(handoff),
  });
}

function exitDemo(handoff = false) {
  if (!state.demoMode) return;
  stopTutorial();
  state.demoMode = false;
  state.groups = state.groups.filter(g => g.id !== DEMO_GROUP_ID);
  localStorage.setItem("probable_demo_done", "1");
  state.trade = emptyTrade();
  state.mobileTradeOpen = false;
  state.currentGroupId = state.demoPrevGroupId && state.groups.some(g => g.id === state.demoPrevGroupId)
    ? state.demoPrevGroupId
    : null;
  state.demoPrevGroupId = null;
  if (!state.currentGroupId) {
    if (isLoggedIn() && state.groups.length) {
      state.currentGroupId = state.groups[0].id;
    } else {
      state.shell = "welcome";
      state.welcomeMode = "actions";
    }
  }
  normalizeSelection();
  render();
  if (handoff) {
    if (isLoggedIn()) openModal("group");
    else requireLogin("demo-create-group");
  }
}
```

- [ ] **Step 4: Guard `api()`** — at the top of `async function api(path, opts = {})` (line 8342), before the PROD check:

```js
  if (state.demoMode && (path.includes("/markets/demo-") || path.includes(`/groups/${DEMO_GROUP_ID}/`))) {
    const demoGroup = state.groups.find(g => g.id === DEMO_GROUP_ID);
    return simulateDemoApi(path, opts, demoGroup, state.groups);
  }
```

- [ ] **Step 5: Bypass login check for demo trades** — line 1792, change:

```js
  if (!requireLogin()) return;
```

to:

```js
  if (!state.demoMode && !requireLogin()) return;
```

- [ ] **Step 6: Keep the demo group alive in `setGroups`** — replace the function (line 7944):

```js
function setGroups(groups) {
  state.groups = groups ?? [];
  if (state.demoMode && !state.groups.some(g => g.id === DEMO_GROUP_ID)) {
    state.groups = state.groups.concat([buildDemoGroup(state.activeMember || "You")]);
  }
  tradeQuoteCache.clear();
  tradeQuoteInflight.clear();
}
```

- [ ] **Step 7: Skip suggestions for the demo group** — in `loadQuestionSuggestions(groupId)` (line ~2393), change the first guard:

```js
  if (!groupId || state.pendingUi.suggestions) return;
```

to:

```js
  if (!groupId || groupId === DEMO_GROUP_ID || state.pendingUi.suggestions) return;
```

- [ ] **Step 8: Hide the demo group from nav tabs** — in `visibleNavGroups()`, change:

```js
  state.groups.filter(groupHasCurrentMember).forEach(group => {
```

to:

```js
  state.groups.filter(group => group.id !== DEMO_GROUP_ID).filter(groupHasCurrentMember).forEach(group => {
```

- [ ] **Step 9: Make the group switcher inert during the demo** — in `onGlobalClick`, find the `[data-group-id]` tab handler (grep `data-group-id="__new"` context; the click branch reads `closest("[data-group-id]")`). At the top of that branch add:

```js
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
```

- [ ] **Step 10: Escape exits the demo** — in the keydown listener (line 714), add as the first statement inside `if (e.key === "Escape") {`:

```js
    if (state.demoMode) {
      exitDemo();
      return;
    }
```

- [ ] **Step 11: Re-anchor the tutorial after each render** — in `render()`, inside the existing `requestAnimationFrame` callback (line ~3571), after `animateIn();`:

```js
    if (state.demoMode) tutorialOnRender();
```

- [ ] **Step 12: Handle the post-login handoff action** — in the function that dispatches pending auth actions (grep `action === "welcome-create-market"`), add alongside the existing branches:

```js
  if (action === "demo-create-group") {
    openModal("group");
    return;
  }
```

- [ ] **Step 13: Verify the app still boots clean**

Run: dev server should already be running (`npm run dev`, backend on :8000). Open http://127.0.0.1:5173/ in a browser, confirm the landing page renders and the console has no errors. In the console run:

```js
window.__enterDemoCheck = typeof enterDemo
```

(Functions in module scope aren't on window — instead verify no import errors: console shows no red, page interactive.)

Expected: clean console, landing page renders.

- [ ] **Step 14: Commit**

```bash
git add src/main.js
git commit -m "feat: wire demo mode into app state, api guard, and trade path"
```

---

### Task 4: Entry points — landing button, auto-entry, account menu replay

**Files:**
- Modify: `src/main.js` (welcome hero HTML, `onGlobalClick`, `init()` finally block, `accountIndicatorHtml`)

**Interfaces:**
- Consumes: `enterDemo()` from Task 3.

- [ ] **Step 1: Add "Try the demo" to the welcome hero** — in `renderEmptyDashboard()` (line 4147-4151), change:

```js
  const welcomeActions = `
    <div class="welcome-button-row">
      <button class="btn btn-primary btn-lg" type="button" data-create-market-welcome>Create market</button>
      <button class="btn btn-ghost btn-lg" type="button" data-join-group>Join group</button>
    </div>`;
```

to:

```js
  const welcomeActions = `
    <div class="welcome-button-row">
      <button class="btn btn-primary btn-lg" type="button" data-create-market-welcome>Create market</button>
      <button class="btn btn-ghost btn-lg" type="button" data-join-group>Join group</button>
    </div>
    <button class="welcome-demo-link" type="button" data-try-demo>New here? Try the 2-minute demo</button>`;
```

- [ ] **Step 2: Add the click handler** — in `onGlobalClick`, next to the other welcome handlers (near the `[data-create-market-welcome]` branch, line ~1225):

```js
  if (e.target.closest("[data-try-demo]")) {
    enterDemo();
    return;
  }
```

- [ ] **Step 3: Auto-enter for fresh sign-ins with no groups** — in `init()`'s `finally` block (line ~774-779), after `if (state.currentGroupId) loadQuestionSuggestions(state.currentGroupId);` add:

```js
    if (
      isLoggedIn() &&
      !state.groups.length &&
      !state.inviteToken &&
      !state.sharedMarketId &&
      !localStorage.getItem("probable_demo_done")
    ) {
      enterDemo();
    }
```

- [ ] **Step 4: Add "How it works" to the account menu** — in `accountIndicatorHtml()` (line 3620-3625), change:

```js
          <div class="account-popover">
            <button class="account-popover-name" type="button" data-open-positions>My Portfolio</button>
            <button type="button" data-open-admin>Admin verify</button>
            <button type="button" data-account-signout>Sign out</button>
          </div>` : ""}
```

to:

```js
          <div class="account-popover">
            <button class="account-popover-name" type="button" data-open-positions>My Portfolio</button>
            <button type="button" data-open-admin>Admin verify</button>
            <button type="button" data-demo-replay>How it works</button>
            <button type="button" data-account-signout>Sign out</button>
          </div>` : ""}
```

- [ ] **Step 5: Add the replay handler** — in `onGlobalClick`, next to the other account-menu branches (grep `data-account-signout` handler):

```js
  if (e.target.closest("[data-demo-replay]")) {
    state.accountMenuOpen = false;
    enterDemo();
    return;
  }
```

- [ ] **Step 6: Verify entry points in browser**

1. Open http://127.0.0.1:5173/ logged out → "New here? Try the 2-minute demo" appears under the hero buttons.
2. Click it → app shell shows "The Football Crew" with the demo market and the first tutorial bubble (unstyled until Task 5 — presence is enough).
3. Press Escape → back to welcome.
4. Sign in (dev bypass) → account avatar → menu shows "How it works".
5. `localStorage.removeItem("probable_demo_done")` in console, then sign in with an account that has zero groups → demo auto-opens.

Expected: all five behaviors work; no console errors; Network tab shows no requests to `/api/markets/demo-*` or `/api/groups/demo/*`.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: add demo entry points - landing link, auto-entry, menu replay"
```

---

### Task 5: Tutorial CSS

**Files:**
- Modify: `src/styles.css` (append at end)

- [ ] **Step 1: Append tutorial styles**

```css
/* ── Tutorial (demo-market onboarding) ─────────────────────────── */

.tutorial-spotlight {
  position: fixed;
  z-index: 200;
  border-radius: 14px;
  pointer-events: none;
  box-shadow: 0 0 0 9999px rgba(4, 8, 16, 0.72);
  transition: left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease;
}

.tutorial-bubble {
  position: fixed;
  z-index: 201;
  max-width: 340px;
  background: #101826;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  padding: 16px 18px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}

.tutorial-bubble.centered {
  left: 50% !important;
  top: 50% !important;
  transform: translate(-50%, -50%);
}

.tutorial-step-count {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
  margin: 0 0 6px;
}

.tutorial-bubble h4 {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  margin: 0 0 6px;
}

.tutorial-bubble p {
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.75);
  margin: 0;
}

.tutorial-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
}

.welcome-demo-link {
  margin-top: 14px;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.55);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
  transition: color 0.15s;
}

.welcome-demo-link:hover {
  color: #fff;
}

@media (max-width: 480px) {
  .tutorial-bubble {
    left: 12px !important;
    right: 12px;
    top: auto !important;
    bottom: 12px;
    max-width: none;
    transform: none;
  }
  .tutorial-bubble.centered {
    transform: none;
  }
}
```

- [ ] **Step 2: Visual check in browser**

Enter the demo from the landing link. Confirm: dimmed backdrop with a bright cutout around the market card, styled bubble bottom/side-positioned with step counter "1 / 7", Skip and Next buttons styled like existing btn classes. Resize to 375px wide: bubble docks to the bottom edge.

Expected: matches app's dark aesthetic; no layout overflow.

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat: style tutorial spotlight, coach bubble, and demo link"
```

---

### Task 6: End-to-end verification pass

**Files:** none (verification only; fix-forward any bugs found and commit each fix separately).

- [ ] **Step 1: Full happy path, anonymous** — Landing → "Try the demo" → step 1 (market card spotlit) → Next → step 2 (Yes button spotlit) → Next → step 3 → tap Yes → panel opens, auto-advances to step 4 → enter $50 → Buy → auto-advances to step 5, price visibly higher than 62¢ → "See how it ends" → market shows resolved, balance increased → Next → final card → "Create your group" → login modal appears. Sign in via dev bypass → group-creation modal opens.

- [ ] **Step 2: Bet on No** — replay demo (clear `probable_demo_done`), buy No at step 3-4 → step 6 must resolve No as winner and credit the payout.

- [ ] **Step 3: Skip and Esc** — at each of steps 1, 3, and 4: click Skip once, then re-enter and press Escape once. Both must exit cleanly to the previous context (welcome for anonymous, prior group for signed-in) with the overlay fully removed.

- [ ] **Step 4: Signed-in user with existing groups replays** — via account menu "How it works": demo opens, nav group tabs must NOT navigate (toast "Finish or skip the demo first."), exit returns to the group they came from.

- [ ] **Step 5: Refresh mid-demo** — reload the page at step 4. Expected: normal app/welcome shell, no demo group, no overlay, no console errors.

- [ ] **Step 6: Network silence** — with DevTools Network open, run the full happy path. Zero requests containing `demo` may appear. The `/quote` calls the trade panel makes must be absent (served locally).

- [ ] **Step 7: Auto-entry once only** — fresh profile (clear localStorage), sign in with zero groups → demo auto-opens. Exit. Reload → demo must NOT auto-open again.

- [ ] **Step 8: Commit any fixes; then final commit if clean**

```bash
git status   # confirm clean or commit fixes individually
```

---

## Self-review

**Spec coverage:**
- ✅ Landing "Try the demo" (anonymous) — Task 4 Step 1-2
- ✅ Auto-entry on first sign-in, no groups, shown once — Task 4 Step 3 + `probable_demo_done`
- ✅ Replay from account menu — Task 4 Step 4-5
- ✅ Demo group "The Football Crew", 4 members, seeded positions/balances — Task 1
- ✅ Self-contained market question — Task 1 (`DEMO_QUESTION`)
- ✅ 6 UX beats (engine uses 7 steps: spec's step 3 is split into tap-a-side + place-bet) — Task 2
- ✅ Skippable every step + Esc — Task 2 (Skip button) + Task 3 Step 10
- ✅ Client-side sim via LMSR with fee — Task 1 (`demoBuyShares`, matches `lmsrPreview` math with `DEMO_B`)
- ✅ `api()` choke-point guard incl. `/quote` — Task 3 Step 4
- ✅ Background fetch guards — Task 3 Step 7 (suggestions); group refresh covered by `setGroups` re-append (Task 3 Step 6)
- ✅ Resolution in user's favor + payout + leaderboard — Task 1 `resolveDemoMarket` + Task 2 step 6
- ✅ Handoff: signed-in → group modal; anonymous → login with `pendingAuthAction="demo-create-group"` — Task 3 Steps 3, 12
- ✅ Switcher inert in demo — Task 3 Steps 8-9
- ✅ Mobile bubble fallback — Task 5 media query
- ✅ Testing checklist — Task 6 mirrors the spec's list

**Deviations from spec (deliberate):**
- Spec named only `src/tutorial.js`; the plan adds `src/demo.js` so data/sim and overlay engine stay separately testable. Same spirit (keep main.js small).
- Spec's "6 steps" are implemented as 7 engine steps (step 3 split); UX beats unchanged.
- Backdrop uses `pointer-events: none` so the page stays clickable everywhere during the demo (needed for steps 3-4 anyway); nav misuse is covered by the switcher guard.

**Placeholder scan:** none — every step has complete code or exact commands.

**Type consistency:** `buildDemoGroup(memberName)`, `simulateDemoApi(path, opts, group, allGroups)`, `resolveDemoMarket(group, winningOutcomeId)`, `startTutorial(deps)`, `stopTutorial()`, `tutorialOnRender()`, `enterDemo()`, `exitDemo(handoff)` — names match across Tasks 1-4. `DEMO_GROUP_ID`/`DEMO_YES_ID`/`DEMO_NO_ID` imported consistently.
