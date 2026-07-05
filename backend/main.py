from __future__ import annotations

import json
import base64
import hashlib
import io
import math
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote_plus, urlparse, urlunparse
from uuid import uuid4

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Load .env.local then .env (whichever exists)
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=BASE_DIR / ".env.local", override=False)
load_dotenv(dotenv_path=BASE_DIR / ".env", override=False)

DIST_DIR = BASE_DIR / "dist"
DEFAULT_FAKE_BALANCE = 100000.0
MARKET_FEE_RATE = 0.015
ALL_OUTCOMES_RESOLUTION = "__all__"


# ── Pydantic models ────────────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    emoji: str = Field(default="📣", max_length=4)
    members: list[str] = Field(min_length=1)
    mode: Literal["fake", "real"] = "fake"
    createdBy: str | None = Field(default=None, max_length=80)


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
    initialProbabilities: dict[str, float] | None = None
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


class MarketOddsSeed(BaseModel):
    question: str = Field(min_length=1, max_length=100)
    brief: str | None = Field(default=None, max_length=900)
    outcomes: list[str] = Field(default_factory=list)
    closesAt: str | None = Field(default=None, max_length=80)
    category: str = Field(default="General", max_length=120)


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
    resolverAliases: list[str] | None = None


class EliminateOutcome(BaseModel):
    reasoning: str | None = Field(default=None, max_length=1200)
    eliminatedBy: str | None = Field(default=None, max_length=80)


class BracketEntrySave(BaseModel):
    participant: str = Field(min_length=1, max_length=80)
    userEmail: str | None = Field(default=None, max_length=240)
    picks: dict[str, str] = Field(default_factory=dict)
    submitted: bool = False


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
    weak = {"option", "prediction", "outcome", "team", "player", "tbd", "n/a", "na"}
    if any(label.lower() in weak for label in cleaned):
        raise HTTPException(400, "Use specific prediction labels")
    return cleaned


def probability_key(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip().lower())
    text = re.sub(r"^[^\w]+", "", text)
    return text


def normalize_probability_values(outcomes: list[str], values: dict[str, float] | None) -> list[float]:
    if not outcomes:
        return []
    equal = [1.0 / len(outcomes) for _ in outcomes]
    if not values:
        return equal
    keyed = {probability_key(key): value for key, value in values.items()}
    raw: list[float] = []
    for outcome in outcomes:
        value = keyed.get(probability_key(outcome), values.get(outcome, 0.0))
        try:
            raw.append(max(0.0, float(value)))
        except (TypeError, ValueError):
            raw.append(0.0)
    total = sum(raw)
    if total <= 0:
        return equal
    normalized = [value / total for value in raw]
    # Keep every listed outcome alive on new LMSR markets. This is not a prediction,
    # it prevents tiny or missing priors from making longshots feel impossible.
    floor = min(0.0025, 0.35 / len(outcomes))
    floored = [max(floor, value) for value in normalized]
    total = sum(floored)
    return [value / total for value in floored]


def soften_odds_probabilities(outcomes: list[str], raw_values: dict[str, float]) -> list[float]:
    normalized = normalize_probability_values(outcomes, raw_values)
    if not normalized:
        return []
    equal = 1.0 / len(outcomes)
    # Big multi-outcome fields need more compression; sportsbook-style favorites
    # are too punishing as initial LMSR prices for small friend groups.
    market_weight = 0.50 if len(outcomes) >= 16 else 0.58
    softened = [(value * market_weight) + (equal * (1 - market_weight)) for value in normalized]
    total = sum(softened) or 1.0
    return [value / total for value in softened]


def probability_map(outcomes: list[str], values: list[float]) -> dict[str, float]:
    return {outcome: round(float(values[idx] if idx < len(values) else 0), 6) for idx, outcome in enumerate(outcomes)}


def initial_outcome_prices(outcomes: list[str], initial_probabilities: dict[str, float] | None) -> list[float]:
    return normalize_probability_values(outcomes, initial_probabilities)


def default_event_liquidity(outcome_count: int) -> float:
    count = max(2, int(outcome_count or 2))
    if count <= 2:
        return 20_000.0
    if count <= 10:
        return 50_000.0
    return float(min(200_000, max(80_000, round(count * 3_000, -3))))


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


def extract_openai_response_text(data: dict) -> str:
    if data.get("output_text"):
        return str(data["output_text"])
    chunks: list[str] = []
    for item in data.get("output", []) or []:
        for content in item.get("content", []) or []:
            if isinstance(content, dict) and content.get("text"):
                chunks.append(str(content["text"]))
    return "\n".join(chunks).strip()


def parse_json_object_text(text: str) -> dict:
    cleaned = str(text or "").strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.S | re.I)
    if fence:
        cleaned = fence.group(1).strip()
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            cleaned = cleaned[start:end + 1]
    return json.loads(cleaned)


async def ai_market_odds_seed(payload: MarketOddsSeed, outcomes: list[str], closes_at: datetime | None) -> dict:
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    equal = probability_map(outcomes, [1.0 / len(outcomes) for _ in outcomes])
    if len(outcomes) <= 2:
        return {
            "available": False,
            "source": "binary_skipped",
            "summary": "AI odds seeding is only useful for multi-outcome markets.",
            "probabilities": equal,
            "rawProbabilities": equal,
            "sources": [],
        }
    if not openai_key:
        return {
            "available": False,
            "source": "missing_openai_key",
            "summary": "OpenAI is not configured, so this market will start from equal prices.",
            "probabilities": equal,
            "rawProbabilities": equal,
            "sources": [],
        }

    outcome_lines = "\n".join(f"{idx + 1}. {item}" for idx, item in enumerate(outcomes))
    close_label = closes_at.isoformat() if closes_at else "not specified"
    brief = re.sub(r"\s+", " ", str(payload.brief or "").strip()) or payload.question
    system = (
        "You are estimating starting-price context for a friend-group prediction market. "
        "Use web search to find current sportsbook, prediction-market, or credible consensus odds when available. "
        "Do not copy external odds directly. Return raw context probabilities, then explain that the app will soften them. "
        "Never eliminate a listed outcome unless it is factually impossible or eliminated. "
        "If current odds are unavailable, use informed public-football context and say so."
    )
    user = (
        f"Market question: {payload.question}\n"
        f"Creator context: {brief}\n"
        f"Category: {payload.category}\n"
        f"Maturity: {close_label}\n"
        f"Outcomes, in exact app order:\n{outcome_lines}\n\n"
        "Return JSON only with this shape:\n"
        "{\n"
        '  "probabilities": [{"outcome": "exact listed outcome", "probability": 0.123}],\n'
        '  "summary": "one sentence on what current odds/context suggests",\n'
        '  "sources": [{"title": "source title", "url": "https://..."}]\n'
        "}\n"
        "Probabilities should sum roughly to 1 before app softening."
    )
    raw_values: dict[str, float] = {}
    summary = "Current odds context was used, then softened for friend-group trading."
    sources: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=28.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/responses",
                headers={
                    "Authorization": f"Bearer {openai_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": os.environ.get("OPENAI_ODDS_MODEL", "gpt-4.1-mini"),
                    "tools": [{"type": "web_search_preview"}],
                    "input": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.1,
                    "max_output_tokens": 1200,
                },
            )
        if response.status_code >= 400:
            raise ValueError(f"OpenAI odds seed failed with status {response.status_code}")
        text = extract_openai_response_text(response.json())
        draft = parse_json_object_text(text)
        for item in draft.get("probabilities", []) or []:
            outcome = str(item.get("outcome") or "").strip()
            if not outcome:
                continue
            raw_values[outcome] = float(item.get("probability") or 0)
        summary = re.sub(r"\s+", " ", str(draft.get("summary") or summary).strip())[:240]
        raw_sources = draft.get("sources", []) or []
        for item in raw_sources[:5]:
            if isinstance(item, dict):
                title = re.sub(r"\s+", " ", str(item.get("title") or "").strip())[:120]
                url = str(item.get("url") or "").strip()[:400]
                if title or url:
                    sources.append({"title": title or url, "url": url})
    except Exception:
        return {
            "available": False,
            "source": "fallback_equal",
            "summary": "Odds lookup failed, so this market will start from equal prices.",
            "probabilities": equal,
            "rawProbabilities": equal,
            "sources": [],
        }

    if not raw_values:
        return {
            "available": False,
            "source": "fallback_equal",
            "summary": "No usable odds were found, so this market will start from equal prices.",
            "probabilities": equal,
            "rawProbabilities": equal,
            "sources": sources,
        }
    raw = normalize_probability_values(outcomes, raw_values)
    softened = soften_odds_probabilities(outcomes, raw_values)
    return {
        "available": True,
        "source": "openai_web_softened",
        "summary": summary,
        "probabilities": probability_map(outcomes, softened),
        "rawProbabilities": probability_map(outcomes, raw),
        "sources": sources,
        "softening": "Blended toward equal pricing before LMSR initialization.",
    }


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


def clean_person(value: str | None, fallback: str = "") -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())[:80]
    return text or fallback


def person_key(value: str | None) -> str:
    return clean_person(value).casefold()


def clean_bracket_picks(picks: dict[str, str] | None) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for key, value in (picks or {}).items():
        clean_key = re.sub(r"[^a-zA-Z0-9_-]", "", str(key or ""))[:64]
        clean_value = re.sub(r"\s+", " ", str(value or "").strip())[:80]
        if clean_key and clean_value:
            cleaned[clean_key] = clean_value
    return cleaned


def assemble_bracket_entry(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row.get("id"),
        "challengeId": row.get("challenge_id"),
        "participant": row.get("participant"),
        "userEmail": row.get("user_email"),
        "picks": row.get("picks") or {},
        "submittedAt": row.get("submitted_at"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


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


_last_close_expired_at = 0.0
_close_expired_lock = threading.Lock()
CLOSE_EXPIRED_INTERVAL_SECONDS = int(os.environ.get("CLOSE_EXPIRED_INTERVAL_SECONDS", "60"))


def close_expired_markets(db, *, force: bool = False) -> None:
    global _last_close_expired_at
    monotonic_now = time.monotonic()
    if not force and monotonic_now - _last_close_expired_at < CLOSE_EXPIRED_INTERVAL_SECONDS:
        return
    if not _close_expired_lock.acquire(blocking=False):
        return
    try:
        if not force and monotonic_now - _last_close_expired_at < CLOSE_EXPIRED_INTERVAL_SECONDS:
            return
        _last_close_expired_at = monotonic_now

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
    finally:
        _close_expired_lock.release()


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
    display_outcome_id = t.get("display_outcome_id") or t["outcome_id"]
    display_side = (t.get("display_side") or "yes").lower()
    display_outcome = outcome_lookup.get(display_outcome_id, outcome)
    before_key = display_outcome_id if display_side == "no" else t["outcome_id"]
    before_raw = float(prices_before.get(before_key, display_outcome.get("price") or outcome.get("price") or 0))
    after_raw = float(prices_after.get(before_key, display_outcome.get("price") or outcome.get("price") or 0))
    before = 1.0 - before_raw if display_side == "no" else before_raw
    after = 1.0 - after_raw if display_side == "no" else after_raw
    return {
        "id": t["id"],
        "participant": t["participant"],
        "side": display_side,
        "action": t["action"],
        "outcomeId": display_outcome_id,
        "outcomeTitle": display_outcome.get("title"),
        "amount": t["cash_amount"],
        "shares": t.get("display_shares") if t.get("display_shares") is not None else t["shares_delta"],
        "avgPrice": t["avg_price"],
        "probBefore": before,
        "probAfter": after,
        "pricesBefore": prices_before,
        "pricesAfter": prices_after,
        "createdAt": t["created_at"],
        "displayGroupId": t.get("display_group_id"),
        "components": t.get("components") or [],
    }


def display_event_trades(trades_raw: list[dict], outcomes: list[dict], outcome_lookup: dict[str, dict]) -> list[dict]:
    outcome_ids = {item["id"] for item in outcomes}
    grouped: dict[tuple, list[dict]] = {}
    consumed: set[str] = set()
    display_trades: list[dict] = []

    for row in trades_raw:
        group_id = row.get("display_group_id")
        if group_id:
            grouped.setdefault(("display", group_id), []).append(row)

    for row in trades_raw:
        if row.get("display_group_id"):
            continue
        if len(outcomes) <= 2:
            continue
        key = (
            "infer",
            row.get("event_id"),
            row.get("participant"),
            row.get("action"),
            row.get("created_at"),
            round(float(row.get("avg_price") or 0), 8),
            round(float(row.get("shares_delta") or 0), 8),
            tuple(sorted((row.get("prices_after") or {}).items())),
        )
        grouped.setdefault(key, []).append(row)

    for rows in grouped.values():
        row_ids = {row["id"] for row in rows}
        if row_ids & consumed:
            continue
        component_ids = {row["outcome_id"] for row in rows}
        display_outcome_id = rows[0].get("display_outcome_id")
        if not display_outcome_id:
            missing = list(outcome_ids - component_ids)
            if len(rows) != max(1, len(outcomes) - 1) or len(missing) != 1:
                continue
            display_outcome_id = missing[0]
        display_side = (rows[0].get("display_side") or "no").lower()
        if display_side != "no":
            continue

        base = {**rows[0]}
        base["id"] = rows[0].get("display_group_id") or f"synthetic-{rows[0]['id']}"
        base["outcome_id"] = rows[0]["outcome_id"]
        base["display_outcome_id"] = display_outcome_id
        base["display_side"] = "no"
        base["display_shares"] = rows[0].get("display_shares") or abs(float(rows[0].get("shares_delta") or 0))
        base["cash_amount"] = round(sum(float(row.get("cash_amount") or 0) for row in rows), 4)
        base["components"] = [assemble_event_trade({**row, "display_side": None, "display_outcome_id": None, "display_shares": None}, outcome_lookup) for row in rows]
        display_trades.append(assemble_event_trade(base, outcome_lookup))
        consumed |= row_ids

    for row in trades_raw:
        if row["id"] not in consumed:
            display_trades.append(assemble_event_trade(row, outcome_lookup))

    return sorted(display_trades, key=lambda item: item.get("createdAt") or "")


def insert_event_trade_rows(db, rows: list[dict]) -> None:
    if not rows:
        return
    try:
        db.table("event_trades").insert(rows).execute()
    except Exception as exc:
        message = str(exc)
        if "display_group_id" not in message and "display_outcome_id" not in message and "display_side" not in message and "display_shares" not in message:
            raise
        stripped = [
            {
                key: value
                for key, value in row.items()
                if key not in {"display_group_id", "display_outcome_id", "display_side", "display_shares"}
            }
            for row in rows
        ]
        db.table("event_trades").insert(stripped).execute()


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
    outcome_count = max(1, len(event.get("_assembled_outcomes") or []))
    equal_probability = 1.0 / outcome_count
    seed_probability = float(outcome.get("price") or equal_probability)
    if trades_raw:
        seed_probability = float((trades_raw[0].get("prices_before") or {}).get(outcome["id"], seed_probability))

    created_at = event["created_at"]
    seed_at_dt = parse_iso_datetime(created_at)
    seed_at = (seed_at_dt + timedelta(seconds=10)).isoformat() if seed_at_dt else created_at
    history = []
    if outcome_count > 2 and abs(seed_probability - equal_probability) > 0.0005:
        history.append({
            "createdAt": created_at,
            "probability": round(float(equal_probability), 4),
        })
        history.append({
            "createdAt": seed_at,
            "probability": round(float(seed_probability), 4),
        })
    else:
        history.append({
            "createdAt": created_at,
            "probability": round(float(seed_probability), 4),
        })
    relevant_prices: list[dict] = []
    for trade in trades_raw:
        prices_after = trade.get("prices_after") or {}
        if outcome["id"] in prices_after:
            relevant_prices.append({
                "createdAt": trade["created_at"],
                "probability": round(float(prices_after[outcome["id"]]), 4),
            })
    if relevant_prices:
        history.extend(relevant_prices)
    return history


def assemble_event_markets(event: dict) -> list[dict]:
    outcomes = sorted(event.pop("market_outcomes", []), key=lambda x: x.get("sort_order") or 0)
    event["_assembled_outcomes"] = outcomes
    trades_raw = sorted(event.pop("event_trades", []), key=lambda x: x.get("created_at") or "")
    positions_raw = event.pop("event_positions", [])
    outcome_lookup = {outcome["id"]: outcome for outcome in outcomes}
    trades = display_event_trades(trades_raw, outcomes, outcome_lookup)
    positions: dict[str, dict[str, float]] = {}
    for position in positions_raw:
        positions.setdefault(position["participant"], {})[position["outcome_id"]] = float(position.get("shares") or 0)

    liquidity = float(event.get("liquidity_b") or 0)
    volume = round(
        sum(abs(float(trade.get("cash_amount") or 0)) for trade in trades_raw)
        if trades_raw else float(event.get("total_volume") or 0),
        4,
    )
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
            "outcomeStatus": outcome.get("status") or "active",
            "eliminatedAt": outcome.get("eliminated_at"),
            "eliminatedBy": outcome.get("eliminated_by"),
            "eliminationNotes": outcome.get("elimination_notes"),
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
                    "status": item.get("status") or "active",
                    "eliminatedAt": item.get("eliminated_at"),
                    "eliminatedBy": item.get("eliminated_by"),
                    "eliminationNotes": item.get("elimination_notes"),
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
        "createdBy": g.get("created_by"),
        "createdAt": g["created_at"],
        "members":   [m["name"] for m in members_raw],
        "balances":  {m["name"]: m["balance"] for m in members_raw},
        "markets":   [*event_markets, *legacy_markets],
    }


GROUPS_SELECT_FULL = "*, group_members(*), market_events(*, market_outcomes(*), event_trades(*), event_positions(*)), markets(*, trades(*))"
EVENT_SELECT_COMPACT = (
    "id,group_id,title,description,status,mode,oracle_type,liquidity_b,total_volume,"
    "image_url,"
    "closes_at,created_at,outcome_id,resolved_at,oracle_proposal,legacy_key,"
    "resolution_source,edge_cases,verification_status,verification_attempts,"
    "resolved_by,resolution_notes,created_by,"
    "market_outcomes(*),event_positions(*)"
)
EVENT_SELECT_CONTEXT = (
    "id,group_id,title,description,status,mode,oracle_type,liquidity_b,total_volume,"
    "image_url,"
    "closes_at,created_at,outcome_id,resolved_at,oracle_proposal,legacy_key,"
    "resolution_source,edge_cases,verification_status,verification_attempts,"
    "resolved_by,resolution_notes,created_by,"
    "market_outcomes(*),event_trades(*),event_positions(*)"
)
GROUPS_SELECT_COMPACT = (
    "id,name,emoji,mode,created_by,created_at,"
    "group_members(*),"
    f"market_events({EVENT_SELECT_COMPACT}),"
    "markets(*)"
)


def compact_market_image_url(market_id: str) -> str:
    return f"{public_base_url().rstrip('/')}/api/markets/{market_id}/image"


def strip_data_url_images(groups: list[dict]) -> list[dict]:
    for group in groups:
        for market in group.get("markets", []):
            image_url = market.get("imageUrl")
            if isinstance(image_url, str) and image_url.startswith("data:"):
                market["imageUrl"] = compact_market_image_url(market["id"])
    return groups


def load_all_groups(*, compact: bool = True, group_id: str | None = None, limit: int | None = None) -> list[dict]:
    db = get_db()
    close_expired_markets(db)
    query = db.table("groups").select(GROUPS_SELECT_COMPACT if compact else GROUPS_SELECT_FULL)
    if group_id:
        query = query.eq("id", group_id)
    if compact and limit:
        query = query.limit(max(1, min(int(limit), 50)))
    result = query.order("created_at", desc=True).execute()
    groups = [assemble_group(deepcopy(g)) for g in result.data]
    return strip_data_url_images(groups) if compact else groups


def groups_response(
    *,
    compact: bool = True,
    group_id: str | None = None,
    include: str | None = None,
    limit: int | None = None,
    members: str | None = None,
    **extra,
) -> dict:
    aliases = {
        item.strip().lower()
        for item in (members or "").split(",")
        if item.strip()
    }
    groups = load_all_groups(compact=compact, group_id=group_id, limit=None if aliases else limit)
    if aliases:
        def matches_member_alias(group: dict) -> bool:
            creator = clean_person(group.get("createdBy"))
            if creator.lower() in aliases:
                return True
            return any(clean_person(member).lower() in aliases for member in group.get("members", []))

        groups = [
            group for group in groups
            if matches_member_alias(group)
        ]
        if limit:
            groups = groups[:max(1, min(int(limit), 50))]
    if include and not any(group.get("id") == include for group in groups):
        groups.extend(load_all_groups(compact=compact, group_id=include))
    return {"groups": groups, **extra}


def load_market_context_group(market_id: str) -> dict:
    db = get_db()
    close_expired_markets(db)
    try:
        event, _route_outcome = require_event_or_outcome(market_id)
        group_id = event["group_id"]
        group_rows = db.table("groups").select("id,name,emoji,mode,created_by,created_at,group_members(*)").eq("id", group_id).execute().data or []
        event_rows = db.table("market_events").select(EVENT_SELECT_CONTEXT).eq("id", event["id"]).execute().data or []
        if not group_rows or not event_rows:
            raise HTTPException(404, "Market group not found")
        group = deepcopy(group_rows[0])
        group["market_events"] = event_rows
        group["markets"] = []
        return strip_data_url_images([assemble_group(group)])[0]
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        legacy_rows = db.table("markets").select("*, trades(*)").eq("id", market_id).execute().data or []
        if not legacy_rows:
            raise
        group_id = legacy_rows[0]["group_id"]
        group_rows = db.table("groups").select("id,name,emoji,mode,created_by,created_at,group_members(*)").eq("id", group_id).execute().data or []
        if not group_rows:
            raise HTTPException(404, "Market group not found")
        group = deepcopy(group_rows[0])
        group["market_events"] = []
        group["markets"] = legacy_rows
        return strip_data_url_images([assemble_group(group)])[0]


def find_assembled_market(market_id: str) -> tuple[dict, dict, dict]:
    for group in load_all_groups(compact=False):
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
    for group in load_all_groups(compact=False):
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
    explicit = (
        os.environ.get("FRONTEND_BASE_URL")
        or os.environ.get("APP_BASE_URL")
        or os.environ.get("SITE_URL")
        or os.environ.get("VITE_PUBLIC_APP_BASE_URL")
    )
    if explicit:
        return explicit.rstrip("/")
    base = request_base_url(request)
    if base:
        parsed = urlparse(base)
        host = (parsed.hostname or "").lower()
        if host.endswith(".onrender.com"):
            return os.environ.get("PROBABLE_FRONTEND_FALLBACK", "https://www.probable.live").rstrip("/")
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
    title = event["title"]
    if share_card_is_multi(event):
        share_title = title
        top_series = share_card_series(market, event, limit=3)
        top_bits = [f"{item['label']} {item['pct']}%" for item in top_series]
        share_description = f"{' · '.join(top_bits)} · {group['emoji']} {group['name']}"
    else:
        yes_price, no_price = share_yes_no_prices(market)
        outcome = market.get("question") or "Yes"
        share_title = f"{title}: {outcome}"
        share_description = f"{round(yes_price * 100)}% Yes · {round(no_price * 100)}% No · {group['emoji']} {group['name']}"
    return {
        "market": market,
        "event": event,
        "group": {"id": group["id"], "name": group["name"], "emoji": group["emoji"]},
        "share": {
            "title": share_title,
            "description": share_description,
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


SHARE_CARD_OUTCOME_COLORS = ["#2d9cff", "#f23645", "#f2c414", "#ff861c", "#8bd450", "#b87cff", "#18c3b6", "#78b7ff"]

PNG_EMOJI_PATTERN = re.compile(
    "["
    "\U0001F1E6-\U0001F1FF"
    "\U0001F300-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U0001F000-\U0001F0FF"
    "\U0000FE0F"
    "]+",
    flags=re.UNICODE,
)


def png_safe_label(text: str) -> str:
    """Pillow's bundled fonts can't render emoji (shows as a missing-glyph box),
    so strip them for raster share cards; SVG/browser rendering doesn't need this."""
    return PNG_EMOJI_PATTERN.sub("", text).strip() or text


def darken_hex(hex_color: str, factor: float = 0.32) -> str:
    raw = hex_color.lstrip("#")
    r, g, b = (int(raw[i:i + 2], 16) for i in (0, 2, 4))
    return f"#{int(r * factor):02x}{int(g * factor):02x}{int(b * factor):02x}"


def share_card_series(market: dict, event: dict, *, limit: int = 5) -> list[dict]:
    """Build the chart/legend series for a share card: Yes/No for binary markets,
    or the top N outcomes by current price for multi-outcome events."""
    event_markets = event.get("markets") or [market]
    if len(event_markets) <= 2:
        yes_price, no_price = share_yes_no_prices(market)
        yes_values, no_values = share_card_yes_no_values(market)
        return [
            {"label": "Yes", "color": "#2d9cff", "values": yes_values, "pct": round(yes_price * 100)},
            {"label": "No", "color": "#ff4d5a", "values": no_values, "pct": round(no_price * 100)},
        ]
    ranked = sorted(event_markets, key=lambda item: float(item.get("probability") or 0), reverse=True)[:limit]
    series = []
    for index, outcome in enumerate(ranked):
        label = str(outcome.get("question") or outcome.get("title") or "Outcome")
        series.append({
            "label": label,
            "color": SHARE_CARD_OUTCOME_COLORS[index % len(SHARE_CARD_OUTCOME_COLORS)],
            "values": share_card_history_values(outcome),
            "pct": round(float(outcome.get("probability") or 0) * 100),
        })
    return series


def share_card_is_multi(event: dict) -> bool:
    return len(event.get("markets") or []) > 2


def share_card_date_labels(history_rows: list[dict], count: int = 3) -> list[str]:
    dates = []
    for row in history_rows:
        dt = parse_iso_datetime(row.get("createdAt"))
        if dt:
            dates.append(dt)
    if not dates:
        return [""] * count
    if len(dates) == 1:
        dates = dates * count
    picks = [dates[round(index * (len(dates) - 1) / max(1, count - 1))] for index in range(count)]
    return [d.strftime("%b %-d") for d in picks]


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


def outcome_status(outcome: dict) -> str:
    return str(outcome.get("status") or "active").strip().lower() or "active"


def outcome_is_eliminated(outcome: dict | None) -> bool:
    return outcome_status(outcome or {}) == "eliminated"


def active_outcomes(outcomes: list[dict]) -> list[dict]:
    return [item for item in outcomes if not outcome_is_eliminated(item)]


def event_sum_exp(outcomes: list[dict], b: float) -> float:
    return sum(math.exp(float(item.get("quantity") or 0) / b) for item in active_outcomes(outcomes))


def lmsr_buy_shares(outcomes: list[dict], b: float, outcome_id: str, cash: float) -> float:
    if cash <= 0:
        return 0.0
    target = next((item for item in active_outcomes(outcomes) if item["id"] == outcome_id), None)
    if not target or b <= 0:
        return 0.0
    sum_exp = event_sum_exp(outcomes, b)
    target_exp = math.exp(float(target.get("quantity") or 0) / b)
    return b * math.log(1 + (sum_exp / target_exp) * (math.exp(cash / b) - 1))


def lmsr_sell_cash_for_shares(outcomes: list[dict], b: float, outcome_id: str, shares: float) -> float:
    if shares <= 0:
        return 0.0
    target = next((item for item in active_outcomes(outcomes) if item["id"] == outcome_id), None)
    if not target or b <= 0:
        return 0.0
    sum_exp = event_sum_exp(outcomes, b)
    target_exp = math.exp(float(target.get("quantity") or 0) / b)
    denominator = sum_exp - target_exp + target_exp * math.exp(-shares / b)
    if denominator <= 0:
        return 0.0
    return b * math.log(sum_exp / denominator)


def lmsr_complement_buy_shares(outcomes: list[dict], b: float, excluded_outcome_id: str, gross_cash: float) -> float:
    net_cash = trade_net_cash(gross_cash)
    if net_cash <= 0 or b <= 0:
        return 0.0
    values = [(item["id"], math.exp(float(item.get("quantity") or 0) / b)) for item in active_outcomes(outcomes)]
    sum_exp = sum(value for _id, value in values)
    target_exp = next((value for oid, value in values if oid == excluded_outcome_id), None)
    if not target_exp or sum_exp <= 0:
        return 0.0
    complement_exp = max(0.0, sum_exp - target_exp)
    if complement_exp <= 0:
        return 0.0
    new_sum = sum_exp * math.exp(net_cash / b)
    ratio = (new_sum - target_exp) / complement_exp
    if ratio <= 1:
        return 0.0
    return b * math.log(ratio)


def lmsr_complement_sell_cash_for_shares(outcomes: list[dict], b: float, excluded_outcome_id: str, shares: float) -> float:
    amount = max(0.0, float(shares or 0))
    if amount <= 0 or b <= 0:
        return 0.0
    values = [(item["id"], math.exp(float(item.get("quantity") or 0) / b)) for item in active_outcomes(outcomes)]
    sum_exp = sum(value for _id, value in values)
    target_exp = next((value for oid, value in values if oid == excluded_outcome_id), None)
    if not target_exp or sum_exp <= 0:
        return 0.0
    complement_exp = max(0.0, sum_exp - target_exp)
    new_sum = target_exp + complement_exp * math.exp(-amount / b)
    if new_sum <= 0:
        return 0.0
    return trade_net_cash(b * math.log(sum_exp / new_sum))


def lmsr_complement_sell_shares_for_cash(outcomes: list[dict], b: float, excluded_outcome_id: str, net_cash: float, max_shares: float) -> float:
    target_cash = max(0.0, float(net_cash or 0))
    high = max(0.0, float(max_shares or 0))
    if target_cash <= 0 or high <= 0:
        return 0.0
    if lmsr_complement_sell_cash_for_shares(outcomes, b, excluded_outcome_id, high) < target_cash - 0.0001:
        return high + 1
    low = 0.0
    for _ in range(60):
        mid = (low + high) / 2
        if lmsr_complement_sell_cash_for_shares(outcomes, b, excluded_outcome_id, mid) > target_cash:
            high = mid
        else:
            low = mid
    return low


def lmsr_prices_for_quantities(outcomes: list[dict], b: float) -> dict[str, float]:
    exps = {
        item["id"]: math.exp(float(item.get("quantity") or 0) / b)
        for item in active_outcomes(outcomes)
    }
    total = sum(exps.values()) or 1.0
    prices = {oid: value / total for oid, value in exps.items()}
    for item in outcomes:
        prices.setdefault(item["id"], 0.0)
    return prices


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
    if outcome_is_eliminated(target):
        raise HTTPException(400, f"{target.get('title') or 'This outcome'} has been eliminated")
    active = active_outcomes(outcomes)
    if len(active) < 2:
        raise HTTPException(400, "Market does not have enough active outcomes to trade")
    b = float(event.get("liquidity_b") or DEFAULT_FAKE_BALANCE)
    amount = float(payload.amount or 0)
    is_complement = len(outcomes) > 2 and len(active) > 1 and payload.side == "no"
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
        complement = [item for item in active if item["id"] != outcome_id]
        if payload.action == "buy":
            shares = lmsr_complement_buy_shares(active, b, outcome_id, amount)
            quote["shares"] = round(shares, 8)
            quote["allocations"] = weighted_allocations(complement, amount)
        else:
            holdings = positions or {}
            max_shares = min([float(holdings.get(item["id"], 0)) for item in complement] or [0.0])
            max_cash = lmsr_complement_sell_cash_for_shares(active, b, outcome_id, max_shares)
            quote["maxCash"] = round(max_cash, 4)
            quote["cashReceived"] = round(min(amount, max_cash), 4)
            quote["shares"] = round(lmsr_complement_sell_shares_for_cash(active, b, outcome_id, min(amount, max_cash), max_shares), 8)
        return quote
    if payload.action == "buy":
        quote["shares"] = round(lmsr_buy_shares(active, b, outcome_id, trade_net_cash(amount)), 8)
    else:
        held = float((positions or {}).get(outcome_id, 0))
        max_cash = trade_net_cash(lmsr_sell_cash_for_shares(active, b, outcome_id, held))
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


def resolve_event_market_all_outcomes(
    db,
    event: dict,
    *,
    resolved_by: str = "manual",
    notes: str | None = None,
) -> dict:
    event_id = event["id"]
    if event.get("status") == "resolved":
        raise HTTPException(400, "Already resolved")
    if event.get("status") not in ("open", "closed"):
        raise HTTPException(400, "Market must be open or closed before resolution")

    resolved_by_clean = (resolved_by or "manual").strip()[:80] or "manual"
    note = (notes or "").strip()[:1200] or "Resolved as draw: all listed outcomes were correct."
    positions = db.table("event_positions").select("participant, shares").eq("event_id", event_id).gt("shares", 0).execute().data or []
    payouts_by_participant: dict[str, float] = {}
    shares_by_participant: dict[str, float] = {}
    for position in positions:
        participant = str(position.get("participant") or "").strip()
        shares = float(position.get("shares") or 0)
        if not participant or shares <= 0:
            continue
        shares_by_participant[participant] = shares_by_participant.get(participant, 0.0) + shares
        payouts_by_participant[participant] = payouts_by_participant.get(participant, 0.0) + shares

    payouts = []
    for participant in sorted(payouts_by_participant):
        payout = round(payouts_by_participant[participant], 2)
        balance_after = None
        member_res = db.table("group_members").select("balance").eq("group_id", event["group_id"]).eq("name", participant).execute()
        if member_res.data:
            current_balance = float(member_res.data[0].get("balance") or 0)
            balance_after = round(current_balance + payout, 2)
            db.table("group_members").update({"balance": balance_after}).eq("group_id", event["group_id"]).eq("name", participant).execute()
        payouts.append({
            "participant": participant,
            "shares": round(shares_by_participant.get(participant, 0.0), 8),
            "payout": payout,
            "balanceAfter": balance_after,
        })

    resolved_at = now_iso()
    db.table("market_events").update({
        "status": "resolved",
        "outcome_id": ALL_OUTCOMES_RESOLUTION,
        "resolved_at": resolved_at,
        "resolved_by": resolved_by_clean,
        "verification_status": "resolved",
        "resolution_notes": note,
    }).eq("id", event_id).execute()

    return {
        "eventId": event_id,
        "outcomeId": ALL_OUTCOMES_RESOLUTION,
        "outcomeTitle": "Draw / all outcomes correct",
        "resolvedBy": resolved_by_clean,
        "resolutionNotes": note,
        "resolvedAt": resolved_at,
        "payouts": payouts,
        "totalPaid": round(sum(item["payout"] for item in payouts), 2),
    }


def group_founder_for_event(db, event: dict) -> str:
    group_rows = db.table("groups").select("created_by").eq("id", event["group_id"]).limit(1).execute().data or []
    founder = clean_person(group_rows[0].get("created_by") if group_rows else None)
    if founder:
        return founder
    members = (
        db.table("group_members")
        .select("name")
        .eq("group_id", event["group_id"])
        .order("joined_at")
        .limit(1)
        .execute()
        .data
        or []
    )
    return clean_person(members[0].get("name") if members else None, clean_person(event.get("created_by"), "manual"))


def event_admins(db, event: dict) -> list[str]:
    founder = group_founder_for_event(db, event)
    creator = clean_person(event.get("created_by"), founder)
    admins: list[str] = []
    seen: set[str] = set()
    for person in [founder, creator]:
        key = person_key(person)
        if person and key not in seen:
            admins.append(person)
            seen.add(key)
    return admins or ["manual"]


def approval_role(resolver: str, founder: str, creator: str) -> str:
    key = person_key(resolver)
    founder_key = person_key(founder)
    creator_key = person_key(creator)
    if key and key == founder_key and key == creator_key:
        return "founder_creator"
    if key and key == founder_key:
        return "founder"
    if key and key == creator_key:
        return "creator"
    return "admin"


def append_event_verification_attempt(db, event: dict, attempt: dict) -> None:
    attempts = event.get("verification_attempts") or []
    if not isinstance(attempts, list):
        attempts = []
    attempts.append(attempt)
    db.table("market_events").update({
        "verification_attempts": attempts[-20:],
        "verification_status": attempt.get("status") or "approval_pending",
    }).eq("id", event["id"]).execute()
    event["verification_attempts"] = attempts[-20:]
    event["verification_status"] = attempt.get("status") or "approval_pending"


def record_resolution_approval(
    db,
    event: dict,
    *,
    outcome_id: str,
    outcome_title: str,
    resolver: str,
    resolver_aliases: list[str] | None = None,
    notes: str | None = None,
) -> dict:
    resolver_clean = clean_person(resolver, "manual")
    founder = group_founder_for_event(db, event)
    creator = clean_person(event.get("created_by"), founder)
    admins = event_admins(db, event)
    admin_keys = {person_key(item) for item in admins}
    resolver_keys = {person_key(resolver_clean)}
    resolver_keys.update(person_key(alias) for alias in (resolver_aliases or []) if clean_person(alias))
    matched_admin = next((admin for admin in admins if person_key(admin) in resolver_keys), "")
    if not matched_admin:
        raise HTTPException(403, "Only the group founder or market creator can resolve this market.")

    role = approval_role(matched_admin, founder, creator)
    note = (notes or "").strip()[:1200] or None
    db.table("market_resolution_approvals").upsert({
        "event_id": event["id"],
        "outcome_id": outcome_id,
        "resolver": matched_admin,
        "role": role,
        "notes": note,
    }, on_conflict="event_id,resolver").execute()

    rows = (
        db.table("market_resolution_approvals")
        .select("*")
        .eq("event_id", event["id"])
        .execute()
        .data
        or []
    )
    relevant = [row for row in rows if person_key(row.get("resolver")) in admin_keys]
    approval_by_key = {person_key(row.get("resolver")): row for row in relevant}
    missing = [person for person in admins if person_key(person) not in approval_by_key]
    approved_outcomes = {str(row.get("outcome_id") or "") for row in relevant if str(row.get("outcome_id") or "")}
    ready = not missing and len(approved_outcomes) == 1 and outcome_id in approved_outcomes
    mismatch = len(approved_outcomes) > 1
    status = "ready_to_resolve" if ready else "needs_review" if mismatch else "approval_pending"
    approval = {
        "eventId": event["id"],
        "outcomeId": outcome_id,
        "outcomeTitle": outcome_title,
        "resolver": resolver_clean,
        "approver": matched_admin,
        "role": role,
        "status": status,
        "requiredResolvers": admins,
        "missingResolvers": missing,
        "approvals": [
            {
                "resolver": row.get("resolver"),
                "role": row.get("role"),
                "outcomeId": row.get("outcome_id"),
                "notes": row.get("notes"),
                "createdAt": row.get("created_at"),
            }
            for row in relevant
        ],
    }
    append_event_verification_attempt(db, event, {
        "type": "manual_approval",
        "status": status,
        "outcomeId": outcome_id,
        "outcomeTitle": outcome_title,
        "resolvedBy": resolver_clean,
        "approver": matched_admin,
        "notes": note,
        "createdAt": now_iso(),
        "requiredResolvers": admins,
        "missingResolvers": missing,
    })
    return approval


def eliminate_event_outcome(
    db,
    event: dict,
    outcome_id: str,
    *,
    eliminated_by: str = "manual",
    notes: str | None = None,
) -> dict:
    event_id = event["id"]
    if event.get("status") == "resolved":
        raise HTTPException(400, "Resolved markets cannot be edited")
    if event.get("status") not in ("open", "closed"):
        raise HTTPException(400, "Market must be open or closed before eliminating an outcome")

    outcomes = db.table("market_outcomes").select("*").eq("event_id", event_id).order("sort_order").execute().data or []
    if len(outcomes) <= 2:
        raise HTTPException(400, "Outcome elimination is only for multi-outcome markets")
    outcome = next((item for item in outcomes if item["id"] == outcome_id), None)
    if not outcome:
        raise HTTPException(400, "Outcome not found")
    if outcome_is_eliminated(outcome):
        raise HTTPException(400, f"{outcome.get('title') or 'This outcome'} is already eliminated")

    active = active_outcomes(outcomes)
    if len(active) <= 2:
        raise HTTPException(400, "Only two outcomes remain. Resolve the market instead.")

    eliminated_by_clean = (eliminated_by or "manual").strip()[:80] or "manual"
    note = (notes or "").strip()[:1200] or f"{outcome['title']} eliminated from contention."
    eliminated_at = now_iso()

    try:
        db.table("market_outcomes").update({
            "status": "eliminated",
            "eliminated_at": eliminated_at,
            "eliminated_by": eliminated_by_clean,
            "elimination_notes": note,
            "price": 0,
            "quantity": -1_000_000_000,
        }).eq("id", outcome_id).eq("event_id", event_id).execute()
        attempts = event.get("verification_attempts") or []
        if not isinstance(attempts, list):
            attempts = []
        attempts.append({
            "type": "elimination",
            "outcomeId": outcome_id,
            "outcomeTitle": outcome.get("title"),
            "by": eliminated_by_clean,
            "notes": note,
            "at": eliminated_at,
        })
        db.table("market_events").update({
            "verification_status": "in_progress",
            "verification_attempts": attempts,
        }).eq("id", event_id).execute()
        db.rpc("probable_reprice_event", {"p_event_id": event_id}).execute()
    except Exception as exc:
        raise HTTPException(400, rpc_error_message(exc)) from exc

    return {
        "eventId": event_id,
        "outcomeId": outcome_id,
        "outcomeTitle": outcome["title"],
        "eliminatedBy": eliminated_by_clean,
        "eliminationNotes": note,
        "eliminatedAt": eliminated_at,
    }


# ── Lifespan ───────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app_: FastAPI):
    def run_boot_maintenance() -> None:
        try:
            db = get_db()
            close_expired_markets(db, force=True)
            if os.environ.get("RUN_LEGACY_MIGRATION_ON_BOOT", "").lower() in {"1", "true", "yes"}:
                migrate_legacy_events(db)
        except Exception as exc:
            print(f"Startup maintenance warning: {exc}")

    threading.Thread(target=run_boot_maintenance, daemon=True).start()
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
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/groups")
def list_groups(
    compact: bool = True,
    limit: int | None = None,
    include: str | None = None,
    members: str | None = None,
) -> dict:
    return groups_response(compact=compact, limit=limit, include=include, members=members)


@app.get("/api/markets/{market_id}/context")
def get_market_context(market_id: str) -> dict:
    group = load_market_context_group(market_id)
    groups = groups_response(compact=True, limit=20, include=group["id"]).get("groups", [])
    return {"group": group, "groups": groups}


@app.get("/api/markets/{market_id}/image")
def get_market_image(market_id: str) -> Response:
    image_url: str | None = None
    try:
        event, _route_outcome = require_event_or_outcome(market_id)
        image_url = event.get("image_url")
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        legacy = require_market(market_id)
        image_url = legacy.get("image_url")

    if not image_url:
        raise HTTPException(404, "Market image not found")

    if image_url.startswith("data:image") and "," in image_url:
        header, encoded = image_url.split(",", 1)
        media_type = header[5:].split(";", 1)[0] or "image/png"
        try:
            raw = base64.b64decode(encoded)
        except Exception:
            raise HTTPException(422, "Market image is invalid")
        return Response(
            content=raw,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"},
        )

    if image_url.startswith(("http://", "https://")):
        return RedirectResponse(image_url, status_code=307)

    if image_url.startswith("/"):
        path = BASE_DIR / "public" / image_url.lstrip("/")
        if path.exists() and path.is_file():
            return FileResponse(path, headers={"Cache-Control": "public, max-age=86400"})

    raise HTTPException(404, "Market image not found")


@app.post("/api/groups", status_code=201)
def create_group(payload: GroupCreate) -> dict:
    db = get_db()
    cleaned = [m.strip() for m in payload.members if m.strip()]
    if not cleaned:
        raise HTTPException(400, "At least one member is required")

    group_id = create_id()
    founder = (payload.createdBy or cleaned[0]).strip()[:80] or cleaned[0]
    group_row = {
        "id":    group_id,
        "name":  payload.name.strip(),
        "emoji": payload.emoji.strip() or "📣",
        "mode":  payload.mode,
        "created_by": founder,
    }
    try:
        db.table("groups").insert(group_row).execute()
    except Exception:
        # Older live databases may not have groups.created_by until the migration
        # is applied. Creation should still work; admin hardening uses the first
        # member as founder fallback in that case.
        group_row.pop("created_by", None)
        db.table("groups").insert(group_row).execute()

    db.table("group_members").insert([
        {"group_id": group_id, "name": m, "balance": DEFAULT_FAKE_BALANCE}
        for m in cleaned
    ]).execute()

    return groups_response(groupId=group_id)


@app.get("/api/brackets/{challenge_id}/entry")
def get_bracket_entry(challenge_id: str, participant: str | None = None, entry: str | None = None) -> dict:
    db = get_db()
    clean_challenge = re.sub(r"[^a-zA-Z0-9_-]", "", challenge_id)[:80]
    if entry:
        return {"entry": get_bracket_entry_by_id(clean_challenge, entry)}
    clean_participant = clean_person(participant)
    if not clean_challenge or not clean_participant:
        raise HTTPException(400, "Bracket entry identity is missing")
    rows = (
        db.table("bracket_entries")
        .select("*")
        .eq("challenge_id", clean_challenge)
        .eq("participant", clean_participant)
        .limit(1)
        .execute()
        .data
        or []
    )
    return {"entry": assemble_bracket_entry(rows[0] if rows else None)}


@app.post("/api/brackets/{challenge_id}/entry", status_code=201)
def save_bracket_entry(challenge_id: str, payload: BracketEntrySave) -> dict:
    db = get_db()
    clean_challenge = re.sub(r"[^a-zA-Z0-9_-]", "", challenge_id)[:80]
    participant = clean_person(payload.participant)
    if not clean_challenge or not participant:
        raise HTTPException(400, "Bracket entry identity is missing")
    cleaned_picks = clean_bracket_picks(payload.picks)
    existing_rows = (
        db.table("bracket_entries")
        .select("*")
        .eq("challenge_id", clean_challenge)
        .eq("participant", participant)
        .limit(1)
        .execute()
        .data
        or []
    )
    if existing_rows and existing_rows[0].get("submitted_at"):
        existing_entry = assemble_bracket_entry(existing_rows[0])
        existing_picks = clean_bracket_picks(existing_entry.get("picks") if existing_entry else {})
        if existing_picks != cleaned_picks or not payload.submitted:
            raise HTTPException(409, "Bracket already submitted and locked.")
        return {"entry": existing_entry}
    row = {
        "challenge_id": clean_challenge,
        "participant": participant,
        "user_email": clean_person(payload.userEmail, "") or None,
        "picks": cleaned_picks,
        "submitted_at": now_iso() if payload.submitted else None,
        "updated_at": now_iso(),
    }
    result = (
        db.table("bracket_entries")
        .upsert(row, on_conflict="challenge_id,participant")
        .execute()
    )
    saved = None
    if result.data:
        saved = result.data[0]
    else:
        saved_rows = (
            db.table("bracket_entries")
            .select("*")
            .eq("challenge_id", clean_challenge)
            .eq("participant", participant)
            .limit(1)
            .execute()
            .data
            or []
        )
        saved = saved_rows[0] if saved_rows else row
    return {"entry": assemble_bracket_entry(saved)}


BRACKET_CHALLENGE_META = {
    "id": "wc26-bracket-r32",
    "prize": "up to $500",
    "title": "World Cup Bracket Challenge",
    "subtitle": "Free to enter. Submit the cleanest knockout bracket from the Round of 32 onward.",
}


def bracket_entry_count(challenge_id: str) -> int:
    db = get_db()
    try:
        result = (
            db.table("bracket_entries")
            .select("id", count="exact")
            .eq("challenge_id", challenge_id)
            .not_.is_("submitted_at", "null")
            .execute()
        )
        return int(result.count or 0)
    except Exception:
        return 0


def bracket_card_payload(challenge_id: str, request: Request | None = None) -> dict:
    share_base = share_base_url(request)
    app_base = frontend_base_url(request)
    meta = BRACKET_CHALLENGE_META
    entries = bracket_entry_count(challenge_id)
    joined = f"{entries:,} bracket{'s' if entries != 1 else ''} submitted" if entries else "Be the first to submit a bracket"
    return {
        "title": f"{meta['title']} · {meta['prize']} for perfect knockouts",
        "description": f"{meta['subtitle']} {joined}.",
        "entries": entries,
        "url": f"{share_base}/bracket",
        "appUrl": f"{app_base}/bracket",
        "imageUrl": f"{share_base}/api/brackets/{challenge_id}/share-card.png",
    }


BRACKET_BASE_MATCHUPS = [
    {"id": "m73", "teams": ["South Africa", "Canada"], "winner": "Canada", "completed": True},
    {"id": "m74", "teams": ["Germany", "Paraguay"], "winner": "Paraguay", "completed": True},
    {"id": "m75", "teams": ["Netherlands", "Morocco"], "winner": "Morocco", "completed": True},
    {"id": "m76", "teams": ["Brazil", "Japan"], "winner": "Brazil", "completed": True},
    {"id": "m77", "teams": ["France", "Sweden"]},
    {"id": "m78", "teams": ["Ivory Coast", "Norway"], "winner": "Norway", "completed": True},
    {"id": "m79", "teams": ["Mexico", "Ecuador"]},
    {"id": "m80", "teams": ["England", "DR Congo"]},
    {"id": "m81", "teams": ["USA", "Bosnia and Herzegovina"]},
    {"id": "m82", "teams": ["Belgium", "Senegal"]},
    {"id": "m83", "teams": ["Portugal", "Croatia"]},
    {"id": "m84", "teams": ["Spain", "Austria"]},
    {"id": "m85", "teams": ["Switzerland", "Algeria"]},
    {"id": "m86", "teams": ["Argentina", "Cabo Verde"]},
    {"id": "m87", "teams": ["Colombia", "Ghana"]},
    {"id": "m88", "teams": ["Australia", "Egypt"]},
]

BRACKET_DERIVED_MATCHUPS = {
    "m89": ("m74", "m77"),
    "m90": ("m73", "m75"),
    "m91": ("m76", "m78"),
    "m92": ("m79", "m80"),
    "m93": ("m81", "m82"),
    "m94": ("m83", "m84"),
    "m95": ("m86", "m88"),
    "m96": ("m85", "m87"),
    "m97": ("m89", "m90"),
    "m98": ("m93", "m94"),
    "m99": ("m91", "m92"),
    "m100": ("m95", "m96"),
    "m101": ("m97", "m98"),
    "m102": ("m99", "m100"),
    "final": ("m101", "m102"),
}

BRACKET_SAMPLE_PICKS = {
    "m74": "Germany", "m75": "Morocco", "m77": "France", "m78": "Norway",
    "m79": "Mexico", "m80": "England", "m81": "USA", "m82": "Senegal",
    "m83": "Portugal", "m84": "Spain", "m85": "Switzerland", "m86": "Argentina",
    "m87": "Colombia", "m88": "Australia", "m89": "France", "m90": "Morocco",
    "m91": "Brazil", "m92": "England", "m93": "USA", "m94": "Spain",
    "m95": "Argentina", "m96": "Colombia", "m97": "France", "m98": "Spain",
    "m99": "Brazil", "m100": "Argentina", "m101": "France", "m102": "Argentina", "final": "France",
}

BRACKET_FLAG = {
    "Algeria": "🇩🇿", "Argentina": "🇦🇷", "Australia": "🇦🇺", "Austria": "🇦🇹",
    "Belgium": "🇧🇪", "Bosnia and Herzegovina": "🇧🇦", "Brazil": "🇧🇷", "Cabo Verde": "🇨🇻",
    "Canada": "🇨🇦", "Colombia": "🇨🇴", "Croatia": "🇭🇷", "DR Congo": "🇨🇩",
    "Ecuador": "🇪🇨", "Egypt": "🇪🇬", "England": "🏴", "France": "🇫🇷",
    "Germany": "🇩🇪", "Ghana": "🇬🇭", "Ivory Coast": "🇨🇮", "Japan": "🇯🇵",
    "Mexico": "🇲🇽", "Morocco": "🇲🇦", "Netherlands": "🇳🇱", "Norway": "🇳🇴",
    "Paraguay": "🇵🇾", "Portugal": "🇵🇹", "Senegal": "🇸🇳", "South Africa": "🇿🇦",
    "Spain": "🇪🇸", "Sweden": "🇸🇪", "Switzerland": "🇨🇭", "USA": "🇺🇸",
}


def get_bracket_entry_for_participant(challenge_id: str, participant: str | None) -> dict | None:
    clean_challenge = re.sub(r"[^a-zA-Z0-9_-]", "", challenge_id)[:80]
    clean_participant = clean_person(participant)
    if not clean_challenge or not clean_participant:
        return None
    try:
        rows = (
            get_db()
            .table("bracket_entries")
            .select("*")
            .eq("challenge_id", clean_challenge)
            .eq("participant", clean_participant)
            .limit(1)
            .execute()
            .data
            or []
        )
        return assemble_bracket_entry(rows[0]) if rows else None
    except Exception:
        return None


def get_bracket_entry_by_id(challenge_id: str, entry_id: str | None) -> dict | None:
    clean_challenge = re.sub(r"[^a-zA-Z0-9_-]", "", challenge_id)[:80]
    clean_entry_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(entry_id or ""))[:80]
    if not clean_challenge or not clean_entry_id:
        return None
    try:
        rows = (
            get_db()
            .table("bracket_entries")
            .select("*")
            .eq("challenge_id", clean_challenge)
            .eq("id", clean_entry_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        return assemble_bracket_entry(rows[0]) if rows else None
    except Exception:
        return None


def bracket_locked_winners() -> dict[str, str]:
    return {
        item["id"]: item["winner"]
        for item in BRACKET_BASE_MATCHUPS
        if item.get("completed") and item.get("winner")
    }


def bracket_official_winner(matchup_id: str) -> str | None:
    return bracket_locked_winners().get(matchup_id)


def bracket_user_pick(matchup_id: str, picks: dict[str, str]) -> str | None:
    value = clean_person((picks or {}).get(matchup_id))
    return value or None


def bracket_winner(matchup_id: str, picks: dict[str, str]) -> str | None:
    return bracket_user_pick(matchup_id, picks) or bracket_official_winner(matchup_id)


def bracket_eliminated_teams() -> set[str]:
    eliminated: set[str] = set()
    for item in BRACKET_BASE_MATCHUPS:
        winner = item.get("winner") if item.get("completed") else None
        if not winner:
            continue
        for team in item.get("teams") or []:
            if team and team != winner:
                eliminated.add(team)
    return eliminated


def bracket_team_status(matchup_id: str, team: str, picks: dict[str, str]) -> str:
    official = bracket_official_winner(matchup_id)
    user_pick = bracket_user_pick(matchup_id, picks)
    if official:
        if user_pick and user_pick == team:
            return "correct" if team == official else "wrong"
        if not user_pick and team == official:
            return "auto"
        return "official_loser"
    if team in bracket_eliminated_teams():
        return "dead"
    if user_pick == team:
        return "user"
    return ""


def bracket_matchup_teams(matchup_id: str, picks: dict[str, str]) -> list[str]:
    base = next((item for item in BRACKET_BASE_MATCHUPS if item["id"] == matchup_id), None)
    if base:
        return list(base["teams"])
    parents = BRACKET_DERIVED_MATCHUPS.get(matchup_id)
    if not parents:
        return []
    return [team for team in (bracket_winner(parents[0], picks), bracket_winner(parents[1], picks)) if team]


def decode_bracket_picks_param(value: str | None) -> dict[str, str] | None:
    if not value:
        return None
    try:
        padded = value + ("=" * (-len(value) % 4))
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        decoded = json.loads(raw)
        if isinstance(decoded, dict):
            return clean_bracket_picks(decoded)
    except Exception:
        return None
    return None


def bracket_render_payload(
    challenge_id: str,
    participant: str | None,
    sample: bool,
    picks_param: str | None = None,
    entry_id: str | None = None,
) -> tuple[dict[str, str], str, str]:
    if entry_id:
        entry = get_bracket_entry_by_id(challenge_id, entry_id)
        if entry:
            picks = clean_bracket_picks(entry.get("picks") or {})
            return picks, clean_person(entry.get("participant"), "Bracket"), bracket_winner("final", picks) or "TBD"
    url_picks = decode_bracket_picks_param(picks_param)
    if url_picks:
        owner = clean_person(participant, "Shared Bracket")
        return url_picks, owner, bracket_winner("final", url_picks) or "TBD"
    if sample:
        return dict(BRACKET_SAMPLE_PICKS), "Sample Bracket", "France"
    entry = get_bracket_entry_for_participant(challenge_id, participant)
    if entry:
        picks = clean_bracket_picks(entry.get("picks") or {})
        return picks, clean_person(entry.get("participant"), "Bracket"), bracket_winner("final", picks) or "TBD"
    return {}, "World Cup Bracket", "TBD"


@app.head("/api/brackets/{challenge_id}/share-card.png")
@app.get("/api/brackets/{challenge_id}/share-card.png")
def bracket_share_card_png(
    challenge_id: str,
    participant: str | None = None,
    sample: bool = False,
    picks: str | None = None,
    entry: str | None = None,
) -> Response:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception as exc:
        raise HTTPException(503, "PNG share cards require Pillow. Run pip install -r requirements.txt") from exc

    picks, owner, champion = bracket_render_payload(challenge_id, participant, sample, picks, entry)
    meta = BRACKET_CHALLENGE_META

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

    team_codes = {
        "South Africa": "RSA", "Canada": "CAN", "Germany": "GER", "Paraguay": "PAR",
        "France": "FRA", "Sweden": "SWE", "Netherlands": "NED", "Morocco": "MAR",
        "USA": "USA", "Bosnia and Herzegovina": "BIH", "Belgium": "BEL", "Senegal": "SEN",
        "Portugal": "POR", "Croatia": "CRO", "Spain": "ESP", "Austria": "AUT",
        "Brazil": "BRA", "Japan": "JPN", "Ivory Coast": "CIV", "Norway": "NOR",
        "Mexico": "MEX", "Ecuador": "ECU", "England": "ENG", "DR Congo": "COD",
        "Argentina": "ARG", "Cabo Verde": "CPV", "Australia": "AUS", "Egypt": "EGY",
        "Switzerland": "SUI", "Algeria": "ALG", "Colombia": "COL", "Ghana": "GHA",
    }
    flag_patterns = {
        "Algeria": ("vertical", ["#006233", "#ffffff"], "#d21034"),
        "Argentina": ("horizontal", ["#75aadb", "#ffffff", "#75aadb"], "#f6c343"),
        "Australia": ("solid", ["#012169"], "#e6eef7"),
        "Austria": ("horizontal", ["#ed2939", "#ffffff", "#ed2939"], None),
        "Belgium": ("vertical", ["#000000", "#ffd90c", "#ef3340"], None),
        "Bosnia and Herzegovina": ("solid", ["#002f6c"], "#f7d117"),
        "Brazil": ("brazil", ["#009b3a", "#ffdf00", "#002776"], None),
        "Cabo Verde": ("horizontal", ["#003893", "#003893", "#ffffff", "#cf2027", "#003893"], None),
        "Canada": ("vertical", ["#ff0000", "#ffffff", "#ff0000"], "#ff0000"),
        "Colombia": ("horizontal", ["#fcd116", "#003893", "#ce1126"], None),
        "Croatia": ("horizontal", ["#ff0000", "#ffffff", "#171796"], None),
        "DR Congo": ("diagonal", ["#00a3e0", "#f7d618", "#ce1021"], None),
        "Ecuador": ("horizontal", ["#ffdd00", "#034ea2", "#ed1c24"], None),
        "Egypt": ("horizontal", ["#ce1126", "#ffffff", "#000000"], None),
        "England": ("england", ["#ffffff", "#cf142b"], None),
        "France": ("vertical", ["#0055a4", "#ffffff", "#ef4135"], None),
        "Germany": ("horizontal", ["#000000", "#dd0000", "#ffce00"], None),
        "Ghana": ("horizontal", ["#ce1126", "#fcd116", "#006b3f"], "#111111"),
        "Ivory Coast": ("vertical", ["#f77f00", "#ffffff", "#009e60"], None),
        "Japan": ("solid", ["#ffffff"], "#bc002d"),
        "Mexico": ("vertical", ["#006847", "#ffffff", "#ce1126"], None),
        "Morocco": ("solid", ["#c1272d"], "#006233"),
        "Netherlands": ("horizontal", ["#ae1c28", "#ffffff", "#21468b"], None),
        "Norway": ("cross", ["#ba0c2f", "#ffffff", "#00205b"], None),
        "Paraguay": ("horizontal", ["#d52b1e", "#ffffff", "#0038a8"], None),
        "Portugal": ("vertical", ["#006600", "#ff0000"], "#ffcc00"),
        "Senegal": ("vertical", ["#00853f", "#fdef42", "#e31b23"], "#00853f"),
        "South Africa": ("horizontal", ["#007a4d", "#ffb81c", "#de3831", "#002395"], None),
        "Spain": ("horizontal", ["#aa151b", "#f1bf00", "#aa151b"], None),
        "Sweden": ("cross", ["#006aa7", "#fecc00", "#fecc00"], None),
        "Switzerland": ("swiss", ["#ff0000", "#ffffff"], None),
        "USA": ("usa", ["#b22234", "#ffffff", "#3c3b6e"], None),
    }

    def team_code(team: str) -> str:
        return team_codes.get(team, re.sub(r"[^A-Z]", "", str(team).upper())[:3] or "---")

    def fit_text(draw, text: str, fnt, max_width: int) -> str:
        text = str(text or "")
        if draw.textlength(text, font=fnt) <= max_width:
            return text
        while text and draw.textlength(text + "…", font=fnt) > max_width:
            text = text[:-1]
        return (text + "…") if text else "…"

    def draw_flag_badge(team: str, x: int, y: int, w: int, h: int, dim: bool = False) -> None:
        pattern, colors, accent = flag_patterns.get(team, ("solid", ["#17242c"], None))
        draw.rounded_rectangle((x, y, x + w, y + h), radius=4, fill="#0b1216", outline="#24313a", width=1)
        inset = 1
        x1, y1, x2, y2 = x + inset, y + inset, x + w - inset, y + h - inset
        if pattern == "vertical":
            stripe_w = max(1, (x2 - x1) / len(colors))
            for idx, color in enumerate(colors):
                draw.rectangle((x1 + idx * stripe_w, y1, x1 + (idx + 1) * stripe_w, y2), fill=color)
        elif pattern == "horizontal":
            stripe_h = max(1, (y2 - y1) / len(colors))
            for idx, color in enumerate(colors):
                draw.rectangle((x1, y1 + idx * stripe_h, x2, y1 + (idx + 1) * stripe_h), fill=color)
        elif pattern == "cross":
            draw.rectangle((x1, y1, x2, y2), fill=colors[0])
            draw.rectangle((x1, y1 + h * 0.38, x2, y1 + h * 0.62), fill=colors[1])
            draw.rectangle((x1 + w * 0.32, y1, x1 + w * 0.48, y2), fill=colors[1])
            if len(colors) > 2 and colors[2] != colors[1]:
                draw.rectangle((x1, y1 + h * 0.44, x2, y1 + h * 0.56), fill=colors[2])
                draw.rectangle((x1 + w * 0.36, y1, x1 + w * 0.44, y2), fill=colors[2])
        elif pattern == "england":
            draw.rectangle((x1, y1, x2, y2), fill=colors[0])
            draw.rectangle((x1, y1 + h * 0.42, x2, y1 + h * 0.58), fill=colors[1])
            draw.rectangle((x1 + w * 0.42, y1, x1 + w * 0.58, y2), fill=colors[1])
        elif pattern == "swiss":
            draw.rectangle((x1, y1, x2, y2), fill=colors[0])
            draw.rectangle((x1 + w * 0.38, y1 + h * 0.22, x1 + w * 0.62, y2 - h * 0.22), fill=colors[1])
            draw.rectangle((x1 + w * 0.24, y1 + h * 0.39, x2 - w * 0.24, y1 + h * 0.61), fill=colors[1])
        elif pattern == "brazil":
            draw.rectangle((x1, y1, x2, y2), fill=colors[0])
            draw.polygon([(x1 + w / 2, y1 + 2), (x2 - 3, y1 + h / 2), (x1 + w / 2, y2 - 2), (x1 + 3, y1 + h / 2)], fill=colors[1])
            draw.ellipse((x1 + w * 0.38, y1 + h * 0.28, x1 + w * 0.62, y1 + h * 0.72), fill=colors[2])
        elif pattern == "diagonal":
            draw.rectangle((x1, y1, x2, y2), fill=colors[0])
            draw.line((x1 - 2, y2, x2 + 2, y1), fill=colors[1], width=max(2, h // 4))
            draw.line((x1 - 2, y2, x2 + 2, y1), fill=colors[2], width=max(1, h // 7))
        elif pattern == "usa":
            stripe_h = max(1, (y2 - y1) / 7)
            for idx in range(7):
                draw.rectangle((x1, y1 + idx * stripe_h, x2, y1 + (idx + 1) * stripe_h), fill=colors[idx % 2])
            draw.rectangle((x1, y1, x1 + w * 0.45, y1 + h * 0.56), fill=colors[2])
        else:
            draw.rectangle((x1, y1, x2, y2), fill=colors[0])
        if accent:
            r = max(2, min(w, h) // 5)
            draw.ellipse((x + w / 2 - r, y + h / 2 - r, x + w / 2 + r, y + h / 2 + r), fill=accent)
        if dim:
            draw.rounded_rectangle((x, y, x + w, y + h), radius=4, outline="#3c474f", width=1)

    image = Image.new("RGB", (1600, 900), "#090f13")
    draw = ImageDraw.Draw(image)
    for y in range(900):
        shade = int(10 + y / 900 * 18)
        draw.line((0, y, 1600, y), fill=(6, shade, min(42, shade + 18)))
    draw.rounded_rectangle((1040, -80, 1680, 330), radius=120, fill="#071426")

    logo_font = font(28, True)
    title_font = font(44, True)
    label_font = font(18, True)
    name_font = font(16, True)
    small_font = font(14, False)
    compact_font = font(15, True)

    draw.text((52, 34), "probable.", fill="#f2f7fb", font=logo_font)
    draw.ellipse((174, 55, 182, 63), fill="#149cff")
    owner_title = "Sample World Cup bracket" if owner == "Sample Bracket" else (f"{owner}'s World Cup bracket" if owner not in {"World Cup Bracket", "Bracket"} else "World Cup bracket")
    draw.text((52, 82), owner_title, fill="#f6fbff", font=title_font)
    draw.text((54, 136), f"{meta['prize']} for perfect knockouts · Champion: {champion}", fill="#a8b5c0", font=font(24, False))

    line_color = "#168eea"
    muted_line = "#24414f"
    card_bg = "#071114"
    card_stroke = "#1f4153"
    selected_bg = "#104b82"
    locked_bg = "#37434b"
    correct_bg = "#156f4c"
    wrong_bg = "#5a2028"
    auto_bg = "#303a43"
    text = "#eef5fb"
    muted = "#8e9ca7"

    left_ids = ["m74", "m77", "m73", "m75", "m81", "m82", "m83", "m84"]
    right_ids = ["m76", "m78", "m79", "m80", "m86", "m88", "m85", "m87"]
    left_r16 = ["m89", "m90", "m93", "m94"]
    right_r16 = ["m91", "m92", "m95", "m96"]
    left_qf = ["m97", "m98"]
    right_qf = ["m99", "m100"]
    left_sf = ["m101"]
    right_sf = ["m102"]

    centers: dict[str, tuple[int, int]] = {}
    sizes: dict[str, tuple[int, int]] = {}
    rendered_matchups: list[tuple[str, int, int, int, str, bool]] = []

    def row_y(index: int) -> int:
        return 205 + index * 78

    def matchup_center(matchup_id: str, default_y: int | None = None) -> int:
        parents = BRACKET_DERIVED_MATCHUPS.get(matchup_id)
        if parents and parents[0] in centers and parents[1] in centers:
            return int((centers[parents[0]][1] + centers[parents[1]][1]) / 2)
        return int(default_y or 450)

    def draw_matchup(matchup_id: str, x: int, cy: int, width: int, side: str, compact: bool = False, record: bool = True) -> None:
        teams = bracket_matchup_teams(matchup_id, picks)
        winner = bracket_winner(matchup_id, picks)
        height = 54 if not compact else 44
        y = int(cy - height / 2)
        centers[matchup_id] = (x + width // 2, cy)
        sizes[matchup_id] = (width, height)
        if record:
            rendered_matchups.append((matchup_id, x, cy, width, side, compact))
        draw.rounded_rectangle((x, y, x + width, y + height), radius=13, fill=card_bg, outline=card_stroke, width=2)
        if len(teams) < 2:
            draw.text((x + width / 2 - draw.textlength("Awaiting", font=small_font) / 2, y + height / 2 - 8), "Awaiting", fill="#5f6d76", font=small_font)
            return
        row_h = height / 2
        for idx, team in enumerate(teams[:2]):
            row_top = y + int(idx * row_h)
            active = bool(winner and winner == team)
            status = bracket_team_status(matchup_id, team, picks)
            if active:
                fill = selected_bg
                stripe = "#159cff"
                if status == "correct":
                    fill = correct_bg
                    stripe = "#35c46f"
                elif status in {"wrong", "dead"}:
                    fill = wrong_bg
                    stripe = "#ff5d6c"
                elif status == "auto":
                    fill = auto_bg
                    stripe = "#9aa7af"
                draw.rounded_rectangle((x + 1, row_top + 1, x + width - 1, row_top + int(row_h) - 1), radius=10 if idx in (0, 1) else 4, fill=fill)
                draw.rectangle((x + 1, row_top + 4, x + 5, row_top + int(row_h) - 4), fill=stripe)
            elif status in {"wrong", "dead"}:
                draw.rounded_rectangle((x + 1, row_top + 1, x + width - 1, row_top + int(row_h) - 1), radius=10 if idx in (0, 1) else 4, fill="#171116")
            badge_w = 31 if compact else 36
            badge_h = 17 if compact else 18
            badge_x = x + 12
            badge_y = row_top + (5 if not compact else 4)
            draw_flag_badge(team, badge_x, badge_y, badge_w, badge_h, dim=status in {"official_loser", "wrong", "dead"})
            team_label = fit_text(draw, team if not compact else team_code(team), compact_font if compact else name_font, width - badge_w - 32)
            label_fill = text if active else muted
            if status in {"wrong", "dead"}:
                label_fill = "#a8757b"
            elif status in {"auto", "official_loser"}:
                label_fill = "#c4ced7"
            draw.text((badge_x + badge_w + 10, row_top + (4 if not compact else 3)), team_label, fill=label_fill, font=compact_font if compact else name_font)

    def edge(matchup_id: str, side: str) -> tuple[int, int]:
        x, y = centers[matchup_id]
        w, _ = sizes[matchup_id]
        return (x + w // 2, y) if side == "left" else (x - w // 2, y)

    def connect(parent: str, child: str, side: str) -> None:
        if parent not in centers or child not in centers:
            return
        p_x, p_y = edge(parent, "right" if side == "left" else "left")
        c_x, c_y = edge(child, "left" if side == "left" else "right")
        mid_x = int((p_x + c_x) / 2)
        color = line_color if bracket_winner(parent, picks) else muted_line
        draw.line((p_x, p_y, mid_x, p_y), fill=color, width=3)
        draw.line((mid_x, p_y, mid_x, c_y), fill=color, width=3)
        draw.line((mid_x, c_y, c_x, c_y), fill=color, width=3)

    # Round labels
    labels = [(52, "ROUND OF 32"), (350, "R16"), (575, "QF"), (748, "SF"), (795, "FINAL"), (960, "SF"), (1125, "QF"), (1330, "R16"), (1410, "ROUND OF 32")]
    for x, label in labels:
        draw.text((x, 178), label, fill="#71808a", font=label_font)

    for index, matchup_id in enumerate(left_ids):
        draw_matchup(matchup_id, 52, row_y(index), 240, "left")
    for index, matchup_id in enumerate(right_ids):
        draw_matchup(matchup_id, 1308, row_y(index), 240, "right")
    for index, matchup_id in enumerate(left_r16):
        draw_matchup(matchup_id, 335, matchup_center(matchup_id), 185, "left")
        for parent in BRACKET_DERIVED_MATCHUPS[matchup_id]:
            connect(parent, matchup_id, "left")
    for index, matchup_id in enumerate(right_r16):
        draw_matchup(matchup_id, 1080, matchup_center(matchup_id), 185, "right")
        for parent in BRACKET_DERIVED_MATCHUPS[matchup_id]:
            connect(parent, matchup_id, "right")
    for matchup_id in left_qf:
        draw_matchup(matchup_id, 560, matchup_center(matchup_id), 160, "left", compact=True)
        for parent in BRACKET_DERIVED_MATCHUPS[matchup_id]:
            connect(parent, matchup_id, "left")
    for matchup_id in right_qf:
        draw_matchup(matchup_id, 880, matchup_center(matchup_id), 160, "right", compact=True)
        for parent in BRACKET_DERIVED_MATCHUPS[matchup_id]:
            connect(parent, matchup_id, "right")
    for matchup_id in left_sf:
        draw_matchup(matchup_id, 660, matchup_center(matchup_id), 125, "left", compact=True)
        for parent in BRACKET_DERIVED_MATCHUPS[matchup_id]:
            connect(parent, matchup_id, "left")
    for matchup_id in right_sf:
        draw_matchup(matchup_id, 815, matchup_center(matchup_id), 125, "right", compact=True)
        for parent in BRACKET_DERIVED_MATCHUPS[matchup_id]:
            connect(parent, matchup_id, "right")

    final_y = max(620, matchup_center("final"))
    draw_matchup("final", 720, final_y, 160, "left", compact=True)
    for parent in BRACKET_DERIVED_MATCHUPS["final"]:
        if parent in centers:
            parent_is_left = parent == "m101"
            p_x, p_y = edge(parent, "right" if parent_is_left else "left")
            f_x, f_y = edge("final", "left" if parent_is_left else "right")
            color = line_color if bracket_winner(parent, picks) else muted_line
            mid_x = int((p_x + f_x) / 2)
            draw.line((p_x, p_y, mid_x, p_y), fill=color, width=3)
            draw.line((mid_x, p_y, mid_x, f_y), fill=color, width=3)
            draw.line((mid_x, f_y, f_x, f_y), fill=color, width=3)

    # Keep connector rails behind the actual selections.
    for matchup_id, x, cy, width, side, compact in rendered_matchups:
        draw_matchup(matchup_id, x, cy, width, side, compact, record=False)

    if champion and champion != "TBD":
        trophy_y = min(815, final_y + 78)
        draw.rounded_rectangle((714, trophy_y - 24, 886, trophy_y + 56), radius=18, fill="#0a2439", outline="#145ca8", width=2)
        draw.text((800 - draw.textlength("CHAMPION", font=font(14, True)) / 2, trophy_y - 6), "CHAMPION", fill="#f8d56c", font=font(14, True))
        champ_label = fit_text(draw, champion, font(24, True), 140)
        draw.text((800 - draw.textlength(champ_label, font=font(24, True)) / 2, trophy_y + 20), champ_label, fill="#f4f8fb", font=font(24, True))

    # Footer CTA
    draw.rounded_rectangle((1180, 805, 1538, 858), radius=18, fill="#145ca8", outline="#2c9aff", width=1)
    draw.text((1210, 820), "Build yours on probable.live", fill="#ffffff", font=font(24, True))

    output = io.BytesIO()
    image.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png")


@app.head("/b/{entry_id}", response_class=HTMLResponse)
@app.get("/b/{entry_id}", response_class=HTMLResponse)
def short_bracket_open_graph_page(request: Request, entry_id: str) -> str:
    return bracket_open_graph_page(request=request, entry=entry_id)


@app.head("/bracket", response_class=HTMLResponse)
@app.get("/bracket", response_class=HTMLResponse)
def bracket_open_graph_page(
    request: Request,
    participant: str | None = None,
    picks: str | None = None,
    entry: str | None = None,
) -> str:
    challenge_id = BRACKET_CHALLENGE_META["id"]
    card = bracket_card_payload(challenge_id, request)
    safe_participant = clean_person(participant or "", "")
    image_url = card["imageUrl"]
    title = card["title"]
    description = card["description"]
    query_parts = []
    if entry:
        query_parts.append(f"entry={quote_plus(entry)}")
    if safe_participant:
        query_parts.append(f"participant={quote_plus(safe_participant)}")
    if picks:
        query_parts.append(f"picks={quote_plus(picks)}")
    if query_parts:
        image_url = f"{image_url}?{'&'.join(query_parts)}"
    entry_record = get_bracket_entry_by_id(challenge_id, entry) if entry else None
    if entry_record and not safe_participant:
        safe_participant = clean_person(entry_record.get("participant"), "")
    if safe_participant or picks or entry:
        display_name = safe_participant or "Shared Bracket"
        title = f"{display_name}'s World Cup bracket · {BRACKET_CHALLENGE_META['prize']} for perfect knockouts"
        description = "See their World Cup bracket, then build yours on Probable."
    return f"""<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{esc_html(title)} · Probable</title>
<meta name="description" content="{esc_html(description)}"/>
<meta property="og:type" content="website"/><meta property="og:site_name" content="Probable"/>
<meta property="og:title" content="{esc_html(title)}"/>
<meta property="og:description" content="{esc_html(description)}"/>
<meta property="og:image" content="{esc_html(image_url)}"/>
<meta property="og:image:width" content="1600"/><meta property="og:image:height" content="900"/>
<meta property="og:url" content="{esc_html(card['url'])}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="{esc_html(title)}"/>
<meta name="twitter:description" content="{esc_html(description)}"/>
<meta name="twitter:image" content="{esc_html(image_url)}"/>
<style>body{{margin:0;background:#0d1216;color:#f4f7fa;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}}a{{background:#145ca8;color:white;text-decoration:none;padding:14px 18px;border-radius:12px;font-weight:800}}main{{max-width:720px;padding:28px;text-align:center}}img{{width:100%;border-radius:18px;border:1px solid #2b3944}}</style></head><body><main><img src="{esc_html(image_url)}" alt="World Cup bracket challenge preview"/><h1>{esc_html(title)}</h1><p>{esc_html(description)}</p><a href="{esc_html(card['appUrl'])}">Open bracket</a></main></body></html>"""


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


@app.post("/api/markets/odds/seed")
async def seed_market_odds(payload: MarketOddsSeed) -> dict:
    question = clean_market_question(payload.question)
    outcomes = normalize_outcomes(payload.outcomes)
    closes_at = parse_iso_datetime(payload.closesAt) if payload.closesAt else None
    seed_payload = payload.model_copy(update={"question": question, "outcomes": outcomes})
    seed = await ai_market_odds_seed(seed_payload, outcomes, closes_at)
    return {"seed": seed}


def place_complement_event_trade(db, event: dict, outcomes: list[dict], excluded_outcome_id: str, payload: TradeCreate) -> dict:
    participant = payload.participant.strip()
    amount = round(float(payload.amount or 0), 4)
    if amount <= 0:
        raise HTTPException(400, "Trade amount must be positive")
    if event["status"] != "open":
        raise HTTPException(400, "Market is not open for trading")
    closes_at = parse_iso_datetime(event.get("closes_at"))
    if closes_at and closes_at <= datetime.now(timezone.utc):
        db.table("market_events").update({"status": "closed"}).eq("id", event["id"]).execute()
        raise HTTPException(400, "Market is closed for trading")

    target = next((item for item in outcomes if item["id"] == excluded_outcome_id), None)
    if not target:
        raise HTTPException(400, "Outcome not found")
    if outcome_is_eliminated(target):
        raise HTTPException(400, f"{target.get('title') or 'This outcome'} has been eliminated")
    active = active_outcomes(outcomes)
    if len(active) < 2:
        raise HTTPException(400, "NO basket trades require at least two active outcomes")
    complement = [item for item in active if item["id"] != excluded_outcome_id]
    if not complement:
        raise HTTPException(400, "No complement outcomes available")

    member_rows = (
        db.table("group_members")
        .select("balance")
        .eq("group_id", event["group_id"])
        .eq("name", participant)
        .execute()
        .data or []
    )
    if not member_rows:
        db.table("group_members").insert({
            "group_id": event["group_id"],
            "name": participant,
            "balance": DEFAULT_FAKE_BALANCE,
        }).execute()
        balance = DEFAULT_FAKE_BALANCE
    else:
        balance = float(member_rows[0].get("balance") or 0)

    b = float(event.get("liquidity_b") or DEFAULT_FAKE_BALANCE)
    prices_before = {item["id"]: round(float(item.get("price") or 0), 8) for item in outcomes}
    quantities = {item["id"]: float(item.get("quantity") or 0) for item in outcomes}

    if payload.action == "buy":
        if amount > balance:
            raise HTTPException(400, f"{participant} only has ${round(balance, 0)}")
        shares = lmsr_complement_buy_shares(active, b, excluded_outcome_id, amount)
        if shares <= 0:
            raise HTTPException(400, "Trade amount is too small")
        cash_delta = -amount
        share_delta = shares
    else:
        position_rows = (
            db.table("event_positions")
            .select("outcome_id, shares")
            .eq("event_id", event["id"])
            .eq("participant", participant)
            .execute()
            .data or []
        )
        positions = {row["outcome_id"]: float(row.get("shares") or 0) for row in position_rows}
        max_shares = min([positions.get(item["id"], 0.0) for item in complement] or [0.0])
        max_cash = lmsr_complement_sell_cash_for_shares(active, b, excluded_outcome_id, max_shares)
        if amount > max_cash + 0.0001:
            raise HTTPException(400, f"{participant} can cash out up to ${round(max_cash, 2)} on this NO basket")
        shares = lmsr_complement_sell_shares_for_cash(active, b, excluded_outcome_id, amount, max_shares)
        if shares <= 0 or shares > max_shares + 0.0001:
            raise HTTPException(400, f"{participant} does not have enough NO shares to sell")
        cash_delta = amount
        share_delta = -shares

    for item in complement:
        quantities[item["id"]] = quantities[item["id"]] + share_delta
        if quantities[item["id"]] < -1_000_000_000:
            raise HTTPException(400, "Invalid complement trade")

    priced_outcomes = [{**item, "quantity": quantities[item["id"]]} for item in outcomes]
    prices_after = lmsr_prices_for_quantities(priced_outcomes, b)
    now = now_iso()
    for item in priced_outcomes:
        db.table("market_outcomes").update({
            "quantity": round(float(item["quantity"]), 8),
            "price": round(float(prices_after[item["id"]]), 8),
        }).eq("id", item["id"]).eq("event_id", event["id"]).execute()

    db.table("group_members").update({
        "balance": round(balance + cash_delta, 2),
    }).eq("group_id", event["group_id"]).eq("name", participant).execute()

    existing_positions = (
        db.table("event_positions")
        .select("outcome_id, shares")
        .eq("event_id", event["id"])
        .eq("participant", participant)
        .execute()
        .data or []
    )
    position_lookup = {row["outcome_id"]: float(row.get("shares") or 0) for row in existing_positions}
    for item in complement:
        next_shares = round(position_lookup.get(item["id"], 0.0) + share_delta, 8)
        if next_shares < -0.0001:
            raise HTTPException(400, f"{participant} does not have enough NO shares to sell")
        db.table("event_positions").upsert({
            "event_id": event["id"],
            "outcome_id": item["id"],
            "participant": participant,
            "shares": max(0.0, next_shares),
            "updated_at": now,
        }, on_conflict="event_id,outcome_id,participant").execute()

    allocation_weights = [max(0.000001, float(prices_before.get(item["id"], 0))) for item in complement]
    allocation_total = sum(allocation_weights) or len(complement)
    trade_rows = []
    remaining_cash = amount
    display_group_id = create_id()
    for idx, item in enumerate(complement):
        if idx == len(complement) - 1:
            cash_amount = remaining_cash
        else:
            cash_amount = round(amount * allocation_weights[idx] / allocation_total, 4)
            remaining_cash = round(remaining_cash - cash_amount, 4)
        trade_rows.append({
            "id": create_id(),
            "event_id": event["id"],
            "outcome_id": item["id"],
            "participant": participant,
            "action": payload.action,
            "cash_amount": cash_amount,
            "shares_delta": round(share_delta, 8),
            "avg_price": round((amount / abs(shares)) if shares else 0, 8),
            "prices_before": prices_before,
            "prices_after": {key: round(value, 8) for key, value in prices_after.items()},
            "display_group_id": display_group_id,
            "display_outcome_id": excluded_outcome_id,
            "display_side": "no",
            "display_shares": round(abs(shares), 8),
            "created_at": now,
        })
    insert_event_trade_rows(db, trade_rows)
    db.table("market_events").update({
        "total_volume": round(float(event.get("total_volume") or 0) + amount, 4),
    }).eq("id", event["id"]).execute()
    return {
        "basket": True,
        "synthetic": "complement_no",
        "selectedOutcomeId": excluded_outcome_id,
        "shares": round(shares, 8),
        "amount": amount,
        "trades": trade_rows,
    }


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
    liquidity = max(float(payload.initialLiquidity or 0), default_event_liquidity(len(outcomes)))
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
        "liquidity_b": liquidity,
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

    initial_prices = initial_outcome_prices(outcomes, payload.initialProbabilities)
    outcome_rows = []
    for idx, outcome in enumerate(outcomes):
        price = initial_prices[idx] if idx < len(initial_prices) else (1.0 / len(outcomes))
        outcome_rows.append({
            "id": create_id(),
            "event_id": event_id,
            "title": outcome,
            "sort_order": idx,
            "quantity": round(liquidity * math.log(price), 8),
            "price": round(price, 8),
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
    volume = float(market.get("volume") or market.get("totalBet") or 0)
    series = share_card_series(market, event, limit=5)
    is_multi = share_card_is_multi(event)
    all_values = [value for item in series for value in item["values"]]
    low, high, _tick_step = share_card_chart_domain(all_values, min_range=8, pad=1.6)
    title = esc_html(event["title"])[:72]
    subtitle = esc_html("Top outcomes" if is_multi else (market.get("question") or "Yes"))[:40]
    group_name = esc_html(f"{group['emoji']} {group['name']}")
    closes = esc_html(fmt_card_date(market.get("closesAt")))
    chart_left, chart_top, chart_width, chart_height = 120, 286, 760, 184
    grid = share_card_svg_grid_labels(low, high, chart_left, chart_top, chart_width, chart_height)

    lines_svg = []
    dots_svg = []
    for item in reversed(series):
        points = share_card_svg_points(item["values"], chart_left, chart_top, chart_width, chart_height, low, high)
        lines_svg.append(f'<polyline points="{points}" fill="none" stroke="{item["color"]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
        dot = points.split(" ")[-1]
        dots_svg.append(
            f'<circle cx="{dot.split(",")[0]}" cy="{dot.split(",")[1]}" r="18" fill="{item["color"]}" opacity="0.2" filter="url(#glow)"/>'
            f'<circle cx="{dot.split(",")[0]}" cy="{dot.split(",")[1]}" r="8" fill="{item["color"]}"/>'
        )

    stat_rows = []
    row_h = 64 if len(series) <= 2 else 46
    stat_y = 335
    for item in series:
        label = esc_html(item["label"])[:18]
        stat_rows.append(
            f'<text x="918" y="{stat_y}" font-family="Arial, sans-serif" font-size="{40 if len(series) <= 2 else 30}" font-weight="800" fill="{item["color"]}">{item["pct"]}%</text>'
            f'<text x="918" y="{stat_y + 28 if len(series) <= 2 else stat_y + 20}" font-family="Arial, sans-serif" font-size="20" fill="#8fa0ad">{label}</text>'
        )
        stat_y += row_h

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
  <text x="120" y="270" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#b7c3cc">{subtitle}</text>
  {grid}
  {"".join(lines_svg)}
  {"".join(dots_svg)}
  {"".join(stat_rows)}
  <text x="120" y="520" font-family="Arial, sans-serif" font-size="26" fill="#8fa0ad">${volume:,.0f} Vol. · Closes {closes}</text>
  <rect x="900" y="498" width="170" height="50" rx="15" fill="#145ca8"/>
  <text x="936" y="531" font-family="Arial, sans-serif" font-size="21" font-weight="800" fill="#fff">Trade now</text>
</svg>"""
    return Response(svg, media_type="image/svg+xml")


@app.head("/api/markets/{market_id}/share-card")
@app.get("/api/markets/{market_id}/share-card")
def market_share_card(market_id: str, request: Request) -> Response:
    return market_share_card_svg(market_id, request)


@app.head("/api/markets/{market_id}/share-card.png")
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
    volume = float(market.get("volume") or market.get("totalBet") or 0)
    series = share_card_series(market, event, limit=5)
    is_multi = share_card_is_multi(event)
    history_source = sorted(event.get("markets") or [market], key=lambda item: float(item.get("probability") or 0), reverse=True)[0] if is_multi else market
    date_labels = share_card_date_labels(history_source.get("probabilityHistory") or [])
    all_values = [value for item in series for value in item["values"]]
    low, high, tick_step = share_card_chart_domain(all_values, min_range=8, pad=1.6)

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
    subtitle = "Top outcomes" if is_multi else (market.get("question") or "Yes")
    draw.text((head_x, outcome_y), truncate(draw, subtitle, right - head_x, font(20, False)), fill="#8fa0ad", font=font(20, False))

    prob_y = max(card_y + (190 if is_multi else 200), outcome_y + 34)
    prob_x = left
    for item in series[:2]:
        label = png_safe_label(item["label"])
        text = f"{truncate(draw, label, 150, font(23, True))} {item['pct']}%"
        draw.text((prob_x, prob_y), text, fill=item["color"], font=font(23, True))
        prob_x += draw.textlength(text, font=font(23, True)) + 22

    chart_height = 92 if is_multi else 145
    chart_left, chart_top, chart_width = left + 30, prob_y + (42 if is_multi else 52), (400 if is_multi else 430)
    denom = max(0.001, high - low)
    grid_ticks = (low, (low + high) / 2, high) if is_multi else reversed(share_card_tick_values(low, high, tick_step))
    label_gap = 22 if is_multi else 8
    for value in grid_ticks:
        row_y = chart_top + ((high - value) / denom * chart_height)
        draw.line((chart_left, row_y, chart_left + chart_width, row_y), fill="#26343d", width=1)
        draw.text((chart_left + chart_width + label_gap, row_y - 9), share_card_axis_label(value), fill="#748593", font=font(16, False))
    if not is_multi:
        for index, label in enumerate(date_labels):
            if label:
                draw.text((chart_left - 24 + index * 120, chart_top + chart_height + 16), label, fill="#526472", font=font(16, False))

    dot_outer, dot_inner = (10, 5) if is_multi else (15, 6)
    for item in reversed(series):
        points = chart_points(item["values"], chart_left, chart_top, chart_width, chart_height)
        draw_line(points, item["color"], width=4)
    for item in series:
        points = chart_points(item["values"], chart_left, chart_top, chart_width, chart_height)
        x, y = points[-1]
        draw.ellipse((x - dot_outer, y - dot_outer, x + dot_outer, y + dot_outer), fill=darken_hex(item["color"]))
        draw.ellipse((x - dot_inner, y - dot_inner, x + dot_inner, y + dot_inner), fill=item["color"])

    row_step = 38 if len(series) <= 2 else 24
    label_font = font(23 if len(series) <= 2 else 18, False)
    pct_font = font(25 if len(series) <= 2 else 20, True)
    row_y = chart_top + chart_height + (30 if len(series) <= 2 else 16)
    for item in series:
        draw.ellipse((left, row_y + 7, left + 10, row_y + 17), fill=item["color"])
        label_text = truncate(draw, png_safe_label(item["label"]), (right - left) - 110, label_font)
        draw.text((left + 22, row_y), label_text, fill="#9fb0bd", font=label_font)
        pct_text = f"{item['pct']}%"
        draw.text((right - draw.textlength(pct_text, font=pct_font), row_y - 2), pct_text, fill="#f4f7fa", font=pct_font)
        row_y += row_step

    button_y, button_h, gap = card_y + card_h - 54, 44, 12
    line_y = button_y - 36
    foot_y = button_y - 22
    draw.line((left, line_y, right, line_y), fill="#26343d", width=1)
    draw.text((left, foot_y), f"{compact_money_text(volume)} Vol.", fill="#8fa0ad", font=font(20, False))
    close_text = f"Closes {fmt_card_date(market.get('closesAt'))}"
    draw.text((right - draw.textlength(close_text, font=font(20, False)), foot_y), close_text, fill="#8fa0ad", font=font(20, False))

    if len(series) <= 2:
        button_w = (card_w - pad * 2 - gap) // 2
        draw.rounded_rectangle((left, button_y, left + button_w, button_y + button_h), radius=12, fill="#0b2942")
        draw.rounded_rectangle((left + button_w + gap, button_y, right, button_y + button_h), radius=12, fill="#321c24")
        yes_btn = f"Yes {series[0]['pct']}¢"
        no_btn = f"No {series[1]['pct']}¢"
        draw.text((left + button_w / 2 - draw.textlength(yes_btn, font=font(20, True)) / 2, button_y + 12), yes_btn, fill="#145ca8", font=font(20, True))
        draw.text((left + button_w + gap + button_w / 2 - draw.textlength(no_btn, font=font(20, True)) / 2, button_y + 12), no_btn, fill="#ff4d5a", font=font(20, True))
    else:
        draw.rounded_rectangle((left, button_y, right, button_y + button_h), radius=12, fill="#145ca8")
        cta = "Trade on probable.fun"
        draw.text((left + (right - left) / 2 - draw.textlength(cta, font=font(20, True)) / 2, button_y + 12), cta, fill="#fff", font=font(20, True))

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
    active = active_outcomes(outcomes)

    if payload.action == "buy":
        b = float(event.get("liquidity_b") or DEFAULT_FAKE_BALANCE)
        cap = b / 2
        if float(payload.amount) > cap:
            raise HTTPException(
                400,
                f"Max single trade is {cap:,.0f} pts (½ of market liquidity — "
                f"split into smaller trades to move the price further).",
            )

    if not payload.outcomeId:
        raise HTTPException(400, "Choose an outcome to trade")
    outcome_id = payload.outcomeId
    selected_outcome = next((outcome for outcome in outcomes if outcome["id"] == outcome_id), None)
    if not selected_outcome:
        raise HTTPException(400, "Outcome does not belong to this market")
    if outcome_is_eliminated(selected_outcome):
        raise HTTPException(400, f"{selected_outcome.get('title') or 'This outcome'} has been eliminated")
    if len(active) < 2:
        raise HTTPException(400, "Market does not have enough active outcomes to trade")

    try:
        if len(outcomes) > 2 and len(active) > 1 and payload.side == "no":
            trade_result_data = place_complement_event_trade(db, event, outcomes, outcome_id, payload)
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
        resolver = (payload.resolvedBy or "manual").strip()[:80] or "manual"
        note = (payload.reasoning or "").strip()
        if wanted in (ALL_OUTCOMES_RESOLUTION, "all", "draw", "all_correct", "all outcomes", "all outcomes correct"):
            if len(outcomes) < 2:
                raise HTTPException(400, "All-correct resolution requires multiple outcomes")
            if not note:
                note = "Resolved as draw: all listed outcomes were correct."
            if event["status"] == "open":
                db.table("market_events").update({"status": "closed"}).eq("id", event["id"]).execute()
                event["status"] = "closed"
            approval = record_resolution_approval(
                db,
                event,
                outcome_id=ALL_OUTCOMES_RESOLUTION,
                outcome_title="Draw / all outcomes correct",
                resolver=resolver,
                resolver_aliases=payload.resolverAliases,
                notes=note,
            )
            if approval["status"] != "ready_to_resolve":
                return groups_response(resolutionApproval=approval)
            settlement = resolve_event_market_all_outcomes(
                db,
                event,
                resolved_by=resolver,
                notes=note,
            )
            return groups_response(settlement=settlement, resolutionApproval=approval)

        outcome = (
            next((item for item in outcomes if item["id"] == payload.outcome), None)
            or next((item for item in outcomes if item["title"].strip().lower() == wanted), None)
            or (route_outcome if route_outcome and wanted == "yes" else None)
        )
        if not outcome and wanted in ("yes", "no"):
            outcome = next((item for item in outcomes if item["title"].strip().lower() == wanted), None)
        if not outcome:
            raise HTTPException(400, "Resolution outcome not found")
        if outcome_is_eliminated(outcome):
            raise HTTPException(400, "Cannot resolve to an eliminated outcome")

        if not note:
            note = f"Manually resolved to {outcome['title']}."
        if event["status"] == "open":
            # Manual admin override: if an outcome is already knowable before
            # maturity, close trading immediately and let the settlement RPC pay.
            db.table("market_events").update({"status": "closed"}).eq("id", event["id"]).execute()
            event["status"] = "closed"
        approval = record_resolution_approval(
            db,
            event,
            outcome_id=outcome["id"],
            outcome_title=outcome["title"],
            resolver=resolver,
            resolver_aliases=payload.resolverAliases,
            notes=note,
        )
        if approval["status"] != "ready_to_resolve":
            return groups_response(resolutionApproval=approval)
        settlement = resolve_event_market_rpc(
            db,
            event["id"],
            outcome["id"],
            resolved_by=resolver,
            notes=note,
        )
        return groups_response(settlement=settlement, resolutionApproval=approval)
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


@app.post("/api/markets/{market_id}/outcomes/{outcome_id}/eliminate")
def eliminate_market_outcome(market_id: str, outcome_id: str, payload: EliminateOutcome) -> dict:
    db = get_db()
    event, _route_outcome = require_event_or_outcome(market_id)
    elimination = eliminate_event_outcome(
        db,
        event,
        outcome_id,
        eliminated_by=payload.eliminatedBy or "manual",
        notes=payload.reasoning,
    )
    return groups_response(elimination=elimination)


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
