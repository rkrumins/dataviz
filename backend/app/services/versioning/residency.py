"""Graph residency (doc 17): which versioned graphs' keys FalkorDB holds.

With ``GRAPHVER_RESIDENCY_ENABLED`` on, an evicted graph stays evicted: no projection pass reseeds
it (``FalkorProjector.project_graph``'s gate), and its reads are served from Postgres. It comes
back only through a load, which is asked for here (:func:`request_load`) and admitted by the
projection lane's capacity loop, in the order the loads were first asked for.
"""
from __future__ import annotations

import logging
import time

from .messaging import get_broker_redis

logger = logging.getLogger(__name__)

#: The graphs whose load has been asked for: a sorted set on the broker, scored by when each was
#: first asked for.
LOAD_REQUESTS = "versioning:residency:loads"


async def request_load(graph_id: str) -> None:
    """Ask for ``graph_id`` to be loaded into FalkorDB again. Asking again keeps its place.
    Best effort: a broker outage loses the request, and the next read asks again."""
    try:
        await get_broker_redis().zadd(LOAD_REQUESTS, {graph_id: time.time()}, nx=True)
    except Exception:  # noqa: BLE001 — a read must never fail over it
        logger.warning("could not ask for graph %s to be loaded", graph_id, exc_info=True)
