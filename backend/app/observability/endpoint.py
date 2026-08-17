"""``GET /internal/metrics`` — the Prometheus scrape target.

Sits beside the existing ``/internal/metrics/db`` JSON endpoint rather
than replacing it: that one is a human-readable snapshot an operator
curls during an incident, this one is the machine format a scraper
polls. They read the same underlying pool stats.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Response

from .metrics import (
    build_registry,
    change_feed_subscribers,
    db_pool_utilisation,
    metrics_enabled,
    multiprocess_dir,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/metrics", tags=["metrics"])


def _refresh_gauges() -> None:
    """Sample the things that are state rather than events.

    Counters are incremented where the event happens. Gauges describe a
    current value, so they are read at scrape time — which also means a
    gauge here costs nothing when nobody is scraping.
    """
    try:
        from backend.app.db.engine import pool_status

        for role, stats in pool_status().items():
            size = stats.get("size")
            checked_out = stats.get("checked_out")
            if size is None or checked_out is None:
                continue  # NullPool (alembic) — no capacity to be a fraction of
            # Same definition of capacity as ``db_metrics.py:69``, and
            # deliberately so: that one already drives the >80% saturation
            # warnings, and a Prometheus gauge disagreeing with the log
            # line and the JSON endpoint about what "utilised" means is
            # worse than any imprecision in the definition itself.
            #
            # Reading ``pool_status()`` rather than calling
            # ``get_pool_stats()`` because that helper logs saturation as
            # a side effect. A scrape is a read; how often somebody polls
            # this endpoint must not decide how much the app logs.
            capacity = size + max(stats.get("overflow") or 0, 0)
            if capacity:
                db_pool_utilisation.labels(role=role).set(checked_out / capacity)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pool gauge sample failed: %s", exc)

    try:
        from backend.app.changes.hub import get_hub

        change_feed_subscribers.set(get_hub().subscriber_count)
    except Exception as exc:  # noqa: BLE001
        logger.warning("subscriber gauge sample failed: %s", exc)


@router.get("", include_in_schema=False)
async def prometheus_metrics() -> Response:
    if not metrics_enabled():
        raise HTTPException(
            status_code=404,
            detail="Internal metrics disabled. Set INTERNAL_METRICS_ENABLED=true.",
        )

    _refresh_gauges()

    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

    body = generate_latest(build_registry())

    return Response(
        content=body,
        media_type=CONTENT_TYPE_LATEST,
        headers={
            # Says what this reading actually covers. Without it a
            # number is ambiguous between "the fleet" and "whichever
            # worker happened to answer", and those differ by the worker
            # count — which is exactly the size of the mistake somebody
            # would make reading it.
            "X-Metrics-Scope": (
                "fleet" if multiprocess_dir() else "single-process"
            ),
        },
    )
