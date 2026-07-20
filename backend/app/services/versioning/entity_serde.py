"""Canonical entity ↔ versioned-payload serialization — the SINGLE contract every producer of a
Postgres ``node_versions``/``edge_versions`` payload must route through, so no code path can flatten
or drop a field again.

Two inverse mappings, each defined ONCE here:

    GraphNode / GraphEdge   <->   payload dict (the JSONB stored on a version row)

Canonical shapes (historically ``versioned_branch_provider._node_payload`` / ``_edge_payload``):

* node — ``node.model_dump(by_alias=True, exclude_none=True)`` with the nested ``properties``
  sanitised of reserved keys. Nodes were already correct everywhere (they all use ``model_dump``);
  this just centralises it.
* edge — ``{edgeType, sourceEntityId, targetEntityId, confidence?(TOP-LEVEL), properties?(NESTED)}``.
  Edges were hand-FLATTENED in five producers (bootstrap ``_edges_to_rows``,
  ``versioned_bootstrap.collect_provider_rows``, and ``service.bulk_ingest``/``sync_ingest``/
  ``_external_state``): they spread user props at the payload top level and dropped ``confidence``.
  The reseed reader (``projection._edge_item``) reads the canonical shape, so a rebuild lost every
  edge's confidence (→ ``None``) and properties (→ ``{}``). Routing all producers through
  :func:`edge_to_payload` / :func:`row_to_edge_payload` closes that whole class.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping

from backend.common.models.graph import GraphEdge, GraphNode

# The edge payload/row ENVELOPE — never user properties. Any OTHER top-level key on a legacy
# flattened row is a user property to be re-nested under ``properties``.
_EDGE_RESERVED = frozenset({
    "kind", "id", "entity_id", "version",
    "source", "target", "sourceEntityId", "source_entity_id", "targetEntityId", "target_entity_id",
    "edgeType", "edge_type", "confidence", "properties", "discriminator",
})
_NODE_ROW_RESERVED = frozenset({"kind", "id", "entity_id"})


def _sanitize(payload: dict) -> dict:
    # Lazy import: falkordb_provider is a heavy module and this keeps entity_serde import-cycle-free.
    from backend.app.providers.falkordb_provider import _sanitize_node_properties
    return _sanitize_node_properties(payload)


def node_to_payload(node: GraphNode) -> dict:
    """``GraphNode`` → canonical node payload (denormalised top-level fields, nested ``properties``
    sanitised of reserved keys). Identical to the shape ``_nodes_to_rows`` already produces."""
    return _sanitize(node.model_dump(by_alias=True, exclude_none=True))


def edge_to_payload(edge: GraphEdge) -> dict:
    """``GraphEdge`` → canonical edge payload: endpoints as entity-ids (== urn), ``confidence`` at
    the TOP level, user ``properties`` NESTED. Mirrors ``versioned_branch_provider._edge_payload``."""
    p: Dict[str, Any] = {"edgeType": edge.edge_type,
                         "sourceEntityId": edge.source_urn, "targetEntityId": edge.target_urn}
    if edge.confidence is not None:
        p["confidence"] = edge.confidence
    if edge.properties:
        p["properties"] = dict(edge.properties)
    return p


def row_to_node_payload(row: Mapping) -> dict:
    """A bulk-ingest node ROW → canonical node payload (strip the row envelope, sanitise props).
    Centralises the behavior the node ingest paths already had."""
    return _sanitize({k: v for k, v in row.items() if k not in _NODE_ROW_RESERVED})


def _split_endpoints_props(d: Mapping) -> tuple:
    """(src, tgt, confidence, properties) from EITHER a canonical or a legacy-flattened
    edge row/payload. Non-reserved top-level keys are folded into ``properties`` (a nested
    ``properties`` already present wins on key conflict) — this is how a legacy flattened edge is
    recovered without a re-import."""
    src = d.get("sourceEntityId") or d.get("source_entity_id") or d.get("source")
    tgt = d.get("targetEntityId") or d.get("target_entity_id") or d.get("target")
    props: Dict[str, Any] = dict(d.get("properties") or {})
    for k, v in d.items():
        if k not in _EDGE_RESERVED and k not in props:
            props[k] = v
    return src, tgt, d.get("confidence"), props


def row_to_edge_payload(row: Mapping) -> dict:
    """A bulk-ingest edge ROW → canonical edge payload, tolerating BOTH wire shapes: the canonical
    ``{edgeType, sourceEntityId, targetEntityId, confidence?, properties?}`` and the LEGACY flattened
    ``{edgeType, source, target, <user props spread at top level>}`` (which carried no confidence)."""
    src, tgt, conf, props = _split_endpoints_props(row)
    payload: Dict[str, Any] = {"edgeType": row.get("edgeType") or row.get("edge_type"),
                               "sourceEntityId": src, "targetEntityId": tgt}
    if conf is not None:
        payload["confidence"] = conf
    if props:
        payload["properties"] = props
    if row.get("discriminator") is not None:                # explicit parallel-edge discriminator
        payload["discriminator"] = row["discriminator"]
    return payload


def edge_payload_from_parts(*, edge_type: str, source_entity_id: str, target_entity_id: str,
                            row: Mapping) -> dict:
    """Canonical edge payload where the caller has ALREADY resolved the endpoints (urn→entity-id)
    and the edge type, and ``row`` carries confidence + properties in either wire shape. Used by the
    ingest builders (bulk/sync/external) that resolve endpoints against their own urn→eid maps."""
    _src, _tgt, conf, props = _split_endpoints_props(row)
    payload: Dict[str, Any] = {"edgeType": edge_type, "sourceEntityId": source_entity_id,
                               "targetEntityId": target_entity_id}
    if conf is not None:
        payload["confidence"] = conf
    if props:
        payload["properties"] = props
    if row.get("discriminator") is not None:
        payload["discriminator"] = row["discriminator"]
    return payload


def payload_to_edge(entity_id: str, payload: Mapping) -> GraphEdge:
    """Durable edge payload → ``GraphEdge``. Legacy-flatten tolerant, so a verify/reader treats a
    not-yet-migrated graph correctly (used by the attribute-aware projection verify)."""
    src, tgt, conf, props = _split_endpoints_props(payload)
    return GraphEdge(id=entity_id, sourceUrn=src or "", targetUrn=tgt or "",
                     edgeType=(payload.get("edgeType") or payload.get("edge_type") or ""),
                     confidence=conf, properties=props)


def payload_to_node(entity_id: str, payload: Mapping) -> GraphNode:
    """Durable node payload → ``GraphNode`` (entity_id is the urn). Symmetric with
    :func:`node_to_payload` for verify/reader use."""
    data = {k: v for k, v in payload.items() if k not in _NODE_ROW_RESERVED}
    data.setdefault("urn", entity_id)
    data.setdefault("entityType", payload.get("entityType") or "unknown")
    data.setdefault("displayName", payload.get("displayName") or "")
    return GraphNode.model_validate(data)
