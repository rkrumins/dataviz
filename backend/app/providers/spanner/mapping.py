"""Spanner-specific value coercion and node/edge hydration.

Re-exports :class:`SchemaMapping` from the shared adapter helpers so the
package presents a single import surface. The Spanner provider uses the
same canonical-shape dict pipeline as Neo4j: foreign rows → mapped dict →
``GraphNode`` / ``GraphEdge``.
"""
from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.common.models.graph import GraphEdge, GraphNode

# Re-export so callers can ``from .mapping import SchemaMapping``
from backend.graph.adapters.schema_mapping import (  # noqa: F401
    SchemaMapping,
    map_edge_props,
    map_node_props,
)

logger = logging.getLogger(__name__)


def coerce_spanner_value(value: Any) -> Any:
    """Normalize a Spanner SDK return value into JSON-friendly Python.

    Spanner returns native Python primitives for INT64/FLOAT64/BOOL/STRING,
    ``datetime.datetime`` for TIMESTAMP, ``datetime.date`` for DATE,
    ``bytes`` for BYTES, ``Decimal`` for NUMERIC, lists for ARRAY<...>, and
    a ``JsonObject`` (dict subclass) for JSON.
    """
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, list):
        return [coerce_spanner_value(v) for v in value]
    if isinstance(value, dict):
        return {k: coerce_spanner_value(v) for k, v in value.items()}
    return str(value)


def node_from_props(
    props: Dict[str, Any],
    entity_type_str: Optional[str] = None,
) -> Optional[GraphNode]:
    """Build a GraphNode from a canonical-shape (post-mapping) property dict."""
    if not props or not props.get("urn"):
        return None
    entity_type = entity_type_str or props.get("entityType") or "container"
    raw_props = props.get("properties")
    if isinstance(raw_props, str):
        try:
            raw_props = json.loads(raw_props)
        except (json.JSONDecodeError, TypeError):
            raw_props = {}
    raw_tags = props.get("tags")
    if isinstance(raw_tags, str):
        try:
            raw_tags = json.loads(raw_tags)
        except (json.JSONDecodeError, TypeError):
            raw_tags = []
    try:
        return GraphNode(
            urn=str(props["urn"]),
            entityType=str(entity_type),
            displayName=str(props.get("displayName") or ""),
            qualifiedName=props.get("qualifiedName"),
            description=props.get("description"),
            properties=raw_props if isinstance(raw_props, dict) else {},
            tags=raw_tags if isinstance(raw_tags, list) else [],
            layerAssignment=props.get("layerAssignment"),
            childCount=props.get("childCount"),
            sourceSystem=props.get("sourceSystem"),
            lastSyncedAt=props.get("lastSyncedAt"),
        )
    except Exception as exc:  # noqa: BLE001 — hydration must not crash the request
        logger.warning("spanner: failed to build GraphNode keys=%s: %s", list(props.keys()), exc)
        return None


def edge_from_row(
    *,
    source_urn: str,
    target_urn: str,
    edge_type: str,
    edge_id: Optional[str],
    confidence: Optional[float],
    properties: Optional[Any],
) -> GraphEdge:
    """Build a GraphEdge from canonical edge fields."""
    eid = edge_id or f"{source_urn}|{edge_type}|{target_urn}"
    props: Dict[str, Any] = {}
    if isinstance(properties, dict):
        props = properties
    elif isinstance(properties, str):
        try:
            parsed = json.loads(properties)
            if isinstance(parsed, dict):
                props = parsed
        except (json.JSONDecodeError, TypeError):
            pass
    return GraphEdge(
        id=str(eid),
        sourceUrn=source_urn,
        targetUrn=target_urn,
        edgeType=str(edge_type),
        confidence=confidence,
        properties=props,
    )


def extract_node_from_record(
    node_json: Optional[Any],
    labels: Optional[List[str]],
    mapping: SchemaMapping,
) -> Optional[GraphNode]:
    """Hydrate a GraphNode from the result of ``SAFE_TO_JSON(n)`` + ``LABELS(n)``.

    Spanner GQL ``SAFE_TO_JSON(n)`` returns a JsonObject containing
    ``identifier``, ``labels``, and ``properties``. Pass the property map
    plus labels through the SchemaMapping so the same canonical-shape
    dict feeds ``node_from_props``.
    """
    if node_json is None:
        return None
    parsed = node_json
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(parsed, dict):
        return None
    raw_props = parsed.get("properties") or {}
    if not isinstance(raw_props, dict):
        return None
    node_labels: List[str] = list(labels or parsed.get("labels") or [])
    coerced = {k: coerce_spanner_value(v) for k, v in raw_props.items()}
    mapped = map_node_props(coerced, node_labels, mapping)
    return node_from_props(mapped)


def extract_edge_from_record(
    *,
    source_urn: str,
    target_urn: str,
    edge_label: str,
    edge_json: Optional[Any],
    mapping: SchemaMapping,
) -> Optional[GraphEdge]:
    """Hydrate a GraphEdge from a row of ``(s.urn, t.urn, edge_label, SAFE_TO_JSON(r))``."""
    if not source_urn or not target_urn:
        return None
    parsed = edge_json or {}
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except (json.JSONDecodeError, TypeError):
            parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    raw_props = parsed.get("properties") or {}
    if not isinstance(raw_props, dict):
        raw_props = {}
    coerced = {k: coerce_spanner_value(v) for k, v in raw_props.items()}
    mapped = map_edge_props(coerced, mapping)
    edge_id = mapped.get("id") or parsed.get("identifier")
    confidence = mapped.get("confidence")
    try:
        confidence = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence = None
    return edge_from_row(
        source_urn=source_urn,
        target_urn=target_urn,
        edge_type=edge_label,
        edge_id=str(edge_id) if edge_id else None,
        confidence=confidence,
        properties=mapped.get("properties") or {},
    )


def node_to_write_columns(node: GraphNode) -> Dict[str, Any]:
    """Convert a GraphNode into the column map expected by the SynodicNodes table.

    The auto-bootstrap schema uses fixed column names; this is the inverse
    of ``map_node_props`` for the managed-schema path.
    """
    return {
        "urn": node.urn,
        "entity_type": str(node.entity_type or "container"),
        "display_name": node.display_name or "",
        "qualified_name": node.qualified_name or "",
        "description": node.description or "",
        "properties": node.properties or {},
        "tags": list(node.tags or []),
        "layer_assignment": node.layer_assignment or "",
        "source_system": node.source_system or "",
    }


def edge_to_write_columns(edge: GraphEdge) -> Dict[str, Any]:
    """Convert a GraphEdge into the column map expected by SynodicEdges."""
    return {
        "edge_id": edge.id,
        "source_urn": edge.source_urn,
        "target_urn": edge.target_urn,
        "edge_type": str(edge.edge_type or "RELATED_TO"),
        "confidence": float(edge.confidence) if edge.confidence is not None else 1.0,
        "properties": edge.properties or {},
    }


def sanitize_identifier(s: str) -> str:
    """Alphanumeric + underscore only — safe for SQL identifiers.

    Used for derived table/index names where we never substitute
    user-controlled SQL. Treat anything that wouldn't survive this filter
    as a programmer error upstream.
    """
    cleaned = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(s))
    if cleaned and cleaned[0].isdigit():
        cleaned = f"_{cleaned}"
    return cleaned or "graph"
