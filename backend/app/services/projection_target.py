"""Pin a versioned graph's FalkorDB projection to the data source's REAL graph (the one the canvas
reads), self-healing graphs that were auto-created before that name was injected.

This lives at the app layer — NOT inside the versioning package — because it bridges two stores: the
graphver store (``projection_state``, via :class:`GraphVersioningService`) and the management DB (the
data source's ``graph_name``). The versioning package stays decoupled from the management DB; this
resolver is *injected* into the projection worker (``FalkorProjector(target_resolver=...)``) so the
async projection path self-heals exactly the way the interactive ``project_now`` path already does.
"""
from __future__ import annotations

import logging
from typing import Optional

from backend.app.db.engine import get_async_session
from backend.app.db.repositories import data_source_repo
from backend.app.services.versioning.service import GraphVersioningService

logger = logging.getLogger(__name__)


async def repair_projection_target(svc: GraphVersioningService, graph_id: str) -> Optional[str]:
    """Ensure ``graph_id`` projects into its data source's real FalkorDB graph, not an orphan
    ``gv_<id>`` that nothing reads. Returns a now-orphaned ``gv_*`` name safe to drop (else
    ``None``). Never raises — projection must proceed regardless of whether the repair succeeded."""
    try:
        meta = await svc.get_graph(graph_id)
        ds_id = meta.get("data_source_id") if meta else None
        if not ds_id:
            return None
        async with get_async_session() as s:
            ds_row = await data_source_repo.get_data_source_orm(s, str(ds_id))
        if ds_row is None or not ds_row.graph_name:
            return None
        old = await svc.ensure_projection_target(graph_id=graph_id, falkor_graph_name=ds_row.graph_name)
        # Only the synthetic orphan is safe to drop — never a real ds.graph_name or a fork's graph.
        if old and old != ds_row.graph_name and old.startswith("gv_"):
            return old
    except Exception as exc:
        logger.warning("projection-target repair for %s skipped: %s", graph_id, exc)
    return None
