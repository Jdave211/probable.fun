import "./styles.css";
import {
  Chart,
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Filler,
  Tooltip,
} from "chart.js";
import { animate, stagger } from "motion";
import { supabase } from "./supabase.js";
import { DEMO_GROUP_ID, buildDemoGroup, simulateDemoApi, resolveDemoMarket } from "./demo.js";
import { startTutorial, stopTutorial, tutorialOnRender } from "./tutorial.js";
import { DEFAULT_PREDICTOR_ID, LEAGUE_PREDICTORS, LEAGUE_PREDICTOR_LIST } from "./league-predictors.js";

const probableCursorShadePlugin = {
  id: "probableCursorShade",
  beforeEvent(chart, args) {
    if (!chart.options.plugins?.probableCursorShade?.enabled) return;
    if (args.event.type === "mouseout") {
      chart.$probableHoverX = null;
      chart.$probableHoverIndex = null;
      chart.draw();
    }
  },
  afterDraw(chart, _args, options) {
    if (!options?.enabled) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const index = Number.isInteger(chart.$probableHoverIndex) ? chart.$probableHoverIndex : chart.$probablePinnedIndex;
    const xScale = scales.x;
    const x = Number.isInteger(index) && xScale ? xScale.getPixelForValue(index) : chart.$probableHoverX || chart.$probablePinnedX;
    if (!Number.isFinite(x) || x < chartArea.left || x > chartArea.right) return;
    ctx.save();
    drawMutedFutureSegments(chart, index, x, options);
    ctx.strokeStyle = options?.guideColor || "rgba(157, 171, 181, 0.32)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    drawProbableChartLabels(chart, index, x, options);
    ctx.restore();
  },
};

function drawMutedFutureSegments(chart, index, x, options = {}) {
  if (!Number.isInteger(index)) return;
  const { ctx, chartArea } = chart;
  const datasets = chart.data.datasets || [];
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, chartArea.top, chartArea.right - x, chartArea.bottom - chartArea.top);
  ctx.clip();
  ctx.fillStyle = options?.lineMaskColor || "rgba(13, 18, 22, 0.82)";
  for (const [datasetIndex] of datasets.entries()) {
    if (!chart.isDatasetVisible(datasetIndex)) continue;
    const meta = chart.getDatasetMeta(datasetIndex);
    const points = meta?.data || [];
    if (points.length <= index) continue;
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(0, index); i < points.length; i += 1) {
      const point = points[i];
      const px = Number(point?.x);
      const py = Number(point?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    if (started) {
      ctx.lineWidth = window.innerWidth < 620 ? 7 : 9;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = options?.futureLineAlpha ?? 0.72;
  for (const [datasetIndex, dataset] of datasets.entries()) {
    if (!chart.isDatasetVisible(datasetIndex)) continue;
    const meta = chart.getDatasetMeta(datasetIndex);
    const points = meta?.data || [];
    if (points.length <= index) continue;
    ctx.strokeStyle = options?.futureLineColor || "#6f7b84";
    ctx.lineWidth = Math.max(1, (Number(dataset.borderWidth) || 2) * 0.9);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(0, index); i < points.length; i += 1) {
      const point = points[i];
      const px = Number(point?.x);
      const py = Number(point?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    if (started) ctx.stroke();
  }
  ctx.restore();
}

const probableChartActiveDotsPlugin = {
  id: "probableChartActiveDots",
  afterEvent(chart, args) {
    if (chart.options.plugins?.probableCursorShade?.enabled) return;
    if (!chart.options.plugins?.probableChartActiveDots?.enabled) return;
    const { chartArea, scales } = chart;
    const event = args.event;
    if (!chartArea || !event) return;
    if (
      event.type === "mouseout" ||
      event.x < chartArea.left ||
      event.x > chartArea.right ||
      event.y < chartArea.top ||
      event.y > chartArea.bottom
    ) {
      if (chart.$probableHoverIndex != null) {
        chart.$probableHoverIndex = null;
        args.changed = true;
      }
      return;
    }
    const rawIndex = scales.x?.getValueForPixel(event.x);
    const maxIndex = Math.max(0, (chart.data.labels?.length || 1) - 1);
    const nextIndex = Math.max(0, Math.min(maxIndex, Math.round(Number(rawIndex) || 0)));
    if (chart.$probableHoverIndex !== nextIndex) {
      chart.$probableHoverIndex = nextIndex;
      args.changed = true;
    }
  },
  afterDatasetsDraw(chart, _args, options) {
    if (options?.enabled === false) return;
    drawChartActiveDots(chart);
  },
};

function drawProbableChartLabels(chart, index, x, options) {
  if (!Number.isInteger(index)) return;
  const { ctx, chartArea } = chart;
  const datasets = chart.data.datasets || [];
  const points = datasets
    .map((dataset, datasetIndex) => {
      const value = Number(dataset.data?.[index]);
      if (!Number.isFinite(value)) return null;
      const meta = chart.getDatasetMeta(datasetIndex);
      const y = meta?.data?.[index]?.y;
      return {
        label: dataset.label || "",
        value,
        y: Number.isFinite(y) ? y : chart.scales.y.getPixelForValue(value),
        color: dataset.borderColor || "#7b8994",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.y - b.y);
  if (!points.length) return;

  ctx.font = '700 12px "IBM Plex Mono"';
  ctx.textBaseline = "middle";
  const labelX = Math.min(x + 12, chartArea.right - 112);
  const labelDate = chart.data.labels?.[index] || "";
  ctx.fillStyle = "#8d9aa5";
  ctx.fillText(labelDate, labelX, Math.max(chartArea.top - 12, 10));

  let lastY = chartArea.top + 12;
  for (const point of points) {
    const rowY = Math.max(lastY, Math.min(point.y, chartArea.bottom - 10));
    const text = `${point.label} ${point.value.toFixed(point.value % 1 ? 1 : 0)}%`;
    ctx.fillStyle = point.color;
    roundRect(ctx, labelX, rowY - 3, 5, 5, 2.5);
    ctx.fill();
    ctx.fillStyle = options?.textColor || "#f2f5f7";
    ctx.fillText(text, labelX + 10, rowY);
    lastY = rowY + 18;
  }
}

function drawChartActiveDots(chart) {
  const { ctx, chartArea } = chart;
  if (!chartArea) return;
  ctx.save();
  for (const [datasetIndex, dataset] of (chart.data.datasets || []).entries()) {
    if (!chart.isDatasetVisible(datasetIndex)) continue;
    const meta = chart.getDatasetMeta(datasetIndex);
    const activeIndex = Number.isInteger(chart.$probableHoverIndex)
      ? chart.$probableHoverIndex
      : Number.isInteger(chart.$probablePinnedIndex)
        ? chart.$probablePinnedIndex
        : Math.max(0, (dataset.data?.length || 1) - 1);
    const point = meta?.data?.[activeIndex];
    if (!point) continue;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const color = dataset.borderColor || "#7b8994";
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, window.innerWidth < 620 ? 7 : 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.strokeStyle = dataset.pointBorderColor || "#11191e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, window.innerWidth < 620 ? 4 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function chartActivePointIndex(ctx) {
  const hover = ctx.chart?.$probableHoverIndex;
  const pinned = ctx.chart?.$probablePinnedIndex;
  if (Number.isInteger(hover)) return hover;
  if (Number.isInteger(pinned)) return pinned;
  return Math.max(0, (ctx.dataset?.data?.length || 1) - 1);
}

function chartFollowPointRadius(ctx, radius = 5) {
  return ctx.dataIndex === chartActivePointIndex(ctx) ? radius : 0;
}

function chartFollowPointBorderWidth(ctx) {
  return ctx.dataIndex === chartActivePointIndex(ctx) ? 2 : 0;
}

const portfolioEndMarkerPlugin = {
  id: "portfolioEndMarker",
  afterDatasetsDraw(chart, _args, options = {}) {
    if (!options.enabled) return;
    const meta = chart.getDatasetMeta(0);
    const points = meta?.data || [];
    const point = points[points.length - 1];
    if (!point) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const { ctx, chartArea } = chart;
    const value = chart.data.datasets?.[0]?.data?.at(-1);
    const label = money(value);
    ctx.save();
    ctx.shadowColor = "rgba(45, 156, 255, 0.34)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = "rgba(45, 156, 255, 0.16)";
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = options.color || "#2d9cff";
    ctx.strokeStyle = "rgba(255,255,255,0.94)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.font = "800 11px IBM Plex Mono, monospace";
    const textWidth = ctx.measureText(label).width;
    const width = textWidth + 18;
    const height = 24;
    const labelX = Math.min(chartArea.right - width, Math.max(chartArea.left, x - width - 10));
    const labelY = Math.max(chartArea.top + 2, y - height - 12);
    ctx.fillStyle = options.labelBg || "rgba(15, 22, 26, 0.92)";
    ctx.strokeStyle = options.labelBorder || "rgba(45, 156, 255, 0.28)";
    ctx.lineWidth = 1;
    roundRect(ctx, labelX, labelY, width, height, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = options.labelColor || "rgba(244,247,249,0.82)";
    ctx.fillText(label, labelX + 9, labelY + 16);
    ctx.restore();
  },
};

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip, probableCursorShadePlugin, probableChartActiveDotsPlugin, portfolioEndMarkerPlugin);

const API = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const API_CONFIG_ERROR = "Production API is not configured. Set VITE_API_BASE_URL in Vercel to your Render backend URL.";
const DEFAULT_BALANCE = 100000;
const DEFAULT_MARKET_LIQUIDITY = 20000;
const MARKET_FEE_RATE = 0.015;
const API_TIMEOUT_MS = 18000;
const BOOT_API_TIMEOUT_MS = 9000;
const AUTH_TIMEOUT_MS = 8000;
const ALL_OUTCOMES_RESOLUTION = "__all__";

function defaultMarketLiquidityForOutcomeCount(count) {
  const n = Math.max(2, Number(count || 2));
  if (n <= 2) return DEFAULT_MARKET_LIQUIDITY;
  if (n <= 10) return 50000;
  return Math.min(200000, Math.max(80000, Math.round((n * 3000) / 1000) * 1000));
}
let rulesDraftPromise = null;
const MAX_MARKET_IMAGE_BYTES = 650000;
const EVENT_CHART_COLORS = ["#2d9cff", "#f23645", "#f2c414", "#ff861c", "#8bd450", "#b87cff", "#18c3b6", "#78b7ff"];
const BINARY_CHART_COLORS = { yes: "#2d9cff", no: "#f23645" };
const charts = new Map();
let gooeyCleanup = null;
let bootRetryTimer = null;
const STORAGE_KEYS = {
  shell: "probable_shell",
  view: "probable_view",
  groupId: "probable_groupId",
  user: "probable_user",
  devAuth: "probable_dev_auth",
  bootCache: "probable_boot_cache_v1",
  groupAddons: "probable_group_addons_v1",
};

const state = {
  groups: [],
  currentGroupId: null,
  activeMember: null,
  shell: "welcome",
  view: "dashboard",
  welcomeMode: "actions",
  joinPreFill: null,
  inviteToken: null,
  invitePreview: null,
  inviteError: "",
  inviteLoading: false,
  inviteModal: { groupId: null, invite: null, loading: false, error: "", confirmRegenerate: false },
  embedModal: { marketId: null, chart: true, buttons: true, dark: true, border: true },
  tradeHistoryModal: { marketId: null, sort: "recent" },
  embedRoute: null,
  sharedMarketId: null,
  bootError: "",
  marketLinkError: "",
  trade: { marketId: null, side: null, mode: "buy" },
  expandedEventKey: null,
  oracleErrors: {},
  pendingAuthAction: null,
  authUser: null,
  accountMenuOpen: false,
  leaderboardMode: "chart",
  leaderboardMetric: "nominal",
  portfolioChartMetric: "mark",
  portfolioChartRange: "all",
  positionsStatus: "open",
  expandedParticipants: new Set(),
  expandedOutcomeEvents: new Set(),
  marketSort: "trending",
  marketStatus: "open",
  mobileTradeOpen: false,
  marketFormStep: 1,
  marketImageDataUrl: "",
  marketImageName: "",
  marketOddsSeed: null,
  marketImages: [],
  bracketPicks: {},
  bracketSubmitted: false,
  bracketRoundIndex: 0,
  bracketView: "grid",
  bracketEntryId: "",
  sharedBracketEntryId: "",
  bracketRemoteLoaded: false,
  bracketLastPickedId: "",
  bracketSaving: false,
  activePredictorId: DEFAULT_PREDICTOR_ID,
  plRanking: [],
  plEntryId: "",
  plSubmitted: false,
  plRemoteLoaded: false,
  plSaving: false,
  plSharedEntryId: "",
  pendingUi: { marketCreate: false, welcomeCreate: false, rulesDraft: false, oddsSeed: false, suggestions: false, suggestionPreview: null, tradeMarketId: null, resolveMarketId: null },
  demoMode: false,
  demoPrevGroupId: null,
  questionSuggestions: [],
  questionSuggestionsGroupId: null,
  loaded: false,
};

const tradeQuoteCache = new Map();
const tradeQuoteInflight = new Map();

const BRACKET_CHALLENGE = {
  id: "wc26-bracket-r32",
  prize: "up to $500",
  title: "World Cup Bracket Challenge",
  subtitle: "Free to enter. Submit the cleanest knockout bracket from the Round of 32 onward.",
  matchups: [
    { id: "m73", matchNo: 73, teams: ["South Africa", "Canada"], winner: "Canada", completed: true },
    { id: "m74", matchNo: 74, teams: ["Germany", "Paraguay"], winner: "Paraguay", completed: true },
    { id: "m75", matchNo: 75, teams: ["Netherlands", "Morocco"], winner: "Morocco", completed: true },
    { id: "m76", matchNo: 76, teams: ["Brazil", "Japan"], winner: "Brazil", completed: true },
    { id: "m77", matchNo: 77, teams: ["France", "Sweden"], winner: "France", completed: true },
    { id: "m78", matchNo: 78, teams: ["Ivory Coast", "Norway"], winner: "Norway", completed: true },
    { id: "m79", matchNo: 79, teams: ["Mexico", "Ecuador"], winner: "Mexico", completed: true },
    { id: "m80", matchNo: 80, teams: ["England", "DR Congo"], winner: "England", completed: true },
    { id: "m81", matchNo: 81, teams: ["USA", "Bosnia and Herzegovina"], winner: "USA", completed: true },
    { id: "m82", matchNo: 82, teams: ["Belgium", "Senegal"], winner: "Belgium", completed: true },
    { id: "m83", matchNo: 83, teams: ["Portugal", "Croatia"], winner: "Portugal", completed: true },
    { id: "m84", matchNo: 84, teams: ["Spain", "Austria"], winner: "Spain", completed: true },
    { id: "m85", matchNo: 85, teams: ["Switzerland", "Algeria"], winner: "Switzerland", completed: true },
    { id: "m86", matchNo: 86, teams: ["Argentina", "Cabo Verde"], winner: "Argentina", completed: true },
    { id: "m87", matchNo: 87, teams: ["Colombia", "Ghana"], winner: "Colombia", completed: true },
    { id: "m88", matchNo: 88, teams: ["Australia", "Egypt"], winner: "Egypt", completed: true },
  ],
};
const BRACKET_DERIVED_RESULTS = {
  m89: "France",
  m90: "Morocco",
  m91: "Norway",
  m92: "England",
  m93: "Belgium",
  m94: "Spain",
  m95: "Argentina",
  m96: "Switzerland",
  m97: "France",
  m98: "Spain",
  m99: "England",
  m100: "Argentina",
  m101: "Spain",
  m102: "Argentina",
  final: "Spain",
};
const BRACKET_LOCKED_WINNERS = {
  ...Object.fromEntries(
    BRACKET_CHALLENGE.matchups
      .filter(matchup => matchup.completed && matchup.winner)
      .map(matchup => [matchup.id, matchup.winner])
  ),
  ...BRACKET_DERIVED_RESULTS,
};
const BRACKET_TEAM_CHANCES = {
  France: 23,
  Spain: 11,
  Argentina: 10,
  Brazil: 9,
  England: 8,
  Portugal: 6,
  Netherlands: 5,
  Germany: 4,
  Colombia: 4,
  Belgium: 3,
  USA: 3,
  Mexico: 3,
  Canada: 2,
  Switzerland: 2,
  Croatia: 1,
  Morocco: 1,
  Senegal: 1,
  Japan: 1,
  Norway: 1,
  Austria: 1,
  Ecuador: 1,
  Ghana: 1,
  Sweden: 1,
  "Ivory Coast": 1,
  Australia: 1,
  Egypt: 1,
  Algeria: 1,
  Paraguay: 1,
  "DR Congo": 1,
  "Bosnia and Herzegovina": 1,
  "Cabo Verde": 1,
  "South Africa": 0.5,
};

function activeLeaguePredictor() {
  return LEAGUE_PREDICTORS[state.activePredictorId] || LEAGUE_PREDICTORS[DEFAULT_PREDICTOR_ID];
}

function leaguePredictorDraftKey(predictorId = state.activePredictorId) {
  return `probable_${predictorId.replace(/[^a-z0-9_-]/gi, "_")}_draft_v1`;
}

const GENERAL_MARKET_POOL = [
  {
    id: "world-cup-bracket",
    type: "bracket",
    title: BRACKET_CHALLENGE.title,
    subtitle: "Free-to-enter knockout bracket contest.",
    eyebrow: "General pool",
    prize: BRACKET_CHALLENGE.prize,
  },
  ...LEAGUE_PREDICTOR_LIST.map(predictor => ({
    id: `${predictor.id}-table-predictor`,
    type: "league-predictor",
    predictorId: predictor.id,
    route: predictor.route,
    leagueMark: predictor.leagueMark,
    logoUrl: predictor.logoUrl,
    title: predictor.title,
    subtitle: `Rank all ${predictor.clubs.length} clubs before kickoff.`,
    eyebrow: "General pool",
    prize: "Season contest",
  })),
];

document.querySelector("#app").innerHTML = `
  <nav class="topnav" id="topnav">
    <button class="logo" type="button" data-go-welcome>probable<span class="logo-dot">.</span></button>
    <div class="nav-sep" id="navSep"></div>
    <div class="group-tabs" id="groupTabs"></div>
    <div class="nav-right" id="navRight"></div>
  </nav>

  <main class="main">
    <div id="mainContent"></div>
  </main>

  <div class="modal-overlay hidden" id="groupModalOverlay">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Create group</span>
        <button class="modal-x" type="button" id="closeGroupModal" aria-label="Close">x</button>
      </div>
      <form id="groupForm">
        <div class="field-row">
          <div class="field">
            <label class="field-label">Group name</label>
            <input name="name" placeholder="Friday Picks" maxlength="40" required />
          </div>
          <div class="field emoji-field">
            <label class="field-label">Mark</label>
            <input type="hidden" name="emoji" value="⚽" />
            <div class="emoji-wheel" role="radiogroup" aria-label="Group mark">
              <button type="button" class="emoji-chip active" data-emoji-option="⚽" aria-pressed="true">⚽</button>
              <button type="button" class="emoji-chip" data-emoji-option="🏆" aria-pressed="false">🏆</button>
              <button type="button" class="emoji-chip" data-emoji-option="🥇" aria-pressed="false">🥇</button>
              <button type="button" class="emoji-chip" data-emoji-option="🏅" aria-pressed="false">🏅</button>
              <button type="button" class="emoji-chip" data-emoji-option="👑" aria-pressed="false">👑</button>
              <button type="button" class="emoji-chip" data-emoji-option="🐐" aria-pressed="false">🐐</button>
              <button type="button" class="emoji-chip" data-emoji-option="🔥" aria-pressed="false">🔥</button>
              <button type="button" class="emoji-chip" data-emoji-option="⭐" aria-pressed="false">⭐</button>
              <button type="button" class="emoji-chip" data-emoji-option="🏟️" aria-pressed="false">🏟️</button>
              <button type="button" class="emoji-chip" data-emoji-option="🎯" aria-pressed="false">🎯</button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="cancelGroupModal">Cancel</button>
          <button type="submit" class="btn btn-primary">Create</button>
        </div>
      </form>
    </div>
  </div>

  <div class="modal-overlay hidden" id="joinModalOverlay">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Join group</span>
        <button class="modal-x" type="button" id="closeJoinModal" aria-label="Close">x</button>
      </div>
      <form id="joinForm">
        <div class="field">
          <label class="field-label">Invite link or group ID</label>
          <input name="groupId" placeholder="Paste invite link or group ID" required />
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="cancelJoinModal">Cancel</button>
          <button type="submit" class="btn btn-primary">Join</button>
        </div>
      </form>
    </div>
  </div>

  <div class="modal-overlay hidden" id="inviteModalOverlay">
    <div class="modal invite-modal">
      <div class="modal-header">
        <span class="modal-title">Invite friends</span>
        <button class="modal-x" type="button" id="closeInviteModal" aria-label="Close">x</button>
      </div>
      <div id="inviteModalBody" class="invite-modal-body"></div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="generalMarketModalOverlay">
    <div class="modal general-market-modal">
      <div class="modal-header">
        <span class="modal-title">Add from general pool</span>
        <button class="modal-x" type="button" id="closeGeneralMarketModal" aria-label="Close">x</button>
      </div>
      <div id="generalMarketModalBody" class="general-market-modal-body"></div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="embedModalOverlay">
    <div class="modal embed-modal">
      <div class="modal-header">
        <span class="modal-title">Share market</span>
        <button class="modal-x" type="button" id="closeEmbedModal" aria-label="Close">x</button>
      </div>
      <div id="embedModalBody" class="embed-modal-body"></div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="leaderProfileModalOverlay">
    <div class="modal leader-profile-modal">
      <div class="modal-header">
        <span class="modal-title">Trader profile</span>
        <button class="modal-x" type="button" id="closeLeaderProfileModal" aria-label="Close">x</button>
      </div>
      <div id="leaderProfileModalBody" class="leader-profile-body"></div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="tradeHistoryModalOverlay">
    <div class="modal trade-history-modal">
      <div class="modal-header">
        <span class="modal-title">Market trades</span>
        <button class="modal-x" type="button" id="closeTradeHistoryModal" aria-label="Close">x</button>
      </div>
      <div id="tradeHistoryModalBody" class="trade-history-modal-body"></div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="loginModalOverlay">
    <div class="modal auth-modal">
      <div class="auth-close-row">
        <button class="modal-x" type="button" id="closeLoginModal" aria-label="Close">x</button>
      </div>
      <form id="loginForm">
        <div class="auth-brand-lockup">
          <div class="auth-logo-mark" aria-hidden="true">probable<span class="logo-dot">.</span></div>
          <span class="modal-title" id="loginModalTitle">Sign in to Probable</span>
          <p class="auth-current" id="authCurrent">Welcome back, sign in to create markets.</p>
        </div>
        <div class="auth-name-area" id="authNameArea">
          <label for="authNameInput">Display name</label>
          <input id="authNameInput" name="displayName" type="text" autocomplete="name" maxlength="40" placeholder="Enter your name" />
        </div>
        <div class="auth-provider-row" id="authProviderArea">
          <button type="button" class="auth-provider-btn" id="googleSignInBtn" aria-label="Sign in with Google">
            <span class="google-logo" aria-hidden="true"></span>
            <span>Google</span>
          </button>
        </div>
        <div class="auth-divider" id="authDivider"><span></span><em>or</em><span></span></div>
        <div class="auth-email-area" id="authEmailArea">
          <label for="authEmailInput">Email address</label>
          <input id="authEmailInput" name="email" type="email" inputmode="email" autocomplete="email" placeholder="Enter your email address" />
          <button type="submit" class="auth-continue-btn">Continue <span aria-hidden="true">›</span></button>
        </div>
        <div class="auth-session-actions hidden" id="authSessionActions">
          <button type="button" class="auth-continue-btn auth-signout" id="signOutBtn">Sign out</button>
        </div>
      </form>
      <div class="auth-modal-footer" id="authModalFooter">
        <span>Don’t have an account?</span>
        <button type="button" id="authSignUpBtn">Sign up</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="suggestPreviewModalOverlay">
    <div class="modal suggest-preview-modal" id="suggestPreviewModal">
      <div class="modal-header">
        <span class="modal-title">Question preview</span>
        <button class="modal-x" type="button" id="closeSuggestPreviewModal" aria-label="Close">×</button>
      </div>
      <p class="suggest-preview-question" id="suggestPreviewQuestion"></p>
      <div class="suggest-preview-rules" id="suggestPreviewRules"></div>
      <div class="suggest-preview-actions">
        <button class="btn btn-ghost" type="button" id="dismissSuggestPreview">Dismiss</button>
        <button class="btn btn-primary" type="button" id="createFromSuggestion">Create this market</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="marketModalOverlay">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">New market</span>
        <button class="modal-x" type="button" id="closeMarketModal" aria-label="Close">x</button>
      </div>
      <form id="marketForm">
        <div class="market-form-progress">
          <div class="market-progress-meta">
            <span data-market-step-label>Basics</span>
            <span data-market-step-count>Step 1</span>
          </div>
          <div class="market-progress-track" aria-hidden="true">
            <span data-market-progress-fill></span>
          </div>
        </div>
        <div class="market-form-step" data-market-form-step="1">
          <p class="form-helper">Start with the market people will trade.</p>
          <div class="field">
            <label class="field-label">Question</label>
            <input name="question" placeholder="Will Wirtz get 3+ GA tomorrow?" maxlength="100" required />
            <div class="form-suggest-chips hidden" data-form-suggest-chips></div>
          </div>
          <div class="field prediction-field">
            <label class="field-label">Predictions</label>
            <div class="prediction-builder">
              <div class="prediction-builder-head">
                <span>Outcome set</span>
                <div class="market-type-toggle" role="radiogroup" aria-label="Market type">
                  <button type="button" class="active" data-market-type="binary" aria-pressed="true">Binary</button>
                  <button type="button" data-market-type="multi" aria-pressed="false">Multiple</button>
                </div>
              </div>
              <textarea name="outcomes" placeholder="Yes, No" required>Yes, No</textarea>
              <div class="prediction-chip-preview" data-outcome-preview></div>
            </div>
            <small class="field-help">Add one outcome per line or separate them with commas.</small>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="field-label">Maturity date</label>
              <input name="closesAt" type="datetime-local" required />
            </div>
          </div>
        </div>
        <div class="market-form-step hidden" data-market-form-step="2">
          <p class="form-helper">AI fleshes this out automatically — edit freely.</p>
          <div class="field">
            <label class="field-label">Detailed description</label>
            <textarea name="description" maxlength="2400" placeholder="What exactly has to happen, what source settles it, and what counts as ambiguous?" required></textarea>
            <small class="field-help ai-generating-note hidden" data-ai-generating-note>✨ AI is fleshing out the rules…</small>
          </div>
        </div>
        <div class="market-form-step hidden" data-market-form-step="3">
          <p class="form-helper">Optional. Add a market picture, or skip and we'll use a stock football image.</p>
          <div class="market-image-picker">
            <label class="market-image-drop">
              <input name="image" type="file" accept="image/*" />
              <span class="market-image-preview" data-market-image-preview>
                ${imageUploadIconSvg()}
              </span>
              <span class="market-image-copy">
                <strong>Upload market picture</strong>
                <small>Square-ish photos work best. Max 650KB.</small>
              </span>
            </label>
          </div>
        </div>
        <div class="market-form-step hidden" data-market-form-step="4">
          <p class="form-helper">Optional for multi-outcome markets.</p>
          <div class="market-odds-card">
            <label class="market-odds-toggle">
              <input type="checkbox" data-market-odds-toggle />
              <span>
                <strong>Seed starting odds with AI</strong>
                <small>Useful for big fields like World Cup winner. We look up current context, then soften it so favorites get a head start without killing longshots.</small>
              </span>
            </label>
            <div class="market-odds-actions">
              <button type="button" class="btn btn-ghost" data-generate-market-odds>Generate seed odds</button>
              <span data-market-odds-status>Off. This market will start equal.</span>
            </div>
            <div class="market-odds-preview" data-market-odds-preview></div>
          </div>
        </div>
        <div class="market-form-step hidden" data-market-form-step="5">
          <p class="form-helper">Check the setup before it goes live.</p>
          <div class="market-review" data-market-review></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost hidden" data-market-step-back>Back</button>
          <button type="button" class="btn btn-primary" data-market-step-next>Continue</button>
          <button type="submit" class="btn btn-primary hidden" data-market-submit>Create market</button>
        </div>
      </form>
    </div>
  </div>

  <div class="toast hidden" id="toast"></div>
`;

const dom = {
  navSep: document.querySelector("#navSep"),
  groupTabs: document.querySelector("#groupTabs"),
  navRight: document.querySelector("#navRight"),
  mainContent: document.querySelector("#mainContent"),
  groupModalOverlay: document.querySelector("#groupModalOverlay"),
  joinModalOverlay: document.querySelector("#joinModalOverlay"),
  inviteModalOverlay: document.querySelector("#inviteModalOverlay"),
  inviteModalBody: document.querySelector("#inviteModalBody"),
  generalMarketModalOverlay: document.querySelector("#generalMarketModalOverlay"),
  generalMarketModalBody: document.querySelector("#generalMarketModalBody"),
  embedModalOverlay: document.querySelector("#embedModalOverlay"),
  embedModalBody: document.querySelector("#embedModalBody"),
  leaderProfileModalOverlay: document.querySelector("#leaderProfileModalOverlay"),
  leaderProfileModalBody: document.querySelector("#leaderProfileModalBody"),
  tradeHistoryModalOverlay: document.querySelector("#tradeHistoryModalOverlay"),
  tradeHistoryModalBody: document.querySelector("#tradeHistoryModalBody"),
  loginModalOverlay: document.querySelector("#loginModalOverlay"),
  marketModalOverlay: document.querySelector("#marketModalOverlay"),
  suggestPreviewModalOverlay: document.querySelector("#suggestPreviewModalOverlay"),
  suggestPreviewQuestion: document.querySelector("#suggestPreviewQuestion"),
  suggestPreviewRules: document.querySelector("#suggestPreviewRules"),
  groupForm: document.querySelector("#groupForm"),
  joinForm: document.querySelector("#joinForm"),
  loginForm: document.querySelector("#loginForm"),
  authCurrent: document.querySelector("#authCurrent"),
  authNameArea: document.querySelector("#authNameArea"),
  authNameInput: document.querySelector("#authNameInput"),
  authProviderArea: document.querySelector("#authProviderArea"),
  authDivider: document.querySelector("#authDivider"),
  authEmailArea: document.querySelector("#authEmailArea"),
  authEmailInput: document.querySelector("#authEmailInput"),
  authSessionActions: document.querySelector("#authSessionActions"),
  authModalFooter: document.querySelector("#authModalFooter"),
  googleSignInBtn: document.querySelector("#googleSignInBtn"),
  signOutBtn: document.querySelector("#signOutBtn"),
  loginModalTitle: document.querySelector("#loginModalTitle"),
  marketForm: document.querySelector("#marketForm"),
  toast: document.querySelector("#toast"),
};

document.querySelector("#closeGroupModal").addEventListener("click", () => closeModal("group"));
document.querySelector("#cancelGroupModal").addEventListener("click", () => closeModal("group"));
document.querySelector("#closeJoinModal").addEventListener("click", () => closeModal("join"));
document.querySelector("#cancelJoinModal").addEventListener("click", () => closeModal("join"));
document.querySelector("#closeInviteModal").addEventListener("click", () => closeModal("invite"));
document.querySelector("#closeGeneralMarketModal").addEventListener("click", () => closeModal("generalMarket"));
document.querySelector("#closeEmbedModal").addEventListener("click", () => closeModal("embed"));
document.querySelector("#closeLeaderProfileModal").addEventListener("click", () => closeModal("leaderProfile"));
document.querySelector("#closeTradeHistoryModal").addEventListener("click", () => closeModal("tradeHistory"));
document.querySelector("#closeLoginModal").addEventListener("click", () => closeModal("login"));
document.querySelector("#closeMarketModal").addEventListener("click", () => closeModal("market"));
document.querySelector("#closeSuggestPreviewModal").addEventListener("click", () => closeModal("suggestPreview"));
document.querySelector("#dismissSuggestPreview").addEventListener("click", () => closeModal("suggestPreview"));
dom.suggestPreviewModalOverlay.addEventListener("click", e => { if (e.target === dom.suggestPreviewModalOverlay) closeModal("suggestPreview"); });
dom.groupModalOverlay.addEventListener("click", e => { if (e.target === dom.groupModalOverlay) closeModal("group"); });
dom.joinModalOverlay.addEventListener("click", e => { if (e.target === dom.joinModalOverlay) closeModal("join"); });
dom.inviteModalOverlay.addEventListener("click", e => { if (e.target === dom.inviteModalOverlay) closeModal("invite"); });
dom.generalMarketModalOverlay.addEventListener("click", e => { if (e.target === dom.generalMarketModalOverlay) closeModal("generalMarket"); });
dom.embedModalOverlay.addEventListener("click", e => { if (e.target === dom.embedModalOverlay) closeModal("embed"); });
dom.leaderProfileModalOverlay.addEventListener("click", e => { if (e.target === dom.leaderProfileModalOverlay) closeModal("leaderProfile"); });
dom.tradeHistoryModalOverlay.addEventListener("click", e => { if (e.target === dom.tradeHistoryModalOverlay) closeModal("tradeHistory"); });
dom.loginModalOverlay.addEventListener("click", e => { if (e.target === dom.loginModalOverlay) closeModal("login"); });
dom.marketModalOverlay.addEventListener("click", e => { if (e.target === dom.marketModalOverlay) closeModal("market"); });
dom.groupForm.addEventListener("submit", onCreateGroup);
dom.joinForm.addEventListener("submit", onJoinGroupSubmit);
dom.loginForm.addEventListener("submit", onLogin);
dom.googleSignInBtn.addEventListener("click", onGoogleSignIn);
dom.signOutBtn.addEventListener("click", onSignOut);
document.querySelector("#authSignUpBtn").addEventListener("click", () => dom.authNameInput?.focus());
dom.marketForm.addEventListener("submit", onCreateMarket);

document.addEventListener("click", onGlobalClick);
document.addEventListener("click", onTradeSubmitClickCapture, true);
document.addEventListener("click", onTradeAmountChipClick, true);
document.addEventListener("change", onGlobalChange);
document.addEventListener("input", onGlobalInput);
document.addEventListener("submit", onGlobalSubmit);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (state.demoMode) {
      exitDemo();
      return;
    }
    closeModal("group");
    closeModal("join");
    closeModal("invite");
    closeModal("generalMarket");
    closeModal("embed");
    closeModal("leaderProfile");
    closeModal("tradeHistory");
    closeModal("login");
    closeModal("market");
    closeModal("suggestPreview");
  }
});
window.addEventListener("popstate", () => {
  const route = routeFromLocation();
  applyRouteToState(route);
  if (route.name === "market" && state.loaded) openSharedMarket(route.marketId);
  if (route.name === "invite" && state.loaded) loadInvitePreview(route.token);
  normalizeSelection();
  render();
});

async function init() {
  const initialRoute = routeFromLocation();
  applyRouteToState(initialRoute, { replaceLegacy: true });

  try {
    const { data, error } = await withTimeout(supabase.auth.getSession(), AUTH_TIMEOUT_MS, "Sign-in check");
    if (error) throw error;
    applyAuthSession(data.session || restoreDevAuthSession(), { renderNow: false });
    const savedGroup = localStorage.getItem(STORAGE_KEYS.groupId);
    const savedShell = localStorage.getItem(STORAGE_KEYS.shell);
    const savedView = localStorage.getItem(STORAGE_KEYS.view);
    const savedWantsWelcome = savedShell === "welcome" && initialRoute.name === "welcome";
    if (state.authUser && savedGroup) state.currentGroupId = savedGroup;
    const isEmbedRoute = initialRoute.name === "embedMarket" || initialRoute.name === "embedEvent";
    if (state.authUser && !isEmbedRoute && !state.inviteToken && !savedWantsWelcome && (initialRoute.name === "app" || initialRoute.name === "leaderboard" || initialRoute.name === "admin" || initialRoute.name === "plPredictor" || savedShell === "app" || savedGroup || state.sharedMarketId)) {
      state.shell = "app";
      state.view = appViewFromRouteOrSaved(initialRoute, savedView);
      if (initialRoute.name === "welcome") {
        routeToCurrentAppView({ replace: true });
      }
    }
  } catch (err) {
    console.warn("Auth session unavailable", err);
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    const nextSession = session || restoreDevAuthSession();
    applyAuthSession(nextSession);
    runStoredPendingAuthAction();
  });

  const restoredFromCache = restoreBootCacheForRoute(initialRoute);
  if (restoredFromCache) {
    state.loaded = true;
    normalizeSelection();
  }
  render();
  loadMarketImages().catch(() => {});
  let keepInitialLoading = false;
  loadInitialAppData()
    .catch(err => {
      if (!restoredFromCache && isWakeTimeoutError(err)) {
        state.bootError = "";
        state.marketLinkError = "";
        keepInitialLoading = true;
        scheduleInitialLoadRetry();
        return;
      }
      if (restoredFromCache) {
        console.warn("Initial refresh deferred", err);
        return;
      }
      state.bootError = err.message || "Could not load groups.";
      toast(err.message || "Could not load groups.");
    })
    .finally(() => {
      if (!keepInitialLoading) state.loaded = true;
      render();
      if (!keepInitialLoading) {
        if (state.currentGroupId) loadQuestionSuggestions(state.currentGroupId);
        if (
          isLoggedIn() &&
          !state.bootError &&
          !state.groups.some(groupHasCurrentMember) &&
          !state.inviteToken &&
          !state.sharedMarketId &&
          !localStorage.getItem("probable_demo_done") &&
          !sessionStorage.getItem("probable_pending_auth_action")
        ) {
          enterDemo();
        }
        runStoredPendingAuthAction();
      }
    });
}

init();

async function loadInitialAppData() {
  state.bootError = "";
  state.marketLinkError = "";
  if (state.view === "bracket" && !state.sharedMarketId && !state.inviteToken) {
    loadBracketEntryIntoState();
    if (isLoggedIn() || state.sharedBracketEntryId) void loadRemoteBracketEntry({ refresh: true });
    return;
  }
  if (state.view === "plPredictor" && !state.sharedMarketId && !state.inviteToken) {
    loadPremierLeagueDraftIntoState();
    if (isLoggedIn() || state.plSharedEntryId) void loadRemotePremierLeagueEntry({ refresh: true });
    return;
  }
  if (state.sharedMarketId) {
    const data = await loadMarketContextForBoot(state.sharedMarketId);
    if (Array.isArray(data.groups)) {
      setGroups(data.groups);
    }
    if (data.group) {
      mergeFocusedGroupContext(data.group);
    } else if (!Array.isArray(data.groups)) {
      setGroups(data.groups);
    }
    openSharedMarket(state.sharedMarketId);
    if (isLoggedIn()) {
      try {
        const memberData = await loadGroupsForBoot();
        if (Array.isArray(memberData.groups)) setGroups(memberData.groups);
        openSharedMarket(state.sharedMarketId);
      } catch (err) {
        console.warn("Member groups refresh deferred", err);
      }
    }
    normalizeSelection();
    return;
  }
  const data = await loadGroupsForBoot();
  setGroups(data.groups);
  if (state.inviteToken) await loadInvitePreview(state.inviteToken);
  normalizeSelection();
  if (state.shell === "app" && !state.currentGroupId && state.groups.length && !state.sharedMarketId) {
    const savedGroup = localStorage.getItem(STORAGE_KEYS.groupId);
    const saved = state.groups.find(group => group.id === savedGroup && groupHasCurrentMember(group) && !isPbMyMarketsGroup(group));
    state.currentGroupId = saved?.id ?? firstSelectableGroup()?.id ?? null;
    normalizeSelection();
  }
  if (state.authUser && !state.inviteToken && !state.sharedMarketId && (state.currentGroupId || state.groups.length)) {
    state.shell = "app";
  }
}

async function loadGroupsForBoot() {
  const savedGroup = localStorage.getItem(STORAGE_KEYS.groupId);
  const include = savedGroup ? `&include=${encodeURIComponent(savedGroup)}` : "";
  const members = currentMemberAliases();
  const memberQuery = members.length ? `&members=${encodeURIComponent(members.join(","))}` : "";
  const path = `/api/groups?compact=1&limit=50${include}${memberQuery}`;
  try {
    return await api(path, { timeoutMs: BOOT_API_TIMEOUT_MS });
  } catch (err) {
    if (!/timed out/i.test(err?.message || "")) throw err;
    throw new Error("Still waking the server. Showing the last saved view if available.");
  }
}

async function loadMarketContextForBoot(marketId) {
  const path = `/api/markets/${encodeURIComponent(marketId)}/context`;
  try {
    return await api(path, { timeoutMs: BOOT_API_TIMEOUT_MS });
  } catch (err) {
    if (!/timed out/i.test(err?.message || "")) throw err;
    throw new Error("Still waking the server. Showing the last saved view if available.");
  }
}

async function refreshFocusedMarketContext(marketId) {
  if (!marketId) return false;
  const data = await api(`/api/markets/${encodeURIComponent(marketId)}/context`, { timeoutMs: API_TIMEOUT_MS });
  if (Array.isArray(data.groups)) setGroups(data.groups);
  if (data.group) mergeFocusedGroupContext(data.group);
  return Boolean(data.group || data.groups);
}

function isWakeTimeoutError(err) {
  return /timed out|still waking|connection timed out|waking the server/i.test(err?.message || "");
}

function scheduleInitialLoadRetry() {
  if (bootRetryTimer) window.clearTimeout(bootRetryTimer);
  bootRetryTimer = window.setTimeout(() => {
    bootRetryTimer = null;
    void retryInitialLoad({ auto: true });
  }, 1800);
}

async function retryInitialLoad({ auto = false } = {}) {
  state.loaded = false;
  state.bootError = "";
  state.marketLinkError = "";
  render();
  loadMarketImages().catch(() => {});
  let keepLoading = false;
  try {
    await loadInitialAppData();
  } catch (err) {
    if (isWakeTimeoutError(err)) {
      keepLoading = true;
      scheduleInitialLoadRetry();
      return;
    }
    state.bootError = err.message || "Could not load groups.";
    if (!auto) toast(state.bootError);
  } finally {
    if (!keepLoading) state.loaded = true;
    render();
    if (!keepLoading) runStoredPendingAuthAction();
  }
}

function routeFromLocation() {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean).map(part => decodeURIComponent(part));

  if (parts[0] === "invite" && parts[1]) return { name: "invite", token: parts[1] };
  if (parts[0] === "embed" && parts[1] === "market" && parts[2]) return { name: "embedMarket", marketId: parts[2], options: embedOptionsFromSearch(url.searchParams) };
  if (parts[0] === "embed" && parts[1] === "event" && parts[2]) return { name: "embedEvent", eventId: parts[2], options: embedOptionsFromSearch(url.searchParams) };
  if (parts[0] === "market" && parts[1]) return { name: "market", marketId: sanitizeRouteMarketId(parts.slice(1).join("/")) };
  if (parts[0] === "leaderboard") return { name: "leaderboard" };
  if (parts[0] === "admin") return { name: "admin" };
  if (parts[0] === "portfolio") return { name: "positions" };
  if (parts[0] === "positions") return { name: "positions", legacyPath: "/portfolio" };
  const leaguePredictor = LEAGUE_PREDICTOR_LIST.find(predictor => predictor.route === path);
  if (leaguePredictor) return {
    name: "plPredictor",
    predictorId: leaguePredictor.id,
    entry: url.searchParams.get("entry") || "",
    participant: url.searchParams.get("participant") || "",
  };
  if (parts[0] === "b" && parts[1]) return {
    name: "bracket",
    entry: parts[1],
    legacyPath: `/bracket?entry=${encodeURIComponent(parts[1])}`,
  };
  if (parts[0] === "bracket") return {
    name: "bracket",
    entry: url.searchParams.get("entry") || "",
    participant: url.searchParams.get("participant") || "",
  };
  if (parts[0] === "app") return { name: "app" };

  const legacyInvite = url.searchParams.get("invite");
  const legacyMarket = url.searchParams.get("market");
  const legacyJoin = url.searchParams.get("join");
  if (legacyInvite) return { name: "invite", token: legacyInvite, legacyPath: `/invite/${encodeURIComponent(legacyInvite)}` };
  if (legacyMarket) {
    const marketId = sanitizeRouteMarketId(legacyMarket);
    return { name: "market", marketId, legacyPath: `/market/${encodeURIComponent(marketId)}` };
  }
  if (legacyJoin) return { name: "welcome", joinPreFill: legacyJoin, legacyPath: "/" };
  return { name: "welcome" };
}

function sanitizeRouteMarketId(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.split(/[?#]/)[0];
  value = value.replace(/https?:.*$/i, "");
  value = value.replace(/^market\//i, "");
  value = value.replace(/\/+$/g, "");
  const match = value.match(/[A-Za-z0-9][A-Za-z0-9_-]{5,80}/);
  return match ? match[0] : value;
}

function embedOptionsFromSearch(params) {
  return {
    chart: params.get("chart") !== "0",
    buttons: params.get("buttons") !== "0",
    dark: params.get("dark") !== "0",
    border: params.get("border") !== "0",
  };
}

function shouldHoldAppShell() {
  const route = routeFromLocation();
  return (
    route.name === "app" ||
    route.name === "leaderboard" ||
    route.name === "admin" ||
    route.name === "positions" ||
    route.name === "bracket" ||
    route.name === "plPredictor" ||
    route.name === "market" ||
    route.name === "embedMarket" ||
    route.name === "embedEvent" ||
    localStorage.getItem(STORAGE_KEYS.shell) === "app" ||
    Boolean(localStorage.getItem(STORAGE_KEYS.groupId))
  );
}

function applyRouteToState(route, { replaceLegacy = false } = {}) {
  state.inviteToken = null;
  state.invitePreview = null;
  state.inviteError = "";
  state.sharedMarketId = null;
  state.sharedBracketEntryId = "";
  state.plSharedEntryId = "";
  state.joinPreFill = null;
  state.embedRoute = null;

  if (route.name === "invite") {
    state.inviteToken = route.token;
    state.shell = "invite";
    state.view = "dashboard";
    state.trade = emptyTrade();
  } else if (route.name === "market") {
    state.sharedMarketId = route.marketId;
    state.shell = "app";
    state.view = "dashboard";
  } else if (route.name === "embedMarket") {
    state.embedRoute = { type: "market", id: route.marketId, options: route.options || embedOptionsFromSearch(new URL(location.href).searchParams) };
    state.shell = "embed";
    state.view = "dashboard";
    state.trade = emptyTrade();
  } else if (route.name === "embedEvent") {
    state.embedRoute = { type: "event", id: route.eventId, options: route.options || embedOptionsFromSearch(new URL(location.href).searchParams) };
    state.shell = "embed";
    state.view = "dashboard";
    state.trade = emptyTrade();
  } else if (route.name === "leaderboard") {
    state.shell = "app";
    state.view = "leaderboard";
    state.trade = emptyTrade();
  } else if (route.name === "admin") {
    state.shell = "app";
    state.view = "admin";
    state.trade = emptyTrade();
  } else if (route.name === "positions") {
    state.shell = "app";
    state.view = "positions";
    state.trade = emptyTrade();
  } else if (route.name === "bracket") {
    state.shell = "app";
    state.view = "bracket";
    state.trade = emptyTrade();
    state.sharedBracketEntryId = route.entry || "";
  } else if (route.name === "plPredictor") {
    const nextPredictorId = LEAGUE_PREDICTORS[route.predictorId] ? route.predictorId : DEFAULT_PREDICTOR_ID;
    if (state.activePredictorId !== nextPredictorId) {
      state.plRanking = [];
      state.plEntryId = "";
      state.plSubmitted = false;
      state.plRemoteLoaded = false;
    }
    state.shell = "app";
    state.view = "plPredictor";
    state.trade = emptyTrade();
    state.activePredictorId = nextPredictorId;
    state.plSharedEntryId = route.entry || "";
  } else if (route.name === "app") {
    state.shell = "app";
    state.view = "dashboard";
    state.trade = emptyTrade();
  } else {
    state.joinPreFill = route.joinPreFill || null;
    enterWelcomeShell({ updateUrl: false });
  }

  if (replaceLegacy && route.legacyPath) {
    history.replaceState(null, "", route.legacyPath);
  }
}

function navigateTo(path, { replace = false } = {}) {
  const target = path || "/";
  if (`${location.pathname}${location.search}${location.hash}` !== target) {
    history[replace ? "replaceState" : "pushState"](null, "", target);
  }
}

function routeToWelcome({ replace = false } = {}) {
  navigateTo("/", { replace });
}

function routeToApp({ replace = false } = {}) {
  navigateTo("/app", { replace });
}

function routeToLeaderboard({ replace = false } = {}) {
  navigateTo("/leaderboard", { replace });
}

function routeToAdmin({ replace = false } = {}) {
  navigateTo("/admin", { replace });
}

function routeToPositions({ replace = false } = {}) {
  navigateTo("/portfolio", { replace });
}

function routeToBracket({ replace = false } = {}) {
  navigateTo("/bracket", { replace });
}

function routeToPremierLeaguePredictor({ replace = false } = {}) {
  navigateTo(activeLeaguePredictor().route, { replace });
}

function routeToMarket(marketId, { replace = false } = {}) {
  if (state.demoMode) {
    // The demo market only exists in client-side state, so it can never be
    // resolved as a shared-market link. Keep the URL at /app instead of
    // leaking a demo-* id into the address bar (breaks on refresh/share).
    routeToApp({ replace });
    return;
  }
  navigateTo(`/market/${encodeURIComponent(marketId)}`, { replace });
}

function appViewFromRouteOrSaved(route, savedView = "dashboard") {
  if (route.name === "leaderboard") return "leaderboard";
  if (route.name === "admin") return "admin";
  if (route.name === "positions") return "positions";
  if (route.name === "bracket") return "bracket";
  if (route.name === "plPredictor") return "plPredictor";
  if (savedView === "leaderboard") return "leaderboard";
  if (savedView === "admin") return "admin";
  if (savedView === "positions") return "positions";
  if (savedView === "bracket") return "bracket";
  if (savedView === "plPredictor") return "plPredictor";
  return "dashboard";
}

function routeToCurrentAppView({ replace = false } = {}) {
  if (state.view === "leaderboard") return routeToLeaderboard({ replace });
  if (state.view === "admin") return routeToAdmin({ replace });
  if (state.view === "positions") return routeToPositions({ replace });
  if (state.view === "bracket") return routeToBracket({ replace });
  if (state.view === "plPredictor") return routeToPremierLeaguePredictor({ replace });
  return routeToApp({ replace });
}

async function loadMarketImages() {
  try {
    const res = await fetchWithTimeout("/market-images/manifest.json", { cache: "no-cache", timeoutMs: 6000 });
    if (!res.ok) return;
    const data = await res.json();
    state.marketImages = Array.isArray(data.images) ? data.images.filter(image => image?.src) : [];
  } catch {
    state.marketImages = [];
  }
}

function onKeyDown(e) {
  if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-open-leaderboard]")) {
    e.preventDefault();
    state.shell = "app";
    state.view = "leaderboard";
    routeToLeaderboard();
    render();
  }
}

async function onGlobalClick(e) {
  const openPositionsBtn = e.target.closest("[data-open-positions]");
  if (openPositionsBtn) {
    e.preventDefault();
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
    state.accountMenuOpen = false;
    state.shell = "app";
    state.view = "positions";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    routeToPositions();
    normalizeSelection();
    render();
    return;
  }

  const openAdminBtn = e.target.closest("[data-open-admin]");
  if (openAdminBtn) {
    e.preventDefault();
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
    state.accountMenuOpen = false;
    state.shell = "app";
    state.view = "admin";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    routeToAdmin();
    normalizeSelection();
    render();
    return;
  }

  if (e.target.closest("[data-demo-replay]")) {
    state.accountMenuOpen = false;
    enterDemo();
    return;
  }

  const accountSignOut = e.target.closest("[data-account-signout]");
  if (accountSignOut) {
    e.preventDefault();
    await onSignOut();
    return;
  }

  const accountToggle = e.target.closest("[data-account-toggle]");
  if (accountToggle) {
    e.preventDefault();
    state.accountMenuOpen = !state.accountMenuOpen;
    renderAccountMenuOnly();
    return;
  }

  const accountWasOpen = state.accountMenuOpen;
  if (!e.target.closest("[data-account-menu]")) state.accountMenuOpen = false;


  const leaderboardModeBtn = e.target.closest("[data-leaderboard-mode]");
  if (leaderboardModeBtn) {
    state.leaderboardMode = leaderboardModeBtn.dataset.leaderboardMode || "chart";
    refreshLeaderboardComponent();
    return;
  }

  const leaderboardMetricBtn = e.target.closest("[data-leaderboard-metric]");
  if (leaderboardMetricBtn) {
    state.leaderboardMetric = leaderboardMetricBtn.dataset.leaderboardMetric || "nominal";
    refreshLeaderboardComponent();
    return;
  }

  const portfolioMetricBtn = e.target.closest("[data-portfolio-chart-metric]");
  if (portfolioMetricBtn) {
    state.portfolioChartMetric = portfolioMetricBtn.dataset.portfolioChartMetric === "cashout" ? "cashout" : "mark";
    refreshPortfolioChartComponent();
    return;
  }

  const portfolioRangeBtn = e.target.closest("[data-portfolio-chart-range]");
  if (portfolioRangeBtn) {
    state.portfolioChartRange = ["7d", "30d", "all"].includes(portfolioRangeBtn.dataset.portfolioChartRange) ? portfolioRangeBtn.dataset.portfolioChartRange : "all";
    refreshPortfolioChartComponent();
    return;
  }

  const marketStatusBtn = e.target.closest("[data-market-status-filter]");
  if (marketStatusBtn) {
    state.marketStatus = marketStatusBtn.dataset.marketStatusFilter || "open";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    state.expandedEventKey = null;
    routeToApp();
    render();
    return;
  }

  const leaderProfileBtn = e.target.closest("[data-leader-profile]");
  if (leaderProfileBtn) {
    e.preventDefault();
    e.stopPropagation();
    openLeaderProfile(leaderProfileBtn.dataset.leaderProfile || "");
    return;
  }

  const viewAllTradesBtn = e.target.closest("[data-view-all-trades]");
  if (viewAllTradesBtn) {
    e.preventDefault();
    e.stopPropagation();
    openTradeHistoryModal(viewAllTradesBtn.dataset.viewAllTrades || "");
    return;
  }

  const tradeHistorySortBtn = e.target.closest("[data-trade-history-sort]");
  if (tradeHistorySortBtn) {
    state.tradeHistoryModal.sort = tradeHistorySortBtn.dataset.tradeHistorySort === "largest" ? "largest" : "recent";
    renderTradeHistoryModal();
    return;
  }

  const expandParticipantsBtn = e.target.closest("[data-expand-participants]");
  if (expandParticipantsBtn) {
    const key = expandParticipantsBtn.dataset.expandParticipants;
    if (state.expandedParticipants.has(key)) {
      state.expandedParticipants.delete(key);
    } else {
      state.expandedParticipants.add(key);
    }
    render();
    return;
  }

  const expandOutcomesBtn = e.target.closest("[data-toggle-focused-outcomes]");
  if (expandOutcomesBtn) {
    const key = expandOutcomesBtn.dataset.toggleFocusedOutcomes;
    if (state.expandedOutcomeEvents.has(key)) {
      state.expandedOutcomeEvents.delete(key);
    } else {
      state.expandedOutcomeEvents.add(key);
    }
    render();
    return;
  }

  if (e.target.closest("[data-open-leaderboard]")) {
    state.shell = "app";
    state.view = "leaderboard";
    routeToLeaderboard();
    render();
    return;
  }

  const emojiBtn = e.target.closest("[data-emoji-option]");
  if (emojiBtn) {
    selectGroupEmoji(emojiBtn);
    return;
  }

  if (e.target.closest("[data-go-welcome]")) {
    if (state.demoMode) exitDemo();
    enterWelcomeShell();
    render();
    return;
  }

  if (e.target.closest("[data-go-dashboard]")) {
    state.shell = "app";
    state.view = "dashboard";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    state.bootError = "";
    state.marketLinkError = "";
    routeToApp();
    render();
    return;
  }

  if (e.target.closest("[data-go-bracket]")) {
    state.shell = "app";
    state.view = "bracket";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    state.bracketView = "grid";
    loadBracketEntryIntoState();
    void loadRemoteBracketEntry({ refresh: true });
    routeToBracket();
    render();
    return;
  }

  const leaguePredictorButton = e.target.closest("[data-go-league-predictor], [data-go-pl-predictor]");
  if (leaguePredictorButton) {
    const predictorId = leaguePredictorButton.dataset.goLeaguePredictor || DEFAULT_PREDICTOR_ID;
    if (state.activePredictorId !== predictorId) {
      state.activePredictorId = LEAGUE_PREDICTORS[predictorId] ? predictorId : DEFAULT_PREDICTOR_ID;
      state.plRanking = [];
      state.plEntryId = "";
      state.plSubmitted = false;
      state.plRemoteLoaded = false;
      state.plSharedEntryId = "";
    }
    state.shell = "app";
    state.view = "plPredictor";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    loadPremierLeagueDraftIntoState();
    void loadRemotePremierLeagueEntry({ refresh: true });
    routeToPremierLeaguePredictor();
    render();
    return;
  }

  const plClubPick = e.target.closest("[data-pl-club-pick]");
  if (plClubPick) {
    e.preventDefault();
    selectPremierLeagueClub(plClubPick.dataset.plClubPick);
    renderPremierLeaguePredictor();
    return;
  }

  const plClearPick = e.target.closest("[data-pl-clear-position]");
  if (plClearPick) {
    e.preventDefault();
    clearPremierLeaguePosition(Number(plClearPick.dataset.plClearPosition));
    renderPremierLeaguePredictor();
    return;
  }

  if (e.target.closest("[data-pl-undo]")) {
    e.preventDefault();
    undoPremierLeaguePick();
    renderPremierLeaguePredictor();
    return;
  }

  if (e.target.closest("[data-pl-reset]")) {
    e.preventDefault();
    if (premierLeaguePredictorLocked()) {
      toast("Predictor is locked.");
      return;
    }
    state.plRanking = [];
    state.plSubmitted = false;
    savePremierLeagueDraft();
    renderPremierLeaguePredictor();
    toast("Draft reset.");
    return;
  }

  if (e.target.closest("[data-pl-submit]")) {
    e.preventDefault();
    await submitPremierLeagueEntry();
    return;
  }

  if (e.target.closest("[data-share-pl-predictor]")) {
    e.preventDefault();
    await openPremierLeagueShareModal();
    return;
  }

  const bracketViewBtn = e.target.closest("[data-bracket-view]");
  if (bracketViewBtn) {
    e.preventDefault();
    state.bracketView = bracketViewBtn.dataset.bracketView === "table" ? "table" : "grid";
    refreshBracketChallenge();
    return;
  }

  const bracketPickBtn = e.target.closest("[data-bracket-pick]");
  if (bracketPickBtn) {
    e.preventDefault();
    const matchupId = bracketPickBtn.dataset.bracketPick;
    const team = bracketPickBtn.dataset.team;
    pickBracketTeam(matchupId, team);
    refreshBracketChallenge();
    return;
  }

  const bracketNavBtn = e.target.closest("[data-bracket-round-nav]");
  if (bracketNavBtn) {
    e.preventDefault();
    moveBracketRound(Number(bracketNavBtn.dataset.bracketRoundNav || 0));
    refreshBracketChallenge();
    return;
  }

  if (e.target.closest("[data-reset-bracket]")) {
    e.preventDefault();
    if (state.bracketSubmitted) {
      toast("Submitted brackets are locked.");
      return;
    }
    state.bracketPicks = {};
    state.bracketSubmitted = false;
    state.bracketLastPickedId = "";
    state.bracketRoundIndex = 0;
    void saveBracketEntry({ submitted: false, silent: true }).catch(() => {});
    refreshBracketChallenge();
    toast("Bracket reset.");
    return;
  }

  if (e.target.closest("[data-submit-bracket]")) {
    void submitBracketEntry();
    return;
  }

  if (e.target.closest("[data-share-bracket]")) {
    e.preventDefault();
    await openBracketShareModal();
    return;
  }

  if (e.target.closest("[data-retry-initial-load]")) {
    await retryInitialLoad();
    return;
  }

  if (e.target.closest("[data-enter-app]")) {
    if (!isLoggedIn()) {
      requireLogin("enter-app");
      return;
    }
    try {
      if (!getCurrentGroup()) {
        try {
          const data = await loadGroupsForBoot();
          if (Array.isArray(data.groups)) setGroups(data.groups);
          normalizeSelection();
        } catch (err) {
          console.warn("Enter app group refresh deferred", err);
        }
      }
      if (!getCurrentGroup()) {
        await ensureMarketGroup();
      }
      state.shell = "app";
      state.view = "dashboard";
      state.welcomeMode = "actions";
      state.trade = emptyTrade();
      state.bootError = "";
      state.marketLinkError = "";
      routeToApp();
      normalizeSelection();
      render();
    } catch (err) {
      state.shell = "app";
      state.loaded = true;
      state.bootError = err.message || "Could not enter the app.";
      toast(state.bootError);
      render();
    }
    return;
  }

  const groupBtn = e.target.closest("[data-group-id]");
  if (groupBtn) {
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
    const gid = groupBtn.dataset.groupId;
    if (gid === "__new") {
      if (requireLogin("add-menu")) openGeneralMarketStartModal();
      return;
    }
    if (gid === "__leaderboard") {
      state.shell = "app";
      state.view = state.view === "leaderboard" ? "dashboard" : "leaderboard";
      state.view === "leaderboard" ? routeToLeaderboard() : routeToApp();
      render();
      return;
    }
    state.currentGroupId = gid;
    state.shell = "app";
    state.view = "dashboard";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    localStorage.setItem("probable_groupId", gid);
    routeToApp();
    normalizeSelection();
    render();
    loadQuestionSuggestions(gid);
    return;
  }

  if (e.target.closest("[data-try-demo]")) {
    enterDemo();
    return;
  }

  if (e.target.closest("[data-create-market-welcome]")) {
    state.welcomeMode = "create";
    render();
    return;
  }

  if (e.target.closest("[data-create-group]")) {
    if (!requireLogin("create-group")) return;
    closeModal("generalMarket");
    openModal("group");
    return;
  }

  if (e.target.closest("[data-show-general-market-pool]")) {
    if (!requireLogin("general-pool")) return;
    renderGeneralMarketPoolModal();
    return;
  }

  if (e.target.closest("[data-add-menu-back]")) {
    renderGeneralMarketStartModal();
    return;
  }

  const addGeneralMarketBtn = e.target.closest("[data-add-general-market]");
  if (addGeneralMarketBtn) {
    const group = getCurrentGroup();
    if (!group) {
      toast("Create or join a group first.");
      return;
    }
    const item = GENERAL_MARKET_POOL.find(candidate => candidate.id === addGeneralMarketBtn.dataset.addGeneralMarket);
    if (!item) return;
    addGeneralMarketToGroup(group.id, item.id);
    renderGeneralMarketPoolModal();
    render();
    toast(`${item.title} added to ${group.name}.`);
    return;
  }

  if (e.target.closest("[data-login]")) {
    openModal("login");
    return;
  }

  if (e.target.closest("[data-join-group]")) {
    if (!getCurrentGroup()) {
      state.welcomeMode = "join";
      render();
      return;
    }
    openModal("join");
    return;
  }

  if (e.target.closest("[data-welcome-back]")) {
    state.welcomeMode = "actions";
    render();
    return;
  }

  if (e.target.closest("[data-refresh-suggestions]")) {
    const group = getCurrentGroup();
    if (!group) return;
    state.questionSuggestions = [];
    state.questionSuggestionsGroupId = null;
    loadQuestionSuggestions(group.id);
    return;
  }

  if (e.target.closest("[data-form-suggestion]")) {
    const btn = e.target.closest("[data-form-suggestion]");
    const idx = parseInt(btn.dataset.formSuggestionIndex, 10);
    const question = state.questionSuggestions[idx];
    if (!question) return;
    const qInput = dom.marketForm?.querySelector("[name=question]");
    if (qInput) {
      qInput.value = question;
      qInput.dispatchEvent(new Event("input", { bubbles: true }));
      qInput.focus();
    }
    updateFormSuggestChips();
    return;
  }

  if (e.target.closest("[data-suggestion-chip]")) {
    const btn = e.target.closest("[data-suggestion-chip]");
    const idx = parseInt(btn.dataset.suggestionIndex, 10);
    const question = state.questionSuggestions[idx];
    if (!question) return;
    const group = getCurrentGroup();
    if (!group) return;
    state.pendingUi.suggestionPreview = { question, rules: null, loading: true };
    render();
    openModal("suggestPreview");
    // Fetch AI rules draft for the preview
    api(`/api/markets/rules/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        brief: question,
        outcomes: ["Yes", "No"],
        oracleType: "ai",
      }),
    })
      .then(data => {
        if (data) {
          state.pendingUi.suggestionPreview = { question, rules: data.draft?.description || "", loading: false };
        } else {
          state.pendingUi.suggestionPreview = { question, rules: "", loading: false };
        }
        render();
      })
      .catch(() => {
        state.pendingUi.suggestionPreview = { question, rules: "", loading: false };
        render();
      });
    return;
  }

  if (e.target.closest("#createFromSuggestion")) {
    if (!requireLogin("create-market")) return;
    const preview = state.pendingUi.suggestionPreview;
    if (!preview) return;
    closeModal("suggestPreview");
    await ensureMarketGroup();
    setMarketMinDate();
    openModal("market");
    const qInput = dom.marketForm?.querySelector("[name=question]");
    if (qInput) {
      qInput.value = preview.question;
      qInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (preview.rules) {
      const descInput = dom.marketForm?.querySelector("[name=description]");
      if (descInput) {
        descInput.value = preview.rules;
        descInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }

  if (e.target.closest("[data-new-market]")) {
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
    if (!requireLogin("create-market")) return;
    closeModal("generalMarket");
    await ensureMarketGroup();
    setMarketMinDate();
    openModal("market");
    return;
  }

  const enterGroupBtn = e.target.closest("[data-enter-group]");
  if (enterGroupBtn) {
    state.currentGroupId = enterGroupBtn.dataset.enterGroup;
    state.shell = "app";
    state.view = "dashboard";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    localStorage.setItem("probable_groupId", state.currentGroupId);
    routeToApp();
    normalizeSelection();
    render();
    return;
  }

  const inviteBtn = e.target.closest("[data-open-invite]");
  if (inviteBtn) {
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
    await openInviteModal(inviteBtn.dataset.openInvite);
    return;
  }

  if (e.target.closest("[data-copy-invite-link]")) {
    copyInviteLink();
    return;
  }

  if (e.target.closest("[data-native-share-invite]")) {
    shareInviteLink();
    return;
  }

  const marketShareBtn = e.target.closest("[data-share-market]");
  if (marketShareBtn) {
    if (state.demoMode) {
      toast("Finish or skip the demo first.");
      return;
    }
    openMarketEmbedModal(marketShareBtn.dataset.shareMarket);
    await copyMarketLink(marketShareBtn.dataset.shareMarket);
    return;
  }

  if (e.target.closest("[data-copy-market-link]")) {
    await copyMarketLink();
    return;
  }

  if (e.target.closest("[data-native-share-market]")) {
    await nativeShareMarket();
    return;
  }

  if (e.target.closest("[data-copy-bracket-link]")) {
    await copyBracketLink();
    return;
  }

  if (e.target.closest("[data-native-share-bracket]")) {
    await shareBracketLink();
    return;
  }

  if (e.target.closest("[data-copy-pl-link]")) {
    await copyPremierLeagueLink();
    return;
  }

  if (e.target.closest("[data-native-share-pl]")) {
    await sharePremierLeagueLink();
    return;
  }

  if (e.target.closest("[data-copy-embed-code]")) {
    await copyMarketEmbedCode();
    return;
  }

  const embedOption = e.target.closest("[data-embed-option]");
  if (embedOption) {
    state.embedModal[embedOption.dataset.embedOption] = Boolean(embedOption.checked);
    renderMarketEmbedModal();
    return;
  }

  if (e.target.closest("[data-regenerate-invite]")) {
    if (!state.inviteModal.confirmRegenerate) {
      state.inviteModal.confirmRegenerate = true;
      renderInviteModal();
      return;
    }
    await regenerateInviteLink();
    return;
  }

  if (e.target.closest("[data-cancel-regenerate-invite]")) {
    state.inviteModal.confirmRegenerate = false;
    renderInviteModal();
    return;
  }

  if (e.target.closest("[data-join-invite]")) {
    await joinCurrentInvite();
    return;
  }

  const marketTypeBtn = e.target.closest("[data-market-type]");
  if (marketTypeBtn) {
    setMarketType(marketTypeBtn.dataset.marketType || "binary");
    return;
  }

  if (e.target.closest("[data-generate-market-odds]")) {
    await generateMarketOddsSeed();
    return;
  }

  if (e.target.closest("[data-market-step-next]")) {
    await goMarketFormStep(state.marketFormStep + 1);
    return;
  }

  if (e.target.closest("[data-market-step-back]")) {
    await goMarketFormStep(state.marketFormStep - 1);
    return;
  }

  const buyBtn = e.target.closest("[data-buy]");
  if (buyBtn) {
    const card = buyBtn.closest("[data-market-id]");
    if (!card) return;
    const mid = card.dataset.marketId;
    const side = buyBtn.dataset.buy;
    const eventCard = buyBtn.closest("[data-event-key]");
    if (eventCard) state.expandedEventKey = eventCard.dataset.eventKey;
    const inTradePanel = Boolean(buyBtn.closest(".trade-panel"));
    const inFocusedTrade = Boolean(buyBtn.closest(".focused-market-shell"));
    if (state.sharedMarketId && !inTradePanel) {
      state.sharedMarketId = mid;
      state.trade = { marketId: mid, side, mode: state.trade.mode || "buy" };
      state.mobileTradeOpen = true;
      routeToMarket(mid);
      if (!isLoggedIn()) {
        storePendingSharedTrade(mid, side, state.trade.mode);
        requireLogin("trade-shared-market");
        render();
        return;
      }
      const group = findGroupForMarket(mid);
      if (group && !groupHasCurrentMember(group)) {
        await joinSharedMarketAndOpen(mid, side, state.trade.mode);
        return;
      }
    }
    if ((inTradePanel || inFocusedTrade) && state.trade.marketId === mid) {
      setTradeSide(mid, side);
      if (inFocusedTrade) {
        state.mobileTradeOpen = true;
        render();
      }
      return;
    }
    const nextTrade = state.trade.marketId === mid && state.trade.side === side
      ? ((inTradePanel || inFocusedTrade) ? state.trade : emptyTrade())
      : { marketId: mid, side, mode: state.trade.mode || "buy" };
    state.trade = nextTrade;
    if (inFocusedTrade && state.trade.marketId) state.mobileTradeOpen = true;
    state.trade.marketId ? routeToMarket(state.trade.marketId) : routeToApp();
    render();
    requestAnimationFrame(() => window.scrollTo(0, 0));
    return;
  }

  const eventOpenBtn = e.target.closest("[data-event-open]");
  if (eventOpenBtn) {
    toggleEventCard(eventOpenBtn.dataset.eventOpen);
    return;
  }

  const tradeModeBtn = e.target.closest("[data-trade-mode]");
  if (tradeModeBtn) {
    const panel = tradeModeBtn.closest("[data-market-id]");
    const market = findMarket(panel?.dataset.marketId);
    if (market) setTradeMode(market.id, tradeModeBtn.dataset.tradeMode);
    return;
  }

  if (e.target.closest("[data-close-trade]")) {
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    state.expandedEventKey = null;
    state.mobileTradeOpen = false;
    routeToApp();
    render();
    return;
  }

  if (e.target.closest("[data-mobile-trade-toggle]")) {
    state.mobileTradeOpen = true;
    render();
    return;
  }

  if (e.target.closest("[data-mobile-trade-close]")) {
    state.mobileTradeOpen = false;
    render();
    return;
  }

  const fillAmountBtn = e.target.closest("[data-fill-amount], [data-fill-percent]");
  if (fillAmountBtn) {
    handleTradeAmountFill(fillAmountBtn);
    return;
  }

  const resolveBtn = e.target.closest("[data-resolve]");
  if (resolveBtn) {
    const container = resolveBtn.closest("[data-market-id]");
    const market = findMarket(container?.dataset.marketId);
    const reasoning = container?.querySelector("[data-resolution-reasoning]")?.value?.trim() || "";
    if (market) onResolve(market, resolveBtn.dataset.resolve, { reasoning, button: resolveBtn });
    return;
  }

  const eliminateBtn = e.target.closest("[data-eliminate-outcome]");
  if (eliminateBtn) {
    const container = eliminateBtn.closest("[data-market-id]");
    const market = findMarket(container?.dataset.marketId);
    const reasoning = container?.querySelector("[data-resolution-reasoning]")?.value?.trim() || "";
    if (market) onEliminateOutcome(market, eliminateBtn.dataset.eliminateOutcome, { reasoning, button: eliminateBtn });
    return;
  }

  const oracleBtn = e.target.closest("[data-oracle-trigger]");
  if (oracleBtn) {
    const market = findMarket(oracleBtn.closest("[data-market-id]")?.dataset.marketId);
    if (market) onOracleTrigger(market);
    return;
  }

  const acceptBtn = e.target.closest("[data-oracle-accept]");
  if (acceptBtn) {
    const market = findMarket(acceptBtn.closest("[data-market-id]")?.dataset.marketId);
    if (market) onOracleAccept(market);
    return;
  }

  const disputeBtn = e.target.closest("[data-oracle-dispute]");
  if (disputeBtn) {
    const market = findMarket(disputeBtn.closest("[data-market-id]")?.dataset.marketId);
    if (market) onOracleDispute(market);
    return;
  }

  const voteBtn = e.target.closest("[data-oracle-vote]");
  if (voteBtn) {
    const market = findMarket(voteBtn.closest("[data-market-id]")?.dataset.marketId);
    if (market) onOracleVote(market, voteBtn.dataset.oracleVote);
    return;
  }

  const eventCard = e.target.closest("[data-event-key]");
  if (eventCard && !e.target.closest("button, input, textarea, select, .trade-panel, .oracle-proposal, .card-trades")) {
    openEventTrade(eventCard.dataset.eventKey);
    return;
  }

  if (accountWasOpen && !state.accountMenuOpen) renderAccountMenuOnly();
}

function toggleEventCard(key) {
  state.expandedEventKey = state.expandedEventKey === key ? null : key;
  if (state.expandedEventKey !== key) state.trade = emptyTrade();
  render();
}

function openEventTrade(key) {
  const group = getCurrentGroup();
  const event = group ? marketEvents(group.markets).find(item => item.key === key) : null;
  if (!event) return;
  const market = event.markets.find(item => item.status === "open") ?? event.markets[0];
  if (!market) return;
  state.expandedEventKey = null;
  state.trade = { marketId: market.id, side: "yes", mode: "buy" };
  state.sharedMarketId = null;
  routeToMarket(market.id);
  render();
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function openSharedMarket(marketId) {
  const group = findGroupForMarket(marketId);
  const market = findMarketForRoute(marketId, group);
  if (!group || !market) {
    state.marketLinkError = "That market link could not be found.";
    if (state.loaded) toast(state.marketLinkError);
    return false;
  }
  state.currentGroupId = group.id;
  state.shell = "app";
  state.view = "dashboard";
  state.trade = { marketId: market.id, side: "yes", mode: "buy" };
  state.sharedMarketId = market.id;
  state.bootError = "";
  state.marketLinkError = "";
  state.expandedEventKey = null;
  if (isLoggedIn()) localStorage.setItem("probable_groupId", group.id);
  return true;
}

function findMarketForRoute(marketId, group = null) {
  if (!marketId) return null;
  const markets = group?.markets ?? state.groups.flatMap(g => g.markets ?? []);
  return markets.find(item => item.id === marketId) ||
    markets.find(item => item.eventId === marketId) ||
    markets.find(item => item.outcomeId === marketId) ||
    markets.find(item => (item.outcomes ?? []).some(outcome => outcome.id === marketId)) ||
    null;
}

function selectGroupEmoji(button) {
  const form = button.closest("#groupForm");
  if (!form) return;
  const value = button.dataset.emojiOption || "⚽";
  const input = form.querySelector("[name=emoji]");
  if (input) input.value = value;
  form.querySelectorAll("[data-emoji-option]").forEach(option => {
    const active = option === button;
    option.classList.toggle("active", active);
    option.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function resetGroupEmoji(form = dom.groupForm) {
  const defaultButton = form?.querySelector('[data-emoji-option="⚽"]');
  if (defaultButton) selectGroupEmoji(defaultButton);
}

function onGlobalInput(e) {
  if (e.target.classList.contains("trade-input")) {
    clearTradeInputRawAmount(e.target);
    const market = findMarket(e.target.closest("[data-market-id]")?.dataset.marketId);
    if (market) renderTradePreview(market, tradeInputAmount(e.target) || 0);
    return;
  }
  if (e.target.matches("#marketForm [name=outcomes]")) {
    resetMarketOddsSeed();
    updateOutcomePreviews();
    updateMarketOddsPanel();
    if (state.marketFormStep === marketReviewStep()) updateMarketReview();
  }
  if (e.target.matches("#marketForm [name=description], #marketForm [name=question], #marketForm [name=closesAt]")) {
    if (e.target.matches("#marketForm [name=question], #marketForm [name=closesAt]")) resetMarketOddsSeed();
    if (e.target.matches("#marketForm [name=question]")) updateFormSuggestChips();
    updateMarketOddsPanel();
    if (state.marketFormStep === marketReviewStep()) updateMarketReview();
  }
}

function onTradeAmountChipClick(e) {
  const button = e.target.closest?.("[data-fill-amount], [data-fill-percent]");
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  handleTradeAmountFill(button);
}

function onTradeSubmitClickCapture(e) {
  const submit = e.target.closest?.(".trade-submit");
  if (!submit) return;
  const form = submit.closest(".trade-form-el");
  const input = form?.querySelector(".trade-input");
  const amount = tradeInputAmount(input);
  if (Number.isFinite(amount) && amount > 0) {
    setTradeInputAmount(input, amount, { display: input.value || formatShareInput(amount) });
  }
}

function handleTradeAmountFill(fillAmountBtn) {
  if (!fillAmountBtn || fillAmountBtn.disabled) return;
  const panel = fillAmountBtn.closest(".trade-panel") || fillAmountBtn.closest("[data-market-id]");
  const input = panel?.querySelector(".trade-input");
  if (!input) return;
  const market = findMarket(panel?.dataset.marketId);
  const max = Number(input.dataset.rawMax || input.max || DEFAULT_BALANCE);
  let amount = 0;
  if (fillAmountBtn.dataset.fillPercent) {
    const percent = Number(fillAmountBtn.dataset.fillPercent || 0);
    amount = (max * percent) / 100;
    setTradeInputAmount(input, amount, { display: formatShareDisplay(amount) });
  } else if (fillAmountBtn.dataset.fillAmount === "max") {
    amount = max;
    setTradeInputAmount(input, amount, { display: formatShareDisplay(amount) });
  } else {
    const next = (tradeInputAmount(input) || 0) + Number(fillAmountBtn.dataset.fillAmount || 0);
    amount = Math.min(max, next);
    setTradeInputAmount(input, amount, { display: String(amount) });
  }
  if (market) renderTradePreview(market, amount);
}

function onGlobalChange(e) {
  if (e.target.matches("[data-market-odds-toggle]")) {
    e.target.dataset.userSet = "true";
    updateMarketOddsPanel();
    if (e.target.checked && !state.marketOddsSeed && !state.pendingUi.oddsSeed) {
      generateMarketOddsSeed();
    }
    return;
  }
  if (e.target.matches("#marketForm [name=image]")) {
    handleMarketImageInput(e.target);
    return;
  }
  const portfolioGroupSelect = e.target.closest("[data-portfolio-group-select]");
  if (portfolioGroupSelect) {
    const gid = portfolioGroupSelect.value;
    if (!gid || !state.groups.some(group => group.id === gid)) return;
    state.currentGroupId = gid;
    state.shell = "app";
    state.view = "positions";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    localStorage.setItem("probable_groupId", gid);
    routeToPositions({ replace: true });
    normalizeSelection();
    render();
    return;
  }
  const sortControl = e.target.closest("[data-market-sort]");
  if (!sortControl) return;
  state.marketSort = sortControl.value || "trending";
  const grid = document.querySelector("[data-market-grid]");
  const group = getCurrentGroup();
  if (grid && group) {
    grid.innerHTML = sortedMarketEvents(dashboardVisibleMarkets(group.markets)).map(event => eventCard(event)).join("");
    animateIn();
    return;
  }
  render();
}

async function onGlobalSubmit(e) {
  if (e.target.id === "dashboardCreateForm") {
    e.preventDefault();
    onDashboardCreate(e);
    return;
  }
  if (e.target.id === "dashboardJoinForm") {
    e.preventDefault();
    onDashboardJoin(e);
    return;
  }

  const form = e.target.closest(".trade-form-el");
  if (!form) return;
  e.preventDefault();
  const panel = form.closest(".trade-panel");
  const market = findMarket(form.dataset.marketId || panel?.dataset.marketId || form.closest("[data-market-id]")?.dataset.marketId);
  if (!market) return;
  if (isSampleMarket(market)) {
    toast("Sample market only. Create a real market to trade.");
    return;
  }
  const tradeContext = tradeContextFromPanel(panel, form, market);
  if (!tradeContext.valid) {
    toast(tradeContext.error || "Trade panel is stale. Reopen the market and try again.");
    render();
    return;
  }
  state.trade = { marketId: market.id, side: tradeContext.side, mode: tradeContext.action };

  const input = form.querySelector(".trade-input");
  const rawAmount = tradeInputAmount(input);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    toast("Enter a valid amount.");
    return;
  }
  if (!state.demoMode && !requireLogin()) return;
  if (!state.activeMember) {
    toast("Select a member first.");
    return;
  }

  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const { action, side, outcomeId } = tradeContext;
  let amount = rawAmount;
  if (state.pendingUi.tradeMarketId === market.id) return;
  if (action === "buy" && amount > balance) {
    toast(`${state.activeMember} has ${money(balance)}.`);
    return;
  }
  if (action === "buy" && amount > maxSingleBuyAmount(market) + 0.000001) {
    toast(`Max single trade is ${money(maxSingleBuyAmount(market))}. Split it into smaller trades.`);
    renderTradePreview(market, amount);
    return;
  }
  if (action === "sell") {
    const sellState = sellPreviewForShares(market, outcomeId, rawAmount, side);
    if (!sellState.held || sellState.held <= 0) {
      toast(`You do not own ${marketOptionTitleForOutcome(market, outcomeId)} contracts.`);
      return;
    }
    if (sellState.oversell) {
      toast(`You can sell up to ${formatShares(sellState.held)} shares.`);
      return;
    }
    if (!sellState.cashAmount || sellState.cashAmount <= 0) {
      toast("Enter more shares to sell.");
      return;
    }
    amount = sellState.cashAmount;
  }
  const submit = form.querySelector(".trade-submit");
  state.pendingUi.tradeMarketId = market.id;
  setButtonPending(submit, true, action === "sell" ? "Selling" : "Buying");
  try {
    const data = await api(`/api/markets/${market.id}/trade`, {
      method: "POST",
      body: JSON.stringify({ participant: state.activeMember, side, amount, action, outcomeId }),
    });
    state.pendingUi.tradeMarketId = null;
    setButtonPending(submit, false);
    setGroups(data.groups);
    try {
      await refreshFocusedMarketContext(market.id);
    } catch (contextErr) {
      console.warn("Could not refresh market context after trade", contextErr);
    }
    state.trade = { marketId: market.id, side, mode: action };
    state.mobileTradeOpen = false;
    normalizeSelection();
    render();
    toast(`${state.activeMember} ${action === "sell" ? "sold" : "bought"} ${side.toUpperCase()}.`);
  } catch (err) {
    toast(err.message || "Trade failed.");
  } finally {
    if (state.pendingUi.tradeMarketId === market.id) state.pendingUi.tradeMarketId = null;
    setButtonPending(submit, false);
  }
}

function isLoggedIn() {
  return Boolean(state.authUser);
}

function requireLogin(action) {
  if (isLoggedIn()) return true;
  state.pendingAuthAction = action;
  if (action) sessionStorage.setItem("probable_pending_auth_action", action);
  else sessionStorage.removeItem("probable_pending_auth_action");
  openModal("login");
  return false;
}

function runPendingAuthAction() {
  const action = state.pendingAuthAction;
  state.pendingAuthAction = null;
  if (action === "create-group") {
    openModal("group");
    return;
  }
  if (action === "join-group") {
    openModal("join");
    return;
  }
  if (action === "join-invite") {
    const token = state.inviteToken || sessionStorage.getItem("probable_pending_invite_token");
    if (token) {
      state.inviteToken = token;
      sessionStorage.removeItem("probable_pending_invite_token");
      loadInvitePreview(token).then(() => joinCurrentInvite());
    }
    return;
  }
  if (action === "create-market") {
    ensureMarketGroup().then(() => {
      state.shell = "app";
      state.view = "dashboard";
      routeToApp();
      setMarketMinDate();
      render();
      openModal("market");
    }).catch(err => toast(err.message || "Could not prepare a market room."));
    return;
  }
  if (action === "enter-app") {
    ensureMarketGroup().then(() => {
      state.shell = "app";
      state.view = "dashboard";
      state.welcomeMode = "actions";
      routeToApp();
      normalizeSelection();
      render();
    }).catch(err => toast(err.message || "Could not open the dashboard."));
    return;
  }
  if (action === "welcome-create-market") {
    createStoredWelcomeMarket().catch(err => toast(err.message || "Failed to create market."));
    return;
  }
  if (action === "demo-create-group") {
    openModal("group");
    return;
  }
  if (action === "submit-bracket") {
    state.shell = "app";
    state.view = "bracket";
    routeToBracket();
    render();
    void submitBracketEntry();
    return;
  }
  if (action === "submit-pl-predictor") {
    const pendingPredictorId = sessionStorage.getItem("probable_pending_predictor_id");
    if (pendingPredictorId && LEAGUE_PREDICTORS[pendingPredictorId]) {
      state.activePredictorId = pendingPredictorId;
    }
    sessionStorage.removeItem("probable_pending_predictor_id");
    state.shell = "app";
    state.view = "plPredictor";
    routeToPremierLeaguePredictor();
    render();
    void submitPremierLeagueEntry();
    return;
  }
  if (action === "trade-shared-market") {
    continueSharedMarketTrade().catch(err => toast(err.message || "Could not open that trade."));
  }
}

async function onLogin(e) {
  e.preventDefault();
  const email = new FormData(e.currentTarget).get("email")?.toString().trim() ?? "";
  const displayName = readAuthDisplayNameInput();
  if (!displayName) return;
  if (import.meta.env.DEV) {
    applyDevAuthBypass(displayName, email || `${slug(displayName)}@probable.local`);
    return;
  }
  if (!email) {
    toast("Enter your email address.");
    dom.authEmailInput?.focus();
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast("Enter a valid email address.");
    dom.authEmailInput?.focus();
    return;
  }
  const action = state.pendingAuthAction;
  if (action) sessionStorage.setItem("probable_pending_auth_action", action);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: authRedirectUrl(),
      shouldCreateUser: true,
      data: { name: displayName, full_name: displayName },
    },
  });
  if (error) {
    toast(error.message || "Email sign-in failed.");
    return;
  }
  toast("Check your email for a sign-in link.");
}

async function onGoogleSignIn() {
  const displayName = dom.authNameInput?.value.trim() || localStorage.getItem("probable_display_name") || "Dev";
  if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_AUTH_BYPASS === "true") {
    if (!displayName || displayName.length < 2) {
      toast("Enter a display name.");
      dom.authNameInput?.focus();
      return;
    }
    applyDevAuthBypass(displayName);
    return;
  }
  await onOAuthSignIn("google");
}

function applyDevAuthBypass(displayName, email = "dev@probable.local") {
  const action = state.pendingAuthAction || sessionStorage.getItem("probable_pending_auth_action");
  if (action) sessionStorage.setItem("probable_pending_auth_action", action);
  const session = devAuthSession(displayName, email);
  localStorage.setItem(STORAGE_KEYS.devAuth, JSON.stringify({
    displayName,
    email: session.user.email,
  }));
  applyAuthSession(session);
  closeModal("login");
  toast("Dev sign-in active.");
  runStoredPendingAuthAction();
}

function devAuthSession(displayName, email = "dev@probable.local") {
  return {
    user: {
      id: "dev-user",
      email,
      user_metadata: { full_name: displayName, name: displayName },
    },
  };
}

function restoreDevAuthSession() {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.devAuth);
    const stored = raw ? JSON.parse(raw) : {};
    const wantsAppRestore = localStorage.getItem(STORAGE_KEYS.shell) === "app" || Boolean(localStorage.getItem(STORAGE_KEYS.groupId));
    if (!raw && !wantsAppRestore) return null;
    const displayName = String(
      stored.displayName ||
      localStorage.getItem("probable_display_name") ||
      localStorage.getItem(STORAGE_KEYS.user) ||
      ""
    ).trim();
    if (!displayName) return null;
    localStorage.setItem(STORAGE_KEYS.devAuth, JSON.stringify({
      displayName,
      email: stored.email || "dev@probable.local",
    }));
    return devAuthSession(displayName, stored.email || "dev@probable.local");
  } catch {
    return null;
  }
}

function readAuthDisplayNameInput() {
  const displayName = dom.authNameInput?.value.trim() ?? "";
  if (!displayName) {
    toast("Enter a display name.");
    dom.authNameInput?.focus();
    return "";
  }
  if (displayName.length < 2) {
    toast("Display name must be at least 2 characters.");
    dom.authNameInput?.focus();
    return "";
  }
  localStorage.setItem("probable_display_name", displayName);
  return displayName;
}

async function onOAuthSignIn(provider) {
  const action = state.pendingAuthAction;
  if (action) sessionStorage.setItem("probable_pending_auth_action", action);
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: authRedirectUrl() },
  });
  if (error) toast(error.message || `${provider} sign-in failed.`);
}

function authRedirectUrl() {
  return `${location.origin}${location.pathname || "/"}${location.search || ""}`;
}

async function onSignOut() {
  localStorage.removeItem(STORAGE_KEYS.devAuth);
  const { error } = state.authUser?.id === "dev-user" ? { error: null } : await supabase.auth.signOut();
  if (error) {
    toast(error.message || "Sign out failed.");
    return;
  }
  resetToWelcomeAfterSignOut();
  closeModal("login");
  render();
  toast("Signed out.");
}

async function onJoinGroupSubmit(e) {
  e.preventDefault();
  if (!requireLogin("join-group")) return;
  const rawTarget = new FormData(e.currentTarget).get("groupId")?.toString().trim() ?? "";
  const inviteToken = extractInviteToken(rawTarget);
  if (inviteToken) {
    state.inviteToken = inviteToken;
    await loadInvitePreview(inviteToken);
    await joinCurrentInvite();
    closeModal("join");
    return;
  }
  const groupId = extractJoinGroupId(rawTarget);
  if (!groupId) {
    toast("Paste an invite link or group ID.");
    return;
  }
  await joinGroup(groupId, authDisplayName());
  closeModal("join");
}

async function onDashboardCreate(e) {
  if (state.pendingUi.welcomeCreate) return;
  const fd = new FormData(e.target);
  const payload = marketPayloadFromForm(fd);
  if (!payload) return;
  if (!isLoggedIn()) {
    storePendingWelcomeMarket(payload);
    requireLogin("welcome-create-market");
    return;
  }
  const submit = e.target.querySelector('[type="submit"]');
  state.pendingUi.welcomeCreate = true;
  setButtonPending(submit, true, "Creating");
  try {
    await createWelcomeMarket(payload, e.target);
  } finally {
    state.pendingUi.welcomeCreate = false;
    setButtonPending(submit, false);
  }
}

function marketPayloadFromForm(fd, { includeOddsSeed = false } = {}) {
  const question = fd.get("question")?.toString().trim() ?? "";
  const description = fd.get("description")?.toString().trim() ?? "";
  const closesAtRaw = fd.get("closesAt")?.toString().trim() ?? "";
  const outcomes = parseOutcomeOptions(fd.get("outcomes")?.toString() ?? "");
  if (!question) {
    toast("Add a question.");
    return null;
  }
  if (outcomes.length < 2) {
    toast("Add at least two predictions.");
    return null;
  }
  if (!closesAtRaw) {
    toast("Choose a maturity date.");
    return null;
  }
  const closesAt = new Date(closesAtRaw);
  if (!Number.isFinite(closesAt.getTime()) || closesAt <= new Date()) {
    toast("Maturity date must be in the future.");
    return null;
  }
  const descriptionError = marketDescriptionError(fd);
  if (descriptionError) {
    toast(descriptionError);
    return null;
  }
  const payload = {
    question,
    description,
    category: "General",
    closesAt: closesAt.toISOString(),
    outcomes,
    initialProbability: 0.5,
    initialLiquidity: defaultMarketLiquidityForOutcomeCount(outcomes.length),
    oracleType: "ai",
  };
  if (includeOddsSeed) {
    const seed = selectedMarketOddsSeed(outcomes);
    if (seed) payload.initialProbabilities = seed;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setButtonPending(button, pending, label = "Working") {
  if (!button) return;
  if (pending) {
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    if (!button.dataset.wasDisabled) button.dataset.wasDisabled = button.disabled ? "true" : "false";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.add("is-loading");
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
    return;
  }
  if (button.dataset.idleHtml) button.innerHTML = button.dataset.idleHtml;
  button.disabled = button.dataset.wasDisabled === "true";
  button.removeAttribute("aria-busy");
  button.classList.remove("is-loading");
  delete button.dataset.idleHtml;
  delete button.dataset.wasDisabled;
}

function validateMarketBasics(form = dom.marketForm) {
  const fd = new FormData(form);
  const question = fd.get("question")?.toString().trim() ?? "";
  const outcomes = parseOutcomeOptions(fd.get("outcomes")?.toString() ?? "");
  const closesAtRaw = fd.get("closesAt")?.toString().trim() ?? "";
  if (!question) {
    toast("Add a question.");
    form.querySelector("[name=question]")?.focus();
    return false;
  }
  if (outcomes.length < 2) {
    toast("Add at least two predictions.");
    form.querySelector("[name=outcomes]")?.focus();
    return false;
  }
  if (!closesAtRaw) {
    toast("Choose a maturity date.");
    form.querySelector("[name=closesAt]")?.focus();
    return false;
  }
  const closesAt = new Date(closesAtRaw);
  if (!Number.isFinite(closesAt.getTime()) || closesAt <= new Date()) {
    toast("Maturity date must be in the future.");
    form.querySelector("[name=closesAt]")?.focus();
    return false;
  }
  return true;
}

function validateMarketDescription(form = dom.marketForm) {
  const fd = new FormData(form);
  const error = marketDescriptionError(fd);
  if (error) {
    toast(error);
    form.querySelector("[name=description]")?.focus();
    return false;
  }
  return true;
}

function marketDescriptionError(fd) {
  const description = fd.get("description")?.toString().trim() ?? "";
  if (!description || description.length < 40) return "Add a specific description with at least 40 characters.";
  return "";
}

async function autoFleshOutDescription(form = dom.marketForm) {
  if (!form || state.pendingUi.rulesDraft) return;
  const fd = new FormData(form);
  const question = fd.get("question")?.toString().trim() ?? "";
  const currentDescription = fd.get("description")?.toString().trim() ?? "";
  if (!question || currentDescription) return;
  const closesAtRaw = fd.get("closesAt")?.toString().trim() ?? "";
  const closesAt = closesAtRaw ? new Date(closesAtRaw) : null;
  const outcomes = parseOutcomeOptions(fd.get("outcomes")?.toString() ?? "");
  const descriptionInput = form.querySelector("[name=description]");
  const note = form.querySelector("[data-ai-generating-note]");
  state.pendingUi.rulesDraft = true;
  if (descriptionInput) descriptionInput.disabled = true;
  note?.classList.remove("hidden");
  try {
    const data = await api("/api/markets/rules/draft", {
      method: "POST",
      body: JSON.stringify({
        question,
        brief: currentDescription || question,
        outcomes,
        closesAt: closesAt && Number.isFinite(closesAt.getTime()) ? closesAt.toISOString() : null,
        oracleType: "ai",
      }),
    });
    const stripLabel = (text, label) => text.replace(new RegExp(`^\\s*${label}\\s*:?\\s*`, "i"), "").trim();
    const draft = data.draft || {};
    const draftDescription = draft.description ? draft.description.trim() : "";
    const source = draft.resolutionSource ? stripLabel(draft.resolutionSource.trim(), "primary source") : "";
    const edgeCases = draft.edgeCases ? stripLabel(draft.edgeCases.trim(), "edge cases") : "";
    const merged = [
      draftDescription,
      source && !/primary source/i.test(draftDescription) ? `Primary source: ${source}` : "",
      edgeCases && !/edge cases/i.test(draftDescription) ? `Edge cases: ${edgeCases}` : "",
    ].filter(Boolean).join("\n\n");
    if (descriptionInput && merged && !descriptionInput.value.trim()) {
      descriptionInput.value = merged;
      if (state.marketFormStep === marketReviewStep(form)) updateMarketReview(form);
    }
  } catch {
    // Silent: the user can still type their own description if AI assist fails.
  } finally {
    state.pendingUi.rulesDraft = false;
    if (descriptionInput) descriptionInput.disabled = false;
    note?.classList.add("hidden");
  }
}

function handleMarketImageInput(input) {
  const file = input.files?.[0];
  if (!file) {
    state.marketImageDataUrl = "";
    state.marketImageName = "";
    updateMarketImagePreview();
    return;
  }
  if (!file.type.startsWith("image/")) {
    input.value = "";
    state.marketImageDataUrl = "";
    state.marketImageName = "";
    updateMarketImagePreview();
    toast("Upload an image file.");
    return;
  }
  if (file.size > MAX_MARKET_IMAGE_BYTES) {
    input.value = "";
    state.marketImageDataUrl = "";
    state.marketImageName = "";
    updateMarketImagePreview();
    toast("Keep market pictures under 650KB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.marketImageDataUrl = typeof reader.result === "string" ? reader.result : "";
    state.marketImageName = file.name;
    updateMarketImagePreview();
    if (state.marketFormStep === marketReviewStep()) updateMarketReview();
  };
  reader.onerror = () => {
    input.value = "";
    state.marketImageDataUrl = "";
    state.marketImageName = "";
    updateMarketImagePreview();
    toast("Could not read that image.");
  };
  reader.readAsDataURL(file);
}

function updateMarketImagePreview() {
  const preview = dom.marketForm?.querySelector("[data-market-image-preview]");
  if (!preview) return;
  if (state.marketImageDataUrl) {
    preview.innerHTML = `<img src="${esc(state.marketImageDataUrl)}" alt="" /><strong>${esc(state.marketImageName || "Custom image")}</strong>`;
    preview.classList.add("has-image");
    return;
  }
  preview.innerHTML = imageUploadIconSvg();
  preview.classList.remove("has-image");
}

function marketOracleLabel(value) {
  if (value === "manual") return "Manual settle";
  if (value === "vote") return "Group vote";
  return "probable.fun expert verification";
}

function marketTypeLabel(outcomes) {
  return isBinaryOutcomeSet(outcomes) ? "Binary" : "Multiple choice";
}

function isBinaryOutcomeSet(outcomes) {
  const keys = (outcomes || []).map(outcome => outcome.toLowerCase());
  return keys.length === 2 && keys.includes("yes") && keys.includes("no");
}

function marketFormOutcomes(form = dom.marketForm) {
  return parseOutcomeOptions(form?.querySelector("[name=outcomes]")?.value ?? "");
}

function marketFormIsMulti(form = dom.marketForm) {
  const outcomes = marketFormOutcomes(form);
  return outcomes.length > 2 || (outcomes.length === 2 && !isBinaryOutcomeSet(outcomes));
}

function marketFormTotalSteps(form = dom.marketForm) {
  return marketFormIsMulti(form) ? 5 : 4;
}

function marketReviewStep(form = dom.marketForm) {
  return marketFormTotalSteps(form);
}

function marketPanelStep(step, form = dom.marketForm) {
  return !marketFormIsMulti(form) && step === 4 ? "5" : String(step);
}

function outcomePreviewHtml(outcomes, { limit = Infinity } = {}) {
  const list = outcomes.length ? outcomes : ["Yes", "No"];
  const visible = list.slice(0, limit);
  const remaining = Math.max(0, list.length - visible.length);
  return [
    ...visible.map(outcome => `<span>${escapeHtml(outcome)}</span>`),
    remaining ? `<span class="prediction-chip-more">+${remaining} more</span>` : "",
  ].join("");
}

function outcomeReviewHtml(outcomes) {
  const list = outcomes.length ? outcomes : ["Yes", "No"];
  return `
    <div class="market-review-outcomes">
      <strong>${list.length} outcome${list.length === 1 ? "" : "s"}</strong>
      <div class="prediction-chip-preview market-review-outcome-list">
        ${outcomePreviewHtml(list)}
      </div>
    </div>`;
}

function updateOutcomePreviews(form = dom.marketForm) {
  const outcomes = parseOutcomeOptions(form.querySelector("[name=outcomes]")?.value ?? "");
  form.querySelectorAll("[data-outcome-preview]").forEach(target => {
    target.innerHTML = outcomePreviewHtml(outcomes, { limit: 10 });
  });
}

function selectedMarketOddsSeed(outcomes) {
  const toggle = dom.marketForm?.querySelector("[data-market-odds-toggle]");
  const seed = state.marketOddsSeed;
  if (!toggle?.checked || !seed?.available || !seed.probabilities || isBinaryOutcomeSet(outcomes)) return null;
  const values = {};
  outcomes.forEach(outcome => {
    const direct = seed.probabilities[outcome];
    if (Number.isFinite(Number(direct))) values[outcome] = Number(direct);
  });
  return Object.keys(values).length ? values : null;
}

async function loadQuestionSuggestions(groupId) {
  if (!groupId || groupId === DEMO_GROUP_ID || state.pendingUi.suggestions) return;
  if (state.questionSuggestionsGroupId === groupId && state.questionSuggestions.length) return;
  state.pendingUi.suggestions = true;
  state.questionSuggestions = [];
  render();
  try {
    const data = await api(`/api/groups/${groupId}/questions/suggest`, { method: "POST", timeoutMs: 35000 });
    if (state.currentGroupId === groupId) {
      state.questionSuggestions = data.questions || [];
      state.questionSuggestionsGroupId = groupId;
    }
  } catch {
    state.questionSuggestions = [];
  } finally {
    state.pendingUi.suggestions = false;
    render();
    if (state.currentGroupId && state.currentGroupId !== groupId) {
      loadQuestionSuggestions(state.currentGroupId);
    }
  }
}

function resetMarketOddsSeed() {
  state.marketOddsSeed = null;
}

function shouldDefaultMarketOddsSeed(outcomes) {
  return outcomes.length > 10 && !isBinaryOutcomeSet(outcomes);
}

function oddsSeedPreviewHtml(seed, outcomes) {
  if (!seed?.probabilities) return "";
  return outcomes.map(outcome => {
    const value = Number(seed.probabilities[outcome] ?? 0);
    return `<span><strong>${escapeHtml(outcome)}</strong>${Math.round(value * 1000) / 10}%</span>`;
  }).join("");
}

function updateMarketOddsPanel(form = dom.marketForm) {
  if (!form) return;
  const outcomes = marketFormOutcomes(form);
  const multi = marketFormIsMulti(form);
  const toggle = form.querySelector("[data-market-odds-toggle]");
  const button = form.querySelector("[data-generate-market-odds]");
  const status = form.querySelector("[data-market-odds-status]");
  const preview = form.querySelector("[data-market-odds-preview]");
  if (toggle) {
    toggle.disabled = !multi;
    if (multi && !toggle.dataset.userSet) toggle.checked = shouldDefaultMarketOddsSeed(outcomes);
    if (!multi) toggle.checked = false;
  }
  if (button) {
    button.disabled = !multi || !toggle?.checked || state.pendingUi.oddsSeed;
  }
  if (!preview || !status) return;
  if (!multi) {
    status.textContent = "Binary markets start at 50/50.";
    preview.innerHTML = "";
    return;
  }
  if (!toggle?.checked) {
    status.textContent = "Off. Every outcome starts equal.";
    preview.innerHTML = "";
    return;
  }
  if (state.pendingUi.oddsSeed) {
    status.textContent = "Looking up current odds context...";
    preview.innerHTML = "";
    return;
  }
  const seed = state.marketOddsSeed;
  if (!seed) {
    status.textContent = "On. Generate seed odds before review, or continue with equal prices.";
    preview.innerHTML = "";
    return;
  }
  status.textContent = seed.available ? (seed.summary || "Seed odds ready.") : (seed.summary || "Seed odds unavailable.");
  preview.innerHTML = seed.available ? oddsSeedPreviewHtml(seed, outcomes) : "";
}

async function generateMarketOddsSeed(form = dom.marketForm) {
  if (!form || state.pendingUi.oddsSeed) return;
  if (!marketFormIsMulti(form)) {
    toast("AI odds seeding is only for multi-outcome markets.");
    return;
  }
  if (!validateMarketBasics(form)) return;
  const fd = new FormData(form);
  const question = fd.get("question")?.toString().trim() ?? "";
  const description = fd.get("description")?.toString().trim() ?? "";
  const closesAtRaw = fd.get("closesAt")?.toString().trim() ?? "";
  const closesAt = closesAtRaw ? new Date(closesAtRaw) : null;
  const outcomes = parseOutcomeOptions(fd.get("outcomes")?.toString() ?? "");
  const button = form.querySelector("[data-generate-market-odds]");
  state.pendingUi.oddsSeed = true;
  setButtonPending(button, true, "Checking odds");
  updateMarketOddsPanel(form);
  try {
    const data = await api("/api/markets/odds/seed", {
      method: "POST",
      body: JSON.stringify({
        question,
        brief: description || question,
        outcomes,
        closesAt: closesAt && Number.isFinite(closesAt.getTime()) ? closesAt.toISOString() : null,
        category: "General",
      }),
    });
    state.marketOddsSeed = data.seed || null;
    if (!state.marketOddsSeed?.available) {
      toast(state.marketOddsSeed?.summary || "Could not seed odds. Equal prices will be used.");
    }
  } catch (err) {
    state.marketOddsSeed = null;
    toast(err.message || "Could not seed odds.");
  } finally {
    state.pendingUi.oddsSeed = false;
    setButtonPending(button, false);
    updateMarketOddsPanel(form);
    if (state.marketFormStep === marketReviewStep(form)) updateMarketReview(form);
  }
}

function updateMarketReview(form = dom.marketForm) {
  const review = form.querySelector("[data-market-review]");
  if (!review) return;
  const fd = new FormData(form);
  const question = fd.get("question")?.toString().trim() ?? "Untitled market";
  const description = fd.get("description")?.toString().trim() ?? "";
  const closesAtRaw = fd.get("closesAt")?.toString().trim() ?? "";
  const closesAt = closesAtRaw ? new Date(closesAtRaw) : null;
  const outcomes = parseOutcomeOptions(fd.get("outcomes")?.toString() ?? "");
  const oracle = fd.get("oracle")?.toString() || "ai";
  const closeLabel = closesAt && Number.isFinite(closesAt.getTime()) ? fmtDate(closesAt) : "Not set";
  const selectedSeed = selectedMarketOddsSeed(outcomes);
  const oddsLabel = selectedSeed
    ? "AI-seeded, softened"
    : (isBinaryOutcomeSet(outcomes) ? "50/50 start" : "Equal start");
  review.innerHTML = `
    <div class="market-review-summary">
      <div>
        <span>Question</span>
        <strong>${escapeHtml(question)}</strong>
      </div>
      <div>
        <span>Predictions</span>
        ${outcomeReviewHtml(outcomes)}
      </div>
      <div>
        <span>Maturity</span>
        <strong>${escapeHtml(closeLabel)}</strong>
      </div>
      <div>
        <span>Verification</span>
        <strong>${marketOracleLabel(oracle)}</strong>
      </div>
      <div>
        <span>Starting odds</span>
        <strong>${escapeHtml(oddsLabel)}</strong>
      </div>
      <div>
        <span>Image</span>
        <strong>${state.marketImageDataUrl ? "Custom upload" : "Stock football image"}</strong>
      </div>
    </div>
    ${selectedSeed ? `
      <div class="market-review-odds">
        <span>Seed preview</span>
        <div class="market-odds-preview">${oddsSeedPreviewHtml({ probabilities: selectedSeed }, outcomes)}</div>
      </div>
    ` : ""}
    <div class="market-review-description">
      <span>Description</span>
      <div class="market-review-description-box">${escapeHtml(description || "No description added yet.")}</div>
    </div>
  `;
}

async function goMarketFormStep(step) {
  const totalSteps = marketFormTotalSteps();
  const nextStep = Math.max(1, Math.min(totalSteps, Number(step) || 1));
  if (nextStep > 1 && !validateMarketBasics()) return;
  if (state.marketFormStep < 2 && nextStep >= 2 && !rulesDraftPromise) {
    rulesDraftPromise = autoFleshOutDescription(dom.marketForm).finally(() => {
      rulesDraftPromise = null;
    });
  }
  if (nextStep > 2) {
    if (rulesDraftPromise) await rulesDraftPromise;
    if (!validateMarketDescription()) return;
  }
  if (nextStep === marketReviewStep()) updateMarketReview();
  state.marketFormStep = nextStep;
  updateMarketFormStep();
  if (nextStep === 4 && marketFormIsMulti()) {
    const toggle = dom.marketForm.querySelector("[data-market-odds-toggle]");
    if (toggle?.checked && !state.marketOddsSeed && !state.pendingUi.oddsSeed) await generateMarketOddsSeed();
  }
}

function updateFormSuggestChips() {
  const container = dom.marketForm?.querySelector("[data-form-suggest-chips]");
  if (!container) return;
  const onStep1 = state.marketFormStep === 1;
  const qInput = dom.marketForm?.querySelector("[name=question]");
  const hasTyped = (qInput?.value || "").trim().length > 0;
  const questions = state.questionSuggestions;
  if (!onStep1 || hasTyped || !questions.length) {
    container.classList.add("hidden");
    return;
  }
  container.innerHTML = questions.map((q, i) =>
    `<button class="form-suggest-chip" type="button" data-form-suggestion data-form-suggestion-index="${i}">${esc(q)}</button>`
  ).join("");
  container.classList.remove("hidden");
}

function updateMarketFormStep() {
  const totalSteps = marketFormTotalSteps();
  const step = Math.max(1, Math.min(totalSteps, state.marketFormStep || 1));
  state.marketFormStep = step;
  const stepLabels = marketFormIsMulti()
    ? ["Basics", "Description", "Image", "AI odds", "Review"]
    : ["Basics", "Description", "Image", "Review"];
  const visiblePanelStep = marketPanelStep(step);
  dom.marketForm.querySelectorAll("[data-market-form-step]").forEach(panel => {
    panel.classList.toggle("hidden", panel.dataset.marketFormStep !== visiblePanelStep);
  });
  const progressFill = dom.marketForm.querySelector("[data-market-progress-fill]");
  const stepLabel = dom.marketForm.querySelector("[data-market-step-label]");
  const stepCount = dom.marketForm.querySelector("[data-market-step-count]");
  if (progressFill) progressFill.style.width = `${(step / totalSteps) * 100}%`;
  if (stepLabel) stepLabel.textContent = stepLabels[step - 1] || "Basics";
  if (stepCount) stepCount.textContent = `Step ${step} of ${totalSteps}`;
  updateOutcomePreviews();
  updateMarketImagePreview();
  updateMarketOddsPanel();
  if (step === marketReviewStep()) updateMarketReview();
  dom.marketForm.querySelector("[data-market-step-back]")?.classList.toggle("hidden", step === 1);
  dom.marketForm.querySelector("[data-market-step-next]")?.classList.toggle("hidden", step === totalSteps);
  dom.marketForm.querySelector("[data-market-submit]")?.classList.toggle("hidden", step !== totalSteps);
  updateFormSuggestChips();
}

function setMarketType(type) {
  const normalized = type === "multi" ? "multi" : "binary";
  resetMarketOddsSeed();
  const oddsToggle = dom.marketForm.querySelector("[data-market-odds-toggle]");
  if (oddsToggle) delete oddsToggle.dataset.userSet;
  dom.marketForm.querySelectorAll("[data-market-type]").forEach(button => {
    const active = button.dataset.marketType === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const outcomes = dom.marketForm.querySelector("[name=outcomes]");
  if (!outcomes) return;
  const currentValue = outcomes.value.trim();
  if (normalized === "binary") {
    if (!currentValue) outcomes.value = "Yes, No";
    outcomes.placeholder = "Yes, No";
  } else {
    if (!currentValue || currentValue.toLowerCase() === "yes, no") outcomes.value = "";
    outcomes.placeholder = "England, France, Portugal, Brazil";
  }
  updateOutcomePreviews();
  updateMarketOddsPanel();
  updateMarketFormStep();
}

function parseOutcomeOptions(value) {
  const raw = value.trim();
  if (!raw) return [];
  const seen = new Set();
  return raw
    .split(/[\n,]/)
    .map(option => option.trim())
    .filter(Boolean)
    .filter(option => {
      const key = option.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function storePendingWelcomeMarket(payload) {
  sessionStorage.setItem("probable_pending_market", JSON.stringify(payload));
}

function takePendingWelcomeMarket() {
  const raw = sessionStorage.getItem("probable_pending_market");
  if (!raw) return null;
  sessionStorage.removeItem("probable_pending_market");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function createStoredWelcomeMarket() {
  const payload = takePendingWelcomeMarket();
  if (!payload) {
    state.welcomeMode = "create";
    render();
    return;
  }
  await createWelcomeMarket(payload);
}

async function createWelcomeMarket(payload, form) {
  if (!authDisplayName()) {
    toast("Sign in to create markets.");
    return false;
  }
  try {
    const group = await ensureMarketGroup();
    await createMarketForGroup(group, payload);
    form?.reset();
    state.shell = "app";
    state.view = "dashboard";
    state.welcomeMode = "actions";
    routeToApp();
    normalizeSelection();
    render();
    toast("Market created.");
    return true;
  } catch (err) {
    toast(err.message || "Failed to create market.");
    return false;
  }
}

async function onDashboardJoin(e) {
  if (!requireLogin("join-group")) return;
  const fd = new FormData(e.target);
  const myName = authDisplayName();
  const rawTarget = fd.get("groupId")?.toString().trim() ?? "";
  const inviteToken = extractInviteToken(rawTarget);
  if (inviteToken) {
    await loadInvitePreview(inviteToken);
    state.inviteToken = inviteToken;
    await joinCurrentInvite();
    return;
  }
  const groupId = extractJoinGroupId(rawTarget);
  if (!myName || !groupId) {
    toast("Add your name and invite.");
    return;
  }
  await joinGroup(groupId, myName);
}

function extractInviteToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.origin);
    const queryToken = url.searchParams.get("invite");
    if (queryToken) return queryToken.trim();
    const parts = url.pathname.split("/").filter(Boolean);
    const inviteIndex = parts.indexOf("invite");
    if (inviteIndex >= 0 && parts[inviteIndex + 1]) return decodeURIComponent(parts[inviteIndex + 1]).trim();
  } catch {}
  return "";
}

function extractJoinGroupId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.origin);
    const queryJoin = url.searchParams.get("join");
    if (queryJoin) return queryJoin.trim();
    const parts = url.pathname.split("/").filter(Boolean);
    const groupIndex = parts.indexOf("group");
    if (groupIndex >= 0 && parts[groupIndex + 1]) return decodeURIComponent(parts[groupIndex + 1]).trim();
  } catch {}
  return raw;
}

async function loadInvitePreview(token) {
  if (!token) return null;
  state.inviteLoading = true;
  state.inviteError = "";
  render();
  try {
    const data = await api(`/api/invites/${encodeURIComponent(token)}`);
    state.invitePreview = data.invite;
    state.inviteError = "";
    return data.invite;
  } catch (err) {
    state.invitePreview = null;
    state.inviteError = err.message || "Invite link could not be loaded.";
    return null;
  } finally {
    state.inviteLoading = false;
    render();
  }
}

async function openInviteModal(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group) return;
  state.inviteModal = { groupId, invite: null, loading: true, error: "", confirmRegenerate: false };
  openModal("invite");
  renderInviteModal();
  try {
    const data = await api(`/api/groups/${groupId}/invites`, {
      method: "POST",
      body: JSON.stringify({ createdBy: authDisplayName() }),
    });
    state.inviteModal.invite = data.invite;
  } catch (err) {
    state.inviteModal.error = err.message || "Could not create invite link.";
  } finally {
    state.inviteModal.loading = false;
    renderInviteModal();
  }
}

function renderInviteModal() {
  const group = state.groups.find(item => item.id === state.inviteModal.groupId);
  const invite = state.inviteModal.invite;
  const link = invite ? inviteUrl(invite.token) : "";
  dom.inviteModalBody.innerHTML = `
    <div class="invite-card">
      <div class="invite-card-head">
        <span class="invite-card-mark">${esc(group?.emoji || "PB")}</span>
        <div>
          <p class="eyebrow">Group invite</p>
          <h3>${esc(group?.name || "Group")}</h3>
        </div>
      </div>
      ${state.inviteModal.loading ? `
        <p class="muted">Preparing invite link...</p>
      ` : state.inviteModal.error ? `
        <p class="invite-error">${esc(state.inviteModal.error)}</p>
      ` : invite ? `
        <div class="invite-link-box">
          <span>${esc(link)}</span>
          <button type="button" data-copy-invite-link>Copy</button>
        </div>
        <div class="invite-actions">
          <button class="btn btn-primary" type="button" data-copy-invite-link>Copy link</button>
          ${navigator.share ? `<button class="btn btn-ghost" type="button" data-native-share-invite>Share</button>` : ""}
        </div>
        <div class="invite-regenerate ${state.inviteModal.confirmRegenerate ? "confirming" : ""}">
          ${state.inviteModal.confirmRegenerate ? `
            <p>Regenerating breaks older invite links.</p>
            <div class="invite-actions">
              <button class="btn btn-primary" type="button" data-regenerate-invite>Regenerate</button>
              <button class="btn btn-ghost" type="button" data-cancel-regenerate-invite>Cancel</button>
            </div>
          ` : `
            <button type="button" data-regenerate-invite>Regenerate link</button>
          `}
        </div>
      ` : ""}
    </div>`;
}

function inviteUrl(token) {
  return `${location.origin}/invite/${encodeURIComponent(token)}`;
}

function marketUrl(marketId) {
  return `${sharePageBaseUrl()}/market/${encodeURIComponent(marketId)}`;
}

function bracketShareUrl() {
  if (state.bracketEntryId) {
    return `${sharePageBaseUrl()}/bracket?entry=${encodeURIComponent(state.bracketEntryId)}`;
  }
  return `${sharePageBaseUrl()}/bracket`;
}

function bracketShareCardUrl({ sample = false, preview = false } = {}) {
  const params = new URLSearchParams();
  const participant = bracketParticipantName();
  if (state.bracketEntryId) params.set("entry", state.bracketEntryId);
  if (participant && participant !== "Guest") params.set("participant", participant);
  if (sample) params.set("sample", "1");
  const query = params.toString();
  const base = preview ? shareAssetBaseUrl() : shareBaseUrl();
  return `${base}/api/brackets/${encodeURIComponent(BRACKET_CHALLENGE.id)}/share-card.png${query ? `?${query}` : ""}`;
}

function encodedBracketPicks() {
  const picks = state.bracketPicks && typeof state.bracketPicks === "object" ? state.bracketPicks : {};
  const clean = Object.fromEntries(Object.entries(picks).filter(([, value]) => value));
  if (!Object.keys(clean).length) return "";
  try {
    const json = JSON.stringify(clean);
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  } catch {
    return "";
  }
}

function shareBaseUrl() {
  const configured = import.meta.env.VITE_PUBLIC_SHARE_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (API) return new URL(API, location.origin).origin.replace(/\/$/, "");
  if (["5173", "5174", "4173"].includes(location.port)) {
    return `${location.protocol}//${location.hostname}:8000`;
  }
  return location.origin.replace(/\/$/, "");
}

function sharePageBaseUrl() {
  const configuredApp = import.meta.env.VITE_PUBLIC_APP_BASE_URL;
  if (configuredApp) return configuredApp.replace(/\/$/, "");
  return location.origin.replace(/\/$/, "");
}

function shareAssetBaseUrl() {
  const configuredApp = import.meta.env.VITE_PUBLIC_APP_BASE_URL;
  if (configuredApp) return configuredApp.replace(/\/$/, "");
  return apiOriginForAssets();
}

function apiOriginForAssets() {
  if (API) return new URL(API, location.origin).origin.replace(/\/$/, "");
  if (["5173", "5174", "4173"].includes(location.port)) {
    return `${location.protocol}//${location.hostname}:8000`;
  }
  return shareBaseUrl();
}

function appBaseUrl() {
  return (import.meta.env.VITE_PUBLIC_APP_BASE_URL || location.origin).replace(/\/$/, "");
}

function marketEmbedUrl(marketId, options = state.embedModal) {
  const params = new URLSearchParams({
    chart: options.chart ? "1" : "0",
    buttons: options.buttons ? "1" : "0",
    dark: options.dark ? "1" : "0",
    border: options.border ? "1" : "0",
  });
  return `${shareBaseUrl()}/embed/market/${encodeURIComponent(marketId)}?${params.toString()}`;
}

function marketShareCardUrl(marketId) {
  return `${shareBaseUrl()}/api/markets/${encodeURIComponent(marketId)}/share-card.png`;
}

function eventEmbedUrl(eventId, options = state.embedModal) {
  const params = new URLSearchParams({
    chart: options.chart ? "1" : "0",
    buttons: options.buttons ? "1" : "0",
    dark: options.dark ? "1" : "0",
    border: options.border ? "1" : "0",
  });
  return `${shareBaseUrl()}/embed/event/${encodeURIComponent(eventId)}?${params.toString()}`;
}

function marketShareText(market) {
  const title = sampleEventTitle(market);
  const option = marketOptionTitle(market);
  return title === option
    ? `Trade this market on Probable: ${title}`
    : `Trade this market on Probable: ${title} · ${option}`;
}

function clearMarketUrlParam() {
  routeToApp({ replace: true });
}

function imageUploadIconSvg() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17.2 9 12l3 3 3.5-3.5L21 16" />
    </svg>`;
}

function tradeFabIconSvg() {
  return `
    <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <path d="M3 13.5 7.8 8.2l3.4 3 5.4-6" />
      <path d="M12.8 4.6h3.8v3.8" />
    </svg>`;
}

function shareIconSvg() {
  return `
    <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <path d="M7.2 11.4 12.8 14.6M12.8 5.4 7.2 8.6" />
      <circle cx="5" cy="10" r="2.4" />
      <circle cx="15" cy="4.2" r="2.4" />
      <circle cx="15" cy="15.8" r="2.4" />
    </svg>`;
}

function shareArrowIconSvg() {
  return `
    <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <path d="M10 12.5V3.8" />
      <path d="M6.7 7.1 10 3.8l3.3 3.3" />
      <path d="M5.2 9.4v5.4c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6V9.4" />
    </svg>`;
}

async function copyInviteLink() {
  const token = state.inviteModal.invite?.token || state.invitePreview?.token;
  if (!token) return;
  const link = inviteUrl(token);
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied.");
  } catch {
    toast(link);
  }
}

async function shareInviteLink() {
  const invite = state.inviteModal.invite;
  if (!invite || !navigator.share) return;
  try {
    await navigator.share({
      title: `Join ${invite.groupName} on Probable`,
      text: `Join ${invite.groupName} and trade your predictions.`,
      url: inviteUrl(invite.token),
    });
  } catch (err) {
    if (err?.name !== "AbortError") toast("Could not open share sheet.");
  }
}

async function shareMarketLink(marketId) {
  const market = findMarket(marketId);
  if (!market) {
    toast("Market link unavailable.");
    return;
  }
  const url = marketUrl(market.id);
  const title = sampleEventTitle(market);
  const text = marketShareText(market);
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Market link copied.");
  } catch {
    toast(url);
  }
}

async function copyBracketLink() {
  await prepareBracketShareEntry();
  const link = bracketShareUrl();
  const copied = await writeClipboardText(link);
  toast(copied ? "Bracket link copied." : link);
}

async function shareBracketLink() {
  await prepareBracketShareEntry();
  const url = bracketShareUrl();
  const title = `${BRACKET_CHALLENGE.title} · ${BRACKET_CHALLENGE.prize} for perfect knockouts`;
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  await copyBracketLink();
}

async function prepareBracketShareEntry() {
  if (!isLoggedIn()) return null;
  const hasPicks = Object.values(state.bracketPicks || {}).some(Boolean);
  if (!hasPicks) return null;
  try {
    return await saveBracketEntry({ submitted: state.bracketSubmitted, silent: true });
  } catch (err) {
    console.warn("Could not prepare bracket share entry", err);
    return null;
  }
}

function openMarketEmbedModal(marketId) {
  const market = findMarket(marketId);
  if (!market) {
    toast("Market link unavailable.");
    return;
  }
  state.embedModal = { ...state.embedModal, marketId };
  openModal("embed");
  renderMarketEmbedModal();
}

function renderMarketEmbedModal() {
  dom.embedModalOverlay.querySelector(".modal-title").textContent = "Share market";
  const market = findMarket(state.embedModal.marketId);
  if (!market) {
    dom.embedModalBody.innerHTML = `<p class="muted">Market unavailable.</p>`;
    return;
  }
  const group = findGroupForMarket(market.id);
  const event = findEventForMarket(group, market);
  const link = marketUrl(market.id);
  const previewImage = marketShareCardUrl(market.id);
  dom.embedModalBody.innerHTML = `
    <div class="embed-share-layout">
      <div class="embed-preview-frame share-og-preview-frame">
        <img class="share-og-preview-img" src="${esc(previewImage)}" alt="${esc(sampleEventTitle(market))} share preview" />
      </div>
      <div class="embed-share-controls">
        <div class="share-section">
          <p class="eyebrow">Share link</p>
          <h3>Share this market</h3>
          <div class="invite-link-box">
            <span>${esc(link)}</span>
            <button type="button" data-copy-market-link>Copy</button>
          </div>
          <div class="share-action-grid">
            <button class="btn btn-primary" type="button" data-copy-market-link>Copy link</button>
            <button class="btn btn-ghost" type="button" data-native-share-market>Share</button>
          </div>
        </div>

      </div>
    </div>`;
}

async function openBracketShareModal() {
  openModal("embed");
  dom.embedModalOverlay.querySelector(".modal-title").textContent = "Share bracket";
  dom.embedModalBody.innerHTML = `<div class="modal-loading">Preparing share preview...</div>`;
  await prepareBracketShareEntry();
  renderBracketShareModal();
}

function renderBracketShareModal() {
  const link = bracketShareUrl();
  const previewImage = bracketShareCardUrl({ preview: true });
  const fallbackPreviewImage = bracketShareCardUrl();
  dom.embedModalOverlay.querySelector(".modal-title").textContent = "Share bracket";
  dom.embedModalBody.innerHTML = `
    <div class="embed-share-layout bracket-share-layout">
      <div class="embed-preview-frame share-og-preview-frame bracket-share-preview-frame">
        <img
          class="share-og-preview-img bracket-share-preview-img"
          src="${esc(previewImage)}"
          data-fallback-src="${esc(fallbackPreviewImage)}"
          alt="Bracket share preview"
        />
      </div>
      <div class="embed-share-controls">
        <div class="share-section">
          <p class="eyebrow">Bracket link</p>
          <h3>Share your knockout picks</h3>
          <div class="invite-link-box">
            <span>${esc(link)}</span>
            <button type="button" data-copy-bracket-link>Copy</button>
          </div>
          <div class="share-action-grid">
            <button class="btn btn-primary" type="button" data-copy-bracket-link>Copy link</button>
            <button class="btn btn-ghost" type="button" data-native-share-bracket>Share</button>
          </div>
        </div>
      </div>
    </div>`;
  const preview = dom.embedModalBody.querySelector(".bracket-share-preview-img");
  preview?.addEventListener("error", () => {
    const fallback = preview.dataset.fallbackSrc;
    if (fallback && preview.src !== fallback) {
      preview.src = fallback;
      preview.dataset.fallbackSrc = "";
      return;
    }
    const message = document.createElement("div");
    message.className = "share-preview-error";
    message.textContent = "Preview unavailable. The share link still works.";
    preview.replaceWith(message);
  });
}

async function nativeShareMarket() {
  const market = findMarket(state.embedModal.marketId);
  if (!market) return;
  if (!navigator.share) {
    await copyMarketLink(market.id, { fallbackToast: "Share sheet unavailable. Market link copied." });
    return;
  }
  try {
    await navigator.share({
      title: sampleEventTitle(market),
      text: marketShareText(market),
      url: marketUrl(market.id),
    });
  } catch (err) {
    if (err?.name !== "AbortError") toast("Could not open share sheet.");
  }
}

function embedOptionHtml(key, label) {
  return `<label><input type="checkbox" data-embed-option="${key}" ${state.embedModal[key] ? "checked" : ""}/> <span>${label}</span></label>`;
}

async function writeClipboardText(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea copy path for browsers that block clipboard writes.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function copyMarketLink(marketId = state.embedModal.marketId, options = {}) {
  const market = findMarket(marketId);
  if (!market) return;
  const link = marketUrl(market.id);
  const copied = await writeClipboardText(link);
  toast(copied ? (options.fallbackToast || "Market link copied.") : link);
}

async function copyMarketEmbedCode() {
  const box = dom.embedModalBody.querySelector(".embed-code-box");
  const code = box?.value || "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast("Embed code copied.");
  } catch {
    toast(code);
  }
}

async function regenerateInviteLink() {
  const groupId = state.inviteModal.groupId;
  if (!groupId) return;
  state.inviteModal.loading = true;
  state.inviteModal.error = "";
  renderInviteModal();
  try {
    const data = await api(`/api/groups/${groupId}/invites/regenerate`, {
      method: "POST",
      body: JSON.stringify({ createdBy: authDisplayName() }),
    });
    state.inviteModal.invite = data.invite;
    state.inviteModal.confirmRegenerate = false;
    toast("Invite link regenerated.");
  } catch (err) {
    state.inviteModal.error = err.message || "Could not regenerate invite.";
  } finally {
    state.inviteModal.loading = false;
    renderInviteModal();
  }
}

async function joinCurrentInvite() {
  const token = state.inviteToken || state.invitePreview?.token;
  if (!token) {
    toast("Invite link missing.");
    return;
  }
  if (!isLoggedIn()) {
    state.pendingAuthAction = "join-invite";
    sessionStorage.setItem("probable_pending_invite_token", token);
    sessionStorage.setItem("probable_pending_auth_action", "join-invite");
    openModal("login");
    return;
  }
  const name = authDisplayName();
  if (!name) {
    toast("Sign in to join this group.");
    return;
  }
  const previewGroupId = state.invitePreview?.groupId || state.invitePreview?.group_id;
  const existingGroup = previewGroupId ? state.groups.find(group => group.id === previewGroupId) : null;
  const existingMember = existingGroup ? memberAliasForGroup(existingGroup) : null;
  if (existingGroup && existingMember) {
    state.currentGroupId = existingGroup.id;
    state.activeMember = existingMember;
    state.shell = "app";
    state.view = "dashboard";
    state.inviteToken = null;
    state.invitePreview = null;
    state.inviteError = "";
    localStorage.setItem("probable_user", state.activeMember);
    localStorage.setItem("probable_groupId", state.currentGroupId || "");
    routeToApp({ replace: true });
    normalizeSelection();
    render();
    toast("Opened group.");
    return;
  }
  try {
    const data = await api(`/api/invites/${encodeURIComponent(token)}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setGroups(data.groups);
    state.currentGroupId = data.groupId;
    state.activeMember = memberAliasForGroup(getCurrentGroup()) || data.memberName || name;
    state.shell = "app";
    state.view = "dashboard";
    state.inviteToken = null;
    state.invitePreview = null;
    state.inviteError = "";
    localStorage.setItem("probable_user", state.activeMember);
    localStorage.setItem("probable_groupId", state.currentGroupId || "");
    routeToApp({ replace: true });
    normalizeSelection();
    render();
    toast("Joined group.");
  } catch (err) {
    state.inviteError = err.message || "Could not join this group.";
    render();
    toast(state.inviteError);
  }
}

async function onCreateGroup(e) {
  e.preventDefault();
  if (!requireLogin("create-group")) return;
  const fd = new FormData(e.currentTarget);
  const name = fd.get("name")?.toString().trim() ?? "";
  const emoji = fd.get("emoji")?.toString().trim() || "PX";
  const creator = authDisplayName();
  const members = [creator].filter(Boolean);
  if (!name || !creator) {
    toast("Add a group name.");
    return;
  }
  await createGroup({ name, emoji, members, activeMember: creator, form: e.currentTarget });
  closeModal("group");
}

async function createGroup({ name, emoji, members, activeMember, form }) {
  try {
    const data = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name, emoji, members, mode: "fake", createdBy: activeMember || authDisplayName() }),
    });
    setGroups(data.groups);
    state.currentGroupId = data.groupId ?? state.currentGroupId;
    state.activeMember = activeMember;
    state.shell = "app";
    state.view = "dashboard";
    routeToApp();
    localStorage.setItem("probable_user", state.activeMember);
    localStorage.setItem("probable_groupId", state.currentGroupId || "");
    form?.reset();
    if (form) resetGroupEmoji(form);
    normalizeSelection();
    render();
    toast("Group created.");
  } catch (err) {
    toast(err.message || "Failed to create group.");
  }
}

async function ensureMarketGroup() {
  let group = getCurrentGroup();
  if (group) return group;

  const member = authDisplayName();
  if (!member) throw new Error("Sign in to create markets.");

  const reusableGroup = pickReusableGroup();
  if (reusableGroup) {
    state.currentGroupId = reusableGroup.id;
    state.activeMember = memberAliasForGroup(reusableGroup) ?? member;
    state.shell = "app";
    localStorage.setItem("probable_user", state.activeMember);
    localStorage.setItem("probable_groupId", state.currentGroupId);
    normalizeSelection();
    return getCurrentGroup();
  }

  const data = await api("/api/groups", {
    method: "POST",
    body: JSON.stringify({
      name: "My Markets",
      emoji: "PB",
      members: [member],
      mode: "fake",
      createdBy: member,
    }),
  });
  setGroups(data.groups);
  state.currentGroupId = data.groupId ?? state.currentGroupId;
  state.activeMember = member;
  state.shell = "app";
  state.view = "dashboard";
  localStorage.setItem("probable_user", state.activeMember);
  localStorage.setItem("probable_groupId", state.currentGroupId || "");
  normalizeSelection();
  return getCurrentGroup();
}

function pickReusableGroup() {
  if (!isLoggedIn() || !state.groups.length) return null;
  const savedGroupId = localStorage.getItem("probable_groupId");
  if (savedGroupId) {
    const saved = state.groups.find(group => group.id === savedGroupId);
    if (saved && groupHasCurrentMember(saved)) return saved;
  }
  return state.groups.find(group => groupHasCurrentMember(group) && !isPbMyMarketsGroup(group))
    ?? state.groups.find(groupHasCurrentMember)
    ?? null;
}

async function createMarketForGroup(group, payload) {
  if (!group) throw new Error("Could not find a market room.");
  const data = await api(`/api/groups/${group.id}/markets`, {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      createdBy: authDisplayName() || state.activeMember || "Unknown",
    }),
  });
  setGroups(data.groups);
  if (data.marketId || data.eventId || data.marketIds?.[0]) {
    try {
      await refreshFocusedMarketContext(data.marketId || data.marketIds?.[0] || data.eventId);
    } catch (contextErr) {
      console.warn("Could not refresh market context after create", contextErr);
    }
  }
  return data;
}

async function joinGroup(groupId, myName) {
  const existing = state.groups.find(g => g.id === groupId);
  const existingMember = existing ? memberAliasForGroup(existing) : null;
  if (existingMember) {
    state.currentGroupId = groupId;
    state.activeMember = existingMember;
    state.shell = "app";
    state.view = "dashboard";
    localStorage.setItem("probable_user", state.activeMember);
    localStorage.setItem("probable_groupId", groupId);
    routeToApp({ replace: true });
    normalizeSelection();
    render();
    return;
  }
  try {
    const data = await api(`/api/groups/${groupId}/join`, {
      method: "POST",
      body: JSON.stringify({ name: myName }),
    });
    setGroups(data.groups);
    state.currentGroupId = groupId;
    state.activeMember = memberAliasForGroup(getCurrentGroup()) || data.memberName || myName;
    state.shell = "app";
    state.view = "dashboard";
    localStorage.setItem("probable_user", state.activeMember);
    localStorage.setItem("probable_groupId", groupId);
    routeToApp({ replace: true });
    normalizeSelection();
    render();
    toast(`Joined as ${myName}.`);
  } catch (err) {
    toast(err.message || "Could not join group.");
  }
}

async function onCreateMarket(e) {
  e.preventDefault();
  if (state.pendingUi.marketCreate) return;
  const totalSteps = marketFormTotalSteps();
  if (state.marketFormStep !== totalSteps) {
    await goMarketFormStep(state.marketFormStep + 1);
    return;
  }
  const form = e.currentTarget;
  const fd = new FormData(form);
  const basePayload = marketPayloadFromForm(fd, { includeOddsSeed: true });
  if (!basePayload) return;
  if (!requireLogin("create-market")) return;
  const submit = form.querySelector("[data-market-submit]");
  const payload = {
    ...basePayload,
    category: fd.get("category")?.toString().trim() || "General",
    initialProbability: Number(fd.get("initialProb") || 50) / 100,
    initialLiquidity: Number(fd.get("liquidity") || basePayload.initialLiquidity || defaultMarketLiquidityForOutcomeCount(basePayload.outcomes?.length || 2)),
    oracleType: fd.get("oracle")?.toString() || "ai",
    imageUrl: state.marketImageDataUrl || null,
    slug: marketSlugFor(basePayload.question),
  };

  state.pendingUi.marketCreate = true;
  setButtonPending(submit, true, "Creating");
  try {
    const group = await ensureMarketGroup();
    await createMarketForGroup(group, payload);
    form.reset();
    resetMarketForm();
    closeModal("market");
    state.shell = "app";
    state.view = "dashboard";
    routeToApp();
    normalizeSelection();
    render();
    toast("Market created.");
  } catch (err) {
    toast(err.message || "Failed to create market.");
  } finally {
    state.pendingUi.marketCreate = false;
    setButtonPending(submit, false);
  }
}

function storePendingSharedTrade(marketId, side = "yes", mode = "buy") {
  sessionStorage.setItem("probable_pending_shared_trade", JSON.stringify({ marketId, side, mode }));
}

function takePendingSharedTrade() {
  try {
    const raw = sessionStorage.getItem("probable_pending_shared_trade");
    sessionStorage.removeItem("probable_pending_shared_trade");
    return raw ? JSON.parse(raw) : null;
  } catch {
    sessionStorage.removeItem("probable_pending_shared_trade");
    return null;
  }
}

async function continueSharedMarketTrade() {
  const pending = takePendingSharedTrade();
  if (!pending?.marketId) return;
  await joinSharedMarketAndOpen(pending.marketId, pending.side || "yes", pending.mode || "buy");
}

async function joinSharedMarketAndOpen(marketId, side = "yes", mode = "buy") {
  if (!findMarketForRoute(marketId)) {
    const data = await api(`/api/markets/${encodeURIComponent(marketId)}/context`, { timeoutMs: API_TIMEOUT_MS });
    if (Array.isArray(data.groups)) setGroups(data.groups);
    if (data.group) {
      mergeFocusedGroupContext(data.group);
    } else if (!Array.isArray(data.groups)) {
      setGroups(data.groups);
    }
  }
  let group = findGroupForMarket(marketId);
  let market = findMarketForRoute(marketId, group);
  if (!group || !market) throw new Error("That market link could not be found.");
  const memberName = authDisplayName();
  if (!memberName) throw new Error("Sign in to trade.");
  let resolvedMember = memberAliasForGroup(group);
  if (!resolvedMember) {
    const data = await api(`/api/groups/${group.id}/join`, {
      method: "POST",
      body: JSON.stringify({ name: memberName }),
    });
    setGroups(data.groups);
    group = findGroupForMarket(marketId) || group;
    market = findMarketForRoute(marketId, group) || market;
    resolvedMember = memberAliasForGroup(group) || memberName;
  }
  state.currentGroupId = group.id;
  state.activeMember = resolvedMember;
  state.shell = "app";
  state.view = "dashboard";
  state.sharedMarketId = market.id;
  state.trade = { marketId: market.id, side, mode };
  state.mobileTradeOpen = true;
  localStorage.setItem("probable_user", state.activeMember);
  localStorage.setItem("probable_groupId", group.id);
  localStorage.setItem(STORAGE_KEYS.shell, "app");
  routeToMarket(market.id, { replace: true });
  normalizeSelection();
  render();
}

async function onResolve(market, outcome, options = {}) {
  if (state.pendingUi.resolveMarketId === market.id) return;
  const reasoning = String(options.reasoning || "").trim();
  const button = options.button || null;
  state.pendingUi.resolveMarketId = market.id;
  setButtonPending(button, true, "Resolving");
  try {
    const data = await api(`/api/markets/${market.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        outcome,
        reasoning: reasoning || null,
        resolvedBy: authDisplayName() || state.activeMember || "manual",
        resolverAliases: currentMemberAliases(),
      }),
    });
    setGroups(data.groups);
    delete state.oracleErrors[market.id];
    normalizeSelection();
    render();
    if (data.settlement) {
      toastSettlement(data.settlement, `Resolved ${resolutionOutcomeLabel(market, outcome)}.`);
    } else if (data.resolutionApproval) {
      const approval = data.resolutionApproval;
      const missing = approval.missingResolvers?.length ? ` Waiting on ${approval.missingResolvers.join(" + ")}.` : "";
      const prefix = approval.status === "needs_review" ? "Approval conflict." : "Approval recorded.";
      toast(`${prefix}${missing}`);
    } else {
      toast("Approval recorded.");
    }
  } catch (err) {
    toast(err.message || "Resolve failed.");
  } finally {
    if (state.pendingUi.resolveMarketId === market.id) state.pendingUi.resolveMarketId = null;
    setButtonPending(button, false);
  }
}

async function onEliminateOutcome(market, outcomeId, options = {}) {
  if (state.pendingUi.resolveMarketId === market.id) return;
  const reasoning = String(options.reasoning || "").trim();
  const button = options.button || null;
  state.pendingUi.resolveMarketId = market.id;
  setButtonPending(button, true, "Eliminating");
  try {
    const data = await api(`/api/markets/${market.id}/outcomes/${outcomeId}/eliminate`, {
      method: "POST",
      body: JSON.stringify({
        reasoning: reasoning || null,
        eliminatedBy: authDisplayName() || state.activeMember || "manual",
      }),
    });
    setGroups(data.groups);
    delete state.oracleErrors[market.id];
    normalizeSelection();
    render();
    const title = data.elimination?.outcomeTitle || resolutionOutcomeLabel(market, outcomeId);
    toast(`${title} eliminated. Remaining outcomes repriced.`);
  } catch (err) {
    toast(err.message || "Eliminate failed.");
  } finally {
    if (state.pendingUi.resolveMarketId === market.id) state.pendingUi.resolveMarketId = null;
    setButtonPending(button, false);
  }
}

async function onOracleTrigger(market) {
  toast("Asking AI oracle...");
  try {
    const data = await api(`/api/markets/${market.id}/oracle/trigger`, { method: "POST" });
    setGroups(data.groups);
    delete state.oracleErrors[market.id];
    normalizeSelection();
    render();
    const updated = findMarket(market.id);
    const proposal = updated?.oracleProposal;
    if (data.settlement) {
      toastSettlement(data.settlement, "Oracle resolved market.");
    } else {
      toast(proposal ? `Oracle proposes ${String(proposal.outcomeTitle || proposal.outcome || "review")}.` : "Oracle finished.");
    }
  } catch (err) {
    state.oracleErrors[market.id] = err.message || "AI oracle unavailable.";
    render();
    toast("AI oracle unavailable. Manual fallback shown.");
  }
}

async function onOracleAccept(market) {
  try {
    const data = await api(`/api/markets/${market.id}/oracle/accept`, { method: "POST" });
    setGroups(data.groups);
    normalizeSelection();
    render();
    toastSettlement(data.settlement, "Oracle accepted.");
  } catch (err) {
    toast(err.message || "Accept failed.");
  }
}

async function onOracleDispute(market) {
  try {
    const data = await api(`/api/markets/${market.id}/oracle/dispute`, { method: "POST" });
    setGroups(data.groups);
    normalizeSelection();
    render();
    toast("Oracle disputed. Manual controls enabled.");
  } catch (err) {
    toast(err.message || "Dispute failed.");
  }
}

async function onOracleVote(market, outcome) {
  if (!state.activeMember) {
    toast("Select a member first.");
    return;
  }
  try {
    const data = await api(`/api/markets/${market.id}/oracle/vote`, {
      method: "POST",
      body: JSON.stringify({ participant: state.activeMember, outcome }),
    });
    setGroups(data.groups);
    normalizeSelection();
    render();
    const updated = findMarket(market.id);
    if (data.settlement) {
      toastSettlement(data.settlement, "Vote resolved market.");
    } else {
      toast(updated?.status === "resolved" ? `Vote resolved ${resolutionOutcomeLabel(updated, updated.outcome)}.` : `Vote recorded: ${resolutionOutcomeLabel(market, outcome)}.`);
    }
  } catch (err) {
    toast(err.message || "Vote failed.");
  }
}

function render() {
  destroyCharts();
  updateSuggestPreviewModal();
  const waitingForInitialAppData = state.shell === "app" && !state.loaded && (state.currentGroupId || isLoggedIn() || state.sharedMarketId || shouldHoldAppShell());
  const unresolvedMarketLink = Boolean(state.sharedMarketId && !findMarketForRoute(state.sharedMarketId));
  if (state.shell === "app" && state.view !== "bracket" && state.view !== "plPredictor" && !getCurrentGroup() && !waitingForInitialAppData && !unresolvedMarketLink && !state.bootError) {
    enterWelcomeShell();
  }
  renderNav();
  persistNavigationState();
  if (state.shell === "embed") {
    renderEmbedRoute();
  } else if (state.shell === "app" && !state.loaded && !getCurrentGroup()) {
    renderMarketLinkLoading();
  } else if (state.shell === "app" && state.view !== "bracket" && state.view !== "plPredictor" && (state.bootError || unresolvedMarketLink)) {
    renderMarketLinkLoading({ error: state.bootError || state.marketLinkError || "That market link could not be found." });
  } else if (state.shell === "invite") {
    renderInvitePreview();
  } else if (state.shell !== "app") {
    renderEmptyDashboard();
  } else if (state.view === "leaderboard") {
    renderLeaderboard();
  } else if (state.view === "admin") {
    renderAdminVerification();
  } else if (state.view === "positions") {
    renderPositions();
  } else if (state.view === "bracket") {
    renderBracketChallenge();
  } else if (state.view === "plPredictor") {
    renderPremierLeaguePredictor();
  } else {
    renderDashboard();
  }
  requestAnimationFrame(() => {
    renderCharts();
    animateIn();
    hydrateWelcomeVideos();
    if (state.demoMode) tutorialOnRender();
  });
}

function renderNav() {
  document.querySelector("#topnav").style.display = state.shell === "embed" ? "none" : "";
  const navGroups = visibleNavGroups();
  const inApp = state.shell === "app";
  const hasGroups = inApp && isLoggedIn() && navGroups.length > 0;
  dom.navSep.style.display = hasGroups ? "" : "none";
  dom.groupTabs.innerHTML = hasGroups
    ? `<button class="group-add-btn" type="button" data-group-id="__new" aria-label="Add from general pool">+</button>` + navGroups.map(g => `<button class="group-tab ${g.id === getCurrentGroup()?.id && state.view === "dashboard" ? "active" : ""}" type="button" data-group-id="${g.id}">${esc(g.emoji)} ${esc(g.name)}</button>`).join("")
    : "";

  const group = inApp && isLoggedIn() ? getCurrentGroup() : null;
  const displayName = authDisplayName() || state.activeMember || "User";
  const balance = group?.balances?.[state.activeMember] ?? 0;

  dom.navRight.innerHTML = group ? `
    <div class="member-pill" title="${esc(displayName)}">
      <span class="member-name">${esc(displayName)}</span>
      <span class="member-balance">${topbarMoney(balance)}</span>
    </div>
    ${accountIndicatorHtml()}
  ` : `
    <button class="btn btn-primary btn-sm nav-enter" type="button" data-enter-app>Enter app</button>
    ${accountIndicatorHtml()}
	  `;
}

function hydrateWelcomeVideos() {
  if (!document.querySelector(".welcome-hero")) return;
  const load = () => {
    if (!document.querySelector(".welcome-hero")) return;
    document.querySelectorAll(".welcome-video-tile video[data-src]").forEach(video => {
      video.src = video.dataset.src;
      video.removeAttribute("data-src");
      video.load();
      video.play?.().catch(() => {});
    });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(load, { timeout: 1200 });
  } else {
    window.setTimeout(load, 700);
  }
}

function visibleNavGroups() {
  if (state.shell !== "app" || !isLoggedIn()) return [];
  return selectableNavGroups();
}

function selectableNavGroups() {
  const activeId = state.currentGroupId;
  const byLabel = new Map();
  state.groups.filter(group => group.id !== DEMO_GROUP_ID && groupHasCurrentMember(group) && !isPbMyMarketsGroup(group)).forEach(group => {
    const key = `${String(group.emoji || "").trim().toLowerCase()}::${String(group.name || "").trim().toLowerCase()}`;
    const current = byLabel.get(key);
    if (!current || groupNavSortScore(group, activeId) > groupNavSortScore(current, activeId)) byLabel.set(key, group);
  });
  return [...byLabel.values()].sort((a, b) => groupNavSortScore(b, activeId) - groupNavSortScore(a, activeId));
}

function groupNavSortScore(group, activeId = state.currentGroupId) {
  if (!group) return -1;
  const markets = group.markets ?? [];
  const openMarkets = new Set(markets.filter(market => market.status === "open").map(market => market.eventId || market.id)).size;
  const marketCount = new Set(markets.map(market => market.eventId || market.id)).size;
  const createdAt = Date.parse(group.createdAt || "") || 0;
  return (group.id === activeId ? 1_000_000_000 : 0) + openMarkets * 10_000 + marketCount * 1_000 + createdAt / 1_000_000_000;
}

function firstSelectableGroup() {
  return selectableNavGroups()[0] ?? state.groups.find(group => groupHasCurrentMember(group) && !isPbMyMarketsGroup(group)) ?? state.groups.find(groupHasCurrentMember) ?? null;
}

function readGroupAddons() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.groupAddons);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeGroupAddons(addons) {
  try {
    localStorage.setItem(STORAGE_KEYS.groupAddons, JSON.stringify(addons));
  } catch {
    // Local-only affordance; failing to persist should not block the app.
  }
}

function groupAddonIds(groupId) {
  const raw = readGroupAddons()[groupId] || [];
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

function addGeneralMarketToGroup(groupId, addonId) {
  const addons = readGroupAddons();
  const ids = new Set(Array.isArray(addons[groupId]) ? addons[groupId] : []);
  ids.add(addonId);
  addons[groupId] = [...ids];
  writeGroupAddons(addons);
}

function generalMarketsForGroup(group) {
  if (!group?.id) return [];
  const ids = new Set(groupAddonIds(group.id));
  return GENERAL_MARKET_POOL.filter(item => ids.has(item.id));
}

function openGeneralMarketPoolModal() {
  renderGeneralMarketPoolModal();
  openModal("generalMarket");
}

function openGeneralMarketStartModal() {
  renderGeneralMarketStartModal();
  openModal("generalMarket");
}

function renderGeneralMarketStartModal() {
  const group = getCurrentGroup();
  const groupLabel = group ? `${group.emoji || ""} ${group.name}`.trim() : "your group";
  dom.generalMarketModalOverlay.querySelector(".modal-title").textContent = "Add";
  dom.generalMarketModalBody.innerHTML = `
    <div class="general-market-intro">
      <p class="eyebrow">Add to ${esc(groupLabel)}</p>
      <h2>What are we adding?</h2>
      <p>Start a custom market, add a shared market, or create another group.</p>
    </div>
    <div class="general-market-choice-grid">
      <button class="general-market-choice" type="button" data-new-market>
        <span aria-hidden="true">✦</span>
        <strong>Custom market</strong>
        <em>Write your own question.</em>
      </button>
      <button class="general-market-choice" type="button" data-show-general-market-pool>
        <span aria-hidden="true">🏆</span>
        <strong>General markets</strong>
        <em>Bracket and shared contests.</em>
      </button>
      <button class="general-market-choice" type="button" data-create-group>
        <span aria-hidden="true">＋</span>
        <strong>New group</strong>
        <em>Spin up a new room.</em>
      </button>
    </div>
  `;
}

function renderGeneralMarketPoolModal() {
  const group = getCurrentGroup();
  const groupLabel = group ? `${group.emoji || ""} ${group.name}`.trim() : "your group";
  dom.generalMarketModalOverlay.querySelector(".modal-title").textContent = "General markets";
  dom.generalMarketModalBody.innerHTML = `
    <div class="general-market-intro">
      <p class="eyebrow">Reusable markets</p>
      <h2>Add shared experiences to ${esc(groupLabel)}</h2>
      <p>Pull in contests and global markets without recreating them for every group.</p>
    </div>
    <div class="general-market-list">
      ${GENERAL_MARKET_POOL.map(item => generalMarketPoolRow(item, group)).join("")}
    </div>
    <div class="general-market-footer">
      <button class="btn btn-ghost" type="button" data-add-menu-back>Back</button>
      <button class="btn btn-ghost" type="button" data-create-group>Create new group</button>
      <button class="btn btn-ghost" type="button" data-new-market>Custom market</button>
    </div>
  `;
}

function generalMarketPoolRow(item, group) {
  const added = group?.id ? groupAddonIds(group.id).includes(item.id) : false;
  const icon = item.type === "league-predictor" && item.logoUrl
    ? `<img src="${esc(item.logoUrl)}" alt="" loading="lazy" />`
    : esc(item.type === "league-predictor" ? item.leagueMark : "🏆");
  return `
    <article class="general-market-pool-row">
      <div class="general-market-pool-icon" aria-hidden="true">${icon}</div>
      <div class="general-market-pool-copy">
        <p>${esc(item.eyebrow)}</p>
        <h3>${esc(item.title)}</h3>
        <span>${esc(item.subtitle)} ${esc(item.prize)} prize.</span>
      </div>
      <button class="btn ${added ? "btn-ghost" : "btn-primary"} btn-sm" type="button" data-add-general-market="${esc(item.id)}" ${added ? "disabled" : ""}>
        ${added ? "Added" : "Add"}
      </button>
    </article>
  `;
}

function premierLeagueClubById(id) {
  return activeLeaguePredictor().clubs.find(club => club.id === id) || null;
}

function normalizePremierLeagueRanking(ranking) {
  const valid = new Set(activeLeaguePredictor().clubs.map(club => club.id));
  const seen = new Set();
  const cleaned = [];
  (Array.isArray(ranking) ? ranking : []).forEach(id => {
    const value = String(id || "").trim();
    if (valid.has(value) && !seen.has(value)) {
      cleaned.push(value);
      seen.add(value);
    }
  });
  return cleaned;
}

function loadPremierLeagueDraftIntoState() {
  if (state.plRemoteLoaded) return;
  try {
    const raw = localStorage.getItem(leaguePredictorDraftKey());
    const parsed = raw ? JSON.parse(raw) : {};
    const savedRanking = parsed.mode === "sequential" || parsed.submitted
      ? parsed.ranking
      : state.plRanking;
    state.plRanking = normalizePremierLeagueRanking(savedRanking || []);
    state.plSubmitted = Boolean(parsed.submitted && !state.plRemoteLoaded);
    state.plEntryId = state.plEntryId || parsed.entryId || "";
  } catch {
    state.plRanking = normalizePremierLeagueRanking(state.plRanking);
  }
}

function savePremierLeagueDraft() {
  localStorage.setItem(leaguePredictorDraftKey(), JSON.stringify({
    ranking: normalizePremierLeagueRanking(state.plRanking),
    mode: "sequential",
    submitted: state.plSubmitted,
    entryId: state.plEntryId,
    updatedAt: new Date().toISOString(),
  }));
}

function premierLeaguePredictorLocked() {
  return Date.now() >= Date.parse(activeLeaguePredictor().lockAt);
}

function premierLeagueZone(rank) {
  const zone = activeLeaguePredictor().zones.find(item => rank >= item.from && rank <= item.to);
  if (zone) return zone;
  return { label: "Mid-table", className: "mid" };
}

function premierLeagueOrdinal(rank) {
  const suffix = rank % 10 === 1 && rank % 100 !== 11 ? "st" : rank % 10 === 2 && rank % 100 !== 12 ? "nd" : rank % 10 === 3 && rank % 100 !== 13 ? "rd" : "th";
  return `${rank}${suffix}`;
}

function selectPremierLeagueClub(clubId) {
  if (premierLeaguePredictorLocked()) {
    toast("Predictor is locked.");
    return;
  }
  const ranking = normalizePremierLeagueRanking(state.plRanking);
  const club = premierLeagueClubById(clubId);
  if (!club || ranking.includes(club.id) || ranking.length >= activeLeaguePredictor().clubs.length) return;
  ranking.push(club.id);
  state.plRanking = ranking;
  state.plSubmitted = false;
  savePremierLeagueDraft();
}

function clearPremierLeaguePosition(index) {
  if (premierLeaguePredictorLocked()) {
    toast("Predictor is locked.");
    return;
  }
  const ranking = normalizePremierLeagueRanking(state.plRanking);
  if (!Number.isInteger(index) || index < 0 || index >= ranking.length) return;
  ranking.splice(index, 1);
  state.plRanking = ranking;
  state.plSubmitted = false;
  savePremierLeagueDraft();
}

function undoPremierLeaguePick() {
  if (premierLeaguePredictorLocked()) {
    toast("Predictor is locked.");
    return;
  }
  const ranking = normalizePremierLeagueRanking(state.plRanking);
  if (!ranking.length) return;
  ranking.pop();
  state.plRanking = ranking;
  state.plSubmitted = false;
  savePremierLeagueDraft();
}

function premierLeagueClubBadge(club, small = false) {
  const light = ["#ffffff", "#ffcd00", "#f6a800", "#95bfe5", "#77bbff", "#6cabdd"].includes(String(club.color || "").toLowerCase());
  return `
    <span class="pl-club-badge ${small ? "small" : ""}" style="--club-color:${esc(club.color)};--club-fg:${light ? "#061018" : "#fff"}">
      <img src="${esc(club.logoUrl || "")}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid';" />
      <span>${esc(club.shortName.slice(0, 1))}</span>
    </span>`;
}

function renderPremierLeaguePredictor() {
  const predictor = activeLeaguePredictor();
  loadPremierLeagueDraftIntoState();
  state.plRanking = normalizePremierLeagueRanking(state.plRanking);
  const locked = premierLeaguePredictorLocked();
  const status = locked ? "Locked" : state.plSubmitted ? "Submitted" : "Draft";
  const picked = new Set(state.plRanking);
  const nextRank = Math.min(state.plRanking.length + 1, activeLeaguePredictor().clubs.length);
  const complete = state.plRanking.length === activeLeaguePredictor().clubs.length;
  const lockLabel = new Date(activeLeaguePredictor().lockAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  dom.mainContent.innerHTML = `
    <section class="pl-predictor-page">
      <header class="pl-predictor-hero motion-item">
        <div class="pl-predictor-identity">
          ${predictor.logoUrl
            ? `<img class="pl-league-logo" src="${esc(predictor.logoUrl)}" alt="${esc(predictor.leagueName)}" />`
            : `<div class="pl-league-wordmark" aria-label="${esc(predictor.leagueName)}">${esc(predictor.leagueMark)}</div>`}
          <span class="pl-identity-divider" aria-hidden="true"></span>
          <div>
            <p class="eyebrow">Probable challenge · ${esc(activeLeaguePredictor().season)}</p>
            <h1>Predict the table</h1>
            <p class="pl-predictor-subtitle">Pick your champion first, then fill the table one club at a time.</p>
          </div>
        </div>
        <div class="pl-predictor-actions">
          <div class="pl-status ${locked ? "locked" : ""}">
            <span>${esc(status)}</span>
            <small>Locks ${esc(lockLabel)}</small>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-share-pl-predictor>Share</button>
          <button class="btn btn-ghost btn-sm" type="button" data-pl-reset ${locked ? "disabled" : ""}>Reset</button>
          <button class="btn btn-primary btn-sm" type="button" data-pl-submit ${state.plSaving || locked || !complete ? "disabled" : ""}>${state.plSaving ? "Saving..." : state.plSubmitted ? "Save changes" : "Submit"}</button>
        </div>
      </header>

      <div class="pl-pick-layout motion-item">
        <div class="pl-ranking-shell">
          <div class="pl-table-titlebar">
            <div>
              <p>Your prediction</p>
              <strong>Final table</strong>
            </div>
            <span>${state.plRanking.length} of ${activeLeaguePredictor().clubs.length} picked</span>
          </div>
          <div class="pl-ranking-head">
            <span>Pos</span>
            <span>Club</span>
            <span></span>
          </div>
          <div class="pl-ranking-list">
            ${Array.from({ length: activeLeaguePredictor().clubs.length }, (_, index) => premierLeagueRankingRow(state.plRanking[index] || "", index, { locked, current: index === state.plRanking.length })).join("")}
          </div>
          <div class="pl-zone-strip">
            ${predictor.zones.map(zone => `<span class="${esc(zone.className)}">${zone.from === zone.to ? zone.from : `${zone.from}-${zone.to}`} ${esc(zone.label)}</span>`).join("")}
          </div>
        </div>

        <aside class="pl-club-picker" aria-label="Available ${esc(predictor.leagueName)} clubs">
          <div class="pl-club-picker-head">
            <div>
              <p class="eyebrow">${complete ? "Table complete" : `Pick ${esc(premierLeagueOrdinal(nextRank))}`}</p>
              <h2>${complete ? "Review your table" : "Choose a club"}</h2>
            </div>
            <button type="button" data-pl-undo ${locked || !state.plRanking.length ? "disabled" : ""}>Undo</button>
          </div>
          <div class="pl-pick-progress" aria-label="${state.plRanking.length} of ${activeLeaguePredictor().clubs.length} clubs picked">
            <span style="width:${(state.plRanking.length / activeLeaguePredictor().clubs.length) * 100}%"></span>
          </div>
          <div class="pl-club-picker-grid">
            ${activeLeaguePredictor().clubs.map(club => {
              const selected = picked.has(club.id);
              return `
                <button class="pl-club-choice ${selected ? "selected" : ""}" type="button"
                  data-pl-club-pick="${esc(club.id)}"
                  aria-label="${selected ? `${esc(club.name)} already picked` : `Pick ${esc(club.name)} ${esc(premierLeagueOrdinal(nextRank))}`}"
                  title="${esc(club.name)}" ${locked || selected || complete ? "disabled" : ""}>
                  ${premierLeagueClubBadge(club)}
                  <span>${esc(club.shortName)}</span>
                  ${selected ? '<i aria-hidden="true">✓</i>' : ""}
                </button>`;
            }).join("")}
          </div>
          <p class="pl-picker-note">${complete ? "Every club has a position. Check the table before submitting." : "Select clubs in the exact order you think they will finish."}</p>
        </aside>
      </div>
      <p class="pl-attribution">${esc(predictor.leagueName)} club marks are used for identification. Club list verified against the official league source.</p>
    </section>
  `;
}

function premierLeagueRankingRow(clubId, index, { locked = false, current = false } = {}) {
  const club = clubId ? premierLeagueClubById(clubId) : null;
  const rank = index + 1;
  const zone = premierLeagueZone(rank);
  return `
    <article class="pl-ranking-row ${zone.className} ${club ? "filled" : "empty"} ${current ? "current" : ""}">
      <div class="pl-rank-number">${rank}</div>
      ${club ? `
        <div class="pl-club-main">
          ${premierLeagueClubBadge(club)}
          <div>
            <strong>${esc(club.name)}</strong>
            <small>${esc(club.shortName)}</small>
          </div>
        </div>
        <button class="pl-clear-pick" type="button" aria-label="Remove ${esc(club.name)}" data-pl-clear-position="${index}" ${locked ? "disabled" : ""}>×</button>
      ` : `
        <div class="pl-empty-club">${current ? `Choose the ${esc(premierLeagueOrdinal(rank))} place club` : "—"}</div>
        <span></span>
      `}
    </article>
  `;
}

async function loadRemotePremierLeagueEntry({ refresh = false } = {}) {
  if (!isLoggedIn() && !state.plSharedEntryId) return;
  if (state.plRemoteLoaded && !refresh) return;
  const params = new URLSearchParams();
  if (state.plSharedEntryId) params.set("entry", state.plSharedEntryId);
  else params.set("participant", authDisplayName());
  const data = await api(`/api/predictors/${activeLeaguePredictor().id}/entry?${params.toString()}`);
  if (data.entry?.ranking?.length) {
    state.plRanking = normalizePremierLeagueRanking(data.entry.ranking);
    state.plEntryId = data.entry.id || "";
    state.plSubmitted = Boolean(data.entry.submittedAt);
    state.plRemoteLoaded = true;
    savePremierLeagueDraft();
    render();
  } else {
    state.plRemoteLoaded = true;
  }
}

async function submitPremierLeagueEntry() {
  if (premierLeaguePredictorLocked()) {
    toast("Predictor is locked.");
    return;
  }
  state.plRanking = normalizePremierLeagueRanking(state.plRanking);
  savePremierLeagueDraft();
  if (state.plRanking.length !== activeLeaguePredictor().clubs.length) {
    toast(`Pick all ${activeLeaguePredictor().clubs.length} clubs before submitting.`);
    return;
  }
  if (!isLoggedIn()) {
    sessionStorage.setItem("probable_pending_predictor_id", activeLeaguePredictor().id);
    requireLogin("submit-pl-predictor");
    return;
  }
  state.plSaving = true;
  renderPremierLeaguePredictor();
  try {
    const data = await api(`/api/predictors/${activeLeaguePredictor().id}/entry`, {
      method: "POST",
      body: JSON.stringify({
        participant: authDisplayName(),
        userEmail: state.authUser?.email || null,
        ranking: state.plRanking,
        submitted: true,
      }),
    });
    state.plEntryId = data.entry?.id || state.plEntryId;
    state.plSubmitted = Boolean(data.entry?.submittedAt);
    state.plRemoteLoaded = true;
    savePremierLeagueDraft();
    toast(`${activeLeaguePredictor().leagueName} table saved.`);
  } catch (err) {
    toast(err.message || "Could not save predictor.");
  } finally {
    state.plSaving = false;
    renderPremierLeaguePredictor();
  }
}

function premierLeagueShareUrl() {
  const base = `${location.origin}${activeLeaguePredictor().route}`;
  return state.plEntryId ? `${base}?entry=${encodeURIComponent(state.plEntryId)}` : base;
}

function premierLeagueShareCardUrl() {
  const params = new URLSearchParams();
  if (state.plEntryId) params.set("entry", state.plEntryId);
  else if (authDisplayName()) params.set("participant", authDisplayName());
  params.set("t", String(Date.now()));
  return `${API}/api/predictors/${activeLeaguePredictor().id}/share-card.png?${params.toString()}`;
}

async function openPremierLeagueShareModal() {
  openModal("embed");
  dom.embedModalOverlay.querySelector(".modal-title").textContent = `Share ${activeLeaguePredictor().leagueName} predictor`;
  const link = premierLeagueShareUrl();
  dom.embedModalBody.innerHTML = `
    <div class="embed-share-layout pl-share-layout">
      <div class="embed-preview-frame share-og-preview-frame pl-share-preview-frame">
        <img class="share-og-preview-img" src="${esc(premierLeagueShareCardUrl())}" alt="${esc(activeLeaguePredictor().leagueName)} table share preview" />
      </div>
      <div class="embed-share-controls">
        <div class="share-section">
          <p class="eyebrow">Predictor link</p>
          <h3>Share your table</h3>
          <div class="invite-link-box">
            <span>${esc(link)}</span>
            <button type="button" data-copy-pl-link>Copy</button>
          </div>
          <div class="share-action-grid">
            <button class="btn btn-primary" type="button" data-copy-pl-link>Copy link</button>
            <button class="btn btn-ghost" type="button" data-native-share-pl>Share</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function copyPremierLeagueLink() {
  const link = premierLeagueShareUrl();
  const copied = await writeClipboardText(link);
  toast(copied ? "Predictor link copied." : link);
}

async function sharePremierLeagueLink() {
  const link = premierLeagueShareUrl();
  if (!navigator.share) {
    await copyPremierLeagueLink();
    return;
  }
  try {
    await navigator.share({
      title: activeLeaguePredictor().title,
      text: `My ${activeLeaguePredictor().leagueName} table prediction`,
      url: link,
    });
  } catch (err) {
    if (err?.name !== "AbortError") toast("Could not open share sheet.");
  }
}

function accountIndicatorHtml() {
  if (isLoggedIn()) {
    return `
      <div class="account-menu" data-account-menu>
        <button class="account-avatar" type="button" data-account-toggle aria-label="Account" aria-expanded="${state.accountMenuOpen ? "true" : "false"}">${esc(authInitials())}</button>
        ${state.accountMenuOpen ? `
          <div class="account-popover">
            <button class="account-popover-name" type="button" data-open-positions>My Portfolio</button>
            <button type="button" data-open-admin>Admin verify</button>
            <button type="button" data-demo-replay>How it works</button>
            <button type="button" data-account-signout>Sign out</button>
          </div>` : ""}
      </div>`;
  }
  return `<button class="btn btn-ghost btn-sm nav-signin" type="button" data-login>Sign in</button>`;
}

function renderAccountMenuOnly() {
  const accountMenu = document.querySelector("[data-account-menu]");
  if (accountMenu) {
    accountMenu.outerHTML = accountIndicatorHtml();
    return;
  }
  const signin = document.querySelector("[data-login].nav-signin");
  if (signin) signin.outerHTML = accountIndicatorHtml();
}

function authInitials() {
  const label = authDisplayName();
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] || "U") + (parts[1]?.[0] || "");
}

function avatarText(name) {
  const parts = String(name || "User").split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "U") + (parts[1]?.[0] || "")).toUpperCase();
}

function leaderLevel(entry) {
  if (entry.bal >= DEFAULT_BALANCE + 1000) return "Level 5";
  if (entry.bal >= DEFAULT_BALANCE + 500) return "Level 4";
  if (entry.bal >= DEFAULT_BALANCE) return "Level 3";
  if (entry.bal >= DEFAULT_BALANCE - 500) return "Level 2";
  return "Level 1";
}

function suggestedQuestionsHtml() {
  const loading = state.pendingUi.suggestions;
  const questions = state.questionSuggestions;
  if (!loading && !questions.length) return "";
  const chipsHtml = loading
    ? `<div class="suggest-skeleton-row">
        <span class="suggest-skeleton"></span>
        <span class="suggest-skeleton"></span>
        <span class="suggest-skeleton"></span>
        <span class="suggest-skeleton"></span>
      </div>`
    : questions.map((q, i) =>
        `<button class="suggest-chip" type="button" data-suggestion-chip data-suggestion-index="${i}">${esc(q)}</button>`
      ).join("");
  return `
    <div class="suggest-panel motion-item">
      <div class="suggest-panel-head">
        <p class="eyebrow">Suggested questions</p>
        <button class="btn-icon" type="button" data-refresh-suggestions aria-label="Refresh suggestions">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1 7a6 6 0 1 0 1.2-3.6"/><path d="M1 2v2.4h2.4"/>
          </svg>
        </button>
      </div>
      <div class="suggest-chips">${chipsHtml}</div>
    </div>
  `;
}

function updateSuggestPreviewModal() {
  const preview = state.pendingUi.suggestionPreview;
  if (!dom.suggestPreviewQuestion || !dom.suggestPreviewRules) return;
  if (!preview) return;
  dom.suggestPreviewQuestion.textContent = preview.question || "";
  if (preview.loading) {
    dom.suggestPreviewRules.innerHTML = `<p class="suggest-rules-loading">✨ Drafting rules…</p>`;
  } else if (preview.rules) {
    dom.suggestPreviewRules.innerHTML = `<pre class="suggest-rules-text">${esc(preview.rules)}</pre>`;
  } else {
    dom.suggestPreviewRules.innerHTML = "";
  }
}

function renderDashboard() {
  const group = getCurrentGroup();
  if (!group) {
    renderEmptyDashboard();
    return;
  }

  const markets = group.markets;
  const activeMarket = state.trade.marketId ? findMarket(state.trade.marketId) : null;
  if (activeMarket && markets.some(market => market.id === activeMarket.id)) {
    renderFocusedTradeView(group, activeMarket, findEventForMarket(group, activeMarket));
    return;
  }

  const activeStatus = state.marketStatus === "closed" ? "closed" : "open";
  const allEvents = marketEvents(markets);
  const groupGeneralMarkets = generalMarketsForGroup(group);
  const generalCards = activeStatus === "open" ? groupGeneralMarkets : [];
  const open = allEvents.filter(event => eventStatus(event) === "open").length + groupGeneralMarkets.length;
  const closed = allEvents.filter(event => eventStatus(event) !== "open").length;
  const visibleMarkets = dashboardVisibleMarkets(markets);
  const events = sortedMarketEvents(visibleMarkets);

  dom.mainContent.innerHTML = `
    <section class="dashboard-shell">
      <div class="dashboard-head motion-item">
        <div>
          <p class="eyebrow">${esc(group.emoji)} ${group.members.length} members</p>
          <h1 class="group-title-line">
            <span>${esc(group.name)}</span>
            <span class="group-counts">
              <button class="group-count group-count-open ${activeStatus === "open" ? "active" : ""}" type="button" data-market-status-filter="open">${open} open</button>
              <button class="group-count group-count-closed ${activeStatus === "closed" ? "active" : ""}" type="button" data-market-status-filter="closed">${closed} closed</button>
            </span>
          </h1>
        </div>
        <div class="dashboard-head-actions">
          <button class="btn btn-primary btn-sm" type="button" data-new-market>+ Market</button>
          <button class="btn btn-ghost btn-sm invite-friends-btn" type="button" data-open-invite="${group.id}">
            <span class="share-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" focusable="false">
                <path d="M7.2 11.4 12.8 14.6M12.8 5.4 7.2 8.6" />
                <circle cx="5" cy="10" r="2.4" />
                <circle cx="15" cy="4.2" r="2.4" />
                <circle cx="15" cy="15.8" r="2.4" />
              </svg>
            </span>
            Invite friends
          </button>
        </div>
      </div>

      <div class="dashboard-layout">
        <section class="market-column">
          <div class="section-row motion-item">
            <div>
              <p class="eyebrow">Markets</p>
              <h2>Price board</h2>
            </div>
            ${marketSortControl()}
          </div>
          ${(visibleMarkets.length || generalCards.length) ? `<div class="market-grid" data-market-grid>${generalCards.map(generalMarketCard).join("")}${events.map(event => eventCard(event)).join("")}</div>` : emptyMarketsHtml(activeStatus)}
        </section>

        <aside class="side-panel motion-item">
          ${leaderboardPanel(group, { limit: compactLeaderboardLimit(), compact: true })}
          ${suggestedQuestionsHtml()}
        </aside>
      </div>
    </section>
  `;
}

function generalMarketCard(item) {
  if (item.type === "bracket") {
    return `
      <article class="event-card general-market-card motion-item" data-go-bracket>
        <div class="event-card-inner">
          <div class="event-card-head">
            <div class="event-thumb event-thumb-image" aria-hidden="true">🏆</div>
            <div class="event-title-wrap">
              <p class="event-title">${esc(item.title)}</p>
            </div>
            <span class="general-market-badge">General</span>
          </div>
          <div class="general-market-card-body">
            <strong>${esc(item.prize)} prize</strong>
            <span>${esc(item.subtitle)}</span>
          </div>
          <div class="event-card-foot">
            <span>Bracket contest</span>
            <span class="event-card-creator">from general pool</span>
          </div>
        </div>
      </article>
    `;
  }
  if (item.type === "league-predictor") {
    return `
      <article class="event-card general-market-card motion-item" data-go-league-predictor="${esc(item.predictorId)}">
        <div class="event-card-inner">
          <div class="event-card-head">
            <div class="event-thumb event-thumb-image general-league-mark" aria-hidden="true">
              ${item.logoUrl ? `<img src="${esc(item.logoUrl)}" alt="" loading="lazy" />` : esc(item.leagueMark)}
            </div>
            <div class="event-title-wrap">
              <p class="event-title">${esc(item.title)}</p>
            </div>
            <span class="general-market-badge">General</span>
          </div>
          <div class="general-market-card-body">
            <strong>Rank the table</strong>
            <span>${esc(item.subtitle)}</span>
          </div>
          <div class="event-card-foot">
            <span>Season contest</span>
            <span class="event-card-creator">from general pool</span>
          </div>
        </div>
      </article>
    `;
  }
  return "";
}

function renderFocusedTradeView(group, market, event) {
  const eventTitle = event?.title || sampleEventTitle(market);
  const tradeMarket = market;
  const sharedLanding = state.sharedMarketId === market.id && !isLoggedIn();
  const prob = Number(tradeMarket.probability ?? 0.5);
  const yesPrice = prob.toFixed(2);
  const noPrice = (1 - prob).toFixed(2);
  const allOutcomeMarkets = event?.markets?.length ? event.markets : [market];
  const sortedMarkets = focusedOutcomeMarkets(allOutcomeMarkets, event);
  const outcomeToggleKey = event?.key || market.eventId || market.id;
  const outcomesExpanded = state.expandedOutcomeEvents.has(outcomeToggleKey);
  const visibleOutcomeMarkets = focusedVisibleOutcomeMarkets(sortedMarkets, tradeMarket.id, outcomesExpanded);
  const leadingMarkets = chartMarketsForEvent(event || { markets: sortedMarkets });
  dom.mainContent.innerHTML = `
    <section class="dashboard-shell focused-market-shell ${sharedLanding ? "shared-market-shell" : ""}">
      <div class="focused-market-nav motion-item">
        <button class="focused-back" type="button" data-close-trade>&larr; Back to markets</button>
        <div class="focused-market-nav-actions">
          <button class="market-page-share" type="button" data-share-market="${esc(market.id)}" aria-label="Share market">
            ${shareArrowIconSvg()}
            <span>Share</span>
          </button>
        </div>
      </div>

      <div class="focused-market-stage motion-item">
        <section class="focused-event-board" data-event-chart="${esc(event.key)}">
          <div class="focused-event-head">
            <div class="event-thumb ${eventThumbClass(eventTitle, event.imageUrl)} focused-event-thumb" aria-hidden="true">${eventThumb(eventTitle, event.imageUrl)}</div>
            <div>
              <p class="focused-event-kicker">${esc(marketContextLabel(group, market, event))}</p>
              <h1>${esc(eventTitle)}</h1>
            </div>
          </div>

          <div class="focused-event-legend" aria-label="Top outcomes">
            ${leadingMarkets.map((item, index) => focusedLegendItem(item, index, event)).join("")}
          </div>

          <span class="focused-chart-watermark">probable</span>
          <div class="focused-chart-shell">
            <canvas data-event-chart-canvas="${esc(event.key)}" aria-label="${esc(eventTitle)} probability history"></canvas>
            ${tradeMarket.status === "open" ? `<button class="mobile-trade-fab" type="button" data-mobile-trade-toggle>${tradeFabIconSvg()}<span>Trade</span></button>` : ""}
          </div>

          <div class="focused-chart-meta">
            <span>${compactMoney(event.volume)} Vol.</span>
            <span>${fmtClose({ closesAt: event.closesAt, status: eventStatus(event) })}</span>
            <span class="focused-range active">ALL</span>
          </div>

          <div class="focused-outcome-table">
            ${visibleOutcomeMarkets.map((item, index) => focusedOutcomeRow(item, tradeMarket.id, sortedMarkets.indexOf(item), event)).join("")}
            ${focusedOutcomeToggle(sortedMarkets, visibleOutcomeMarkets, outcomeToggleKey, outcomesExpanded)}
          </div>

          ${sharedLanding ? `
            <div class="shared-market-note">
              <strong>Pick a side to trade.</strong>
              <span>Sign in once, join ${esc(group.name)}, and the trade ticket opens automatically.</span>
            </div>
          ` : `
            ${marketHistoryPanel(tradeMarket, event)}
            ${focusedRulesPanel(tradeMarket, event)}
            ${marketParticipants(tradeMarket, event)}
          `}
        </section>

        ${tradeMarket.status === "open" ? `
          <div class="mobile-trade-sheet ${state.mobileTradeOpen ? "open" : ""}">
            <div class="mobile-trade-sheet-backdrop" data-mobile-trade-close></div>
            <div class="mobile-trade-sheet-panel">
              <button class="mobile-trade-sheet-close" type="button" data-mobile-trade-close aria-label="Close">×</button>
              ${tradePanel(tradeMarket, yesPrice, noPrice, event)}
            </div>
          </div>
        ` : `
          <aside class="trade-panel closed-trade-note">
            <strong>${tradeMarket.status === "resolved" ? "Resolved market" : "Market closed"}</strong>
            <p>Trading is closed for this market.</p>
          </aside>
        `}
      </div>
    </section>
  `;
}

function marketParticipantStats(market, event) {
  const allMarkets = event?.markets ?? [market];
  const positions = market.positions ?? {};

  const findOutcome = outcomeId => {
    for (const m of allMarkets) {
      const found = (m.outcomes ?? []).find(o => o.id === outcomeId);
      if (found) return found;
    }
    return null;
  };

  const stats = [];
  for (const [name, outcomePositions] of Object.entries(positions)) {
    let topOutcome = null;
    let topShares = 0;
    let totalValue = 0;
    for (const [outcomeId, shares] of Object.entries(outcomePositions)) {
      const s = Number(shares);
      if (s <= 0.001) continue;
      const outcomeObj = findOutcome(outcomeId);
      const price = outcomeObj ? Number(outcomeObj.price ?? 0) : 0;
      totalValue += s * price;
      if (s > topShares) {
        topShares = s;
        topOutcome = outcomeId;
      }
    }

    // Resolve outcome label for the trader's largest current holding
    let posLabel = null;
    let posValue = 0;
    if (topOutcome && topShares > 0.001) {
      const outcomeObj = findOutcome(topOutcome);
      const price = outcomeObj ? Number(outcomeObj.price ?? 0) : 0;
      posValue = topShares * price;
      const label = outcomeObj?.title?.trim().toLowerCase();
      posLabel = label === "yes" ? "YES" : label === "no" ? "NO" : (outcomeObj?.title ?? "");
    }

    if (totalValue <= 0.01) continue;
    stats.push({ name, totalValue, posLabel, topShares, posValue });
  }

  return stats.sort((a, b) => b.totalValue - a.totalValue);
}

function marketParticipants(market, event) {
  const stats = marketParticipantStats(market, event);
  if (!stats.length) return "";

  const LIMIT = 3;
  const key = market.eventId ?? market.id ?? "";
  const expanded = state.expandedParticipants.has(key);
  const visible = expanded ? stats : stats.slice(0, LIMIT);
  const hiddenCount = stats.length - LIMIT;

  const rows = visible.map((p, i) => {
    const rankColor = i === 0 ? "var(--gold, #f5c842)" : i === 1 ? "var(--silver, #b0b8c1)" : i === 2 ? "var(--bronze, #cd7f32)" : "var(--muted)";
    const volStr = money(p.totalValue);
    const holdStr = p.posLabel && p.topShares > 0.001
      ? `${formatShares(p.topShares)} ${esc(p.posLabel)} <span class="mp-pos-value">≈${money(p.posValue)}</span>`
      : `<span class="mp-no-pos">no position</span>`;
    return `
      <div class="mp-row">
        <span class="mp-rank" style="color:${rankColor}">#${i + 1}</span>
        <span class="mp-name">${esc(p.name)}</span>
        <span class="mp-vol">${volStr}</span>
        <span class="mp-hold">${holdStr}</span>
      </div>`;
  }).join("");

  const toggleBtn = hiddenCount > 0 || expanded ? `
    <button class="mp-toggle" data-expand-participants="${esc(key)}" aria-expanded="${expanded}">
      ${expanded
        ? `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 8l4-4 4 4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Show less`
        : `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> ${hiddenCount} more`
      }
    </button>` : "";

  return `
    <section class="market-participants">
      <div class="mp-header">
        <span class="mp-title">Participants</span>
        <span class="mp-col-label mp-col-vol">in market</span>
        <span class="mp-col-label mp-col-hold">holding</span>
        ${toggleBtn}
      </div>
      <div class="mp-list">${rows}</div>
    </section>`;
}

function focusedLegendItem(market, index, event) {
  const pct = Math.round(displayedEventProbability(market, event) * 10) / 10;
  return `
    <span class="focused-legend-item">
      <i style="--series-color:${chartColorForMarket(market, index, event)}"></i>
      ${outcomeTitleHtml(marketOptionTitle(market))} <strong>${pct}%</strong>
    </span>`;
}

function focusedOutcomeMarkets(markets, event) {
  return (markets || [])
    .map((market, index) => ({ market, index, probability: displayedEventProbability(market, event) }))
    .sort((a, b) => (b.probability - a.probability) || (a.index - b.index))
    .map(item => item.market);
}

function focusedVisibleOutcomeMarkets(sortedMarkets, activeMarketId, expanded) {
  if (expanded || sortedMarkets.length <= 10) return sortedMarkets;
  const top = sortedMarkets.slice(0, 10);
  if (top.some(item => item.id === activeMarketId)) return top;
  const active = sortedMarkets.find(item => item.id === activeMarketId);
  return active ? [...top.slice(0, 9), active] : top;
}

function focusedOutcomeToggle(sortedMarkets, visibleMarkets, key, expanded) {
  const hidden = Math.max(0, sortedMarkets.length - visibleMarkets.length);
  if (sortedMarkets.length <= 10) return "";
  return `
    <button class="focused-outcome-toggle" type="button" data-toggle-focused-outcomes="${esc(key)}" aria-expanded="${expanded}">
      <span>${expanded ? "Show top 10" : `Show ${hidden} more`}</span>
      <svg class="${expanded ? "up" : ""}" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3 5.25 7 9.25l4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>`;
}

function focusedOutcomeRow(market, activeMarketId, index, event) {
  const yesPct = Math.round(displayedEventProbability(market, event));
  const option = marketOptionTitle(market);
  const tradeTarget = tradeTargetForOutcome(market, event);
  const active = tradeTarget.marketId === activeMarketId;
  const eliminated = marketOutcomeEliminated(market);
  const binary = isBinaryEvent(event);
  const yesButtonMarket = binary ? binaryMarketForSide(event, "yes") : market;
  const noButtonMarket = binary ? binaryMarketForSide(event, "no") : market;
  const yesButtonPct = Math.round(displayedEventProbability(yesButtonMarket || market, event));
  const noButtonPct = binary
    ? Math.round(displayedEventProbability(noButtonMarket || market, event))
    : 100 - yesButtonPct;
  return `
    <div class="focused-outcome-row ${active ? "active" : ""} ${eliminated ? "is-eliminated" : ""}" data-market-id="${tradeTarget.marketId}">
      <div class="focused-outcome-name">
        <i style="--series-color:${chartColorForMarket(market, index, event)}"></i>
        <span>${outcomeTitleHtml(option)}</span>
      </div>
      <strong>${yesPct}%</strong>
      ${eliminated ? `<span class="event-result-pill lost">Eliminated</span>` : market.status === "open" ? `
        <div class="event-trade-actions">
          <button class="event-side yes" type="button" data-buy="yes" aria-label="Buy YES on ${option} at ${yesButtonPct} cents"><span>Yes</span><em>${yesButtonPct}¢</em></button>
          <button class="event-side no" type="button" data-buy="no" aria-label="Buy NO on ${option} at ${noButtonPct} cents"><span>No</span><em>${noButtonPct}¢</em></button>
        </div>` : statusBadge(market)}
    </div>`;
}

function eventStatus(event) {
  if (event.markets.every(m => m.status === "resolved")) return "resolved";
  if (event.markets.some(m => m.status === "open")) return "open";
  return "closed";
}

function findEventForMarket(group, market) {
  return marketEvents(group.markets).find(event => event.markets.some(item => item.id === market.id)) ?? {
    key: `focused-${market.id}`,
    title: sampleEventTitle(market),
    description: market.description || "",
    resolutionSource: market.resolutionSource || "",
    edgeCases: market.edgeCases || "",
    verificationStatus: market.verificationStatus || "not_started",
    imageUrl: market.imageUrl || "",
    creator: market.creator || "",
    markets: [market],
    volume: Number(market.volume ?? market.totalBet ?? 0),
    closesAt: market.closesAt,
  };
}

function renderInvitePreview() {
  const invite = state.invitePreview;
  const error = state.inviteError;
  dom.mainContent.innerHTML = `
    <section class="invite-preview-page">
      <div class="invite-preview-card motion-item">
        <button class="logo invite-preview-logo" type="button" data-go-welcome>probable<span class="logo-dot">.</span></button>
        ${state.inviteLoading ? `
          <p class="eyebrow">Loading invite</p>
          <h1>Checking this link</h1>
          <p class="muted">One second while we verify the group invite.</p>
        ` : error ? `
          <p class="eyebrow">Invite unavailable</p>
          <h1>This invite link does not work</h1>
          <p>${esc(error)}</p>
          <button class="btn btn-primary" type="button" data-go-welcome>Back to Probable</button>
        ` : invite ? `
          <p class="eyebrow">Group invite</p>
          <div class="invite-preview-mark">${esc(invite.emoji || "PB")}</div>
          <h1>${esc(invite.groupName)}</h1>
          <p>Join this group to create markets, trade takes, and compete on the leaderboard.</p>
          <div class="invite-preview-stats">
            <span><strong>${Number(invite.memberCount || 0)}</strong><em>members</em></span>
            <span><strong>${Number(invite.openCount || 0)}</strong><em>open</em></span>
            <span><strong>${Number(invite.closedCount || 0)}</strong><em>closed</em></span>
          </div>
          ${invite.active ? `
            <button class="btn btn-primary btn-lg" type="button" data-join-invite>${isLoggedIn() ? "Join group" : "Sign in to join"}</button>
          ` : `
            <p class="invite-error">This invite has been revoked. Ask for a fresh link.</p>
            <button class="btn btn-primary" type="button" data-go-welcome>Back to Probable</button>
          `}
        ` : `
          <p class="eyebrow">Invite unavailable</p>
          <h1>No invite found</h1>
          <p>Ask your friend for a fresh group link.</p>
        `}
      </div>
    </section>
  `;
}

function renderEmbedRoute() {
  const route = state.embedRoute;
  const options = route?.options || state.embedModal;
  if (!route) {
    dom.mainContent.innerHTML = `<section class="embed-page"><div class="embed-widget"><p>Embed unavailable.</p></div></section>`;
    return;
  }
  if (!state.loaded) {
    dom.mainContent.innerHTML = `<section class="embed-page"><div class="embed-widget"><p>Loading market...</p></div></section>`;
    return;
  }
  const routeMarket = route.type === "market" ? findMarket(route.id) : null;
  const routeGroup = routeMarket ? findGroupForMarket(routeMarket.id) : null;
  const event = route.type === "event" ? findEventById(route.id) : (routeMarket && routeGroup ? findEventForMarket(routeGroup, routeMarket) : null);
  const market = route.type === "market" ? routeMarket : event?.markets?.[0];
  if (!market || !event) {
    dom.mainContent.innerHTML = `<section class="embed-page"><div class="embed-widget"><p>Market not found.</p></div></section>`;
    return;
  }
  dom.mainContent.innerHTML = `
    <section class="embed-page ${options.dark ? "dark" : "light"} ${options.border ? "with-border" : "no-border"}">
      ${embedWidgetHtml(event, market, options)}
    </section>`;
}

function embedWidgetHtml(event, market, options = {}) {
  const yesPct = Math.round(Number(market.probability || 0) * 100);
  const noPct = 100 - yesPct;
  const chartId = `embed-${market.id}`;
  const rows = (event.markets || [market]).slice(0, 4).map((item, index) => `
    <div class="embed-outcome-row">
      <span><i style="--series-color:${chartColorForMarket(item, index, event)}"></i>${esc(marketOptionTitle(item))}</span>
      <strong>${Math.round(Number(item.probability || 0) * 100)}%</strong>
    </div>`).join("");
  return `
    <article class="embed-widget" data-market-id="${esc(market.id)}">
      <div class="embed-brand">probable<span>.</span></div>
      <div class="embed-head">
        <div class="event-thumb ${eventThumbClass(event.title, event.imageUrl)}" aria-hidden="true">${eventThumb(event.title, event.imageUrl)}</div>
        <div>
          <p>${esc(getGroupForEvent(event)?.emoji || "PB")} ${esc(getGroupForEvent(event)?.name || "Market")}</p>
          <h1>${esc(event.title)}</h1>
          <span>${esc(marketOptionTitle(market))}</span>
        </div>
      </div>
      <div class="embed-prob-row"><strong class="yes">Yes ${yesPct}%</strong><strong class="no">No ${noPct}%</strong></div>
      ${options.chart !== false ? `<div class="embed-chart"><canvas data-market-chart="${chartId}"></canvas></div>` : ""}
      <div class="embed-outcomes">${rows}</div>
      <div class="embed-foot"><span>${compactMoney(event.volume)} Vol.</span><span>${fmtClose({ closesAt: event.closesAt, status: eventStatus(event) })}</span></div>
      ${options.buttons !== false ? `<div class="embed-buttons"><a class="yes" href="${marketUrl(market.id)}" target="_blank">Yes ${yesPct}¢</a><a class="no" href="${marketUrl(market.id)}" target="_blank">No ${noPct}¢</a></div>` : ""}
    </article>`;
}

function findEventById(eventId) {
  for (const group of state.groups) {
    const event = marketEvents(group.markets).find(item => item.markets.some(market => market.eventId === eventId));
    if (event) return event;
  }
  return null;
}

function getGroupForEvent(event) {
  if (!event) return null;
  return state.groups.find(group => (group.markets || []).some(market => event.markets?.some(item => item.id === market.id))) || null;
}

function renderEmptyDashboard() {
  const welcomeActions = `
    <div class="welcome-button-row">
      <button class="btn btn-primary btn-lg" type="button" data-create-market-welcome>Create market</button>
      <button class="btn btn-ghost btn-lg" type="button" data-join-group>Join group</button>
    </div>
    <button class="welcome-demo-link" type="button" data-try-demo>New here? Try the 2-minute demo</button>`;
  const bracketPromo = `
    <button class="welcome-bracket-card" type="button" data-go-bracket>
      <span class="welcome-bracket-copy">
        <em>New</em>
        <strong>${BRACKET_CHALLENGE.prize} for perfect knockouts</strong>
        <small>Free to enter. Build your World Cup bracket.</small>
      </span>
      <span class="welcome-bracket-prize">🏆</span>
    </button>`;
  const welcomeCreateForm = `
    <form class="welcome-inline-form" id="dashboardCreateForm">
      <div class="form-topline">
        <span>Create market</span>
        <button type="button" data-welcome-back>Back</button>
      </div>
      <input name="question" placeholder="Will Wirtz get 3+ GA tomorrow?" maxlength="100" required />
      <textarea name="outcomes" placeholder="Yes, No" required>Yes, No</textarea>
      <input name="closesAt" type="datetime-local" required />
      <textarea name="description" placeholder="Define exactly how this resolves, source of truth, timezone, and edge cases." required></textarea>
      <button class="btn btn-primary btn-lg" type="submit">Create market</button>
    </form>`;
  const welcomeJoinForm = `
    <form class="welcome-inline-form" id="dashboardJoinForm">
      <div class="form-topline">
        <span>Join existing group</span>
        <button type="button" data-welcome-back>Back</button>
      </div>
      <input name="groupId" placeholder="Paste invite link or group ID" value="${esc(state.joinPreFill || "")}" required />
      <button class="btn btn-primary btn-lg" type="submit">Join group</button>
    </form>`;
  const welcomeEntry = state.welcomeMode === "create"
    ? welcomeCreateForm
    : state.welcomeMode === "join"
      ? welcomeJoinForm
      : welcomeActions;
  dom.mainContent.innerHTML = `
    <section class="empty-dashboard welcome-hero">
      <div class="welcome-video-field" aria-hidden="true">
        <figure class="welcome-video-tile tile-a">
          <video data-src="/media/welcome-1.mp4" autoplay muted loop playsinline preload="none"></video>
        </figure>
        <figure class="welcome-video-tile tile-b">
          <video data-src="/media/welcome-2.mp4" autoplay muted loop playsinline preload="none"></video>
        </figure>
        <figure class="welcome-video-tile tile-c">
          <video data-src="/media/welcome-3.mp4" autoplay muted loop playsinline preload="none"></video>
        </figure>
        <figure class="welcome-video-tile tile-d">
          <video data-src="/media/welcome-4.mp4" autoplay muted loop playsinline preload="none"></video>
        </figure>
        <figure class="welcome-video-tile tile-e">
          <video data-src="/media/welcome-5.mp4" autoplay muted loop playsinline preload="none"></video>
        </figure>
      </div>
      <div class="welcome-scrim" aria-hidden="true"></div>

      <div class="welcome-content">
        <div class="welcome-copy motion-item">
          <p class="eyebrow">Your own prediction markets.</p>
          <h1 class="welcome-headline">Measure who has the best <span class="gooey-word" data-gooey-texts="ball knowledge|hot takes|match reads|game calls"><span class="sr-only gooey-word-current">ball knowledge</span><span class="gooey-word-1" aria-hidden="true">ball knowledge</span><span class="gooey-word-2" aria-hidden="true">hot takes</span></span></h1>
          <p>Create markets, invite your friends to put their money where their hot take is, and track the leaderboard.</p>
          <div class="welcome-signal-row" aria-label="Product highlights">
            <span>we settle it</span>
            <span>charts</span>
            <span>leaderboard</span>
            <span>points only</span>
          </div>
        </div>

        <div class="welcome-access welcome-access-compact motion-item">
          <div class="welcome-access-head">
            <p class="eyebrow">Enter market mode</p>
          </div>
          <div class="welcome-action-stack">
            ${bracketPromo}
            ${welcomeEntry}
          </div>
        </div>
      </div>
    </section>
  `;
  setWelcomeMarketMinDate();
}

function emptyMarketsHtml(status = "open") {
  const closed = status === "closed";
  return `
    <div class="empty-state motion-item">
      <p class="empty-title">${closed ? "No closed markets" : "No open markets"}</p>
      <p class="empty-sub">${closed ? "Resolved and expired markets will show here." : "Create the first active question for this group."}</p>
      ${closed ? "" : `<button class="btn btn-primary btn-sm" type="button" data-new-market>+ New market</button>`}
    </div>`;
}

function dashboardVisibleMarkets(markets) {
  return (markets ?? []).filter(market => {
    const isClosed = market.status === "closed" || market.status === "resolved";
    return state.marketStatus === "closed" ? isClosed : market.status === "open";
  });
}

function marketSortControl() {
  const options = [
    ["trending", "Trending"],
    ["latest", "Latest"],
    ["active", "Most active"],
    ["expiring", "Expiring soon"],
  ];
  return `
    <label class="market-sort-control" aria-label="Sort markets">
      <span class="sort-icon" aria-hidden="true"></span>
      <select data-market-sort>
        ${options.map(([value, label]) => `<option value="${value}" ${state.marketSort === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </label>`;
}

function marketEvents(markets) {
  const map = new Map();
  markets.forEach(market => {
    const eventTitle = market.category && market.category !== "General" ? market.category : market.question;
    const key = eventTitle.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        key,
        title: eventTitle,
        description: market.description || "",
        resolutionSource: market.resolutionSource || "",
        edgeCases: market.edgeCases || "",
        verificationStatus: market.verificationStatus || "not_started",
        resolvedBy: market.resolvedBy || "",
        resolutionNotes: market.resolutionNotes || "",
        resolvedAt: market.resolvedAt || "",
        outcome: market.outcome || "",
        imageUrl: market.imageUrl || "",
        creator: market.creator || "",
        markets: [],
        volume: 0,
        tradeCount: 0,
        createdAt: market.createdAt,
        latestActivityAt: market.createdAt,
        closesAt: market.closesAt,
      });
    }
    const event = map.get(key);
    if (!event.imageUrl && market.imageUrl) event.imageUrl = market.imageUrl;
    if (!event.creator && market.creator) event.creator = market.creator;
    if (!event.resolutionSource && market.resolutionSource) event.resolutionSource = market.resolutionSource;
    if (!event.edgeCases && market.edgeCases) event.edgeCases = market.edgeCases;
    if (market.verificationStatus) event.verificationStatus = market.verificationStatus;
    if (market.resolvedBy) event.resolvedBy = market.resolvedBy;
    if (market.resolutionNotes) event.resolutionNotes = market.resolutionNotes;
    if (market.resolvedAt) event.resolvedAt = market.resolvedAt;
    if (market.outcome) event.outcome = market.outcome;
    const marketTrades = market.trades ?? [];
    const latestTradeAt = marketTrades
      .map(trade => trade.createdAt || trade.timestamp)
      .filter(Boolean)
      .sort()
      .at(-1);
    event.markets.push(market);
    if (market.eventId) {
      event.volume = Math.max(event.volume, Number(market.volume ?? market.totalBet ?? 0));
      event.tradeCount = Math.max(event.tradeCount, (market.eventTrades ?? marketTrades).length);
    } else {
      event.volume += Number(market.volume ?? market.totalBet ?? 0);
      event.tradeCount += marketTrades.length;
    }
    if (market.createdAt && (!event.createdAt || new Date(market.createdAt) > new Date(event.createdAt))) event.createdAt = market.createdAt;
    if (latestTradeAt && (!event.latestActivityAt || new Date(latestTradeAt) > new Date(event.latestActivityAt))) event.latestActivityAt = latestTradeAt;
    if (!event.closesAt || new Date(market.closesAt) < new Date(event.closesAt)) event.closesAt = market.closesAt;
  });
  return [...map.values()].map(event => ({
    ...event,
    markets: event.markets.sort((a, b) => {
      const eliminatedDelta = Number(marketOutcomeEliminated(a)) - Number(marketOutcomeEliminated(b));
      return eliminatedDelta || Number(b.probability ?? 0) - Number(a.probability ?? 0);
    }),
  }));
}

function sortedMarketEvents(markets) {
  const events = marketEvents(markets);
  const sort = state.marketSort || "trending";
  return events.sort((a, b) => {
    if (sort === "latest") return eventTime(b.createdAt) - eventTime(a.createdAt);
    if (sort === "active") return (b.tradeCount - a.tradeCount) || (b.volume - a.volume);
    if (sort === "expiring") return eventExpiry(a) - eventExpiry(b);
    return eventTrendScore(b) - eventTrendScore(a);
  });
}

function eventTrendScore(event) {
  const openBoost = eventStatus(event) === "open" ? 100000 : 0;
  const movement = event.markets.reduce((sum, market) => sum + recentMarketMovement(market), 0);
  return openBoost + event.volume + event.tradeCount * 750 + movement * 180;
}

function recentMarketMovement(market) {
  const history = normalizedMarketHistory(market);
  if (history.length < 2) return Math.abs(Number(market.probability ?? 0.5) - 0.5) * 100;
  const last = history.at(-1).value;
  const previous = history[Math.max(0, history.length - 6)].value;
  return Math.abs(last - previous);
}

function eventExpiry(event) {
  if (eventStatus(event) !== "open") return Number.MAX_SAFE_INTEGER;
  const time = eventTime(event.closesAt);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function eventTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function marketOptionTitle(market) {
  return market.category && market.category !== "General" ? market.question : "Yes";
}

function eventCard(event) {
  const activeMarket = event.markets.find(m => state.trade.marketId === m.id);
  const expanded = state.expandedEventKey === event.key || Boolean(activeMarket);
  const shareMarket = activeMarket || event.markets.find(m => m.status === "open") || event.markets[0];
  const status = event.markets.every(m => m.status === "resolved")
    ? "resolved"
    : event.markets.some(m => m.status === "open")
      ? "open"
      : "closed";
  const resolvedOutcome = status === "resolved" ? eventResolvedOutcome(event) : null;
  const visibleMarkets = expanded ? event.markets : event.markets.slice(0, 2);
  const hiddenCount = Math.max(0, event.markets.length - visibleMarkets.length);
  const rows = visibleMarkets.map(market => eventOutcomeRow(market, event)).join("");
  const activeTrade = activeMarket
    ? tradePanel(activeMarket, Number(activeMarket.probability ?? 0.5).toFixed(2), (1 - Number(activeMarket.probability ?? 0.5)).toFixed(2), event)
    : "";
  return `
    <article class="event-card ${expanded ? "event-card-expanded" : ""} motion-item" data-event-key="${esc(event.key)}" aria-expanded="${expanded ? "true" : "false"}">
      <div class="event-card-inner">
        <div class="event-card-head">
          <div class="event-thumb ${eventThumbClass(event.title, event.imageUrl)}" aria-hidden="true">${eventThumb(event.title, event.imageUrl)}</div>
          <div class="event-title-wrap">
            <p class="event-title">${esc(event.title)}</p>
          </div>
          ${shareMarket ? `
            <button class="event-share-btn" type="button" data-share-market="${esc(shareMarket.id)}" aria-label="Share market">
              ${shareArrowIconSvg()}
            </button>` : ""}
        </div>
        <div class="event-outcome-list">${rows}</div>
        ${!expanded ? (
          hiddenCount
            ? `<button class="event-more-row" type="button" data-event-open="${esc(event.key)}">+${hiddenCount} more</button>`
            : `<div class="event-more-row event-more-row-placeholder" aria-hidden="true"></div>`
        ) : ""}
        ${expanded ? eventDetailStrip(event, status) : ""}
        <div class="event-card-foot">
          <span>${resolvedOutcome ? `Winner: ${esc(resolvedOutcome.label)}` : `${compactMoney(event.volume)} Vol.`}</span>
          <span class="event-card-creator">by ${esc(eventCreatorLabel(event))}</span>
        </div>
      </div>
      ${activeTrade}
    </article>`;
}

function eventCreatorLabel(event) {
  return event?.creator || getCurrentGroup()?.members?.[0] || "unknown";
}

function marketContextLabel(group, market, event) {
  const text = [
    group?.name,
    group?.emoji,
    event?.title,
    market?.category,
    market?.question,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(hockey|nhl|stanley|puck|leafs|rangers|oilers|canadiens|bruins|panthers|avalanche|penguins|lightning|jets|senators|flames|canucks|stars|devils|islanders)/.test(text)) return "Sports · Hockey";
  if (/(nba|basketball|lakers|celtics|knicks|warriors|raptors|nuggets|mavericks|bucks|heat)/.test(text)) return "Sports · Basketball";
  if (/(nfl|football|super bowl|chiefs|eagles|cowboys|ravens|bills|49ers)/.test(text)) return "Sports · Football";
  if (/(soccer|world cup|fifa|champions league|premier league|goal|ronaldo|messi|mbappe|haaland|wirtz)/.test(text)) return "Sports · Soccer";
  if (group?.name) return `${group.emoji || "PB"} ${group.name}`;
  return "Group market";
}

function eventResolvedOutcome(event) {
  const market = event?.markets?.[0];
  const outcome = event?.outcome || market?.outcome || "";
  if (!market || !outcome) return null;
  return {
    id: outcome,
    label: resolutionOutcomeLabel(market, outcome),
    cls: resolutionOutcomeClass(market, outcome),
  };
}

function eventDetailStrip(event, status) {
  const openCount = event.markets.filter(m => m.status === "open").length;
  const avgProb = event.markets.length
    ? Math.round(event.markets.reduce((sum, m) => sum + Number(m.probability ?? 0.5), 0) / event.markets.length * 100)
    : 0;
  const liquidity = event.markets.some(m => m.eventId)
    ? Math.max(...event.markets.map(m => Number(m.liquidity ?? 0)))
    : event.markets.reduce((sum, m) => sum + Number(m.liquidity ?? 0), 0);
  return `
    <div class="event-detail-strip">
      <span><strong>${event.markets.length}</strong> outcomes</span>
      <span><strong>${openCount}</strong> open</span>
      <span><strong>${avgProb}%</strong> avg yes</span>
      <span><strong>${compactMoney(liquidity)}</strong> liquidity</span>
      <span>${esc(status)}</span>
      <span>${fmtClose({ closesAt: event.closesAt, status })}</span>
    </div>`;
}

function eventOutcomeRow(market, event) {
  const yesPct = Math.round(displayedEventProbability(market, event));
  const option = marketOptionTitle(market);
  const tradeTarget = tradeTargetForOutcome(market, event);
  const eliminated = marketOutcomeEliminated(market);
  const binary = isBinaryEvent(event);
  const yesButtonMarket = binary ? binaryMarketForSide(event, "yes") : market;
  const noButtonMarket = binary ? binaryMarketForSide(event, "no") : market;
  const yesButtonPct = Math.round(displayedEventProbability(yesButtonMarket || market, event));
  const noButtonPct = binary
    ? Math.round(displayedEventProbability(noButtonMarket || market, event))
    : 100 - yesButtonPct;
  const resolvedOutcome = eventResolvedOutcome(event);
  const rowOutcomeId = market.outcomeId || binaryOutcomeForSide(market, "yes")?.id || market.id;
  const rowIsWinner = Boolean(resolvedOutcome) && (
    resolvedOutcome.id === rowOutcomeId
    || resolvedOutcome.label.toLowerCase() === option.toLowerCase()
  );
  return `
    <div class="event-outcome-row ${market.status === "resolved" ? (rowIsWinner ? "is-winner" : "is-loser") : ""} ${eliminated ? "is-eliminated" : ""}" data-market-id="${tradeTarget.marketId}">
      <div class="event-outcome-main">
        <span class="event-outcome-name">${outcomeTitleHtml(option)}</span>
        <strong>${yesPct}%</strong>
      </div>
      ${eliminated ? `<span class="event-result-pill lost">Eliminated</span>` : market.status === "open" ? `
        <div class="event-trade-actions">
          <button class="event-side yes" type="button" data-buy="yes" aria-label="Buy YES on ${option} at ${yesButtonPct} cents"><span>Yes</span><em>${yesButtonPct}¢</em></button>
          <button class="event-side no" type="button" data-buy="no" aria-label="Buy NO on ${option} at ${noButtonPct} cents"><span>No</span><em>${noButtonPct}¢</em></button>
        </div>` : market.status === "resolved"
          ? `<span class="event-result-pill ${rowIsWinner ? "winner" : "lost"}">${rowIsWinner ? "Winner" : "Lost"}</span>`
          : statusBadge(market)}
    </div>`;
}

function eventThumb(title, imageUrl = "") {
  if (imageUrl) return `<img src="${esc(imageUrl)}" alt="" loading="lazy" />`;
  const image = marketImageForTitle(title);
  if (image) return `<img src="${esc(image.src)}" alt="" loading="lazy" title="${esc([image.title, image.license].filter(Boolean).join(" · "))}" />`;
  const lower = title.toLowerCase();
  if (lower.includes("world cup") || lower.includes("wc")) return `<img src="/ball.png" alt="" />`;
  if (lower.includes("golden") || lower.includes("trophy") || lower.includes("cup")) return `<span class="thumb-trophy"></span>`;
  if (lower.includes("england")) return `<span class="thumb-flag thumb-england"></span>`;
  if (lower.includes("scotland")) return `<span class="thumb-flag thumb-scotland"></span>`;
  if (lower.includes("portugal")) return `<span class="thumb-flag thumb-portugal"></span>`;
  if (lower.includes("brazil")) return `<span class="thumb-flag thumb-brazil"></span>`;
  if (lower.includes("sign") || lower.includes("transfer")) return `<span class="thumb-paper"></span>`;
  return `<img src="/ball.png" alt="" />`;
}

function eventThumbClass(title, imageUrl = "") {
  if (imageUrl) return "event-thumb-photo";
  if (marketImageForTitle(title)) return "event-thumb-photo";
  const lower = title.toLowerCase();
  if (lower.includes("world cup") || lower.includes("wc")) return "event-thumb-image";
  if (lower.includes("golden") || lower.includes("trophy") || lower.includes("cup")) return "event-thumb-trophy";
  if (lower.includes("england")) return "event-thumb-flag";
  if (lower.includes("scotland")) return "event-thumb-flag";
  if (lower.includes("portugal")) return "event-thumb-flag";
  if (lower.includes("brazil")) return "event-thumb-flag";
  if (lower.includes("sign") || lower.includes("transfer")) return "event-thumb-paper";
  return "event-thumb-image";
}

function marketImageForTitle(title) {
  if (!state.marketImages.length) return null;
  const index = hashString(title) % state.marketImages.length;
  return state.marketImages[index];
}

function hashString(value) {
  return String(value).split("").reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 2166136261);
}

function compactMoney(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return money(n);
}

function topbarMoney(value) {
  return `$${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(Number(value || 0))}`;
}

function money(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function signedMoney(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`;
}

function tradeNetCash(cash) {
  return Math.max(0, Number(cash || 0) * (1 - MARKET_FEE_RATE));
}

function sellGrossCashForNet(netCash) {
  return MARKET_FEE_RATE >= 1 ? 0 : Math.max(0, Number(netCash || 0) / (1 - MARKET_FEE_RATE));
}

function tradeFee(amount) {
  const n = Math.max(0, Number(amount || 0));
  return n * MARKET_FEE_RATE;
}

function marketFeeNote(amount) {
  const fee = tradeFee(amount);
  if (!fee) return "";
  return `<div class="trade-fee-note">Market fee ${money(fee)} (${(MARKET_FEE_RATE * 100).toFixed(1)}%)</div>`;
}

function marketCard(group, market) {
  const prob = Number(market.probability ?? 0.5);
  const yesPct = Math.round(prob * 100);
  const noPct = 100 - yesPct;
  const yesPrice = prob.toFixed(2);
  const noPrice = (1 - prob).toFixed(2);
  const tradeOpen = state.trade.marketId === market.id;
  const proposal = market.oracleProposal;
  const oracleError = state.oracleErrors[market.id];
  const chartId = `chart-${market.id}`;
  const recentTrades = market.trades.slice(-3).reverse();

  return `
    <article class="market-card motion-item" data-market-id="${market.id}">
      <div class="market-card-inner">
        <div class="card-top">
          <div class="card-meta">
            <span class="badge badge-category">${esc(market.category)}</span>
            ${oracleBadge(market)}
          </div>
          ${statusBadge(market)}
        </div>
        <p class="card-question">${esc(market.question)}</p>
        <div class="prob-section">
          <div class="prob-row">
            <div><span class="prob-yes-num">${yesPct}%</span><span class="prob-yes-tag">YES</span></div>
            <div class="prob-no-group"><span class="prob-no-num">${noPct}%</span><span class="prob-no-tag">NO</span></div>
          </div>
          <div class="prob-bar"><div class="prob-bar-yes" style="width:${yesPct}%"></div><div class="prob-bar-no"></div></div>
        </div>
        <div class="chart-box">
          <div class="chart-labels"><span class="yes">YES</span><span class="no">NO</span></div>
          <canvas data-market-chart="${chartId}" aria-label="YES and NO probability history"></canvas>
        </div>
        <div class="market-meta-grid">
          <span><strong>${Number(market.volume ?? market.totalBet ?? 0).toFixed(0)}</strong> volume</span>
          <span><strong>${Number(market.liquidity ?? 0).toFixed(0)}</strong> liquidity</span>
          <span><strong>${market.trades.length}</strong> trades</span>
          <span>${fmtClose(market)}</span>
        </div>
      </div>

      ${market.status === "open" ? `
        <div class="trade-btn-row">
          <button class="btn btn-yes" type="button" data-buy="yes">Buy YES ${yesPrice}</button>
          <button class="btn btn-no" type="button" data-buy="no">Buy NO ${noPrice}</button>
        </div>` : ""}

      ${market.status === "resolved" ? outcomeBanner(market) : ""}
      ${tradeOpen ? tradePanel(market, yesPrice, noPrice) : ""}
      ${oracleError ? oracleUnavailableHtml(oracleError) : ""}
      ${proposalHtml(market, proposal)}
      ${oracleControls(market, proposal, oracleError)}
      ${recentTrades.length ? tradesHtml(market, recentTrades) : ""}
    </article>`;
}

function oracleBadge(market) {
  const labels = { manual: "Manual", ai: "AI", vote: "Vote" };
  return `<span class="badge badge-${market.oracleType}">${labels[market.oracleType] || "Oracle"}</span>`;
}

function statusBadge(market) {
  const cls = market.status === "open" ? "badge-open" : market.status === "closed" ? "badge-closed" : "badge-resolved";
  return `<span class="badge ${cls}">${market.status}</span>`;
}

function tradePanel(market, yesPrice, noPrice, event = null) {
  const side = state.trade.marketId === market.id ? (state.trade.side || "yes") : "yes";
  const mode = state.trade.marketId === market.id ? (state.trade.mode || "buy") : "buy";
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const eventTitle = sampleEventTitle(market);
  const binary = isBinaryEvent(event);
  const selectedLabel = marketOptionTitle(market);
  const opposite = binary ? event.markets.find(item => item.id !== market.id) : null;
  const yesLabel = binary ? selectedLabel : selectedLabel;
  const noLabel = binary ? (opposite ? marketOptionTitle(opposite) : "No") : "No";
  const yesTradePrice = binary ? Number(market.probability ?? yesPrice) : Number(yesPrice);
  const noTradePrice = binary ? Number(opposite?.probability ?? noPrice) : Math.max(0, 1 - Number(yesPrice));
  const activeOutcomeId = tradeOutcomeId(market, side);
  const activeLabel = binary
    ? (side === "no" ? noLabel : yesLabel)
    : `${selectedLabel} · ${side === "no" ? "No" : "Yes"}`;
  const sellState = tradeSellState(market, side);
  const tradePending = state.pendingUi.tradeMarketId === market.id;
  const sellDisabled = !sellState.anyHeld;
  const activeSellDisabled = mode === "sell" && !sellState.canSellSelected;
  const showMissingSideCopy = mode === "sell" && sellState.anyHeld && sellState.shares <= 0.000001;
  const sellMode = mode === "sell";
  const buyCap = maxSingleBuyAmount(market);
  const max = Math.max(0, sellMode ? sellState.shares : Math.floor(Math.min(balance || DEFAULT_BALANCE, buyCap)));
  const inputDisabled = activeSellDisabled || tradePending ? "disabled" : "";
  const submitDisabled = activeSellDisabled || tradePending ? "disabled" : "";
  const yesSellDisabled = tradePending || (mode === "sell" && !tradeSellState(market, "yes").canSellSelected);
  const noSellDisabled = tradePending || (mode === "sell" && !tradeSellState(market, "no").canSellSelected);
  const submitText = `${mode === "sell" ? "Sell" : "Buy"} ${side.toUpperCase()}`;
  const submitContent = tradePending
    ? `<span class="button-spinner" aria-hidden="true"></span><span>${mode === "sell" ? "Selling" : "Buying"}</span>`
    : submitText;
  return `
    <div class="trade-panel" data-market-id="${market.id}" data-trade-side="${side}" data-trade-mode="${mode}" data-outcome-id="${esc(activeOutcomeId)}">
      <div class="trade-panel-context ${side === "yes" ? "yes" : "no"}">
        <div class="trade-context-thumb ${eventThumbClass(eventTitle, event?.imageUrl || market.imageUrl)}" aria-hidden="true">${eventThumb(eventTitle, event?.imageUrl || market.imageUrl)}</div>
        <div>
          <span>${esc(eventTitle)}</span>
          <strong><em data-trade-side-label>${tradeSideLabelHtml(activeLabel)}</em></strong>
        </div>
      </div>
      <div class="trade-panel-header">
        <div class="trade-tabs" aria-label="Trade mode">
          <button type="button" class="${mode === "buy" ? "active" : ""}" data-trade-mode="buy" ${tradePending ? "disabled" : ""}>Buy</button>
          <button type="button" class="${mode === "sell" ? "active" : ""}" data-trade-mode="sell" ${sellDisabled || tradePending ? "disabled" : ""} title="${sellDisabled ? "You do not own any contracts in this market" : "Sell owned contracts"}">Sell</button>
        </div>
        <button class="trade-close" type="button" data-close-trade aria-label="Close">×</button>
      </div>
      <div class="trade-pick-row">
        <button class="trade-pick ${side === "yes" ? "yes active" : "yes"} ${yesSellDisabled ? "disabled" : ""}" type="button" data-buy="yes" ${yesSellDisabled ? "disabled" : ""}><span>${outcomeTitleHtml(yesLabel)}</span> <strong>${(yesTradePrice * 100).toFixed(0)}¢</strong></button>
        <button class="trade-pick ${side === "no" ? "no active" : "no"} ${noSellDisabled ? "disabled" : ""}" type="button" data-buy="no" ${noSellDisabled ? "disabled" : ""}><span>${outcomeTitleHtml(noLabel)}</span> <strong>${(noTradePrice * 100).toFixed(0)}¢</strong></button>
      </div>
      <form class="trade-form-el" data-market-id="${market.id}" data-trade-side="${side}" data-trade-mode="${mode}" data-outcome-id="${esc(activeOutcomeId)}">
        <div class="trade-amount-row">
          <label class="trade-amount-label"><span data-trade-input-label>${sellMode ? "Shares" : "Amount"}</span> <span data-trade-limit-copy>${sellMode ? sellLimitCopy(sellState) : `${money(balance)} cash`}</span></label>
          <div class="trade-input-row ${sellMode ? "sell" : "buy"}">
            ${sellMode ? "" : `<span class="trade-suffix">$</span>`}
            <input class="trade-input" type="text" min="${sellMode ? "0.01" : "1"}" ${sellMode ? "" : `max="${max}"`} data-raw-max="${formatShareInput(max)}" step="any" placeholder="0" inputmode="decimal" autocomplete="off" ${inputDisabled} />
          </div>
        </div>
        <div class="trade-chip-row ${mode === "sell" ? "sell" : ""}">
          ${tradeAmountChips(mode, max, activeSellDisabled || tradePending)}
        </div>
        <div class="trade-preview hidden" id="preview-${market.id}"></div>
        <button type="submit" class="trade-submit ${side === "yes" ? "yes" : "no"} ${tradePending ? "is-loading" : ""}" ${tradePending ? 'aria-busy="true"' : ""} ${submitDisabled}>${submitContent}</button>
      </form>
      ${showMissingSideCopy ? `<p class="trade-disabled-copy">You do not own this side yet.</p>` : ""}
    </div>`;
}

function outcomeBanner(market) {
  const label = resolutionOutcomeLabel(market, market.outcome);
  const cls = resolutionOutcomeClass(market, market.outcome);
  return `<div class="outcome-banner ${cls}">Resolved ${esc(label)} <span>${money(market.totalBet || 0)} pot</span></div>`;
}

function tradeAmountChips(mode, max, disabled) {
  if (mode === "sell") {
    return [25, 50, 75]
      .map(value => `<button type="button" data-fill-percent="${value}" ${disabled || max <= 0 ? "disabled" : ""}>${value}%</button>`)
      .join("") + `<button type="button" class="trade-chip-max" data-fill-amount="max" ${disabled || max <= 0 ? "disabled" : ""}>Max</button>`;
  }
  return [1, 5, 10, 50, 100]
    .map(value => `<button type="button" data-fill-amount="${value}" ${disabled ? "disabled" : ""}>+$${value}</button>`)
    .join("");
}

function oracleUnavailableHtml(message) {
  return `
    <div class="oracle-proposal oracle-warning">
      <div class="oracle-proposal-header">
        <span class="oracle-proposal-title">AI unavailable</span>
        <span class="oracle-conf-badge no">Manual fallback</span>
      </div>
      <p class="oracle-reasoning">${esc(message)}</p>
    </div>`;
}

function resolutionOutcomes(market) {
  if (market.outcomes?.length) return market.outcomes;
  return [
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ];
}

function outcomeEliminated(outcome) {
  return String(outcome?.status || outcome?.outcomeStatus || "").trim().toLowerCase() === "eliminated";
}

function activeResolutionOutcomes(market) {
  return resolutionOutcomes(market).filter(outcome => !outcomeEliminated(outcome));
}

function marketOutcomeEliminated(market) {
  if (outcomeEliminated(market)) return true;
  const outcomeId = market?.outcomeId || market?.id;
  return outcomeEliminated((market?.outcomes || []).find(outcome => outcome.id === outcomeId));
}

function resolutionOutcomeLabel(market, outcome) {
  const raw = String(outcome || "").trim();
  if (raw === ALL_OUTCOMES_RESOLUTION) return "Draw / all outcomes correct";
  const found = resolutionOutcomes(market).find(item => item.id === raw || String(item.title).toLowerCase() === raw.toLowerCase());
  return found?.title || raw || "Unknown";
}

function resolutionOutcomeClass(market, outcome, index = 0) {
  if (String(outcome || "").trim() === ALL_OUTCOMES_RESOLUTION) return "draw";
  const label = resolutionOutcomeLabel(market, outcome).toLowerCase();
  if (label === "yes") return "yes";
  if (label === "no") return "no";
  return index % 2 === 0 ? "yes" : "no";
}

function verificationStatusLabel(market) {
  if (market.status === "resolved") return "Resolved";
  if (market.status === "open") return "Pre-close";
  if (market.oracleProposal?.status === "needs_review" || market.verificationStatus === "needs_review") return "Needs review";
  if (market.oracleProposal?.status === "pending" || market.verificationStatus === "proposal_pending") return "Proposal pending";
  if (market.oracleType === "vote" && market.oracleProposal?.status === "voting") return "Voting";
  return "Ready to verify";
}

function verificationPanel(market, event) {
  const source = market.resolutionSource || event?.resolutionSource || "";
  const edgeCases = market.edgeCases || event?.edgeCases || "";
  const rules = market.description || event?.description || "Resolution rules were not provided.";
  const proposal = market.oracleProposal;
  const oracleError = state.oracleErrors[market.id];
  const winner = market.status === "resolved" ? resolutionOutcomeLabel(market, market.outcome) : "";
  return `
    <section class="verification-panel" data-market-id="${esc(market.id)}">
      <div class="verification-head">
        <div>
          <span class="verification-kicker">Verification</span>
          <h3>${esc(verificationStatusLabel(market))}</h3>
        </div>
        <span class="verification-mode">${esc(marketOracleLabel(market.oracleType || "ai"))}</span>
      </div>
      ${richRulesHtml({ rules, source, edgeCases, winner, resolvedBy: market.resolvedBy, notes: market.resolutionNotes, resolved: market.status === "resolved" })}
      ${oracleError ? oracleUnavailableHtml(oracleError) : ""}
      ${proposalHtml(market, proposal)}
      ${oracleControls(market, proposal, oracleError)}
    </section>`;
}

function marketHistoryPanel(market, event) {
  const title = event?.title || sampleEventTitle(market);
  const imageUrl = event?.imageUrl || market.imageUrl || "";
  const allTrades = marketHistoryTrades(market, event);
  const trades = allTrades.slice(-8).reverse();
  const total = allTrades.length;
  return `
    <section class="market-history-panel" data-market-id="${esc(market.id)}">
      <div class="market-history-head">
        <div>
          <span class="market-history-kicker">Market history</span>
          <h3>${trades.length ? "Recent activity" : "No trades yet"}</h3>
        </div>
        <div class="market-history-actions">
          <span>${total} ${total === 1 ? "trade" : "trades"}</span>
          ${total ? `<button type="button" data-view-all-trades="${esc(market.id)}">View all</button>` : ""}
        </div>
      </div>
      ${trades.length ? `
        <div class="market-history-list">
          ${trades.map(trade => marketHistoryRow(trade, market, { title, imageUrl })).join("")}
        </div>
      ` : `
        <div class="market-history-empty">
          <span class="market-history-thumb ${eventThumbClass(title, imageUrl)}" aria-hidden="true">${eventThumb(title, imageUrl)}</span>
          <div>
            <strong>Market opened</strong>
            <p>Trades will appear here as people buy or sell outcomes.</p>
          </div>
          <time>${esc(fmtDate(market.createdAt || event?.createdAt || Date.now()))}</time>
        </div>
      `}
    </section>`;
}

function marketHistoryTrades(market, event) {
  const markets = event?.markets?.length ? event.markets : [market];
  const eventTradeSource = markets.find(item => Array.isArray(item.eventTrades) && item.eventTrades.length) || (market.eventTrades?.length ? market : null);
  const rawTrades = eventTradeSource
    ? eventTradeSource.eventTrades
    : markets.flatMap(item => (item.trades || []).map(trade => ({
        ...trade,
        outcomeTitle: trade.outcomeTitle || marketOptionTitleForOutcome(item, trade.outcomeId) || marketOptionTitle(item),
      })));
  const seen = new Set();
  return sortedTrades(rawTrades).filter(trade => {
    const key = trade.id || `${trade.participant}-${trade.createdAt}-${trade.outcomeId || trade.side}-${trade.amount || trade.cashAmount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function marketHistoryRow(trade, market, eventMeta) {
  const action = String(trade.action || "buy").toLowerCase();
  const isSell = action === "sell";
  const outcomeTitle = tradeDisplayOutcomeTitle(trade, market);
  const priceAfter = Number(trade.probAfter ?? trade.avgPrice ?? 0);
  const priceBefore = Number(trade.probBefore ?? priceAfter);
  const move = (priceAfter - priceBefore) * 100;
  const amount = Number(trade.amount ?? trade.cashAmount ?? 0);
  const avgPrice = Number(trade.avgPrice || 0);
  const normalizedOutcomeTitle = String(outcomeTitle).trim().toLowerCase();
  const sideClass = trade.side === "no" || normalizedOutcomeTitle === "no" || normalizedOutcomeTitle.endsWith("· no") ? "no" : "yes";
  return `
    <div class="market-history-row ${isSell ? "sell" : "buy"}">
      <span class="market-history-thumb ${eventThumbClass(eventMeta.title, eventMeta.imageUrl)}" aria-hidden="true">${eventThumb(eventMeta.title, eventMeta.imageUrl)}</span>
      <div class="market-history-main">
        <span class="market-history-line">
          <em>${isSell ? "Sold" : "Bought"}</em>
          <strong>${esc(outcomeTitle)}</strong>
          <small>${esc(trade.participant || "Trader")}</small>
        </span>
        <span class="market-history-meta">
          ${money(amount)}${avgPrice > 0 ? ` · avg ${(avgPrice * 100).toFixed(1)}¢` : ""}
        </span>
      </div>
      <div class="market-history-price">
        <strong class="${sideClass}">${Number.isFinite(priceAfter) ? `${Math.round(priceAfter * 100)}%` : "-"}</strong>
        <span class="${move >= 0 ? "up" : "down"}">${Number.isFinite(move) ? `${move >= 0 ? "+" : ""}${move.toFixed(1)}%` : ""}</span>
      </div>
      <time>${esc(fmtDate(trade.createdAt))}</time>
    </div>`;
}

function tradeDisplayOutcomeTitle(trade, market = null) {
  const title = trade.outcomeTitle || (market ? marketOptionTitleForOutcome(market, trade.outcomeId) : "") || String(trade.side || "Yes").toUpperCase();
  return trade.side === "no" && !String(title).trim().toLowerCase().endsWith("· no")
    ? `${title} · No`
    : title;
}

function tradeComponents(trade) {
  return Array.isArray(trade?.components) && trade.components.length ? trade.components : [trade];
}

function openTradeHistoryModal(marketId) {
  const market = findMarket(marketId);
  if (!market) {
    toast("Could not find market trades.");
    return;
  }
  state.tradeHistoryModal = { marketId, sort: state.tradeHistoryModal.sort || "recent" };
  renderTradeHistoryModal();
  openModal("tradeHistory");
}

function renderTradeHistoryModal() {
  const market = findMarket(state.tradeHistoryModal.marketId);
  if (!market) {
    dom.tradeHistoryModalBody.innerHTML = `<p class="muted">Trade history unavailable.</p>`;
    return;
  }
  const group = findGroupForMarket(market.id) || getCurrentGroup();
  const event = group ? findEventForMarket(group, market) : null;
  const eventTitle = event?.title || sampleEventTitle(market);
  const imageUrl = event?.imageUrl || market.imageUrl || "";
  const sort = state.tradeHistoryModal.sort === "largest" ? "largest" : "recent";
  const trades = marketHistoryTrades(market, event).sort((a, b) => {
    if (sort === "largest") return Number(b.amount ?? b.cashAmount ?? 0) - Number(a.amount ?? a.cashAmount ?? 0);
    return timeValue(b.createdAt) - timeValue(a.createdAt);
  });
  dom.tradeHistoryModalBody.innerHTML = `
    <div class="trade-history-modal-head">
      <span class="market-history-thumb ${eventThumbClass(eventTitle, imageUrl)}" aria-hidden="true">${eventThumb(eventTitle, imageUrl)}</span>
      <div>
        <p class="eyebrow">${esc(group?.emoji || "")} ${esc(group?.name || "Market")}</p>
        <h2>${esc(eventTitle)}</h2>
        <span>${trades.length} ${trades.length === 1 ? "trade" : "trades"}</span>
      </div>
    </div>
    <div class="trade-history-sort" aria-label="Sort trades">
      <button class="${sort === "recent" ? "active" : ""}" type="button" data-trade-history-sort="recent">Most recent</button>
      <button class="${sort === "largest" ? "active" : ""}" type="button" data-trade-history-sort="largest">Largest</button>
    </div>
    ${trades.length ? `
      <div class="trade-history-full-list">
        ${trades.map(trade => marketHistoryRow(trade, market, { title: eventTitle, imageUrl })).join("")}
      </div>
    ` : `<p class="leader-profile-empty">No trades yet.</p>`}`;
}

function focusedRulesPanel(market, event) {
  const source = market.resolutionSource || event?.resolutionSource || "";
  const edgeCases = market.edgeCases || event?.edgeCases || "";
  const rules = market.description || event?.description || "Resolution rules were not provided.";
  const winner = market.status === "resolved" ? resolutionOutcomeLabel(market, market.outcome) : "";
  return `
    <section class="focused-rules-panel" data-market-id="${esc(market.id)}">
      ${richRulesHtml({
        rules,
        source,
        edgeCases,
        winner,
        resolvedBy: market.resolvedBy,
        notes: market.resolutionNotes,
        resolved: market.status === "resolved",
      })}
    </section>`;
}

function splitRuleSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function sourceTextWithoutLabel(source) {
  return String(source || "").replace(/^primary source:\s*/i, "").trim();
}

function classifyRuleSentences(rules = "") {
  const sections = {
    condition: [],
    timing: [],
    source: [],
    edge: [],
  };
  for (const sentence of splitRuleSentences(rules)) {
    const lower = sentence.toLowerCase();
    if (/^(primary source|source|backup source)\b/.test(lower) || /\b(primary source|backup source)\b/.test(lower)) {
      sections.source.push(sentence);
    } else if (/(cancel|disagreement|ambiguous|ambiguity|manual review|does not participate|does not play|injury|unavailable|edge case|stat-provider|provider disagreement)/.test(lower)) {
      sections.edge.push(sentence);
    } else if (/(trading|maturity|postpon|pending|close|window|date|utc|played|available)/.test(lower)) {
      sections.timing.push(sentence);
    } else {
      sections.condition.push(sentence);
    }
  }
  return sections;
}

function uniqueRuleItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = String(item || "")
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/\bthe\b|\ba\b|\ban\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rulesList(items, fallback = "") {
  const list = uniqueRuleItems(items.filter(Boolean)).slice(0, 5);
  if (!list.length && fallback) list.push(fallback);
  return `<ul>${list.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function parseSectionedRules(rules = "") {
  const sections = { condition: [], timing: [], source: [], edge: [] };
  const labelMap = new Map([
    ["what settles it", "condition"],
    ["resolution condition", "condition"],
    ["condition", "condition"],
    ["timing", "timing"],
    ["time window", "timing"],
    ["source", "source"],
    ["sources", "source"],
    ["primary source", "source"],
    ["edge cases", "edge"],
    ["edge case", "edge"],
    ["settlement edge cases", "edge"],
  ]);
  let current = null;
  for (const rawLine of String(rules || "").split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(.+?):\s*$/);
    if (heading) {
      current = labelMap.get(heading[1].trim().toLowerCase()) || current;
      continue;
    }
    const inlineHeading = line.match(/^(.+?):\s*(.+)$/);
    if (inlineHeading && labelMap.has(inlineHeading[1].trim().toLowerCase())) {
      current = labelMap.get(inlineHeading[1].trim().toLowerCase());
      const rest = inlineHeading[2].replace(/^[-•]\s*/, "").trim();
      if (rest) sections[current].push(rest);
      continue;
    }
    const bullet = line.replace(/^[-•]\s*/, "").trim();
    if (current && bullet) sections[current].push(bullet);
  }
  return Object.values(sections).some(items => items.length) ? sections : null;
}

function richRulesHtml({ rules, source, edgeCases, winner = "", resolvedBy = "", notes = "", resolved = false, compact = false }) {
  const displayRules = stripLabeledRuleAppendices(rules);
  const sectioned = parseSectionedRules(displayRules);
  const sections = sectioned || classifyRuleSentences(displayRules);
  const sourceLine = sourceTextWithoutLabel(source);
  const edgeList = [
    ...splitRuleSentences(edgeCases),
    ...sections.edge,
  ];
  const conditionFallback = splitRuleSentences(displayRules)[0] || "Resolution rules were not provided.";
  const sourceItems = sourceLine ? [sourceLine, ...sections.source] : sections.source;
  return `
    <div class="resolution-rules ${compact ? "compact" : ""}">
      <div class="rules-title-row">
        <h4>Rules</h4>
        <span>before you trade</span>
      </div>
      <div class="rules-grid">
        <article class="rules-card rules-card-main">
          <span class="rules-card-label">What settles it</span>
          ${rulesList(sections.condition, conditionFallback)}
        </article>
        <article class="rules-card">
          <span class="rules-card-label">Timing</span>
          ${rulesList(sections.timing, "Trading closes at maturity. Resolution happens once the source result is available.")}
        </article>
        <article class="rules-card">
          <span class="rules-card-label">Source</span>
          ${rulesList(sourceItems, "Use the named official source or manual review if unavailable.")}
        </article>
        <article class="rules-card">
          <span class="rules-card-label">Edge cases</span>
          ${rulesList(edgeList, "Ambiguous results go to manual review.")}
        </article>
        ${resolved ? `
          <article class="rules-card rules-card-resolved">
            <span class="rules-card-label">Settlement</span>
            <ul>
              <li>Winner: <strong>${esc(winner || "Unknown")}</strong>${resolvedBy ? ` · resolved by ${esc(resolvedBy)}` : ""}</li>
              ${notes ? `<li>${esc(notes)}</li>` : ""}
            </ul>
          </article>` : ""}
      </div>
    </div>`;
}

function stripLabeledRuleAppendices(rules = "") {
  const paragraphs = String(rules || "")
    .split(/\n{2,}/)
    .map(item => item.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) return String(rules || "");
  return paragraphs
    .filter(item => !/^(primary source|source|edge cases):/i.test(item))
    .join("\n\n");
}

function proposalHtml(market, proposal) {
  if (market.oracleType === "ai" && proposal?.status === "pending" && market.status !== "resolved") {
    const confPct = Math.round((proposal.confidence || 0) * 100);
    const outcomeId = proposal.outcomeId || proposal.outcome;
    const outCls = resolutionOutcomeClass(market, outcomeId);
    const outcomeLabel = proposal.outcomeTitle || resolutionOutcomeLabel(market, outcomeId);
    const sources = (proposal.sources || []).slice(0, 3).map(s => {
      const label = typeof s === "string" ? s : (s.title || s.url || "Source");
      return `<span class="oracle-source">${esc(label)}</span>`;
    }).join("");
    return `
      <div class="oracle-proposal">
        <div class="oracle-proposal-header">
          <span class="oracle-proposal-title">AI proposal</span>
          <span class="oracle-conf-badge ${outCls}">${esc(outcomeLabel)} · ${confPct}%</span>
        </div>
        <div class="oracle-conf-bar"><div class="oracle-conf-fill ${outCls}" style="width:${confPct}%"></div></div>
        ${proposal.reasoning ? `<p class="oracle-reasoning">${esc(proposal.reasoning)}</p>` : ""}
        ${proposal.notes ? `<p class="oracle-reasoning">${esc(proposal.notes)}</p>` : ""}
        ${sources ? `<div class="oracle-sources">${sources}</div>` : ""}
        <div class="oracle-actions">
          <button class="btn-oracle-accept" type="button" data-oracle-accept>Accept</button>
          <button class="btn-oracle-dispute" type="button" data-oracle-dispute>Dispute</button>
        </div>
      </div>`;
  }

  if (market.oracleType === "ai" && proposal?.status === "needs_review" && market.status === "closed") {
    const sources = (proposal.sources || []).slice(0, 3).map(s => {
      const label = typeof s === "string" ? s : (s.title || s.url || "Source");
      return `<span class="oracle-source">${esc(label)}</span>`;
    }).join("");
    return `
      <div class="oracle-proposal oracle-warning">
        <div class="oracle-proposal-header">
          <span class="oracle-proposal-title">Needs review</span>
          <span class="oracle-conf-badge no">${Math.round((proposal.confidence || 0) * 100)}%</span>
        </div>
        ${proposal.reasoning ? `<p class="oracle-reasoning">${esc(proposal.reasoning)}</p>` : ""}
        ${proposal.notes ? `<p class="oracle-reasoning">${esc(proposal.notes)}</p>` : ""}
        ${sources ? `<div class="oracle-sources">${sources}</div>` : ""}
      </div>`;
  }

  if (market.oracleType === "vote" && market.status === "closed") {
    const outcomes = resolutionOutcomes(market);
    const votes = proposal?.votes || {};
    const total = Object.values(votes).reduce((sum, value) => sum + Number(value || 0), 0);
    const top = outcomes
      .map(outcome => ({ ...outcome, votes: Number(votes[outcome.id] || 0) }))
      .sort((a, b) => b.votes - a.votes)[0];
    const width = total && top ? Math.round((top.votes / total) * 100) : 0;
    const voteButtons = outcomes.map((outcome, index) => {
      const cls = resolutionOutcomeClass(market, outcome.id, index);
      const count = Number(votes[outcome.id] || 0);
      return `<button class="btn-oracle-${cls === "yes" ? "accept" : "dispute"}" type="button" data-oracle-vote="${esc(outcome.id)}">Vote ${esc(outcome.title)} (${count})</button>`;
    }).join("");
    return `
      <div class="oracle-proposal">
        <div class="oracle-proposal-header">
          <span class="oracle-proposal-title">Group vote</span>
          <span class="oracle-conf-badge yes">${total} votes</span>
        </div>
        <div class="oracle-conf-bar"><div class="oracle-conf-fill yes" style="width:${width}%"></div></div>
        <div class="oracle-actions">${voteButtons}</div>
      </div>`;
  }
  return "";
}

function oracleControls(market, proposal, oracleError) {
  if (market.status === "resolved") return "";
  if (market.status === "open") {
    return `<div class="market-controls muted">Resolution opens after close.</div>`;
  }
  if (market.oracleType === "manual" || oracleError) {
    const buttons = resolutionOutcomes(market).map((outcome, index) => {
      const cls = resolutionOutcomeClass(market, outcome.id, index) === "yes" ? "btn-resolve-yes" : "btn-resolve-no";
      return `<button class="${cls}" type="button" data-resolve="${esc(outcome.id)}">${esc(outcome.title)}</button>`;
    }).join("");
    return `
      <div class="market-controls">
        <span class="controls-label">Resolve</span>
        ${buttons}
      </div>`;
  }
  if (market.oracleType === "ai" && proposal?.status !== "pending") {
    return `<div class="market-controls"><button class="btn-oracle-ai" type="button" data-oracle-trigger>Resolve with AI</button></div>`;
  }
  return "";
}

function tradesHtml(market, trades) {
  return `
    <div class="card-trades">
      <div class="card-trades-label">Recent trades</div>
      ${trades.map(t => {
        const dp = ((t.probAfter - t.probBefore) * 100).toFixed(1);
        const won = market.status === "resolved" && t.side === market.outcome;
        return `
          <div class="trade-item">
            <div class="trade-item-left">
              <span class="trade-side-tag ${t.side}">${t.side.toUpperCase()}</span>
              <span>${esc(t.participant)}</span>
              <span>${money(t.amount)}</span>
            </div>
            <div class="trade-item-right">
              <span>${Number(dp) >= 0 ? "+" : ""}${dp}%</span>
              ${market.status === "resolved" ? `<span class="${won ? "trade-won" : "trade-lost"}">${won ? "won" : "lost"}</span>` : ""}
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

function renderTradePreview(market, amount) {
  const el = document.querySelector(`#preview-${market.id}`);
  if (!el) return;
  if (!amount || amount <= 0) {
    const mode = state.trade.mode || "buy";
    const outcomeId = tradeOutcomeId(market, state.trade.side || "yes");
    const preview = mode === "sell"
      ? sellPreviewForShares(market, outcomeId, 0, state.trade.side || "yes")
      : lmsrPreview(market, outcomeId, mode, 0);
    updateTradeSubmitState(market, preview, 0);
  }
  el.classList.toggle("hidden", !amount || amount <= 0);
  el.innerHTML = tradePreviewHtml(market, amount);
}

function tradePreviewHtml(market, amount) {
  const side = state.trade.side || "yes";
  const mode = state.trade.mode || "buy";
  const outcomeId = tradeOutcomeId(market, side);
  const outcome = market.outcomes?.find(item => item.id === outcomeId);
  const price = Number(outcome?.price ?? market.probability ?? 0.5);
  let displayPrice = isComplementNoTrade(market, side) ? Math.max(0.000001, 1 - price) : price;
  if (!amount || amount <= 0) {
    return "";
  }
  if (mode === "sell") {
    const preview = sellPreviewForShares(market, outcomeId, amount, side);
    updateTradeSubmitState(market, preview, amount);
    const shares = Math.min(Math.max(0, amount), preview.held || 0);
    const avgPrice = shares > 0 ? preview.cashAmount / shares : displayPrice;
    const guidance = liquidityGuidance(market, preview.cashAmount, displayPrice, avgPrice, preview);
    const pl = sellProfitLossEstimate(market, outcomeId, shares, avgPrice, side);
    return `
      <div class="trade-payout-label">
        <span>You'll receive 💸</span>
        <small>${outcomeTitleHtml(outcome?.title || marketOptionTitle(market))} · Avg. Price ${(avgPrice * 100).toFixed(1)}¢</small>
      </div>
      <strong class="trade-payout-value">${money(preview.cashAmount)}</strong>
      ${pl ? `<div class="trade-pl-note ${pl.percent >= 0 ? "gain" : "loss"}">${pl.percent >= 0 ? "+" : ""}${pl.percent.toFixed(1)}%</div>` : ""}
      ${marketFeeNote(sellGrossCashForNet(preview.cashAmount))}
      <div class="trade-liquidity-note ${guidance.level}">
        ${guidance.text}
      </div>`;
  }
  const quote = cachedTradeQuote(market, amount);
  if (!quote) requestTradeQuote(market, amount);
  if (isComplementNoTrade(market, side) && !quote) {
    updateTradeSubmitState(market, { held: 0, oversell: false, needsQuote: true }, amount);
    return `
      <div class="trade-payout-label">
        <span>To win 💸</span>
        <small>${outcomeTitleHtml(outcome?.title || marketOptionTitle(market))} · getting market quote</small>
      </div>
      <strong class="trade-payout-value">...</strong>
      <div class="trade-liquidity-note caution">Quoting the full complement basket.</div>`;
  }
  displayPrice = Number(quote?.price ?? displayPrice);
  const preview = quote
    ? quoteToPreview(market, quote, outcomeId)
    : isComplementNoTrade(market, side)
    ? complementBuyPreview(market, outcomeId, amount)
    : lmsrPreview(market, outcomeId, mode, amount);
  updateTradeSubmitState(market, preview, amount);
  const shares = Math.abs(preview.shares || 0);
  const avgPrice = shares > 0 ? amount / shares : displayPrice;
  const payout = mode === "sell" ? amount : shares;
  const guidance = liquidityGuidance(market, amount, displayPrice, avgPrice, preview);
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const insufficientBalance = amount > balance;
  return `
    <div class="trade-payout-label">
      <span>${mode === "sell" ? "You receive" : "To win 💸"}</span>
      <small>${outcomeTitleHtml(outcome?.title || marketOptionTitle(market))} · Avg. Price ${(avgPrice * 100).toFixed(1)}¢</small>
    </div>
    <strong class="trade-payout-value">${money(payout)}</strong>
    ${!insufficientBalance ? marketFeeNote(amount) : ""}
    ${insufficientBalance ? `<div class="trade-liquidity-note warn">Not enough funds. You have ${money(balance)}.</div>` : `
      <div class="trade-liquidity-note ${guidance.level}">
        ${guidance.text}
      </div>`}`;
}

function tradeQuoteKey(market, amount) {
  const side = state.trade.side || "yes";
  const mode = state.trade.mode || "buy";
  const outcomeId = tradeOutcomeId(market, side);
  const participant = state.activeMember || "";
  const normalizedAmount = Number(amount || 0).toFixed(4);
  return [market.id, outcomeId, side, mode, participant, normalizedAmount].join(":");
}

function cachedTradeQuote(market, amount) {
  if ((state.trade.mode || "buy") !== "buy") return null;
  return tradeQuoteCache.get(tradeQuoteKey(market, amount)) || null;
}

function quoteToPreview(market, quote, outcomeId) {
  return {
    shares: Number(quote.shares || 0),
    maxCash: Number(quote.maxCash || 0),
    held: currentSharesForOutcome(market, outcomeId),
    oversell: false,
    syntheticPrice: Number(quote.price || 0),
    isComplement: Boolean(quote.isComplement),
    serverQuoted: true,
  };
}

async function requestTradeQuote(market, amount) {
  if ((state.trade.mode || "buy") !== "buy") return;
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return;
  const key = tradeQuoteKey(market, amount);
  if (tradeQuoteCache.has(key) || tradeQuoteInflight.has(key)) return;
  tradeQuoteInflight.set(key, true);
  try {
    const side = state.trade.side || "yes";
    const data = await api(`/api/markets/${market.id}/quote`, {
      method: "POST",
      body: JSON.stringify({
        participant: state.activeMember || undefined,
        side,
        action: "buy",
        amount: Number(amount),
        outcomeId: tradeOutcomeId(market, side),
      }),
    });
    tradeQuoteCache.set(key, data.quote);
    const currentMarket = findMarket(market.id);
    const panel = findTradePanelForMarket(market.id);
    const input = panel?.querySelector(".trade-input");
    if (currentMarket && input && tradeQuoteKey(currentMarket, tradeInputAmount(input)) === key) {
      renderTradePreview(currentMarket, tradeInputAmount(input));
    }
  } catch {
    // Keep the instant local estimate if the quote endpoint is temporarily unavailable.
  } finally {
    tradeQuoteInflight.delete(key);
  }
}

function tradeOutcomeId(market, side = "yes") {
  if (side === "no" && (market.outcomes?.length || 0) === 2) {
    return market.outcomes.find(item => item.id !== market.outcomeId)?.id || market.outcomeId || market.id;
  }
  return market.outcomeId || market.id;
}

function tradeContextFromPanel(panel, form, market) {
  const side = sanitizeTradeSide(form?.dataset.tradeSide || panel?.dataset.tradeSide || state.trade.side);
  const action = sanitizeTradeMode(form?.dataset.tradeMode || panel?.dataset.tradeMode || state.trade.mode);
  const outcomeId = form?.dataset.outcomeId || panel?.dataset.outcomeId || tradeOutcomeId(market, side);
  if (!market?.id) return { valid: false, error: "Trade panel is missing a market." };
  if (panel?.dataset.marketId && panel.dataset.marketId !== market.id) {
    return { valid: false, error: "Trade panel changed. Reopen it and try again." };
  }
  if (!side) return { valid: false, error: "Choose Yes or No." };
  if (!action) return { valid: false, error: "Choose Buy or Sell." };
  if (!outcomeBelongsToMarket(market, outcomeId)) {
    return { valid: false, error: "Selected outcome does not belong to this market." };
  }
  if (!outcomeActiveInMarket(market, outcomeId)) {
    return { valid: false, error: "That outcome has been eliminated." };
  }
  if (action === "sell" && !tradeSellState(market, side).canSellSelected) {
    return { valid: false, error: "You do not own this side yet." };
  }
  const expectedOutcomeId = tradeOutcomeId(market, side);
  if (outcomeId !== expectedOutcomeId) {
    return { valid: false, error: "Trade ticket is stale. Reopen it and try again." };
  }
  return { valid: true, side, action, outcomeId };
}

function sanitizeTradeSide(side) {
  const value = String(side || "").trim().toLowerCase();
  return value === "yes" || value === "no" ? value : "";
}

function sanitizeTradeMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  return value === "sell" ? "sell" : value === "buy" ? "buy" : "";
}

function outcomeBelongsToMarket(market, outcomeId) {
  if (!outcomeId) return false;
  const outcomes = market.outcomes || [];
  if (!outcomes.length) return outcomeId === (market.outcomeId || market.id);
  return outcomes.some(outcome => outcome.id === outcomeId);
}

function outcomeActiveInMarket(market, outcomeId) {
  const outcomes = market.outcomes || [];
  if (!outcomes.length) return !marketOutcomeEliminated(market);
  const outcome = outcomes.find(item => item.id === outcomeId);
  return Boolean(outcome) && !outcomeEliminated(outcome);
}

function syncTradePanelDataset(panel, market, side, mode) {
  if (!panel || !market) return;
  const outcomeId = tradeOutcomeId(market, side);
  panel.dataset.tradeSide = side;
  panel.dataset.tradeMode = mode;
  panel.dataset.outcomeId = outcomeId;
  const form = panel.querySelector(".trade-form-el");
  if (form) {
    form.dataset.marketId = market.id;
    form.dataset.tradeSide = side;
    form.dataset.tradeMode = mode;
    form.dataset.outcomeId = outcomeId;
  }
}

function findTradePanelForMarket(marketId) {
  const panels = [...document.querySelectorAll(".trade-panel")]
    .filter(item => item.dataset.marketId === marketId);
  return panels.find(isElementVisible) || panels[0] || null;
}

function isElementVisible(element) {
  return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
}

function isComplementNoTrade(market, side = state.trade.side || "yes") {
  return side === "no" && (market.outcomes?.length || 0) > 2 && activeOutcomesForMarket(market).length > 1;
}

function activeOutcomesForMarket(market) {
  const outcomes = market.outcomes?.length
    ? market.outcomes
    : [{ id: market.outcomeId || market.id, price: market.probability, quantity: 0 }];
  return outcomes.filter(outcome => !outcomeEliminated(outcome));
}

function complementOutcomes(market, outcomeId = tradeOutcomeId(market, "yes")) {
  return activeOutcomesForMarket(market).filter(outcome => outcome.id !== outcomeId);
}

function complementShareState(market, outcomeId = tradeOutcomeId(market, "yes")) {
  const outcomes = complementOutcomes(market, outcomeId);
  const heldByOutcome = outcomes.map(outcome => currentSharesForOutcome(market, outcome.id));
  const shares = heldByOutcome.length ? Math.min(...heldByOutcome) : 0;
  const maxCash = outcomes.reduce((sum, outcome) => {
    return sum + lmsrSellValueForShares(market, outcome.id, shares);
  }, 0);
  return { shares, maxCash, outcomes };
}

function marketOptionTitleForOutcome(market, outcomeId) {
  const outcome = market.outcomes?.find(item => item.id === outcomeId);
  return outcome?.title || marketOptionTitle(market);
}

function binaryOutcomeForSide(market, side) {
  const normalizedSide = String(side || "").trim().toLowerCase();
  if (!["yes", "no"].includes(normalizedSide)) return null;
  const outcomes = market.outcomes || [];
  if (outcomes.length !== 2) return null;
  return outcomes.find(item => String(item.title || "").trim().toLowerCase() === normalizedSide) || null;
}

function lmsrPreview(market, outcomeId, mode, amount) {
  const outcomes = activeOutcomesForMarket(market);
  const b = Number(market.initialLiquidity || market.liquidity || DEFAULT_MARKET_LIQUIDITY);
  const target = outcomes.find(item => item.id === outcomeId) || outcomes[0];
  if (!target) return { shares: 0, maxCash: 0, held: 0, oversell: false };
  const sumExp = outcomes.reduce((sum, item) => sum + Math.exp(Number(item.quantity || 0) / b), 0);
  const targetExp = Math.exp(Number(target.quantity || 0) / b);
  if (mode === "sell") {
    const held = currentSharesForOutcome(market, outcomeId);
    const maxCash = tradeNetCash(b * Math.log(sumExp / (sumExp - targetExp + targetExp * Math.exp(-held / b))));
    const safeAmount = Math.min(amount, Math.max(0, maxCash - 0.0001));
    const curveCash = sellGrossCashForNet(safeAmount);
    const multiplier = Math.exp(curveCash / b);
    const denominator = sumExp / multiplier - (sumExp - targetExp);
    const shares = denominator > 0 ? -b * Math.log(denominator / targetExp) : held + 1;
    return { shares: -shares, maxCash, held, oversell: amount > maxCash + 0.0001 };
  }
  const curveCash = tradeNetCash(amount);
  const multiplier = Math.exp(curveCash / b);
  const shares = b * Math.log(1 + (sumExp / targetExp) * (multiplier - 1));
  return { shares, maxCash: 0, held: currentSharesForOutcome(market, outcomeId), oversell: false };
}

function lmsrStateForMarket(market) {
  const outcomes = activeOutcomesForMarket(market);
  const b = Number(market.initialLiquidity || market.liquidity || DEFAULT_MARKET_LIQUIDITY);
  const values = outcomes.map(item => ({
    ...item,
    quantity: Number(item.quantity || 0),
    exp: Math.exp(Number(item.quantity || 0) / b),
  }));
  return {
    outcomes: values,
    b,
    sumExp: values.reduce((sum, item) => sum + item.exp, 0),
  };
}

function lmsrGrossCostForComplementShares(market, excludedOutcomeId, shares) {
  const { outcomes, b, sumExp } = lmsrStateForMarket(market);
  const target = outcomes.find(item => item.id === excludedOutcomeId);
  if (!target || !Number.isFinite(b) || b <= 0 || shares <= 0) return 0;
  const complementExp = Math.max(0, sumExp - target.exp);
  const newSum = target.exp + complementExp * Math.exp(shares / b);
  const netCost = b * Math.log(newSum / sumExp);
  return sellGrossCashForNet(netCost);
}

function lmsrComplementSharesForCash(market, excludedOutcomeId, amount) {
  const gross = Math.max(0, Number(amount || 0));
  if (!gross) return 0;
  let low = 0;
  let high = Math.max(1, gross / Math.max(0.01, 1 - Number(market.outcomes?.find(item => item.id === excludedOutcomeId)?.price || 0)));
  for (let i = 0; i < 40 && lmsrGrossCostForComplementShares(market, excludedOutcomeId, high) < gross; i += 1) {
    high *= 2;
  }
  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    if (lmsrGrossCostForComplementShares(market, excludedOutcomeId, mid) > gross) high = mid;
    else low = mid;
  }
  return low;
}

function lmsrCashForComplementSellShares(market, excludedOutcomeId, shares) {
  const { outcomes, b, sumExp } = lmsrStateForMarket(market);
  const target = outcomes.find(item => item.id === excludedOutcomeId);
  const amount = Math.max(0, Number(shares || 0));
  if (!target || !Number.isFinite(b) || b <= 0 || amount <= 0) return 0;
  const complementExp = Math.max(0, sumExp - target.exp);
  const newSum = target.exp + complementExp * Math.exp(-amount / b);
  if (newSum <= 0) return 0;
  return tradeNetCash(b * Math.log(sumExp / newSum));
}

function complementBuyPreview(market, outcomeId, amount) {
  const shares = lmsrComplementSharesForCash(market, outcomeId, amount);
  const targetPrice = Number(market.outcomes?.find(item => item.id === outcomeId)?.price ?? market.probability ?? 0);
  const noPrice = Math.max(0.000001, 1 - targetPrice);
  return {
    shares,
    maxCash: 0,
    held: complementShareState(market, outcomeId).shares,
    oversell: false,
    syntheticPrice: noPrice,
    isComplement: true,
  };
}

function sellPreviewForShares(market, outcomeId, shares, side = state.trade.side || "yes") {
  if (isComplementNoTrade(market, side)) {
    const basket = complementShareState(market, outcomeId);
    const requestedShares = Math.max(0, Number(shares || 0));
    const safeShares = Math.min(requestedShares, basket.shares);
    const cashAmount = lmsrCashForComplementSellShares(market, outcomeId, safeShares);
    return {
      shares: -safeShares,
      cashAmount,
      maxCash: basket.maxCash,
      held: basket.shares,
      oversell: requestedShares > basket.shares + 0.000001,
    };
  }
  const held = currentSharesForOutcome(market, outcomeId);
  const requestedShares = Math.max(0, Number(shares || 0));
  const safeShares = Math.min(requestedShares, held);
  const cashAmount = lmsrSellValueForShares(market, outcomeId, safeShares);
  const maxCash = lmsrSellValueForShares(market, outcomeId, held);
  return {
    shares: -safeShares,
    cashAmount,
    maxCash,
    held,
    oversell: requestedShares > held + 0.000001,
  };
}

function sellProfitLossEstimate(market, outcomeId, shares, avgSellPrice, side = state.trade.side || "yes") {
  if (!state.activeMember || !shares || shares <= 0) return null;
  const basis = averageBuyPriceForPosition(market, outcomeId, side);
  if (!basis || !Number.isFinite(basis.avgPrice) || basis.avgPrice <= 0) return null;
  const value = (Number(avgSellPrice || 0) - basis.avgPrice) * shares;
  return {
    value,
    percent: ((Number(avgSellPrice || 0) - basis.avgPrice) / basis.avgPrice) * 100,
    avgBuyPrice: basis.avgPrice,
  };
}

function averageBuyPriceForPosition(market, outcomeId, side = state.trade.side || "yes") {
  const outcomeIds = isComplementNoTrade(market, side)
    ? complementOutcomes(market, outcomeId).map(outcome => outcome.id)
    : [outcomeId];
  const wanted = new Set(outcomeIds);
  const trades = market.eventTrades?.length ? market.eventTrades : market.trades || [];
  let buyCash = 0;
  let buyShares = 0;
  const complementShares = new Map();
  for (const trade of trades) {
    if (trade.participant !== state.activeMember) continue;
    const tradeOutcomeId = trade.outcomeId || outcomeId;
    if (!wanted.has(tradeOutcomeId)) continue;
    if ((trade.action || "buy") !== "buy") continue;
    const sharesDelta = Math.abs(Number(trade.shares || trade.sharesDelta || 0));
    const cash = Math.abs(Number(trade.amount || trade.cashAmount || 0));
    if (sharesDelta <= 0 || cash <= 0) continue;
    buyCash += cash;
    buyShares += sharesDelta;
    if (isComplementNoTrade(market, side)) {
      complementShares.set(tradeOutcomeId, Number(complementShares.get(tradeOutcomeId) || 0) + sharesDelta);
    }
  }
  if (isComplementNoTrade(market, side)) {
    const syntheticShares = complementShares.size ? Math.min(...complementShares.values()) : 0;
    if (syntheticShares <= 0) return null;
    return { avgPrice: buyCash / syntheticShares, buyCash, buyShares: syntheticShares };
  }
  if (buyShares <= 0) return null;
  return { avgPrice: buyCash / buyShares, buyCash, buyShares };
}

function currentSharesForOutcome(market, outcomeId) {
  const member = state.activeMember;
  if (!member) return 0;
  return Number(market.positions?.[member]?.[outcomeId] || 0);
}

function tradeSellState(market, side = "yes") {
  const outcomes = market.outcomes?.length ? market.outcomes : [{ id: market.outcomeId || market.id }];
  const owned = outcomes.map(outcome => {
    const preview = lmsrPreview(market, outcome.id, "sell", 0);
    return { outcomeId: outcome.id, shares: preview.held || 0, maxCash: preview.maxCash || 0 };
  });
  const selectedOutcomeId = tradeOutcomeId(market, side);
  const selected = isComplementNoTrade(market, side)
    ? complementShareState(market, selectedOutcomeId)
    : (owned.find(item => item.outcomeId === selectedOutcomeId) || { shares: 0, maxCash: 0 });
  return {
    anyHeld: owned.some(item => item.shares > 0.000001),
    canSellSelected: selected.shares > 0.000001,
    shares: selected.shares,
    maxCash: selected.maxCash,
    owned,
  };
}

function sellLimitCopy(sellState) {
  if (!sellState.anyHeld) return "owned 0 shares";
  if (!sellState.shares) return "owned 0 shares";
  return `owned ${formatShares(sellState.shares)} shares`;
}

function firstSellableSide(market) {
  const yesState = tradeSellState(market, "yes");
  if (yesState.canSellSelected) return "yes";
  const noState = tradeSellState(market, "no");
  if (noState.canSellSelected) return "no";
  return null;
}

function updateTradeSubmitState(market, preview, amount) {
  const panel = findTradePanelForMarket(market.id);
  if (!panel) return;
  const submit = panel.querySelector(".trade-submit");
  const input = panel.querySelector(".trade-input");
  const mode = state.trade.mode || "buy";
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const buyCap = maxSingleBuyAmount(market);
  if (state.pendingUi.tradeMarketId === market.id) {
    if (submit) {
      submit.disabled = true;
      submit.classList.add("disabled", "is-loading");
    }
    return;
  }
  const insufficientBalance = mode === "buy" && Number(amount || 0) > balance;
  const exceedsBuyCap = mode === "buy" && Number(amount || 0) > buyCap + 0.000001;
  const shouldDisable = insufficientBalance || exceedsBuyCap || preview.needsQuote || (mode === "sell" && (!preview.held || preview.held <= 0 || preview.oversell || !amount || amount > preview.held + 0.000001));
  if (submit) {
    submit.disabled = shouldDisable;
    submit.classList.toggle("disabled", shouldDisable);
    if (exceedsBuyCap) {
      submit.textContent = `Max ${money(buyCap)}`;
    } else if (!state.pendingUi.tradeMarketId) {
      submit.textContent = `${mode === "sell" ? "Sell" : "Buy"} ${(state.trade.side || "yes").toUpperCase()}`;
    }
  }
  if (input && mode === "sell" && preview.held > 0) input.dataset.rawMax = formatShareInput(preview.held);
}

function liquidityGuidance(market, amount, spotPrice, avgPrice, preview = {}) {
  const liquidity = Number(market.liquidity ?? 0);
  const buyCap = maxSingleBuyAmount(market);
  const balanceLimitPct = amount / DEFAULT_BALANCE;
  const liquidityUse = liquidity > 0 ? amount / liquidity : 1;
  const priceImpact = spotPrice > 0 ? Math.abs(avgPrice - spotPrice) / spotPrice : 0;
  const maxComfort = Math.max(250, Math.min(DEFAULT_BALANCE, liquidity * 0.65));
  if (preview.oversell) {
    return { level: "warn", text: `Position too small. Max ${formatShares(preview.held || 0)} shares.` };
  }
  if (amount > DEFAULT_BALANCE) {
    return { level: "warn", text: `Above the ${money(DEFAULT_BALANCE)} allowance.` };
  }
  if ((state.trade.mode || "buy") === "buy" && amount > buyCap + 0.000001) {
    return { level: "warn", text: `Max single trade is ${money(buyCap)}. Split the order into smaller trades.` };
  }
  if (priceImpact > 0.35 || liquidityUse > 0.85) {
    return { level: "warn", text: `Thin liquidity: ${(priceImpact * 100).toFixed(1)}% price impact. Max comfortable ${money(maxComfort)}.` };
  }
  if (priceImpact > 0.18 || liquidityUse > 0.55 || balanceLimitPct > 0.5) {
    return { level: "caution", text: `Large fake-money order: ${(priceImpact * 100).toFixed(1)}% price impact.` };
  }
  return { level: "ok", text: `Healthy size: ${(priceImpact * 100).toFixed(1)}% price impact.` };
}

function maxSingleBuyAmount(market) {
  const liquidity = Number(market.initialLiquidity || market.liquidity || DEFAULT_MARKET_LIQUIDITY);
  return Math.max(1, liquidity / 2);
}

function setTradeSide(marketId, side) {
  if (state.pendingUi.tradeMarketId === marketId) return;
  const market = findMarket(marketId);
  if (!market) return;
  if ((state.trade.mode || "buy") === "sell" && !tradeSellState(market, side).canSellSelected) return;
  state.trade = { marketId, side, mode: state.trade.mode || "buy" };
  const panel = findTradePanelForMarket(marketId);
  if (!panel) return;
  syncTradePanelDataset(panel, market, side, state.trade.mode || "buy");

  panel.querySelectorAll(".trade-pick").forEach(button => {
    button.classList.toggle("active", button.dataset.buy === side);
  });

  const submit = panel.querySelector(".trade-submit");
  if (submit) {
    submit.classList.toggle("yes", side === "yes");
    submit.classList.toggle("no", side === "no");
    submit.textContent = `${(state.trade.mode || "buy") === "sell" ? "Sell" : "Buy"} ${side.toUpperCase()}`;
  }

  const sideLabel = panel.querySelector("[data-trade-side-label]");
  const activePick = panel.querySelector(`.trade-pick[data-buy="${side}"] span`);
  if (sideLabel) sideLabel.textContent = market.outcomes?.length > 2
    ? `${stripRegionalFlagGlyph(marketOptionTitle(market))} · ${side === "no" ? "No" : "Yes"}`
    : (activePick?.textContent || (side === "yes" ? "Yes" : "No"));
  if (sideLabel) sideLabel.innerHTML = tradeSideLabelHtml(sideLabel.textContent);
  const context = panel.querySelector(".trade-panel-context");
  context?.classList.toggle("yes", side === "yes");
  context?.classList.toggle("no", side === "no");

  const amountInput = panel.querySelector(".trade-input");
  renderTradePreview(market, tradeInputAmount(amountInput) || 0);
  updateRenderedTradeSellControls(market);
}

function setTradeMode(marketId, mode) {
  if (state.pendingUi.tradeMarketId === marketId) return;
  const market = findMarket(marketId);
  if (!market) return;
  const normalizedMode = mode === "sell" ? "sell" : "buy";
  let nextSide = state.trade.side || "yes";
  if (normalizedMode === "sell") {
    if (!tradeSellState(market, nextSide).canSellSelected) {
      nextSide = firstSellableSide(market) || nextSide;
    }
    if (!tradeSellState(market, nextSide).canSellSelected) return;
  }
  state.trade = { marketId, side: nextSide, mode: normalizedMode };
  const panel = findTradePanelForMarket(marketId);
  if (!panel) return;
  syncTradePanelDataset(panel, market, nextSide, normalizedMode);
  panel.querySelectorAll("[data-trade-mode]").forEach(button => {
    button.classList.toggle("active", button.dataset.tradeMode === normalizedMode);
  });
  const submit = panel.querySelector(".trade-submit");
  if (submit) {
    submit.textContent = `${normalizedMode === "sell" ? "Sell" : "Buy"} ${nextSide.toUpperCase()}`;
    submit.classList.toggle("yes", nextSide === "yes");
    submit.classList.toggle("no", nextSide === "no");
  }
  const amountInput = panel.querySelector(".trade-input");
  if (amountInput) {
    amountInput.value = "";
    delete amountInput.dataset.rawAmount;
    amountInput.disabled = normalizedMode === "sell" && !tradeSellState(market, nextSide).canSellSelected;
  }
  panel.querySelectorAll(".trade-pick").forEach(button => {
    button.classList.toggle("active", button.dataset.buy === nextSide);
  });
  const sideLabel = panel.querySelector("[data-trade-side-label]");
  const activePick = panel.querySelector(`.trade-pick[data-buy="${nextSide}"] span`);
  if (sideLabel) sideLabel.textContent = market.outcomes?.length > 2
    ? `${stripRegionalFlagGlyph(marketOptionTitle(market))} · ${nextSide === "no" ? "No" : "Yes"}`
    : (activePick?.textContent || (nextSide === "yes" ? "Yes" : "No"));
  if (sideLabel) sideLabel.innerHTML = tradeSideLabelHtml(sideLabel.textContent);
  const context = panel.querySelector(".trade-panel-context");
  context?.classList.toggle("yes", nextSide === "yes");
  context?.classList.toggle("no", nextSide === "no");
  renderTradePreview(market, tradeInputAmount(amountInput) || 0);
  updateRenderedTradeSellControls(market);
}

function updateRenderedTradeSellControls(market) {
  const panel = findTradePanelForMarket(market.id);
  if (!panel) return;
  const mode = state.trade.mode || "buy";
  const sellState = tradeSellState(market, state.trade.side || "yes");
  syncTradePanelDataset(panel, market, state.trade.side || "yes", mode);
  const input = panel.querySelector(".trade-input");
  const inputRow = panel.querySelector(".trade-input-row");
  const inputLabel = panel.querySelector("[data-trade-input-label]");
  const submit = panel.querySelector(".trade-submit");
  const limitCopy = panel.querySelector("[data-trade-limit-copy]");
  const chipRow = panel.querySelector(".trade-chip-row");
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? DEFAULT_BALANCE;
  const max = Math.max(0, mode === "sell" ? sellState.shares : Math.floor(Math.min(balance, maxSingleBuyAmount(market))));
  if (inputLabel) inputLabel.textContent = mode === "sell" ? "Shares" : "Amount";
  if (limitCopy) limitCopy.textContent = mode === "sell" ? sellLimitCopy(sellState) : `${money(getCurrentGroup()?.balances?.[state.activeMember] ?? 0)} cash`;
  if (inputRow) {
    inputRow.classList.toggle("sell", mode === "sell");
    inputRow.classList.toggle("buy", mode !== "sell");
    const suffix = inputRow.querySelector(".trade-suffix");
    if (mode === "sell") {
      suffix?.remove();
    } else if (!suffix) {
      inputRow.insertAdjacentHTML("afterbegin", `<span class="trade-suffix">$</span>`);
    }
  }
  if (input) {
    input.min = mode === "sell" ? "0.01" : "1";
    input.step = "any";
    input.dataset.rawMax = formatShareInput(max);
    if (mode === "sell") input.removeAttribute("max");
    else input.max = String(max);
    input.disabled = mode === "sell" && !sellState.canSellSelected;
  }
  if (submit) {
    const disabled = mode === "sell" && !sellState.canSellSelected;
    submit.disabled = disabled;
    submit.classList.toggle("disabled", disabled);
  }
  if (chipRow) {
    chipRow.classList.toggle("sell", mode === "sell");
    chipRow.innerHTML = tradeAmountChips(mode, max, mode === "sell" && !sellState.canSellSelected);
  }
  panel.querySelectorAll("[data-fill-amount], [data-fill-percent]").forEach(button => {
    const isMax = button.dataset.fillAmount === "max";
    button.disabled = mode === "sell" && (!sellState.canSellSelected || (isMax && sellState.shares <= 0));
  });
  panel.querySelectorAll(".trade-pick").forEach(button => {
    const side = button.dataset.buy || "yes";
    const disabled = mode === "sell" && !tradeSellState(market, side).canSellSelected;
    button.disabled = disabled;
    button.classList.toggle("disabled", disabled);
  });
}

function emptyTrade() {
  return { marketId: null, side: null, mode: "buy" };
}

function refreshLeaderboardComponent() {
  const group = getCurrentGroup();
  if (!group) {
    render();
    return;
  }

  if (state.view === "leaderboard") {
    const controlsToggle = document.querySelector(".probable-leaderboard-controls .gain-toggle");
    if (controlsToggle) controlsToggle.outerHTML = leaderboardMetricToggle();

    const stage = document.querySelector(".probable-leaderboard-stage");
    if (stage) {
      stage.outerHTML = expandedLeaderboard(leaderboardEntries(group));
      return;
    }
  }

  const compactPanel = document.querySelector(".leaderboard-compact-panel");
  if (compactPanel) {
    compactPanel.outerHTML = leaderboardPanel(group, { limit: compactLeaderboardLimit(), compact: true });
    return;
  }

  const leaderboardPanelEl = document.querySelector(".leaderboard-panel");
  if (leaderboardPanelEl) {
    leaderboardPanelEl.outerHTML = leaderboardPanel(group);
    return;
  }

  render();
}

function renderLeaderboard() {
  const group = getCurrentGroup();
  if (!group) {
    renderEmptyDashboard();
    return;
  }
  const entries = leaderboardEntries(group);
  dom.mainContent.innerHTML = `
    <section class="leaderboard-page leaderboard-expanded-page probable-leaderboard-page">
      <div class="leaderboard-topbar motion-item">
        <div>
          <p class="eyebrow">${esc(group.name)} leaderboard</p>
          <h1>Portfolio race</h1>
          <p>${state.leaderboardMetric === "percent" ? "Ranked by return on money actually put into trades." : "Ranked by nominal gain from each trader's starting bankroll."}</p>
        </div>
        <div class="leaderboard-controls probable-leaderboard-controls">
          ${leaderboardMetricToggle()}
          <button class="btn btn-ghost btn-sm" type="button" data-go-dashboard>Back</button>
        </div>
      </div>
      ${expandedLeaderboard(entries)}
    </section>`;
}

function bracketStorageKey() {
  const owner = bracketParticipantName();
  return `probable_bracket_${BRACKET_CHALLENGE.id}_${slug(owner) || "guest"}`;
}

function bracketParticipantName() {
  return authDisplayName() || state.activeMember || state.authUser?.email || localStorage.getItem(STORAGE_KEYS.user) || "Guest";
}

function loadBracketEntry() {
  try {
    const raw = localStorage.getItem(bracketStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadBracketEntryIntoState() {
  const entry = loadBracketEntry();
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem("probable_pending_bracket") || "null");
  } catch {
    pending = null;
  }
  state.bracketPicks = entry?.picks && typeof entry.picks === "object"
    ? { ...entry.picks }
    : pending?.picks && typeof pending.picks === "object"
      ? { ...pending.picks }
      : {};
  state.bracketSubmitted = Boolean(entry?.submittedAt);
  state.bracketEntryId = entry?.entryId || entry?.id || "";
  normalizeBracketPicks();
}

function persistBracketEntry({ submitted = state.bracketSubmitted, submittedAt = null } = {}) {
  const previous = loadBracketEntry();
  const payload = {
    challengeId: BRACKET_CHALLENGE.id,
    entryId: previous?.entryId || previous?.id || state.bracketEntryId || "",
    name: bracketParticipantName(),
    prize: BRACKET_CHALLENGE.prize,
    picks: { ...state.bracketPicks },
    submittedAt: submitted ? (submittedAt || previous?.submittedAt || new Date().toISOString()) : null,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(bracketStorageKey(), JSON.stringify(payload));
  state.bracketSubmitted = Boolean(payload.submittedAt);
  state.bracketEntryId = payload.entryId || "";
  return payload;
}

function applyRemoteBracketEntry(entry) {
  if (!entry) return false;
  state.bracketPicks = entry.picks && typeof entry.picks === "object" ? { ...entry.picks } : {};
  state.bracketSubmitted = Boolean(entry.submittedAt);
  state.bracketEntryId = entry.id || "";
  normalizeBracketPicks();
  persistBracketEntry({ submitted: state.bracketSubmitted, submittedAt: entry.submittedAt });
  return true;
}

async function loadRemoteBracketEntry({ refresh = false } = {}) {
  const sharedEntry = state.sharedBracketEntryId || "";
  if (!isLoggedIn() && !sharedEntry) return null;
  const participant = bracketParticipantName();
  if (!participant && !sharedEntry) return null;
  try {
    const query = sharedEntry
      ? `entry=${encodeURIComponent(sharedEntry)}`
      : `participant=${encodeURIComponent(participant)}`;
    const data = await api(`/api/brackets/${encodeURIComponent(BRACKET_CHALLENGE.id)}/entry?${query}`, {
      timeoutMs: API_TIMEOUT_MS,
    });
    state.bracketRemoteLoaded = true;
    if (applyRemoteBracketEntry(data.entry) && refresh) refreshBracketChallenge();
    return data.entry || null;
  } catch (err) {
    state.bracketRemoteLoaded = false;
    console.warn("Bracket entry load failed", err);
    return null;
  }
}

async function saveBracketEntry({ submitted = state.bracketSubmitted, silent = true } = {}) {
  if (state.bracketSubmitted && !submitted) {
    return loadBracketEntry();
  }
  const local = persistBracketEntry({ submitted });
  if (!isLoggedIn()) return local;
  state.bracketSaving = true;
  try {
    const data = await api(`/api/brackets/${encodeURIComponent(BRACKET_CHALLENGE.id)}/entry`, {
      method: "POST",
      body: JSON.stringify({
        participant: bracketParticipantName(),
        userEmail: state.authUser?.email || null,
        picks: state.bracketPicks,
        submitted,
      }),
    });
    if (data.entry) {
      state.bracketEntryId = data.entry.id || state.bracketEntryId || "";
      state.bracketSubmitted = Boolean(data.entry.submittedAt);
      persistBracketEntry({ submitted: state.bracketSubmitted, submittedAt: data.entry.submittedAt });
    }
    return data.entry || local;
  } catch (err) {
    if (!silent) toast(err.message || "Could not save bracket.");
    throw err;
  } finally {
    state.bracketSaving = false;
  }
}

function bracketOfficialWinner(id) {
  return BRACKET_LOCKED_WINNERS[id] || "";
}

function bracketUserPick(id) {
  return state.bracketPicks?.[id] || "";
}

function predictedWinner(id) {
  return bracketUserPick(id) || bracketOfficialWinner(id) || "";
}

function displayWinner(id) {
  return predictedWinner(id);
}

function bracketWinner(id) {
  return displayWinner(id);
}

function bracketEliminatedTeams() {
  const eliminated = new Set();
  for (const matchup of BRACKET_CHALLENGE.matchups) {
    const winner = bracketOfficialWinner(matchup.id);
    if (!winner) continue;
    for (const team of matchup.teams || []) {
      if (team && team !== winner) eliminated.add(team);
    }
  }
  for (const round of bracketRounds()) {
    for (const matchup of round.matchups || []) {
      const winner = bracketOfficialWinner(matchup.id);
      if (!winner) continue;
      for (const team of matchup.teams || []) {
        if (team && team !== winner) eliminated.add(team);
      }
    }
  }
  return eliminated;
}

function bracketTeamStatusClass(matchup, team) {
  if (!matchup?.id || !team) return "";
  const officialWinner = bracketOfficialWinner(matchup.id);
  const userPick = bracketUserPick(matchup.id);
  if (officialWinner) {
    if (userPick && userPick === team) {
      return team === officialWinner ? "correct-pick" : "wrong-pick";
    }
    if (!userPick && team === officialWinner) return "auto-advance";
    return team === officialWinner ? "auto-advance" : "official-loser";
  }
  if (bracketEliminatedTeams().has(team)) return "dead-pick";
  return userPick === team ? "user-pick" : "";
}

function bracketMatchup(id, sourceA, sourceB) {
  const teams = [
    typeof sourceA === "function" ? sourceA() : sourceA,
    typeof sourceB === "function" ? sourceB() : sourceB,
  ].filter(Boolean);
  return { id, teams };
}

function bracketRounds() {
  const r32 = BRACKET_CHALLENGE.matchups.map(item => ({ ...item }));
  const r16 = [
    bracketMatchup("m89", () => bracketWinner("m74"), () => bracketWinner("m77")),
    bracketMatchup("m90", () => bracketWinner("m73"), () => bracketWinner("m75")),
    bracketMatchup("m91", () => bracketWinner("m76"), () => bracketWinner("m78")),
    bracketMatchup("m92", () => bracketWinner("m79"), () => bracketWinner("m80")),
    bracketMatchup("m93", () => bracketWinner("m81"), () => bracketWinner("m82")),
    bracketMatchup("m94", () => bracketWinner("m83"), () => bracketWinner("m84")),
    bracketMatchup("m95", () => bracketWinner("m86"), () => bracketWinner("m88")),
    bracketMatchup("m96", () => bracketWinner("m85"), () => bracketWinner("m87")),
  ];
  const qf = [
    bracketMatchup("m97", () => bracketWinner("m89"), () => bracketWinner("m90")),
    bracketMatchup("m98", () => bracketWinner("m93"), () => bracketWinner("m94")),
    bracketMatchup("m99", () => bracketWinner("m91"), () => bracketWinner("m92")),
    bracketMatchup("m100", () => bracketWinner("m95"), () => bracketWinner("m96")),
  ];
  const sf = [
    bracketMatchup("m101", () => bracketWinner("m97"), () => bracketWinner("m98")),
    bracketMatchup("m102", () => bracketWinner("m99"), () => bracketWinner("m100")),
  ];
  const final = [
    bracketMatchup("final", () => bracketWinner("m101"), () => bracketWinner("m102")),
  ];
  return [
    { id: "r32", name: "Round of 32", matchups: r32 },
    { id: "r16", name: "Round of 16", matchups: r16 },
    { id: "qf", name: "Quarterfinals", matchups: qf },
    { id: "sf", name: "Semifinals", matchups: sf },
    { id: "final", name: "Final", matchups: final },
  ];
}

function normalizeBracketPicks() {
  const validIds = new Set();
  for (const round of bracketRounds()) {
    for (const matchup of round.matchups) {
      validIds.add(matchup.id);
    }
  }
  for (const id of Object.keys(state.bracketPicks)) {
    if (!validIds.has(id)) delete state.bracketPicks[id];
    if (!state.bracketSubmitted && BRACKET_LOCKED_WINNERS[id]) {
      delete state.bracketPicks[id];
    }
  }
}

function pickBracketTeam(matchupId, team) {
  if (!matchupId || !team) return;
  if (BRACKET_LOCKED_WINNERS[matchupId]) return;
  if (state.bracketSubmitted) {
    toast("Bracket already submitted and locked.");
    return;
  }
  state.bracketPicks[matchupId] = team;
  normalizeBracketPicks();
  state.bracketSubmitted = false;
  state.bracketLastPickedId = matchupId;
  void saveBracketEntry({ submitted: false, silent: true }).catch(() => {});
}

function bracketComplete() {
  normalizeBracketPicks();
  return Boolean(bracketWinner("final"));
}

function moveBracketRound(delta) {
  const rounds = bracketRounds();
  const next = Math.max(0, Math.min(rounds.length - 1, Number(state.bracketRoundIndex || 0) + delta));
  state.bracketRoundIndex = next;
}

function bracketRoundPickCount(round) {
  return (round?.matchups || []).filter(matchup => Boolean(bracketWinner(matchup.id))).length;
}

function bracketProgress(rounds) {
  const total = rounds.reduce((sum, round) => sum + round.matchups.length, 0);
  const picked = rounds.reduce((sum, round) => sum + bracketRoundPickCount(round), 0);
  return { picked, total, pct: total ? Math.round((picked / total) * 100) : 0 };
}

async function submitBracketEntry() {
  if (!bracketComplete()) {
    toast("Finish the bracket before submitting.");
    return;
  }
  if (!isLoggedIn()) {
    sessionStorage.setItem("probable_pending_bracket", JSON.stringify({ picks: state.bracketPicks }));
    requireLogin("submit-bracket");
    return;
  }
  sessionStorage.removeItem("probable_pending_bracket");
  try {
    await saveBracketEntry({ submitted: true, silent: false });
    refreshBracketChallenge();
    toast(`Bracket submitted for the ${BRACKET_CHALLENGE.prize} prize.`);
  } catch {
    // saveBracketEntry already surfaced the useful message.
  }
}

function refreshBracketChallenge({ preserveScroll = true } = {}) {
  if (state.view !== "bracket") {
    render();
    return;
  }
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  renderBracketChallenge();
  if (!preserveScroll) return;
  requestAnimationFrame(() => {
    window.scrollTo(scrollX, scrollY);
    animateBracketAdvance();
  });
}

function animateBracketAdvance() {
  if (!state.bracketLastPickedId) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const targets = document.querySelectorAll(".bracket-mini-match.just-picked, .bracket-matchup.just-picked");
  if (!targets.length) return;
  animate(targets, { scale: [0.985, 1.012, 1], opacity: [0.92, 1] }, { duration: 0.38, easing: "ease-out" });
  const activeRows = document.querySelectorAll(".bracket-mini-match.just-picked .active, .bracket-matchup.just-picked .active");
  if (activeRows.length) {
    animate(activeRows, { boxShadow: ["inset 4px 0 0 #169bff", "inset 4px 0 0 #2d9cff"] }, { duration: 0.42 });
  }
  window.setTimeout(() => {
    state.bracketLastPickedId = "";
  }, 650);
}

function teamFlag(team) {
  const flags = {
    Algeria: "🇩🇿",
    Argentina: "🇦🇷",
    Australia: "🇦🇺",
    Austria: "🇦🇹",
    Belgium: "🇧🇪",
    "Bosnia and Herzegovina": "🇧🇦",
    Brazil: "🇧🇷",
    Canada: "🇨🇦",
    "Cabo Verde": "🇨🇻",
    Colombia: "🇨🇴",
    Croatia: "🇭🇷",
    "DR Congo": "🇨🇩",
    Ecuador: "🇪🇨",
    Egypt: "🇪🇬",
    England: "ENG",
    France: "🇫🇷",
    Germany: "🇩🇪",
    Ghana: "🇬🇭",
    Italy: "🇮🇹",
    "Ivory Coast": "🇨🇮",
    Japan: "🇯🇵",
    Mexico: "🇲🇽",
    Morocco: "🇲🇦",
    Netherlands: "🇳🇱",
    Norway: "🇳🇴",
    Paraguay: "🇵🇾",
    Portugal: "🇵🇹",
    Scotland: "SCO",
    Senegal: "🇸🇳",
    "South Africa": "🇿🇦",
    "South Korea": "🇰🇷",
    Spain: "🇪🇸",
    Sweden: "🇸🇪",
    Switzerland: "🇨🇭",
    Turkey: "🇹🇷",
    Uruguay: "🇺🇾",
    USA: "🇺🇸",
  };
  return flags[team] || "⚽";
}

function teamFlagCode(team) {
  const codes = {
    Algeria: "dz",
    Argentina: "ar",
    Australia: "au",
    Austria: "at",
    Belgium: "be",
    "Bosnia and Herzegovina": "ba",
    Brazil: "br",
    Canada: "ca",
    "Cabo Verde": "cv",
    Colombia: "co",
    Croatia: "hr",
    "DR Congo": "cd",
    Ecuador: "ec",
    Egypt: "eg",
    England: "gb-eng",
    France: "fr",
    Germany: "de",
    Ghana: "gh",
    Italy: "it",
    "Ivory Coast": "ci",
    Japan: "jp",
    Mexico: "mx",
    Morocco: "ma",
    Netherlands: "nl",
    Norway: "no",
    Paraguay: "py",
    Portugal: "pt",
    Scotland: "gb-sct",
    Senegal: "sn",
    "South Africa": "za",
    "South Korea": "kr",
    Spain: "es",
    Sweden: "se",
    Switzerland: "ch",
    Turkey: "tr",
    Uruguay: "uy",
    USA: "us",
  };
  return codes[team] || "";
}

function teamFlagHtml(team) {
  const code = teamFlagCode(team);
  if (code) {
    return `<span class="bracket-flag-token" aria-hidden="true"><img src="https://flagcdn.com/${esc(code)}.svg" alt="" loading="lazy" /></span>`;
  }
  return `<span class="bracket-flag-token" aria-hidden="true"><span class="bracket-emoji-flag">${esc(teamFlag(team))}</span></span>`;
}

function bracketChanceText(team) {
  const chance = Number(BRACKET_TEAM_CHANCES[team] ?? 1);
  return chance < 1 ? "<1%" : `${Math.round(chance)}%`;
}

function bracketChanceWidth(team) {
  const chance = Number(BRACKET_TEAM_CHANCES[team] ?? 1);
  return Math.max(3, Math.min(100, chance * 4));
}

function bracketMatchupHtml(matchup, index = 0) {
  const winner = bracketWinner(matchup.id);
  const empty = matchup.teams.length < 2;
  const teams = empty ? [...matchup.teams, ...Array(2 - matchup.teams.length).fill("")] : matchup.teams.slice(0, 2);
  const locked = Boolean(BRACKET_LOCKED_WINNERS[matchup.id]);
  const missing = teams.every(team => !team);
  const waiting = empty || missing;
  return `
    <article class="bracket-matchup ${winner ? "picked" : ""} ${locked ? "locked" : ""} ${waiting ? "waiting empty" : ""} ${state.bracketLastPickedId === matchup.id ? "just-picked" : ""}">
      ${waiting ? `
        <div class="bracket-pick-slot waiting">
          <span>·</span>
          <strong>Unlocks after previous picks</strong>
        </div>
      ` : !locked && !winner ? `
        <div class="bracket-pick-slot">
          <span>+</span>
          <strong>Pick to advance</strong>
          <em>⌄</em>
        </div>
      ` : ""}
      ${locked ? `<span class="bracket-match-tag">Final: ${esc(winner)} advanced</span>` : ""}
      ${waiting ? "" : teams.map(team => team ? `
        <button class="bracket-team ${winner === team ? "active" : ""} ${bracketTeamStatusClass(matchup, team)} ${locked && !bracketUserPick(matchup.id) && winner === team ? "preset" : ""}" type="button" data-bracket-pick="${esc(matchup.id)}" data-team="${esc(team)}" ${locked ? "disabled" : ""}>
          <span class="bracket-team-main">
            ${teamFlagHtml(team)}
            <strong>${esc(team)}</strong>
          </span>
          <span class="bracket-team-chance">${bracketChanceText(team)}</span>
          <span class="bracket-team-bar" style="--bar-width:${bracketChanceWidth(team)}%"></span>
        </button>
      ` : "").join("")}
    </article>
  `;
}

function bracketRoundShellHtml(rounds, champion) {
  const roundIndex = Math.max(0, Math.min(rounds.length - 1, Number(state.bracketRoundIndex || 0)));
  state.bracketRoundIndex = roundIndex;
  const round = rounds[roundIndex];
  const progress = bracketProgress(rounds);
  const pickedInRound = bracketRoundPickCount(round);
  return `
    <div class="bracket-progress-bar" aria-hidden="true">
      <span style="width:${progress.pct}%"></span>
    </div>
    <div class="bracket-stage-nav">
      <button class="bracket-nav-btn" type="button" data-bracket-round-nav="-1" ${roundIndex === 0 ? "disabled" : ""} aria-label="Previous round">‹</button>
      <div>
        <h2>${esc(round.name)}</h2>
        <p>${pickedInRound}/${round.matchups.length} picked</p>
      </div>
      <button class="bracket-nav-btn" type="button" data-bracket-round-nav="1" ${roundIndex === rounds.length - 1 ? "disabled" : ""} aria-label="Next round">›</button>
    </div>
    <div class="bracket-board motion-item">
      <section class="bracket-focused-round">
        <div class="bracket-round-list">
          ${round.matchups.map((matchup, index) => bracketMatchupHtml(matchup, index)).join("")}
        </div>
      </section>
      <aside class="bracket-side-summary">
        <div class="bracket-winner-card">
          ${champion ? `${teamFlagHtml(champion)}<strong>${esc(champion)}</strong><small>Your winner</small>` : `<span>🏆</span><strong>No winner yet</strong><small>Complete the final</small>`}
        </div>
        <div class="bracket-faq-card">
          <h3>Rules & FAQ</h3>
          <p>Submit one bracket before entries close. If nobody is perfect, the best bracket wins.</p>
        </div>
      </aside>
    </div>
  `;
}

function bracketMiniCellHtml(matchup, options = {}) {
  const winner = bracketWinner(matchup.id);
  const hasChoices = matchup.teams.length >= 2;
  const teams = hasChoices ? matchup.teams.slice(0, 2) : [];
  const locked = Boolean(BRACKET_LOCKED_WINNERS[matchup.id]);
  const depth = Number(options?.depth ?? 0);
  const mobile = Boolean(options?.mobile);
  const compact = !mobile && depth >= 2;
  const row = !mobile && typeof options === "object" && Number.isFinite(Number(options.row))
    ? ` style="--bracket-row:${Number(options.row)}"`
    : "";
  if (!hasChoices) {
    const waitingTeams = [...matchup.teams, ...Array(2 - matchup.teams.length).fill("")].slice(0, 2);
    return `
      <article class="bracket-mini-match waiting ${matchup.teams.length ? "has-pending" : "empty"} ${compact ? "compact" : ""} ${state.bracketLastPickedId === matchup.id ? "just-picked" : ""}" data-matchup-id="${esc(matchup.id)}"${row}>
        ${waitingTeams.map(team => team ? `
          <div class="bracket-mini-team pending-team" title="${esc(team)}">
            ${teamFlagHtml(team)}
            ${compact ? `<strong class="sr-only">${esc(team)}</strong>` : `<strong>${esc(team)}</strong>`}
          </div>
        ` : `
          <div class="bracket-mini-team placeholder">
            <span>·</span>
            ${compact ? `<strong class="sr-only">Awaiting</strong>` : `<strong>Awaiting</strong>`}
          </div>
        `).join("")}
      </article>
    `;
  }
  return `
    <article class="bracket-mini-match ready ${compact ? "compact" : ""} ${winner ? "picked" : ""} ${locked ? "locked" : ""} ${state.bracketLastPickedId === matchup.id ? "just-picked" : ""}" data-matchup-id="${esc(matchup.id)}"${row}>
      ${teams.slice(0, 2).map(team => team ? `
        <button class="bracket-mini-team ${winner === team ? "active" : ""} ${bracketTeamStatusClass(matchup, team)} ${locked && !bracketUserPick(matchup.id) && winner === team ? "preset" : ""} ${locked && winner !== team ? "locked-loser" : ""}" type="button" data-bracket-pick="${esc(matchup.id)}" data-team="${esc(team)}" aria-label="${esc(team)}" title="${esc(team)}" ${locked ? "disabled" : ""}>
          ${teamFlagHtml(team)}
          ${compact ? `<strong class="sr-only">${esc(team)}</strong>` : `<strong>${esc(team)}</strong>`}
        </button>
      ` : "").join("")}
    </article>
  `;
}

function bracketStageReadyMatchups(stage) {
  return (stage?.matchups || []).filter(matchup => matchup.teams.length >= 2);
}

function bracketIncomingConnectorHtml(stage, index) {
  if (!stage || Number(stage.depth) <= 0) return "";
  const previousMatchCount = stage.matchups.length * 2;
  const topCenterLine = bracketGridRowForMatch(previousMatchCount, index * 2) + 1;
  const bottomCenterLine = bracketGridRowForMatch(previousMatchCount, index * 2 + 1) + 1;
  return `
    <span
      class="bracket-connector"
      aria-hidden="true"
      style="--connector-start:${topCenterLine}; --connector-end:${bottomCenterLine}"
    ></span>
  `;
}

function bracketGridRowForMatch(matchCount, index) {
  if (matchCount >= 8) return index * 2 + 1;
  if (matchCount === 4) return index * 4 + 2;
  if (matchCount === 2) return index * 8 + 4;
  return 8;
}

function bracketMatchupsByIds(round, ids) {
  const lookup = new Map((round?.matchups || []).map(matchup => [matchup.id, matchup]));
  return ids.map(id => lookup.get(id)).filter(Boolean);
}

function bracketSideStages(rounds, side) {
  const left = side === "left";
  const sideIds = left
    ? [
        ["m74", "m77", "m73", "m75", "m81", "m82", "m83", "m84"],
        ["m89", "m90", "m93", "m94"],
        ["m97", "m98"],
        ["m101"],
      ]
    : [
        ["m76", "m78", "m79", "m80", "m86", "m88", "m85", "m87"],
        ["m91", "m92", "m95", "m96"],
        ["m99", "m100"],
        ["m102"],
      ];
  const source = sideIds.map((ids, index) => ({
    round: rounds[index],
    matchups: bracketMatchupsByIds(rounds[index], ids),
    depth: index,
  }));
  return left ? source : source.reverse();
}

function bracketGridRoundLabel(name) {
  if (name === "Round of 16") return "R16";
  if (name === "Quarterfinals") return "QF";
  if (name === "Semifinals") return "SF";
  return name;
}

function bracketSvgTeamRow(matchup, team, x, y, width, height, active, compact = false) {
  const locked = Boolean(BRACKET_LOCKED_WINNERS[matchup.id]);
  const flagCode = teamFlagCode(team);
  const flag = flagCode
    ? `<image href="https://flagcdn.com/${esc(flagCode)}.svg" x="${x + 10}" y="${y + 6}" width="22" height="15" preserveAspectRatio="xMidYMid slice" />`
    : `<text class="bracket-svg-flag-text" x="${x + 21}" y="${y + 18}" text-anchor="middle">${esc(teamFlag(team))}</text>`;
  const label = compact && width < 130 ? team.slice(0, 3).toUpperCase() : team;
  const data = BRACKET_LOCKED_WINNERS[matchup.id] ? "" : `data-bracket-pick="${esc(matchup.id)}" data-team="${esc(team)}"`;
  return `
    <g class="bracket-svg-team ${active ? "active" : ""} ${bracketTeamStatusClass(matchup, team)} ${locked && !bracketUserPick(matchup.id) && active ? "preset" : ""} ${locked && !active ? "locked-loser" : ""}" ${data} role="button" tabindex="0" aria-label="Pick ${esc(team)}">
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" />
      ${flag}
      <text class="bracket-svg-team-name" x="${x + 40}" y="${y + height / 2 + 4}">${esc(label)}</text>
    </g>
  `;
}

function bracketSvgMatch(matchup, x, y, width, options = {}) {
  const rowH = Number(options.rowH || 22);
  const compact = Boolean(options.compact);
  const winner = bracketWinner(matchup.id);
  const teams = [...(matchup.teams || []), "", ""].slice(0, 2);
  const empty = teams.every(team => !team);
  if (empty) {
    return `
      <g class="bracket-svg-match waiting" data-matchup-id="${esc(matchup.id)}">
        <rect x="${x}" y="${y}" width="${width}" height="${rowH * 2}" rx="10" />
        <text x="${x + width / 2}" y="${y + rowH + 4}" text-anchor="middle">Awaiting</text>
      </g>
    `;
  }
  return `
    <g class="bracket-svg-match ${winner ? "picked" : ""}" data-matchup-id="${esc(matchup.id)}">
      <rect class="bracket-svg-shell-rect" x="${x}" y="${y}" width="${width}" height="${rowH * 2}" rx="10" />
      ${teams.map((team, index) => team
        ? bracketSvgTeamRow(matchup, team, x, y + index * rowH, width, rowH, winner === team, compact)
        : `<g class="bracket-svg-team empty"><rect x="${x}" y="${y + index * rowH}" width="${width}" height="${rowH}" rx="8" /><text x="${x + width / 2}" y="${y + index * rowH + rowH / 2 + 4}" text-anchor="middle">Awaiting</text></g>`
      ).join("")}
    </g>
  `;
}

function bracketSvgConnector(side, fromCenters, toCenter, fromX, toX) {
  if (!fromCenters.length || !Number.isFinite(toCenter)) return "";
  const midX = side === "left" ? fromX + (toX - fromX) * 0.52 : toX + (fromX - toX) * 0.52;
  const first = fromCenters[0];
  const last = fromCenters[fromCenters.length - 1];
  const top = Math.min(first, last, toCenter);
  const bottom = Math.max(first, last, toCenter);
  const segments = fromCenters.map(y => `<path d="M ${fromX} ${y} H ${midX}" />`).join("");
  return `
    <g class="bracket-svg-lines">
      ${segments}
      <path d="M ${midX} ${top} V ${bottom}" />
      <path d="M ${midX} ${toCenter} H ${toX}" />
    </g>
  `;
}

function bracketSvgRoundMap(rounds) {
  return new Map(rounds.flatMap(round => round.matchups.map(matchup => [matchup.id, matchup])));
}

function bracketSvgHtml(rounds, champion) {
  const lookup = bracketSvgRoundMap(rounds);
  const sideConfig = {
    left: {
      ids: [
        ["m74", "m77", "m73", "m75", "m81", "m82", "m83", "m84"],
        ["m89", "m90", "m93", "m94"],
        ["m97", "m98"],
        ["m101"],
      ],
      x: [48, 310, 520, 670],
      widths: [240, 180, 130, 105],
      edge(match, stage) { return this.x[stage] + this.widths[stage]; },
      targetEdge(stage) { return this.x[stage + 1]; },
    },
    right: {
      ids: [
        ["m76", "m78", "m79", "m80", "m86", "m88", "m85", "m87"],
        ["m91", "m92", "m95", "m96"],
        ["m99", "m100"],
        ["m102"],
      ],
      x: [1312, 1110, 950, 825],
      widths: [240, 180, 130, 105],
      edge(match, stage) { return this.x[stage]; },
      targetEdge(stage) { return this.x[stage + 1] + this.widths[stage + 1]; },
    },
  };
  const y0 = 46;
  const gap = 16;
  const rowH = 29;
  const cardH = rowH * 2;
  const centers = { left: [], right: [] };
  const cards = [];
  const lines = [];

  for (const side of ["left", "right"]) {
    const cfg = sideConfig[side];
    centers[side] = cfg.ids.map(() => []);
    for (const [stage, ids] of cfg.ids.entries()) {
      const width = cfg.widths[stage];
      for (const [index, id] of ids.entries()) {
        const matchup = lookup.get(id);
        if (!matchup) continue;
        let y;
        if (stage === 0) {
          y = y0 + index * (cardH + gap);
        } else {
          const parentA = centers[side][stage - 1][index * 2];
          const parentB = centers[side][stage - 1][index * 2 + 1];
          y = ((parentA + parentB) / 2) - cardH / 2;
          lines.push(bracketSvgConnector(side, [parentA, parentB], y + cardH / 2, cfg.edge(null, stage - 1), cfg.targetEdge(stage - 1)));
        }
        centers[side][stage][index] = y + cardH / 2;
        cards.push(bracketSvgMatch(matchup, cfg.x[stage], y, width, { rowH, compact: stage >= 2 }));
      }
    }
  }

  const finalMatch = lookup.get("final");
  const finalX = 735;
  const finalY = 526;
  const finalW = 130;
  const leftSf = centers.left[3][0];
  const rightSf = centers.right[3][0];
  lines.push(bracketSvgConnector("left", [leftSf], finalY + cardH / 2, sideConfig.left.x[3] + sideConfig.left.widths[3], finalX));
  lines.push(bracketSvgConnector("right", [rightSf], finalY + cardH / 2, sideConfig.right.x[3], finalX + finalW));

  return `
    <svg class="bracket-svg" viewBox="0 0 1600 765" role="img" aria-label="World Cup bracket path">
      <text class="bracket-svg-title" x="160" y="26" text-anchor="middle">ROUND OF 32</text>
      <text class="bracket-svg-title" x="400" y="26" text-anchor="middle">R16</text>
      <text class="bracket-svg-title" x="585" y="26" text-anchor="middle">QF</text>
      <text class="bracket-svg-title" x="722" y="26" text-anchor="middle">SF</text>
      <text class="bracket-svg-title" x="800" y="512" text-anchor="middle">FINAL</text>
      <text class="bracket-svg-title" x="878" y="26" text-anchor="middle">SF</text>
      <text class="bracket-svg-title" x="1015" y="26" text-anchor="middle">QF</text>
      <text class="bracket-svg-title" x="1200" y="26" text-anchor="middle">R16</text>
      <text class="bracket-svg-title" x="1438" y="26" text-anchor="middle">ROUND OF 32</text>
      ${lines.join("")}
      ${cards.join("")}
      ${bracketSvgMatch(finalMatch, finalX, finalY, finalW, { rowH, compact: false })}
      <g class="bracket-svg-champion">
        <rect x="735" y="605" width="130" height="54" rx="14" />
        <text x="800" y="627" text-anchor="middle">🏆</text>
        <text x="800" y="648" text-anchor="middle">${champion ? esc(champion) : "Pick winner"}</text>
      </g>
    </svg>
  `;
}

function bracketMobileSvgHtml(rounds, champion) {
  const stageX = [12, 194, 274, 336, 382];
  const widths = [166, 64, 46, 34, 36];
  const rowH = 38;
  const cardH = rowH * 2;
  const gap = 6;
  const y0 = 40;
  const lookup = bracketSvgRoundMap(rounds);
  const mobileRoundIds = [
    ["m74", "m77", "m73", "m75", "m81", "m82", "m83", "m84", "m76", "m78", "m79", "m80", "m86", "m88", "m85", "m87"],
    ["m89", "m90", "m93", "m94", "m91", "m92", "m95", "m96"],
    ["m97", "m98", "m99", "m100"],
    ["m101", "m102"],
    ["final"],
  ];
  const mobileRounds = mobileRoundIds.map((ids, index) => ({
    ...rounds[index],
    matchups: ids.map(id => lookup.get(id)).filter(Boolean),
  }));
  const centers = [];
  const cards = [];
  const lines = [];
  const mobileConnector = (fromY, toY, fromX, toX) => {
    if (!Number.isFinite(fromY) || !Number.isFinite(toY)) return "";
    const midX = fromX + (toX - fromX) * 0.58;
    return `
      <g class="bracket-svg-lines bracket-mobile-row-lines">
        <path d="M ${fromX} ${fromY} H ${midX} V ${toY} H ${toX}" />
      </g>
    `;
  };
  const mobileAdvanceCenter = (matchup, y) => {
    const winner = bracketWinner(matchup.id);
    const teams = [...(matchup.teams || []), "", ""].slice(0, 2);
    const winnerIndex = teams.findIndex(team => team && team === winner);
    return winnerIndex >= 0 ? y + winnerIndex * rowH + rowH / 2 : y + cardH / 2;
  };
  const flagOnlyRow = (matchup, team, x, y, width, height, active) => {
    if (!team) {
      return `
        <g class="bracket-svg-team empty bracket-mobile-flag-row">
          <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" />
          <text x="${x + width / 2}" y="${y + height / 2 + 4}" text-anchor="middle">·</text>
        </g>
      `;
    }
    const flagCode = teamFlagCode(team);
    const flag = flagCode
      ? `<image href="https://flagcdn.com/${esc(flagCode)}.svg" x="${x + Math.max(4, (width - 24) / 2)}" y="${y + 8}" width="24" height="18" preserveAspectRatio="xMidYMid slice" />`
      : `<text class="bracket-svg-flag-text" x="${x + width / 2}" y="${y + height / 2 + 4}" text-anchor="middle">${esc(teamFlag(team))}</text>`;
    const locked = Boolean(BRACKET_LOCKED_WINNERS[matchup.id]);
    const data = locked ? "" : `data-bracket-pick="${esc(matchup.id)}" data-team="${esc(team)}"`;
    return `
      <g class="bracket-svg-team bracket-mobile-flag-row ${active ? "active" : ""} ${bracketTeamStatusClass(matchup, team)} ${locked && !bracketUserPick(matchup.id) && active ? "preset" : ""} ${locked && !active ? "locked-loser" : ""}" ${data} role="button" tabindex="0" aria-label="Pick ${esc(team)}">
        <title>${esc(team)}</title>
        <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" />
        ${flag}
      </g>
    `;
  };
  const mobileMatch = (matchup, stage, x, y, width) => {
    if (stage === 0) {
      return bracketSvgMatch(matchup, x, y, width, { rowH, compact: false });
    }
    const winner = bracketWinner(matchup.id);
    const teams = [...(matchup.teams || []), "", ""].slice(0, 2);
    if (teams.every(team => !team)) {
      return `
        <g class="bracket-svg-match waiting bracket-mobile-flag-match" data-matchup-id="${esc(matchup.id)}">
          <rect x="${x}" y="${y}" width="${width}" height="${cardH}" rx="10" />
          <text x="${x + width / 2}" y="${y + cardH / 2 + 4}" text-anchor="middle">·</text>
        </g>
      `;
    }
    return `
      <g class="bracket-svg-match ${winner ? "picked" : ""} bracket-mobile-flag-match" data-matchup-id="${esc(matchup.id)}">
        <rect class="bracket-svg-shell-rect" x="${x}" y="${y}" width="${width}" height="${cardH}" rx="10" />
        ${teams.map((team, index) => flagOnlyRow(matchup, team, x, y + index * rowH, width, rowH, winner === team)).join("")}
      </g>
    `;
  };

  mobileRounds.forEach((round, stage) => {
    centers[stage] = [];
    round.matchups.forEach((matchup, index) => {
      let y;
      if (stage === 0) {
        y = y0 + index * (cardH + gap);
      } else {
        const parentA = centers[stage - 1]?.[index * 2];
        const parentB = centers[stage - 1]?.[index * 2 + 1];
        if (Number.isFinite(parentA) && Number.isFinite(parentB)) {
          y = ((parentA + parentB) / 2) - cardH / 2;
          lines.push(mobileConnector(parentA, y + rowH / 2, stageX[stage - 1] + widths[stage - 1], stageX[stage]));
          lines.push(mobileConnector(parentB, y + rowH * 1.5, stageX[stage - 1] + widths[stage - 1], stageX[stage]));
        } else {
          y = y0 + index * (cardH + gap);
        }
      }
      centers[stage][index] = mobileAdvanceCenter(matchup, y);
      cards.push(mobileMatch(matchup, stage, stageX[stage], y, widths[stage]));
    });
  });

  return `
    <div class="bracket-mobile-svg-shell">
      <svg class="bracket-svg bracket-mobile-svg" viewBox="0 0 430 1375" role="img" aria-label="One-sided World Cup bracket path">
        <text class="bracket-svg-title" x="95" y="24" text-anchor="middle">ROUND OF 32</text>
        <text class="bracket-svg-title" x="226" y="24" text-anchor="middle">R16</text>
        <text class="bracket-svg-title" x="297" y="24" text-anchor="middle">QF</text>
        <text class="bracket-svg-title" x="353" y="24" text-anchor="middle">SF</text>
        <text class="bracket-svg-title" x="400" y="24" text-anchor="middle">FINAL</text>
        ${lines.join("")}
        ${cards.join("")}
      </svg>
    </div>
  `;
}

function bracketWideStageHtml(stage, side) {
  const readyMatchups = bracketStageReadyMatchups(stage);
  const picked = stage.matchups.filter(matchup => Boolean(bracketWinner(matchup.id))).length;
  const ready = readyMatchups.length;
  const empty = ready === 0;
  return `
    <section class="bracket-wide-round bracket-wide-${side} bracket-depth-${stage.depth} ${empty ? "stage-empty" : "stage-ready"}" style="--match-count:${stage.matchups.length}; --stage-depth:${stage.depth}" data-match-count="${stage.matchups.length}" data-ready-count="${ready}">
      <header>
        <span>${esc(bracketGridRoundLabel(stage.round.name))}</span>
        <em>${picked}/${stage.matchups.length}</em>
      </header>
      <div class="bracket-wide-list">
        ${stage.matchups.map((_, index) => bracketIncomingConnectorHtml(stage, index)).join("")}
        ${stage.matchups.map((matchup, index) => bracketMiniCellHtml(matchup, {
          row: bracketGridRowForMatch(stage.matchups.length, index),
          depth: stage.depth,
        })).join("")}
      </div>
    </section>
  `;
}

function bracketMobileStageHtml(stage) {
  const visibleMatchups = stage.depth === 0
    ? stage.matchups
    : stage.matchups.filter(matchup => matchup.teams.length > 0 || bracketWinner(matchup.id));
  const picked = stage.matchups.filter(matchup => Boolean(bracketWinner(matchup.id))).length;
  const locked = stage.depth > 0 && visibleMatchups.length === 0;
  return `
    <section class="bracket-mobile-stage ${locked ? "locked" : "active"}" data-depth="${stage.depth}">
      <header>
        <span>${esc(bracketGridRoundLabel(stage.round.name))}</span>
        <em>${picked}/${stage.matchups.length}</em>
      </header>
      ${locked ? `
        <div class="bracket-mobile-locked">
          <span></span>
          <strong>Unlocks after previous picks</strong>
        </div>
      ` : `
        <div class="bracket-mobile-list">
          ${visibleMatchups.map(matchup => bracketMiniCellHtml(matchup, {
            depth: stage.depth,
            mobile: true,
          })).join("")}
        </div>
      `}
    </section>
  `;
}

function bracketMobilePathHtml(rounds, champion) {
  return `
    <div class="bracket-mobile-path" aria-label="Mobile one-sided bracket path">
      <div class="bracket-mobile-path-head">
        <p class="eyebrow">Bracket path</p>
        <span>${champion ? `${teamFlag(champion)} ${esc(champion)} selected` : "Round of 32 to final"}</span>
      </div>
      ${bracketMobileSvgHtml(rounds, champion)}
    </div>
  `;
}

function bracketViewToggleHtml(bracketView) {
  return `
    <div class="bracket-view-toggle compact-icons motion-item" aria-label="Bracket view">
      <button type="button" data-bracket-view="grid" class="${bracketView === "grid" ? "active" : ""}" aria-pressed="${bracketView === "grid"}" aria-label="Grid bracket view">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />
        </svg>
      </button>
      <button type="button" data-bracket-view="table" class="${bracketView === "table" ? "active" : ""}" aria-pressed="${bracketView === "table"}" aria-label="Round-by-round table view">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6h14v2H5zM5 11h14v2H5zM5 16h14v2H5z" />
        </svg>
      </button>
    </div>
  `;
}

function bracketActionControlsHtml(champion) {
  const locked = state.bracketSubmitted;
  return `
    <div class="bracket-graph-actions">
      <div class="bracket-current-pick">
        <span>Champion</span>
        <strong>${champion ? `${teamFlag(champion)} ${esc(champion)}` : "TBD"}</strong>
      </div>
      <button class="btn btn-ghost btn-sm bracket-share-btn" type="button" data-share-bracket>${shareArrowIconSvg()}<span>Share</span></button>
      <button class="btn btn-ghost btn-sm" type="button" data-reset-bracket ${locked ? "disabled" : ""}>Reset</button>
      <button class="btn btn-primary btn-sm" type="button" data-submit-bracket ${locked ? "disabled" : ""}>${locked ? "Submitted" : "Submit bracket"}</button>
    </div>
  `;
}

function bracketWideGridHtml(rounds, champion, bracketView = "grid") {
  const progress = bracketProgress(rounds);
  return `
    <section class="bracket-wide-preview motion-item" aria-label="Full bracket preview">
      <div class="bracket-wide-head compact">
        <div>
          <p class="eyebrow">Progressive bracket</p>
          <h2>See the whole path</h2>
        </div>
        <div class="bracket-graph-controls">
          ${bracketViewToggleHtml(bracketView)}
          ${bracketActionControlsHtml(champion)}
        </div>
      </div>
      <div class="bracket-progress-bar bracket-progress-wide" aria-hidden="true">
        <span style="width:${progress.pct}%"></span>
      </div>
      <div class="bracket-svg-shell">
        ${bracketSvgHtml(rounds, champion)}
      </div>
      ${bracketMobilePathHtml(rounds, champion)}
    </section>
  `;
}

function renderBracketChallenge() {
  const rounds = bracketRounds();
  const champion = bracketWinner("final");
  const complete = bracketComplete();
  const bracketView = state.bracketView === "table" ? "table" : "grid";
  const entry = loadBracketEntry();
  const entryStatus = state.bracketSubmitted ? "Entry locked" : complete ? "Ready to submit" : "Build your bracket";
  const entryHint = entry?.submittedAt
    ? `Submitted ${new Date(entry.submittedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : complete
      ? "Review the champion, then submit your entry."
      : "Pick winners left to right. Later rounds unlock as you choose.";
  dom.mainContent.innerHTML = `
    <section class="bracket-page">
      <div class="bracket-toolbar motion-item">
      <div>
          <p class="eyebrow">World Cup bracket challenge · ${BRACKET_CHALLENGE.prize} prize for perfect knockouts</p>
          <h2>${entryStatus}</h2>
          <p>${entryHint}</p>
        </div>
      </div>

      ${bracketView === "grid" ? bracketWideGridHtml(rounds, champion, bracketView) : `
        <section class="bracket-wide-preview table-mode motion-item" aria-label="Round table bracket">
          <div class="bracket-wide-head compact">
            <div>
              <p class="eyebrow">Round view</p>
              <h2>Pick one round at a time</h2>
            </div>
            <div class="bracket-graph-controls">
              ${bracketViewToggleHtml(bracketView)}
              ${bracketActionControlsHtml(champion)}
            </div>
          </div>
          ${bracketRoundShellHtml(rounds, champion)}
        </section>
      `}
    </section>`;
}

function renderAdminVerification() {
  const queue = adminVerificationQueue();
  const total = queue.reduce((sum, item) => sum + item.events.length, 0);
  const resolved = adminResolvedQueue();
  dom.mainContent.innerHTML = `
    <section class="admin-page">
      <div class="admin-head motion-item">
        <div>
          <p class="eyebrow">Manual verification</p>
          <h1>Resolve markets</h1>
          <p>Settle a market as soon as the outcome is known. Live overrides close trading immediately, lock the winner, and pay out in one step.</p>
        </div>
        <div class="admin-actions">
          <span class="admin-count">${total} pending</span>
          <button class="btn btn-ghost btn-sm" type="button" data-go-dashboard>Back</button>
        </div>
      </div>
      ${queue.length ? `
        <div class="admin-groups">
          ${queue.map(adminGroupHtml).join("")}
        </div>
      ` : adminEmptyHtml()}
      ${resolved.length ? `
        <section class="admin-recent motion-item">
          <div class="admin-group-head">
            <div>
              <p class="eyebrow">Recently settled</p>
              <h2>Resolution log</h2>
            </div>
          </div>
          <div class="admin-recent-list">
            ${resolved.map(adminResolvedRow).join("")}
          </div>
        </section>
      ` : ""}
    </section>`;
}

function adminVerificationQueue() {
  return state.groups
    .map(group => {
      const events = marketEvents(group.markets ?? [])
        .filter(event => eventStatus(event) !== "resolved")
        .sort((a, b) => {
          const aStatus = eventStatus(a);
          const bStatus = eventStatus(b);
          if (aStatus !== bStatus) return aStatus === "closed" ? -1 : 1;
          return eventTime(a.closesAt) - eventTime(b.closesAt);
        });
      return { group, events };
    })
    .filter(item => item.events.length);
}

function adminResolvedQueue() {
  return state.groups.flatMap(group => {
    return marketEvents(group.markets ?? [])
      .filter(event => eventStatus(event) === "resolved")
      .map(event => ({ group, event }));
  }).sort((a, b) => eventTime(b.event.resolvedAt) - eventTime(a.event.resolvedAt)).slice(0, 8);
}

function adminGroupHtml({ group, events }) {
  return `
    <section class="admin-group motion-item">
      <div class="admin-group-head">
        <div>
          <p class="eyebrow">${esc(group.emoji)} ${esc(group.name)}</p>
          <h2>${events.length} decision${events.length === 1 ? "" : "s"}</h2>
        </div>
      </div>
      <div class="admin-card-list">
        ${events.map(event => adminEventCard(group, event)).join("")}
      </div>
    </section>`;
}

function adminEventCard(group, event) {
  const market = event.markets[0];
  const outcomes = resolutionOutcomes(market);
  const activeOutcomes = activeResolutionOutcomes(market);
  const multiOutcome = outcomes.length > 2;
  const showAllCorrect = activeOutcomes.length > 2;
  const source = market.resolutionSource || event.resolutionSource || "";
  const edgeCases = market.edgeCases || event.edgeCases || "";
  const rules = market.description || event.description || "No resolution rules saved.";
  const pending = state.pendingUi.resolveMarketId === market.id;
  const status = eventStatus(event);
  const isLive = status === "open";
  const approvalNotice = adminApprovalNoticeHtml(market);
  const closeLabel = isLive ? `Live override · closes ${fmtDate(event.closesAt)}` : fmtClose({ closesAt: event.closesAt, status: "closed" });
  return `
    <article class="admin-resolve-card" data-market-id="${esc(market.id)}">
      <div class="admin-card-main">
        <div class="admin-card-title-row">
          <div class="event-thumb ${eventThumbClass(event.title, event.imageUrl)} admin-card-thumb" aria-hidden="true">${eventThumb(event.title, event.imageUrl)}</div>
          <div>
            <p class="admin-card-kicker ${isLive ? "is-live" : ""}">${esc(group.name)} · ${esc(closeLabel)}</p>
            <h3>${esc(event.title)}</h3>
          </div>
        </div>
        ${isLive ? `<div class="admin-live-note">Resolve now only if the result is already knowable. This closes trading immediately.</div>` : ""}
        ${approvalNotice}
        <div class="admin-rules">
          ${richRulesHtml({ rules, source, edgeCases, compact: true })}
        </div>
      </div>
      <div class="admin-decision-panel">
        <label>
          <span>Reasoning / source note</span>
          <textarea data-resolution-reasoning maxlength="1200" placeholder="Optional: FotMob shows Wirtz finished with 2 G/A, so No resolves."></textarea>
        </label>
        <div class="admin-outcome-grid">
          ${activeOutcomes.map((outcome, index) => {
            const cls = resolutionOutcomeClass(market, outcome.id, index);
            return `<button class="admin-outcome-btn ${cls}" type="button" data-resolve="${esc(outcome.id)}" ${pending ? "disabled" : ""}>${esc(outcome.title)}</button>`;
          }).join("")}
          ${showAllCorrect ? `<button class="admin-outcome-btn draw" type="button" data-resolve="${ALL_OUTCOMES_RESOLUTION}" ${pending ? "disabled" : ""}>Draw · all correct</button>` : ""}
        </div>
        ${multiOutcome ? `
          <div class="admin-eliminate-block">
            <div>
              <span>Remove impossible outcome</span>
              <em>Keeps the market open and reprices the remaining active outcomes.</em>
            </div>
            <div class="admin-eliminate-grid">
              ${outcomes.map(outcome => {
                const eliminated = outcomeEliminated(outcome);
                return `
                  <button class="admin-eliminate-btn ${eliminated ? "is-eliminated" : ""}" type="button" data-eliminate-outcome="${esc(outcome.id)}" ${pending || eliminated ? "disabled" : ""}>
                    ${esc(outcome.title)}${eliminated ? " · eliminated" : ""}
                  </button>`;
              }).join("")}
            </div>
          </div>` : ""}
      </div>
    </article>`;
}

function adminApprovalNoticeHtml(market) {
  const attempts = Array.isArray(market.verificationAttempts) ? market.verificationAttempts : [];
  const latest = [...attempts].reverse().find(item => item?.type === "manual_approval" && item.status && item.status !== "ready_to_resolve");
  if (!latest) return "";
  const cls = latest.status === "needs_review" ? "error" : "pending";
  const missing = latest.missingResolvers?.length ? `Waiting on ${latest.missingResolvers.join(" + ")}.` : "Needs review before payout.";
  return `
    <div class="admin-approval-notice ${cls}">
      <strong>${latest.status === "needs_review" ? "Approval conflict" : "Approval pending"}</strong>
      <span>${esc(latest.outcomeTitle || "Outcome")} · ${esc(missing)}</span>
    </div>`;
}

function adminEmptyHtml() {
  return `
    <div class="admin-empty motion-item">
      <p class="eyebrow">All clear</p>
      <h2>No markets need verification.</h2>
      <p>Open and closed markets appear here until you pick the winning outcome.</p>
      <button class="btn btn-primary btn-sm" type="button" data-go-dashboard>Back to markets</button>
    </div>`;
}

function adminResolvedRow({ group, event }) {
  const market = event.markets[0];
  const winner = resolutionOutcomeLabel(market, market.outcome || event.outcome);
  return `
    <div class="admin-resolved-row">
      <div>
        <strong>${esc(event.title)}</strong>
        <span>${esc(group.emoji)} ${esc(group.name)} · Winner: ${esc(winner)}${market.resolvedBy ? ` · ${esc(market.resolvedBy)}` : ""}</span>
        ${market.resolutionNotes ? `<em>${esc(market.resolutionNotes)}</em>` : ""}
      </div>
      <small>${market.resolvedAt ? fmtDate(new Date(market.resolvedAt)) : "resolved"}</small>
    </div>`;
}

function renderPositions() {
  const status = "open";
  state.positionsStatus = "open";
  const snapshot = portfolioSnapshot();
  const visibleGroups = snapshot.groups
    .map(item => ({ ...item, rows: item.open }))
    .filter(item => item.rows.length);
  const deltaClass = snapshot.pnl >= 0 ? "gain" : "loss";
  const deltaLabel = `${snapshot.pnl >= 0 ? "+" : ""}${money(snapshot.pnl)} (${snapshot.pnlPct >= 0 ? "+" : ""}${snapshot.pnlPct.toFixed(1)}%)`;

  dom.mainContent.innerHTML = `
    <section class="positions-page probable-portfolio-page">
      <div class="portfolio-topbar motion-item">
        <div>
          <p class="eyebrow">${snapshot.scopeEmoji ? `${esc(snapshot.scopeEmoji)} ` : ""}${esc(snapshot.scopeName)} Portfolio</p>
          <h1>${money(snapshot.portfolioMark)}</h1>
          <span class="portfolio-delta ${deltaClass}">${deltaLabel} all time</span>
        </div>
        <div class="portfolio-topbar-actions">
          ${portfolioGroupSwitcherHtml(snapshot)}
          <button class="btn btn-ghost btn-sm" type="button" data-go-dashboard>Back</button>
        </div>
      </div>

      <div class="portfolio-overview-shell motion-item">
        <div class="portfolio-chart-shell">
          ${portfolioChartCardHtml(snapshot)}
        </div>
        ${portfolioHistoryHtml(snapshot.activity)}
      </div>

      ${portfolioChallengesHtml()}

      ${visibleGroups.length ? `
        <div class="positions-groups portfolio-groups">
          ${visibleGroups.map(item => positionGroupHtml(item.group, item.rows, status, item)).join("")}
        </div>
      ` : positionsEmptyHtml(status)}
    </section>`;
}

function portfolioChallengesHtml() {
  const bracketComplete = bracketCompletion().complete;
  const bracketStatus = state.bracketSubmitted ? "Submitted" : bracketComplete ? "Ready" : "Draft";
  const bracketChampion = bracketDisplayWinner("final") || "No champion yet";
  return `
    <section class="portfolio-challenges motion-item" aria-label="Season challenges">
      <div class="portfolio-challenges-head">
        <div>
          <p class="eyebrow">Challenges</p>
          <h2>Season picks</h2>
        </div>
        <span>Bracket and table contests live here.</span>
      </div>
      <div class="portfolio-challenge-grid">
        <button class="portfolio-challenge-card" type="button" data-go-bracket>
          <span class="portfolio-challenge-icon">🏆</span>
          <span>
            <strong>${esc(BRACKET_CHALLENGE.title)}</strong>
            <em>${esc(BRACKET_CHALLENGE.prize)} prize · ${esc(bracketStatus)}</em>
          </span>
          <small>${esc(bracketChampion)}</small>
        </button>
        ${LEAGUE_PREDICTOR_LIST.map(predictor => portfolioLeaguePredictorCard(predictor)).join("")}
      </div>
    </section>
  `;
}

function portfolioLeaguePredictorCard(predictor) {
  let ranking = [];
  let submitted = false;
  if (predictor.id === state.activePredictorId) {
    ranking = normalizePremierLeagueRanking(state.plRanking);
    submitted = state.plSubmitted;
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem(leaguePredictorDraftKey(predictor.id)) || "{}");
      const validIds = new Set(predictor.clubs.map(club => club.id));
      ranking = (Array.isArray(saved.ranking) ? saved.ranking : [])
        .filter((id, index, rows) => validIds.has(id) && rows.indexOf(id) === index);
      submitted = Boolean(saved.submitted);
    } catch {
      ranking = [];
    }
  }
  const locked = Date.now() >= Date.parse(predictor.lockAt);
  const status = locked ? "Locked" : submitted ? "Submitted" : ranking.length ? "Draft" : "Open";
  const leader = predictor.clubs.find(club => club.id === ranking[0])?.name || "Start your table";
  return `
    <button class="portfolio-challenge-card" type="button" data-go-league-predictor="${esc(predictor.id)}">
      <span class="portfolio-challenge-icon league-mark">
        ${predictor.logoUrl ? `<img src="${esc(predictor.logoUrl)}" alt="" loading="lazy" />` : esc(predictor.leagueMark)}
      </span>
      <span>
        <strong>${esc(predictor.title)}</strong>
        <em>${esc(predictor.season)} · ${esc(status)}</em>
      </span>
      <small>${esc(leader)}</small>
    </button>`;
}

function portfolioGroupSwitcherHtml(snapshot = portfolioSnapshot()) {
  const groups = visibleNavGroups();
  if (!groups.length) return "";
  if (groups.length === 1) {
    return `<span class="portfolio-group-static">${esc(groups[0].emoji || "")} ${esc(groups[0].name || snapshot.scopeName || "Group")}</span>`;
  }
  const activeId = getCurrentGroup()?.id || groups[0].id;
  return `
    <label class="portfolio-group-switcher">
      <span>Viewing</span>
      <select data-portfolio-group-select aria-label="Portfolio group">
        ${groups.map(group => `<option value="${esc(group.id)}" ${group.id === activeId ? "selected" : ""}>${esc(`${group.emoji ? `${group.emoji} ` : ""}${group.name}`)}</option>`).join("")}
      </select>
    </label>`;
}

function portfolioSnapshot() {
  const currentGroup = getCurrentGroup();
  const sourceGroups = currentGroup ? [currentGroup] : state.groups;
  const groups = sourceGroups
    .map(group => {
      const owner = positionOwnerForGroup(group);
      const open = positionRowsForGroup(group, "open", owner);
      const closed = positionRowsForGroup(group, "closed", owner);
      const markValue = owner ? currentMarkValue(group, owner) : 0;
      const cashOutValue = owner ? currentPositionValue(group, owner) : 0;
      const activity = owner ? portfolioActivityForGroup(group, owner) : [];
      const rawCash = owner ? Number(group.balances?.[owner] ?? DEFAULT_BALANCE) : 0;
      const hasLedgerActivity = activity.some(item => item.action !== "resolved") || markValue > 0.0001 || cashOutValue > 0.0001 || open.length || closed.length;
      const cash = owner ? (hasLedgerActivity ? rawCash : DEFAULT_BALANCE) : 0;
      const cashFlow = owner ? portfolioCashFlowForGroup(group, owner) : { buys: 0, sells: 0, payouts: 0 };
      const startingValue = owner ? DEFAULT_BALANCE : 0;
      return { group, owner, open, closed, cash, markValue, cashOutValue, activity, cashFlow, startingValue };
    })
    .filter(item => item.owner || item.open.length || item.closed.length || item.activity.length);

  const cash = groups.reduce((sum, item) => sum + item.cash, 0);
  const openCashOutValue = groups.reduce((sum, item) => sum + item.cashOutValue, 0);
  const openMarkValue = groups.reduce((sum, item) => sum + item.markValue, 0);
  const portfolioMark = cash + openMarkValue;
  const cashOutPortfolio = cash + openCashOutValue;
  const openCount = groups.reduce((sum, item) => sum + item.open.length, 0);
  const closedCount = groups.reduce((sum, item) => sum + item.closed.length, 0);
  const activity = groups.flatMap(item => item.activity).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const tradeCount = activity.length;
  const volume = activity.reduce((sum, item) => sum + Math.abs(Number(item.amount || 0)), 0);
  const startingValue = groups.reduce((sum, item) => sum + item.startingValue, 0);
  const pnl = groups.length ? portfolioMark - startingValue : 0;
  const pnlPct = startingValue > 0 ? (pnl / startingValue) * 100 : 0;

  return {
    groups,
    scopeName: currentGroup?.name || "All groups",
    scopeEmoji: currentGroup?.emoji || "",
    cash,
    openCashOutValue,
    openMarkValue,
    portfolioMark,
    cashOutPortfolio,
    openCount,
    closedCount,
    activity,
    tradeCount,
    volume,
    startingValue,
    pnl,
    pnlPct,
  };
}

function portfolioCashFlowForGroup(group, participant) {
  const flow = { buys: 0, sells: 0, payouts: 0 };
  const seenEvents = new Set();
  for (const market of group.markets ?? []) {
    if (market.eventId && Array.isArray(market.outcomes)) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      for (const trade of market.eventTrades ?? []) {
        if (trade.participant !== participant) continue;
        const amount = tradeCashAmount(trade);
        if ((trade.action || "buy") === "sell") flow.sells += amount;
        else flow.buys += amount;
      }
      if (market.status === "resolved" && market.outcome) {
        const positions = market.positions?.[participant] ?? {};
        if (market.outcome === ALL_OUTCOMES_RESOLUTION) {
          flow.payouts += Object.values(positions).reduce((sum, shares) => sum + Math.max(0, Number(shares || 0)), 0);
        } else {
          flow.payouts += Number(positions[market.outcome] || 0);
        }
      }
      continue;
    }

    const sharesBySide = { yes: 0, no: 0 };
    for (const trade of market.trades ?? []) {
      if (trade.participant !== participant) continue;
      const amount = tradeCashAmount(trade);
      const side = trade.side === "no" ? "no" : "yes";
      const shares = Math.abs(Number(trade.shares || 0));
      if ((trade.action || "buy") === "sell") {
        flow.sells += amount;
        sharesBySide[side] -= shares;
      } else {
        flow.buys += amount;
        sharesBySide[side] += shares;
      }
    }
    if (market.status === "resolved" && (market.outcome === "yes" || market.outcome === "no")) {
      flow.payouts += Math.max(0, sharesBySide[market.outcome] || 0);
    }
  }
  return flow;
}

function inferredGroupStartingValue(cash, flow) {
  const inferred = Number(cash || 0) + Number(flow?.buys || 0) - Number(flow?.sells || 0) - Number(flow?.payouts || 0);
  if (Number.isFinite(inferred) && inferred > 0.0001) return inferred;
  const fallback = Number(cash || 0);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_BALANCE;
}

function tradeCashAmount(trade) {
  return Math.abs(Number(trade?.amount ?? trade?.cashAmount ?? 0));
}

function participantTradeRowsForGroup(group, participant) {
  const rows = [];
  const seenEvents = new Set();
  for (const market of group.markets ?? []) {
    if (market.eventId && Array.isArray(market.outcomes)) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      for (const trade of market.eventTrades ?? []) {
        if (trade.participant !== participant) continue;
        rows.push({
          ...trade,
          amount: tradeCashAmount(trade),
          action: trade.action || "buy",
          market,
        });
      }
      continue;
    }
    for (const trade of market.trades ?? []) {
      if (trade.participant !== participant) continue;
      rows.push({
        ...trade,
        amount: tradeCashAmount(trade),
        action: trade.action || "buy",
        market,
      });
    }
  }
  return rows;
}

function portfolioActivityForGroup(group, participant) {
  const items = [];
  const seenEvents = new Set();
  for (const market of group.markets ?? []) {
    if (market.eventId && Array.isArray(market.outcomes)) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      for (const trade of market.eventTrades ?? []) {
        if (trade.participant !== participant) continue;
        items.push({
          groupName: group.name,
          groupEmoji: group.emoji,
          title: sampleEventTitle(market),
          imageUrl: market.imageUrl || "",
          outcomeTitle: tradeDisplayOutcomeTitle(trade, market),
          action: trade.action || "buy",
          amount: Number(trade.amount || trade.cashAmount || 0),
          createdAt: trade.createdAt || market.createdAt,
          marketId: trade.outcomeId || market.id,
        });
      }
      if (market.status === "resolved" && market.resolvedAt) {
        const winner = resolutionOutcomeLabel(market, market.outcome);
        items.push({
          groupName: group.name,
          groupEmoji: group.emoji,
          title: sampleEventTitle(market),
          imageUrl: market.imageUrl || "",
          outcomeTitle: winner,
          action: "resolved",
          amount: 0,
          createdAt: market.resolvedAt,
          marketId: market.outcome || market.id,
        });
      }
      continue;
    }
    for (const trade of market.trades ?? []) {
      if (trade.participant !== participant) continue;
      items.push({
        groupName: group.name,
        groupEmoji: group.emoji,
        title: sampleEventTitle(market),
        imageUrl: market.imageUrl || "",
        outcomeTitle: String(trade.side || "yes").toUpperCase(),
        action: trade.action || "buy",
        amount: Number(trade.amount || 0),
        createdAt: trade.createdAt || market.createdAt,
        marketId: market.id,
      });
    }
  }
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function portfolioHistoryHtml(activity = []) {
  const visible = activity.slice(0, 8);
  return `
    <aside class="portfolio-history-panel" aria-label="Portfolio history">
      <div class="portfolio-history-head">
        <div>
          <p class="eyebrow">History</p>
          <h2>Recent moves</h2>
        </div>
        <span>${activity.length ? `${activity.length} total` : "No trades"}</span>
      </div>
      ${visible.length ? `
        <div class="portfolio-history-list">
          ${visible.map(item => {
            const action = item.action === "sell" ? "Sold" : item.action === "resolved" ? "Resolved" : "Bought";
            const cls = item.action === "sell" ? "sell" : item.action === "resolved" ? "resolved" : "buy";
            return `
              <button class="portfolio-history-item ${cls}" type="button" data-buy="yes" data-market-id="${esc(item.marketId)}">
                <span class="portfolio-history-thumb ${eventThumbClass(item.title || item.groupName || "Market", item.imageUrl)}" aria-hidden="true">${eventThumb(item.title || item.groupName || "Market", item.imageUrl)}</span>
                <span class="portfolio-history-kicker">
                  <em class="portfolio-history-action">${esc(action)}</em>
                  <time>${esc(fmtShortDate(item.createdAt))}</time>
                </span>
                <span class="portfolio-history-main">${esc(item.title || item.groupName || "Market")}</span>
                <span class="portfolio-history-meta">${esc(item.outcomeTitle || "position")}</span>
                <strong>${item.action === "resolved" ? "settled" : money(item.amount)}</strong>
              </button>`;
          }).join("")}
        </div>
      ` : `
        <div class="portfolio-history-empty">
          <strong>No history yet</strong>
          <span>Your buys, sells, and settlements will show here.</span>
        </div>
      `}
    </aside>`;
}

function portfolioChartCardHtml(snapshot = portfolioSnapshot()) {
  const config = portfolioChartConfig(snapshot);
  return `
    <div class="portfolio-chart-card">
      <div class="portfolio-chart-head">
        <div>
          <span>${esc(config.metricLabel)}</span>
          <strong>${config.delta >= 0 ? "+" : ""}${money(config.delta)}</strong>
        </div>
        <div class="portfolio-chart-controls" aria-label="Portfolio chart controls">
          <div class="portfolio-chart-toggle" aria-label="Portfolio value metric">
            <button class="${config.metric === "mark" ? "active" : ""}" type="button" data-portfolio-chart-metric="mark">Mark</button>
            <button class="${config.metric === "cashout" ? "active" : ""}" type="button" data-portfolio-chart-metric="cashout">Cash-out</button>
          </div>
          <div class="portfolio-chart-toggle" aria-label="Portfolio time range">
            <button class="${config.range === "7d" ? "active" : ""}" type="button" data-portfolio-chart-range="7d">1W</button>
            <button class="${config.range === "30d" ? "active" : ""}" type="button" data-portfolio-chart-range="30d">1M</button>
            <button class="${config.range === "all" ? "active" : ""}" type="button" data-portfolio-chart-range="all">ALL</button>
          </div>
        </div>
      </div>
      <div class="portfolio-chart-subhead">
        <span>${money(config.currentValue)} current</span>
        <span>${esc(config.rangeLabel)}</span>
      </div>
      <div class="portfolio-chart-wrap">
        <canvas data-portfolio-chart aria-label="Portfolio value history"></canvas>
      </div>
    </div>`;
}

function portfolioChartConfig(snapshot = portfolioSnapshot()) {
  const metric = state.portfolioChartMetric === "cashout" ? "cashout" : "mark";
  const range = ["7d", "30d", "all"].includes(state.portfolioChartRange) ? state.portfolioChartRange : "all";
  const now = Date.now();
  const baseline = snapshot.startingValue || snapshot.portfolioMark || DEFAULT_BALANCE;
  const finalValue = Math.round((metric === "cashout" ? snapshot.cashOutPortfolio : snapshot.portfolioMark) || baseline);
  const points = portfolioValueTimeline(snapshot, metric, now, finalValue);

  const cutoff = range === "7d" ? now - 7 * 24 * 60 * 60 * 1000 : range === "30d" ? now - 30 * 24 * 60 * 60 * 1000 : -Infinity;
  let visible = points.filter(point => point.time >= cutoff);
  if (range !== "all" && points[0] && (!visible.length || visible[0].time > cutoff)) {
    const anchor = [...points].reverse().find(point => point.time < cutoff) || points[0];
    visible.unshift({ time: cutoff, value: anchor.value });
  }
  if (visible.length < 2) visible = [{ time: now - 24 * 60 * 60 * 1000, value: finalValue }, { time: now, value: finalValue }];
  if (visible.length === 2 && visible[0].value === visible[1].value) {
    visible.splice(1, 0, { time: Math.round((visible[0].time + visible[1].time) / 2), value: visible[0].value });
  }

  const labels = chartTimeLabels(visible.map(point => point.time));
  const data = visible.map(point => point.value);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const spread = Math.max(1, max - min);
  const pad = Math.max(baseline * 0.01, spread * 0.24);
  const delta = data.at(-1) - data[0];
  return {
    labels,
    data,
    minY: Math.max(0, min - pad),
    maxY: max + pad,
    metric,
    range,
    metricLabel: metric === "cashout" ? "Cash-out value" : "Portfolio mark",
    rangeLabel: range === "7d" ? "Last 7 days" : range === "30d" ? "Last 30 days" : "All time",
    currentValue: data.at(-1),
    delta,
  };
}

function portfolioValueTimeline(snapshot, metric, now = Date.now(), finalValue = null) {
  const states = [];
  const events = [];

  for (const item of snapshot.groups) {
    const owner = item.owner;
    if (!owner) continue;
    const state = {
      groupId: item.group.id,
      owner,
      cash: Number(item.startingValue || 0),
      positions: new Map(),
      prices: new Map(),
      quantities: new Map(),
      liquidity: new Map(),
    };
    states.push(state);

    const seenEvents = new Set();
    for (const market of item.group.markets ?? []) {
      if (market.eventId && Array.isArray(market.outcomes)) {
        if (seenEvents.has(market.eventId)) continue;
        seenEvents.add(market.eventId);
        seedEventPrices(state, market);
        for (const trade of sortedTrades(market.eventTrades)) {
          events.push({ type: "trade", time: timeValue(trade.createdAt), state, market, trade });
        }
        if (market.status === "resolved" && market.resolvedAt) {
          events.push({ type: "resolve", time: timeValue(market.resolvedAt), state, market });
        }
        continue;
      }
      seedLegacyMarketPrices(state, market);
      for (const trade of sortedTrades(market.trades)) {
        events.push({ type: "legacy-trade", time: timeValue(trade.createdAt), state, market, trade });
      }
      if (market.status === "resolved" && market.resolvedAt) {
        events.push({ type: "legacy-resolve", time: timeValue(market.resolvedAt), state, market });
      }
    }
  }

  events.sort((a, b) => a.time - b.time);
  const startTime = events[0]?.time || now - 7 * 24 * 60 * 60 * 1000;
  const points = [{ time: startTime, value: Math.round(portfolioTimelineValue(states, metric)) }];

  for (const event of events) {
    if (!Number.isFinite(event.time)) continue;
    applyPortfolioTimelineEvent(event);
    const value = Math.round(portfolioTimelineValue(states, metric));
    if (Number.isFinite(value)) points.push({ time: event.time, value });
  }

  const exactFinal = Number.isFinite(finalValue) ? finalValue : Math.round(portfolioTimelineValue(states, metric));
  if (!points.length) return [{ time: now - 24 * 60 * 60 * 1000, value: exactFinal }, { time: now, value: exactFinal }];
  if (points.at(-1).time !== now || points.at(-1).value !== exactFinal) points.push({ time: now, value: exactFinal });
  return points;
}

function sortedTrades(trades = []) {
  return [...(trades || [])].sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt));
}

function timeValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : Date.now();
}

function seedEventPrices(state, market) {
  const trades = sortedTrades(market.eventTrades);
  const firstTrade = trades[0];
  const before = firstTrade?.pricesBefore || {};
  const prices = new Map();
  const quantities = new Map();
  for (const outcome of market.outcomes ?? []) {
    prices.set(outcome.id, Number(before[outcome.id] ?? outcome.price ?? 0));
    quantities.set(outcome.id, Number(outcome.quantity || 0));
  }
  for (const trade of trades) {
    for (const component of tradeComponents(trade)) {
      const outcomeId = component.outcomeId;
      if (!outcomeId) continue;
      quantities.set(outcomeId, Number(quantities.get(outcomeId) || 0) - Number(component.shares || component.sharesDelta || 0));
    }
  }
  state.prices.set(market.eventId, prices);
  state.quantities.set(market.eventId, quantities);
  state.liquidity.set(market.eventId, Number(market.initialLiquidity || market.liquidity || DEFAULT_MARKET_LIQUIDITY));
}

function seedLegacyMarketPrices(state, market) {
  const firstTrade = sortedTrades(market.trades)[0];
  const probability = Number(firstTrade?.probBefore ?? market.probability ?? 0.5);
  state.prices.set(market.id, new Map([
    ["yes", probability],
    ["no", 1 - probability],
  ]));
}

function applyPortfolioTimelineEvent(event) {
  if (event.type === "trade") {
    const prices = event.state.prices.get(event.market.eventId) || new Map();
    Object.entries(event.trade.pricesAfter || {}).forEach(([id, price]) => prices.set(id, Number(price || 0)));
    event.state.prices.set(event.market.eventId, prices);
    const quantities = event.state.quantities.get(event.market.eventId) || new Map();
    for (const component of tradeComponents(event.trade)) {
      const outcomeId = component.outcomeId;
      if (!outcomeId) continue;
      quantities.set(outcomeId, Number(quantities.get(outcomeId) || 0) + Number(component.shares || component.sharesDelta || 0));
    }
    event.state.quantities.set(event.market.eventId, quantities);
    if (event.trade.participant !== event.state.owner) return;
    event.state.cash += (event.trade.action || "buy") === "sell" ? tradeCashAmount(event.trade) : -tradeCashAmount(event.trade);
    for (const component of tradeComponents(event.trade)) {
      addTimelineShares(event.state, event.market.eventId, component.outcomeId, Number(component.shares || component.sharesDelta || 0));
    }
    return;
  }
  if (event.type === "resolve") {
    const positions = event.state.positions.get(event.market.eventId) || new Map();
    if (event.market.outcome === ALL_OUTCOMES_RESOLUTION) {
      positions.forEach(shares => {
        event.state.cash += Math.max(0, Number(shares || 0));
      });
    } else {
      event.state.cash += Math.max(0, Number(positions.get(event.market.outcome) || 0));
    }
    event.state.positions.delete(event.market.eventId);
    const prices = event.state.prices.get(event.market.eventId) || new Map();
    for (const outcome of event.market.outcomes ?? []) prices.set(outcome.id, event.market.outcome === ALL_OUTCOMES_RESOLUTION || outcome.id === event.market.outcome ? 1 : 0);
    event.state.prices.set(event.market.eventId, prices);
    event.state.quantities.delete(event.market.eventId);
    return;
  }
  if (event.type === "legacy-trade") {
    const side = event.trade.side === "no" ? "no" : "yes";
    const prices = event.state.prices.get(event.market.id) || new Map();
    const probability = Number(event.trade.probAfter ?? event.market.probability ?? 0.5);
    prices.set("yes", probability);
    prices.set("no", 1 - probability);
    event.state.prices.set(event.market.id, prices);
    if (event.trade.participant !== event.state.owner) return;
    event.state.cash += (event.trade.action || "buy") === "sell" ? tradeCashAmount(event.trade) : -tradeCashAmount(event.trade);
    const shares = Math.abs(Number(event.trade.shares || 0)) * ((event.trade.action || "buy") === "sell" ? -1 : 1);
    addTimelineShares(event.state, event.market.id, side, shares);
    return;
  }
  if (event.type === "legacy-resolve") {
    const positions = event.state.positions.get(event.market.id) || new Map();
    event.state.cash += Math.max(0, Number(positions.get(event.market.outcome) || 0));
    event.state.positions.delete(event.market.id);
    event.state.prices.set(event.market.id, new Map([
      ["yes", event.market.outcome === "yes" ? 1 : 0],
      ["no", event.market.outcome === "no" ? 1 : 0],
    ]));
  }
}

function addTimelineShares(state, eventId, outcomeId, shares) {
  if (!eventId || !outcomeId || !Number.isFinite(shares) || Math.abs(shares) < 0.000001) return;
  const positions = state.positions.get(eventId) || new Map();
  positions.set(outcomeId, Math.max(0, Number(positions.get(outcomeId) || 0) + shares));
  state.positions.set(eventId, positions);
}

function portfolioTimelineValue(states, metric) {
  return states.reduce((total, state) => {
    let value = Number(state.cash || 0);
    for (const [eventId, positions] of state.positions.entries()) {
      const prices = state.prices.get(eventId) || new Map();
      const quantities = state.quantities.get(eventId);
      const b = Number(state.liquidity.get(eventId) || DEFAULT_MARKET_LIQUIDITY);
      for (const [outcomeId, shares] of positions.entries()) {
        const ownedShares = Math.max(0, Number(shares || 0));
        value += metric === "cashout" && quantities
          ? lmsrSellValueForQuantityMap(quantities, outcomeId, ownedShares, b)
          : ownedShares * Number(prices.get(outcomeId) || 0);
      }
    }
    return total + value;
  }, 0);
}

function lmsrSellValueForQuantityMap(quantities, outcomeId, shares, b) {
  const amount = Math.max(0, Number(shares || 0));
  if (!amount || !Number.isFinite(b) || b <= 0 || !quantities?.has(outcomeId)) return 0;
  const values = [...quantities.entries()].map(([id, quantity]) => ({ id, quantity: Number(quantity || 0) }));
  const sumExp = values.reduce((sum, item) => sum + Math.exp(item.quantity / b), 0);
  const target = values.find(item => item.id === outcomeId);
  if (!target || sumExp <= 0) return 0;
  const targetExp = Math.exp(target.quantity / b);
  const denominator = sumExp - targetExp + targetExp * Math.exp(-amount / b);
  if (denominator <= 0) return 0;
  return tradeNetCash(b * Math.log(sumExp / denominator));
}

function refreshPortfolioChartComponent() {
  const card = document.querySelector(".portfolio-chart-card");
  if (!card) return;
  const existing = charts.get("portfolio");
  if (existing) {
    existing.destroy();
    charts.delete("portfolio");
  }
  card.outerHTML = portfolioChartCardHtml();
  requestAnimationFrame(renderPortfolioCharts);
}

function positionGroupHtml(group, rows, status, groupData = {}) {
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const markValue = groupData.markValue ?? rows.reduce((sum, row) => sum + row.shares * row.price, 0);
  return `
    <section class="position-group-card portfolio-position-card motion-item">
      <div class="position-group-head portfolio-group-head">
        <div>
          <p class="eyebrow">${esc(group.emoji)} Positions</p>
          <h2>${esc(group.name)}</h2>
        </div>
        <div class="portfolio-group-values">
          <span>Cash-out</span>
          <strong>${money(totalValue)}</strong>
          <em>${money(markValue)} mark</em>
        </div>
      </div>
      <div class="position-list portfolio-position-list">
        ${rows.map(positionRowHtml).join("")}
      </div>
    </section>`;
}

function positionRowHtml(row) {
  const valueLabel = row.status === "open" ? "cash out" : row.statusLabel === "Resolved" ? (row.isWinner ? "paid out" : "lost") : "marked";
  return `
    <button class="position-row portfolio-position-row" type="button" data-buy="yes" data-market-id="${esc(row.marketId)}">
      <div class="position-market portfolio-position-market">
        <strong>${esc(row.title)}</strong>
        <em>${esc(row.closeLabel)}</em>
        ${row.statusLabel === "Resolved" ? `<small class="position-settlement-note">Winner: ${esc(row.winnerTitle || "Unknown")}${row.resolvedBy ? ` · ${esc(row.resolvedBy)}` : ""}${row.resolutionNotes ? ` · ${esc(row.resolutionNotes)}` : ""}</small>` : ""}
      </div>
      <div class="position-outcome portfolio-position-outcome">
        <span>${esc(row.outcomeTitle)}</span>
        <em>${formatShares(row.shares)} shares</em>
      </div>
      <div class="position-price portfolio-position-price">
        <span>${Math.round(row.price * 100)}¢</span>
        <em>${row.status === "open" ? "price" : "final"}</em>
      </div>
      <div class="position-value portfolio-position-value">
        <strong>${money(row.value)}</strong>
        <em>${valueLabel}</em>
      </div>
    </button>`;
}

function positionsEmptyHtml(status) {
  return `
    <div class="positions-empty portfolio-empty motion-item">
      <p class="eyebrow">Portfolio</p>
      <h2>No positions yet.</h2>
      <p>Buy a contract in any group and it will show up here.</p>
      <button class="btn btn-primary btn-sm" type="button" data-go-dashboard>Back to markets</button>
    </div>`;
}

function positionRowsForGroup(group, status, participantOverride = "") {
  const participant = participantOverride || positionOwnerForGroup(group);
  if (!participant) return [];
  const rows = [];
  const seenEvents = new Set();
  for (const market of group.markets ?? []) {
    if (market.eventId && Array.isArray(market.outcomes) && market.positions) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      const marketStatus = market.status === "open" ? "open" : "closed";
      if (marketStatus !== status) continue;
      const positions = market.positions?.[participant] ?? {};
      const syntheticRows = syntheticNoPositionRows(market, participant);
      rows.push(...syntheticRows);
      const covered = syntheticNoCoveredShares(market, participant);
      for (const outcome of market.outcomes) {
        const shares = Number(positions[outcome.id] || 0) - Number(covered[outcome.id] || 0);
        if (!Number.isFinite(shares) || shares <= 0.000001) continue;
        rows.push(positionRowFromOutcome(market, outcome, shares));
      }
      continue;
    }
    const legacyRows = legacyPositionRows(group, market, participant, status);
    rows.push(...legacyRows);
  }
  return rows.sort((a, b) => b.value - a.value);
}

function syntheticNoPositionRows(market, participant) {
  const netByOutcome = {};
  for (const trade of market.eventTrades ?? []) {
    if (trade.participant !== participant || trade.side !== "no") continue;
    const outcomeId = trade.outcomeId;
    if (!outcomeId) continue;
    const direction = trade.action === "sell" ? -1 : 1;
    netByOutcome[outcomeId] = Number(netByOutcome[outcomeId] || 0) + direction * Math.abs(Number(trade.shares || 0));
  }
  return Object.entries(netByOutcome)
    .filter(([, shares]) => shares > 0.000001)
    .map(([outcomeId, shares]) => positionRowFromSyntheticNo(market, outcomeId, shares));
}

function syntheticNoCoveredShares(market, participant) {
  const covered = {};
  for (const row of syntheticNoPositionRows(market, participant)) {
    for (const outcome of market.outcomes ?? []) {
      if (outcome.id === row.marketId) continue;
      covered[outcome.id] = Number(covered[outcome.id] || 0) + Number(row.shares || 0);
    }
  }
  return covered;
}

function positionRowFromSyntheticNo(market, outcomeId, shares) {
  const outcome = market.outcomes?.find(item => item.id === outcomeId) || {};
  const status = market.status === "open" ? "open" : "closed";
  const price = Math.max(0, 1 - Number(outcome.price || 0));
  const resolvedOutcome = market.outcome;
  const value = market.status === "resolved"
    ? (resolvedOutcome === ALL_OUTCOMES_RESOLUTION || resolvedOutcome !== outcomeId ? shares : 0)
    : status === "open"
      ? lmsrCashForComplementSellShares(market, outcomeId, shares)
      : shares * price;
  return {
    marketId: outcomeId,
    title: sampleEventTitle(market),
    outcomeTitle: `${outcome.title || marketOptionTitle(market)} · No`,
    shares,
    price,
    value,
    status,
    statusLabel: market.status === "resolved" ? "Resolved" : market.status === "closed" ? "Closed" : "Open",
    closeLabel: fmtClose(market),
    winnerTitle: market.status === "resolved" ? resolutionOutcomeLabel(market, resolvedOutcome) : "",
    isWinner: market.status === "resolved" && (resolvedOutcome === ALL_OUTCOMES_RESOLUTION || resolvedOutcome !== outcomeId),
    resolvedBy: market.resolvedBy || "",
    resolutionNotes: market.resolutionNotes || "",
    resolvedAt: market.resolvedAt || "",
  };
}

function positionRowFromOutcome(market, outcome, shares) {
  const status = market.status === "open" ? "open" : "closed";
  const price = Number(outcome.price || 0);
  const resolvedOutcome = market.outcome;
  const value = market.status === "resolved"
    ? (resolvedOutcome === ALL_OUTCOMES_RESOLUTION || resolvedOutcome === outcome.id ? shares : 0)
    : status === "open"
      ? lmsrSellValueForShares(market, outcome.id, shares)
      : shares * price;
  return {
    marketId: outcome.id,
    title: sampleEventTitle(market),
    outcomeTitle: outcome.title || marketOptionTitle(market),
    shares,
    price,
    value,
    status,
    statusLabel: market.status === "resolved" ? "Resolved" : market.status === "closed" ? "Closed" : "Open",
    closeLabel: fmtClose(market),
    winnerTitle: market.status === "resolved" ? resolutionOutcomeLabel(market, resolvedOutcome) : "",
    isWinner: market.status === "resolved" && (resolvedOutcome === ALL_OUTCOMES_RESOLUTION || resolvedOutcome === outcome.id),
    resolvedBy: market.resolvedBy || "",
    resolutionNotes: market.resolutionNotes || "",
    resolvedAt: market.resolvedAt || "",
  };
}

function legacyPositionRows(group, market, participant, status) {
  const marketStatus = market.status === "open" ? "open" : "closed";
  if (marketStatus !== status) return [];
  const sharesBySide = { yes: 0, no: 0 };
  for (const trade of market.trades ?? []) {
    if (trade.participant !== participant) continue;
    const side = trade.side === "no" ? "no" : "yes";
    const direction = trade.action === "sell" ? -1 : 1;
    sharesBySide[side] += direction * Number(trade.shares || 0);
  }
  return Object.entries(sharesBySide)
    .filter(([, shares]) => shares > 0.000001)
    .map(([side, shares]) => {
      const price = side === "yes" ? Number(market.probability ?? 0.5) : 1 - Number(market.probability ?? 0.5);
      return {
        marketId: market.id,
        title: sampleEventTitle(market),
        outcomeTitle: side.toUpperCase(),
        shares,
        price,
        value: market.status === "resolved" ? (market.outcome === side ? shares : 0) : shares * price,
        status: marketStatus,
        statusLabel: market.status === "resolved" ? "Resolved" : market.status === "closed" ? "Closed" : "Open",
        closeLabel: fmtClose(market),
        winnerTitle: market.status === "resolved" ? resolutionOutcomeLabel(market, market.outcome) : "",
        isWinner: market.status === "resolved" && market.outcome === side,
        resolvedBy: market.resolvedBy || "",
        resolutionNotes: market.resolutionNotes || "",
        resolvedAt: market.resolvedAt || "",
      };
    });
}

function positionOwnerForGroup(group) {
  return memberAliasForGroup(group) || "";
}

function formatShares(value) {
  const n = Number(value || 0);
  if (n >= 1000) return compactMoney(n).replace("$", "");
  return n.toFixed(n >= 10 ? 1 : 2);
}

function formatShareInput(value) {
  const n = Math.max(0, Number(value || 0));
  if (!Number.isFinite(n)) return "0";
  return (Math.floor(n * 10000) / 10000).toString();
}

function formatShareDisplay(value) {
  const n = Math.max(0, Number(value || 0));
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(2);
}

function tradeInputAmount(input) {
  if (!input) return NaN;
  const raw = input.dataset.rawAmount ||
    input.closest(".trade-form-el")?.dataset.rawAmount ||
    input.closest(".trade-panel")?.dataset.rawAmount;
  if (raw) return parseTradeNumber(raw);
  return parseTradeNumber(input.value);
}

function parseTradeNumber(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[$,\s_]/g, "")
    .replace(/[^\d.+-]/g, "");
  if (!normalized || normalized === "." || normalized === "+" || normalized === "-") return NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function setTradeInputAmount(input, amount, { display = null } = {}) {
  if (!input) return;
  const safe = Number(amount);
  if (!Number.isFinite(safe)) return;
  const raw = formatShareInput(safe);
  input.dataset.rawAmount = raw;
  input.value = display ?? raw;
  const form = input.closest(".trade-form-el");
  const panel = input.closest(".trade-panel");
  if (form) form.dataset.rawAmount = raw;
  if (panel) panel.dataset.rawAmount = raw;
}

function clearTradeInputRawAmount(input) {
  if (!input) return;
  delete input.dataset.rawAmount;
  const form = input.closest(".trade-form-el");
  const panel = input.closest(".trade-panel");
  if (form) delete form.dataset.rawAmount;
  if (panel) delete panel.dataset.rawAmount;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function randomSlugSuffix() {
  return Math.random().toString(36).slice(2, 7);
}

function marketSlugFor(question) {
  const base = slugify(question);
  const suffix = state.marketSlugSuffix || randomSlugSuffix();
  return base ? `${base}-${suffix}` : suffix;
}

function openLeaderProfile(memberName) {
  const group = getCurrentGroup();
  if (!group || !memberName) return;
  const entries = leaderboardEntries(group);
  const entry = entries.find(item => item.name === memberName)
    || entries.find(item => item.name.toLowerCase() === memberName.toLowerCase());
  if (!entry) {
    toast("Could not find that trader.");
    return;
  }
  const rank = entries.indexOf(entry) + 1;
  const detailPanel = document.querySelector(".probable-leader-detail");
  if (detailPanel) detailPanel.innerHTML = leaderDetailHtml(entry, rank);
  dom.leaderProfileModalBody.innerHTML = leaderProfileHtml(group, entry, rank);
  openModal("leaderProfile");
}

function leaderProfileHtml(group, entry, rank) {
  const openRows = positionRowsForGroup(group, "open", entry.name);
  const closedRows = positionRowsForGroup(group, "closed", entry.name);
  const recentTrades = recentTradesForMember(group, entry.name).slice(0, 5);
  return `
    <div class="leader-profile-hero">
      <div class="leader-avatar leader-profile-avatar">${avatarText(entry.name)}</div>
      <div>
        <p class="eyebrow">${esc(group.name)} · rank #${rank}</p>
        <h2>${esc(entry.name)}</h2>
        <span class="${entry.pnl >= 0 ? "pos" : "neg"}">${leaderboardGainLabel(entry)}</span>
      </div>
    </div>
    <div class="leader-profile-metrics">
      <span><strong>${money(entry.bal)}</strong><em>portfolio mark</em></span>
      <span><strong>${money(entry.cashOutPortfolio)}</strong><em>cash-out value</em></span>
      <span><strong>${money(entry.cash)}</strong><em>cash</em></span>
      <span><strong>${entry.trades}</strong><em>trades</em></span>
    </div>
    <div class="leader-profile-section">
      <div class="leader-profile-section-head">
        <strong>Open positions</strong>
        <span>${openRows.length}</span>
      </div>
      ${leaderProfilePositionList(openRows)}
    </div>
    <div class="leader-profile-section">
      <div class="leader-profile-section-head">
        <strong>Closed positions</strong>
        <span>${closedRows.length}</span>
      </div>
      ${leaderProfilePositionList(closedRows)}
    </div>
    <div class="leader-profile-section">
      <div class="leader-profile-section-head">
        <strong>Recent trades</strong>
        <span>${money(entry.volume)} volume</span>
      </div>
      ${recentTrades.length ? `
        <div class="leader-profile-trades">
          ${recentTrades.map(trade => `
            <div>
              <span>${esc(trade.title)}</span>
              <strong>${esc(trade.action)} ${esc(trade.outcomeTitle)} · ${money(trade.amount)}</strong>
            </div>
          `).join("")}
        </div>
      ` : `<p class="leader-profile-empty">No trades yet.</p>`}
    </div>`;
}

function leaderProfilePositionList(rows) {
  const visible = rows.slice(0, 5);
  if (!visible.length) return `<p class="leader-profile-empty">No positions here.</p>`;
  return `
    <div class="leader-profile-positions">
      ${visible.map(row => `
        <div class="leader-profile-position">
          <div>
            <strong>${esc(row.title)}</strong>
            <span>${esc(row.outcomeTitle)} · ${formatShares(row.shares)} shares</span>
          </div>
          <em>${money(row.value)}</em>
        </div>
      `).join("")}
      ${rows.length > visible.length ? `<small>+${rows.length - visible.length} more</small>` : ""}
    </div>`;
}

function recentTradesForMember(group, memberName) {
  const trades = [];
  const seenEvents = new Set();
  for (const market of group.markets ?? []) {
    if (market.eventId) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      for (const trade of market.eventTrades ?? []) {
        if (trade.participant !== memberName) continue;
        trades.push({
          title: sampleEventTitle(market),
          outcomeTitle: tradeDisplayOutcomeTitle(trade, market),
          action: trade.action === "sell" ? "sold" : "bought",
          amount: Number(trade.amount || trade.cashAmount || 0),
          createdAt: trade.createdAt || trade.timestamp || "",
        });
      }
      continue;
    }
    for (const trade of market.trades ?? []) {
      if (trade.participant !== memberName) continue;
      trades.push({
        title: sampleEventTitle(market),
        outcomeTitle: String(trade.side || "").toUpperCase(),
        action: trade.action === "sell" ? "sold" : "bought",
        amount: Number(trade.amount || 0),
        createdAt: trade.createdAt || trade.timestamp || "",
      });
    }
  }
  return trades.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function leaderboardMetricToggle() {
  const metric = state.leaderboardMetric === "percent" ? "percent" : "nominal";
  return `
    <div class="gain-toggle" aria-label="Leaderboard metric">
      <button class="${metric === "nominal" ? "active" : ""}" type="button" data-leaderboard-metric="nominal">$</button>
      <button class="${metric === "percent" ? "active" : ""}" type="button" data-leaderboard-metric="percent">%</button>
    </div>`;
}

function leaderboardPanel(group, { limit = 8, compact = false } = {}) {
  const entries = leaderboardEntries(group).slice(0, limit);
  if (compact) {
    return `
      <div class="panel-block leaderboard-compact-panel" data-open-leaderboard role="button" tabindex="0" aria-label="Open leaderboard">
        <div class="leaderboard-compact-head">
          <div>
            <h2>Leaderboard</h2>
            <p>${state.leaderboardMetric === "percent" ? "Top returns" : "Top gains"}</p>
          </div>
          <div class="leaderboard-compact-actions">
            ${leaderboardMetricToggle("compact")}
          </div>
        </div>
        ${entries.length ? compactLeaderboardChart(entries) : `<p class="muted">No members yet.</p>`}
      </div>`;
  }
  const mode = state.leaderboardMode === "list" ? "list" : "chart";
  return `
    <div class="panel-block leaderboard-panel ${compact ? "leaderboard-panel-compact" : "motion-item"}">
      <div class="section-row compact leaderboard-panel-head">
        <div>
          <p class="eyebrow">Leaderboard</p>
          <h2>Portfolio</h2>
        </div>
        <div class="leaderboard-head-actions">
          ${leaderboardMetricToggle()}
          <div class="leaderboard-toggle" aria-label="Leaderboard view">
            <button class="${mode === "chart" ? "active" : ""}" type="button" data-leaderboard-mode="chart">Chart</button>
            <button class="${mode === "list" ? "active" : ""}" type="button" data-leaderboard-mode="list">List</button>
          </div>
        </div>
      </div>
      ${entries.length
        ? mode === "chart"
          ? leaderboardChart(entries)
          : `<div class="lb-table ${compact ? "mini-lb" : ""}">${entries.map(leaderRow).join("")}</div>`
        : `<p class="muted">No members yet.</p>`}
    </div>`;
}

function compactLeaderboardLimit() {
  return window.matchMedia?.("(max-width: 620px)").matches ? 3 : 8;
}

function expandedLeaderboard(entries) {
  const topThree = entries.slice(0, 3);
  const selected = entries[0];
  return `
    <div class="leaderboard-stage probable-leaderboard-stage motion-item">
      <section class="leaderboard-rank-panel probable-rank-panel">
        ${podiumHtml(topThree)}
        <div class="probable-list-head">
          <span>Rank</span>
          <span>Trader</span>
          <span>${state.leaderboardMetric === "percent" ? "Trade ROI" : "Gain"}</span>
          <span>Portfolio</span>
        </div>
        <div class="expanded-rank-list probable-rank-list">
          ${entries.map(expandedLeaderRow).join("") || `<p class="muted">No members yet.</p>`}
        </div>
      </section>
      <aside class="leader-detail-panel probable-leader-detail">
        ${selected ? leaderDetailHtml(selected) : `<p class="muted">No leader yet.</p>`}
      </aside>
    </div>`;
}

function podiumHtml(entries) {
  const order = [entries[1], entries[0], entries[2]].filter(Boolean);
  return `
    <div class="podium-area probable-podium">
      ${order.map(entry => {
        const rank = entries.indexOf(entry) + 1;
        return `
          <button class="podium-slot probable-podium-slot podium-rank-${rank}" type="button" data-leader-profile="${esc(entry.name)}" aria-label="Open ${esc(entry.name)} profile">
            <div class="leader-avatar podium-avatar">${avatarText(entry.name)}</div>
            <strong>${esc(entry.name)}</strong>
            <span>${leaderboardGainLabel(entry)}</span>
            <div class="podium-block"><b>${rank}</b></div>
          </button>`;
      }).join("")}
    </div>`;
}

function expandedLeaderRow(entry, index) {
  return `
    <button class="expanded-rank-row probable-rank-row" type="button" data-leader-profile="${esc(entry.name)}" aria-label="Open ${esc(entry.name)} profile">
      <span class="expanded-rank-number">${index + 1}</span>
      <span class="leader-avatar">${avatarText(entry.name)}</span>
      <div class="expanded-rank-name">
        <strong>${esc(entry.name)}</strong>
        <span>${entry.trades} trades · ${money(entry.volume)} volume</span>
      </div>
      <span class="expanded-rank-change ${entry.pnl >= 0 ? "pos" : "neg"}">${leaderboardGainLabel(entry)}</span>
      <strong class="probable-rank-equity">${money(entry.bal)}</strong>
    </button>`;
}

function leaderDetailHtml(entry, rank = 1) {
  const start = Number(entry.startingValue || DEFAULT_BALANCE);
  const progress = Math.max(4, Math.min(100, Math.round((entry.bal / Math.max(start, entry.bal + Math.abs(entry.pnl))) * 100)));
  return `
    <div class="leader-detail-hero probable-detail-hero">
      <div class="leader-avatar leader-detail-avatar">${avatarText(entry.name)}</div>
      <div>
        <p class="eyebrow">Rank #${rank}</p>
        <h2>${esc(entry.name)}</h2>
        <span>${leaderboardGainLabel(entry)}</span>
      </div>
    </div>
    <div class="probable-detail-value">
      <span>Portfolio mark</span>
      <strong>${money(entry.bal)}</strong>
      <em>${money(start)} start</em>
    </div>
    <div class="probable-detail-grid">
      <span><strong>${money(entry.cash)}</strong><em>cash</em></span>
      <span><strong>${money(entry.markValue)}</strong><em>mark value</em></span>
      <span><strong>${money(entry.cashOutPortfolio)}</strong><em>cash-out</em></span>
      <span><strong>${entry.trades}</strong><em>trades</em></span>
    </div>
    <div class="leader-detail-section">
      <p class="leader-detail-title">Market profile</p>
      <div class="leader-badges probable-leader-badges">
        <span>${entry.positionValue > 0 ? "Has skin in play" : "Holding cash"}</span>
        <span>${entry.trades >= 5 ? "High activity" : "Selective trader"}</span>
        <span>${entry.pnl >= 0 ? "Positive return" : "Needs a comeback"}</span>
      </div>
    </div>
    <div class="leader-detail-section">
      <div class="leader-progress-label"><span>Portfolio progress</span><strong>${progress}%</strong></div>
      <div class="leader-progress"><span style="width:${progress}%"></span></div>
    </div>`;
}

function compactLeaderboardChart(entries) {
  const rows = entries.slice(0, 5);
  const maxValue = Math.max(...rows.map(entry => Math.max(0, compactLeaderboardMetricValue(entry))), 1);
  return `
    <div class="compact-race-board" aria-label="Top leaderboard bars">
      ${rows.map((entry, index) => {
        const value = Math.max(0, compactLeaderboardMetricValue(entry));
        const width = Math.max(4, Math.round((value / maxValue) * 100));
        return `
          <button class="compact-race-row" type="button" data-leader-profile="${esc(entry.name)}" aria-label="Open ${esc(entry.name)} profile">
            <div class="compact-race-label">
              <strong>${esc(entry.name)}</strong>
              <em>${compactLeaderboardValue(entry)}</em>
            </div>
            <div class="compact-race-track"><span style="width:${width}%"></span></div>
          </button>`;
      }).join("")}
    </div>`;
}

function leaderboardChart(entries) {
  const values = entries.map(entry => Math.max(0, leaderboardSortValue(entry)));
  const maxValue = Math.max(...values, 1);
  return `
    <div class="leaderboard-chart">
      ${entries.map((entry, index) => {
        const pct = Math.max(8, Math.round((Math.max(0, leaderboardSortValue(entry)) / maxValue) * 100));
        return `
          <button class="leader-chart-row motion-item" type="button" data-leader-profile="${esc(entry.name)}" aria-label="Open ${esc(entry.name)} profile">
            <span class="leader-chart-rank">${index + 1}</span>
            <div class="leader-chart-main">
              <div class="leader-chart-label">
                <strong>${esc(entry.name)}</strong>
                <span class="${entry.pnl > 0 ? "pos" : entry.pnl < 0 ? "neg" : "zero"}">${leaderboardGainLabel(entry)}</span>
              </div>
              <div class="leader-chart-track">
                <span class="leader-chart-fill" style="width:${pct}%"></span>
              </div>
              <div class="leader-chart-meta">${entry.trades} trades · ${money(entry.volume)} volume · ${money(entry.markValue)} mark value</div>
            </div>
            <strong class="leader-chart-balance">${money(entry.bal)}</strong>
          </button>`;
      }).join("")}
    </div>`;
}

function leaderboardEntries(group) {
  return (group.members ?? []).map(name => {
    const rawCash = Number(group.balances?.[name] ?? DEFAULT_BALANCE);
    const startingValue = DEFAULT_BALANCE;
    const trades = participantTradeRowsForGroup(group, name);
    const volume = trades.reduce((sum, t) => sum + tradeCashAmount(t), 0);
    const deployed = trades.reduce((sum, t) => sum + (isBuyTrade(t) ? tradeCashAmount(t) : 0), 0);
    const markValue = currentMarkValue(group, name);
    const cashOutValue = currentPositionValue(group, name);
    const hasLedgerActivity = trades.length > 0 || markValue > 0.0001 || cashOutValue > 0.0001;
    const cash = hasLedgerActivity ? rawCash : DEFAULT_BALANCE;
    const positionValue = markValue;
    const bal = cash + markValue;
    const cashOutPortfolio = cash + cashOutValue;
    const pnl = bal - startingValue;
    return {
      name,
      cash,
      startingValue,
      markValue,
      cashOutValue,
      cashOutPortfolio,
      positionValue,
      bal,
      pnl,
      deployed,
      pnlPct: deployed > 0 ? (pnl / deployed) * 100 : 0,
      trades: trades.length,
      volume,
    };
  }).sort((a, b) => leaderboardSortValue(b) - leaderboardSortValue(a));
}

function isBuyTrade(trade) {
  return (trade.action || "buy") !== "sell";
}

function currentMarkValue(group, name) {
  const seenEvents = new Set();
  let value = 0;
  for (const market of group.markets ?? []) {
    if (market.eventId && Array.isArray(market.outcomes) && market.positions) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      if (market.status === "resolved") continue;
      const positions = market.positions?.[name] ?? {};
      value += market.outcomes.reduce((sum, outcome) => {
        const shares = Number(positions[outcome.id] || 0);
        if (!Number.isFinite(shares) || shares <= 0) return sum;
        return sum + shares * Number(outcome.price || 0);
      }, 0);
      continue;
    }
    value += (market.trades ?? [])
      .filter(trade => trade.participant === name)
      .reduce((sum, trade) => sum + markToMarketValue(trade, market), 0);
  }
  return value;
}

function currentPositionValue(group, name) {
  const seenEvents = new Set();
  let value = 0;
  for (const market of group.markets ?? []) {
    if (market.eventId && Array.isArray(market.outcomes) && market.positions) {
      if (seenEvents.has(market.eventId)) continue;
      seenEvents.add(market.eventId);
      if (market.status === "resolved") continue;
      const positions = market.positions?.[name] ?? {};
      value += market.outcomes.reduce((sum, outcome) => {
        const shares = Number(positions[outcome.id] || 0);
        if (!Number.isFinite(shares) || shares <= 0) return sum;
        return sum + lmsrSellValueForShares(market, outcome.id, shares);
      }, 0);
      continue;
    }
    value += (market.trades ?? [])
      .filter(trade => trade.participant === name)
      .reduce((sum, trade) => sum + markToMarketValue(trade, market), 0);
  }
  return value;
}

function lmsrSellValueForShares(market, outcomeId, shares) {
  const amount = Number(shares || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const outcomes = market.outcomes?.length ? market.outcomes : [{ id: market.outcomeId || market.id, price: market.probability, quantity: 0 }];
  const b = Number(market.initialLiquidity || market.liquidity || DEFAULT_MARKET_LIQUIDITY);
  const target = outcomes.find(item => item.id === outcomeId);
  if (!target || !Number.isFinite(b) || b <= 0) return 0;
  const sumExp = outcomes.reduce((sum, item) => sum + Math.exp(Number(item.quantity || 0) / b), 0);
  const targetExp = Math.exp(Number(target.quantity || 0) / b);
  const denominator = sumExp - targetExp + targetExp * Math.exp(-amount / b);
  if (denominator <= 0 || sumExp <= 0) return 0;
  return tradeNetCash(b * Math.log(sumExp / denominator));
}

function leaderboardSortValue(entry) {
  return state.leaderboardMetric === "percent" ? entry.pnlPct : entry.pnl;
}

function leaderboardMetricValue(entry) {
  return state.leaderboardMetric === "percent" ? entry.pnlPct : entry.bal;
}

function compactLeaderboardMetricValue(entry) {
  return state.leaderboardMetric === "percent" ? entry.pnlPct : entry.pnl;
}

function compactLeaderboardValue(entry) {
  if (state.leaderboardMetric === "percent") return signedPercent(entry.pnlPct);
  return signedMoney(entry.pnl);
}

function leaderboardGainLabel(entry) {
  if (state.leaderboardMetric === "percent") return signedPercent(entry.pnlPct);
  return signedMoney(entry.pnl);
}

function signedPercent(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(1)}%`;
}

function markToMarketValue(trade, market) {
  if (!market || market.status === "resolved") return 0;
  const probability = Number(market.probability ?? 0.5);
  const price = trade.side === "yes" ? probability : 1 - probability;
  return Number(trade.shares || 0) * price;
}

function leaderRow(entry, index = 0) {
  const pnlStr = signedMoney(entry.pnl);
  const rank = index + 1;
  return `
    <button class="lb-row motion-item" type="button" data-leader-profile="${esc(entry.name)}" aria-label="Open ${esc(entry.name)} profile">
      <div class="lb-rank">${rank}</div>
      <div class="lb-name">${esc(entry.name)}</div>
      <div class="lb-trades">${entry.trades} trades · ${money(entry.volume)} volume</div>
      <div class="lb-pnl ${entry.pnl > 0 ? "pos" : entry.pnl < 0 ? "neg" : "zero"}">${pnlStr}</div>
      <div class="lb-balance">${money(entry.bal)}</div>
    </button>`;
}

function renderPortfolioCharts() {
  document.querySelectorAll("[data-portfolio-chart]").forEach(canvas => {
    const { labels, data, minY, maxY } = portfolioChartConfig();
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height || 300);
    gradient.addColorStop(0, "rgba(45, 156, 255, 0.42)");
    gradient.addColorStop(0.42, "rgba(18, 79, 143, 0.24)");
    gradient.addColorStop(0.78, "rgba(18, 79, 143, 0.08)");
    gradient.addColorStop(1, "rgba(18, 79, 143, 0.00)");
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Portfolio",
          data,
          borderColor: "#2d9cff",
          backgroundColor: gradient,
          pointBackgroundColor: "#2d9cff",
          pointBorderColor: "rgba(255,255,255,0.92)",
          pointBorderWidth: ctx => ctx.dataIndex === data.length - 1 ? 2 : 0,
          pointRadius: ctx => ctx.dataIndex === data.length - 1 ? 4 : 0,
          pointHoverRadius: 5,
          borderWidth: window.innerWidth < 620 ? 2.2 : 3,
          borderCapStyle: "round",
          borderJoinStyle: "round",
          cubicInterpolationMode: "monotone",
          tension: 0.42,
          fill: "origin",
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 540 },
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 18, right: 62, bottom: 4, left: 2 } },
        plugins: {
          legend: { display: false },
          portfolioEndMarker: { enabled: true, color: "#2d9cff", labelBg: "rgba(15, 22, 26, 0.94)", labelColor: "rgba(244,247,249,0.86)", labelBorder: "rgba(45,156,255,0.3)" },
          tooltip: {
            displayColors: false,
            backgroundColor: "rgba(15,22,26,0.94)",
            titleColor: "rgba(174,188,198,0.78)",
            bodyColor: "#f4f7f9",
            borderColor: "rgba(45,156,255,0.28)",
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: context => `Value ${money(context.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "rgba(157, 171, 181, 0.46)",
              maxTicksLimit: window.innerWidth < 620 ? 2 : 4,
              maxRotation: 0,
              font: { size: 10, family: "IBM Plex Mono" },
            },
          },
          y: {
            min: minY,
            max: maxY,
            position: "right",
            border: { display: false },
            ticks: {
              color: "rgba(157, 171, 181, 0.44)",
              maxTicksLimit: 3,
              callback: value => compactMoney(value),
              font: { size: 10, family: "IBM Plex Mono" },
            },
            grid: { color: "rgba(157, 171, 181, 0.09)", tickLength: 0, drawTicks: false },
          },
        },
      },
    });
    charts.set("portfolio", chart);
  });
}

function renderCharts() {
  renderPortfolioCharts();

  document.querySelectorAll("[data-event-chart-canvas]").forEach(canvas => {
    const key = canvas.dataset.eventChartCanvas;
    const event = findCurrentEventByKey(key);
    if (!event) return;
    const { labels, datasets, minY, maxY, tickStep } = eventChartConfig(event);
    const chart = new Chart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 520 },
        interaction: { mode: "index", intersect: false },
        onHover: (event, _active, chart) => {
          const { chartArea } = chart;
          if (!chartArea || event.x < chartArea.left || event.x > chartArea.right || event.y < chartArea.top || event.y > chartArea.bottom) {
            const hadHover = chart.$probableHoverIndex != null || chart.$probableHoverX != null;
            chart.$probableHoverX = null;
            chart.$probableHoverIndex = null;
            if (hadHover) chart.draw();
          } else {
            const xScale = chart.scales.x;
            const rawIndex = xScale?.getValueForPixel(event.x);
            const maxIndex = Math.max(0, (chart.data.labels?.length || 1) - 1);
            const nextIndex = Math.max(0, Math.min(maxIndex, Math.round(Number(rawIndex) || 0)));
            const changed = chart.$probableHoverIndex !== nextIndex;
            chart.$probableHoverIndex = nextIndex;
            chart.$probableHoverX = xScale?.getPixelForValue(chart.$probableHoverIndex) || event.x;
            if (changed) chart.draw();
          }
        },
        onClick: (event, _active, chart) => {
          const { chartArea } = chart;
          if (!chartArea || event.x < chartArea.left || event.x > chartArea.right) return;
          const xScale = chart.scales.x;
          const rawIndex = xScale?.getValueForPixel(event.x);
          const maxIndex = Math.max(0, (chart.data.labels?.length || 1) - 1);
          chart.$probablePinnedIndex = Math.max(0, Math.min(maxIndex, Math.round(Number(rawIndex) || 0)));
          chart.$probablePinnedX = xScale?.getPixelForValue(chart.$probablePinnedIndex) || event.x;
          chart.draw();
        },
        layout: { padding: { top: 12, right: 16, bottom: 0, left: 0 } },
        plugins: {
          probableCursorShade: { enabled: true, textColor: "#f4f7f9" },
          legend: { display: false },
          tooltip: {
            enabled: false,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "#41505a",
              maxTicksLimit: window.innerWidth < 620 ? 5 : 9,
              autoSkip: true,
              maxRotation: 0,
              font: { size: window.innerWidth < 620 ? 10 : 12, family: "IBM Plex Mono" },
            },
          },
          y: {
            min: minY,
            max: maxY,
            position: "right",
            border: { display: false },
            ticks: {
              stepSize: tickStep || Math.max(1, Math.round((maxY - minY) / 4)),
              color: "#7b8994",
              padding: 6,
              callback: value => `${Number(value).toFixed(Number(value) % 1 ? 1 : 0)}%`,
              font: { size: 11, family: "IBM Plex Mono" },
            },
            grid: {
              color: "rgba(157, 171, 181, 0.16)",
              tickLength: 0,
            },
          },
        },
      },
    });
    charts.set(`event-${key}`, chart);
  });

  document.querySelectorAll("[data-market-chart]").forEach(canvas => {
    const card = canvas.closest("[data-market-id]");
    const market = findMarket(card?.dataset.marketId);
    if (!market) return;
    const history = market.probabilityHistory?.length ? market.probabilityHistory : [{ createdAt: market.createdAt, probability: market.probability }];
    const labels = history.map(p => fmtShortDate(p.createdAt));
    const yesData = history.map(p => Math.round(Number(p.probability) * 1000) / 10);
    const noData = yesData.map(value => Math.round((100 - value) * 10) / 10);
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "YES",
            data: yesData,
            borderColor: "#124f8f",
            pointBackgroundColor: "#124f8f",
            pointBorderColor: "#124f8f",
            borderWidth: 2,
            pointRadius: ctx => chartFollowPointRadius(ctx, 3),
            pointHoverRadius: 4,
            stepped: "after",
            tension: 0,
            fill: false,
          },
          {
            label: "NO",
            data: noData,
            borderColor: "#ef4444",
            pointBackgroundColor: "#ef4444",
            pointBorderColor: "#ef4444",
            borderWidth: 2,
            pointRadius: ctx => chartFollowPointRadius(ctx, 3),
            pointHoverRadius: 4,
            stepped: "after",
            tension: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 450 },
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 20, right: 8, bottom: 0, left: 0 } },
        plugins: {
          probableChartActiveDots: { enabled: true },
          legend: { display: false },
          tooltip: {
            backgroundColor: "#151a1e",
            borderColor: "rgba(157, 171, 181, 0.24)",
            borderWidth: 1,
            titleColor: "#edf2f5",
            bodyColor: "#edf2f5",
            displayColors: true,
            callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}%` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "#65737e",
              maxTicksLimit: 4,
              font: { size: 10, family: "IBM Plex Mono" },
            },
          },
          y: {
            min: 0,
            max: 100,
            position: "right",
            border: { display: false },
            ticks: {
              stepSize: 25,
              color: "#7b8994",
              padding: 5,
              callback: value => `${value}%`,
              font: { size: 10, family: "IBM Plex Mono" },
            },
            grid: {
              color: "rgba(157, 171, 181, 0.18)",
              tickLength: 0,
            },
          },
        },
      },
    });
    charts.set(canvas.dataset.marketChart, chart);
  });
}

function findCurrentEventByKey(key) {
  const group = getCurrentGroup();
  if (!group || !key) return null;
  return marketEvents(group.markets).find(event => event.key === key) ?? null;
}

function eventChartConfig(event) {
  if (isBinaryEvent(event)) return binaryEventChartConfig(event);

  const chartMarkets = chartMarketsForEvent(event);
  const histories = chartMarkets.map(market => displayMarketHistory(market, event));
  const times = [...new Set(histories.flat().map(point => point.time))]
    .sort((a, b) => a - b);
  const chartTimes = times.length ? times : [Date.now()];
  const values = [];
  const datasets = chartMarkets.map((market, index) => {
    const history = histories[index];
    const data = chartTimes.map(time => {
      const value = valueAtTime(history, time);
      values.push(value);
      return value;
    });
    const color = EVENT_CHART_COLORS[index % EVENT_CHART_COLORS.length];
    return {
      label: marketOptionTitle(market),
      data,
      borderColor: color,
      pointBackgroundColor: color,
      pointBorderColor: "#11191e",
      pointBorderWidth: chartFollowPointBorderWidth,
      borderWidth: market.id === state.trade.marketId ? 2.4 : 1.8,
      pointRadius: ctx => chartFollowPointRadius(ctx, 5),
      pointHoverRadius: 6,
      stepped: false,
      tension: 0.18,
      fill: false,
    };
  });
  const domain = probabilityChartDomain(values, { minRange: 12, pad: 2.5 });
  return {
    labels: chartTimeLabels(chartTimes),
    datasets,
    ...domain,
  };
}

function chartMarketsForEvent(event, limit = 5) {
  const markets = event?.markets ?? [];
  if (isBinaryEvent(event)) return markets;
  return markets
    .map((market, index) => ({ market, index, probability: Number(market.probability ?? 0) }))
    .sort((a, b) => (b.probability - a.probability) || (a.index - b.index))
    .slice(0, limit)
    .map(item => item.market);
}

function binaryEventChartConfig(event) {
  const yesMarket = event.markets.find(market => binarySideForMarket(market) === "yes");
  const noMarket = event.markets.find(market => binarySideForMarket(market) === "no");
  const yesHistory = displayMarketHistory(yesMarket || event.markets[0], event);
  const noHistory = displayMarketHistory(noMarket || event.markets[1] || event.markets[0], event);
  const chartTimes = [...new Set([...yesHistory, ...noHistory].map(point => point.time))].sort((a, b) => a - b);
  const yesData = chartTimes.map(time => roundPct(valueAtTime(yesHistory, time)));
  const noData = chartTimes.map(time => roundPct(valueAtTime(noHistory, time)));
  const values = [...yesData, ...noData];
  const datasets = [
    binaryDataset("Yes", yesData, BINARY_CHART_COLORS.yes, state.trade.side === "yes"),
    binaryDataset("No", noData, BINARY_CHART_COLORS.no, state.trade.side === "no"),
  ];
  const domain = probabilityChartDomain(values, { minRange: 8, pad: 1.6 });
  return {
    labels: chartTimeLabels(chartTimes),
    datasets,
    ...domain,
  };
}

function probabilityChartDomain(values, { minRange = 10, pad = 2 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { minY: 45, maxY: 55, tickStep: 2.5 };

  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const spread = Math.max(0.1, high - low);
  let minY = Math.max(0, low - Math.max(pad, spread * 0.18));
  let maxY = Math.min(100, high + Math.max(pad, spread * 0.18));

  if (maxY - minY < minRange) {
    const center = (low + high) / 2;
    minY = center - minRange / 2;
    maxY = center + minRange / 2;
    if (minY < 0) {
      maxY -= minY;
      minY = 0;
    }
    if (maxY > 100) {
      minY -= maxY - 100;
      maxY = 100;
    }
  }

  minY = Math.max(0, Math.floor(minY * 2) / 2);
  maxY = Math.min(100, Math.ceil(maxY * 2) / 2);
  const range = Math.max(1, maxY - minY);
  const rawStep = range / 4;
  const tickStep = rawStep <= 1 ? 1 : rawStep <= 2 ? 2 : rawStep <= 2.5 ? 2.5 : rawStep <= 5 ? 5 : Math.ceil(rawStep / 5) * 5;
  return { minY, maxY, tickStep };
}

function binaryDataset(label, data, color, active) {
  return {
    label,
    data,
    borderColor: color,
    pointBackgroundColor: color,
    pointBorderColor: "#11191e",
    pointBorderWidth: chartFollowPointBorderWidth,
    borderWidth: active ? 2.5 : 2,
    pointRadius: ctx => chartFollowPointRadius(ctx, 5),
    pointHoverRadius: 6,
    stepped: false,
    tension: 0.16,
    fill: false,
  };
}

function normalizedMarketHistory(market) {
  const history = market.probabilityHistory?.length
    ? market.probabilityHistory
    : [{ createdAt: market.createdAt || new Date().toISOString(), probability: market.probability ?? 0.5 }];
  return history
    .map(point => ({
      time: new Date(point.createdAt).getTime(),
      value: Math.round(Number(point.probability ?? market.probability ?? 0.5) * 1000) / 10,
    }))
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
    .sort((a, b) => a.time - b.time);
}

function displayMarketHistory(market, event) {
  const history = normalizedMarketHistory(market);
  if (!hasMarketTrades(market) && history.length <= 1) return flatMarketHistory(history, market);
  return history;
}

function hasMarketTrades(market) {
  const legacyTrades = market.trades ?? [];
  const eventTrades = market.eventTrades ?? [];
  return [...legacyTrades, ...eventTrades].some(trade => Math.abs(tradeCashAmount(trade)) > 0);
}

function flatMarketHistory(history, market) {
  const now = Date.now();
  const created = history[0]?.time || new Date(market.createdAt || now).getTime();
  const value = roundPct(history[0]?.value ?? Number(market.probability ?? 0.5) * 100);
  const span = Math.max(now - created, 60 * 60 * 1000);
  const start = Math.min(created, now - span);
  const points = 8;
  return Array.from({ length: points }, (_, index) => ({
    time: start + (span * index) / (points - 1),
    value,
  }));
}

function interpolatedValue(points, time) {
  if (!points.length) return 50;
  if (time <= points[0].time) return points[0].value;
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const next = points[index];
    if (time <= next.time) {
      const span = Math.max(1, next.time - prev.time);
      const progress = (time - prev.time) / span;
      return prev.value + (next.value - prev.value) * progress;
    }
  }
  return points.at(-1).value;
}

function valueAtTime(history, time) {
  if (!history.length) return 50;
  let value = history[0].value;
  for (const point of history) {
    if (point.time > time) break;
    value = point.value;
  }
  return value;
}

function isBinaryEvent(event) {
  if (!event || event.markets.length !== 2) return false;
  const sides = event.markets.map(binarySideForMarket).sort();
  return sides[0] === "no" && sides[1] === "yes";
}

function binaryMarketForSide(event, side) {
  if (!event) return null;
  return event.markets.find(market => binarySideForMarket(market) === side) || null;
}

function tradeTargetForOutcome(market, event) {
  return { marketId: market.id, yesSide: "yes", noSide: "no" };
}

function binarySideForMarket(market) {
  const label = marketOptionTitle(market).trim().toLowerCase();
  if (label === "yes") return "yes";
  if (label === "no") return "no";
  return null;
}

function displayedEventProbability(market, event) {
  return Number(market.probability ?? 0.5) * 100;
}

function chartColorForMarket(market, index, event) {
  if (isBinaryEvent(event)) {
    const side = binarySideForMarket(market);
    if (side) return BINARY_CHART_COLORS[side];
  }
  return EVENT_CHART_COLORS[index % EVENT_CHART_COLORS.length];
}

function clampPct(value) {
  return Math.max(1, Math.min(99, Number(value) || 0));
}

function roundPct(value) {
  return Math.round(clampPct(value) * 10) / 10;
}

function chartMonthLabel(time) {
  return new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(time));
}

function chartTimeLabels(times) {
  if (!times.length) return [];
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(0, max - min);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const formatter = span <= 36 * hour
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: span <= 4 * hour ? "2-digit" : undefined })
    : span <= 8 * day
      ? new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" })
      : span <= 60 * day
        ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
        : span <= 370 * day
          ? new Intl.DateTimeFormat(undefined, { month: "short" })
          : new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
  return times.map(time => formatter.format(new Date(time)));
}

function destroyCharts() {
  charts.forEach(chart => chart.destroy());
  charts.clear();
}

function animateIn() {
  const items = document.querySelectorAll(".motion-item");
  if (!items.length) return;
  animate(items, { opacity: [0, 1], y: [8, 0] }, { duration: 0.28, delay: stagger(0.025), easing: "ease-out" });
  initGooeyText();
}

function initGooeyText() {
  gooeyCleanup?.();
  const host = document.querySelector("[data-gooey-texts]");
  if (!host) {
    gooeyCleanup = null;
    return;
  }
  const texts = host.dataset.gooeyTexts.split("|").filter(Boolean);
  const currentText = host.querySelector(".gooey-word-current");
  const text1 = host.querySelector(".gooey-word-1");
  const text2 = host.querySelector(".gooey-word-2");
  if (!texts.length || !text1 || !text2) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    if (currentText) currentText.textContent = texts[0];
    text1.textContent = texts[0];
    text1.style.opacity = "1";
    text2.style.opacity = "0";
    return;
  }

  let textIndex = texts.length - 1;
  let time = Date.now();
  let morph = 0;
  let cooldown = 0.62;
  let frame = null;
  const morphTime = 0.92;
  const cooldownTime = 1.65;

  const setMorph = fraction => {
    const next = Math.max(fraction, 0.001);
    const prev = Math.max(1 - fraction, 0.001);
    text2.style.filter = `blur(${Math.min(8 / next - 8, 100)}px)`;
    text2.style.opacity = `${Math.pow(next, 0.4)}`;
    text1.style.filter = `blur(${Math.min(8 / prev - 8, 100)}px)`;
    text1.style.opacity = `${Math.pow(prev, 0.4)}`;
  };

  const doCooldown = () => {
    morph = 0;
    text2.style.filter = "";
    text2.style.opacity = "1";
    text1.style.filter = "";
    text1.style.opacity = "0";
  };

  const doMorph = () => {
    morph -= cooldown;
    cooldown = 0;
    let fraction = morph / morphTime;
    if (fraction > 1) {
      cooldown = cooldownTime;
      fraction = 1;
    }
    setMorph(fraction);
  };

  const tick = () => {
    frame = requestAnimationFrame(tick);
    const now = Date.now();
    const shouldIncrementIndex = cooldown > 0;
    const dt = (now - time) / 1000;
    time = now;
    cooldown -= dt;

    if (cooldown <= 0) {
      if (shouldIncrementIndex) {
        textIndex = (textIndex + 1) % texts.length;
        text1.textContent = texts[textIndex % texts.length];
        text2.textContent = texts[(textIndex + 1) % texts.length];
        if (currentText) currentText.textContent = texts[textIndex % texts.length];
      }
      doMorph();
    } else {
      doCooldown();
    }
  };

  text1.textContent = texts[0];
  text2.textContent = texts[1 % texts.length];
  if (currentText) currentText.textContent = texts[0];
  tick();
  gooeyCleanup = () => cancelAnimationFrame(frame);
}

function ammPreview(poolYes, poolNo, side, amount) {
  const k = poolYes * poolNo;
  let shares, newPoolYes, newPoolNo;
  if (side === "yes") {
    newPoolNo = poolNo + amount;
    newPoolYes = k / newPoolNo;
    shares = amount + (poolYes - newPoolYes);
  } else {
    newPoolYes = poolYes + amount;
    newPoolNo = k / newPoolYes;
    shares = amount + (poolNo - newPoolNo);
  }
  return { shares, newProb: newPoolNo / (newPoolYes + newPoolNo) };
}

function setGroups(groups, { persist = true } = {}) {
  state.groups = reconcileGroups(groups ?? []);
  if (persist && !state.demoMode) persistBootCache();
  if (state.demoMode && !state.groups.some(g => g.id === DEMO_GROUP_ID)) {
    state.groups = state.groups.concat([buildDemoGroup(state.activeMember || "You")]);
  }
  tradeQuoteCache.clear();
  tradeQuoteInflight.clear();
}

function reconcileGroups(incomingGroups) {
  const incoming = Array.isArray(incomingGroups) ? incomingGroups.filter(Boolean) : [];
  const byId = new Map(incoming.map(group => [group.id, group]));
  for (const existing of state.groups ?? []) {
    if (!existing?.id || byId.has(existing.id)) continue;
    if (isPbMyMarketsGroup(existing) && existing.id !== state.currentGroupId) continue;
    if (existing.id === state.currentGroupId || groupHasCurrentMember(existing)) {
      byId.set(existing.id, existing);
    }
  }
  return [...byId.values()];
}

function upsertGroup(group) {
  if (!group?.id) return;
  const next = [...state.groups];
  const index = next.findIndex(item => item.id === group.id);
  if (index >= 0) {
    next[index] = group;
  } else {
    next.unshift(group);
  }
  setGroups(next);
}

function mergeFocusedGroupContext(group) {
  if (!group?.id) return;
  const focusedMarkets = group.markets ?? [];
  if (!focusedMarkets.length) {
    upsertGroup(group);
    return;
  }

  const next = [...state.groups];
  const index = next.findIndex(item => item.id === group.id);
  if (index < 0) {
    upsertGroup(group);
    return;
  }

  const focusedEventIds = new Set(focusedMarkets.map(market => market.eventId || market.id).filter(Boolean));
  const focusedMarketIds = new Set(focusedMarkets.map(market => market.id).filter(Boolean));
  const existing = next[index];
  const remainingMarkets = (existing.markets ?? []).filter(market => {
    const eventId = market.eventId || market.id;
    return !focusedEventIds.has(eventId) && !focusedMarketIds.has(market.id);
  });

  next[index] = {
    ...existing,
    ...group,
    markets: [...focusedMarkets, ...remainingMarkets],
  };
  setGroups(next);
}

function persistBootCache() {
  if (!Array.isArray(state.groups) || !state.groups.length) return;
  try {
    localStorage.setItem(STORAGE_KEYS.bootCache, JSON.stringify({
      groups: state.groups,
      currentGroupId: state.currentGroupId,
      activeMember: state.activeMember,
      savedAt: Date.now(),
    }));
  } catch {
    // Cache is best-effort; app correctness must not depend on storage quota.
  }
}

function readBootCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.bootCache);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (!Array.isArray(cache?.groups) || !cache.groups.length) return null;
    return cache;
  } catch {
    return null;
  }
}

function restoreBootCacheForRoute(route) {
  const cache = readBootCache();
  if (!cache) return false;
  // Market links need fresh event trade history for charts. Rendering cached
  // groups first causes a visible straight-line chart before hydration.
  if (route.name === "market") return false;
  setGroups(cache.groups, { persist: false });
  if (cache.currentGroupId && state.groups.some(group => group.id === cache.currentGroupId)) {
    state.currentGroupId = cache.currentGroupId;
  }
  if (!state.activeMember && cache.activeMember) state.activeMember = cache.activeMember;
  normalizeSelection();
  if (route.name === "market" && state.sharedMarketId) {
    const cachedMarket = findMarketForRoute(state.sharedMarketId);
    if (cachedMarket) {
      openSharedMarket(state.sharedMarketId);
      return true;
    }
  }
  return state.shell === "app" && Boolean(getCurrentGroup());
}

function isPbMyMarketsGroup(group) {
  const name = String(group?.name || "").toLowerCase();
  const emoji = String(group?.emoji || "").toLowerCase();
  return name.includes("my markets") && emoji === "pb";
}

function sampleEventTitle(market) {
  return market.category && market.category !== "General" ? market.category : market.question;
}

function isSampleMarket(market) {
  return String(market?.id || "").startsWith("sample-");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function stripRegionalFlagGlyph(value) {
  return String(value || "")
    .replace(/[\u{E0061}-\u{E007A}\u{E007F}]/gu, "")
    .replace(/^🏴\s*/u, "")
    .trim();
}

function regionalFlagClass(value) {
  const normalized = stripRegionalFlagGlyph(value).toLowerCase();
  if (/\bengland\b/.test(normalized)) return "flag-england";
  if (/\bscotland\b/.test(normalized)) return "flag-scotland";
  return "";
}

function outcomeTitleHtml(value) {
  const label = stripRegionalFlagGlyph(value);
  const flagClass = regionalFlagClass(label);
  return flagClass
    ? `<span class="outcome-flag ${flagClass}" aria-hidden="true"></span>${esc(label)}`
    : esc(label);
}

function tradeSideLabelHtml(value) {
  const raw = String(value || "");
  const suffix = raw.match(/\s·\s(?:Yes|No)$/i)?.[0] || "";
  const base = suffix ? raw.slice(0, -suffix.length) : raw;
  return `${outcomeTitleHtml(base)}${esc(suffix)}`;
}

function normalizeSelection() {
  if (state.currentGroupId && !state.groups.some(g => g.id === state.currentGroupId)) {
    state.currentGroupId = null;
  }
  let group = getCurrentGroup();
  if (group && isPbMyMarketsGroup(group)) {
    const replacement = firstSelectableGroup();
    if (replacement) {
      state.currentGroupId = replacement.id;
      localStorage.setItem(STORAGE_KEYS.groupId, replacement.id);
      group = replacement;
    }
  }
  if (group) {
    const resolved = memberAliasForGroup(group);
    if (resolved && resolved !== state.activeMember) {
      state.activeMember = resolved;
    } else if (!state.activeMember || !group.members.includes(state.activeMember)) {
      state.activeMember = resolved ?? (!isLoggedIn() ? group.members[0] ?? null : null);
    }
  }
  if (!group && !isLoggedIn()) {
    state.activeMember = null;
  }
}

function currentMemberAliases() {
  const aliases = [
    state.authUser?.email,
    state.authUser?.phone,
    authDisplayName(),
    localStorage.getItem("probable_display_name"),
    localStorage.getItem(STORAGE_KEYS.user),
    state.activeMember,
  ];
  const seen = new Set();
  return aliases
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function memberHistoryScore(group, memberName) {
  const member = String(memberName || "").trim();
  if (!group || !member) return -1;
  let score = 0;
  const balance = Number(group.balances?.[member]);
  if (Number.isFinite(balance) && Math.abs(balance - DEFAULT_BALANCE) > 0.009) score += 1000 + Math.min(500, Math.abs(balance - DEFAULT_BALANCE) / 100);
  for (const market of group.markets ?? []) {
    for (const trade of market.eventTrades ?? []) {
      if (trade.participant === member) score += 80 + Math.min(40, tradeCashAmount(trade) / 1000);
    }
    for (const trade of market.trades ?? []) {
      if (trade.participant === member) score += 80 + Math.min(40, tradeCashAmount(trade) / 1000);
    }
    const positions = market.positions?.[member] ?? {};
    for (const shares of Object.values(positions)) {
      if (Number(shares || 0) > 0.000001) score += 60;
    }
  }
  return score;
}

function memberAliasForGroup(group) {
  const members = new Set((group?.members ?? []).map(member => String(member || "").trim()));
  const matches = currentMemberAliases().filter(alias => members.has(alias));
  if (!matches.length) return null;
  return matches
    .map((alias, index) => ({ alias, index, score: memberHistoryScore(group, alias) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))[0].alias;
}

function groupHasCurrentMember(group) {
  return Boolean(memberAliasForGroup(group));
}

function renderMarketLinkLoading({ error = "" } = {}) {
  const isError = Boolean(error);
  dom.mainContent.innerHTML = `
    <section class="invite-preview-page">
      <div class="invite-preview-card motion-item market-link-card">
        <button class="logo invite-preview-logo" type="button" data-go-welcome>probable<span class="logo-dot">.</span></button>
        <p class="eyebrow">Market link</p>
        <h1>${isError ? "Could not open market" : "Opening market"}</h1>
        <p class="${isError ? "invite-error" : "muted"}">${esc(isError ? error : "Loading the latest prices and trade panel.")}</p>
        <div class="market-link-actions">
          <button class="btn btn-primary" type="button" data-retry-initial-load>${isError ? "Retry" : "Still loading?"}</button>
          <button class="btn btn-ghost" type="button" data-enter-app>Enter app</button>
        </div>
      </div>
    </section>`;
}

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
  ["group", "join", "invite", "embed", "leaderProfile", "tradeHistory", "login", "market", "suggestPreview"].forEach(closeModal);
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
    const memberGroup = isLoggedIn() ? state.groups.find(groupHasCurrentMember) : null;
    if (memberGroup) {
      state.currentGroupId = memberGroup.id;
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

function enterWelcomeShell({ updateUrl = true } = {}) {
  state.shell = "welcome";
  state.view = "dashboard";
  state.welcomeMode = "actions";
  state.trade = emptyTrade();
  state.expandedEventKey = null;
  state.accountMenuOpen = false;
  state.inviteToken = null;
  state.invitePreview = null;
  state.inviteError = "";
  state.sharedMarketId = null;
  if (isLoggedIn()) {
    localStorage.setItem(STORAGE_KEYS.shell, "welcome");
    localStorage.setItem(STORAGE_KEYS.view, "dashboard");
  }
  if (updateUrl) routeToWelcome({ replace: true });
}

function persistNavigationState() {
  if (!isLoggedIn()) return;
  if (state.shell !== "app") return;
  localStorage.setItem(STORAGE_KEYS.shell, "app");
  localStorage.setItem(STORAGE_KEYS.view, state.view || "dashboard");
  if (state.currentGroupId) localStorage.setItem(STORAGE_KEYS.groupId, state.currentGroupId);
  if (state.activeMember) localStorage.setItem(STORAGE_KEYS.user, state.activeMember);
  if (import.meta.env.DEV && state.activeMember) {
    const displayName = authDisplayName() || state.activeMember;
    localStorage.setItem(STORAGE_KEYS.devAuth, JSON.stringify({
      displayName,
      email: state.authUser?.email || "dev@probable.local",
    }));
  }
}

function getCurrentGroup() {
  if (!state.currentGroupId) return null;
  return state.groups.find(g => g.id === state.currentGroupId) ?? null;
}

function findMarket(mid) {
  if (!mid) return null;
  return state.groups.flatMap(g => g.markets).find(m => m.id === mid) ?? null;
}

function findGroupForMarket(mid) {
  if (!mid) return null;
  return state.groups.find(group => (group.markets ?? []).some(market => (
    market.id === mid ||
    market.eventId === mid ||
    market.outcomeId === mid ||
    (market.outcomes ?? []).some(outcome => outcome.id === mid)
  ))) ?? null;
}

function openModal(type) {
  if (type === "group") resetGroupEmoji();
  if (type === "market") {
    dom.marketForm.reset();
    resetMarketForm();
  }
  if (type === "join") {
    const input = dom.joinForm.querySelector("[name=groupId]");
    if (input && state.joinPreFill) input.value = state.joinPreFill;
  }
  if (type === "login") {
    updateAuthModal();
  }
  dom[`${type}ModalOverlay`].classList.remove("hidden");
}

function closeModal(type) {
  if (type === "login") state.pendingAuthAction = null;
  dom[`${type}ModalOverlay`].classList.add("hidden");
}

function applyAuthSession(session, { renderNow = true } = {}) {
  state.authUser = session?.user ?? null;
  if (state.authUser) {
    state.activeMember = authDisplayName();
  } else {
    state.activeMember = null;
    if (state.embedRoute) {
      state.shell = "embed";
      if (renderNow) render();
      return;
    }
    if (!shouldHoldAppShell()) state.currentGroupId = null;
    if (state.inviteToken) state.shell = "invite";
    else if (state.sharedMarketId) state.shell = "app";
    else if (shouldHoldAppShell()) state.shell = "app";
    else enterWelcomeShell();
  }
  if (renderNow) {
    normalizeSelection();
    render();
    if (state.authUser && state.view === "bracket") {
      void loadRemoteBracketEntry({ refresh: true });
    }
    if (state.authUser && state.view === "plPredictor") {
      void loadRemotePremierLeagueEntry({ refresh: true });
    }
  }
}

function resetToWelcomeAfterSignOut() {
  applyAuthSession(null, { renderNow: false });
  state.currentGroupId = null;
  state.activeMember = null;
  enterWelcomeShell();
  state.pendingAuthAction = null;
  sessionStorage.removeItem("probable_pending_auth_action");
  sessionStorage.removeItem("probable_pending_market");
  localStorage.removeItem(STORAGE_KEYS.user);
  localStorage.removeItem(STORAGE_KEYS.groupId);
  localStorage.removeItem(STORAGE_KEYS.shell);
  localStorage.removeItem(STORAGE_KEYS.view);
  localStorage.removeItem(STORAGE_KEYS.devAuth);
}

function authDisplayName() {
  const user = state.authUser;
  if (!user) return "";
  const storedName = localStorage.getItem("probable_display_name")?.trim();
  let providerName = (
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.user_metadata?.preferred_username ||
    ""
  ).trim();
  if (isEmailLike(providerName)) providerName = "";
  return (
    providerName ||
    storedName ||
    user.email ||
    user.phone ||
    `user-${String(user.id || "").slice(0, 8)}`
  );
}

function runStoredPendingAuthAction() {
  if (!isLoggedIn()) return;
  const action = sessionStorage.getItem("probable_pending_auth_action");
  if (!action) return;
  sessionStorage.removeItem("probable_pending_auth_action");
  state.pendingAuthAction = action;
  runPendingAuthAction();
}

function updateAuthModal() {
  const loggedIn = isLoggedIn();
  const devBypass = import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_AUTH_BYPASS === "true";
  dom.loginModalOverlay.querySelector(".auth-modal")?.classList.toggle("is-logged-in", loggedIn);
  dom.loginModalTitle.textContent = loggedIn ? "Signed in" : "Sign in to Probable";
  if (!loggedIn && dom.authNameInput && !dom.authNameInput.value) {
    dom.authNameInput.value = localStorage.getItem("probable_display_name") || "";
  }
  dom.authCurrent.innerHTML = loggedIn
    ? `You’re signed in as <strong>${esc(authDisplayName())}</strong>.`
    : "Welcome back. Sign in with Google to create markets.";
  dom.authNameArea.classList.toggle("hidden", loggedIn || !devBypass);
  dom.authProviderArea.classList.toggle("hidden", loggedIn);
  dom.authDivider.classList.add("hidden");
  dom.authEmailArea.classList.add("hidden");
  dom.authModalFooter.classList.add("hidden");
  dom.authSessionActions.classList.toggle("hidden", !loggedIn);
}

function setMarketMinDate() {
  const input = document.querySelector("#marketForm [name=closesAt]");
  if (!input) return;
  const now = new Date(Date.now() + 5 * 60 * 1000);
  input.min = toLocalDatetime(now);
  if (!input.value) input.value = toLocalDatetime(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function setWelcomeMarketMinDate() {
  const input = document.querySelector("#dashboardCreateForm [name=closesAt]");
  if (!input) return;
  const now = new Date(Date.now() + 5 * 60 * 1000);
  input.min = toLocalDatetime(now);
  if (!input.value) input.value = toLocalDatetime(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function resetMarketForm() {
  const oracle = document.querySelector("#marketForm [name=oracle]");
  const probSliderVal = document.querySelector("#probSliderVal");
  const probLabel = document.querySelector("#probLabel");
  const imageInput = document.querySelector("#marketForm [name=image]");
  const oddsToggle = document.querySelector("#marketForm [data-market-odds-toggle]");
  if (oracle) oracle.value = "ai";
  if (probSliderVal) probSliderVal.textContent = "50%";
  if (probLabel) probLabel.textContent = "50% YES";
  if (imageInput) imageInput.value = "";
  state.marketImageDataUrl = "";
  state.marketImageName = "";
  state.marketOddsSeed = null;
  if (oddsToggle) {
    oddsToggle.checked = false;
    delete oddsToggle.dataset.userSet;
  }
  state.marketFormStep = 1;
  state.marketSlugSuffix = randomSlugSuffix();
  setMarketType("binary");
  updateMarketImagePreview();
  updateMarketFormStep();
  setMarketMinDate();
}

function fmtClose(market) {
  if (!market.closesAt) return "No close";
  return `${market.status === "open" ? "Closes" : "Closed"} ${fmtDate(market.closesAt)}`;
}

function fmtDate(v) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(v));
}

function fmtShortDate(v) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(v));
}

function toLocalDatetime(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let toastTimer = null;
function toast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), 2800);
}

function toastSettlement(settlement, fallback = "Market resolved.") {
  if (!settlement) {
    toast(fallback);
    return;
  }
  const title = settlement.outcomeTitle || settlement.outcome || "Outcome";
  const payouts = Array.isArray(settlement.payouts) ? settlement.payouts : [];
  const active = state.activeMember || authDisplayName();
  let payoutLine = "";
  if (active) {
    const activePayout = payouts.find(item => item.participant === active);
    payoutLine = `${active} +${money(Number(activePayout?.payout || 0))}`;
  } else if (payouts.length) {
    payoutLine = payouts
      .slice()
      .sort((a, b) => Number(b.payout || 0) - Number(a.payout || 0))
      .slice(0, 2)
      .map(item => `${item.participant} +${money(Number(item.payout || 0))}`)
      .join(" · ");
  }
  toast(`Resolved ${title}${payoutLine ? ` · ${payoutLine}` : ""}`);
}

async function api(path, opts = {}) {
  if (state.demoMode && (path.includes("/markets/demo-") || path.includes(`/groups/${DEMO_GROUP_ID}/`))) {
    const demoGroup = state.groups.find(g => g.id === DEMO_GROUP_ID);
    return simulateDemoApi(path, opts, demoGroup, state.groups);
  }
  if (!API && import.meta.env.PROD && !isLocalHost()) {
    throw new Error(API_CONFIG_ERROR);
  }
  const { timeoutMs = API_TIMEOUT_MS, ...fetchOpts } = opts;
  const res = await fetchWithTimeout(`${API}${path}`, {
    ...fetchOpts,
    timeoutMs,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = "Request failed";
    try { msg = (await res.json()).detail || msg; } catch { msg = res.statusText || msg; }
    throw new Error(msg);
  }
  return res.json();
}

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = API_TIMEOUT_MS, signal, ...fetchOpts } = opts;
  if (signal) return fetch(url, { ...fetchOpts, signal });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOpts, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Connection timed out. Check your connection and try again.");
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, label = "Request") {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} timed out. Try again.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function isLocalHost() {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(location.hostname) || location.hostname.endsWith(".local");
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
