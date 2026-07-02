# Automated question generation

**Date:** 2026-07-01
**Branch:** feature/automated-question-generation

## Goal

Reduce the barrier to creating markets by surfacing AI-generated question suggestions in two places: the group dashboard and the market creation form. Suggestions are inferred from the group name and recent market titles, so they stay relevant without requiring any manual configuration.

## Surfaces

### 1. Group dashboard

A "Suggested questions" section is always visible below the open markets list. On load it fires the suggestion endpoint and renders 4 question chips. A refresh icon lets the user re-fetch.

Tapping a chip opens a **preview sheet** (modal) showing:
- The suggested question
- AI-drafted resolution rules (fetched from the existing `POST /api/markets/rules/draft` endpoint)
- Two actions: "Create this market" (opens the 4-step form with question + rules pre-filled) and "Dismiss"

While suggestions are loading, show 4 skeleton pill placeholders. If the request fails or OpenAI is unavailable, the section is hidden silently — no error state shown.

### 2. Market creation form (step 1)

A row of pill-shaped suggestion chips appears below the question input when the modal opens. Tapping a chip fills the question field. The chips disappear once the user starts typing their own question. If the suggestion fetch fails, the chips row is simply not rendered.

## Backend

### New endpoint

```
POST /api/groups/{group_id}/questions/suggest
```

**Request body:** none — the backend fetches the group name and last 5 market question titles from `market_events` using the existing `get_db()` pattern.

**Response:**
```json
{ "questions": ["...", "...", "...", "...", "..."] }
```

**Logic:**
1. Load group name from `groups` table
2. Load last 5 `market_events.title` for the group, ordered by `created_at DESC`
3. Call OpenAI `gpt-4o-mini` with a prompt that infers the group theme and returns 5 yes/no prediction market questions as a JSON array
4. Return the array

**Prompt (approximate):**
> This friend group is called "{name}". Their recent markets: {titles}. Suggest 5 short, specific yes/no prediction market questions they would enjoy. Return as a JSON array of strings only.

**Fallback:** if `OPENAI_API_KEY` is missing or the call fails, return an empty `{ "questions": [] }` — the frontend hides the chips section silently.

**Model:** `gpt-4o-mini` (same as rules drafter, configurable via `OPENAI_RULES_MODEL` or a new `OPENAI_SUGGEST_MODEL` env var).

No new DB tables, Pydantic models, or schema migrations required.

## Frontend

### Dashboard

- On group load, fire `POST /api/groups/{group_id}/questions/suggest`
- Render chips in a column list inside a "Suggested questions" card section
- Tapping a chip: fetch `POST /api/markets/rules/draft` with the question as input, show preview modal
- "Create this market" in the preview: open the market creation modal with `question` and `description` pre-filled, skip to step 2
- Refresh button re-fires the suggestion endpoint

### Creation form (step 1)

- On modal open, fire `POST /api/groups/{group_id}/questions/suggest`
- Render chips as horizontal pill row below the question `<input>`
- Tapping a chip: set the question field value, hide the chips row
- User typing in the question field: hide the chips row

## Error handling

| Scenario | Behaviour |
|---|---|
| OpenAI key missing | Return `{ "questions": [] }`, UI hides chips section |
| OpenAI call fails | Same as above — no error surfaced to user |
| Slow response (>2s) | Show skeleton placeholders while in flight |
| Group has no prior markets | Suggestions based on group name alone — works fine |

## What this does not include

- Caching suggestions between sessions (on-demand only, always fresh)
- Personalisation beyond group name + recent titles
- Multi-outcome question suggestions (binary Yes/No only for now)
- Admin controls for toggling suggestions per group
