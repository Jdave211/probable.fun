// Client-side demo market for the new-user tutorial.
// Everything here is synthetic: no API calls, no persistence.

export const DEMO_GROUP_ID = "demo";
export const PRESENTATION_GROUP_ID = "demo-lazy-boys";
export const PRESENTATION_LOVE_GROUP_ID = "demo-love-island-group";
export const DEMO_EVENT_ID = "demo-event";
export const DEMO_YES_ID = "demo-yes";
export const DEMO_NO_ID = "demo-no";
export const PRESENTATION_PRIMARY_ID = "demo-married-dave";

const DEMO_B = 150; // small liquidity so a modest bet visibly moves the price
const PRESENTATION_B = 4000;
const DEMO_FEE_RATE = 0.015;
const DEMO_QUESTION = "Will Jordan show up late to five-a-side again?";
const PRESENTATION_HAALAND_ID = "demo-haaland";
const PRESENTATION_LOVE_EVENT_ID = "demo-love-island";
const PRESENTATION_LOVE_YES_ID = "demo-love-yes";
const PRESENTATION_LOVE_NO_ID = "demo-love-no";
const PRESENTATION_PERSONAL_EVENT_ID = "demo-first-married";
const PRESENTATION_JULIAN_ID = "demo-married-julian";
const PRESENTATION_KOREDE_ID = "demo-married-korede";
const PRESENTATION_JOEL_ID = "demo-married-joel";
const PRESENTATION_JAY_JAY_ID = "demo-married-jay-jay";

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

export function buildPresentationDemoGroups(memberName = "Dave Jaga") {
  const created = new Date(new Date().getFullYear(), 0, 3, 18).toISOString();
  const members = [...new Set([memberName, "Julian Asogwa", "Korede Adeniyi", "Joel Adejola", "Jay Jay Ezugo"])];
  const worldCupMarkets = buildPresentationEvent({
    eventId: DEMO_EVENT_ID,
    title: "Who scores the most goals today?",
    outcomes: [
      [DEMO_YES_ID, "Kylian Mbappé"],
      [DEMO_NO_ID, "Lionel Messi"],
      [PRESENTATION_HAALAND_ID, "Erling Haaland"],
    ],
    description: "Resolves to the player who scores the most goals across today's World Cup matches. Extra-time goals count; penalty-shootout goals do not. A tie resolves to the tied player with fewer minutes played.",
    imageUrl: "/market-images/market-007-ec1164b216.jpg",
    creator: "Julian Asogwa",
    resolutionSource: "Official FIFA match reports",
    edgeCases: "If tied on goals and minutes, the market is void and stakes are returned.",
    createdAt: created,
    closesAt: nowIso(10 * 60 * 60 * 1000),
    liquidity: 9000,
  });
  const loveIslandMarkets = buildPresentationEvent({
    eventId: PRESENTATION_LOVE_EVENT_ID,
    title: "Will Aniya crash out at the Love Island reunion?",
    outcomes: [
      [PRESENTATION_LOVE_YES_ID, "Yes"],
      [PRESENTATION_LOVE_NO_ID, "No"],
    ],
    description: "Resolves Yes if Aniya visibly loses her composure, leaves the set, or needs production to pause the reunion. Otherwise resolves No.",
    imageUrl: "https://probable-fun.onrender.com/api/markets/92888e49/image",
    creator: "Jay Jay Ezugo",
    resolutionSource: "The aired Love Island reunion episode",
    edgeCases: "Edited previews do not count. Only footage included in the full reunion broadcast settles the market.",
    createdAt: nowIso(-3 * 86400000),
    closesAt: nowIso(36 * 60 * 60 * 1000),
    liquidity: PRESENTATION_B,
  });
  const personalMarkets = buildPresentationEvent({
    eventId: PRESENTATION_PERSONAL_EVENT_ID,
    title: "Who will be the first to get married?",
    outcomes: [
      [PRESENTATION_PRIMARY_ID, "Dave Jaga"],
      [PRESENTATION_JULIAN_ID, "Julian Asogwa"],
      [PRESENTATION_KOREDE_ID, "Korede Adeniyi"],
      [PRESENTATION_JOEL_ID, "Joel Adejola"],
      [PRESENTATION_JAY_JAY_ID, "Jay Jay Ezugo"],
    ],
    description: "Resolves to the first person in the group to complete a legally recognized marriage ceremony. An engagement alone does not count.",
    imageUrl: "/marriage-market.svg",
    creator: "Joel Adejola",
    resolutionSource: "Marriage announcement confirmed by the person and the group",
    edgeCases: "If two ceremonies occur on the same date, the earlier local ceremony time wins. If timing cannot be verified, the market is void.",
    createdAt: created,
    closesAt: nowIso(540 * 86400000),
    liquidity: 7000,
  });
  const ambientMarkets = presentationAmbientMarketSpecs(created).flatMap(spec => buildPresentationEvent(spec));
  const group = {
    id: DEMO_GROUP_ID,
    name: "Sporty Boys",
    emoji: "🏆",
    mode: "fake",
    createdAt: created,
    members,
    balances: Object.fromEntries(members.map(name => [name, 100000])),
    markets: worldCupMarkets,
  };
  const loveIslandGroup = {
    id: PRESENTATION_LOVE_GROUP_ID,
    name: "Love Island",
    emoji: "🏝️",
    mode: "fake",
    createdAt: created,
    members,
    balances: Object.fromEntries(members.map(name => [name, 100000])),
    markets: loveIslandMarkets,
  };
  const lazyBoys = {
    id: PRESENTATION_GROUP_ID,
    name: "Lazy Boys",
    emoji: "🛋️",
    mode: "fake",
    createdAt: created,
    members,
    balances: Object.fromEntries(members.map(name => [name, 100000])),
    markets: [...personalMarkets, ...ambientMarkets],
  };

  const worldCupPlan = [
    ["Dave Jaga", DEMO_YES_ID, 720], ["Julian Asogwa", DEMO_NO_ID, 480],
    ["Korede Adeniyi", PRESENTATION_HAALAND_ID, 560], ["Joel Adejola", DEMO_YES_ID, 640],
    ["Jay Jay Ezugo", DEMO_NO_ID, 380], ["Julian Asogwa", PRESENTATION_HAALAND_ID, 420],
    ["Korede Adeniyi", DEMO_YES_ID, 850], ["Joel Adejola", DEMO_NO_ID, 510],
    ["Jay Jay Ezugo", DEMO_YES_ID, 620], ["Dave Jaga", PRESENTATION_HAALAND_ID, 360],
    ["Joel Adejola", DEMO_YES_ID, 940], ["Korede Adeniyi", DEMO_NO_ID, 630],
    ["Dave Jaga", DEMO_YES_ID, 740], ["Julian Asogwa", DEMO_NO_ID, 460],
    ["Joel Adejola", PRESENTATION_HAALAND_ID, 520], ["Korede Adeniyi", DEMO_YES_ID, 1050],
    ["Jay Jay Ezugo", PRESENTATION_HAALAND_ID, 390], ["Dave Jaga", DEMO_NO_ID, 570],
    ["Joel Adejola", DEMO_YES_ID, 680], ["Korede Adeniyi", PRESENTATION_HAALAND_ID, 440],
    ["Dave Jaga", DEMO_YES_ID, 890], ["Julian Asogwa", DEMO_NO_ID, 520],
    ["Korede Adeniyi", DEMO_YES_ID, 760], ["Joel Adejola", PRESENTATION_HAALAND_ID, 610],
    ["Jay Jay Ezugo", DEMO_YES_ID, 580], ["Dave Jaga", DEMO_NO_ID, 430],
    ["Joel Adejola", DEMO_YES_ID, 1120], ["Korede Adeniyi", DEMO_NO_ID, 650],
    ["Dave Jaga", PRESENTATION_HAALAND_ID, 470], ["Julian Asogwa", DEMO_YES_ID, 795],
  ];
  const loveIslandPlan = [
    ["Korede Adeniyi", PRESENTATION_LOVE_NO_ID, 690], ["Dave Jaga", PRESENTATION_LOVE_YES_ID, 410],
    ["Joel Adejola", PRESENTATION_LOVE_NO_ID, 840], ["Julian Asogwa", PRESENTATION_LOVE_YES_ID, 350],
    ["Dave Jaga", PRESENTATION_LOVE_NO_ID, 720], ["Korede Adeniyi", PRESENTATION_LOVE_YES_ID, 520],
    ["Julian Asogwa", PRESENTATION_LOVE_NO_ID, 910], ["Jay Jay Ezugo", PRESENTATION_LOVE_YES_ID, 380],
    ["Korede Adeniyi", PRESENTATION_LOVE_NO_ID, 760], ["Dave Jaga", PRESENTATION_LOVE_YES_ID, 440],
    ["Joel Adejola", PRESENTATION_LOVE_NO_ID, 1080], ["Julian Asogwa", PRESENTATION_LOVE_YES_ID, 560],
    ["Dave Jaga", PRESENTATION_LOVE_NO_ID, 670], ["Korede Adeniyi", PRESENTATION_LOVE_YES_ID, 490],
    ["Julian Asogwa", PRESENTATION_LOVE_NO_ID, 990], ["Joel Adejola", PRESENTATION_LOVE_YES_ID, 420],
    ["Korede Adeniyi", PRESENTATION_LOVE_NO_ID, 810], ["Dave Jaga", PRESENTATION_LOVE_YES_ID, 370],
    ["Joel Adejola", PRESENTATION_LOVE_NO_ID, 930], ["Julian Asogwa", PRESENTATION_LOVE_YES_ID, 460],
    ["Dave Jaga", PRESENTATION_LOVE_NO_ID, 880], ["Korede Adeniyi", PRESENTATION_LOVE_YES_ID, 510],
    ["Julian Asogwa", PRESENTATION_LOVE_NO_ID, 1040], ["Joel Adejola", PRESENTATION_LOVE_YES_ID, 450],
    ["Korede Adeniyi", PRESENTATION_LOVE_NO_ID, 790], ["Dave Jaga", PRESENTATION_LOVE_YES_ID, 405],
  ];
  worldCupPlan.forEach(([participant, outcomeId, amount], index) => applyDemoTrade(group, {
    participant,
    outcomeId,
    side: "yes",
    amount,
    action: "buy",
    createdAt: nowIso((-3.5 * 86400000) + index * 90 * 60 * 1000),
  }));
  loveIslandPlan.forEach(([participant, outcomeId, amount], index) => applyDemoTrade(loveIslandGroup, {
    participant,
    outcomeId,
    side: "yes",
    amount,
    action: "buy",
    createdAt: nowIso((-3.5 * 86400000) + index * 90 * 60 * 1000),
  }));
  smoothBinaryPresentationHistory(loveIslandGroup, PRESENTATION_LOVE_EVENT_ID);
  seedPersonalPresentationMarket(lazyBoys);
  seedAmbientPresentationMarkets(lazyBoys);
  return [group, loveIslandGroup, lazyBoys];
}

export function buildPresentationDemoGroup(memberName = "Dave Jaga") {
  return buildPresentationDemoGroups(memberName)[0];
}

function smoothBinaryPresentationHistory(group, eventId) {
  const eventMarkets = group.markets.filter(market => market.eventId === eventId);
  if (eventMarkets.length !== 2) return;
  const timestamps = eventMarkets[0].probabilityHistory.map(point => point.createdAt);
  const finalYes = Number(eventMarkets[0].probability || .5);
  const denominator = Math.max(1, timestamps.length - 1);
  eventMarkets.forEach((market, marketIndex) => {
    const finalProbability = marketIndex === 0 ? finalYes : 1 - finalYes;
    market.probabilityHistory = timestamps.map((createdAt, index) => {
      const progress = index / denominator;
      const smoothProgress = progress * progress * (3 - (2 * progress));
      return {
        createdAt,
        probability: .5 + ((finalProbability - .5) * smoothProgress),
      };
    });
  });
}

function presentationAmbientMarketSpecs(createdAt) {
  return [
    {
      eventId: "demo-ambient-late-dinner",
      title: "Who arrives last to the next group dinner?",
      outcomes: [["demo-late-dave", "Dave Jaga"], ["demo-late-joel", "Joel Adejola"], ["demo-late-jay", "Jay Jay Ezugo"]],
      description: "Resolves to the last listed person to arrive at the next full group dinner.",
      imageUrl: null,
      creator: "Julian Asogwa",
      resolutionSource: "Group arrival time",
      edgeCases: "Someone who cancels before the reservation is excluded.",
      createdAt,
      closesAt: nowIso(18 * 86400000),
      liquidity: 3200,
    },
    {
      eventId: "demo-ambient-new-city",
      title: "Who moves to a new city first?",
      outcomes: [["demo-city-julian", "Julian Asogwa"], ["demo-city-korede", "Korede Adeniyi"], ["demo-city-joel", "Joel Adejola"]],
      description: "Resolves to the first listed person who changes their primary residence to another city.",
      imageUrl: "/market-images/market-006-1f1254052d.jpg",
      creator: "Dave Jaga",
      resolutionSource: "Confirmed move announcement",
      edgeCases: "Trips and temporary stays under three months do not count.",
      createdAt,
      closesAt: nowIso(300 * 86400000),
      liquidity: 3600,
    },
    {
      eventId: "demo-ambient-trip",
      title: "Where will the next group trip be?",
      outcomes: [["demo-trip-lagos", "Lagos"], ["demo-trip-london", "London"], ["demo-trip-toronto", "Toronto"], ["demo-trip-barcelona", "Barcelona"]],
      description: "Resolves to the destination booked for the next trip with at least four group members.",
      imageUrl: "/market-images/market-010-b1ca940411.jpg",
      creator: "Jay Jay Ezugo",
      resolutionSource: "Confirmed group booking",
      edgeCases: "A destination not listed voids the market.",
      createdAt,
      closesAt: nowIso(120 * 86400000),
      liquidity: 3600,
    },
    {
      eventId: "demo-ambient-fifa-night",
      title: "Who wins the next FIFA night?",
      outcomes: [["demo-fifa-joel", "Joel Adejola"], ["demo-fifa-jay", "Jay Jay Ezugo"], ["demo-fifa-korede", "Korede Adeniyi"]],
      description: "Resolves to the winner of the next completed group FIFA tournament.",
      imageUrl: "/ball.png",
      creator: "Joel Adejola",
      resolutionSource: "Final tournament bracket",
      edgeCases: "The tournament must include all three listed players.",
      createdAt,
      closesAt: nowIso(12 * 86400000),
      liquidity: 3000,
    },
    {
      eventId: "demo-ambient-founder",
      title: "Who starts a company next?",
      outcomes: [["demo-founder-julian", "Julian Asogwa"], ["demo-founder-joel", "Joel Adejola"], ["demo-founder-jay", "Jay Jay Ezugo"], ["demo-founder-korede", "Korede Adeniyi"]],
      description: "Resolves to the first listed person to publicly launch a company with a working product or paying customer.",
      imageUrl: null,
      creator: "Korede Adeniyi",
      resolutionSource: "Public launch confirmed by the founder",
      edgeCases: "Unlaunched side projects do not count.",
      createdAt,
      closesAt: nowIso(420 * 86400000),
      liquidity: 3800,
    },
    {
      eventId: "demo-ambient-trip-attendance",
      title: "Will everyone make the annual group trip?",
      outcomes: [["demo-trip-all-yes", "Yes"], ["demo-trip-all-no", "No"]],
      description: "Resolves Yes if every confirmed member arrives for at least one full day of the annual trip.",
      imageUrl: "/market-images/market-013-5190a064a8.jpg",
      creator: "Julian Asogwa",
      resolutionSource: "Group attendance on the trip",
      edgeCases: "A cancellation before bookings are finalized does not count as a miss.",
      createdAt,
      closesAt: nowIso(80 * 86400000),
      liquidity: 3200,
    },
  ];
}

function seedAmbientPresentationMarkets(group) {
  const participants = ["Dave Jaga", "Julian Asogwa", "Korede Adeniyi", "Joel Adejola", "Jay Jay Ezugo"];
  const eventIds = [...new Set(group.markets.map(market => market.eventId))]
    .filter(eventId => String(eventId).startsWith("demo-ambient-"));
  eventIds.forEach((eventId, eventIndex) => {
    const market = group.markets.find(item => item.eventId === eventId);
    const outcomes = market?.outcomes || [];
    const count = 5 + (eventIndex % 4);
    for (let index = 0; index < count; index += 1) {
      const outcome = outcomes[(index * 2 + eventIndex) % outcomes.length];
      const amount = 160 + ((index * 137 + eventIndex * 83) % 390);
      applyDemoTrade(group, {
        participant: participants[(index + eventIndex) % participants.length],
        outcomeId: outcome.id,
        side: "yes",
        amount,
        action: "buy",
        createdAt: nowIso((-46 * 60 + eventIndex * 190 + index * 71) * 60000),
      });
    }
  });
}

function seedPersonalPresentationMarket(group) {
  let tradeIndex = 0;
  const participantMap = {
    "Maya Chen": "Dave Jaga",
    "Sam Okafor": "Julian Asogwa",
    "Riley Singh": "Korede Adeniyi",
    "Alex Morgan": "Joel Adejola",
  };
  const timelineStart = new Date(new Date().getFullYear(), 0, 8, 12).getTime();
  const timelineEnd = Date.now() - (6 * 60 * 60 * 1000);
  const place = ({ participant, outcomeId, amount = 0, action = "buy", shares = 0 }) => {
    const progress = Math.min(.995, (tradeIndex + ((tradeIndex * 7) % 5) / 8) / 29.5);
    const createdAt = new Date(timelineStart + ((timelineEnd - timelineStart) * progress)).toISOString();
    tradeIndex += 1;
    return applyDemoTrade(group, {
      participant: participantMap[participant] || participant,
      outcomeId,
      amount,
      action,
      shares,
      side: "yes",
      createdAt,
    });
  };
  const price = outcomeId => Number(group.markets.find(market => market.outcomeId === outcomeId)?.probability || 0);
  const catalyst = (outcomeId, title, detail, from) => {
    const eventMarkets = demoEventMarkets(group, outcomeId);
    const entries = eventMarkets[0]?.demoCatalysts;
    if (!entries) return;
    entries.push({
      title,
      detail,
      from,
      to: price(outcomeId),
      createdAt: eventMarkets[0].probabilityHistory.at(-1)?.createdAt,
    });
  };

  [
    ["Maya Chen", PRESENTATION_KOREDE_ID, 920], ["Sam Okafor", PRESENTATION_PRIMARY_ID, 540],
    ["Riley Singh", PRESENTATION_JULIAN_ID, 680], ["Alex Morgan", PRESENTATION_KOREDE_ID, 760],
    ["Maya Chen", PRESENTATION_JOEL_ID, 430], ["Sam Okafor", PRESENTATION_JAY_JAY_ID, 390],
    ["Riley Singh", PRESENTATION_KOREDE_ID, 870], ["Alex Morgan", PRESENTATION_PRIMARY_ID, 620],
    ["Maya Chen", PRESENTATION_JULIAN_ID, 510], ["Sam Okafor", PRESENTATION_KOREDE_ID, 790],
    ["Riley Singh", PRESENTATION_JAY_JAY_ID, 460], ["Alex Morgan", PRESENTATION_JOEL_ID, 570],
    ["Maya Chen", PRESENTATION_KOREDE_ID, 640], ["Sam Okafor", PRESENTATION_PRIMARY_ID, 470],
  ].forEach(([participant, outcomeId, amount]) => place({ participant, outcomeId, amount }));

  const koredeBefore = price(PRESENTATION_KOREDE_ID);
  [
    ["Maya Chen", 850], ["Sam Okafor", 720], ["Riley Singh", 780], ["Alex Morgan", 690],
  ].forEach(([participant, shares]) => place({ participant, outcomeId: PRESENTATION_KOREDE_ID, action: "sell", shares }));
  place({ participant: "Maya Chen", outcomeId: PRESENTATION_JULIAN_ID, amount: 880 });
  place({ participant: "Sam Okafor", outcomeId: PRESENTATION_PRIMARY_ID, amount: 760 });
  catalyst(
    PRESENTATION_KOREDE_ID,
    "Korede’s breakup changes the room",
    "Four traders sell Korede contracts, then rotate into Dave and Julian.",
    koredeBefore,
  );

  const daveBefore = price(PRESENTATION_PRIMARY_ID);
  [
    ["Alex Morgan", 1180], ["Riley Singh", 930], ["Maya Chen", 1040], ["Sam Okafor", 860],
  ].forEach(([participant, amount]) => place({ participant, outcomeId: PRESENTATION_PRIMARY_ID, amount }));
  catalyst(
    PRESENTATION_PRIMARY_ID,
    "Dave meets his girlfriend’s parents",
    "The group treats the relationship milestone as new information and buys Dave.",
    daveBefore,
  );

  const julianBefore = price(PRESENTATION_JULIAN_ID);
  [
    ["Riley Singh", PRESENTATION_JULIAN_ID, 920], ["Alex Morgan", PRESENTATION_JOEL_ID, 510],
    ["Maya Chen", PRESENTATION_JULIAN_ID, 740], ["Sam Okafor", PRESENTATION_JAY_JAY_ID, 580],
    ["Alex Morgan", PRESENTATION_PRIMARY_ID, 450], ["Riley Singh", PRESENTATION_JOEL_ID, 390],
  ].forEach(([participant, outcomeId, amount]) => place({ participant, outcomeId, amount }));
  catalyst(
    PRESENTATION_JULIAN_ID,
    "Julian is spotted ring shopping",
    "A smaller late wave moves Julian up without erasing Dave’s lead.",
    julianBefore,
  );
}

function buildPresentationEvent({ eventId, title, outcomes: outcomeSeeds, description, imageUrl, creator, resolutionSource, edgeCases, createdAt, closesAt, liquidity }) {
  const initialPrice = 1 / outcomeSeeds.length;
  const outcomes = outcomeSeeds.map(([id, outcomeTitle], sortOrder) => ({
    id,
    title: outcomeTitle,
    price: initialPrice,
    quantity: 0,
    sortOrder,
  }));
  const positions = {};
  const demoCatalysts = [];
  return outcomes.map(outcome => ({
    id: outcome.id,
    eventId,
    outcomeId: outcome.id,
    question: outcome.title,
    category: title,
    description,
    imageUrl,
    creator,
    status: "open",
    mode: "fake",
    oracleType: "manual",
    resolutionSource,
    edgeCases,
    verificationStatus: "not_started",
    verificationAttempts: [],
    resolvedBy: null,
    resolutionNotes: null,
    probability: outcome.price,
    pool_yes: null,
    pool_no: null,
    k: null,
    initialLiquidity: liquidity,
    totalBet: 0,
    yesSharesOutstanding: outcome.quantity,
    noSharesOutstanding: 0,
    closesAt,
    createdAt,
    outcome: null,
    resolvedAt: null,
    oracleProposal: null,
    trades: [],
    eventTrades: [],
    outcomes,
    positions,
    demoCatalysts,
    probabilityHistory: [{ createdAt, probability: outcome.price }],
    volumeHistory: [{ createdAt, volume: 0 }],
    volume: 0,
    liquidity,
  }));
}

function demoNetCash(amount) {
  return Math.max(0, Number(amount) || 0) * (1 - DEMO_FEE_RATE);
}

export function demoBuyShares(group, outcomeId, amount) {
  const eventMarkets = demoEventMarkets(group, outcomeId);
  const outcomes = eventMarkets[0]?.outcomes || [];
  const liquidity = Number(eventMarkets[0]?.initialLiquidity || DEMO_B);
  const target = outcomes.find(o => o.id === outcomeId) || outcomes[0];
  if (!target) return 0;
  const sumExp = outcomes.reduce((s, o) => s + Math.exp(o.quantity / liquidity), 0);
  const targetExp = Math.exp(target.quantity / liquidity);
  const net = demoNetCash(amount);
  if (net <= 0) return 0;
  return liquidity * Math.log(1 + (sumExp / targetExp) * (Math.exp(net / liquidity) - 1));
}

function demoEventMarkets(group, outcomeId) {
  const selected = group.markets.find(market => (
    market.id === outcomeId ||
    market.outcomeId === outcomeId ||
    (market.outcomes || []).some(outcome => outcome.id === outcomeId)
  ));
  if (!selected) return [];
  return group.markets.filter(market => market.eventId === selected.eventId);
}

function recomputeDemoPrices(eventMarkets) {
  const outcomes = eventMarkets[0]?.outcomes || [];
  const liquidity = Number(eventMarkets[0]?.initialLiquidity || DEMO_B);
  const sumExp = outcomes.reduce((s, o) => s + Math.exp(o.quantity / liquidity), 0);
  outcomes.forEach(o => { o.price = Math.exp(o.quantity / liquidity) / sumExp; });
  eventMarkets.forEach(m => {
    const own = outcomes.find(o => o.id === m.outcomeId);
    if (own) m.probability = own.price;
  });
}

export function applyDemoTrade(group, { participant, amount, outcomeId, side, action = "buy", shares: requestedShares, createdAt: requestedCreatedAt }) {
  const eventMarkets = demoEventMarkets(group, outcomeId);
  const outcomes = eventMarkets[0]?.outcomes || [];
  const target = outcomes.find(o => o.id === outcomeId) || outcomes[0];
  if (!target) return 0;
  const positions = eventMarkets[0].positions;
  positions[participant] = positions[participant] || {};
  const pricesBefore = new Map(eventMarkets.map(market => [market.outcomeId, Number(market.probability || 0)]));
  let cash = Math.max(0, Number(amount) || 0);
  let shares = 0;
  if (action === "sell") {
    const held = Math.max(0, Number(positions[participant][target.id] || 0));
    shares = Math.min(held, Math.max(0, Number(requestedShares) || 0));
    if (shares <= 0) return 0;
    const liquidity = Number(eventMarkets[0]?.initialLiquidity || DEMO_B);
    const sumExp = outcomes.reduce((sum, outcome) => sum + Math.exp(outcome.quantity / liquidity), 0);
    const targetExp = Math.exp(target.quantity / liquidity);
    const newSumExp = sumExp - targetExp + Math.exp((target.quantity - shares) / liquidity);
    cash = Math.max(0, liquidity * Math.log(sumExp / newSumExp) * (1 - DEMO_FEE_RATE));
    target.quantity -= shares;
    positions[participant][target.id] = Math.max(0, held - shares);
    group.balances[participant] = (group.balances[participant] ?? 0) + cash;
  } else {
    shares = demoBuyShares(group, target.id, cash);
    if (shares <= 0) return 0;
    target.quantity += shares;
    positions[participant][target.id] = (positions[participant][target.id] || 0) + shares;
    group.balances[participant] = Math.max(0, (group.balances[participant] ?? 0) - cash);
  }
  recomputeDemoPrices(eventMarkets);
  const createdAt = requestedCreatedAt || new Date().toISOString();
  const baseTrade = {
    participant,
    side: side || "yes",
    action,
    cashAmount: cash,
    cash_amount: cash,
    amount: cash,
    shares: action === "sell" ? -shares : shares,
    outcomeId: target.id,
    createdAt,
  };
  const targetProbabilityBefore = Number(pricesBefore.get(target.id) || 0);
  const targetProbabilityAfter = Number(eventMarkets.find(market => market.outcomeId === target.id)?.probability || 0);
  const sharedTrade = {
    ...baseTrade,
    id: `demo-${String(createdAt).replace(/\D/g, "").slice(-10)}-${String(participant).replace(/\W/g, "").slice(0, 6)}`,
    probBefore: targetProbabilityBefore,
    probAfter: targetProbabilityAfter,
    avgPrice: shares ? cash / shares : targetProbabilityAfter,
  };
  eventMarkets.forEach(m => {
    m.eventTrades = [...(m.eventTrades || []), sharedTrade];
    if (m.outcomeId === target.id) m.trades = [...(m.trades || []), sharedTrade];
    m.volume = (m.volume || 0) + cash;
    m.totalBet = m.volume;
    m.positions = positions;
    m.probabilityHistory = [...(m.probabilityHistory || []), { createdAt: sharedTrade.createdAt, probability: m.probability }];
    m.volumeHistory = [...(m.volumeHistory || []), { createdAt: sharedTrade.createdAt, volume: m.volume }];
  });
  return action === "sell" ? -shares : shares;
}

export function simulateDemoApi(path, opts, group, allGroups) {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  if (path.endsWith("/quote")) {
    const outcomes = demoEventMarkets(group, body.outcomeId)[0]?.outcomes || [];
    const target = outcomes.find(o => o.id === body.outcomeId) || outcomes[0];
    if (!target) throw new Error("Demo outcome not found.");
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
  const eventMarkets = demoEventMarkets(group, winningOutcomeId);
  const outcomes = eventMarkets[0]?.outcomes || [];
  const positions = eventMarkets[0]?.positions || {};
  outcomes.forEach(o => { o.price = o.id === winningOutcomeId ? 1 : 0; });
  Object.entries(positions).forEach(([member, held]) => {
    const winShares = Number(held?.[winningOutcomeId] || 0);
    if (winShares > 0) group.balances[member] = (group.balances[member] ?? 0) + winShares;
  });
  eventMarkets.forEach(m => {
    m.status = "resolved";
    m.outcome = winningOutcomeId;
    m.resolvedAt = now;
    m.resolvedBy = "Demo";
    m.resolutionNotes = "Practice market — resolved instantly for the tutorial.";
    m.probability = m.outcomeId === winningOutcomeId ? 1 : 0;
  });
}
