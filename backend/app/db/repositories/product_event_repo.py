"""Read/write helpers for ``product_events`` — the append-only telemetry store.

Writes are one-liners; reads aggregate in Python after a windowed fetch (the
same portable approach ``audit.py`` uses for payload predicates), which keeps
the SQL trivial and works identically on SQLite and Postgres.

The window scan below is filtered by ``event_type``. It did not need to be
while every row was a deliberate product signal, but ``view.opened`` is
appended on every view open, so an unfiltered window would now be dominated by
rows this summary discards. High-volume aggregates over this table belong in
``analytics_repo``, which groups in SQL rather than folding in Python.
"""
from __future__ import annotations

import json
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ProductEventORM


async def record(
    session: AsyncSession,
    *,
    event_type: str,
    actor_id: str | None,
    payload: dict[str, Any] | None,
) -> None:
    """Append one telemetry row. The caller owns the transaction/commit."""
    session.add(
        ProductEventORM(
            event_type=event_type,
            actor_id=actor_id,
            payload=json.dumps(payload) if payload else None,
        )
    )
    await session.flush()


def _decode(row: ProductEventORM) -> dict[str, Any]:
    if not row.payload:
        return {}
    try:
        val = json.loads(row.payload)
        return val if isinstance(val, dict) else {}
    except (ValueError, TypeError):
        return {}


#: The event types this summary actually reads. Filtering on them is not an
#: optimisation detail — ``view.opened`` is appended once per view open, so an
#: unfiltered window scan would load hundreds of rows for every one it uses.
#: The ``(event_type, created_at)`` index serves this predicate directly.
_SUMMARISED_TYPES = (
    "docs.feedback",
    "docs.search_miss",
    "tour.completed",
    "tour.skipped",
)


async def summary(session: AsyncSession, *, since_iso: str, top: int = 15) -> dict[str, Any]:
    """Aggregate the telemetry window into the shape the Admin panel renders."""
    rows = (
        await session.execute(
            select(ProductEventORM).where(
                ProductEventORM.created_at >= since_iso,
                ProductEventORM.event_type.in_(_SUMMARISED_TYPES),
            )
        )
    ).scalars().all()

    helpful_yes = helpful_no = 0
    per_page: dict[str, dict[str, int]] = {}
    miss_counter: Counter[str] = Counter()
    tour_completed = tour_skipped = 0
    tour_completed_by: Counter[str] = Counter()
    tour_skipped_by: Counter[str] = Counter()
    tour_dropoff: dict[str, Counter[int]] = {}

    for r in rows:
        p = _decode(r)
        if r.event_type == "docs.feedback":
            vote = p.get("vote")
            page = str(p.get("pageKey") or "unknown")
            bucket = per_page.setdefault(page, {"yes": 0, "no": 0})
            if vote == "yes":
                helpful_yes += 1
                bucket["yes"] += 1
            elif vote == "no":
                helpful_no += 1
                bucket["no"] += 1
        elif r.event_type == "docs.search_miss":
            q = str(p.get("query") or "").strip().lower()
            if q:
                miss_counter[q] += 1
        elif r.event_type == "tour.completed":
            tour_completed += 1
            tour_completed_by[str(p.get("tourId") or "unknown")] += 1
        elif r.event_type == "tour.skipped":
            tour_skipped += 1
            tid = str(p.get("tourId") or "unknown")
            tour_skipped_by[tid] += 1
            step = p.get("atStep")
            if isinstance(step, int) and not isinstance(step, bool):
                tour_dropoff.setdefault(tid, Counter())[step] += 1

    # Per-tour funnel: completion rate and where skippers bailed. Built from the
    # tourId/atStep we already record on tour.completed / tour.skipped.
    tour_funnel = []
    for tid in set(tour_completed_by) | set(tour_skipped_by):
        comp = tour_completed_by[tid]
        skip = tour_skipped_by[tid]
        starts = comp + skip
        drops = tour_dropoff.get(tid, Counter())
        tour_funnel.append({
            "tourId": tid,
            "completed": comp,
            "skipped": skip,
            "starts": starts,
            "completionRate": round(comp / starts, 3) if starts else None,
            "dropoff": [{"step": s, "count": c} for s, c in sorted(drops.items())],
        })
    tour_funnel.sort(key=lambda f: (-f["starts"], f["tourId"]))

    total_votes = helpful_yes + helpful_no
    pages = [
        {"page": page, "yes": c["yes"], "no": c["no"]}
        for page, c in sorted(per_page.items(), key=lambda kv: -(kv[1]["yes"] + kv[1]["no"]))
    ]

    return {
        "helpful": {
            "yes": helpful_yes,
            "no": helpful_no,
            "total": total_votes,
            "score": round(helpful_yes / total_votes, 3) if total_votes else None,
            "byPage": pages,
        },
        "contentGaps": [
            {"query": q, "count": n} for q, n in miss_counter.most_common(top)
        ],
        "tours": {"completed": tour_completed, "skipped": tour_skipped, "funnel": tour_funnel},
        "totalEvents": len(rows),
    }
