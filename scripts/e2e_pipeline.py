#!/usr/bin/env python3
"""Run a disposable end-to-end Probable pipeline against the local API."""

from __future__ import annotations

import argparse
import math
import time
from datetime import datetime, timedelta, timezone

import httpx


DAVE = "DaveQA"
TESTER = "TesterQA"


class Pipeline:
    def __init__(self, api_base: str, timeout: float = 30.0):
        self.api_base = api_base.rstrip("/")
        self.client = httpx.Client(base_url=self.api_base, timeout=timeout)
        self.group_id = ""

    def request(self, method: str, path: str, **kwargs) -> dict:
        response = self.client.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise AssertionError(f"{method} {path} failed {response.status_code}: {response.text}")
        return response.json()

    def expect_fail(self, method: str, path: str, **kwargs) -> str:
        response = self.client.request(method, path, **kwargs)
        if response.status_code < 400:
            raise AssertionError(f"{method} {path} unexpectedly succeeded: {response.text}")
        try:
            return response.json().get("detail") or response.text
        except Exception:
            return response.text

    def group_from(self, data: dict) -> dict:
        for group in data.get("groups", []):
            if group.get("id") == self.group_id:
                return group
        raise AssertionError(f"QA group {self.group_id} not found in response")

    def latest_group(self) -> dict:
        return self.group_from(self.request("GET", "/api/groups"))

    def create_group(self) -> dict:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        data = self.request("POST", "/api/groups", json={
            "name": f"QA Pipeline {stamp}",
            "emoji": "🧪",
            "mode": "fake",
            "members": [DAVE, TESTER],
        })
        self.group_id = data["groupId"]
        return self.group_from(data)

    def create_market(self, question: str, outcomes: list[str], close_seconds: int = 10) -> tuple[str, dict]:
        closes_at = (datetime.now(timezone.utc) + timedelta(seconds=close_seconds)).isoformat()
        data = self.request("POST", f"/api/groups/{self.group_id}/markets", json={
            "question": question,
            "description": (
                "Resolve this QA market exactly according to the named test outcome. "
                "This market is created only for automated pipeline verification."
            ),
            "resolutionSource": "Probable QA script",
            "edgeCases": "If the API path fails, the test should fail rather than infer an outcome.",
            "category": "QA",
            "closesAt": closes_at,
            "outcomes": outcomes,
            "initialLiquidity": 20000,
            "oracleType": "manual",
            "createdBy": "QA Pipeline",
        })
        event_id = data["eventId"]
        return event_id, self.event(self.group_from(data), event_id)

    def event(self, group: dict, event_id: str) -> dict:
        markets = [market for market in group.get("markets", []) if market.get("eventId") == event_id]
        if not markets:
            raise AssertionError(f"Event {event_id} not found")
        return {
            "id": event_id,
            "status": markets[0]["status"],
            "markets": markets,
            "outcomes": markets[0].get("outcomes", []),
        }

    def outcome_id(self, event: dict, title: str) -> str:
        for outcome in event["outcomes"]:
            if outcome["title"].lower() == title.lower():
                return outcome["id"]
        raise AssertionError(f"Outcome {title} not found in {event['outcomes']}")

    def route_market_id(self, event: dict, title: str) -> str:
        oid = self.outcome_id(event, title)
        for market in event["markets"]:
            if market["id"] == oid:
                return market["id"]
        return event["markets"][0]["id"]

    def assert_prices_sum(self, group: dict, event_id: str) -> None:
        event = self.event(group, event_id)
        total = sum(float(outcome["price"]) for outcome in event["outcomes"])
        if not math.isclose(total, 1.0, abs_tol=0.0001):
            raise AssertionError(f"Event {event_id} prices sum to {total}, not 1.0")

    def trade(self, event: dict, participant: str, title: str, side: str, amount: float, action: str = "buy") -> dict:
        market_id = self.route_market_id(event, title)
        outcome_id = self.outcome_id(event, title)
        data = self.request("POST", f"/api/markets/{market_id}/trade", json={
            "participant": participant,
            "side": side,
            "action": action,
            "amount": amount,
            "outcomeId": outcome_id,
        })
        group = self.group_from(data)
        self.assert_prices_sum(group, event["id"])
        return data

    def quote(self, event: dict, participant: str, title: str, side: str, amount: float, action: str = "sell") -> dict:
        market_id = self.route_market_id(event, title)
        outcome_id = self.outcome_id(event, title)
        return self.request("POST", f"/api/markets/{market_id}/quote", json={
            "participant": participant,
            "side": side,
            "action": action,
            "amount": amount,
            "outcomeId": outcome_id,
        })["quote"]

    def wait_closed(self, event_ids: list[str], timeout: int = 45) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            group = self.latest_group()
            if all(self.event(group, event_id)["status"] == "closed" for event_id in event_ids):
                return group
            time.sleep(1)
        statuses = {event_id: self.event(self.latest_group(), event_id)["status"] for event_id in event_ids}
        raise AssertionError(f"Timed out waiting for closed markets: {statuses}")

    def balance(self, group: dict, participant: str) -> float:
        return float(group.get("balances", {}).get(participant, 0))

    def expected_winning_shares(self, group: dict, event_id: str, outcome_id: str) -> dict[str, float]:
        event = self.event(group, event_id)
        positions = event["markets"][0].get("positions", {})
        expected = {}
        for participant, by_outcome in positions.items():
            shares = float(by_outcome.get(outcome_id, 0) or 0)
            if shares > 0:
                expected[participant] = shares
        return expected

    def resolve_and_verify(self, group: dict, event_id: str, winner_title: str) -> dict:
        event = self.event(group, event_id)
        route_id = self.route_market_id(event, winner_title)
        outcome_id = self.outcome_id(event, winner_title)
        before_balances = {name: self.balance(group, name) for name in [DAVE, TESTER]}
        expected = self.expected_winning_shares(group, event_id, outcome_id)
        data = self.request("POST", f"/api/markets/{route_id}/resolve", json={
            "outcome": outcome_id,
            "resolvedBy": "QA Pipeline",
            "reasoning": f"QA resolves this event to {winner_title}.",
        })
        settlement = data.get("settlement") or {}
        if settlement.get("outcomeId") != outcome_id:
            raise AssertionError(f"Settlement winner mismatch: {settlement}")
        payouts = {item["participant"]: float(item["payout"]) for item in settlement.get("payouts", [])}
        for participant, shares in expected.items():
            if not math.isclose(payouts.get(participant, 0), round(shares, 2), abs_tol=0.02):
                raise AssertionError(f"{participant} payout mismatch: got {payouts.get(participant)}, expected shares {shares}")
        after_group = self.group_from(data)
        for participant in [DAVE, TESTER]:
            expected_balance = before_balances[participant] + payouts.get(participant, 0)
            if not math.isclose(self.balance(after_group, participant), expected_balance, abs_tol=0.02):
                raise AssertionError(f"{participant} balance mismatch after resolution")
        self.expect_fail("POST", f"/api/markets/{route_id}/resolve", json={
            "outcome": outcome_id,
            "resolvedBy": "QA Pipeline",
        })
        return after_group

    def run(self) -> None:
        self.request("GET", "/api/health")
        group = self.create_group()
        binary_yes_id, binary_yes = self.create_market("QA binary resolves YES", ["Yes", "No"], close_seconds=10)
        binary_no_id, binary_no = self.create_market("QA binary resolves NO", ["Yes", "No"], close_seconds=11)
        multi_id, multi = self.create_market("QA multi outcome resolves Spain", ["France", "Spain", "England"], close_seconds=12)

        self.trade(binary_yes, DAVE, "Yes", "yes", 500)
        self.trade(binary_yes, TESTER, "No", "no", 350)
        yes_sell = self.quote(binary_yes, DAVE, "Yes", "yes", 75, "sell")
        self.trade(binary_yes, DAVE, "Yes", "yes", min(75, max(1, float(yes_sell["maxCash"]) / 3)), "sell")
        no_sell = self.quote(binary_yes, TESTER, "No", "no", 50, "sell")
        self.trade(binary_yes, TESTER, "No", "no", min(50, max(1, float(no_sell["maxCash"]) / 3)), "sell")
        self.expect_fail("POST", f"/api/markets/{self.route_market_id(binary_yes, 'No')}/trade", json={
            "participant": DAVE,
            "side": "no",
            "action": "sell",
            "amount": 9999,
            "outcomeId": self.outcome_id(binary_yes, "No"),
        })

        self.trade(binary_no, DAVE, "No", "no", 450)
        self.trade(binary_no, TESTER, "Yes", "yes", 250)

        self.trade(multi, DAVE, "France", "yes", 500)
        self.trade(multi, TESTER, "France", "no", 375)
        multi_no_sell = self.quote(multi, TESTER, "France", "no", 60, "sell")
        self.trade(multi, TESTER, "France", "no", min(60, max(1, float(multi_no_sell["maxCash"]) / 3)), "sell")

        group = self.wait_closed([binary_yes_id, binary_no_id, multi_id])
        self.expect_fail("POST", f"/api/markets/{self.route_market_id(self.event(group, binary_yes_id), 'Yes')}/trade", json={
            "participant": DAVE,
            "side": "yes",
            "action": "buy",
            "amount": 10,
            "outcomeId": self.outcome_id(self.event(group, binary_yes_id), "Yes"),
        })

        group = self.resolve_and_verify(group, binary_yes_id, "Yes")
        group = self.resolve_and_verify(group, binary_no_id, "No")
        group = self.resolve_and_verify(group, multi_id, "Spain")

        resolved = [self.event(group, event_id)["status"] for event_id in [binary_yes_id, binary_no_id, multi_id]]
        if resolved != ["resolved", "resolved", "resolved"]:
            raise AssertionError(f"Not all events resolved: {resolved}")

        print("QA pipeline passed")
        print(f"Group: {self.group_id}")
        print(f"Final balances: {group['balances']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-base", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    Pipeline(args.api_base).run()


if __name__ == "__main__":
    main()
