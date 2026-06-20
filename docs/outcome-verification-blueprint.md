# Outcome Verification Blueprint

## Goal
Make every market settle predictably, with enough upfront context that creators cannot hide behind vague wording and traders can understand the source of truth before buying.

## Market Creation Inputs
Required at creation:
- Question: the market people trade on.
- Outcomes: binary `Yes / No` or 2-8 named outcomes.
- Maturity date: when trading closes and verification can begin.
- Resolution condition: exact event, threshold, time window, timezone, and what counts.
- Primary source: official source, FotMob, FIFA, league report, club announcement, or another explicit source.
- Verification style: AI verified, manual settle, or group vote.

Optional at creation:
- Edge cases: abandoned match, player does not start, stat-provider disagreement, ambiguous reporting, postponed fixtures.
- Market image.
- Backup sources.

## Verification Modes
### AI Verified
Default mode for most markets.

Flow:
1. Market closes at maturity.
2. User triggers verification or system runs it later.
3. Oracle reads the resolution rules, outcomes, maturity date, and source instructions.
4. Oracle searches web and source pages.
5. Oracle returns winner, confidence, reasoning, and sources.
6. If confidence is high enough, auto-resolve.
7. Otherwise show proposal for manual accept/dispute.

Acceptance criteria:
- Missing API key returns actionable UI fallback.
- Oracle must cite at least one source when available.
- Oracle cannot resolve before market close.
- Oracle returns `needs_review` when rules are ambiguous.

### Manual Settle
For nuanced friend-group markets where human judgement is expected.

Flow:
1. Market closes.
2. Any group member can view resolution rules and outcomes.
3. Authorized/dev user picks winning outcome.
4. App records resolver and timestamp.

Acceptance criteria:
- Manual resolution uses the same payout engine as AI.
- Resolution requires one existing outcome.
- Resolved markets cannot be traded.

### Group Vote
For subjective or disputed markets.

Flow:
1. Market closes.
2. Members vote for an outcome.
3. Market resolves when one outcome reaches threshold.
4. If no threshold is reached, keep as pending manual review.

V1 threshold recommendation:
- Binary: 60% of votes with at least 3 voters.
- Multi-outcome: plurality after at least 3 voters, or manual review if tied.

## Data Model Additions
Implemented on `market_events`:
- `resolution_source text`
- `edge_cases text`
- `verification_status text default 'not_started'`
- `verification_attempts jsonb default '[]'`
- `resolved_by text`
- `resolution_notes text`

## Oracle Prompt Contract
The oracle should receive:
- Market title.
- Full resolution rules.
- Outcomes with IDs and labels.
- Close date.
- Primary source.
- Edge cases.
- Current date.

The oracle should return:
- `status`: `resolved`, `needs_review`, or `unavailable`.
- `outcomeId`: winning outcome ID if resolved.
- `confidence`: 0-1.
- `reasoning`: concise explanation.
- `sources`: URLs/titles used.
- `notes`: ambiguity or caveats.

## UX States
Pre-close:
- Show resolution rules under outcomes.
- Show verification style.
- Disable resolution controls.

Closed, not verified:
- Show `Ready to verify`.
- Primary action: `Verify outcome` for AI markets.
- Fallback: `Settle manually` where applicable.

AI unavailable:
- Show missing key or source failure.
- Offer manual fallback.

Proposal pending:
- Show proposed outcome, confidence, sources, and reasoning.
- Actions: `Accept`, `Dispute`.

Resolved:
- Show winner, resolver, timestamp, and payout status.

## Guardrails
- Never settle before close date.
- Never settle to an outcome outside the event outcome set.
- Do not auto-resolve if source disagrees with market rules.
- Do not auto-resolve if confidence is below threshold.
- Keep original resolution rules immutable after first trade.

## Implemented V1
- Market creation persists primary source, edge cases, verification status, and attempt history on event-level markets.
- AI oracle routes operate on `market_events` + `market_outcomes`, not legacy market rows.
- Oracle proposals use `outcomeId` and cannot settle outside the event outcome set.
- Manual settlement records resolver/status/notes and uses the same event payout path.
- Group voting works for binary and multi-outcome events with the V1 thresholds above.
- Focused market pages show rules, source, edge cases, verification mode, AI proposals, review states, and resolution controls.
- Live Supabase DB has the additive verification columns.

## Next Hardening Step
Add authorization around who can manually settle or dispute, and make resolution rules immutable after first trade at the API level.
