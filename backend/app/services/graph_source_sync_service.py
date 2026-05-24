"""Mode-2 source-sync orchestrator.

Materialises the upstream system's view of a connected graph into our
``graph_source_*`` tables and writes one ``graph_source_snapshots``
row per run.

Three operations:

- :func:`sync_data_source` — full sync. Resolves the provider,
  streams nodes + edges, applies the diff via
  ``graph_source_repo.apply_source_diff``, records orphans for
  enrichments whose source URN disappeared, and finishes the
  snapshot row. Always one Graph-Store transaction.
- :func:`run_inline_sync` — endpoint-friendly wrapper that handles
  the failure path (records ``status='failed'`` + error message,
  re-raises so the API can return 500).
- :func:`sync_from_inputs` — bypass the provider; useful for tests
  and for the genesis import where the caller already has the data.

Important: this service writes **zero** ``graph_change_event`` rows.
The source layer's audit is the ``graph_source_snapshots`` rows; the
enrichment layer's audit stays the existing per-commit events. A
follow-up "blended audit" query unions both for the UI (Phase 2.5).
"""
from __future__ import annotations

import logging
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models_graph import (
    GraphNodeVersionORM,
    GraphSourceSnapshotORM,
    UserGraphORM,
)
from backend.app.db.repositories import (
    graph_repo,
    graph_source_repo,
    graph_store_outbox_repo,
)
from backend.app.db.repositories.graph_source_repo import (
    SourceEdgeInput,
    SourceNodeInput,
)

logger = logging.getLogger(__name__)


class ProviderResolveError(RuntimeError):
    """Resolving the upstream provider from the workspace data source
    failed. Endpoint maps to 422."""


# ── core: sync from inputs ─────────────────────────────────────────


async def sync_from_inputs(
    session: AsyncSession,
    *,
    graph_id: str,
    source_data_source_id: str | None,
    triggered_by: str | None,
    nodes: Sequence[SourceNodeInput],
    edges: Sequence[SourceEdgeInput],
) -> GraphSourceSnapshotORM:
    """Apply a pre-fetched source layer to *graph_id*. Caller owns
    the txn. Returns the persisted snapshot row (status=completed).

    Separated from :func:`sync_data_source` so tests + the genesis-
    import path can drive the pipeline without standing up a live
    provider.
    """
    snapshot = await graph_source_repo.start_snapshot(
        session,
        graph_id=graph_id,
        source_data_source_id=source_data_source_id,
        triggered_by=triggered_by,
    )

    result = await graph_source_repo.apply_source_diff(
        session,
        graph_id=graph_id,
        sync_run_id=snapshot.id,
        nodes=nodes,
        edges=edges,
    )

    # Orphan detection: an enrichment row whose URN is no longer in
    # the source layer. We scan graph_node_versions for keys that
    # never appeared in the inputs. (Edges follow the same logic but
    # MVP keeps the scan to nodes — edges-as-orphans surface via the
    # composition's dangling-edge diagnostic in the UI.)
    incoming_urns = {n.urn for n in nodes}
    enriched_node_keys = list(
        (
            await session.execute(
                select(GraphNodeVersionORM.node_key)
                .where(GraphNodeVersionORM.graph_id == graph_id)
                .distinct()
            )
        ).scalars()
    )
    orphan_node_urns = [
        k for k in enriched_node_keys
        if k not in incoming_urns and k not in {}  # no edge-key dedup yet
    ]
    orphan_count = 0
    if orphan_node_urns:
        orphan_count = await graph_source_repo.record_orphans(
            session,
            graph_id=graph_id,
            sync_run_id=snapshot.id,
            orphan_node_urns=orphan_node_urns,
            orphan_edge_urns=[],
        )

    await graph_source_repo.finish_snapshot(
        session,
        snapshot_id=snapshot.id,
        status="completed",
        result=result,
        orphan_count=orphan_count,
    )

    await graph_store_outbox_repo.emit(
        session,
        event_type="visualization.graph.source_refreshed",
        aggregate_id=graph_id,
        payload={
            "graph_id": graph_id,
            "sync_run_id": snapshot.id,
            "added": result.added,
            "modified": result.modified,
            "removed": result.removed,
            "orphan_count": orphan_count,
            "source_root_hash": result.root_hash,
            "actor": triggered_by,
        },
    )

    # Reload to get the post-finish field values.
    snapshot = await graph_source_repo.get_snapshot(
        session, snapshot_id=snapshot.id,
    )
    return snapshot


# ── high-level: sync_data_source ────────────────────────────────────


async def sync_data_source(
    session: AsyncSession,
    *,
    graph_id: str,
    workspace_id: str,
    source_data_source_id: str | None,
    triggered_by: str | None,
    mgmt_session: AsyncSession,
    page_size: int = 500,
) -> GraphSourceSnapshotORM:
    """Resolve the upstream provider, stream every node + edge,
    convert to ``SourceNodeInput`` / ``SourceEdgeInput``, apply the
    diff via :func:`run_inline_sync`.

    The provider registry lives on the management DB, so the caller
    must pass a separate ``mgmt_session`` alongside the Graph-Store
    session that owns the txn. (Cross-DB by design: management DB
    is provider/credential SoR; Graph Store is graph SoR.)

    NOT idempotent under concurrent calls on the same graph — wrap
    in an advisory lock at the endpoint layer if you need that
    guarantee. (Concurrent attempts both write snapshot rows; the
    later one wins on diff state.)
    """
    from backend.app.registry.provider_registry import provider_registry
    from backend.common.models.graph import EdgeQuery, NodeQuery

    try:
        provider = await provider_registry.get_provider_for_workspace(
            workspace_id=workspace_id,
            session=mgmt_session,
            data_source_id=source_data_source_id,
        )
    except (KeyError, ConnectionError, ValueError) as exc:
        raise ProviderResolveError(str(exc)) from exc

    nodes_buffer: list[SourceNodeInput] = []
    edges_buffer: list[SourceEdgeInput] = []

    # ── stream nodes (paginated)
    offset = 0
    while True:
        page = await provider.get_nodes(
            NodeQuery(offset=offset, limit=page_size, include_child_count=False)
        )
        if not page:
            break
        for n in page:
            nodes_buffer.append(
                SourceNodeInput(
                    urn=n.urn,
                    entity_type=n.entity_type,
                    display_name=n.display_name,
                    position=None,
                    properties=dict(n.properties or {}),
                    tags=list(n.tags or []),
                )
            )
        if len(page) < page_size:
            break
        offset += page_size

    # ── stream edges (paginated)
    offset = 0
    while True:
        page = await provider.get_edges(
            EdgeQuery(offset=offset, limit=page_size)
        )
        if not page:
            break
        for e in page:
            edges_buffer.append(
                SourceEdgeInput(
                    urn=e.id,
                    source_urn=e.source_urn,
                    target_urn=e.target_urn,
                    edge_type=e.edge_type,
                    properties=dict(e.properties or {}),
                    tags=[],
                )
            )
        if len(page) < page_size:
            break
        offset += page_size

    logger.info(
        "sync_data_source: graph=%s nodes=%d edges=%d (provider=%s)",
        graph_id, len(nodes_buffer), len(edges_buffer), provider.name,
    )

    return await run_inline_sync(
        session,
        graph_id=graph_id,
        source_data_source_id=source_data_source_id,
        triggered_by=triggered_by,
        nodes=nodes_buffer,
        edges=edges_buffer,
    )


# ── inline run with error capture ──────────────────────────────────


async def run_inline_sync(
    session: AsyncSession,
    *,
    graph_id: str,
    source_data_source_id: str | None,
    triggered_by: str | None,
    nodes: Sequence[SourceNodeInput],
    edges: Sequence[SourceEdgeInput],
) -> GraphSourceSnapshotORM:
    """Wrap :func:`sync_from_inputs` with the failure path: on any
    exception, mark the snapshot as ``failed`` + record the error
    message + emit ``visualization.graph.source_failed`` so the SSE
    stream can surface the breakage. Re-raises so the endpoint can
    return 5xx.
    """
    snapshot = await graph_source_repo.start_snapshot(
        session,
        graph_id=graph_id,
        source_data_source_id=source_data_source_id,
        triggered_by=triggered_by,
    )
    try:
        result = await graph_source_repo.apply_source_diff(
            session,
            graph_id=graph_id,
            sync_run_id=snapshot.id,
            nodes=nodes,
            edges=edges,
        )
        await graph_source_repo.finish_snapshot(
            session,
            snapshot_id=snapshot.id,
            status="completed",
            result=result,
        )
        await graph_store_outbox_repo.emit(
            session,
            event_type="visualization.graph.source_refreshed",
            aggregate_id=graph_id,
            payload={
                "graph_id": graph_id,
                "sync_run_id": snapshot.id,
                "added": result.added,
                "modified": result.modified,
                "removed": result.removed,
                "actor": triggered_by,
            },
        )
        return await graph_source_repo.get_snapshot(
            session, snapshot_id=snapshot.id,
        )
    except Exception as exc:
        logger.exception(
            "source sync failed for graph_id=%s run=%s", graph_id, snapshot.id,
        )
        await graph_source_repo.finish_snapshot(
            session,
            snapshot_id=snapshot.id,
            status="failed",
            error_message=str(exc),
        )
        await graph_store_outbox_repo.emit(
            session,
            event_type="visualization.graph.source_failed",
            aggregate_id=graph_id,
            payload={
                "graph_id": graph_id,
                "sync_run_id": snapshot.id,
                "error": str(exc),
                "actor": triggered_by,
            },
        )
        raise


__all__ = [
    "ProviderResolveError",
    "sync_from_inputs",
    "sync_data_source",
    "run_inline_sync",
]
