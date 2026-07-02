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


async def resolve_aggregation_edge_types(svc: GraphVersioningService, graph_id: str):
    """(containment, lineage) edge-type sets for the graph's data source — the ontology
    input the projector needs to maintain ``:AGGREGATED`` rollups incrementally per
    projected window. ``None`` on any failure or when the ontology defines no lineage
    types (the projector then skips rollup maintenance for that window)."""
    try:
        meta = await svc.get_graph(graph_id)
        if not meta or not meta.get("data_source_id"):
            return None
        if await _projection_mode(str(meta["data_source_id"])) == "dedicated":
            # In dedicated mode the aggregation worker writes rollups to {graph_name}_proj —
            # a different graph than the projector's target — and the projector's full-seed
            # wipe doesn't touch them. Incremental maintenance would write where nothing
            # reads; leave dedicated-mode rollups entirely to the aggregation job.
            return None
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService
        async with get_async_session() as s:
            ont = LocalOntologyService(SQLAlchemyOntologyRepository(s))
            resolved = await ont.resolve(
                workspace_id=meta.get("workspace_id"),
                data_source_id=str(meta["data_source_id"]))
        cont = list(getattr(resolved, "containment_edge_types", None) or [])
        lin = list(getattr(resolved, "lineage_edge_types", None) or [])
        return (cont, lin) if lin else None
    except Exception as exc:
        logger.warning("aggregation edge-type resolution for %s skipped: %s", graph_id, exc)
        return None


async def _projection_mode(data_source_id: str) -> str:
    """The data source's canonical aggregation placement (in_source | dedicated)."""
    try:
        async with get_async_session() as s:
            ds = await data_source_repo.get_data_source_orm(s, data_source_id)
        return str(getattr(ds, "projection_mode", None) or "in_source")
    except Exception:                                    # pragma: no cover - schema drift
        return "in_source"


def make_rollup_rebuild_hook(get_aggregation_service):
    """Build the projector's ``on_rollups_stale`` hook: queue a scoped aggregation rebuild
    for the graph's data source when rollups can't be maintained incrementally (a full-seed
    wipe destroyed them, or a containment move exceeded the bounded-recount cap). Dedup and
    concurrency are the AggregationService's own guards (active-job conflict → benign no-op).
    ``get_aggregation_service`` is a lazy getter (app.state in direct mode; ``None`` — e.g.
    proxy mode or startup — logs and leaves the manual rebuild path)."""
    async def _hook(graph_id: str) -> None:
        svc = GraphVersioningService()
        meta = await svc.get_graph(graph_id)
        ds_id = meta.get("data_source_id") if meta else None
        if not ds_id:
            return
        agg = get_aggregation_service()
        if agg is None:
            logger.info("rollup rebuild for ds=%s not auto-queued (aggregation service "
                        "unavailable in this runtime); rebuild via the aggregation UI", ds_id)
            return
        mode = await _projection_mode(str(ds_id))
        if mode == "dedicated":
            # The projector's wipe never touches a dedicated-mode {graph_name}_proj graph,
            # so there is nothing to heal — and a wrong-mode rebuild would write rollups
            # into the source graph, where nothing reads them for this data source.
            return
        from backend.app.services.aggregation.schemas import AggregationTriggerRequest
        try:
            async with get_async_session() as s:
                # idempotency_key: evict/restore churn (each restore is a full seed) collapses
                # to one job per hour via the service's idempotent-replay window.
                await agg.trigger(
                    str(ds_id),
                    AggregationTriggerRequest(idempotency_key=f"gv-rollup-rebuild:{graph_id}"),
                    "api", s)
            logger.info("queued aggregation rebuild for ds=%s (rollups stale after projection)", ds_id)
        except Exception as exc:                         # active-job conflict etc. — benign
            logger.info("rollup rebuild for ds=%s not queued: %s", ds_id, exc)
    return _hook


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
