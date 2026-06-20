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

Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip, probableCursorShadePlugin, probableChartActiveDotsPlugin);

const API = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const DEFAULT_BALANCE = 100000;
const DEFAULT_MARKET_LIQUIDITY = 20000;
const MARKET_FEE_RATE = 0.015;
let rulesDraftPromise = null;
const MAX_MARKET_IMAGE_BYTES = 650000;
const EVENT_CHART_COLORS = ["#2d9cff", "#f23645", "#f2c414", "#ff861c", "#8bd450", "#b87cff", "#18c3b6", "#78b7ff"];
const BINARY_CHART_COLORS = { yes: "#2d9cff", no: "#f23645" };
const charts = new Map();
let gooeyCleanup = null;
const STORAGE_KEYS = {
  shell: "probable_shell",
  view: "probable_view",
  groupId: "probable_groupId",
  user: "probable_user",
  devAuth: "probable_dev_auth",
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
  embedRoute: null,
  sharedMarketId: null,
  trade: { marketId: null, side: null, mode: "buy" },
  expandedEventKey: null,
  oracleErrors: {},
  pendingAuthAction: null,
  authUser: null,
  accountMenuOpen: false,
  leaderboardMode: "chart",
  leaderboardMetric: "nominal",
  positionsStatus: "open",
  expandedParticipants: new Set(),
  marketSort: "trending",
  marketStatus: "open",
  marketFormStep: 1,
  marketImageDataUrl: "",
  marketImageName: "",
  marketImages: [],
  pendingUi: { marketCreate: false, welcomeCreate: false, rulesDraft: false, tradeMarketId: null, resolveMarketId: null },
  loaded: false,
};

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
            <span data-market-step-count>Step 1 of 5</span>
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
  <div class="price-tick-layer" id="priceTickLayer" aria-hidden="true"></div>
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
  embedModalOverlay: document.querySelector("#embedModalOverlay"),
  embedModalBody: document.querySelector("#embedModalBody"),
  leaderProfileModalOverlay: document.querySelector("#leaderProfileModalOverlay"),
  leaderProfileModalBody: document.querySelector("#leaderProfileModalBody"),
  loginModalOverlay: document.querySelector("#loginModalOverlay"),
  marketModalOverlay: document.querySelector("#marketModalOverlay"),
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
document.querySelector("#closeEmbedModal").addEventListener("click", () => closeModal("embed"));
document.querySelector("#closeLeaderProfileModal").addEventListener("click", () => closeModal("leaderProfile"));
document.querySelector("#closeLoginModal").addEventListener("click", () => closeModal("login"));
document.querySelector("#closeMarketModal").addEventListener("click", () => closeModal("market"));
dom.groupModalOverlay.addEventListener("click", e => { if (e.target === dom.groupModalOverlay) closeModal("group"); });
dom.joinModalOverlay.addEventListener("click", e => { if (e.target === dom.joinModalOverlay) closeModal("join"); });
dom.inviteModalOverlay.addEventListener("click", e => { if (e.target === dom.inviteModalOverlay) closeModal("invite"); });
dom.embedModalOverlay.addEventListener("click", e => { if (e.target === dom.embedModalOverlay) closeModal("embed"); });
dom.leaderProfileModalOverlay.addEventListener("click", e => { if (e.target === dom.leaderProfileModalOverlay) closeModal("leaderProfile"); });
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
document.addEventListener("change", onGlobalChange);
document.addEventListener("input", onGlobalInput);
document.addEventListener("submit", onGlobalSubmit);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeModal("group");
    closeModal("join");
    closeModal("invite");
    closeModal("embed");
    closeModal("leaderProfile");
    closeModal("login");
    closeModal("market");
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
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    applyAuthSession(data.session || restoreDevAuthSession(), { renderNow: false });
    const savedGroup = localStorage.getItem(STORAGE_KEYS.groupId);
    const savedShell = localStorage.getItem(STORAGE_KEYS.shell);
    const savedView = localStorage.getItem(STORAGE_KEYS.view);
    const savedWantsWelcome = savedShell === "welcome" && initialRoute.name === "welcome";
    if (state.authUser && savedGroup) state.currentGroupId = savedGroup;
    const isEmbedRoute = initialRoute.name === "embedMarket" || initialRoute.name === "embedEvent";
    if (state.authUser && !isEmbedRoute && !state.inviteToken && !savedWantsWelcome && (initialRoute.name === "app" || initialRoute.name === "leaderboard" || initialRoute.name === "admin" || savedShell === "app" || savedGroup || state.sharedMarketId)) {
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

  render();
  try {
    await loadMarketImages();
    const data = await api("/api/groups");
    setGroups(data.groups);
    if (state.inviteToken) await loadInvitePreview(state.inviteToken);
    if (state.sharedMarketId) openSharedMarket(state.sharedMarketId);
    normalizeSelection();
    if (state.shell === "app" && !state.currentGroupId && state.groups.length) {
      const savedGroup = localStorage.getItem(STORAGE_KEYS.groupId);
      state.currentGroupId = state.groups.some(group => group.id === savedGroup) ? savedGroup : state.groups[0].id;
      normalizeSelection();
    }
    if (state.authUser && !state.inviteToken && !state.sharedMarketId && (state.currentGroupId || state.groups.length)) {
      state.shell = "app";
    }
  } catch (err) {
    toast(err.message || "Could not load groups.");
  } finally {
    state.loaded = true;
    render();
    runStoredPendingAuthAction();
  }
}

init();

function routeFromLocation() {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean).map(part => decodeURIComponent(part));

  if (parts[0] === "invite" && parts[1]) return { name: "invite", token: parts[1] };
  if (parts[0] === "embed" && parts[1] === "market" && parts[2]) return { name: "embedMarket", marketId: parts[2], options: embedOptionsFromSearch(url.searchParams) };
  if (parts[0] === "embed" && parts[1] === "event" && parts[2]) return { name: "embedEvent", eventId: parts[2], options: embedOptionsFromSearch(url.searchParams) };
  if (parts[0] === "market" && parts[1]) return { name: "market", marketId: parts[1] };
  if (parts[0] === "leaderboard") return { name: "leaderboard" };
  if (parts[0] === "admin") return { name: "admin" };
  if (parts[0] === "portfolio") return { name: "positions" };
  if (parts[0] === "positions") return { name: "positions", legacyPath: "/portfolio" };
  if (parts[0] === "app") return { name: "app" };

  const legacyInvite = url.searchParams.get("invite");
  const legacyMarket = url.searchParams.get("market");
  const legacyJoin = url.searchParams.get("join");
  if (legacyInvite) return { name: "invite", token: legacyInvite, legacyPath: `/invite/${encodeURIComponent(legacyInvite)}` };
  if (legacyMarket) return { name: "market", marketId: legacyMarket, legacyPath: `/market/${encodeURIComponent(legacyMarket)}` };
  if (legacyJoin) return { name: "welcome", joinPreFill: legacyJoin, legacyPath: "/" };
  return { name: "welcome" };
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

function routeToMarket(marketId, { replace = false } = {}) {
  navigateTo(`/market/${encodeURIComponent(marketId)}`, { replace });
}

function appViewFromRouteOrSaved(route, savedView = "dashboard") {
  if (route.name === "leaderboard") return "leaderboard";
  if (route.name === "admin") return "admin";
  if (route.name === "positions") return "positions";
  if (savedView === "leaderboard") return "leaderboard";
  if (savedView === "admin") return "admin";
  if (savedView === "positions") return "positions";
  return "dashboard";
}

function routeToCurrentAppView({ replace = false } = {}) {
  if (state.view === "leaderboard") return routeToLeaderboard({ replace });
  if (state.view === "admin") return routeToAdmin({ replace });
  if (state.view === "positions") return routeToPositions({ replace });
  return routeToApp({ replace });
}

async function loadMarketImages() {
  try {
    const res = await fetch("/market-images/manifest.json", { cache: "no-cache" });
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

  const simulateBtn = e.target.closest("[data-simulate-market]");
  if (simulateBtn) {
    const market = findMarket(simulateBtn.dataset.simulateMarket);
    if (market) await simulateMarketActivity(market);
    return;
  }

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

  const positionStatusBtn = e.target.closest("[data-position-status-filter]");
  if (positionStatusBtn) {
    state.positionsStatus = positionStatusBtn.dataset.positionStatusFilter === "closed" ? "closed" : "open";
    renderPositions();
    return;
  }

  const leaderProfileBtn = e.target.closest("[data-leader-profile]");
  if (leaderProfileBtn) {
    e.preventDefault();
    e.stopPropagation();
    openLeaderProfile(leaderProfileBtn.dataset.leaderProfile || "");
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
    enterWelcomeShell();
    render();
    return;
  }

  if (e.target.closest("[data-go-dashboard]")) {
    state.shell = "app";
    state.view = "dashboard";
    state.trade = emptyTrade();
    state.sharedMarketId = null;
    routeToApp();
    render();
    return;
  }

  if (e.target.closest("[data-enter-app]")) {
    if (!isLoggedIn()) {
      requireLogin("enter-app");
      return;
    }
    if (!getCurrentGroup()) {
      await ensureMarketGroup();
    }
    state.shell = "app";
    state.view = "dashboard";
    state.welcomeMode = "actions";
    state.trade = emptyTrade();
    routeToApp();
    normalizeSelection();
    render();
    return;
  }

  const groupBtn = e.target.closest("[data-group-id]");
  if (groupBtn) {
    const gid = groupBtn.dataset.groupId;
    if (gid === "__new") {
      if (requireLogin("create-group")) openModal("group");
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
    return;
  }

  if (e.target.closest("[data-create-market-welcome]")) {
    state.welcomeMode = "create";
    render();
    return;
  }

  if (e.target.closest("[data-create-group]")) {
    if (!requireLogin("create-group")) return;
    openModal("group");
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

  if (e.target.closest("[data-new-market]")) {
    if (!requireLogin("create-market")) return;
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
    openMarketEmbedModal(marketShareBtn.dataset.shareMarket);
    return;
  }

  if (e.target.closest("[data-copy-market-link]")) {
    await copyMarketLink();
    return;
  }

  if (e.target.closest("[data-whatsapp-market]")) {
    openWhatsAppShare();
    return;
  }

  if (e.target.closest("[data-native-share-market]")) {
    await nativeShareMarket();
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
    if ((inTradePanel || inFocusedTrade) && state.trade.marketId === mid) {
      setTradeSide(mid, side);
      return;
    }
    const nextTrade = state.trade.marketId === mid && state.trade.side === side
      ? ((inTradePanel || inFocusedTrade) ? state.trade : emptyTrade())
      : { marketId: mid, side, mode: state.trade.mode || "buy" };
    state.trade = nextTrade;
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
    routeToApp();
    render();
    return;
  }

  const fillAmountBtn = e.target.closest("[data-fill-amount], [data-fill-percent]");
  if (fillAmountBtn) {
    if (fillAmountBtn.disabled) return;
    const panel = fillAmountBtn.closest("[data-market-id]");
    const input = panel?.querySelector(".trade-input");
    const market = findMarket(panel?.dataset.marketId);
    if (input && market) {
      const max = Number(input.dataset.rawMax || input.max || DEFAULT_BALANCE);
      if (fillAmountBtn.dataset.fillPercent) {
        const percent = Number(fillAmountBtn.dataset.fillPercent || 0);
        const exact = (max * percent) / 100;
        input.dataset.rawAmount = formatShareInput(exact);
        input.value = formatShareDisplay(exact);
        renderTradePreview(market, exact);
      } else if (fillAmountBtn.dataset.fillAmount === "max") {
        input.dataset.rawAmount = formatShareInput(max);
        input.value = formatShareDisplay(max);
        renderTradePreview(market, max);
      } else {
        delete input.dataset.rawAmount;
        const next = (parseFloat(input.value) || 0) + Number(fillAmountBtn.dataset.fillAmount || 0);
        input.value = String(Math.min(max, next));
        renderTradePreview(market, parseFloat(input.value) || 0);
      }
    }
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
  const market = group?.markets?.find(item => item.id === marketId);
  if (!group || !market) {
    if (state.loaded) toast("That market link could not be found.");
    return false;
  }
  state.currentGroupId = group.id;
  state.shell = "app";
  state.view = "dashboard";
  state.trade = { marketId: market.id, side: "yes", mode: "buy" };
  state.expandedEventKey = null;
  if (isLoggedIn()) localStorage.setItem("probable_groupId", group.id);
  return true;
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
    delete e.target.dataset.rawAmount;
    const market = findMarket(e.target.closest("[data-market-id]")?.dataset.marketId);
    if (market) renderTradePreview(market, parseFloat(e.target.value) || 0);
    return;
  }
  if (e.target.matches("#marketForm [name=outcomes]")) {
    updateOutcomePreviews();
    if (state.marketFormStep === 4) updateMarketReview();
  }
  if (e.target.matches("#marketForm [name=description], #marketForm [name=question], #marketForm [name=closesAt]")) {
    if (state.marketFormStep === 4) updateMarketReview();
  }
}

function onGlobalChange(e) {
  if (e.target.matches("#marketForm [name=image]")) {
    handleMarketImageInput(e.target);
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
  const market = findMarket(form.closest("[data-market-id]")?.dataset.marketId);
  if (!market) return;
  if (isSampleMarket(market)) {
    toast("Sample market only. Create a real market to trade.");
    return;
  }

  const input = form.querySelector(".trade-input");
  const rawAmount = tradeInputAmount(input);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    toast("Enter a valid amount.");
    return;
  }
  if (!requireLogin()) return;
  if (!state.activeMember) {
    toast("Select a member first.");
    return;
  }

  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const action = state.trade.mode || "buy";
  let amount = rawAmount;
  if (state.pendingUi.tradeMarketId === market.id) return;
  if (action === "buy" && amount > balance) {
    toast(`${state.activeMember} has ${money(balance)}.`);
    return;
  }
  if (action === "sell") {
    const outcomeId = tradeOutcomeId(market, state.trade.side);
    const sellState = sellPreviewForShares(market, outcomeId, rawAmount, state.trade.side);
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
    const side = state.trade.side;
    const data = await api(`/api/markets/${market.id}/trade`, {
      method: "POST",
      body: JSON.stringify({ participant: state.activeMember, side, amount, action, outcomeId: tradeOutcomeId(market, side) }),
    });
    state.pendingUi.tradeMarketId = null;
    setButtonPending(submit, false);
    setGroups(data.groups);
    state.trade = { marketId: market.id, side, mode: action };
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

const SIM_PERSONAS = [
  { tag: "yolo", pctRange: [0.25, 0.45], bias: "momentum", skipChance: 0 },
  { tag: "momentum", pctRange: [0.12, 0.22], bias: "momentum", skipChance: 0.1 },
  { tag: "contrarian", pctRange: [0.1, 0.2], bias: "contrarian", skipChance: 0.1 },
  { tag: "optimist", pctRange: [0.1, 0.2], bias: "favorite", skipChance: 0.15 },
  { tag: "pessimist", pctRange: [0.04, 0.1], bias: "underdog", skipChance: 0.35 },
  { tag: "cautious", pctRange: [0.02, 0.07], bias: "coinflip", skipChance: 0.2 },
];

const SIM_NAMES = ["Avery", "Jordan", "Casey", "Quinn", "Riley", "Sage", "Drew", "Nico", "Wren", "Hale"];

async function simulateMarketActivity(market) {
  if (!import.meta.env.DEV) return;
  if (isSampleMarket(market)) {
    toast("Sample market only. Create a real market to simulate.");
    return;
  }
  let group = getCurrentGroup();
  if (!group) {
    toast("Open a group first.");
    return;
  }
  const button = document.querySelector(`[data-simulate-market="${market.id}"]`);
  setButtonPending(button, true, "Simulating");
  try {
    const shuffledPersonas = [...SIM_PERSONAS].sort(() => Math.random() - 0.5);
    const botCount = 4 + Math.floor(Math.random() * 3);
    const bots = shuffledPersonas.slice(0, botCount).map((persona, index) => ({
      name: `Sim_${randomItem(SIM_NAMES)}${index}`,
      persona,
    }));

    for (const bot of bots) {
      if (group.members.includes(bot.name)) continue;
      const joined = await api(`/api/groups/${group.id}/join`, {
        method: "POST",
        body: JSON.stringify({ name: bot.name }),
      });
      setGroups(joined.groups);
      group = getCurrentGroup();
    }

    let count = 0;
    const rounds = 220 + Math.floor(Math.random() * 160);
    for (let index = 0; index < rounds; index += 1) {
      group = getCurrentGroup();
      const liveMarket = findMarket(market.id);
      if (!group || !liveMarket || liveMarket.status !== "open") break;
      const liveEvent = findEventForMarket(group, liveMarket);
      const outcomeMarkets = liveEvent?.markets?.length ? liveEvent.markets : [liveMarket];
      const leader = outcomeMarkets[0];

      const bot = randomItem(bots);
      const balance = Number(group?.balances?.[bot.name] ?? 0);
      if (balance < 50 || Math.random() < bot.persona.skipChance) continue;

      const target = pickSimOutcome(outcomeMarkets, bot.persona.bias);
      if (!target) continue;

      const [minPct, maxPct] = bot.persona.pctRange;
      const amount = Math.max(25, Math.min(balance, Math.round(balance * randomBetween(minPct, maxPct))));

      try {
        const data = await api(`/api/markets/${target.id}/trade`, {
          method: "POST",
          body: JSON.stringify({
            participant: bot.name,
            side: "yes",
            amount,
            action: "buy",
            outcomeId: target.outcomeId || target.id,
          }),
        });
        setGroups(data.groups);
        count += 1;
        spawnPriceTick(amount, !leader || target.id === leader.id);
      } catch {
        // A single bot's trade can fail (e.g. per-trade cap); keep the walk going.
      }
      if (count > 0 && count % 10 === 0) {
        render();
        setButtonPending(document.querySelector(`[data-simulate-market="${market.id}"]`), true, "Simulating");
      }
    }

    state.currentGroupId = group.id;
    normalizeSelection();
    render();
    toast(count ? `Simulated ${count} trades across ${bots.length} traders.` : "Could not simulate — market may be closed.");
  } catch (err) {
    toast(err.message || "Simulation failed.");
  } finally {
    setButtonPending(button, false);
  }
}

function pickSimOutcome(outcomeMarkets, bias) {
  const openOnly = outcomeMarkets.filter(item => item.status === "open");
  const pool = openOnly.length ? openOnly : outcomeMarkets;
  if (!pool.length) return null;
  if (bias === "coinflip") return randomItem(pool);
  const scored = pool.map(item => {
    const history = normalizedMarketHistory(item);
    const last = history.at(-1)?.value ?? Number(item.probability || 0.5) * 100;
    const prev = history[Math.max(0, history.length - 4)]?.value ?? last;
    return { market: item, probability: Number(item.probability || 0.5), movement: last - prev };
  });
  if (bias === "momentum") {
    return weightedRandom(scored, item => Math.max(1, item.movement + 5))?.market || randomItem(pool);
  }
  if (bias === "favorite") {
    return weightedRandom(scored, item => Math.max(1, item.probability * 100))?.market || randomItem(pool);
  }
  if (bias === "underdog" || bias === "contrarian") {
    return weightedRandom(scored, item => Math.max(1, (1 - item.probability) * 100))?.market || randomItem(pool);
  }
  return randomItem(pool);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomItem(items) {
  if (!items?.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function weightedRandom(items, weightFn) {
  if (!items?.length) return null;
  const weights = items.map(item => Math.max(0, Number(weightFn(item) || 0)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return randomItem(items);
  let cursor = Math.random() * total;
  for (let index = 0; index < items.length; index += 1) {
    cursor -= weights[index];
    if (cursor <= 0) return items[index];
  }
  return items.at(-1);
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

function marketPayloadFromForm(fd) {
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
  return {
    question,
    description,
    category: "General",
    closesAt: closesAt.toISOString(),
    outcomes,
    initialProbability: 0.5,
    initialLiquidity: DEFAULT_MARKET_LIQUIDITY,
    oracleType: "ai",
  };
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
      if (state.marketFormStep === 4) updateMarketReview(form);
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
    if (state.marketFormStep === 4) updateMarketReview();
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
  const keys = outcomes.map(outcome => outcome.toLowerCase());
  return keys.length === 2 && keys.includes("yes") && keys.includes("no") ? "Binary" : "Multiple choice";
}

function outcomePreviewHtml(outcomes) {
  const list = outcomes.length ? outcomes : ["Yes", "No"];
  return list.map(outcome => `<span>${escapeHtml(outcome)}</span>`).join("");
}

function updateOutcomePreviews(form = dom.marketForm) {
  const outcomes = parseOutcomeOptions(form.querySelector("[name=outcomes]")?.value ?? "");
  form.querySelectorAll("[data-outcome-preview]").forEach(target => {
    target.innerHTML = outcomePreviewHtml(outcomes);
  });
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
  const slug = marketSlugFor(question);
  review.innerHTML = `
    <div class="market-review-row">
      <span>Question</span>
      <strong>${escapeHtml(question)}</strong>
    </div>
    <div class="market-review-row">
      <span>Link</span>
      <strong class="market-review-slug">probable.fun/m/${escapeHtml(slug)}</strong>
    </div>
    <div class="market-review-row">
      <span>Type</span>
      <strong>${marketTypeLabel(outcomes)}</strong>
    </div>
    <div class="market-review-row">
      <span>Predictions</span>
      <strong>${outcomes.map(escapeHtml).join(" / ")}</strong>
    </div>
    <div class="market-review-row">
      <span>Maturity</span>
      <strong>${escapeHtml(closeLabel)}</strong>
    </div>
    <div class="market-review-row">
      <span>Verification</span>
      <strong>${marketOracleLabel(oracle)}</strong>
    </div>
    <div class="market-review-row">
      <span>Starting bankroll</span>
      <strong>${money(DEFAULT_BALANCE)} per member</strong>
    </div>
    <div class="market-review-row">
      <span>Starting liquidity</span>
      <strong>${money(DEFAULT_MARKET_LIQUIDITY)} virtual pool</strong>
    </div>
    <div class="market-review-row">
      <span>Image</span>
      <strong>${state.marketImageDataUrl ? `Custom upload${state.marketImageName ? `: ${escapeHtml(state.marketImageName)}` : ""}` : "Stock football image"}</strong>
    </div>
    <div class="market-review-description">
      <span>Description</span>
      <div class="market-review-description-box">${escapeHtml(description || "No description added yet.")}</div>
    </div>
  `;
}

async function goMarketFormStep(step) {
  const nextStep = Math.max(1, Math.min(4, Number(step) || 1));
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
  if (nextStep === 4) updateMarketReview();
  state.marketFormStep = nextStep;
  updateMarketFormStep();
}

function updateMarketFormStep() {
  const step = Math.max(1, Math.min(4, state.marketFormStep || 1));
  state.marketFormStep = step;
  const stepLabels = ["Basics", "Description", "Image", "Review"];
  dom.marketForm.querySelectorAll("[data-market-form-step]").forEach(panel => {
    panel.classList.toggle("hidden", panel.dataset.marketFormStep !== String(step));
  });
  const progressFill = dom.marketForm.querySelector("[data-market-progress-fill]");
  const stepLabel = dom.marketForm.querySelector("[data-market-step-label]");
  const stepCount = dom.marketForm.querySelector("[data-market-step-count]");
  if (progressFill) progressFill.style.width = `${(step / 4) * 100}%`;
  if (stepLabel) stepLabel.textContent = stepLabels[step - 1] || "Basics";
  if (stepCount) stepCount.textContent = `Step ${step} of 4`;
  updateOutcomePreviews();
  updateMarketImagePreview();
  if (step === 4) updateMarketReview();
  dom.marketForm.querySelector("[data-market-step-back]")?.classList.toggle("hidden", step === 1);
  dom.marketForm.querySelector("[data-market-step-next]")?.classList.toggle("hidden", step === 4);
  dom.marketForm.querySelector("[data-market-submit]")?.classList.toggle("hidden", step !== 4);
}

function setMarketType(type) {
  const normalized = type === "multi" ? "multi" : "binary";
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
    })
    .slice(0, 8);
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
  return `${shareBaseUrl()}/market/${encodeURIComponent(marketId)}`;
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
      text: `Join ${invite.groupName} and trade your World Cup takes.`,
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
          <h3>Market link with chart preview</h3>
          <p class="muted">Best for WhatsApp, iMessage, X, and anywhere that unfurls Open Graph cards.</p>
          <div class="invite-link-box">
            <span>${esc(link)}</span>
            <button type="button" data-copy-market-link>Copy</button>
          </div>
          <div class="share-action-grid">
            ${navigator.share ? `<button class="btn btn-primary" type="button" data-native-share-market>Share link</button>` : ""}
            <button class="btn btn-ghost" type="button" data-copy-market-link>Copy link</button>
            <button class="btn btn-ghost" type="button" data-whatsapp-market>WhatsApp</button>
          </div>
        </div>

      </div>
    </div>`;
}

async function nativeShareMarket() {
  const market = findMarket(state.embedModal.marketId);
  if (!market || !navigator.share) return;
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

async function copyMarketLink() {
  const market = findMarket(state.embedModal.marketId);
  if (!market) return;
  const link = marketUrl(market.id);
  try {
    await navigator.clipboard.writeText(link);
    toast("Market link copied.");
  } catch {
    toast(link);
  }
}

function openWhatsAppShare() {
  const market = findMarket(state.embedModal.marketId);
  if (!market) return;
  const text = `${marketShareText(market)} ${marketUrl(market.id)}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
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
  try {
    const data = await api(`/api/invites/${encodeURIComponent(token)}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setGroups(data.groups);
    state.currentGroupId = data.groupId;
    state.activeMember = data.memberName || name;
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
      body: JSON.stringify({ name, emoji, members, mode: "fake" }),
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
    state.activeMember = reusableGroup.members?.includes(member) ? member : reusableGroup.members?.[0] ?? member;
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
    if (saved) return saved;
  }
  return state.groups.find(isPbMyMarketsGroup) ?? state.groups[0] ?? null;
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
}

async function joinGroup(groupId, myName) {
  const existing = state.groups.find(g => g.id === groupId);
  if (existing?.members.includes(myName)) {
    state.currentGroupId = groupId;
    state.activeMember = myName;
    state.shell = "app";
    state.view = "dashboard";
    localStorage.setItem("probable_user", myName);
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
    state.activeMember = myName;
    state.shell = "app";
    state.view = "dashboard";
    localStorage.setItem("probable_user", myName);
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
  if (state.marketFormStep !== 4) {
    await goMarketFormStep(state.marketFormStep + 1);
    return;
  }
  const form = e.currentTarget;
  const fd = new FormData(form);
  const basePayload = marketPayloadFromForm(fd);
  if (!basePayload) return;
  if (!requireLogin("create-market")) return;
  const submit = form.querySelector("[data-market-submit]");
  const payload = {
    ...basePayload,
    category: fd.get("category")?.toString().trim() || "General",
    initialProbability: Number(fd.get("initialProb") || 50) / 100,
    initialLiquidity: Number(fd.get("liquidity") || DEFAULT_MARKET_LIQUIDITY),
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
      }),
    });
    setGroups(data.groups);
    delete state.oracleErrors[market.id];
    normalizeSelection();
    render();
    toastSettlement(data.settlement, `Resolved ${resolutionOutcomeLabel(market, outcome)}.`);
  } catch (err) {
    toast(err.message || "Resolve failed.");
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
  const waitingForInitialAppData = state.shell === "app" && !state.loaded && (state.currentGroupId || isLoggedIn() || state.sharedMarketId || shouldHoldAppShell());
  if (state.shell === "app" && !getCurrentGroup() && !waitingForInitialAppData) {
    enterWelcomeShell();
  }
  renderNav();
  persistNavigationState();
  if (state.shell === "embed") {
    renderEmbedRoute();
  } else if (state.shell === "app" && !state.loaded && !getCurrentGroup()) {
    renderMarketLinkLoading();
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
  } else {
    renderDashboard();
  }
  requestAnimationFrame(() => {
    renderCharts();
    animateIn();
  });
}

function renderNav() {
  document.querySelector("#topnav").style.display = state.shell === "embed" ? "none" : "";
  const navGroups = visibleNavGroups();
  const inApp = state.shell === "app";
  const hasGroups = inApp && isLoggedIn() && navGroups.length > 0;
  dom.navSep.style.display = hasGroups ? "" : "none";
  dom.groupTabs.innerHTML = hasGroups
    ? `<button class="group-add-btn" type="button" data-group-id="__new" aria-label="Create group">+</button>` + navGroups.map(g => `<button class="group-tab ${g.id === getCurrentGroup()?.id && state.view === "dashboard" ? "active" : ""}" type="button" data-group-id="${g.id}">${esc(g.emoji)} ${esc(g.name)}</button>`).join("")
    : "";

  const group = inApp ? getCurrentGroup() : null;
  const displayName = authDisplayName() || state.activeMember || "User";
  const balance = group?.balances?.[state.activeMember] ?? 0;

  dom.navRight.innerHTML = group ? `
    <div class="member-pill" title="${esc(displayName)}">
      <span class="member-name">${esc(displayName)}</span>
      <span class="member-balance">${money(balance)}</span>
    </div>
    ${accountIndicatorHtml()}
  ` : `
    <button class="btn btn-primary btn-sm nav-enter" type="button" data-enter-app>Enter app</button>
    ${accountIndicatorHtml()}
  `;
}

function visibleNavGroups() {
  if (state.shell !== "app" || !isLoggedIn()) return [];
  const activeId = state.currentGroupId;
  const byLabel = new Map();
  state.groups.forEach(group => {
    const key = `${String(group.emoji || "").trim().toLowerCase()}::${String(group.name || "").trim().toLowerCase()}`;
    const current = byLabel.get(key);
    if (!current || group.id === activeId) byLabel.set(key, group);
  });
  return [...byLabel.values()];
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

  const open = markets.filter(m => m.status === "open").length;
  const closed = markets.filter(m => m.status === "closed" || m.status === "resolved").length;
  const visibleMarkets = dashboardVisibleMarkets(markets);
  const events = sortedMarketEvents(visibleMarkets);
  const activeStatus = state.marketStatus === "closed" ? "closed" : "open";

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
          ${visibleMarkets.length ? `<div class="market-grid" data-market-grid>${events.map(event => eventCard(event)).join("")}</div>` : emptyMarketsHtml(activeStatus)}
        </section>

        <aside class="side-panel motion-item">
          ${leaderboardPanel(group, { limit: compactLeaderboardLimit(), compact: true })}
        </aside>
      </div>
    </section>
  `;
}

function renderFocusedTradeView(group, market, event) {
  const eventTitle = event?.title || sampleEventTitle(market);
  const tradeMarket = market;
  const prob = Number(tradeMarket.probability ?? 0.5);
  const yesPrice = prob.toFixed(2);
  const noPrice = (1 - prob).toFixed(2);
  const sortedMarkets = event?.markets?.length ? event.markets : [market];
  const leadingMarkets = sortedMarkets.slice(0, 4);
  dom.mainContent.innerHTML = `
    <section class="dashboard-shell focused-market-shell">
      <div class="focused-market-nav motion-item">
        <button class="focused-back" type="button" data-close-trade>&larr; Back to markets</button>
        <div class="focused-market-nav-actions">
          <p>${esc(group.emoji)} ${esc(group.name)}</p>
          ${import.meta.env.DEV && market.status === "open" && !isSampleMarket(market) ? `<button class="btn btn-ghost btn-sm dev-risky-btn" type="button" data-simulate-market="${esc(market.id)}">Simulate traders</button>` : ""}
          <button class="icon-btn market-page-share" type="button" data-share-market="${esc(market.id)}" aria-label="Share market">
            ${shareIconSvg()}
          </button>
        </div>
      </div>

      <div class="focused-market-stage motion-item">
        <section class="focused-event-board" data-event-chart="${esc(event.key)}">
          <div class="focused-event-head">
            <div class="event-thumb ${eventThumbClass(eventTitle, event.imageUrl)} focused-event-thumb" aria-hidden="true">${eventThumb(eventTitle, event.imageUrl)}</div>
            <div>
              <p class="focused-event-kicker">Sports · Soccer</p>
              <h1>${esc(eventTitle)}</h1>
            </div>
          </div>

          <div class="focused-event-legend" aria-label="Top outcomes">
            ${leadingMarkets.map((item, index) => focusedLegendItem(item, index, event)).join("")}
          </div>

          <span class="focused-chart-watermark">probable</span>
          <div class="focused-chart-shell">
            <canvas data-event-chart-canvas="${esc(event.key)}" aria-label="${esc(eventTitle)} probability history"></canvas>
          </div>

          <div class="focused-chart-meta">
            <span>${compactMoney(event.volume)} Vol.</span>
            <span>${fmtClose({ closesAt: event.closesAt, status: eventStatus(event) })}</span>
            <span class="focused-range active">ALL</span>
          </div>

          <div class="focused-outcome-table">
            ${sortedMarkets.map((item, index) => focusedOutcomeRow(item, tradeMarket.id, index, event)).join("")}
          </div>

          ${verificationPanel(tradeMarket, event)}
          ${marketParticipants(tradeMarket, event)}
        </section>

        ${tradeMarket.status === "open" ? tradePanel(tradeMarket, yesPrice, noPrice, event) : `
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
      ${esc(marketOptionTitle(market))} <strong>${pct}%</strong>
    </span>`;
}

function focusedOutcomeRow(market, activeMarketId, index, event) {
  const yesPct = Math.round(displayedEventProbability(market, event));
  const option = marketOptionTitle(market);
  const tradeTarget = tradeTargetForOutcome(market, event);
  const active = tradeTarget.marketId === activeMarketId;
  const binary = isBinaryEvent(event);
  const yesButtonMarket = binary ? binaryMarketForSide(event, "yes") : market;
  const noButtonMarket = binary ? binaryMarketForSide(event, "no") : market;
  const yesButtonPct = Math.round(displayedEventProbability(yesButtonMarket || market, event));
  const noButtonPct = binary
    ? Math.round(displayedEventProbability(noButtonMarket || market, event))
    : 100 - yesButtonPct;
  return `
    <div class="focused-outcome-row ${active ? "active" : ""}" data-market-id="${tradeTarget.marketId}">
      <div class="focused-outcome-name">
        <i style="--series-color:${chartColorForMarket(market, index, event)}"></i>
        <span>${esc(option)}</span>
      </div>
      <strong>${yesPct}%</strong>
      ${market.status === "open" ? `
        <div class="event-trade-actions">
          <button class="event-side yes" type="button" data-buy="yes" aria-label="Buy ${option} Yes at ${yesButtonPct} cents"><span>Yes</span><em>${yesButtonPct}¢</em></button>
          <button class="event-side no" type="button" data-buy="no" aria-label="Buy ${option} No at ${noButtonPct} cents"><span>No</span><em>${noButtonPct}¢</em></button>
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
    </div>`;
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
          <video src="/media/welcome-1.mp4" autoplay muted loop playsinline preload="metadata"></video>
        </figure>
        <figure class="welcome-video-tile tile-b">
          <video src="/media/welcome-2.mp4" autoplay muted loop playsinline preload="metadata"></video>
        </figure>
        <figure class="welcome-video-tile tile-c">
          <video src="/media/welcome-3.mp4" autoplay muted loop playsinline preload="metadata"></video>
        </figure>
        <figure class="welcome-video-tile tile-d">
          <video src="/media/welcome-4.mp4" autoplay muted loop playsinline preload="metadata"></video>
        </figure>
        <figure class="welcome-video-tile tile-e">
          <video src="/media/welcome-5.mp4" autoplay muted loop playsinline preload="metadata"></video>
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
    markets: event.markets.sort((a, b) => Number(b.probability ?? 0) - Number(a.probability ?? 0)),
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
          <span>${compactMoney(event.volume)} Vol.</span>
          <span class="event-card-creator">by ${esc(eventCreatorLabel(event))}</span>
        </div>
      </div>
      ${activeTrade}
    </article>`;
}

function eventCreatorLabel(event) {
  return event?.creator || getCurrentGroup()?.members?.[0] || "unknown";
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
  const binary = isBinaryEvent(event);
  const yesButtonMarket = binary ? binaryMarketForSide(event, "yes") : market;
  const noButtonMarket = binary ? binaryMarketForSide(event, "no") : market;
  const yesButtonPct = Math.round(displayedEventProbability(yesButtonMarket || market, event));
  const noButtonPct = binary
    ? Math.round(displayedEventProbability(noButtonMarket || market, event))
    : 100 - yesButtonPct;
  return `
    <div class="event-outcome-row" data-market-id="${tradeTarget.marketId}">
      <div class="event-outcome-main">
        <span class="event-outcome-name">${esc(option)}</span>
        <strong>${yesPct}%</strong>
      </div>
      ${market.status === "open" ? `
        <div class="event-trade-actions">
          <button class="event-side yes" type="button" data-buy="yes" aria-label="Buy ${option} Yes at ${yesButtonPct} cents"><span>Yes</span><em>${yesButtonPct}¢</em></button>
          <button class="event-side no" type="button" data-buy="no" aria-label="Buy ${option} No at ${noButtonPct} cents"><span>No</span><em>${noButtonPct}¢</em></button>
        </div>` : statusBadge(market)}
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
  const side = state.trade.side || "yes";
  const mode = state.trade.mode || "buy";
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const eventTitle = sampleEventTitle(market);
  const binary = isBinaryEvent(event);
  const selectedLabel = marketOptionTitle(market);
  const opposite = binary ? event.markets.find(item => item.id !== market.id) : null;
  const yesOutcome = binaryOutcomeForSide(market, "yes");
  const noOutcome = binaryOutcomeForSide(market, "no");
  const yesMarket = binaryMarketForSide(event, "yes");
  const noMarket = binaryMarketForSide(event, "no");
  const yesLabel = binary ? (yesOutcome?.title || (yesMarket ? marketOptionTitle(yesMarket) : "Yes")) : selectedLabel;
  const noLabel = binary ? (noOutcome?.title || (noMarket ? marketOptionTitle(noMarket) : "No")) : "No";
  const yesTradePrice = binary ? Number(yesOutcome?.price ?? yesMarket?.probability ?? yesPrice) : Number(yesPrice);
  const noTradePrice = binary ? Number(noOutcome?.price ?? noMarket?.probability ?? noPrice) : Math.max(0, 1 - Number(yesPrice));
  const activeLabel = binary
    ? (side === "no" ? noLabel : yesLabel)
    : `${selectedLabel} · ${side === "no" ? "No" : "Yes"}`;
  const sellState = tradeSellState(market, side);
  const tradePending = state.pendingUi.tradeMarketId === market.id;
  const sellDisabled = !sellState.anyHeld;
  const activeSellDisabled = mode === "sell" && !sellState.canSellSelected;
  const showMissingSideCopy = mode === "sell" && sellState.anyHeld && sellState.shares <= 0.000001;
  const sellMode = mode === "sell";
  const max = Math.max(0, sellMode ? sellState.shares : Math.floor(balance || DEFAULT_BALANCE));
  const inputDisabled = activeSellDisabled || tradePending ? "disabled" : "";
  const submitDisabled = activeSellDisabled || tradePending ? "disabled" : "";
  const yesSellDisabled = tradePending || (mode === "sell" && !tradeSellState(market, "yes").canSellSelected);
  const noSellDisabled = tradePending || (mode === "sell" && !tradeSellState(market, "no").canSellSelected);
  const submitText = `${mode === "sell" ? "Sell" : "Buy"} ${side.toUpperCase()}`;
  const submitContent = tradePending
    ? `<span class="button-spinner" aria-hidden="true"></span><span>${mode === "sell" ? "Selling" : "Buying"}</span>`
    : submitText;
  return `
    <div class="trade-panel" data-market-id="${market.id}">
      <div class="trade-panel-context ${side === "yes" ? "yes" : "no"}">
        <div class="trade-context-thumb ${eventThumbClass(eventTitle, event?.imageUrl || market.imageUrl)}" aria-hidden="true">${eventThumb(eventTitle, event?.imageUrl || market.imageUrl)}</div>
        <div>
          <span>${esc(eventTitle)}</span>
          <strong><em data-trade-side-label>${esc(activeLabel)}</em></strong>
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
        <button class="trade-pick ${side === "yes" ? "yes active" : "yes"} ${yesSellDisabled ? "disabled" : ""}" type="button" data-buy="yes" ${yesSellDisabled ? "disabled" : ""}><span>${esc(yesLabel)}</span> <strong>${(yesTradePrice * 100).toFixed(0)}¢</strong></button>
        <button class="trade-pick ${side === "no" ? "no active" : "no"} ${noSellDisabled ? "disabled" : ""}" type="button" data-buy="no" ${noSellDisabled ? "disabled" : ""}><span>${esc(noLabel)}</span> <strong>${(noTradePrice * 100).toFixed(0)}¢</strong></button>
      </div>
      <form class="trade-form-el">
        <div class="trade-amount-row">
          <label class="trade-amount-label"><span data-trade-input-label>${sellMode ? "Shares" : "Amount"}</span> <span data-trade-limit-copy>${sellMode ? sellLimitCopy(sellState) : `${money(balance)} cash`}</span></label>
          <div class="trade-input-row ${sellMode ? "sell" : "buy"}">
            ${sellMode ? "" : `<span class="trade-suffix">$</span>`}
            <input class="trade-input" type="number" min="${sellMode ? "0.01" : "1"}" ${sellMode ? "" : `max="${max}"`} data-raw-max="${formatShareInput(max)}" step="any" placeholder="0" inputmode="decimal" ${inputDisabled} />
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

function resolutionOutcomeLabel(market, outcome) {
  const raw = String(outcome || "").trim();
  const found = resolutionOutcomes(market).find(item => item.id === raw || String(item.title).toLowerCase() === raw.toLowerCase());
  return found?.title || raw || "Unknown";
}

function resolutionOutcomeClass(market, outcome, index = 0) {
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
  if (!amount || amount <= 0) {
    return "";
  }
  if (mode === "sell") {
    const preview = sellPreviewForShares(market, outcomeId, amount, side);
    updateTradeSubmitState(market, preview, amount);
    const shares = Math.min(Math.max(0, amount), preview.held || 0);
    const avgPrice = shares > 0 ? preview.cashAmount / shares : price;
    const guidance = liquidityGuidance(market, preview.cashAmount, price, avgPrice, preview);
    const pl = sellProfitLossEstimate(market, outcomeId, shares, avgPrice, side);
    return `
      <div class="trade-payout-label">
        <span>You'll receive 💸</span>
        <small>${esc(outcome?.title || marketOptionTitle(market))} · Avg. Price ${(avgPrice * 100).toFixed(1)}¢</small>
      </div>
      <strong class="trade-payout-value">${money(preview.cashAmount)}</strong>
      ${pl ? `<div class="trade-pl-note ${pl.percent >= 0 ? "gain" : "loss"}">${pl.percent >= 0 ? "+" : ""}${pl.percent.toFixed(1)}%</div>` : ""}
      ${marketFeeNote(sellGrossCashForNet(preview.cashAmount))}
      <div class="trade-liquidity-note ${guidance.level}">
        ${guidance.text}
      </div>`;
  }
  const preview = isComplementNoTrade(market, side)
    ? complementBuyPreview(market, outcomeId, amount)
    : lmsrPreview(market, outcomeId, mode, amount);
  updateTradeSubmitState(market, preview, amount);
  const shares = Math.abs(preview.shares || 0);
  const avgPrice = shares > 0 ? amount / shares : price;
  const payout = mode === "sell" ? amount : shares;
  const guidance = liquidityGuidance(market, amount, price, avgPrice, preview);
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  const insufficientBalance = amount > balance;
  return `
    <div class="trade-payout-label">
      <span>${mode === "sell" ? "You receive" : "To win 💸"}</span>
      <small>${esc(outcome?.title || marketOptionTitle(market))} · Avg. Price ${(avgPrice * 100).toFixed(1)}¢</small>
    </div>
    <strong class="trade-payout-value">${money(payout)}</strong>
    ${!insufficientBalance ? marketFeeNote(amount) : ""}
    ${insufficientBalance ? `<div class="trade-liquidity-note warn">Not enough funds. You have ${money(balance)}.</div>` : `
      <div class="trade-liquidity-note ${guidance.level}">
        ${guidance.text}
      </div>`}`;
}

function tradeOutcomeId(market, side = "yes") {
  const absoluteBinaryOutcome = binaryOutcomeForSide(market, side);
  if (absoluteBinaryOutcome) {
    return absoluteBinaryOutcome.id;
  }
  if (side === "no" && (market.outcomes?.length || 0) === 2) {
    return market.outcomes.find(item => item.id !== market.outcomeId)?.id || market.outcomeId || market.id;
  }
  return market.outcomeId || market.id;
}

function isComplementNoTrade(market, side = state.trade.side || "yes") {
  return side === "no" && (market.outcomes?.length || 0) > 2;
}

function complementOutcomes(market, outcomeId = tradeOutcomeId(market, "yes")) {
  return (market.outcomes || []).filter(outcome => outcome.id !== outcomeId);
}

function complementShareState(market, outcomeId = tradeOutcomeId(market, "yes")) {
  const outcomes = complementOutcomes(market, outcomeId);
  const shares = outcomes.reduce((sum, outcome) => sum + currentSharesForOutcome(market, outcome.id), 0);
  const maxCash = outcomes.reduce((sum, outcome) => {
    const held = currentSharesForOutcome(market, outcome.id);
    return sum + lmsrSellValueForShares(market, outcome.id, held);
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
  const outcomes = market.outcomes?.length ? market.outcomes : [{ id: market.outcomeId || market.id, price: market.probability, quantity: 0 }];
  const b = Number(market.initialLiquidity || market.liquidity || DEFAULT_MARKET_LIQUIDITY);
  const target = outcomes.find(item => item.id === outcomeId) || outcomes[0];
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

function complementBuyPreview(market, outcomeId, amount) {
  const complement = complementOutcomes(market, outcomeId);
  const weightTotal = complement.reduce((sum, outcome) => sum + Math.max(0.000001, Number(outcome.price || 0)), 0) || complement.length || 1;
  const allocations = complement.map(outcome => ({
    outcomeId: outcome.id,
    amount: amount * (Math.max(0.000001, Number(outcome.price || 0)) / weightTotal),
  }));
  const shares = allocations.reduce((sum, allocation) => {
    return sum + Math.max(0, lmsrPreview(market, allocation.outcomeId, "buy", allocation.amount).shares || 0);
  }, 0);
  return {
    shares,
    maxCash: 0,
    held: complementShareState(market, outcomeId).shares,
    oversell: false,
    allocations,
  };
}

function sellPreviewForShares(market, outcomeId, shares, side = state.trade.side || "yes") {
  if (isComplementNoTrade(market, side)) {
    const basket = complementShareState(market, outcomeId);
    const requestedShares = Math.max(0, Number(shares || 0));
    const safeShares = Math.min(requestedShares, basket.shares);
    const fraction = basket.shares > 0 ? safeShares / basket.shares : 0;
    const cashAmount = basket.maxCash * fraction;
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
  const panel = [...document.querySelectorAll(".trade-panel")]
    .find(item => item.dataset.marketId === market.id);
  if (!panel) return;
  const submit = panel.querySelector(".trade-submit");
  const input = panel.querySelector(".trade-input");
  const mode = state.trade.mode || "buy";
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? 0;
  if (state.pendingUi.tradeMarketId === market.id) {
    if (submit) {
      submit.disabled = true;
      submit.classList.add("disabled", "is-loading");
    }
    return;
  }
  const insufficientBalance = mode === "buy" && Number(amount || 0) > balance;
  const shouldDisable = insufficientBalance || (mode === "sell" && (!preview.held || preview.held <= 0 || preview.oversell || !amount || amount > preview.held + 0.000001));
  if (submit) {
    submit.disabled = shouldDisable;
    submit.classList.toggle("disabled", shouldDisable);
  }
  if (input && mode === "sell" && preview.held > 0) input.dataset.rawMax = formatShareInput(preview.held);
}

function liquidityGuidance(market, amount, spotPrice, avgPrice, preview = {}) {
  const liquidity = Number(market.liquidity ?? 0);
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
  if (priceImpact > 0.35 || liquidityUse > 0.85) {
    return { level: "warn", text: `Thin liquidity: ${(priceImpact * 100).toFixed(1)}% price impact. Max comfortable ${money(maxComfort)}.` };
  }
  if (priceImpact > 0.18 || liquidityUse > 0.55 || balanceLimitPct > 0.5) {
    return { level: "caution", text: `Large fake-money order: ${(priceImpact * 100).toFixed(1)}% price impact.` };
  }
  return { level: "ok", text: `Healthy size: ${(priceImpact * 100).toFixed(1)}% price impact.` };
}

function setTradeSide(marketId, side) {
  if (state.pendingUi.tradeMarketId === marketId) return;
  const market = findMarket(marketId);
  if (!market) return;
  if ((state.trade.mode || "buy") === "sell" && !tradeSellState(market, side).canSellSelected) return;
  state.trade = { marketId, side, mode: state.trade.mode || "buy" };
  const panel = [...document.querySelectorAll(".trade-panel")]
    .find(item => item.dataset.marketId === marketId);
  if (!panel) return;

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
    ? `${marketOptionTitle(market)} · ${side === "no" ? "No" : "Yes"}`
    : (activePick?.textContent || (side === "yes" ? "Yes" : "No"));
  const context = panel.querySelector(".trade-panel-context");
  context?.classList.toggle("yes", side === "yes");
  context?.classList.toggle("no", side === "no");

  const amountInput = panel.querySelector(".trade-input");
  renderTradePreview(market, parseFloat(amountInput?.value) || 0);
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
  const panel = [...document.querySelectorAll(".trade-panel")]
    .find(item => item.dataset.marketId === marketId);
  if (!panel) return;
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
    ? `${marketOptionTitle(market)} · ${nextSide === "no" ? "No" : "Yes"}`
    : (activePick?.textContent || (nextSide === "yes" ? "Yes" : "No"));
  const context = panel.querySelector(".trade-panel-context");
  context?.classList.toggle("yes", nextSide === "yes");
  context?.classList.toggle("no", nextSide === "no");
  renderTradePreview(market, parseFloat(amountInput?.value) || 0);
  updateRenderedTradeSellControls(market);
}

function updateRenderedTradeSellControls(market) {
  const panel = [...document.querySelectorAll(".trade-panel")]
    .find(item => item.dataset.marketId === market.id);
  if (!panel) return;
  const mode = state.trade.mode || "buy";
  const sellState = tradeSellState(market, state.trade.side || "yes");
  const input = panel.querySelector(".trade-input");
  const inputRow = panel.querySelector(".trade-input-row");
  const inputLabel = panel.querySelector("[data-trade-input-label]");
  const submit = panel.querySelector(".trade-submit");
  const limitCopy = panel.querySelector("[data-trade-limit-copy]");
  const chipRow = panel.querySelector(".trade-chip-row");
  const balance = getCurrentGroup()?.balances?.[state.activeMember] ?? DEFAULT_BALANCE;
  const max = Math.max(0, mode === "sell" ? sellState.shares : Math.floor(balance));
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
          <p>${state.leaderboardMetric === "percent" ? "Ranked by return on money actually put into trades." : `Ranked by nominal gain from ${money(DEFAULT_BALANCE)} starting cash.`}</p>
        </div>
        <div class="leaderboard-controls probable-leaderboard-controls">
          ${leaderboardMetricToggle()}
          <button class="btn btn-ghost btn-sm" type="button" data-go-dashboard>Back</button>
        </div>
      </div>
      ${expandedLeaderboard(entries)}
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
          <h1>Resolve closed markets</h1>
          <p>Use this when you want to manually settle markets at close. Pick the winning outcome, optionally add reasoning, and payouts run immediately.</p>
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
        .filter(event => eventStatus(event) === "closed")
        .sort((a, b) => eventTime(a.closesAt) - eventTime(b.closesAt));
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
  const source = market.resolutionSource || event.resolutionSource || "";
  const edgeCases = market.edgeCases || event.edgeCases || "";
  const rules = market.description || event.description || "No resolution rules saved.";
  const pending = state.pendingUi.resolveMarketId === market.id;
  return `
    <article class="admin-resolve-card" data-market-id="${esc(market.id)}">
      <div class="admin-card-main">
        <div class="admin-card-title-row">
          <div class="event-thumb ${eventThumbClass(event.title, event.imageUrl)} admin-card-thumb" aria-hidden="true">${eventThumb(event.title, event.imageUrl)}</div>
          <div>
            <p class="admin-card-kicker">${esc(group.name)} · ${fmtClose({ closesAt: event.closesAt, status: "closed" })}</p>
            <h3>${esc(event.title)}</h3>
          </div>
        </div>
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
          ${outcomes.map((outcome, index) => {
            const cls = resolutionOutcomeClass(market, outcome.id, index);
            return `<button class="admin-outcome-btn ${cls}" type="button" data-resolve="${esc(outcome.id)}" ${pending ? "disabled" : ""}>${esc(outcome.title)}</button>`;
          }).join("")}
        </div>
      </div>
    </article>`;
}

function adminEmptyHtml() {
  return `
    <div class="admin-empty motion-item">
      <p class="eyebrow">All clear</p>
      <h2>No closed markets need verification.</h2>
      <p>When a market closes, it will appear here until you pick the winning outcome.</p>
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
  const status = state.positionsStatus === "closed" ? "closed" : "open";
  const grouped = state.groups
    .map(group => ({
      group,
      open: positionRowsForGroup(group, "open"),
      closed: positionRowsForGroup(group, "closed"),
    }))
    .filter(item => item.open.length || item.closed.length);
  const openCount = grouped.reduce((sum, item) => sum + item.open.length, 0);
  const closedCount = grouped.reduce((sum, item) => sum + item.closed.length, 0);
  const visibleGroups = grouped
    .map(item => ({ group: item.group, rows: status === "closed" ? item.closed : item.open }))
    .filter(item => item.rows.length);

  dom.mainContent.innerHTML = `
    <section class="positions-page">
      <div class="positions-head motion-item">
        <div>
          <p class="eyebrow">Account</p>
          <h1>My Portfolio</h1>
          <p>Your open exposure, cash-out value, and settled history, grouped by group.</p>
        </div>
        <div class="positions-actions">
          <div class="group-counts">
            <button class="group-count group-count-open ${status === "open" ? "active" : ""}" type="button" data-position-status-filter="open">${openCount} open</button>
            <button class="group-count group-count-closed ${status === "closed" ? "active" : ""}" type="button" data-position-status-filter="closed">${closedCount} closed</button>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-go-dashboard>Back</button>
        </div>
      </div>
      ${visibleGroups.length ? `
        <div class="positions-groups">
          ${visibleGroups.map(({ group, rows }) => positionGroupHtml(group, rows, status)).join("")}
        </div>
      ` : positionsEmptyHtml(status)}
    </section>`;
}

function positionGroupHtml(group, rows, status) {
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  return `
    <section class="position-group-card motion-item">
      <div class="position-group-head">
        <div>
          <p class="eyebrow">${esc(group.emoji)} ${status === "closed" ? "Closed" : "Open"} portfolio</p>
          <h2>${esc(group.name)}</h2>
        </div>
        <strong>${money(totalValue)}</strong>
      </div>
      <div class="position-list">
        ${rows.map(positionRowHtml).join("")}
      </div>
    </section>`;
}

function positionRowHtml(row) {
  return `
    <button class="position-row" type="button" data-buy="yes" data-market-id="${esc(row.marketId)}">
      <div class="position-market">
        <span class="position-status ${row.status === "open" ? "open" : "closed"}">${esc(row.statusLabel)}</span>
        <strong>${esc(row.title)}</strong>
        <em>${esc(row.closeLabel)}</em>
        ${row.statusLabel === "Resolved" ? `<small class="position-settlement-note">Winner: ${esc(row.winnerTitle || "Unknown")}${row.resolvedBy ? ` · ${esc(row.resolvedBy)}` : ""}${row.resolutionNotes ? ` · ${esc(row.resolutionNotes)}` : ""}</small>` : ""}
      </div>
      <div class="position-outcome">
        <span>${esc(row.outcomeTitle)}</span>
        <em>${formatShares(row.shares)} shares</em>
      </div>
      <div class="position-price">
        <span>${Math.round(row.price * 100)}¢</span>
        <em>${row.status === "open" ? "price" : "final/marked"}</em>
      </div>
      <div class="position-value">
        <strong>${money(row.value)}</strong>
        <em>${row.status === "open" ? "cash out" : row.statusLabel === "Resolved" ? (row.isWinner ? "paid out" : "lost") : "marked"}</em>
      </div>
    </button>`;
}

function positionsEmptyHtml(status) {
  return `
    <div class="positions-empty motion-item">
      <p class="eyebrow">${status === "closed" ? "Closed portfolio" : "Open portfolio"}</p>
      <h2>${status === "closed" ? "No closed portfolio history yet." : "No open portfolio positions yet."}</h2>
      <p>${status === "closed" ? "Settled or closed markets you held will appear here." : "Buy a contract in any group and it will show up here."}</p>
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
      for (const outcome of market.outcomes) {
        const shares = Number(positions[outcome.id] || 0);
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

function positionRowFromOutcome(market, outcome, shares) {
  const status = market.status === "open" ? "open" : "closed";
  const price = Number(outcome.price || 0);
  const resolvedOutcome = market.outcome;
  const value = market.status === "resolved"
    ? (resolvedOutcome === outcome.id ? shares : 0)
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
    isWinner: market.status === "resolved" && resolvedOutcome === outcome.id,
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
  const candidates = [
    state.activeMember,
    authDisplayName(),
    state.authUser?.email,
    localStorage.getItem(STORAGE_KEYS.user),
  ].filter(Boolean).map(value => String(value).trim());
  const exact = candidates.find(candidate => group.members?.includes(candidate));
  if (exact) return exact;
  const lowerCandidates = new Set(candidates.map(value => value.toLowerCase()));
  return (group.members ?? []).find(member => lowerCandidates.has(String(member).toLowerCase())) || "";
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
  if (input.dataset.rawAmount) return parseFloat(input.dataset.rawAmount);
  return parseFloat(input.value);
}

function spawnPriceTick(amount, positive) {
  const layer = document.querySelector("#priceTickLayer");
  const chartShell = document.querySelector(".focused-chart-shell");
  if (!layer || !chartShell) return;
  const rect = chartShell.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const el = document.createElement("span");
  el.className = `price-tick ${positive ? "price-tick-up" : "price-tick-down"}`;
  el.textContent = `${positive ? "+" : "-"}$${Math.max(1, Math.round(amount))}`;
  el.style.left = `${rect.left + rect.width * (0.06 + Math.random() * 0.1)}px`;
  el.style.top = `${rect.bottom - 28}px`;
  el.style.setProperty("--tick-x", `${20 + Math.random() * 24}px`);
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1700);
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
          outcomeTitle: trade.outcomeTitle || marketOptionTitleForOutcome(market, trade.outcomeId),
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
  const progress = Math.max(4, Math.min(100, Math.round((entry.bal / Math.max(DEFAULT_BALANCE, entry.bal + Math.abs(entry.pnl))) * 100)));
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
      <em>${money(DEFAULT_BALANCE)} start</em>
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
    const cash = Number(group.balances?.[name] ?? DEFAULT_BALANCE);
    const trades = (group.markets ?? []).flatMap(market =>
      (market.trades ?? [])
        .filter(t => t.participant === name)
        .map(trade => ({ ...trade, market }))
    );
    const volume = trades.reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);
    const deployed = trades.reduce((sum, t) => sum + (isBuyTrade(t) ? Math.abs(Number(t.amount || 0)) : 0), 0);
    const markValue = currentMarkValue(group, name);
    const cashOutValue = currentPositionValue(group, name);
    const positionValue = markValue;
    const bal = cash + markValue;
    const cashOutPortfolio = cash + cashOutValue;
    const pnl = bal - DEFAULT_BALANCE;
    return {
      name,
      cash,
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

function renderCharts() {
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

  const histories = event.markets.map(market => displayMarketHistory(market, event));
  const times = [...new Set(histories.flat().map(point => point.time))]
    .sort((a, b) => a - b);
  const chartTimes = times.length ? times : [Date.now()];
  const values = [];
  const datasets = event.markets.map((market, index) => {
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
  return (market.trades ?? []).some(trade => Math.abs(Number(trade.amount || 0)) > 0);
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

function setGroups(groups) {
  state.groups = withSampleDashboard(groups ?? []);
}

function withSampleDashboard(groups) {
  return groups.map(group => isPbMyMarketsGroup(group) ? hydrateSampleGroup(group) : group);
}

function isPbMyMarketsGroup(group) {
  const name = String(group?.name || "").toLowerCase();
  const emoji = String(group?.emoji || "").toLowerCase();
  return name.includes("my markets") && emoji === "pb";
}

function hydrateSampleGroup(group) {
  const existingMarkets = group.markets ?? [];
  if (existingMarkets.some(market => isSampleMarket(market))) return group;
  const demoMarkets = sampleMarkets();
  const demoEvents = new Set(demoMarkets.map(market => String(market.category).toLowerCase()));
  const nonConflictingMarkets = existingMarkets.filter(market => !demoEvents.has(sampleEventTitle(market).toLowerCase()));

  const currentName = authDisplayName() || state.activeMember || "You";
  const sampleMembers = [currentName, "Maya", "Leo", "Tomi", "Alex", "Priya", "Noah", "Zara", "Sam", "Ife"].filter(Boolean);
  const members = [...new Set([...(group.members ?? []), ...sampleMembers])];
  const sampleBalances = {
    [currentName]: 11280,
    Maya: 10890,
    Leo: 10640,
    Tomi: 10225,
    Alex: 10085,
    Priya: 9860,
    Noah: 9635,
    Zara: 9480,
    Sam: 9210,
    Ife: 9045,
  };
  const balances = { ...(group.balances ?? {}) };
  members.forEach(member => {
    if (balances[member] == null) balances[member] = sampleBalances[member] ?? DEFAULT_BALANCE;
  });

  return {
    ...group,
    members,
    balances,
    markets: [...demoMarkets, ...nonConflictingMarkets],
  };
}

function sampleMarkets() {
  const defs = [
    ["Who will win the World Cup?", "England", 27, 18420, "open", 32],
    ["Who will win the World Cup?", "France", 21, 16780, "open", 32],
    ["Who will win the World Cup?", "Portugal", 16, 14240, "open", 32],
    ["Who will win the World Cup?", "Brazil", 14, 13050, "open", 32],
    ["Who will win the World Cup?", "Argentina", 11, 9820, "open", 32],
    ["Golden Boot winner", "Kylian Mbappe", 24, 11680, "open", 28],
    ["Golden Boot winner", "Erling Haaland", 20, 10410, "open", 28],
    ["Golden Boot winner", "Harry Kane", 18, 9050, "open", 28],
    ["Golden Boot winner", "Vinicius Jr.", 11, 5480, "open", 28],
    ["Will England win their opener?", "Yes", 62, 7420, "open", 6],
    ["Will England win their opener?", "No", 38, 7420, "open", 6],
    ["Will Portugal reach the final?", "Yes", 33, 6120, "open", 24],
    ["Will Portugal reach the final?", "No", 67, 6120, "open", 24],
    ["Will Brazil top Group C?", "Yes", 71, 4380, "closed", -1],
    ["Will Brazil top Group C?", "No", 29, 4380, "closed", -1],
  ];
  return defs.map((def, index) => sampleMarket(def, index));
}

function sampleEventTitle(market) {
  return market.category && market.category !== "General" ? market.category : market.question;
}

function sampleMarket([event, option, pct, volume, status, closeInDays], index) {
  const probability = pct / 100;
  const createdAt = new Date(Date.now() - (330 - (index % 4) * 4) * 24 * 60 * 60 * 1000);
  const closesAt = new Date(Date.now() + closeInDays * 24 * 60 * 60 * 1000);
  const poolSize = 8000 + index * 260;
  const pool_no = Math.max(8, probability * poolSize);
  const pool_yes = Math.max(8, (1 - probability) * poolSize);
  return {
    id: `sample-${slug(event)}-${slug(option)}`,
    question: option,
    category: event,
    status,
    oracleType: "ai",
    probability,
    pool_yes,
    pool_no,
    k: pool_yes * pool_no,
    initialLiquidity: DEFAULT_MARKET_LIQUIDITY,
    totalBet: volume,
    volume,
    liquidity: pool_yes + pool_no,
    yesSharesOutstanding: Math.round(volume * probability * 0.75),
    noSharesOutstanding: Math.round(volume * (1 - probability) * 0.75),
    createdAt: createdAt.toISOString(),
    closesAt: closesAt.toISOString(),
    outcome: status === "resolved" ? "yes" : null,
    resolvedAt: null,
    oracleProposal: null,
    trades: sampleTrades(index, probability),
    probabilityHistory: sampleProbabilityHistory(createdAt, probability, index),
    volumeHistory: [],
  };
}

function sampleTrades(index, probability) {
  const names = ["Maya", "Leo", "Tomi", "Alex", "Priya", "Noah", "Zara", "Sam", "Ife"];
  return [0, 1, 2].map(offset => {
    const amount = 24 + ((index + offset) % 6) * 18;
    const side = (index + offset) % 3 === 0 ? "no" : "yes";
    return {
      participant: names[(index + offset) % names.length],
      side,
      amount,
      shares: amount * (1 + probability),
      probBefore: Math.max(0.04, Math.min(0.96, probability - 0.05 + offset * 0.025)),
      probAfter: Math.max(0.04, Math.min(0.96, probability - 0.025 + offset * 0.025)),
      createdAt: new Date(Date.now() - (offset + 1) * 6 * 60 * 60 * 1000).toISOString(),
    };
  });
}

function sampleProbabilityHistory(createdAt, probability, index) {
  return Array.from({ length: 132 }, (_, point) => {
    const progress = point / 131;
    const early = probability * (0.55 + (index % 4) * 0.08);
    const longWave = Math.sin((point + index * 5) * 0.09) * 0.035;
    const shortWave = Math.sin((point + index) * 0.41) * 0.012;
    const lateBreak = point > 120 ? (point - 120) * 0.006 * (index % 2 === 0 ? 1 : -1) : 0;
    const value = Math.max(0.03, Math.min(0.96, early + (probability - early) * progress + longWave + shortWave + lateBreak));
    return {
      createdAt: new Date(createdAt.getTime() + point * 2.5 * 24 * 60 * 60 * 1000).toISOString(),
      probability: value,
    };
  });
}

function isSampleMarket(market) {
  return String(market?.id || "").startsWith("sample-");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeSelection() {
  if (state.currentGroupId && !state.groups.some(g => g.id === state.currentGroupId)) {
    state.currentGroupId = null;
  }
  const group = getCurrentGroup();
  if (group && (!state.activeMember || !group.members.includes(state.activeMember))) {
    state.activeMember = group.members[0] ?? null;
  }
  if (!group && !isLoggedIn()) {
    state.activeMember = null;
  }
}

function renderMarketLinkLoading() {
  dom.mainContent.innerHTML = `
    <section class="invite-preview-page">
      <div class="invite-preview-card motion-item">
        <button class="logo invite-preview-logo" type="button" data-go-welcome>probable<span class="logo-dot">.</span></button>
        <p class="eyebrow">Market link</p>
        <h1>Opening market</h1>
        <p class="muted">Loading the latest prices and trade panel.</p>
      </div>
    </section>`;
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
    localStorage.setItem(STORAGE_KEYS.devAuth, JSON.stringify({
      displayName: state.activeMember,
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
  return state.groups.find(group => (group.markets ?? []).some(market => market.id === mid)) ?? null;
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
  const providerName = (
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.user_metadata?.preferred_username ||
    ""
  ).trim();
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
  if (oracle) oracle.value = "ai";
  if (probSliderVal) probSliderVal.textContent = "50%";
  if (probLabel) probLabel.textContent = "50% YES";
  if (imageInput) imageInput.value = "";
  state.marketImageDataUrl = "";
  state.marketImageName = "";
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
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    let msg = "Request failed";
    try { msg = (await res.json()).detail || msg; } catch { msg = res.statusText || msg; }
    throw new Error(msg);
  }
  return res.json();
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
