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
