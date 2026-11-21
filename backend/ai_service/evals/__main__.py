"""Run the golden questions against a live AI service. See the package docstring."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from backend.ai_service.internal_auth import (
    DELEGATION_HEADER, USER_ID_HEADER, USER_NAME_HEADER, internal_auth_headers,
)

DEFAULT_CASES = Path(__file__).with_name("golden_data_lake.json")


def parse_sse(text: str) -> list[tuple[str, Any]]:
    events = []
    for frame in text.split("\n\n"):
        lines = [l for l in frame.splitlines() if l and not l.startswith(":")]
        if len(lines) < 2 or not lines[0].startswith("event:"):
            continue
        events.append((lines[0][6:].strip(), json.loads(lines[1][5:].strip())))
    return events


def judge(case: dict, events: list[tuple[str, Any]]) -> list[str]:
    """What the answer got wrong (empty: it passed)."""
    expect = case.get("expect") or {}
    blocks = [d for n, d in events if n == "block"]
    kinds = {b["type"] for b in blocks}
    clarified = any(n == "clarify" for n, _ in events)
    text = "".join(d.get("delta", "") for n, d in events if n == "text")
    failures = []
    for kind in expect.get("blocks", []):
        if kind not in kinds:
            failures.append(f"no {kind} card")
    if expect.get("clarifyOrNotice") and not (clarified or "notice" in kinds):
        failures.append("used a reading of the term without asking or saying so")
    if expect.get("clarifyOrBlocks") and not clarified:
        for kind in expect["clarifyOrBlocks"]:
            if kind not in kinds:
                failures.append(f"neither asked nor showed a {kind} card")
    impact = next((b["data"] for b in blocks if b["type"] == "impact"), None)
    if impact is not None:
        names = {c.get("name") for c in impact.get("consumers") or []}
        for name in expect.get("impactConsumersInclude", []):
            if name not in names:
                failures.append(f"{name!r} not among the consumers {sorted(n for n in names if n)}")
        if expect.get("impactHasPaths") and not impact.get("paths"):
            failures.append("no paths (why)")
        if expect.get("impactDirection") and impact.get("direction") != expect["impactDirection"]:
            failures.append(f"direction {impact.get('direction')}, wanted {expect['impactDirection']}")
    words = expect.get("textIncludesAny")
    if words and not any(w.lower() in text.lower() for w in words):
        failures.append(f"the answer mentions none of {words}")
    if any(n == "error" for n, _ in events):
        failures.append("error: " + next(d.get("message", "") for n, d in events if n == "error"))
    return failures


async def run(args) -> int:
    from backend.app.auth import delegation

    cases = json.loads(Path(args.cases).read_text())["cases"]
    context = {"workspaceId": args.workspace, "dataSourceId": args.data_source, "viewId": args.view}
    results = []
    async with httpx.AsyncClient(base_url=args.base_url, timeout=180,
                                 headers=internal_auth_headers()) as client:
        for case in cases:
            token = delegation.mint(user_id=args.user, conversation_id=f"eval-{case['id']}")
            started = time.monotonic()
            persona = case.get("persona", "data")
            response = await client.post("/chat/stream", headers={
                DELEGATION_HEADER: token, USER_ID_HEADER: args.user, USER_NAME_HEADER: "Eval",
            }, json={"message": case["question"], "persona": persona,
                     "context": context if persona == "data" else {}})
            events = parse_sse(response.text) if response.status_code == 200 else []
            failures = judge(case, events) if events else [f"HTTP {response.status_code}"]
            usage = next((d for n, d in events if n == "usage"), {})
            results.append({"id": case["id"], "passed": not failures, "failures": failures,
                            "seconds": round(time.monotonic() - started, 1),
                            "tokens": usage.get("inputTokens", 0) + usage.get("outputTokens", 0)})
            mark = "PASS" if not failures else "FAIL"
            print(f"{mark}  {case['id']:<24} {results[-1]['seconds']:>5}s  {'; '.join(failures)}")
    passed = sum(r["passed"] for r in results)
    print(f"\n{passed}/{len(results)} passed")
    if args.report:
        Path(args.report).write_text(json.dumps(results, indent=2))
    return 0 if passed == len(results) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:8093", help="the AI service")
    parser.add_argument("--user", required=True, help="the person to ask as (a user id)")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--data-source", required=True)
    parser.add_argument("--view", required=True, help="a view over the seeded data source")
    parser.add_argument("--cases", default=str(DEFAULT_CASES))
    parser.add_argument("--report", help="write the results as JSON here")
    sys.exit(asyncio.run(run(parser.parse_args())))


if __name__ == "__main__":
    main()
