from __future__ import annotations

import json
import base64
import hashlib
import io
import math
import os
import re
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse, urlunparse
from uuid import uuid4

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Load .env.local then .env (whichever exists)
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=BASE_DIR / ".env.local", override=False)
load_dotenv(dotenv_path=BASE_DIR / ".env", override=False)

DIST_DIR = BASE_DIR / "dist"
DEFAULT_FAKE_BALANCE = 100000.0
MARKET_FEE_RATE = 0.015


# ── Pydantic models ────────────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    emoji: str = Field(default="📣", max_length=4)
    members: list[str] = Field(min_length=1)
    mode: Literal["fake", "real"] = "fake"


class JoinGroup(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class InviteCreate(BaseModel):
    createdBy: str | None = Field(default=None, max_length=80)


class InviteJoin(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class MarketCreate(BaseModel):
    question: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2400)
    resolutionSource: str | None = Field(default=None, max_length=240)
    edgeCases: str | None = Field(default=None, max_length=1000)
    category: str = Field(default="General", max_length=120)
    closesAt: str = Field(min_length=1)
    outcomes: list[str] = Field(default_factory=lambda: ["Yes", "No"])
    initialProbability: float = Field(default=0.5, ge=0.01, le=0.99)
    initialLiquidity: float = Field(default=20000.0, ge=2000.0, le=200000.0)
    oracleType: Literal["manual", "ai", "vote"] = "ai"
    imageUrl: str | None = Field(default=None, max_length=1000000)
    createdBy: str | None = Field(default=None, max_length=80)
    slug: str | None = Field(default=None, max_length=80)


class MarketRulesDraft(BaseModel):
    question: str = Field(min_length=1, max_length=100)
    brief: str = Field(min_length=1, max_length=900)
    outcomes: list[str] = Field(default_factory=lambda: ["Yes", "No"])
    closesAt: str | None = Field(default=None, max_length=80)
    resolutionSource: str | None = Field(default=None, max_length=240)
    category: str = Field(default="General", max_length=120)
    oracleType: Literal["manual", "ai", "vote"] = "manual"


class TradeCreate(BaseModel):
    participant: str = Field(min_length=1, max_length=40)
    side: Literal["yes", "no"]
    amount: float = Field(gt=0, le=1_000_000)
    action: Literal["buy", "sell"] = "buy"
    outcomeId: str | None = None


class TradeQuote(BaseModel):
    participant: str | None = Field(default=None, max_length=40)
    side: Literal["yes", "no"] = "yes"
    amount: float = Field(default=0, ge=0, le=1_000_000)
    action: Literal["buy", "sell"] = "buy"
    outcomeId: str | None = None


class ResolveMarket(BaseModel):
    outcome: str = Field(min_length=1, max_length=80)
    reasoning: str | None = Field(default=None, max_length=1200)
    resolvedBy: str | None = Field(default=None, max_length=80)


class OracleVote(BaseModel):
    participant: str = Field(min_length=1, max_length=40)
    outcome: str = Field(min_length=1, max_length=80)


# ── AMM math ───────────────────────────────────────────────────────────

def compute_trade(
    pool_yes: float, pool_no: float, side: str, amount: float
) -> tuple[float, float, float, float]:
    k = pool_yes * pool_no
    if side == "yes":
        new_pool_no  = pool_no + amount
        new_pool_yes = k / new_pool_no
        shares = amount + (pool_yes - new_pool_yes)
    else:
        new_pool_yes = pool_yes + amount
        new_pool_no  = k / new_pool_yes
        shares = amount + (pool_no - new_pool_no)
    return shares, new_pool_yes, new_pool_no, new_pool_no / (new_pool_yes + new_pool_no)


def compute_sell(
    pool_yes: float, pool_no: float, side: str, cash_out: float
) -> tuple[float, float, float, float]:
    k = pool_yes * pool_no
    if side == "yes":
        if cash_out >= pool_no * 0.9:
            raise HTTPException(400, "Not enough liquidity to sell that much YES")
        new_pool_no = pool_no - cash_out
        new_pool_yes = k / new_pool_no
        shares_burned = cash_out + (new_pool_yes - pool_yes)
    else:
        if cash_out >= pool_yes * 0.9:
            raise HTTPException(400, "Not enough liquidity to sell that much NO")
        new_pool_yes = pool_yes - cash_out
        new_pool_no = k / new_pool_yes
        shares_burned = cash_out + (new_pool_no - pool_no)
    return shares_burned, new_pool_yes, new_pool_no, new_pool_no / (new_pool_yes + new_pool_no)


def init_pools(p: float, liquidity: float) -> tuple[float, float]:
    return liquidity * (1.0 - p), liquidity * p


def prob_from_pools(py: float, pn: float) -> float:
    return pn / (py + pn)


def normalize_outcomes(values: list[str] | None) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        label = re.sub(r"\s+", " ", str(value).strip())[:48]
        key = label.lower()
        if label and key not in seen:
            cleaned.append(label)
            seen.add(key)
    if not cleaned:
        cleaned = ["Yes", "No"]
    if len(cleaned) < 2:
        raise HTTPException(400, "Add at least two predictions")
    if len(cleaned) > 8:
        raise HTTPException(400, "Use 8 predictions or fewer")
    weak = {"option", "prediction", "outcome", "team", "player", "tbd", "n/a", "na"}
    if any(label.lower() in weak for label in cleaned):
        raise HTTPException(400, "Use specific prediction labels")
    return cleaned


def clean_market_question(value: str) -> str:
    question = re.sub(r"\s+", " ", str(value or "").strip())
    if len(question) < 8:
        raise HTTPException(400, "Question is too short")
    if question.lower() in {"test", "new market", "market", "question"}:
        raise HTTPException(400, "Use a real market question")
    return question[:100]


def clean_market_description(payload: MarketCreate) -> str:
    description = re.sub(r"\n{3,}", "\n\n", str(payload.description or "").strip())
    source = re.sub(r"\s+", " ", str(payload.resolutionSource or "").strip())
    edge_cases = re.sub(r"\s+", " ", str(payload.edgeCases or "").strip())
    if source and "Primary source:" not in description:
        description = f"{description}\n\nPrimary source: {source}".strip()
    if edge_cases and "Edge cases:" not in description:
        description = f"{description}\n\nEdge cases: {edge_cases}".strip()
    if len(description) < 40:
        raise HTTPException(400, "Add clear resolution rules before creating this market")
    if not re.search(r"(condition|source|resolve|settle|counts|wins|will|must|primary)", description, re.I):
        raise HTTPException(400, "Resolution rules must explain how the market settles")
    return description[:2400]


def default_resolution_source(question: str, brief: str) -> str:
    text = f"{question} {brief}".lower()
    if any(word in text for word in ("assist", "goal", "ga", "dribble", "shot", "subbed", "halftime", "yellow", "red card", "fotmob")):
        return "FotMob match stats, with the official competition match report as backup."
    if any(word in text for word in ("world cup", "fifa", "wc")):
        return "Official FIFA match reports and announcements."
    if any(word in text for word in ("premier league", "champions league", "uefa", "league")):
        return "Official league or competition report, with FotMob as backup for player stats."
    return "Authoritative public reporting or the official event source."


def fallback_market_rules_draft(payload: MarketRulesDraft, outcomes: list[str], closes_at: datetime | None, generated_by: str = "template") -> dict:
    question = clean_market_question(payload.question)
    brief = re.sub(r"\s+", " ", payload.brief.strip())
    brief_sentence = brief.rstrip(". ")
    source = re.sub(r"\s+", " ", str(payload.resolutionSource or "").strip()) or default_resolution_source(question, brief)
    close_label = closes_at.isoformat() if closes_at else "the maturity date"
    binary = len(outcomes) == 2 and {item.lower() for item in outcomes} == {"yes", "no"}
    if binary:
        condition_items = [
            f"Yes if the condition is confirmed: {brief_sentence}.",
            f"No if the condition is not met by {close_label} or the trusted source contradicts it.",
        ]
    else:
        outcome_text = ", ".join(outcomes)
        condition_items = [
            f"Resolve to the listed outcome that best answers: {question}.",
            f"Eligible outcomes: {outcome_text}. The winner must be one of these labels.",
            f"Creator clarification: {brief_sentence}.",
        ]
    timing_items = [
        f"Trading closes at {close_label}.",
        "Only events, stats, or announcements from the stated market window count unless the question names a different window.",
        "If the result is not available by maturity, resolution remains pending while trading stays closed.",
    ]
    source_items = [source]
    edge_items = [
        "If the event is postponed, resolve from the rescheduled event if it clearly refers to the same fixture or competition stage.",
        "If the event is abandoned or permanently cancelled before a result can be verified, resolve to No for binary markets or manual review for multi-outcome markets.",
        "If trusted sources disagree or the primary source is unavailable, send the market to manual review.",
    ]
    description = rich_rules_to_description(condition_items, timing_items, source_items, edge_items)
    return {
        "description": description[:2400],
        "resolutionSource": source[:240],
        "edgeCases": " ".join(edge_items)[:1000],
        "rulesStructured": {
            "condition": condition_items,
            "timing": timing_items,
            "source": source_items,
            "edgeCases": edge_items,
        },
        "generatedBy": generated_by,
    }


def clean_rule_items(value: object, limit: int = 5) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    for item in value:
        text = re.sub(r"\s+", " ", str(item or "").strip())
        if text:
            cleaned.append(text[:280])
    return cleaned[:limit]


def rich_rules_to_description(condition: list[str], timing: list[str], source: list[str], edge_cases: list[str]) -> str:
    parts = []
    for label, items in (
        ("What settles it", condition),
        ("Timing", timing),
        ("Source", source),
        ("Edge cases", edge_cases),
    ):
        if items:
            parts.append(f"{label}:\n" + "\n".join(f"- {item}" for item in items))
    return "\n\n".join(parts)


async def ai_market_rules_draft(payload: MarketRulesDraft, outcomes: list[str], closes_at: datetime | None) -> dict:
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        return fallback_market_rules_draft(payload, outcomes, closes_at, "template")

    outcome_lines = "\n".join(f"- {item}" for item in outcomes)
    close_label = closes_at.isoformat() if closes_at else "not specified"
    system = (
        "You write strict, practical prediction-market resolution rules for friend-group sports markets. "
        "Return compact bullets, not prose paragraphs. Do not decide the outcome. "
        "Use only the user's market question, brief, outcomes, maturity date, and named source. "
        "Never invent fixture details, dates, team membership, or player participation beyond what the user provides. "
        "Trading always closes at maturity; never say the market stays open after maturity. "
        "If an event is postponed past maturity, resolution remains pending while trading stays closed. "
        "Ambiguous, unavailable, or conflicting source data goes to manual review unless the user explicitly defines a fallback. "
        "For binary markets, define exactly what Yes means and what No means. "
        "For multi-outcome markets, state that the winner must be one of the listed outcomes. "
        "Each bullet must be specific enough for a human admin to settle in one click."
    )
    user = (
        f"Question: {payload.question}\n"
        f"Brief from creator: {payload.brief}\n"
        f"Outcomes:\n{outcome_lines}\n"
        f"Maturity date: {close_label}\n"
        f"Creator preferred source: {payload.resolutionSource or 'not provided'}\n"
        f"Verification style: {payload.oracleType}\n\n"
        "Draft the full market rules now. Make the wording suitable to show directly under a market before people trade."
    )
    schema = {
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Readable markdown-style rules generated from the section arrays. Use section headings and bullet lines only.",
            },
            "resolutionSource": {
                "type": "string",
                "description": "Primary source and optional backup source.",
            },
            "edgeCases": {
                "type": "string",
                "description": "Concise edge-case summary derived from rulesStructured.edgeCases.",
            },
            "rulesStructured": {
                "type": "object",
                "properties": {
                    "condition": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "items": {"type": "string"},
                        "description": "What resolves Yes/No or which listed outcome wins.",
                    },
                    "timing": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "items": {"type": "string"},
                        "description": "Trading close, resolution timing, and window rules.",
                    },
                    "source": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 3,
                        "items": {"type": "string"},
                        "description": "Primary source first, then backup/source priority if needed.",
                    },
                    "edgeCases": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 5,
                        "items": {"type": "string"},
                        "description": "Postponement, cancellation, disagreement, non-participation, ambiguity.",
                    },
                },
                "required": ["condition", "timing", "source", "edgeCases"],
                "additionalProperties": False,
            },
        },
        "required": ["description", "resolutionSource", "edgeCases", "rulesStructured"],
        "additionalProperties": False,
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {openai_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": os.environ.get("OPENAI_RULES_MODEL", "gpt-4o-mini"),
                    "temperature": 0.15,
                    "max_tokens": 1100,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": "market_rules_draft",
                            "strict": True,
                            "schema": schema,
                        },
                    },
                },
            )
        if response.status_code >= 400:
            raise ValueError(f"OpenAI rules draft failed with status {response.status_code}")
        data = response.json()
        text = data.get("choices", [{}])[0].get("message", {}).get("content") or ""
        draft = json.loads(text)
        structured = draft.get("rulesStructured") or {}
        condition_items = clean_rule_items(structured.get("condition"), 4)
        timing_items = clean_rule_items(structured.get("timing"), 4)
        source_items = clean_rule_items(structured.get("source"), 3)
        edge_items = clean_rule_items(structured.get("edgeCases"), 5)
        if len(condition_items) < 1 or len(timing_items) < 1 or len(source_items) < 1 or len(edge_items) < 1:
            raise ValueError("Draft had incomplete structured rules")
        source = re.sub(r"\s+", " ", str(draft.get("resolutionSource") or "").strip())
        if not source and source_items:
            source = source_items[0]
        edge_cases = re.sub(r"\s+", " ", str(draft.get("edgeCases") or " ".join(edge_items)).strip())
        description = rich_rules_to_description(condition_items, timing_items, source_items, edge_items)
        if len(description) < 80 or len(source) < 4:
            raise ValueError("Draft was too sparse")
        return {
            "description": description[:2400],
            "resolutionSource": source[:240],
            "edgeCases": edge_cases[:1000],
            "rulesStructured": {
                "condition": condition_items,
                "timing": timing_items,
                "source": source_items,
                "edgeCases": edge_items,
            },
            "generatedBy": "openai",
        }
    except Exception:
        return fallback_market_rules_draft(payload, outcomes, closes_at, "template")


# ── Helpers ────────────────────────────────────────────────────────────

def create_id() -> str:
    return uuid4().hex[:8]


def stable_id(prefix: str, *parts: object) -> str:
    raw = "|".join(str(part or "") for part in parts)
    return f"{prefix}_{hashlib.md5(raw.encode()).hexdigest()[:14]}"


def create_invite_token() -> str:
    return uuid4().hex[:18]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def close_expired_markets(db) -> None:
    now = datetime.now(timezone.utc)
    r = db.table("markets").select("id, closes_at").eq("status", "open").execute()
    for market in r.data or []:
        closes_at = parse_iso_datetime(market.get("closes_at"))
        if closes_at and closes_at <= now:
            db.table("markets").update({"status": "closed"}).eq("id", market["id"]).execute()

    try:
        er = db.table("market_events").select("id, closes_at").eq("status", "open").execute()
    except Exception:
        return
    for event in er.data or []:
        closes_at = parse_iso_datetime(event.get("closes_at"))
        if closes_at and closes_at <= now:
            db.table("market_events").update({"status": "closed"}).eq("id", event["id"]).execute()


# ── Supabase client ────────────────────────────────────────────────────

_db = None


def get_db():
    global _db
    if _db is None:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
        key = (
            os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            or os.environ.get("SUPABASE_KEY")
            or os.environ.get("VITE_SUPABASE_PUBLISHABLE_KEY")
        )
        if not url or not key:
            raise HTTPException(503, "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        if not os.environ.get("SUPABASE_SERVICE_ROLE_KEY") and os.environ.get("APP_ENV") == "production":
            raise HTTPException(503, "Production backend requires SUPABASE_SERVICE_ROLE_KEY")
        _db = create_client(url, key)
    return _db


# ── Data assembly (Supabase snake_case → frontend camelCase) ──────────

def assemble_trade(t: dict) -> dict:
    return {
        "id":          t["id"],
        "participant": t["participant"],
        "side":        t["side"],
        "amount":      t["amount"],
        "shares":      t["shares"],
        "probBefore":  t["prob_before"],
        "probAfter":   t["prob_after"],
        "createdAt":   t["created_at"],
    }


def assemble_event_trade(t: dict, outcome_lookup: dict[str, dict]) -> dict:
    outcome = outcome_lookup.get(t["outcome_id"], {})
    prices_before = t.get("prices_before") or {}
    prices_after = t.get("prices_after") or {}
    before = float(prices_before.get(t["outcome_id"], outcome.get("price") or 0))
    after = float(prices_after.get(t["outcome_id"], outcome.get("price") or 0))
    return {
        "id": t["id"],
        "participant": t["participant"],
        "side": "yes",
        "action": t["action"],
        "outcomeId": t["outcome_id"],
        "outcomeTitle": outcome.get("title"),
        "amount": t["cash_amount"],
        "shares": t["shares_delta"],
        "avgPrice": t["avg_price"],
        "probBefore": before,
        "probAfter": after,
        "pricesBefore": prices_before,
        "pricesAfter": prices_after,
        "createdAt": t["created_at"],
    }


def assemble_market_analytics(m: dict, trades_raw: list[dict]) -> dict:
    first_probability = (
        trades_raw[0].get("prob_before")
        if trades_raw and trades_raw[0].get("prob_before") is not None
        else m["probability"]
    )
    probability_history = [{
        "createdAt": m["created_at"],
        "probability": round(float(first_probability), 4),
    }]
    volume_history = [{
        "createdAt": m["created_at"],
        "volume": 0.0,
    }]

    running_volume = 0.0
    for trade in trades_raw:
        running_volume += abs(float(trade.get("amount") or 0))
        probability_history.append({
            "createdAt": trade["created_at"],
            "probability": round(float(trade.get("prob_after") or first_probability), 4),
        })
        volume_history.append({
            "createdAt": trade["created_at"],
            "volume": round(running_volume, 4),
        })

    return {
        "probabilityHistory": probability_history,
        "volumeHistory": volume_history,
        "volume": round(running_volume, 4),
        "liquidity": round(float(m["pool_yes"] or 0) + float(m["pool_no"] or 0), 4),
    }


def event_probability_history(event: dict, outcome: dict, trades_raw: list[dict]) -> list[dict]:
    history = [{
        "createdAt": event["created_at"],
        "probability": round(float(outcome.get("price") or 0), 4),
    }]
    relevant_prices: list[dict] = []
    for trade in trades_raw:
        prices_after = trade.get("prices_after") or {}
        if outcome["id"] in prices_after:
            relevant_prices.append({
                "createdAt": trade["created_at"],
                "probability": round(float(prices_after[outcome["id"]]), 4),
            })
    if relevant_prices:
        history[0]["probability"] = round(float((trades_raw[0].get("prices_before") or {}).get(outcome["id"], history[0]["probability"])), 4)
        history.extend(relevant_prices)
    return history


def assemble_event_markets(event: dict) -> list[dict]:
    outcomes = sorted(event.pop("market_outcomes", []), key=lambda x: x.get("sort_order") or 0)
    trades_raw = sorted(event.pop("event_trades", []), key=lambda x: x.get("created_at") or "")
    positions_raw = event.pop("event_positions", [])
    outcome_lookup = {outcome["id"]: outcome for outcome in outcomes}
    trades = [assemble_event_trade(trade, outcome_lookup) for trade in trades_raw]
    positions: dict[str, dict[str, float]] = {}
    for position in positions_raw:
        positions.setdefault(position["participant"], {})[position["outcome_id"]] = float(position.get("shares") or 0)

    liquidity = float(event.get("liquidity_b") or 0)
    volume = round(sum(abs(float(trade.get("cash_amount") or 0)) for trade in trades_raw), 4)
    status = event["status"]
    markets: list[dict] = []
    for outcome in outcomes:
        outcome_trades = [trade for trade in trades if trade["outcomeId"] == outcome["id"]]
        probability = round(float(outcome.get("price") or 0), 6)
        markets.append({
            "id": outcome["id"],
            "eventId": event["id"],
            "outcomeId": outcome["id"],
            "question": outcome["title"],
            "category": event["title"],
            "description": event.get("description") or "",
            "imageUrl": event.get("image_url"),
            "creator": event.get("created_by"),
            "status": status,
            "mode": event["mode"],
            "oracleType": event["oracle_type"],
            "resolutionSource": event.get("resolution_source") or "",
            "edgeCases": event.get("edge_cases") or "",
            "verificationStatus": event.get("verification_status") or "not_started",
            "verificationAttempts": event.get("verification_attempts") or [],
            "resolvedBy": event.get("resolved_by"),
            "resolutionNotes": event.get("resolution_notes"),
            "probability": probability,
            "pool_yes": None,
            "pool_no": None,
            "k": None,
            "initialLiquidity": liquidity,
            "totalBet": volume,
            "yesSharesOutstanding": round(float(outcome.get("quantity") or 0), 4),
            "noSharesOutstanding": 0,
            "closesAt": event["closes_at"],
            "createdAt": event["created_at"],
            "outcome": event.get("outcome_id"),
            "resolvedAt": event.get("resolved_at"),
            "oracleProposal": event.get("oracle_proposal"),
            "trades": outcome_trades,
            "eventTrades": trades,
            "outcomes": [
                {
                    "id": item["id"],
                    "title": item["title"],
                    "price": round(float(item.get("price") or 0), 6),
                    "quantity": round(float(item.get("quantity") or 0), 6),
                    "sortOrder": item.get("sort_order") or 0,
                }
                for item in outcomes
            ],
            "positions": positions,
            "probabilityHistory": event_probability_history(event, outcome, trades_raw),
            "volumeHistory": [
                {"createdAt": event["created_at"], "volume": 0.0},
                *[
                    {
                        "createdAt": trade["created_at"],
                        "volume": round(sum(abs(float(t.get("cash_amount") or 0)) for t in trades_raw[:idx + 1]), 4),
                    }
                    for idx, trade in enumerate(trades_raw)
                ],
            ],
            "volume": volume,
            "liquidity": liquidity,
        })
    return markets


def assemble_market(m: dict) -> dict:
    trades_raw = sorted(m.pop("trades", []), key=lambda x: x.get("created_at") or "")
    analytics = assemble_market_analytics(m, trades_raw)
    return {
        "id":                   m["id"],
        "question":             m["question"],
        "category":             m["category"],
        "description":          m.get("description") or "",
        "status":               m["status"],
        "mode":                 m["mode"],
        "oracleType":           m["oracle_type"],
        "resolutionSource":     m.get("resolution_source") or "",
        "edgeCases":            m.get("edge_cases") or "",
        "verificationStatus":   m.get("verification_status") or "not_started",
        "verificationAttempts": m.get("verification_attempts") or [],
        "resolvedBy":           m.get("resolved_by"),
        "resolutionNotes":      m.get("resolution_notes"),
        "probability":          m["probability"],
        "pool_yes":             m["pool_yes"],
        "pool_no":              m["pool_no"],
        "k":                    m["k"],
        "initialLiquidity":     m["initial_liquidity"],
        "totalBet":             m["total_bet"],
        "yesSharesOutstanding": m["yes_shares_outstanding"],
        "noSharesOutstanding":  m["no_shares_outstanding"],
        "closesAt":             m["closes_at"],
        "createdAt":            m["created_at"],
        "outcome":              m["outcome"],
        "resolvedAt":           m["resolved_at"],
        "oracleProposal":       m["oracle_proposal"],
        "trades":               [assemble_trade(t) for t in trades_raw],
        **analytics,
    }


def assemble_group(g: dict) -> dict:
    members_raw = sorted(g.pop("group_members", []), key=lambda x: x.get("joined_at") or "")
    events_raw = sorted(g.pop("market_events", []), key=lambda x: x.get("created_at") or "", reverse=True)
    markets_raw = sorted(g.pop("markets", []), key=lambda x: x.get("created_at") or "", reverse=True)
    migrated_legacy_ids = {
        outcome.get("legacy_market_id")
        for event in events_raw
        for outcome in event.get("market_outcomes", [])
        if outcome.get("legacy_market_id")
    }
    event_markets = []
    for event in events_raw:
        event_markets.extend(assemble_event_markets(event))
    legacy_markets = [
        assemble_market(market)
        for market in markets_raw
        if market.get("id") not in migrated_legacy_ids
    ]
    return {
        "id":        g["id"],
        "name":      g["name"],
        "emoji":     g["emoji"],
        "mode":      g["mode"],
        "createdAt": g["created_at"],
        "members":   [m["name"] for m in members_raw],
        "balances":  {m["name"]: m["balance"] for m in members_raw},
        "markets":   [*event_markets, *legacy_markets],
    }


def load_all_groups() -> list[dict]:
    db = get_db()
    close_expired_markets(db)
    result = db.table("groups").select(
        "*, group_members(*), market_events(*, market_outcomes(*), event_trades(*), event_positions(*)), markets(*, trades(*))"
    ).order("created_at", desc=True).execute()
    return [assemble_group(deepcopy(g)) for g in result.data]


def groups_response(**extra) -> dict:
    return {"groups": load_all_groups(), **extra}


def find_assembled_market(market_id: str) -> tuple[dict, dict, dict]:
    for group in load_all_groups():
        for market in group.get("markets", []):
            if market.get("id") == market_id or market.get("eventId") == market_id:
                event_markets = [item for item in group.get("markets", []) if item.get("eventId") == market.get("eventId")]
                event = {
                    "id": market.get("eventId") or market.get("id"),
                    "title": market.get("category") if market.get("category") != "General" else market.get("question"),
                    "description": market.get("description") or "",
                    "imageUrl": market.get("imageUrl"),
                    "volume": market.get("volume") or market.get("totalBet") or 0,
                    "closesAt": market.get("closesAt"),
                    "status": market.get("status"),
                    "markets": event_markets or [market],
                }
                return group, event, market
    raise HTTPException(404, "Market not found")


def find_assembled_event(event_id: str) -> tuple[dict, dict]:
    for group in load_all_groups():
        event_markets = [item for item in group.get("markets", []) if item.get("eventId") == event_id]
        if event_markets:
            head = event_markets[0]
            return group, {
                "id": event_id,
                "title": head.get("category") if head.get("category") != "General" else head.get("question"),
                "description": head.get("description") or "",
                "imageUrl": head.get("imageUrl"),
                "volume": head.get("volume") or head.get("totalBet") or 0,
                "closesAt": head.get("closesAt"),
                "status": head.get("status"),
                "markets": sorted(event_markets, key=lambda item: float(item.get("probability") or 0), reverse=True),
            }
    raise HTTPException(404, "Event not found")


def configured_public_base_url() -> str | None:
    explicit = (
        os.environ.get("PUBLIC_SHARE_BASE_URL")
        or os.environ.get("PUBLIC_BASE_URL")
        or os.environ.get("BACKEND_BASE_URL")
    )
    return explicit.rstrip("/") if explicit else None


def public_base_url() -> str:
    return configured_public_base_url() or "http://localhost:8000"


def request_base_url(request: Request | None) -> str | None:
    if not request:
        return None
    return str(request.base_url).rstrip("/")


def frontend_base_url(request: Request | None = None) -> str:
    explicit = os.environ.get("FRONTEND_BASE_URL") or os.environ.get("VITE_PUBLIC_APP_BASE_URL")
    if explicit:
        return explicit.rstrip("/")
    base = request_base_url(request)
    if base:
        parsed = urlparse(base)
        if parsed.port == 8000:
            netloc = parsed.hostname or "localhost"
            if parsed.username:
                netloc = f"{parsed.username}@{netloc}"
            return urlunparse((parsed.scheme, f"{netloc}:5173", "", "", "", "")).rstrip("/")
        return base
    return "http://localhost:5173"


def share_base_url(request: Request | None = None) -> str:
    return configured_public_base_url() or request_base_url(request) or public_base_url()


def is_binary_no_row(market: dict) -> bool:
    titles = {
        str(outcome.get("title") or "").strip().lower()
        for outcome in (market.get("outcomes") or [])
    }
    return titles == {"yes", "no"} and str(market.get("question") or "").strip().lower() == "no"


def share_yes_no_prices(market: dict) -> tuple[float, float]:
    selected = max(0.0, min(1.0, float(market.get("probability") or 0)))
    if is_binary_no_row(market):
        return 1 - selected, selected
    return selected, 1 - selected


def share_market_payload(market_id: str, request: Request | None = None) -> dict:
    group, event, market = find_assembled_market(market_id)
    share_base = share_base_url(request)
    app_base = frontend_base_url(request)
    yes_price, no_price = share_yes_no_prices(market)
    title = event["title"]
    outcome = market.get("question") or "Yes"
    return {
        "market": market,
        "event": event,
        "group": {"id": group["id"], "name": group["name"], "emoji": group["emoji"]},
        "share": {
            "title": f"{title}: {outcome}",
            "description": f"{round(yes_price * 100)}% Yes · {round(no_price * 100)}% No · {group['emoji']} {group['name']}",
            "url": f"{share_base}/market/{market['id']}",
            "appUrl": f"{app_base}/market/{market['id']}",
            "embedUrl": f"{share_base}/embed/market/{market['id']}",
            "imageUrl": f"{share_base}/api/markets/{market['id']}/share-card.png",
        },
    }


def esc_html(value: object) -> str:
    return (
        str(value if value is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def fmt_card_date(value: str | None) -> str:
    dt = parse_iso_datetime(value)
    if not dt:
        return "No close date"
    return dt.strftime("%b %-d, %Y")


def share_card_history_values(market: dict) -> list[float]:
    values: list[float] = []
    for point in market.get("probabilityHistory") or []:
        raw = point.get("probability", point.get("value"))
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 1:
            value = value / 100
        values.append(max(0.01, min(0.99, value)))
    if not values:
        values = [float(market.get("probability") or 0.5)]
    if len(values) == 1:
        values = [values[0], values[0]]
    if len(values) > 180:
        # Keep the same full-period shape as the app chart without bloating OG images.
        indexes = sorted({round(index * (len(values) - 1) / 179) for index in range(180)})
        values = [values[index] for index in indexes]
    return values


def share_card_yes_no_values(market: dict) -> tuple[list[float], list[float]]:
    selected_values = share_card_history_values(market)
    if is_binary_no_row(market):
        no_values = selected_values
        yes_values = [1 - value for value in selected_values]
    else:
        yes_values = selected_values
        no_values = [1 - value for value in selected_values]
    return yes_values, no_values


def share_card_chart_domain(values: list[float], *, min_range: float = 8.0, pad: float = 1.6) -> tuple[float, float, float]:
    """Mirror the frontend probabilityChartDomain() for share-card rendering.

    Input/output values are normalized 0-1 probabilities; min_range/pad are
    percentage-point values to keep this aligned with the Chart.js config.
    """
    pct_values = [
        max(0.0, min(100.0, float(value) * 100 if abs(float(value)) <= 1 else float(value)))
        for value in values
        if isinstance(value, (int, float)) and math.isfinite(float(value))
    ]
    if not pct_values:
        return 0.45, 0.55, 0.025

    low = min(pct_values)
    high = max(pct_values)
    spread = max(0.1, high - low)
    min_y = max(0.0, low - max(pad, spread * 0.18))
    max_y = min(100.0, high + max(pad, spread * 0.18))

    if max_y - min_y < min_range:
        center = (low + high) / 2
        min_y = center - min_range / 2
        max_y = center + min_range / 2
        if min_y < 0:
            max_y -= min_y
            min_y = 0.0
        if max_y > 100:
            min_y -= max_y - 100
            max_y = 100.0

    min_y = max(0.0, math.floor(min_y * 2) / 2)
    max_y = min(100.0, math.ceil(max_y * 2) / 2)
    range_y = max(1.0, max_y - min_y)
    raw_step = range_y / 4
    if raw_step <= 1:
        tick_step = 1.0
    elif raw_step <= 2:
        tick_step = 2.0
    elif raw_step <= 2.5:
        tick_step = 2.5
    elif raw_step <= 5:
        tick_step = 5.0
    else:
        tick_step = math.ceil(raw_step / 5) * 5.0
    return min_y / 100, max_y / 100, tick_step / 100


def share_card_chart_bounds(values: list[float]) -> tuple[float, float]:
    low, high, _tick_step = share_card_chart_domain(values + [1 - value for value in values])
    return low, high


def share_card_axis_label(value: float) -> str:
    pct = value * 100
    if abs(pct - round(pct)) < 0.05:
        return f"{round(pct)}%"
    return f"{pct:.1f}%"


def share_card_tick_values(low: float, high: float, tick_step: float) -> list[float]:
    if high <= low:
        return [low]
    step = tick_step or max(0.01, (high - low) / 4)
    ticks: list[float] = []
    value = low
    guard = 0
    while value <= high + 1e-9 and guard < 12:
        ticks.append(round(value, 4))
        value += step
        guard += 1
    if not ticks or abs(ticks[-1] - high) > 1e-4:
        ticks.append(round(high, 4))
    if len(ticks) > 6:
        return [low, low + (high - low) * 0.25, low + (high - low) * 0.5, low + (high - low) * 0.75, high]
    return ticks


def share_card_svg_points(values: list[float], left: int, top: int, width: int, height: int, low: float, high: float) -> str:
    denom = max(0.001, high - low)
    count = max(1, len(values) - 1)
    points: list[str] = []
    for index, value in enumerate(values):
        x = left + (width * index / count)
        y = top + height - ((value - low) / denom * height)
        points.append(f"{x:.1f},{y:.1f}")
    return " ".join(points)


def share_card_svg_grid_labels(low: float, high: float, left: int, top: int, width: int, height: int) -> str:
    rows: list[str] = []
    for frac in (0, 0.5, 1):
        y = top + (height * frac)
        value = high - ((high - low) * frac)
        rows.append(f'<line x1="{left}" y1="{y:.1f}" x2="{left + width}" y2="{y:.1f}" stroke="#26343d" stroke-dasharray="4 8"/>')
        rows.append(f'<text x="{left + width + 18}" y="{y + 8:.1f}" font-family="Arial, sans-serif" font-size="22" fill="#718290">{share_card_axis_label(value)}</text>')
    return "".join(rows)


def compact_money_text(value: float | int | None) -> str:
    n = float(value or 0)
    if n >= 1_000_000:
        return f"${n / 1_000_000:.1f}M" if n < 10_000_000 else f"${n / 1_000_000:.0f}M"
    if n >= 1_000:
        return f"${n / 1_000:.1f}K" if n < 10_000 else f"${n / 1_000:.0f}K"
    return f"${n:,.0f}"


def rounded_rectangle(draw, xy: tuple[int, int, int, int], radius: int, fill: str, outline: str | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def require_group(group_id: str) -> dict:
    db = get_db()
    r = db.table("groups").select("*").eq("id", group_id).execute()
    if not r.data:
        raise HTTPException(404, "Group not found")
    return r.data[0]


def require_invite(token: str) -> dict:
    db = get_db()
    r = db.table("group_invites").select("*").eq("token", token).execute()
    if not r.data:
        raise HTTPException(404, "Invite not found")
    return r.data[0]


def invite_is_active(invite: dict) -> bool:
    return invite.get("revoked_at") is None


def group_counts(group_id: str) -> dict:
    db = get_db()
    members = db.table("group_members").select("id").eq("group_id", group_id).execute()
    try:
        markets = db.table("market_events").select("status").eq("group_id", group_id).execute()
    except Exception:
        markets = db.table("markets").select("status").eq("group_id", group_id).execute()
    open_count = sum(1 for m in markets.data or [] if m.get("status") == "open")
    closed_count = sum(1 for m in markets.data or [] if m.get("status") in ("closed", "resolved"))
    return {
        "memberCount": len(members.data or []),
        "openCount": open_count,
        "closedCount": closed_count,
    }


def invite_preview(invite: dict) -> dict:
    group = require_group(invite["group_id"])
    return {
        "token": invite["token"],
        "groupId": invite["group_id"],
        "groupName": group["name"],
        "emoji": group["emoji"],
        "active": invite_is_active(invite),
        "createdAt": invite.get("created_at"),
        "revokedAt": invite.get("revoked_at"),
        **group_counts(invite["group_id"]),
    }


def active_invite_for_group(group_id: str) -> dict | None:
    db = get_db()
    result = (
        db.table("group_invites")
        .select("*")
        .eq("group_id", group_id)
        .is_("revoked_at", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def create_group_invite(group_id: str, created_by: str | None = None) -> dict:
    db = get_db()
    row = {
        "token": create_invite_token(),
        "group_id": group_id,
        "created_by": (created_by or "").strip() or None,
    }
    db.table("group_invites").insert(row).execute()
    return require_invite(row["token"])


def add_group_member(group_id: str, name: str) -> None:
    db = get_db()
    cleaned = name.strip()
    db.table("group_members").upsert({
        "group_id": group_id,
        "name": cleaned,
        "balance": DEFAULT_FAKE_BALANCE,
    }, on_conflict="group_id,name", ignore_duplicates=True).execute()


def legacy_event_title(market: dict) -> str:
    return market.get("category") if market.get("category") and market.get("category") != "General" else market.get("question")


def clamp_price(value: float) -> float:
    return max(0.001, min(0.999, float(value or 0)))


def event_sum_exp(outcomes: list[dict], b: float) -> float:
    return sum(math.exp(float(item.get("quantity") or 0) / b) for item in outcomes)


def lmsr_buy_shares(outcomes: list[dict], b: float, outcome_id: str, cash: float) -> float:
    if cash <= 0:
        return 0.0
    target = next((item for item in outcomes if item["id"] == outcome_id), None)
    if not target or b <= 0:
        return 0.0
    sum_exp = event_sum_exp(outcomes, b)
    target_exp = math.exp(float(target.get("quantity") or 0) / b)
    return b * math.log(1 + (sum_exp / target_exp) * (math.exp(cash / b) - 1))


def lmsr_sell_cash_for_shares(outcomes: list[dict], b: float, outcome_id: str, shares: float) -> float:
    if shares <= 0:
        return 0.0
    target = next((item for item in outcomes if item["id"] == outcome_id), None)
    if not target or b <= 0:
        return 0.0
    sum_exp = event_sum_exp(outcomes, b)
    target_exp = math.exp(float(target.get("quantity") or 0) / b)
    denominator = sum_exp - target_exp + target_exp * math.exp(-shares / b)
    if denominator <= 0:
        return 0.0
    return b * math.log(sum_exp / denominator)


def trade_net_cash(cash: float) -> float:
    return max(0.0, float(cash or 0) * (1 - MARKET_FEE_RATE))


def sell_gross_cash_for_net(net_cash: float) -> float:
    if MARKET_FEE_RATE >= 1:
        return 0.0
    return max(0.0, float(net_cash or 0) / (1 - MARKET_FEE_RATE))


def weighted_allocations(outcomes: list[dict], cash: float) -> dict[str, float]:
    if not outcomes:
        return {}
    weights = [max(0.000001, float(item.get("price") or 0)) for item in outcomes]
    total = sum(weights) or len(outcomes)
    return {
        item["id"]: round(cash * (weights[idx] / total), 4)
        for idx, item in enumerate(outcomes)
        if cash * (weights[idx] / total) > 0.0001
    }


def selected_outcome_id(payload: TradeCreate | TradeQuote, route_outcome: dict | None, outcomes: list[dict]) -> str | None:
    outcome_id = payload.outcomeId or (route_outcome or {}).get("id")
    if not outcome_id and outcomes:
        outcome_id = outcomes[0]["id"]
    return outcome_id


def event_trade_quote(event: dict, outcomes: list[dict], outcome_id: str, payload: TradeQuote, positions: dict[str, float] | None = None) -> dict:
    target = next((item for item in outcomes if item["id"] == outcome_id), None)
    if not target:
        raise HTTPException(400, "Outcome not found")
    b = float(event.get("liquidity_b") or DEFAULT_FAKE_BALANCE)
    amount = float(payload.amount or 0)
    is_complement = len(outcomes) > 2 and payload.side == "no"
    target_price = float(target.get("price") or 0)
    price = max(0.0, 1.0 - target_price) if is_complement else target_price
    fee = amount * MARKET_FEE_RATE if payload.action == "buy" else max(0.0, sell_gross_cash_for_net(amount) - amount)
    net_amount = trade_net_cash(amount) if payload.action == "buy" else amount
    quote = {
        "eventId": event["id"],
        "outcomeId": outcome_id,
        "side": payload.side,
        "action": payload.action,
        "price": round(price, 6),
        "amount": round(amount, 4),
        "isComplement": is_complement,
        "allocations": {},
        "shares": 0.0,
        "cashReceived": 0.0,
        "maxCash": 0.0,
        "feeRate": MARKET_FEE_RATE,
        "fee": round(fee, 4),
        "netAmount": round(net_amount, 4),
    }
    if amount <= 0:
        return quote
    if is_complement:
        complement = [item for item in outcomes if item["id"] != outcome_id]
        if payload.action == "buy":
            allocations = weighted_allocations(complement, amount)
            quote["allocations"] = allocations
            quote["shares"] = round(sum(lmsr_buy_shares(outcomes, b, oid, trade_net_cash(cash)) for oid, cash in allocations.items()), 8)
        else:
            holdings = positions or {}
            max_by_outcome = {
                item["id"]: trade_net_cash(lmsr_sell_cash_for_shares(outcomes, b, item["id"], float(holdings.get(item["id"], 0))))
                for item in complement
            }
            max_cash = sum(max_by_outcome.values())
            quote["maxCash"] = round(max_cash, 4)
            quote["cashReceived"] = round(min(amount, max_cash), 4)
            quote["allocations"] = weighted_allocations(
                [{"id": oid, "price": max_cash_value} for oid, max_cash_value in max_by_outcome.items() if max_cash_value > 0],
                min(amount, max_cash),
            )
        return quote
    if payload.action == "buy":
        quote["shares"] = round(lmsr_buy_shares(outcomes, b, outcome_id, trade_net_cash(amount)), 8)
    else:
        held = float((positions or {}).get(outcome_id, 0))
        max_cash = trade_net_cash(lmsr_sell_cash_for_shares(outcomes, b, outcome_id, held))
        quote["maxCash"] = round(max_cash, 4)
        quote["cashReceived"] = round(min(amount, max_cash), 4)
    return quote


def migrate_legacy_events(db) -> None:
    try:
        existing = db.table("market_events").select("legacy_key").execute()
    except Exception:
        return

    existing_keys = {row.get("legacy_key") for row in existing.data or [] if row.get("legacy_key")}

    # Skip the expensive trades join if there are no legacy markets at all.
    legacy_check = db.table("markets").select("id").limit(1).execute()
    if not legacy_check.data:
        return

    legacy = db.table("markets").select("*, trades(*)").execute()
    grouped: dict[tuple[str, str], list[dict]] = {}
    for market in legacy.data or []:
        title = legacy_event_title(market)
        if not title:
            continue
        grouped.setdefault((market["group_id"], title), []).append(market)

    for (group_id, title), markets in grouped.items():
        legacy_key = f"{group_id}:{title.lower()}"
        if legacy_key in existing_keys:
            continue

        event_id = stable_id("ev", group_id, title)
        labels = [m["question"].strip() for m in markets]
        label_keys = [label.lower() for label in labels]
        is_binary = sorted(label_keys) == ["no", "yes"]
        liquidity = max(100.0, sum(float(m.get("initial_liquidity") or 5000) for m in markets) / max(1, len(markets)))
        status = "open" if any(m.get("status") == "open" for m in markets) else ("resolved" if any(m.get("status") == "resolved" for m in markets) else "closed")
        closes_at = min((m["closes_at"] for m in markets if m.get("closes_at")), default=now_iso())
        created_at = min((m["created_at"] for m in markets if m.get("created_at")), default=now_iso())
        mode = markets[0].get("mode") or "fake"
        oracle_type = markets[0].get("oracle_type") or "ai"
        total_volume = sum(abs(float(m.get("total_bet") or 0)) for m in markets)

        prices: dict[str, float] = {}
        if is_binary:
            canonical = max(markets, key=lambda m: (float(m.get("total_bet") or 0), len(m.get("trades") or [])))
            canonical_label = canonical["question"].strip().lower()
            canonical_price = clamp_price(float(canonical.get("probability") or 0.5))
            yes_price = canonical_price if canonical_label == "yes" else 1 - canonical_price
            prices = {"yes": clamp_price(yes_price), "no": clamp_price(1 - yes_price)}
        else:
            raw = [clamp_price(float(m.get("probability") or 0)) for m in markets]
            total = sum(raw)
            prices = {m["question"].strip().lower(): clamp_price(raw[idx] / total) for idx, m in enumerate(markets)}

        price_sum = sum(prices.get(label.lower(), 0) for label in labels) or 1
        for label in labels:
            prices[label.lower()] = clamp_price(prices.get(label.lower(), 1 / len(labels)) / price_sum)

        db.table("market_events").insert({
            "id": event_id,
            "group_id": group_id,
            "title": title,
            "description": "",
            "status": status,
            "mode": mode,
            "oracle_type": oracle_type,
            "liquidity_b": liquidity,
            "total_volume": round(total_volume, 4),
            "closes_at": closes_at,
            "created_at": created_at,
            "legacy_key": legacy_key,
        }).execute()

        outcome_by_legacy: dict[str, str] = {}
        outcome_by_label: dict[str, str] = {}
        outcome_rows = []
        for idx, market in enumerate(markets):
            label = market["question"].strip()
            price = prices.get(label.lower(), 1 / len(markets))
            outcome_id = stable_id("out", event_id, label)
            outcome_by_legacy[market["id"]] = outcome_id
            outcome_by_label[label.lower()] = outcome_id
            outcome_rows.append({
                "id": outcome_id,
                "event_id": event_id,
                "title": label,
                "sort_order": idx,
                "quantity": round(liquidity * math.log(max(price, 0.001)), 8),
                "price": round(price, 8),
                "legacy_market_id": market["id"],
                "created_at": market.get("created_at") or created_at,
            })
        db.table("market_outcomes").insert(outcome_rows).execute()

        position_totals: dict[tuple[str, str], float] = {}
        trade_rows = []
        for market in markets:
            label = market["question"].strip().lower()
            for trade in sorted(market.get("trades") or [], key=lambda x: x.get("created_at") or ""):
                side = trade.get("side")
                if is_binary and side == "no":
                    target_label = "no" if label == "yes" else "yes"
                else:
                    target_label = label
                outcome_id = outcome_by_label.get(target_label)
                if not outcome_id:
                    continue
                prob_before = clamp_price(float(trade.get("prob_before") if trade.get("prob_before") is not None else market.get("probability") or 0.5))
                prob_after = clamp_price(float(trade.get("prob_after") if trade.get("prob_after") is not None else market.get("probability") or 0.5))
                if is_binary:
                    yes_before = prob_before if label == "yes" else 1 - prob_before
                    yes_after = prob_after if label == "yes" else 1 - prob_after
                    prices_before = {outcome_by_label["yes"]: round(yes_before, 6), outcome_by_label["no"]: round(1 - yes_before, 6)}
                    prices_after = {outcome_by_label["yes"]: round(yes_after, 6), outcome_by_label["no"]: round(1 - yes_after, 6)}
                else:
                    prices_before = {row["id"]: row["price"] for row in outcome_rows}
                    prices_after = {**prices_before, outcome_id: round(prob_after, 6)}
                shares = float(trade.get("shares") or 0)
                if float(trade.get("amount") or 0) < 0:
                    shares = -abs(shares)
                position_totals[(trade["participant"], outcome_id)] = position_totals.get((trade["participant"], outcome_id), 0.0) + shares
                cash_amount = abs(float(trade.get("amount") or 0))
                trade_rows.append({
                    "id": stable_id("tr", trade["id"]),
                    "event_id": event_id,
                    "outcome_id": outcome_id,
                    "participant": trade["participant"],
                    "action": "sell" if float(trade.get("amount") or 0) < 0 else "buy",
                    "cash_amount": round(cash_amount, 4),
                    "shares_delta": round(shares, 8),
                    "avg_price": round(cash_amount / abs(shares), 8) if shares else 0,
                    "prices_before": prices_before,
                    "prices_after": prices_after,
                    "created_at": trade.get("created_at") or now_iso(),
                })
        if trade_rows:
            db.table("event_trades").insert(trade_rows).execute()
        position_rows = [
            {
                "event_id": event_id,
                "outcome_id": outcome_id,
                "participant": participant,
                "shares": round(shares, 8),
            }
            for (participant, outcome_id), shares in position_totals.items()
            if abs(shares) > 1e-8
        ]
        if position_rows:
            db.table("event_positions").insert(position_rows).execute()
        db.rpc("probable_reprice_event", {"p_event_id": event_id}).execute()


def require_market(market_id: str) -> dict:
    """Return the raw Supabase market row (no trades)."""
    db = get_db()
    close_expired_markets(db)
    r = db.table("markets").select("*").eq("id", market_id).execute()
    if not r.data:
        raise HTTPException(404, "Market not found")
    return r.data[0]


def require_event_or_outcome(market_or_event_id: str) -> tuple[dict, dict | None]:
    db = get_db()
    close_expired_markets(db)
    event_res = db.table("market_events").select("*").eq("id", market_or_event_id).execute()
    if event_res.data:
        return event_res.data[0], None

    outcome_res = db.table("market_outcomes").select("*, market_events(*)").eq("id", market_or_event_id).execute()
    if outcome_res.data:
        outcome = outcome_res.data[0]
        event = outcome.pop("market_events")
        return event, outcome

    legacy_res = db.table("market_outcomes").select("*, market_events(*)").eq("legacy_market_id", market_or_event_id).execute()
    if legacy_res.data:
        outcome = legacy_res.data[0]
        event = outcome.pop("market_events")
        return event, outcome

    raise HTTPException(404, "Market not found")


def _credit_winners(db, group_id: str, market: dict, trades: list[dict]) -> None:
    outcome = market["outcome"]
    key = "yes_shares_outstanding" if outcome == "yes" else "no_shares_outstanding"
    total_winning = market[key]
    if total_winning <= 0:
        return
    total_pot = market["total_bet"]

    net_by_participant: dict[str, float] = {}
    for trade in trades:
        if trade["side"] != outcome:
            continue
        participant = trade["participant"]
        net_by_participant[participant] = net_by_participant.get(participant, 0.0) + float(trade["shares"] or 0)

    for participant, shares in net_by_participant.items():
        if shares <= 0:
            continue
        payout = round((shares / total_winning) * total_pot, 2)
        bres = db.table("group_members").select("balance").eq("group_id", group_id).eq("name", participant).execute()
        if bres.data:
            new_bal = round(bres.data[0]["balance"] + payout, 2)
            db.table("group_members").update({"balance": new_bal}).eq("group_id", group_id).eq("name", participant).execute()


def legacy_settlement_payload(market: dict, outcome: str, trades: list[dict], resolved_by: str, notes: str | None) -> dict:
    key = "yes_shares_outstanding" if outcome == "yes" else "no_shares_outstanding"
    total_winning = float(market.get(key) or 0)
    total_pot = float(market.get("total_bet") or 0)
    net_by_participant: dict[str, float] = {}
    for trade in trades:
        if trade.get("side") != outcome:
            continue
        participant = trade["participant"]
        direction = -1 if trade.get("action") == "sell" else 1
        net_by_participant[participant] = net_by_participant.get(participant, 0.0) + direction * float(trade.get("shares") or 0)
    payouts = []
    for participant, shares in sorted(net_by_participant.items()):
        if shares <= 0 or total_winning <= 0:
            continue
        payout = round((shares / total_winning) * total_pot, 2)
        payouts.append({
            "participant": participant,
            "shares": round(shares, 8),
            "payout": payout,
        })
    return {
        "eventId": market["id"],
        "outcomeId": outcome,
        "outcomeTitle": outcome.upper(),
        "resolvedBy": resolved_by,
        "resolutionNotes": notes or f"Manually resolved to {outcome.upper()}.",
        "resolvedAt": now_iso(),
        "payouts": payouts,
        "totalPaid": round(sum(item["payout"] for item in payouts), 2),
    }


def rpc_error_message(exc: Exception) -> str:
    first_arg = exc.args[0] if exc.args else None
    if isinstance(first_arg, dict) and first_arg.get("message"):
        return first_arg["message"]
    return str(exc)


def resolve_event_market_rpc(
    db,
    event_id: str,
    outcome_id: str,
    *,
    resolved_by: str = "manual",
    notes: str | None = None,
    proposal: dict | None = None,
) -> dict:
    try:
        result = db.rpc("resolve_event_market", {
            "p_event_id": event_id,
            "p_outcome_id": outcome_id,
            "p_resolved_by": (resolved_by or "manual").strip()[:80] or "manual",
            "p_resolution_notes": (notes or "").strip()[:1200] or None,
            "p_oracle_proposal": proposal,
        }).execute()
    except Exception as exc:
        raise HTTPException(400, rpc_error_message(exc)) from exc
    return result.data or {}


# ── Lifespan ───────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app_: FastAPI):
    try:
        db = get_db()
        close_expired_markets(db)
        migrate_legacy_events(db)
    except Exception as exc:
        print(f"Startup warning: {exc}")
    yield


# ── FastAPI app ────────────────────────────────────────────────────────

def allowed_cors_origins() -> list[str]:
    configured = os.environ.get("ALLOWED_ORIGINS", "")
    origins = [origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()]
    if origins:
        return origins
    return [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://10.100.58.5:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "http://10.100.58.5:5174",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "http://10.100.58.5:4173",
    ]


app = FastAPI(title="Probable API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_cors_origins(),
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/groups")
def list_groups() -> dict:
    return groups_response()


@app.post("/api/groups", status_code=201)
def create_group(payload: GroupCreate) -> dict:
    db = get_db()
    cleaned = [m.strip() for m in payload.members if m.strip()]
    if not cleaned:
        raise HTTPException(400, "At least one member is required")

    group_id = create_id()
    db.table("groups").insert({
        "id":    group_id,
        "name":  payload.name.strip(),
        "emoji": payload.emoji.strip() or "📣",
        "mode":  payload.mode,
    }).execute()

    db.table("group_members").insert([
        {"group_id": group_id, "name": m, "balance": DEFAULT_FAKE_BALANCE}
        for m in cleaned
    ]).execute()

    return groups_response(groupId=group_id)


@app.post("/api/groups/{group_id}/join")
def join_group(group_id: str, payload: JoinGroup) -> dict:
    require_group(group_id)
    name = payload.name.strip()
    add_group_member(group_id, name)
    return groups_response(groupId=group_id, memberName=name)


@app.get("/api/invites/{token}")
def get_invite(token: str) -> dict:
    invite = require_invite(token)
    return {"invite": invite_preview(invite)}


@app.post("/api/groups/{group_id}/invites", status_code=201)
def create_or_get_group_invite(group_id: str, payload: InviteCreate | None = None) -> dict:
    require_group(group_id)
    invite = active_invite_for_group(group_id)
    if not invite:
        invite = create_group_invite(group_id, payload.createdBy if payload else None)
    return {"invite": invite_preview(invite)}


@app.post("/api/groups/{group_id}/invites/regenerate", status_code=201)
def regenerate_group_invite(group_id: str, payload: InviteCreate | None = None) -> dict:
    db = get_db()
    require_group(group_id)
    db.table("group_invites").update({"revoked_at": now_iso()}).eq("group_id", group_id).is_("revoked_at", "null").execute()
    invite = create_group_invite(group_id, payload.createdBy if payload else None)
    return {"invite": invite_preview(invite)}


@app.post("/api/invites/{token}/join")
def join_group_with_invite(token: str, payload: InviteJoin) -> dict:
    invite = require_invite(token)
    if not invite_is_active(invite):
        raise HTTPException(410, "Invite link has been revoked")

    name = payload.name.strip()
    add_group_member(invite["group_id"], name)
    return groups_response(groupId=invite["group_id"], memberName=name, invite=invite_preview(invite))


@app.post("/api/markets/rules/draft")
async def draft_market_rules(payload: MarketRulesDraft) -> dict:
    question = clean_market_question(payload.question)
    outcomes = normalize_outcomes(payload.outcomes)
    closes_at = parse_iso_datetime(payload.closesAt) if payload.closesAt else None
    draft_payload = payload.model_copy(update={"question": question, "outcomes": outcomes})
    draft = await ai_market_rules_draft(draft_payload, outcomes, closes_at)
    return {"draft": draft}


@app.post("/api/groups/{group_id}/markets", status_code=201)
def create_market(group_id: str, payload: MarketCreate) -> dict:
    db = get_db()
    group = require_group(group_id)
    event_title = clean_market_question(payload.question)
    description = clean_market_description(payload)
    outcomes = normalize_outcomes(payload.outcomes)

    closes_at = parse_iso_datetime(payload.closesAt)
    if not closes_at:
        raise HTTPException(400, "Invalid closesAt value")
    if closes_at <= datetime.now(timezone.utc):
        raise HTTPException(400, "Closes at must be in the future")

    event_id = create_id()
    event_row = {
        "id": event_id,
        "group_id": group_id,
        "title": event_title,
        "description": description,
        "resolution_source": (payload.resolutionSource or "").strip() or None,
        "edge_cases": (payload.edgeCases or "").strip() or None,
        "verification_status": "not_started",
        "verification_attempts": [],
        "mode": group["mode"],
        "oracle_type": payload.oracleType,
        "liquidity_b": payload.initialLiquidity,
        "total_volume": 0.0,
        "closes_at": closes_at.isoformat(),
    }
    if payload.imageUrl:
        event_row["image_url"] = payload.imageUrl.strip()
    if payload.createdBy:
        event_row["created_by"] = payload.createdBy.strip()
    if payload.slug:
        event_row["slug"] = payload.slug.strip()

    for _ in range(6):
        try:
            db.table("market_events").insert(event_row).execute()
            break
        except Exception as exc:
            message = str(exc)
            removed = False
            for optional_column in (
                "image_url",
                "created_by",
                "slug",
                "resolution_source",
                "edge_cases",
                "verification_status",
                "verification_attempts",
            ):
                if optional_column in message and optional_column in event_row:
                    event_row.pop(optional_column, None)
                    removed = True
            if not removed:
                raise

    equal_price = 1.0 / len(outcomes)
    outcome_rows = []
    for idx, outcome in enumerate(outcomes):
        outcome_rows.append({
            "id": create_id(),
            "event_id": event_id,
            "title": outcome,
            "sort_order": idx,
            "quantity": round(payload.initialLiquidity * math.log(equal_price), 8),
            "price": round(equal_price, 8),
        })

    db.table("market_outcomes").insert(outcome_rows).execute()
    db.rpc("probable_reprice_event", {"p_event_id": event_id}).execute()

    return groups_response(marketId=outcome_rows[0]["id"], eventId=event_id, marketIds=[row["id"] for row in outcome_rows])


@app.get("/api/markets/{market_id}/share")
def get_market_share_payload(market_id: str, request: Request) -> dict:
    return share_market_payload(market_id, request)


@app.get("/api/events/{event_id}/share")
def get_event_share_payload(event_id: str, request: Request) -> dict:
    group, event = find_assembled_event(event_id)
    share_base = share_base_url(request)
    app_base = frontend_base_url(request)
    return {
        "event": event,
        "group": {"id": group["id"], "name": group["name"], "emoji": group["emoji"]},
        "share": {
            "title": event["title"],
            "description": f"{len(event['markets'])} outcomes · {group['emoji']} {group['name']}",
            "url": f"{share_base}/market/{event['markets'][0]['id']}",
            "appUrl": f"{app_base}/market/{event['markets'][0]['id']}",
            "embedUrl": f"{share_base}/embed/event/{event_id}",
            "imageUrl": f"{share_base}/api/markets/{event['markets'][0]['id']}/share-card.png",
        },
    }


@app.post("/api/markets/{market_id}/quote")
def quote_market_trade(market_id: str, payload: TradeQuote) -> dict:
    db = get_db()
    event, route_outcome = require_event_or_outcome(market_id)
    outcomes = db.table("market_outcomes").select("*").eq("event_id", event["id"]).order("sort_order").execute().data or []
    outcome_id = selected_outcome_id(payload, route_outcome, outcomes)
    if not outcome_id:
        raise HTTPException(400, "Choose an outcome to quote")
    positions: dict[str, float] = {}
    if payload.participant:
        rows = (
            db.table("event_positions")
            .select("outcome_id, shares")
            .eq("event_id", event["id"])
            .eq("participant", payload.participant.strip())
            .execute()
            .data or []
        )
        positions = {row["outcome_id"]: float(row.get("shares") or 0) for row in rows}
    return {"quote": event_trade_quote(event, outcomes, outcome_id, payload, positions)}


@app.get("/api/markets/{market_id}/share-card.svg")
def market_share_card_svg(market_id: str, request: Request) -> Response:
    payload = share_market_payload(market_id, request)
    market = payload["market"]
    event = payload["event"]
    group = payload["group"]
    yes_price, no_price = share_yes_no_prices(market)
    yes = round(yes_price * 100)
    no = round(no_price * 100)
    volume = float(market.get("volume") or market.get("totalBet") or 0)
    yes_values, no_values = share_card_yes_no_values(market)
    low, high = share_card_chart_bounds(yes_values)
    title = esc_html(event["title"])[:72]
    outcome = esc_html(market.get("question") or "Yes")[:40]
    group_name = esc_html(f"{group['emoji']} {group['name']}")
    closes = esc_html(fmt_card_date(market.get("closesAt")))
    yes_values, no_values = share_card_yes_no_values(market)
    low, high = share_card_chart_bounds(yes_values)
    chart_left, chart_top, chart_width, chart_height = 120, 286, 760, 184
    yes_points = share_card_svg_points(yes_values, chart_left, chart_top, chart_width, chart_height, low, high)
    no_points = share_card_svg_points(no_values, chart_left, chart_top, chart_width, chart_height, low, high)
    yes_dot = yes_points.split(" ")[-1]
    no_dot = no_points.split(" ")[-1]
    grid = share_card_svg_grid_labels(low, high, chart_left, chart_top, chart_width, chart_height)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#071018"/><stop offset="0.55" stop-color="#101920"/><stop offset="1" stop-color="#061f3b"/></linearGradient>
    <linearGradient id="card" x1="0" x2="1"><stop stop-color="#152128"/><stop offset="1" stop-color="#101820"/></linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="80" y="70" width="1040" height="490" rx="34" fill="url(#card)" stroke="#2b3944" stroke-width="2"/>
  <text x="120" y="130" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#f3f7fa">probable<tspan fill="#145ca8">.</tspan></text>
  <text x="120" y="178" font-family="Arial, sans-serif" font-size="23" fill="#8fa0ad">{group_name}</text>
  <text x="120" y="236" font-family="Arial, sans-serif" font-size="50" font-weight="800" fill="#f5f8fb">{title}</text>
  <text x="120" y="270" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#b7c3cc">{outcome}</text>
  {grid}
  <polyline points="{no_points}" fill="none" stroke="#f23645" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="{yes_points}" fill="none" stroke="#2d9cff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="{yes_dot.split(',')[0]}" cy="{yes_dot.split(',')[1]}" r="18" fill="#2d9cff" opacity="0.22" filter="url(#glow)"/>
  <circle cx="{yes_dot.split(',')[0]}" cy="{yes_dot.split(',')[1]}" r="8" fill="#79bdff"/>
  <circle cx="{no_dot.split(',')[0]}" cy="{no_dot.split(',')[1]}" r="18" fill="#f23645" opacity="0.18" filter="url(#glow)"/>
  <circle cx="{no_dot.split(',')[0]}" cy="{no_dot.split(',')[1]}" r="8" fill="#ff6671"/>
  <text x="918" y="335" font-family="Arial, sans-serif" font-size="54" font-weight="800" fill="#2d9cff">{yes}%</text>
  <text x="918" y="374" font-family="Arial, sans-serif" font-size="22" fill="#8fa0ad">Yes</text>
  <text x="918" y="438" font-family="Arial, sans-serif" font-size="54" font-weight="800" fill="#f23645">{no}%</text>
  <text x="918" y="477" font-family="Arial, sans-serif" font-size="22" fill="#8fa0ad">No</text>
  <text x="120" y="520" font-family="Arial, sans-serif" font-size="26" fill="#8fa0ad">${volume:,.0f} Vol. · Closes {closes}</text>
  <rect x="900" y="498" width="170" height="50" rx="15" fill="#145ca8"/>
  <text x="936" y="531" font-family="Arial, sans-serif" font-size="21" font-weight="800" fill="#fff">Trade now</text>
</svg>"""
    return Response(svg, media_type="image/svg+xml")


@app.get("/api/markets/{market_id}/share-card")
def market_share_card(market_id: str, request: Request) -> Response:
    return market_share_card_svg(market_id, request)


@app.get("/api/markets/{market_id}/share-card.png")
def market_share_card_png(market_id: str, request: Request) -> Response:
    try:
        from PIL import Image, ImageDraw, ImageFont, ImageOps
    except Exception as exc:
        raise HTTPException(503, "PNG share cards require Pillow. Run pip install -r requirements.txt") from exc

    payload = share_market_payload(market_id, request)
    market = payload["market"]
    event = payload["event"]
    group = payload["group"]
    yes_price, no_price = share_yes_no_prices(market)
    yes = round(yes_price * 100)
    no = round(no_price * 100)
    volume = float(market.get("volume") or market.get("totalBet") or 0)
    yes_values, no_values = share_card_yes_no_values(market)
    low, high, tick_step = share_card_chart_domain(yes_values + no_values, min_range=8, pad=1.6)

    def font(size: int, bold: bool = False):
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
        for path in candidates:
            try:
                if path and Path(path).exists():
                    return ImageFont.truetype(path, size)
            except Exception:
                continue
        return ImageFont.load_default()

    def truncate(draw, text: str, max_width: int, fnt) -> str:
        value = text
        while value and draw.textlength(value, font=fnt) > max_width:
            value = value[:-2].rstrip() + "…"
        return value

    def wrap_lines(draw, text: str, max_width: int, fnt, max_lines: int = 2) -> list[str]:
        words = str(text or "").split()
        lines: list[str] = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if not current or draw.textlength(candidate, font=fnt) <= max_width:
                current = candidate
                continue
            lines.append(current)
            current = word
            if len(lines) >= max_lines:
                break
        if current and len(lines) < max_lines:
            lines.append(current)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
        if len(lines) == max_lines:
            lines[-1] = truncate(draw, lines[-1], max_width, fnt)
        return lines or [""]

    def chart_points(values: list[float], left: int, top: int, width: int, height: int) -> list[tuple[float, float]]:
        denom = max(0.001, high - low)
        count = max(1, len(values) - 1)
        return [
            (
                left + (width * index / count),
                top + height - ((value - low) / denom * height),
            )
            for index, value in enumerate(values)
        ]

    def draw_line(points: list[tuple[float, float]], color: str, width: int = 5) -> None:
        if len(points) < 2:
            return
        draw.line(points, fill=color, width=width, joint="curve")

    def load_thumb(size: int = 58):
        image_url = event.get("imageUrl") or market.get("imageUrl") or ""
        raw: bytes | None = None
        if isinstance(image_url, str) and image_url.startswith("data:image") and "," in image_url:
            try:
                raw = base64.b64decode(image_url.split(",", 1)[1])
            except Exception:
                raw = None
        elif isinstance(image_url, str) and image_url.startswith("/"):
            path = BASE_DIR / "public" / image_url.lstrip("/")
            if path.exists():
                raw = path.read_bytes()
        elif isinstance(image_url, str) and image_url.startswith(("http://", "https://")):
            try:
                response = httpx.get(image_url, timeout=5)
                if response.status_code < 400:
                    raw = response.content
            except Exception:
                raw = None
        if not raw:
            fallback = BASE_DIR / "public" / "ball.png"
            if fallback.exists():
                raw = fallback.read_bytes()
        if not raw:
            return None
        try:
            thumb = Image.open(io.BytesIO(raw)).convert("RGB")
            return ImageOps.fit(thumb, (size, size), method=Image.Resampling.LANCZOS)
        except Exception:
            return None

    def paste_rounded(base, thumb, xy: tuple[int, int], radius: int = 12):
        if thumb is None:
            return
        mask = Image.new("L", thumb.size, 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.rounded_rectangle((0, 0, thumb.size[0], thumb.size[1]), radius=radius, fill=255)
        base.paste(thumb, xy, mask)

    image = Image.new("RGB", (1200, 630), "#071018")
    draw = ImageDraw.Draw(image)
    for y in range(630):
        shade = int(9 + y / 630 * 18)
        draw.line((0, y, 1200, y), fill=(4, shade, min(36, shade + 14)))

    card_x, card_y, card_w, card_h = 290, 20, 620, 590
    draw.rounded_rectangle((card_x + 12, card_y + 18, card_x + card_w + 12, card_y + card_h + 18), radius=26, fill="#03070a")
    draw.rounded_rectangle((card_x, card_y, card_x + card_w, card_y + card_h), radius=24, fill="#101820", outline="#2b3944", width=3)

    pad = 30
    left = card_x + pad
    right = card_x + card_w - pad
    draw.text((left, card_y + 30), "probable.", fill="#f3f7fa", font=font(29, True))

    thumb_size = 58
    thumb_x, thumb_y = left, card_y + 92
    draw.rounded_rectangle((thumb_x - 2, thumb_y - 2, thumb_x + thumb_size + 2, thumb_y + thumb_size + 2), radius=14, fill="#1c2a34")
    paste_rounded(image, load_thumb(thumb_size), (thumb_x, thumb_y), radius=12)

    head_x = thumb_x + thumb_size + 18
    draw.text((head_x, thumb_y + 2), str(group["name"]), fill="#8fa0ad", font=font(22, False))
    title_font = font(25, True)
    title_lines = wrap_lines(draw, event["title"], right - head_x, title_font, max_lines=2)
    for index, line in enumerate(title_lines):
        draw.text((head_x, thumb_y + 30 + index * 31), line, fill="#f3f7fa", font=title_font)
    outcome_y = thumb_y + 30 + len(title_lines) * 31 + 2
    draw.text((head_x, outcome_y), truncate(draw, market.get("question") or "Yes", right - head_x, font(20, False)), fill="#8fa0ad", font=font(20, False))

    prob_y = max(card_y + 200, outcome_y + 34)
    draw.text((left, prob_y), f"Yes {yes}%", fill="#2d9cff", font=font(23, True))
    draw.text((left + 110, prob_y), f"No {no}%", fill="#ff4d5a", font=font(23, True))

    chart_left, chart_top, chart_width, chart_height = left + 30, prob_y + 52, 430, 145
    denom = max(0.001, high - low)
    for value in reversed(share_card_tick_values(low, high, tick_step)):
        row_y = chart_top + ((high - value) / denom * chart_height)
        draw.line((chart_left, row_y, chart_left + chart_width, row_y), fill="#26343d", width=1)
        draw.text((chart_left + chart_width + 8, row_y - 9), share_card_axis_label(value), fill="#748593", font=font(16, False))
    draw.text((chart_left - 24, chart_top + chart_height + 16), "Jun 20", fill="#526472", font=font(16, False))
    draw.text((chart_left + 96, chart_top + chart_height + 16), "Jun 20", fill="#526472", font=font(16, False))
    draw.text((chart_left + 216, chart_top + chart_height + 16), "Jun 20", fill="#526472", font=font(16, False))

    yes_points = chart_points(yes_values, chart_left, chart_top, chart_width, chart_height)
    no_points = chart_points(no_values, chart_left, chart_top, chart_width, chart_height)
    draw_line(no_points, "#ff4d5a", width=4)
    draw_line(yes_points, "#2d9cff", width=4)
    for points, outer, inner in ((yes_points, "#174268", "#2d9cff"), (no_points, "#4a1e28", "#ff4d5a")):
        x, y = points[-1]
        draw.ellipse((x - 15, y - 15, x + 15, y + 15), fill=outer)
        draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill=inner)

    row_y = chart_top + chart_height + 30
    for label, color, pct in (("Yes", "#2d9cff", yes), ("No", "#ff4d5a", no)):
        draw.ellipse((left, row_y + 8, left + 10, row_y + 18), fill=color)
        draw.text((left + 22, row_y), label, fill="#9fb0bd", font=font(23, False))
        pct_text = f"{pct}%"
        draw.text((right - draw.textlength(pct_text, font=font(25, True)), row_y - 1), pct_text, fill="#f4f7fa", font=font(25, True))
        row_y += 38

    button_y, button_h, gap = card_y + card_h - 54, 44, 12
    line_y = button_y - 36
    foot_y = button_y - 22
    draw.line((left, line_y, right, line_y), fill="#26343d", width=1)
    draw.text((left, foot_y), f"{compact_money_text(volume)} Vol.", fill="#8fa0ad", font=font(20, False))
    close_text = f"Closes {fmt_card_date(market.get('closesAt'))}"
    draw.text((right - draw.textlength(close_text, font=font(20, False)), foot_y), close_text, fill="#8fa0ad", font=font(20, False))

    button_w = (card_w - pad * 2 - gap) // 2
    draw.rounded_rectangle((left, button_y, left + button_w, button_y + button_h), radius=12, fill="#0b2942")
    draw.rounded_rectangle((left + button_w + gap, button_y, right, button_y + button_h), radius=12, fill="#321c24")
    yes_btn = f"Yes {yes}¢"
    no_btn = f"No {no}¢"
    draw.text((left + button_w / 2 - draw.textlength(yes_btn, font=font(20, True)) / 2, button_y + 12), yes_btn, fill="#145ca8", font=font(20, True))
    draw.text((left + button_w + gap + button_w / 2 - draw.textlength(no_btn, font=font(20, True)) / 2, button_y + 12), no_btn, fill="#ff4d5a", font=font(20, True))

    output = io.BytesIO()
    image.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png")


def embed_market_html(market: dict, event: dict, group: dict, *, chart: bool = True, buttons: bool = True, dark: bool = True, border: bool = True, app_base: str | None = None) -> str:
    yes_price, no_price = share_yes_no_prices(market)
    yes = round(yes_price * 100)
    no = round(no_price * 100)
    bg = "#101820" if dark else "#ffffff"
    fg = "#f4f7fa" if dark else "#121417"
    muted = "#8fa0ad" if dark else "#66717b"
    line = "#2b3944" if dark else "#d9e0e6"
    border_css = f"border:1px solid {line};" if border else ""
    chart_html = ""
    if chart:
        yes_values, _no_values = share_card_yes_no_values(market)
        points = " ".join(f"{80 + idx * 44},{160 - (float(value or 0) * 120)}" for idx, value in enumerate(yes_values[-8:]))
        if not points:
            points = f"80,{160 - yes * 1.2} 388,{160 - yes * 1.2}"
        chart_html = f"""<svg class="chart" viewBox="0 0 480 180" aria-hidden="true"><path d="M40 35H440M40 90H440M40 145H440" stroke="{line}" stroke-dasharray="3 5"/><polyline points="{points}" fill="none" stroke="#2d9cff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>"""
    app_market_url = f"{(app_base or frontend_base_url()).rstrip('/')}/market/{market['id']}"
    buttons_html = f"""<div class="buttons"><a class="yes" href="{app_market_url}" target="_blank">Yes {yes}¢</a><a class="no" href="{app_market_url}" target="_blank">No {no}¢</a></div>""" if buttons else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>
body{{margin:0;background:transparent;font-family:Inter,Arial,sans-serif;color:{fg};}}.wrap{{box-sizing:border-box;width:100%;min-height:100vh;background:{bg};{border_css}border-radius:18px;padding:18px;overflow:hidden}}.brand{{font-weight:800;margin-bottom:12px}}.brand span{{color:#145ca8}}.meta{{color:{muted};font-size:13px;margin:0 0 6px}}h1{{font-size:20px;line-height:1.15;margin:0 0 8px}}.prob{{display:flex;gap:14px;font-weight:800;margin:12px 0}}.prob .yes{{color:#2d9cff}}.prob .no{{color:#f23645}}.chart{{width:100%;height:150px;display:block;margin:6px 0 12px}}.foot{{display:flex;justify-content:space-between;color:{muted};font-size:13px;border-top:1px solid {line};padding-top:10px}}.buttons{{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}}.buttons a{{text-decoration:none;text-align:center;border-radius:10px;padding:10px 8px;font-weight:800}}.buttons .yes{{background:#143f2b;color:#38d274}}.buttons .no{{background:#411d23;color:#ff626a}}</style></head><body><main class="wrap"><div class="brand">probable<span>.</span></div><p class="meta">{esc_html(group['emoji'])} {esc_html(group['name'])}</p><h1>{esc_html(event['title'])}</h1><p class="meta">{esc_html(market.get('question') or 'Yes')}</p><div class="prob"><span class="yes">Yes {yes}%</span><span class="no">No {no}%</span></div>{chart_html}<div class="foot"><span>${float(market.get('volume') or 0):,.0f} Vol.</span><span>{esc_html(fmt_card_date(market.get('closesAt')))}</span></div>{buttons_html}</main></body></html>"""


@app.get("/embed/market/{market_id}", response_class=HTMLResponse)
def embed_market(market_id: str, request: Request, chart: int = 1, buttons: int = 1, dark: int = 1, border: int = 1) -> str:
    group, event, market = find_assembled_market(market_id)
    return embed_market_html(market, event, group, chart=bool(chart), buttons=bool(buttons), dark=bool(dark), border=bool(border), app_base=frontend_base_url(request))


@app.get("/embed/event/{event_id}", response_class=HTMLResponse)
def embed_event(event_id: str, request: Request, chart: int = 1, buttons: int = 1, dark: int = 1, border: int = 1) -> str:
    group, event = find_assembled_event(event_id)
    market = event["markets"][0]
    return embed_market_html(market, event, group, chart=bool(chart), buttons=bool(buttons), dark=bool(dark), border=bool(border), app_base=frontend_base_url(request))


@app.get("/market/{market_id}", response_class=HTMLResponse)
def market_open_graph_page(market_id: str, request: Request) -> str:
    payload = share_market_payload(market_id, request)
    share = payload["share"]
    app_url = share.get("appUrl") or share["url"]
    return f"""<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{esc_html(share['title'])} · Probable</title>
<meta name="description" content="{esc_html(share['description'])}"/>
<meta property="og:type" content="website"/><meta property="og:site_name" content="Probable"/>
<meta property="og:title" content="{esc_html(share['title'])}"/>
<meta property="og:description" content="{esc_html(share['description'])}"/>
<meta property="og:image" content="{esc_html(share['imageUrl'])}"/>
<meta property="og:url" content="{esc_html(share['url'])}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="{esc_html(share['title'])}"/>
<meta name="twitter:description" content="{esc_html(share['description'])}"/>
<meta name="twitter:image" content="{esc_html(share['imageUrl'])}"/>
<style>body{{margin:0;background:#0d1216;color:#f4f7fa;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}}a{{background:#145ca8;color:white;text-decoration:none;padding:14px 18px;border-radius:12px;font-weight:800}}main{{max-width:560px;padding:28px;text-align:center}}img{{width:100%;border-radius:18px;border:1px solid #2b3944}}</style></head><body><main><img src="{esc_html(share['imageUrl'])}" alt="Market preview"/><h1>{esc_html(share['title'])}</h1><p>{esc_html(share['description'])}</p><a href="{esc_html(app_url)}">Open market</a></main></body></html>"""


@app.post("/api/markets/{market_id}/trade")
def place_trade(market_id: str, payload: TradeCreate) -> dict:
    db = get_db()
    event, route_outcome = require_event_or_outcome(market_id)
    outcomes = db.table("market_outcomes").select("*").eq("event_id", event["id"]).order("sort_order").execute().data or []

    if payload.action == "buy":
        b = float(event.get("liquidity_b") or DEFAULT_FAKE_BALANCE)
        cap = b / 2
        if float(payload.amount) > cap:
            raise HTTPException(
                400,
                f"Max single trade is {cap:,.0f} pts (½ of market liquidity — "
                f"split into smaller trades to move the price further).",
            )

    explicit_outcome = bool(payload.outcomeId)
    outcome_id = selected_outcome_id(payload, route_outcome, outcomes)
    if not outcome_id:
        if len(outcomes) == 2 and payload.side == "no":
            outcome_id = outcomes[1]["id"]
        elif outcomes:
            outcome_id = outcomes[0]["id"]
    if not explicit_outcome and route_outcome and len(outcomes) == 2 and payload.side == "no":
        other = next((outcome for outcome in outcomes if outcome["id"] != route_outcome["id"]), None)
        if other:
            outcome_id = other["id"]
    if not outcome_id:
        raise HTTPException(400, "Choose an outcome to trade")

    try:
        if len(outcomes) > 2 and payload.side == "no":
            complement = [item for item in outcomes if item["id"] != outcome_id]
            if not complement:
                raise HTTPException(400, "No complement outcomes available")
            if payload.action == "buy":
                allocations = weighted_allocations(complement, float(payload.amount))
            else:
                position_rows = (
                    db.table("event_positions")
                    .select("outcome_id, shares")
                    .eq("event_id", event["id"])
                    .eq("participant", payload.participant.strip())
                    .execute()
                    .data or []
                )
                positions = {row["outcome_id"]: float(row.get("shares") or 0) for row in position_rows}
                b = float(event.get("liquidity_b") or DEFAULT_FAKE_BALANCE)
                max_by_outcome = {
                    item["id"]: trade_net_cash(lmsr_sell_cash_for_shares(outcomes, b, item["id"], positions.get(item["id"], 0.0)))
                    for item in complement
                }
                max_cash = sum(max_by_outcome.values())
                if float(payload.amount) > max_cash + 0.0001:
                    raise HTTPException(400, f"{payload.participant} can cash out up to ${round(max_cash, 2)} on this NO basket")
                allocations = weighted_allocations(
                    [{"id": oid, "price": cash} for oid, cash in max_by_outcome.items() if cash > 0],
                    float(payload.amount),
                )
            trade_payloads = []
            for target_id, cash in allocations.items():
                if cash <= 0:
                    continue
                result = db.rpc("place_event_trade", {
                    "p_event_id": event["id"],
                    "p_outcome_id": target_id,
                    "p_participant": payload.participant.strip(),
                    "p_action": payload.action,
                    "p_cash_amount": cash,
                }).execute()
                trade_payloads.append(result.data)
            trade_result_data = {"basket": True, "trades": trade_payloads, "selectedOutcomeId": outcome_id}
        else:
            trade_result = db.rpc("place_event_trade", {
                "p_event_id": event["id"],
                "p_outcome_id": outcome_id,
                "p_participant": payload.participant.strip(),
                "p_action": payload.action,
                "p_cash_amount": payload.amount,
            }).execute()
            trade_result_data = trade_result.data
    except Exception as exc:
        message = str(exc)
        first_arg = exc.args[0] if exc.args else None
        if isinstance(first_arg, dict) and first_arg.get("message"):
            message = first_arg["message"]
        raise HTTPException(400, message)

    return groups_response(trade=trade_result_data)


@app.post("/api/markets/{market_id}/resolve")
def resolve_market(market_id: str, payload: ResolveMarket) -> dict:
    db = get_db()
    try:
        event, route_outcome = require_event_or_outcome(market_id)
        if event["status"] == "resolved":
            raise HTTPException(400, "Already resolved")

        outcomes = db.table("market_outcomes").select("*").eq("event_id", event["id"]).execute().data or []
        wanted = payload.outcome.strip().lower()
        outcome = (
            next((item for item in outcomes if item["id"] == payload.outcome), None)
            or next((item for item in outcomes if item["title"].strip().lower() == wanted), None)
            or (route_outcome if route_outcome and wanted == "yes" else None)
        )
        if not outcome and wanted in ("yes", "no"):
            outcome = next((item for item in outcomes if item["title"].strip().lower() == wanted), None)
        if not outcome:
            raise HTTPException(400, "Resolution outcome not found")

        resolver = (payload.resolvedBy or "manual").strip()[:80] or "manual"
        note = (payload.reasoning or "").strip()
        if not note:
            note = f"Manually resolved to {outcome['title']}."
        if event["status"] == "open":
            # Manual admin override: if an outcome is already knowable before
            # maturity, close trading immediately and let the settlement RPC pay.
            db.table("market_events").update({"status": "closed"}).eq("id", event["id"]).execute()
        settlement = resolve_event_market_rpc(
            db,
            event["id"],
            outcome["id"],
            resolved_by=resolver,
            notes=note,
        )
        return groups_response(settlement=settlement)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise

    market = require_market(market_id)

    if market["status"] == "resolved":
        raise HTTPException(400, "Already resolved")

    legacy_resolver = (payload.resolvedBy or "manual").strip()[:80] or "manual"
    legacy_notes = (payload.reasoning or "").strip()[:1200] or None
    legacy_update = {
        "status":      "resolved",
        "outcome":     payload.outcome,
        "resolved_at": now_iso(),
        "resolution_notes": legacy_notes,
        "resolved_by": legacy_resolver,
    }
    try:
        db.table("markets").update(legacy_update).eq("id", market_id).execute()
    except Exception as exc:
        message = str(exc)
        if "resolution_notes" in message or "resolved_by" in message:
            legacy_update.pop("resolution_notes", None)
            legacy_update.pop("resolved_by", None)
            db.table("markets").update(legacy_update).eq("id", market_id).execute()
        else:
            raise

    # Credit winners
    market["outcome"] = payload.outcome
    trades_res = db.table("trades").select("*").eq("market_id", market_id).execute()
    settlement = legacy_settlement_payload(market, payload.outcome, trades_res.data or [], legacy_resolver, legacy_notes)
    _credit_winners(db, market["group_id"], market, trades_res.data)

    return groups_response(settlement=settlement)


# ── AI Oracle ──────────────────────────────────────────────────────────

async def _brave_search(query: str, api_key: str) -> str:
    if not api_key:
        return f"[Web search unavailable — set BRAVE_SEARCH_API_KEY. Query was: {query}]"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                "https://api.search.brave.com/res/v1/web/search",
                headers={"Accept": "application/json", "X-Subscription-Token": api_key},
                params={"q": query, "count": 5, "search_lang": "en"},
            )
            data = r.json()
            results = data.get("web", {}).get("results", [])
            if not results:
                return f"No results found for: {query}"
            return "\n\n".join(
                f"**{r['title']}**\n{r['url']}\n{r.get('description','')}"
                for r in results
            )
    except Exception as exc:
        return f"Search error: {exc}"


def event_outcomes(db, event_id: str) -> list[dict]:
    return (
        db.table("market_outcomes")
        .select("*")
        .eq("event_id", event_id)
        .order("sort_order")
        .execute()
        .data
        or []
    )


def proposal_outcome_id(proposal: dict, outcomes: list[dict]) -> str | None:
    outcome_id = proposal.get("outcomeId")
    if outcome_id and any(item["id"] == outcome_id for item in outcomes):
        return outcome_id

    raw = str(proposal.get("outcome") or "").strip().lower()
    if not raw or raw == "ambiguous":
        return None
    if raw in {item["id"] for item in outcomes}:
        return raw
    match = next((item for item in outcomes if item["title"].strip().lower() == raw), None)
    return match["id"] if match else None


def append_verification_attempt(event: dict, attempt: dict) -> list[dict]:
    attempts = event.get("verification_attempts") or []
    if not isinstance(attempts, list):
        attempts = []
    return [*attempts[-9:], attempt]


async def run_ai_oracle(event: dict, outcomes: list[dict],
                        anthropic_key: str, brave_key: str) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=anthropic_key)
    tools = [{
        "name": "search_web",
        "description": "Search the web for current information to determine a prediction market outcome.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Search query"}},
            "required": ["query"],
        },
    }]
    outcome_lines = "\n".join(f"- {item['id']}: {item['title']}" for item in outcomes)
    system = (
        "You are an impartial oracle for a prediction market. Determine the winning "
        "outcome from the provided outcome IDs. Search as needed and follow the market "
        "rules exactly. Never resolve before the close date. Return needs_review when "
        "the rules, source, or real-world result are ambiguous.\n\n"
        "Respond ONLY with a JSON object — no other text:\n"
        '{"status":"resolved"|"needs_review"|"unavailable",'
        '"outcomeId":"winning outcome id or null","confidence":0.0-1.0,'
        '"reasoning":"brief explanation","sources":["url1","url2"],'
        '"notes":"ambiguity or caveats"}'
    )
    messages = [{
        "role": "user",
        "content": (
            "Determine the outcome of this prediction market.\n\n"
            f"Market title: {event.get('title')}\n"
            f"Full resolution rules: {event.get('description') or 'No extra rules provided'}\n"
            f"Outcomes:\n{outcome_lines}\n"
            f"Close date: {event.get('closes_at') or 'not specified'}\n"
            f"Primary source: {event.get('resolution_source') or 'Use authoritative public sources'}\n"
            f"Edge cases: {event.get('edge_cases') or 'None provided'}\n"
            f"Current date: {now_iso()}\n\n"
            "Search for relevant information and return the JSON verdict."
        ),
    }]

    for _ in range(4):
        response = client.messages.create(
            model="claude-sonnet-4-6", max_tokens=1024,
            system=system, tools=tools, messages=messages,
        )
        if response.stop_reason == "tool_use":
            tool_block = next((b for b in response.content if b.type == "tool_use"), None)
            if not tool_block: break
            results = await _brave_search(tool_block.input["query"], brave_key)
            messages.append({"role": "assistant", "content": response.content})
            messages.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": tool_block.id, "content": results}],
            })
        else:
            text = next((b.text for b in response.content if b.type == "text"), "")
            match = re.search(r"\{.*\}", text, re.DOTALL)
            if match:
                try: return json.loads(match.group())
                except json.JSONDecodeError: pass
            return {"status": "needs_review", "outcomeId": None, "confidence": 0.0, "reasoning": text, "sources": [], "notes": "Oracle response was not valid JSON."}

    return {"status": "needs_review", "outcomeId": None, "confidence": 0.0,
            "reasoning": "Could not determine outcome after searching.", "sources": [], "notes": "Search loop ended without a verdict."}


@app.post("/api/markets/{market_id}/oracle/trigger")
async def trigger_ai_oracle(market_id: str) -> dict:
    db = get_db()
    event, _route_outcome = require_event_or_outcome(market_id)

    if event["status"] == "resolved":
        raise HTTPException(400, "Market is already resolved")
    if event["status"] != "closed":
        raise HTTPException(400, "Market must be closed before AI resolution")
    if event["oracle_type"] != "ai":
        raise HTTPException(400, "Market does not use the AI oracle")

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        raise HTTPException(
            503,
            "AI oracle unavailable: set ANTHROPIC_API_KEY or resolve this market manually.",
        )

    outcomes = event_outcomes(db, event["id"])
    if not outcomes:
        raise HTTPException(400, "No outcomes available for this market")

    result = await run_ai_oracle(
        event=event,
        outcomes=outcomes,
        anthropic_key=anthropic_key,
        brave_key=os.environ.get("BRAVE_SEARCH_API_KEY", ""),
    )

    resolved_outcome_id = proposal_outcome_id(result, outcomes)
    confidence = float(result.get("confidence") or 0)
    status = result.get("status") or ("resolved" if resolved_outcome_id else "needs_review")
    auto_resolve = status == "resolved" and resolved_outcome_id and confidence >= 0.95
    can_propose = status == "resolved" and resolved_outcome_id and confidence >= 0.80
    deadline   = datetime.now(timezone.utc) + timedelta(hours=24)
    outcome_title = next((item["title"] for item in outcomes if item["id"] == resolved_outcome_id), None)
    proposal = {
        "status":          "pending" if can_propose else "needs_review",
        "outcomeId":       resolved_outcome_id,
        "outcomeTitle":    outcome_title,
        "outcome":         outcome_title or result.get("outcome") or "ambiguous",
        "confidence":      round(confidence, 3),
        "reasoning":       result.get("reasoning", ""),
        "sources":         result.get("sources", []),
        "notes":           result.get("notes", ""),
        "proposedAt":      now_iso(),
        "disputeDeadline": deadline.isoformat() if can_propose else None,
    }
    attempts = append_verification_attempt(event, {**proposal, "rawStatus": status})

    if auto_resolve:
        resolved_proposal = {**proposal, "status": "auto_resolved"}
        settlement = resolve_event_market_rpc(
            db,
            event["id"],
            resolved_outcome_id,
            resolved_by="ai",
            notes=result.get("reasoning", ""),
            proposal=resolved_proposal,
        )
        db.table("market_events").update({"verification_attempts": attempts}).eq("id", event["id"]).execute()
        return groups_response(oracleProposal=proposal, settlement=settlement)
    else:
        db.table("market_events").update({
            "oracle_proposal": proposal,
            "verification_status": "proposal_pending" if can_propose else "needs_review",
            "verification_attempts": attempts,
        }).eq("id", event["id"]).execute()

    return groups_response(oracleProposal=proposal)


@app.post("/api/markets/{market_id}/oracle/accept")
def accept_oracle_proposal(market_id: str) -> dict:
    db = get_db()
    event, _route_outcome = require_event_or_outcome(market_id)

    if event["status"] == "resolved":
        raise HTTPException(400, "Market is already resolved")
    if event["status"] != "closed":
        raise HTTPException(400, "Market must be closed before resolution")

    outcomes = event_outcomes(db, event["id"])
    proposal = event.get("oracle_proposal") or {}
    if proposal.get("status") != "pending":
        raise HTTPException(400, "No pending proposal to accept")
    outcome_id = proposal_outcome_id(proposal, outcomes)
    if not outcome_id:
        raise HTTPException(400, "Proposal outcome is ambiguous — cannot accept")

    accepted = {**proposal, "status": "accepted"}
    settlement = resolve_event_market_rpc(
        db,
        event["id"],
        outcome_id,
        resolved_by="ai_accepted",
        notes=proposal.get("reasoning") or "AI proposal accepted.",
        proposal=accepted,
    )

    return groups_response(settlement=settlement)


@app.post("/api/markets/{market_id}/oracle/dispute")
def dispute_oracle_proposal(market_id: str) -> dict:
    db = get_db()
    event, _route_outcome = require_event_or_outcome(market_id)

    proposal = event.get("oracle_proposal")
    if not proposal:
        raise HTTPException(400, "No proposal to dispute")

    db.table("market_events").update({
        "oracle_type":     "manual",
        "oracle_proposal": {**proposal, "status": "disputed"},
        "verification_status": "needs_review",
        "resolution_notes": "AI proposal disputed. Manual settlement required.",
    }).eq("id", event["id"]).execute()

    return groups_response()


@app.post("/api/markets/{market_id}/oracle/vote")
def submit_oracle_vote(market_id: str, payload: OracleVote) -> dict:
    db = get_db()
    event, _route_outcome = require_event_or_outcome(market_id)

    if event["status"] != "closed":
        raise HTTPException(400, "Market must be closed before voting")
    if event["oracle_type"] != "vote":
        raise HTTPException(400, "Market does not use group voting")

    outcomes = event_outcomes(db, event["id"])
    outcome_id = proposal_outcome_id({"outcomeId": payload.outcome, "outcome": payload.outcome}, outcomes)
    if not outcome_id:
        raise HTTPException(400, "Vote outcome not found")

    proposal = event.get("oracle_proposal") or {}
    votes = proposal.setdefault("votes", {item["id"]: 0 for item in outcomes})
    votes_by_participant = proposal.setdefault("votesByParticipant", {})
    participant = payload.participant.strip()
    previous_vote = votes_by_participant.get(participant)

    if previous_vote == outcome_id:
        return groups_response()

    if previous_vote in votes:
        votes[previous_vote] = max(0, int(votes.get(previous_vote, 0)) - 1)

    votes_by_participant[participant] = outcome_id
    votes[outcome_id] = int(votes.get(outcome_id, 0)) + 1
    proposal["status"] = "voting"
    proposal["proposedAt"] = proposal.get("proposedAt") or now_iso()
    proposal["lastUpdatedAt"] = now_iso()

    voter_count = len(votes_by_participant)
    resolved_outcome_id = None
    if voter_count >= 3:
        ranked = sorted(votes.items(), key=lambda item: int(item[1]), reverse=True)
        top_id, top_votes = ranked[0]
        tied = len(ranked) > 1 and int(ranked[1][1]) == int(top_votes)
        if len(outcomes) == 2:
            if int(top_votes) / voter_count >= 0.60:
                resolved_outcome_id = top_id
        elif not tied:
            resolved_outcome_id = top_id

    if resolved_outcome_id:
        outcome_title = next((item["title"] for item in outcomes if item["id"] == resolved_outcome_id), resolved_outcome_id)
        resolved_proposal = {
            **proposal,
            "status": "resolved",
            "resolvedBy": "vote",
            "outcomeId": resolved_outcome_id,
            "outcomeTitle": outcome_title,
            "outcome": outcome_title,
        }
        settlement = resolve_event_market_rpc(
            db,
            event["id"],
            resolved_outcome_id,
            resolved_by="vote",
            notes=f"Group vote resolved to {outcome_title}.",
            proposal=resolved_proposal,
        )
        return groups_response(settlement=settlement)

    if voter_count >= 3:
        proposal["status"] = "needs_review"

    db.table("market_events").update({
        "oracle_proposal": proposal,
        "verification_status": "voting" if proposal["status"] == "voting" else "needs_review",
    }).eq("id", event["id"]).execute()
    return groups_response()


if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
