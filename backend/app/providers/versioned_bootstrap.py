"""Seed a versioned graph from its provider's current state.

The versioned store is the source of truth, but a freshly-created versioned graph is empty
(only a genesis commit). For a data source that already holds data in its provider
(FalkorDB/Spanner/Neo4j), this snapshots the provider's full graph into ONE ``import``
commit on ``main`` so branches/history/branch-reads cover the WHOLE graph, not just edits
made after versioning was enabled. Identity is aligned to the provider's urn / edge id so
the base and subsequent write-through edits coincide. Idempotent per graph.
"""
from __future__ import annotations

import logging
from typing import Dict, List

from backend.common.models.graph import EdgeQuery, NodeQuery

logger = logging.getLogger(__name__)


async def bootstrap_versioned_graph(
    svc, provider, graph_id: str, actor: str, *, batch: int = 2000,
) -> Dict[str, object]:
    """Stream ``provider``'s full node/edge set into the versioned graph as one ``import``
    commit (paged by ``batch``). Reuses ``GraphVersioningService.bulk_ingest`` and is
    idempotent on ``bootstrap:{graph_id}`` (a re-run replays the first import)."""
    rows: List[dict] = []

    offset = 0
    while True:
        nodes = await provider.get_nodes(NodeQuery(limit=batch, offset=offset))
        for n in nodes:
            payload = n.model_dump(by_alias=True, exclude_none=True)
            rows.append({"kind": "node", "id": n.urn, **payload})
        if len(nodes) < batch:
            break
        offset += batch

    offset = 0
    while True:
        edges = await provider.get_edges(EdgeQuery(limit=batch, offset=offset))
        for e in edges:
            rows.append({
                "kind": "edge", "id": e.id, "edgeType": e.edge_type,
                "source": e.source_urn, "target": e.target_urn,
                **(e.properties or {}),
            })
        if len(edges) < batch:
            break
        offset += batch

    report = await svc.bulk_ingest(
        graph_id=graph_id, rows=rows, actor=actor,
        idempotency_key=f"bootstrap:{graph_id}", message="bootstrap import",
    )
    logger.info("bootstrapped versioned graph %s from provider: %s", graph_id, report)
    return report
