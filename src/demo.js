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

const FRIEND_POOL = ["Maya", "Sam", "Riley", "Alex", "Jordan P", "Nina"];

export function buildDemoGroup(memberName) {
  const created = nowIso(-86400000);
  const closes = nowIso(86400000);
  const friends = FRIEND_POOL.filter(n => n.toLowerCase() !== String(memberName).toLowerCase()).slice(0, 3);
  // Quantities chosen so softmax prices land at 62c / 38c with b = DEMO_B:
  // exp(0/150) / (exp(0/150) + exp(-73.4/150)) = 0.62
  const outcomes = [
    { id: DEMO_YES_ID, title: "Yes", price: 0.62, quantity: 0, sortOrder: 0 },
    { id: DEMO_NO_ID, title: "No", price: 0.38, quantity: -73.4, sortOrder: 1 },
  ];
  const positions = {
    [friends[0]]: { [DEMO_YES_ID]: 40 },
    [friends[1]]: { [DEMO_NO_ID]: 25 },
  };
  const markets = outcomes.map(outcome => ({
    id: outcome.id,
    eventId: DEMO_EVENT_ID,
    outcomeId: outcome.id,
    question: outcome.title,
    category: DEMO_QUESTION,
    description: "Kickoff is 6pm Thursday. Resolves Yes if Jordan arrives after kickoff. Source of truth: whoever runs the group timer. This is a practice market — nothing here is real.",
    imageUrl: null,
    creator: friends[0],
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
    members: [memberName, ...friends],
    balances: { [memberName]: 100000, [friends[0]]: 101200, [friends[1]]: 99100, [friends[2]]: 100450 },
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
    const outcomes = group.markets[0].outcomes;
    const target = outcomes.find(o => o.id === body.outcomeId) || outcomes[0];
    const shares = demoBuyShares(group, target.id, body.amount);
    return {
      quote: {
        shares,
        maxCash: 0,
        price: target.price,
        isComplement: false,
      },
    };
  }
  if (path.endsWith("/trade")) {
    if (body.action === "sell") throw new Error("Selling isn't part of the practice market.");
    applyDemoTrade(group, body);
    return { groups: allGroups };
  }
  throw new Error("Not available in the practice market.");
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
