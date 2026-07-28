# Automated Question Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface AI-generated question suggestions on the group dashboard and in the market creation form step 1, reducing friction to creating new markets.

**Architecture:** A new backend endpoint (`POST /api/groups/{group_id}/questions/suggest`) calls OpenAI with the group name and last 5 market titles, returns 5 yes/no question strings. The frontend fetches this on group load, stores suggestions in state, renders them as chips on the dashboard and in the creation form step 1.

**Tech Stack:** FastAPI + httpx (backend, existing), vanilla JS + HTML string templates (frontend, existing), OpenAI `gpt-4o-mini` (existing model used by rules drafter).

---

## File map

| File | Change |
|---|---|
| `backend/main.py` | Add `POST /api/groups/{group_id}/questions/suggest` route |
| `src/main.js` | Add state fields, fetch function, dashboard section HTML, creation form chips, click/input handlers, preview modal HTML |

---

## Task 1: Backend — suggestion endpoint

**Files:**
- Modify: `backend/main.py` (add after `@app.post("/api/markets/odds/seed")` route, around line 2292)

- [ ] **Step 1: Add the route**

Find the line `@app.post("/api/groups/{group_id}/markets", status_code=201)` (around line 2292) and insert the following route immediately before it:

```python
@app.post("/api/groups/{group_id}/questions/suggest")
async def suggest_market_questions(group_id: str) -> dict:
    db = get_db()
    group_row = db.table("groups").select("name").eq("id", group_id).execute()
    if not group_row.data:
        raise HTTPException(404, "Group not found")
    group_name = group_row.data[0]["name"]

    events_row = (
        db.table("market_events")
        .select("title")
        .eq("group_id", group_id)
        .order("created_at", desc=True)
        .limit(5)
        .execute()
    )
    recent_titles = [e["title"] for e in (events_row.data or [])]

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        return {"questions": []}

    titles_block = "\n".join(f"- {t}" for t in recent_titles) if recent_titles else "No markets yet."
    system = "You generate concise yes/no prediction market questions for friend groups. Return only valid JSON."
    user = (
        f'Group name: "{group_name}"\n'
        f"Recent markets:\n{titles_block}\n\n"
        "Suggest 5 short, specific yes/no prediction market questions this group would enjoy. "
        'Return exactly this JSON shape: {"questions": ["...", "...", "...", "...", "..."]}'
    )

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {openai_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": os.environ.get("OPENAI_SUGGEST_MODEL", os.environ.get("OPENAI_RULES_MODEL", "gpt-4o-mini")),
                    "temperature": 0.8,
                    "max_tokens": 300,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "response_format": {"type": "json_object"},
                },
            )
        if response.status_code >= 400:
            return {"questions": []}
        data = response.json()
        text = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
        parsed = parse_json_object_text(text)
        questions = parsed.get("questions") or []
        questions = [str(q).strip() for q in questions if str(q).strip()][:5]
        return {"questions": questions}
    except Exception:
        return {"questions": []}
```

- [ ] **Step 2: Smoke-test the endpoint with curl**

Make sure both servers are running (`uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000` and `npm run dev`).

Get a group ID from the DB first:
```bash
curl -s --ipv4 http://localhost:8000/api/groups | python3 -m json.tool | grep '"id"' | head -3
```

Then call the endpoint (replace `<group_id>` with a real ID from the output above):
```bash
curl -s --ipv4 -X POST http://localhost:8000/api/groups/<group_id>/questions/suggest | python3 -m json.tool
```

Expected output (questions will vary):
```json
{
  "questions": [
    "Will England win Euro 2026?",
    "Will Mbappé score in the final?",
    "Will the World Cup final go to penalties?",
    "Will Argentina retain the title?",
    "Will there be a VAR controversy in the semis?"
  ]
}
```

If `OPENAI_API_KEY` is not set, expected: `{"questions": []}`

- [ ] **Step 3: Test missing group returns 404**

```bash
curl -s --ipv4 -X POST http://localhost:8000/api/groups/nonexistent-id/questions/suggest
```

Expected: `{"detail":"Group not found"}`

- [ ] **Step 4: Commit**

```bash
git add backend/main.py
git commit -m "feat: add POST /api/groups/:id/questions/suggest endpoint"
```

---

## Task 2: Frontend state + fetch function

**Files:**
- Modify: `src/main.js`
  - State object (~line 369): add `questionSuggestions` fields
  - After `resetMarketOddsSeed` function (~line 2282): add `loadQuestionSuggestions`
  - Inside `onGlobalClick` where `state.currentGroupId` is set (~line 1186): trigger suggestion fetch

- [ ] **Step 1: Add state fields**

Find this line (around line 369):
```js
  pendingUi: { marketCreate: false, welcomeCreate: false, rulesDraft: false, oddsSeed: false, tradeMarketId: null, resolveMarketId: null },
```

Replace with:
```js
  pendingUi: { marketCreate: false, welcomeCreate: false, rulesDraft: false, oddsSeed: false, suggestions: false, tradeMarketId: null, resolveMarketId: null },
  questionSuggestions: [],
  questionSuggestionsGroupId: null,
```

- [ ] **Step 2: Add the fetch function**

Find `function resetMarketOddsSeed()` (around line 2282) and insert this function immediately before it:

```js
async function loadQuestionSuggestions(groupId) {
  if (!groupId || state.pendingUi.suggestions) return;
  if (state.questionSuggestionsGroupId === groupId && state.questionSuggestions.length) return;
  state.pendingUi.suggestions = true;
  state.questionSuggestions = [];
  state.questionSuggestionsGroupId = groupId;
  render();
  try {
    const res = await fetch(`${API}/api/groups/${groupId}/questions/suggest`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      state.questionSuggestions = data.questions || [];
    }
  } catch {
    state.questionSuggestions = [];
  } finally {
    state.pendingUi.suggestions = false;
    render();
  }
}
```

- [ ] **Step 3: Trigger suggestions load when a group is selected**

Find this block in `onGlobalClick` (around line 1186):
```js
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
```

Replace with:
```js
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
```

- [ ] **Step 4: Also trigger on initial app load**

Find `function loadInitialAppData()` (around line 758) and find where `render()` is called after groups load. Look for this pattern around line 789:

```js
  render();
```

The function ends around line 800. Find the call to `render()` inside `loadInitialAppData` that runs after groups are set, and add the suggestion load after it. Specifically, find this line inside `loadInitialAppData`:

```js
async function loadInitialAppData() {
```

Read the function body and add `loadQuestionSuggestions(state.currentGroupId)` after the final `render()` call inside this function. The exact location will be after `state.currentGroupId` is resolved.

Find the line around 789:
```js
  render();
```
And replace with:
```js
  render();
  if (state.currentGroupId) loadQuestionSuggestions(state.currentGroupId);
```

- [ ] **Step 5: Verify in browser console**

Open `http://localhost:5173`, open the browser devtools console, and run:
```js
// After the page loads with a group selected
state.questionSuggestions
```

Expected: an array of 5 question strings (or empty array if still loading / no API key).

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: add question suggestions state and fetch function"
```

---

## Task 3: Dashboard suggestions section

**Files:**
- Modify: `src/main.js`
  - `renderDashboard()` function (~line 3507): add suggestions section HTML
  - `onGlobalClick` (~line 973): add handler for `[data-suggestion-chip]`

- [ ] **Step 1: Add suggestions section to dashboard HTML**

In `renderDashboard()`, find the closing of the `<aside class="side-panel">` (around line 3569):
```js
        <aside class="side-panel motion-item">
          ${leaderboardPanel(group, { limit: compactLeaderboardLimit(), compact: true })}
        </aside>
```

Replace with:
```js
        <aside class="side-panel motion-item">
          ${leaderboardPanel(group, { limit: compactLeaderboardLimit(), compact: true })}
          ${suggestedQuestionsHtml()}
        </aside>
```

Then add this function anywhere before `renderDashboard` (e.g. just above it at ~line 3507):

```js
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
```

- [ ] **Step 2: Add CSS for the suggestions section**

Find `src/styles.css` and add at the end:

```css
.suggest-panel {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--color-border, rgba(255,255,255,0.08));
}

.suggest-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.suggest-chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.suggest-chip {
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid var(--color-border, rgba(255,255,255,0.1));
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--color-text, #fff);
  cursor: pointer;
  line-height: 1.4;
  transition: border-color 0.15s, background 0.15s;
}

.suggest-chip:hover {
  border-color: var(--color-border-strong, rgba(255,255,255,0.25));
  background: rgba(255,255,255,0.04);
}

.suggest-skeleton-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.suggest-skeleton {
  display: block;
  height: 36px;
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.btn-icon {
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: var(--color-muted, rgba(255,255,255,0.4));
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  color: var(--color-text, #fff);
}
```

- [ ] **Step 3: Add click handlers in `onGlobalClick`**

In `onGlobalClick`, find the section that handles `[data-new-market]` (around line 1231) and add these handlers immediately before it:

```js
  if (e.target.closest("[data-refresh-suggestions]")) {
    const group = getCurrentGroup();
    if (!group) return;
    state.questionSuggestions = [];
    state.questionSuggestionsGroupId = null;
    loadQuestionSuggestions(group.id);
    return;
  }

  if (e.target.closest("[data-suggestion-chip]")) {
    const btn = e.target.closest("[data-suggestion-chip]");
    const idx = parseInt(btn.dataset.suggestionIndex, 10);
    const question = state.questionSuggestions[idx];
    if (!question) return;
    state.pendingUi.suggestionPreview = { question, rules: null, loading: true };
    render();
    openModal("suggestPreview");
    // Fetch AI rules draft for the preview
    const group = getCurrentGroup();
    if (!group) return;
    fetch(`${API}/api/markets/rules/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        brief: question,
        outcomes: ["Yes", "No"],
        oracleType: "ai",
      }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          state.pendingUi.suggestionPreview = { question, rules: data.description || "", loading: false };
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
```

- [ ] **Step 4: Also add `suggestionPreview` to pendingUi initial state**

In the state object (Task 2, Step 1), update `pendingUi` to include `suggestionPreview`:
```js
  pendingUi: { marketCreate: false, welcomeCreate: false, rulesDraft: false, oddsSeed: false, suggestions: false, suggestionPreview: null, tradeMarketId: null, resolveMarketId: null },
```

- [ ] **Step 5: Verify in browser**

Open `http://localhost:5173`, select Dev Test Group. The "Suggested questions" section should appear in the sidebar. If no OPENAI_API_KEY is set it will be hidden (empty array = no render). To test the render with a mock, temporarily paste in the browser console:
```js
state.questionSuggestions = ["Will England win?", "Will Mbappé score?", "Will it go to penalties?", "Will Argentina retain?"];
render();
```

Confirm 4 chips appear in the sidebar.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/styles.css
git commit -m "feat: add suggested questions section to group dashboard"
```

---

## Task 4: Preview modal

**Files:**
- Modify: `src/main.js`
  - Main HTML template (~line 376): add `#suggestPreviewModal` markup
  - `dom` object (~line 638): add modal refs
  - Modal close listeners (~line 658): add close listener
  - `openModal` / `closeModal` functions: these are generic, no change needed
  - `render()` or a new `renderSuggestPreviewModal()`: populate modal content

- [ ] **Step 1: Find where modals are declared in the HTML template**

Find the line (around line 522):
```js
  <div class="modal-overlay hidden" id="marketModalOverlay">
```

Add the following block immediately before it:

```js
  <div class="modal-overlay hidden" id="suggestPreviewModalOverlay">
    <div class="modal suggest-preview-modal" id="suggestPreviewModal">
      <div class="modal-header">
        <span class="modal-title">Question preview</span>
        <button class="modal-x" type="button" id="closeSuggestPreviewModal" aria-label="Close">x</button>
      </div>
      <p class="suggest-preview-question" id="suggestPreviewQuestion"></p>
      <div class="suggest-preview-rules" id="suggestPreviewRules"></div>
      <div class="suggest-preview-actions">
        <button class="btn btn-ghost" type="button" id="dismissSuggestPreview">Dismiss</button>
        <button class="btn btn-primary" type="button" id="createFromSuggestion">Create this market</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add modal refs to the `dom` object**

Find the `dom` object (around line 638) and add:
```js
  suggestPreviewModalOverlay: document.querySelector("#suggestPreviewModalOverlay"),
  suggestPreviewQuestion: document.querySelector("#suggestPreviewQuestion"),
  suggestPreviewRules: document.querySelector("#suggestPreviewRules"),
```

- [ ] **Step 3: Add close listeners**

Find the block of modal close listeners (around line 658) and add:
```js
document.querySelector("#closeSuggestPreviewModal").addEventListener("click", () => closeModal("suggestPreview"));
document.querySelector("#dismissSuggestPreview").addEventListener("click", () => closeModal("suggestPreview"));
document.querySelector("#suggestPreviewModalOverlay").addEventListener("click", e => {
  if (e.target === document.querySelector("#suggestPreviewModalOverlay")) closeModal("suggestPreview");
});
```

- [ ] **Step 4: Populate modal content on render**

Find the `render()` function (search for `function render(`) and inside it, add a call to update the preview modal content. Find a good place near the top of `render()` (after the early returns) and add:

```js
  updateSuggestPreviewModal();
```

Then add this function near `suggestedQuestionsHtml()`:

```js
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
```

- [ ] **Step 5: Handle "Create this market" button click**

In `onGlobalClick`, find where other modal action buttons are handled and add:

```js
  if (e.target.closest("#createFromSuggestion")) {
    const preview = state.pendingUi.suggestionPreview;
    if (!preview) return;
    closeModal("suggestPreview");
    await ensureMarketGroup();
    setMarketMinDate();
    openModal("market");
    // Pre-fill question
    const qInput = dom.marketForm?.querySelector("[name=question]");
    if (qInput) {
      qInput.value = preview.question;
      qInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // Pre-fill description if we have rules
    if (preview.rules) {
      const descInput = dom.marketForm?.querySelector("[name=description]");
      if (descInput) {
        descInput.value = preview.rules;
        descInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }
```

- [ ] **Step 6: Add CSS for the preview modal**

Add to `src/styles.css`:
```css
.suggest-preview-modal {
  max-width: 480px;
  width: 90vw;
}

.suggest-preview-question {
  font-size: 17px;
  font-weight: 500;
  line-height: 1.4;
  margin: 1rem 0;
}

.suggest-preview-rules {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  min-height: 60px;
  margin-bottom: 1.25rem;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(255,255,255,0.7);
}

.suggest-rules-text {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 13px;
  margin: 0;
}

.suggest-rules-loading {
  color: rgba(255,255,255,0.4);
  font-style: italic;
  margin: 0;
}

.suggest-preview-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
```

- [ ] **Step 7: Test the preview flow in browser**

1. Load the dashboard with mocked suggestions (browser console):
   ```js
   state.questionSuggestions = ["Will England win Euro 2026?", "Will Mbappé score?", "Will it go to penalties?", "Will Argentina retain?"];
   render();
   ```
2. Click a chip — the preview modal should open with the question and "Drafting rules…"
3. After ~2s the rules should populate (requires OPENAI_API_KEY)
4. Click "Create this market" — market form should open with question pre-filled

- [ ] **Step 8: Commit**

```bash
git add src/main.js src/styles.css
git commit -m "feat: add suggestion preview modal with pre-fill into market creation form"
```

---

## Task 5: Creation form chips

**Files:**
- Modify: `src/main.js`
  - Market form HTML step 1 (~line 538): add chips container below question input
  - `updateMarketFormStep()` (~line 2460): populate chips when on step 1
  - `onGlobalInput` (~line 1542): hide chips when user types in question field
  - `onGlobalClick` (~line 973): handle chip click to fill question field

- [ ] **Step 1: Add chips container to step 1 HTML**

Find the step 1 block (around line 538):
```js
        <div class="market-form-step" data-market-form-step="1">
          <p class="form-helper">Start with the market people will trade.</p>
          <div class="field">
            <label class="field-label">Question</label>
            <input name="question" placeholder="Will Wirtz get 3+ GA tomorrow?" maxlength="100" required />
          </div>
```

Replace with:
```js
        <div class="market-form-step" data-market-form-step="1">
          <p class="form-helper">Start with the market people will trade.</p>
          <div class="field">
            <label class="field-label">Question</label>
            <input name="question" placeholder="Will Wirtz get 3+ GA tomorrow?" maxlength="100" required />
            <div class="form-suggest-chips hidden" data-form-suggest-chips></div>
          </div>
```

- [ ] **Step 2: Populate chips when step 1 is shown**

In `updateMarketFormStep()` (around line 2460), find the end of the function (before the closing `}`) and add:

```js
  updateFormSuggestChips();
```

Then add this function near `updateMarketFormStep`:

```js
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
```

- [ ] **Step 3: Hide chips when user types in question field**

In `onGlobalInput` (around line 1555), find:
```js
  if (e.target.matches("#marketForm [name=description], #marketForm [name=question], #marketForm [name=closesAt]")) {
    if (e.target.matches("#marketForm [name=question], #marketForm [name=closesAt]")) resetMarketOddsSeed();
    updateMarketOddsPanel();
    if (state.marketFormStep === marketReviewStep()) updateMarketReview();
  }
```

Replace with:
```js
  if (e.target.matches("#marketForm [name=description], #marketForm [name=question], #marketForm [name=closesAt]")) {
    if (e.target.matches("#marketForm [name=question], #marketForm [name=closesAt]")) resetMarketOddsSeed();
    if (e.target.matches("#marketForm [name=question]")) updateFormSuggestChips();
    updateMarketOddsPanel();
    if (state.marketFormStep === marketReviewStep()) updateMarketReview();
  }
```

- [ ] **Step 4: Handle chip click in `onGlobalClick`**

In `onGlobalClick`, find the `[data-suggestion-chip]` handler added in Task 3 and add this handler immediately before it:

```js
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
```

- [ ] **Step 5: Add CSS for form chips**

Add to `src/styles.css`:
```css
.form-suggest-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.form-suggest-chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 99px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.6);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

.form-suggest-chip:hover {
  border-color: rgba(255,255,255,0.4);
  color: #fff;
}
```

- [ ] **Step 6: Test end-to-end in browser**

1. Open the group dashboard with suggestions loaded
2. Click "+ Market" to open the creation form
3. Confirm chips appear below the question input (requires `state.questionSuggestions` to be populated)
4. Click a chip — confirm the question field is filled and chips disappear
5. Clear the question field manually — confirm chips reappear
6. Type in the question field — confirm chips disappear

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/styles.css
git commit -m "feat: add question suggestion chips to market creation form step 1"
```

---

## Self-review

**Spec coverage:**
- ✅ `POST /api/groups/{group_id}/questions/suggest` — Task 1
- ✅ Signal: group name + last 5 market titles — Task 1
- ✅ Fallback: empty questions array if no OpenAI key — Task 1
- ✅ Dashboard: always-visible section — Task 3
- ✅ Dashboard: skeleton while loading — Task 3
- ✅ Dashboard: preview sheet on chip tap — Task 4
- ✅ Preview: question + AI-drafted rules — Task 4
- ✅ Preview: "Create this market" pre-fills form — Task 4
- ✅ Creation form: chips below question input — Task 5
- ✅ Creation form: chips hide on typing — Task 5
- ✅ Creation form: chip tap fills field — Task 5
- ✅ Section hidden if suggestions empty — Task 3 (`suggestedQuestionsHtml` returns `""`)

**Placeholder scan:** None found.

**Type consistency:**
- `state.questionSuggestions` (array of strings) — used consistently in Tasks 2, 3, 4, 5
- `state.pendingUi.suggestions` (boolean) — used in Tasks 2 and 3
- `state.pendingUi.suggestionPreview` (object `{question, rules, loading}` or null) — used in Tasks 3 and 4
- `loadQuestionSuggestions(groupId)` — defined in Task 2, called in Tasks 2 and 3
- `updateFormSuggestChips()` — defined in Task 5, called in Tasks 5 (step and input handlers)
- `suggestedQuestionsHtml()` — defined in Task 3, called in Task 3
- `updateSuggestPreviewModal()` — defined in Task 4, called in Task 4
