"""Provider write-through versioning — the out-of-the-box audit trail + branching.

Wraps any :class:`GraphDataProvider`: reads (and lifecycle hooks) delegate unchanged,
but every write also lands as an audited commit on the data source's versioned graph
(resolved or created lazily) BEFORE it's applied to the underlying provider. This makes
the versioning service the system of record for writes — branch/version history and
"who changed what, when" come for free with the existing providers. Disable per
deployment with ``GRAPHVER_VERSIONED_WRITES=0``.

Entity ids in the versioned graph are aligned to provider identifiers (node ``urn``,
edge ``id``) so a write maps to the same versioned entity every time, and edge endpoints
are backfilled from the inner provider so the versioned graph stays referentially whole.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from backend.common.models.graph import GraphEdge, GraphNode
from backend.app.services.versioning.service import GraphVersioningService

logger = logging.getLogger(__name__)


def _node_payload(node: GraphNode) -> dict:
    return node.model_dump(by_alias=True, exclude_none=True)


def _edge_payload(edge: GraphEdge) -> dict:
    p: Dict[str, Any] = {"edgeType": edge.edge_type,
                         "sourceEntityId": edge.source_urn, "targetEntityId": edge.target_urn}
    if edge.confidence is not None:
        p["confidence"] = edge.confidence
    if edge.properties:
        p["properties"] = edge.properties
    return p


class VersionedWriteProvider:
    """Records every write to the versioning service, then delegates to the wrapped
    provider. Everything not overridden here (all reads + lifecycle) delegates
    transparently via ``__getattr__``."""

    def __init__(self, inner, *, workspace_id: str, data_source_id: str,
                 actor: str, svc: Optional[GraphVersioningService] = None):
        self._inner = inner
        self._ws = workspace_id
        self._ds = data_source_id
        self._actor = actor or "system"
        self._svc = svc or GraphVersioningService()
        self._gid: Optional[str] = None
        self._lock = asyncio.Lock()

    def __getattr__(self, name):                         # delegate reads/lifecycle to inner
        if name.startswith("_"):                         # never delegate privates (and avoid recursion)
            raise AttributeError(name)
        return getattr(self._inner, name)

    # ------------------------------------------------------------------ #
    async def _graph_id(self) -> str:
        """Resolve (and lazily create) the data source's versioned graph."""
        if self._gid is None:
            async with self._lock:
                if self._gid is None:
                    res = await self._svc.resolve_graph(
                        data_source_id=self._ds, actor=self._actor,
                        workspace_id=self._ws, open_draft_if_absent=False)
                    self._gid = res["graph_id"] if res is not None else (
                        await self._svc.create_graph(
                            data_source_id=self._ds, workspace_id=self._ws, actor=self._actor)
                    )["graph_id"]
        return self._gid

    async def _record(self, ops: List[dict], message: str) -> None:
        ops = [o for o in ops if o is not None]
        if not ops:
            return
        await self._svc.apply_ops(graph_id=await self._graph_id(), ops=ops,
                                  actor=self._actor, message=message)

    async def _endpoint_op(self, urn: str) -> Optional[dict]:
        """A create op for an edge endpoint node (fetched from the inner provider) so the
        versioned graph stays referentially consistent — a no-op if already current."""
        try:
            node = await self._inner.get_node(urn)
        except Exception:                                # pragma: no cover - provider read hiccup
            return None
        return None if node is None else {
            "op": "create", "entity_kind": "node", "entity_id": urn, "payload": _node_payload(node)}

    # ---- writes: record to versioning, then apply to the provider ---- #
    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        ops = [{"op": "create", "entity_kind": "node", "entity_id": node.urn,
                "payload": _node_payload(node)}]
        if containment_edge is not None:
            ops.append(await self._endpoint_op(containment_edge.source_urn))
            ops.append({"op": "create", "entity_kind": "edge",
                        "entity_id": containment_edge.id, "payload": _edge_payload(containment_edge)})
        await self._record(ops, f"create node {node.urn}")
        return await self._inner.create_node(node, containment_edge)

    async def create_edge(self, edge: GraphEdge) -> bool:
        ops = [await self._endpoint_op(edge.source_urn), await self._endpoint_op(edge.target_urn),
               {"op": "create", "entity_kind": "edge", "entity_id": edge.id, "payload": _edge_payload(edge)}]
        await self._record(ops, f"create edge {edge.id}")
        return await self._inner.create_edge(edge)

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        cur = await self._svc.entity_value(graph_id=await self._graph_id(), entity_id=edge_id)
        if cur is not None:                              # need the full edge payload to version it
            payload = {**cur, "properties": {**(cur.get("properties") or {}), **(properties or {})}}
            await self._record([{"op": "update", "entity_kind": "edge",
                                 "entity_id": edge_id, "payload": payload}], f"update edge {edge_id}")
        return await self._inner.update_edge(edge_id, properties)

    async def delete_edge(self, edge_id: str) -> bool:
        if await self._svc.entity_value(graph_id=await self._graph_id(), entity_id=edge_id) is not None:
            await self._record([{"op": "delete", "entity_kind": "edge",
                                 "entity_id": edge_id, "payload": None}], f"delete edge {edge_id}")
        return await self._inner.delete_edge(edge_id)

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        ops = [{"op": "create", "entity_kind": "node", "entity_id": n.urn, "payload": _node_payload(n)}
               for n in nodes]
        ops += [{"op": "create", "entity_kind": "edge", "entity_id": e.id, "payload": _edge_payload(e)}
                for e in edges]
        await self._record(ops, "save custom graph")
        return await self._inner.save_custom_graph(nodes, edges)
