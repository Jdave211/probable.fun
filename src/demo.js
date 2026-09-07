// Client-side demo market for the new-user tutorial.
// Everything here is synthetic: no API calls, no persistence.

export const DEMO_GROUP_ID = "demo";
export const DEMO_EVENT_ID = "demo-event";
export const DEMO_YES_ID = "demo-yes";
export const DEMO_NO_ID = "demo-no";

const DEMO_B = 150; // small liquidity so a modest bet visibly moves the price
const PRESENTATION_B = 4000;
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

export function buildPresentationDemoGroup(memberName = "Dave Jaga") {
  const created = nowIso(-4 * 86400000);
  const closes = nowIso(240 * 86400000);
  const members = [memberName, "Maya Chen", "Sam Okafor", "Riley Singh", "Alex Morgan"];
  const outcomes = [
    { id: DEMO_YES_ID, title: "Yes", price: 0.5, quantity: 0, sortOrder: 0 },
    { id: DEMO_NO_ID, title: "No", price: 0.5, quantity: 0, sortOrder: 1 },
  ];
  const positions = {};
  const question = "Will Arsenal win the 2026/27 Premier League?";
  const markets = outcomes.map(outcome => ({
    id: outcome.id,
    eventId: DEMO_EVENT_ID,
    outcomeId: outcome.id,
    question: outcome.title,
    category: question,
    description: "Resolves Yes if Arsenal are officially declared 2026/27 Premier League champions. Source: the Premier League final table. If the season is abandoned without a declared champion, the market is void.",
    imageUrl: "/market-images/market-024-4bfd0d2754.jpg",
    creator: "Maya Chen",
    status: "open",
    mode: "fake",
    oracleType: "manual",
    resolutionSource: "Premier League final table",
    edgeCases: "Void if the season ends without an officially declared champion.",
    verificationStatus: "not_started",
    verificationAttempts: [],
    resolvedBy: null,
    resolutionNotes: null,
    probability: outcome.price,
    pool_yes: null,
    pool_no: null,
    k: null,
    initialLiquidity: PRESENTATION_B,
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
    liquidity: PRESENTATION_B,
  }));
  const group = {
    id: DEMO_GROUP_ID,
    name: "Sporty Boys",
    emoji: "🏆",
    mode: "fake",
    createdAt: created,
    members,
    balances: Object.fromEntries(members.map(name => [name, 100000])),
    markets,
  };

  const plan = [
    ["Maya Chen", DEMO_YES_ID, "yes", 400],
    ["Sam Okafor", DEMO_NO_ID, "no", 550],
    ["Riley Singh", DEMO_YES_ID, "yes", 700],
    ["Alex Morgan", DEMO_NO_ID, "no", 300],
    ["Maya Chen", DEMO_YES_ID, "yes", 350],
    ["Sam Okafor", DEMO_NO_ID, "no", 800],
    ["Alex Morgan", DEMO_YES_ID, "yes", 600],
    ["Riley Singh", DEMO_NO_ID, "no", 450],
    ["Sam Okafor", DEMO_YES_ID, "yes", 500],
    ["Maya Chen", DEMO_NO_ID, "no", 650],
    ["Riley Singh", DEMO_YES_ID, "yes", 750],
    ["Alex Morgan", DEMO_NO_ID, "no", 350],
    ["Maya Chen", DEMO_YES_ID, "yes", 550],
    ["Sam Okafor", DEMO_NO_ID, "no", 1050],
    ["Maya Chen", DEMO_YES_ID, "yes", 315],
  ];
  plan.forEach(([participant, outcomeId, side, amount], index) => applyDemoTrade(group, {
    participant,
    outcomeId,
    side,
    amount,
    action: "buy",
    createdAt: nowIso((-3.5 * 86400000) + index * 5.5 * 60 * 60 * 1000),
  }));
  return group;
}

function demoNetCash(amount) {
  return Math.max(0, Number(amount) || 0) * (1 - DEMO_FEE_RATE);
}

export function demoBuyShares(group, outcomeId, amount) {
  const outcomes = group.markets[0].outcomes;
  const liquidity = Number(group.markets[0].initialLiquidity || DEMO_B);
  const target = outcomes.find(o => o.id === outcomeId) || outcomes[0];
  const sumExp = outcomes.reduce((s, o) => s + Math.exp(o.quantity / liquidity), 0);
  const targetExp = Math.exp(target.quantity / liquidity);
  const net = demoNetCash(amount);
  if (net <= 0) return 0;
  return liquidity * Math.log(1 + (sumExp / targetExp) * (Math.exp(net / liquidity) - 1));
}

function recomputeDemoPrices(group) {
  const outcomes = group.markets[0].outcomes;
  const liquidity = Number(group.markets[0].initialLiquidity || DEMO_B);
  const sumExp = outcomes.reduce((s, o) => s + Math.exp(o.quantity / liquidity), 0);
  outcomes.forEach(o => { o.price = Math.exp(o.quantity / liquidity) / sumExp; });
  group.markets.forEach(m => {
    const own = outcomes.find(o => o.id === m.outcomeId);
    if (own) m.probability = own.price;
  });
}

export function applyDemoTrade(group, { participant, amount, outcomeId, side, action, createdAt: requestedCreatedAt }) {
  if (action === "sell") return 0; // tutorial only guides buys; ignore sells safely
  const cash = Math.max(0, Number(amount) || 0);
  const outcomes = group.markets[0].outcomes;
  const target = outcomes.find(o => o.id === outcomeId) || outcomes[0];
  const pricesBefore = new Map(group.markets.map(market => [market.outcomeId, Number(market.probability || 0)]));
  const shares = demoBuyShares(group, target.id, cash);
  if (shares <= 0) return 0;
  target.quantity += shares;
  recomputeDemoPrices(group);
  group.balances[participant] = Math.max(0, (group.balances[participant] ?? 0) - cash);
  const positions = group.markets[0].positions;
  positions[participant] = positions[participant] || {};
  positions[participant][target.id] = (positions[participant][target.id] || 0) + shares;
  const createdAt = requestedCreatedAt || new Date().toISOString();
  const baseTrade = {
    participant,
    side: side || "yes",
    action: "buy",
    cashAmount: cash,
    cash_amount: cash,
    amount: cash,
    shares,
    outcomeId: target.id,
    createdAt,
  };
  group.markets.forEach(m => {
    const probBefore = Number(pricesBefore.get(m.outcomeId) || 0);
    const probAfter = Number(m.probability || 0);
    const trade = {
      ...baseTrade,
      id: `demo-${String(createdAt).replace(/\D/g, "").slice(-10)}-${String(participant).replace(/\W/g, "").slice(0, 6)}`,
      probBefore,
      probAfter,
      avgPrice: Number(m.probability || 0),
    };
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
    const market = group.markets.find(item => item.id === body.outcomeId) || group.markets[0];
    const probabilityBefore = Number(market?.probability || 0);
    const balanceBefore = Number(group.balances?.[body.participant] || 0);
    const shares = applyDemoTrade(group, body);
    const updated = group.markets.find(item => item.id === body.outcomeId) || group.markets[0];
    return {
      groups: allGroups,
      trade: {
        shares,
        cashAmount: Number(body.amount || 0),
        probabilityBefore,
        probabilityAfter: Number(updated?.probability || 0),
        balanceBefore,
        balanceAfter: Number(group.balances?.[body.participant] || 0),
        outcomeId: body.outcomeId,
      },
    };
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
