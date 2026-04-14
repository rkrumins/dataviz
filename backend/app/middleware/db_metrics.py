"""Pool-pressure metrics for the management DB (Phase 2.5 §2.5.3).

Exposes a snapshot of the SQLAlchemy connection pool so deployments
can observe — and alert on — how close the pool is to exhaustion.
The pool size / overflow / wait count was previously invisible; this
endpoint makes pool exhaustion an explicitly-observable failure mode
rather than a "p99 latency mysteriously climbed" guess.

Mounting:

    from .middleware.db_metrics import router as db_metrics_router
    app.include_router(db_metrics_router)

Disabled by default — set ``INTERNAL_METRICS_ENABLED=true`` to expose
the route. Production deployments should additionally restrict the
``/internal/`` prefix at the ingress (k8s NetworkPolicy or equivalent)
so the endpoint is only reachable from the operator's metrics scrape
network, never from the public internet.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.app.db.engine import get_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/metrics", tags=["metrics"])

_SATURATION_WARN_THRESHOLD = 0.8
_SATURATION_WARN_SUSTAIN_SECS = 5.0
_saturation_first_seen_at: float | None = None


def _enabled() -> bool:
    return os.getenv("INTERNAL_METRICS_ENABLED", "false").lower() == "true"


def get_pool_stats() -> dict[str, Any]:
    """Pull current pool counters from the live engine.

    Field semantics (SQLAlchemy QueuePool):
      * ``size`` — configured pool size (the steady-state count)
      * ``checked_out`` — connections currently leased to callers
      * ``checked_in`` — connections sitting idle in the pool
      * ``overflow`` — connections beyond ``size`` (up to ``max_overflow``)
      * ``utilisation_pct`` — checked_out / (size + max_overflow)
    """
    engine = get_engine()
    pool = engine.pool
    # The pool exposes counters via individual methods on QueuePool /
    # AsyncAdaptedQueuePool. Wrap in try/except so a future pool subclass
    # change doesn't 500 the metrics endpoint.
    try:
        size = pool.size()                 # type: ignore[attr-defined]
        checked_out = pool.checkedout()    # type: ignore[attr-defined]
        checked_in = pool.checkedin()      # type: ignore[attr-defined]
        overflow = pool.overflow()         # type: ignore[attr-defined]
    except AttributeError:
        # NullPool (used by alembic migrations) and some third-party
        # pools don't expose these — return a degraded payload.
        return {
            "pool_class": type(pool).__name__,
            "stats_available": False,
        }

    total_capacity = size + max(overflow, 0)
    utilisation = (checked_out / total_capacity) if total_capacity else 0.0

    _maybe_log_saturation(utilisation)

    return {
        "pool_class": type(pool).__name__,
        "size": size,
        "checked_out": checked_out,
        "checked_in": checked_in,
        "overflow": overflow,
        "utilisation_pct": round(utilisation * 100, 1),
        "stats_available": True,
    }


def _maybe_log_saturation(utilisation: float) -> None:
    """WARN once when the pool stays >80% utilised for >5s."""
    global _saturation_first_seen_at
    now = time.monotonic()
    if utilisation < _SATURATION_WARN_THRESHOLD:
        _saturation_first_seen_at = None
        return
    if _saturation_first_seen_at is None:
        _saturation_first_seen_at = now
        return
    if (now - _saturation_first_seen_at) >= _SATURATION_WARN_SUSTAIN_SECS:
        logger.warning(
            "DB pool sustained >%.0f%% utilisation for >%.0fs — consider "
            "raising DB_POOL_SIZE / DB_POOL_MAX_OVERFLOW or finding the "
            "session-leaking endpoint.",
            _SATURATION_WARN_THRESHOLD * 100, _SATURATION_WARN_SUSTAIN_SECS,
        )
        # Reset so the warning re-fires after the next sustained window
        # rather than every second.
        _saturation_first_seen_at = now


@router.get("/db")
async def db_metrics():
    """Snapshot of the management DB connection pool."""
    if not _enabled():
        raise HTTPException(
            status_code=404,
            detail="Internal metrics disabled. Set INTERNAL_METRICS_ENABLED=true.",
        )
    return get_pool_stats()


__all__ = ["router", "get_pool_stats"]
