"""The live facts the registry's recommendations read (``Recommendation.compute(values, facts)``),
collected best effort: a fact that can't be read is left out, never guessed.

* ``largestGraphBytes``, ``graphCount`` — the graph store: the largest measured copy
  (``projection_state.size_bytes``) and how many live graphs there are, forks aside (a fork has no
  copy of its own);
* ``nodes`` — each graph-store master's memory, ``[{name, usedBytes, maxBytes}]`` (``maxBytes``
  None: no limit), as the Graph store page reads it (``graph_store.topology``, cached);
* ``poolSize`` — the connections one process's graph-store pool holds at most
  (``GRAPHVER_POOL_SIZE`` + ``GRAPHVER_POOL_MAX_OVERFLOW``), which its reads from the database
  share;
* ``projectionConcurrency`` — the graphs a versioning worker updates at once
  (``GRAPHVER_PROJECTION_CONCURRENCY``);
* ``readerProcesses`` — the web processes per pod that serve reads (``GUNICORN_WORKERS``), where
  this process's environment says.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from sqlalchemy import func, select

logger = logging.getLogger(__name__)


async def collect() -> Dict[str, Any]:
    """Every fact that can be read now."""
    from backend.app.services.versioning import config

    facts: Dict[str, Any] = {}
    try:
        largest, count = await _graphs()
        facts["graphCount"] = count
        if largest is not None:
            facts["largestGraphBytes"] = largest
    except Exception:  # noqa: BLE001 — a fact unread is left out
        logger.info("settings facts: the graph store could not be read", exc_info=True)
    try:
        nodes = await _nodes()
        if nodes:
            facts["nodes"] = nodes
    except Exception:  # noqa: BLE001
        logger.info("settings facts: the graph store's memory could not be read", exc_info=True)
    facts["poolSize"] = config.POOL_SIZE + config.POOL_MAX_OVERFLOW
    facts["projectionConcurrency"] = config.PROJECTION_CONCURRENCY
    workers = os.getenv("GUNICORN_WORKERS", "").strip()
    if workers.isdigit():
        facts["readerProcesses"] = int(workers)
    return facts


async def _graphs():
    """The largest measured copy (None: none measured) and the number of live graphs, not forks."""
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    async with gvdb.graphver_session() as s:
        largest, count = (await s.execute(
            select(func.max(ProjectionStateORM.size_bytes), func.count(GraphORM.id))
            .select_from(GraphORM)
            .outerjoin(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
            .where(GraphORM.deleted_at.is_(None), GraphORM.fork_parent_graph_id.is_(None)))).one()
    return (int(largest) if largest is not None else None), int(count)


async def _nodes() -> List[Dict[str, Any]]:
    """Each master whose memory was read."""
    from backend.app.services.graph_store import topology

    found = await topology.get_topology_snapshot()
    return [{"name": shard.master.endpoint, "usedBytes": shard.master.memory.used,
             "maxBytes": shard.master.memory.maxmemory or None}
            for instance in found.instances for shard in instance.shards
            if shard.master.memory.used is not None]
