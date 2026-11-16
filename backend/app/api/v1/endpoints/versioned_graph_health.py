"""What happened, and how each versioned graph is doing, over HTTP: the counts behind the settings'
"Something's wrong?" finder (``services/settings/signals.py``), and the top panel of a graph's
settings drawer (``services/settings/health.py``). Both are read only when someone opens them.

* ``GET /admin/versioning/signals?window=1h|24h|7d`` — system administrators: each signal's count
  over the window, per hour, and the graphs it named most. With Redis out of reach it answers
  ``unavailable`` and no counts, never zeros.
* ``GET /{ws_id}/versioning/graphs/{graph_id}/health`` — with ``workspace:datasource:read``: what
  the graph serves, how its readers read it, its copy, its last build, the last day's signals.

Neither is on the API-key surface (``auth/api_key_surface``): a key is refused.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.services.settings import health, preview as previews, signals
from backend.app.services.versioning.service import GraphVersioningService
from backend.auth_service.interface import User

from .versioning import get_versioning_service, graph_in_workspace

logger = logging.getLogger(__name__)

signals_router = APIRouter()
health_router = APIRouter()

_READ = "workspace:datasource:read"


@signals_router.get("", summary="How many times each signal happened, per hour, and where")
async def get_signals(
    window: Literal["1h", "24h", "7d"] = Query("24h", description="That many clock hours (UTC), "
                                                                   "the last the hour under way"),
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
) -> dict:
    """``{asOf, window, unavailable, signals: [{id, count, byHour, topGraphs}]}``: every signal,
    0 when nothing happened. ``byHour`` holds one count per clock hour, oldest first, the last the
    hour under way; ``topGraphs`` (``{graphId, dataSourceId, name, count}``, most first) the graphs
    it named most. Each process's counts arrive within ten seconds. Redis out of reach:
    ``unavailable`` true and no signals."""
    as_of = datetime.now(timezone.utc).isoformat()
    try:
        counts = await signals.read(window)
        top = await signals.top_graphs(window)
    except Exception:  # noqa: BLE001 — said, rather than zeros
        logger.warning("signals: the counts could not be read", exc_info=True)
        return {"asOf": as_of, "window": window, "unavailable": True, "signals": []}
    named = await _named(session, svc, {gid for found in top.values() for gid, _n in found})
    return {"asOf": as_of, "window": window, "unavailable": False, "signals": [{
        "id": sid, "count": counts[sid]["count"], "byHour": counts[sid]["byHour"],
        "topGraphs": [{"graphId": gid, **named.get(gid, {"dataSourceId": None, "name": None}),
                       "count": n} for gid, n in top[sid]],
    } for sid in signals.IDS]}


async def _named(session: AsyncSession, svc: GraphVersioningService,
                 graph_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """Each live graph's data source and its label; one that can't be named is left out."""
    graph_ids = sorted(graph_ids)
    if not graph_ids:
        return {}
    try:
        placed = await svc.projection_placements(graph_ids)
        labels = await previews.labels(session, (p["data_source_id"] for p in placed.values()))
    except Exception:  # noqa: BLE001 — the counts stand without their names
        logger.warning("signals: the graphs could not be named", exc_info=True)
        return {}
    return {gid: {"dataSourceId": p["data_source_id"], "name": labels.get(p["data_source_id"])}
            for gid, p in placed.items()}


@health_router.get("", summary="A versioned graph's health: what it serves, its copy, its builds")
async def get_graph_health(
    ws_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
) -> dict:
    """``{asOf, head, serving, versionsBehind, readMode, progress, lastUpdate, memory, lastBuild,
    signals, follows, problems}``:

    * ``head`` ``{seq, version}``, the version published last, and ``serving`` ``{seq, version,
      source}``, the one its readers get, from the graph store or the database (``version``:
      ``{commitId, at, actor, message}``); ``versionsBehind``, how far that is from the head;
    * ``readMode`` ``{effective, declared, source, why}``, as its settings resolve;
    * ``memory`` ``{bytes, node, loaded, class, lastReadAt}``, its copy;
    * ``lastBuild`` ``{outcome, at, why}``: the new-version build in flight (``running``,
      ``waiting``), else the last one while the copy it retired is kept (``switched``,
      ``dropped``);
    * ``signals`` ``[{id, count24h}]``, each signal's count for it over the last 24 hours;
    * ``progress``, null until updates publish their progress.

    Each part that can't be read is null, with a ``problems`` entry ``{part, message}``. A fork
    reports its root's copy, named by ``follows`` ``{graphId, dataSourceId}`` (null for a graph
    that is no fork)."""
    return await health.graph_health(session, svc, meta)
