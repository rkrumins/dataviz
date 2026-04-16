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

from backend.app.db.engine import pool_status

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/metrics", tags=["metrics"])

_SATURATION_WARN_THRESHOLD = 0.8
_SATURATION_WARN_SUSTAIN_SECS = 5.0
# Per-role saturation timer — roles are tracked independently so a
# hot JOBS pool doesn't mask a separately-saturating WEB pool.
_saturation_first_seen_at: dict[str, float | None] = {}


def _enabled() -> bool:
    return os.getenv("INTERNAL_METRICS_ENABLED", "false").lower() == "true"


def get_pool_stats() -> dict[str, Any]:
    """Per-role pool snapshot (plan Gap 3).

    Returns a dict keyed by role (``web``/``jobs``/``readonly``/``admin``)
    with utilisation + counters per pool. Only roles whose engine has
    been materialised appear — a process that never opened a ``jobs``
    session simply doesn't surface a ``jobs`` entry.

    Also surfaces a top-level ``pools`` list (alphabetised role names)
    for metrics scrapers that prefer a flat structure.
    """
    raw = pool_status()   # {role_name: {size, checked_out, checked_in, overflow}}
    result: dict[str, Any] = {"pools": sorted(raw.keys())}
    for role_name, stats in raw.items():
        size = stats.get("size")
        checked_out = stats.get("checked_out")
        overflow = stats.get("overflow") or 0
        if size is None or checked_out is None:
            # NullPool (used by alembic) or unexpected pool type.
            result[role_name] = {
                "stats_available": False,
            }
            continue
        total_capacity = size + max(overflow, 0)
        utilisation = (checked_out / total_capacity) if total_capacity else 0.0
        _maybe_log_saturation(role_name, utilisation)
        result[role_name] = {
            "size": size,
            "checked_out": checked_out,
            "checked_in": stats.get("checked_in"),
            "overflow": overflow,
            "utilisation_pct": round(utilisation * 100, 1),
            "stats_available": True,
        }
    return result


def _maybe_log_saturation(role: str, utilisation: float) -> None:
    """WARN once per role when that pool stays >80% utilised for >5s."""
    now = time.monotonic()
    first_seen = _saturation_first_seen_at.get(role)
    if utilisation < _SATURATION_WARN_THRESHOLD:
        if first_seen is not None:
            _saturation_first_seen_at[role] = None
        return
    if first_seen is None:
        _saturation_first_seen_at[role] = now
        return
    if (now - first_seen) >= _SATURATION_WARN_SUSTAIN_SECS:
        logger.warning(
            "DB pool[%s] sustained >%.0f%% utilisation for >%.0fs — consider "
            "raising DB_%s_POOL_SIZE / DB_%s_POOL_MAX_OVERFLOW or finding "
            "the session-leaking endpoint on this role.",
            role, _SATURATION_WARN_THRESHOLD * 100,
            _SATURATION_WARN_SUSTAIN_SECS,
            role.upper(), role.upper(),
        )
        # Reset so the warning re-fires after the next sustained window
        # rather than every second.
        _saturation_first_seen_at[role] = now


@router.get("/db")
async def db_metrics():
    """Per-role snapshot of the management DB connection pools."""
    if not _enabled():
        raise HTTPException(
            status_code=404,
            detail="Internal metrics disabled. Set INTERNAL_METRICS_ENABLED=true.",
        )
    return get_pool_stats()


__all__ = ["router", "get_pool_stats"]
