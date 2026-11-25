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

import json
import math
from typing import Any, Dict, List, Mapping, Optional, Tuple

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


def is_flattened_edge_payload(payload: Mapping) -> bool:
    """True iff a durable edge payload carries user properties SPREAD at the TOP level instead of
    nested under ``properties`` — the fingerprint of a payload written by the pre-contract
    flatteners. A canonical payload (nested ``properties``) and a legitimately attribute-less edge
    (only the envelope keys) both return False.

    Such a payload also DROPPED its ``confidence`` (the flatteners never carried it), which the shape
    alone cannot prove; the spread keys are the detectable signal. A graph with any flattened edge
    predates the serialization contract and should be re-imported from its source
    (:func:`GraphVersioningService.resync_from_provider`, ``strategy='external_wins'``) to recover
    properties AND confidence — iff the source still holds them."""
    return any(k not in _EDGE_RESERVED for k in (payload or {}))


def payload_to_node(entity_id: str, payload: Mapping) -> GraphNode:
    """Durable node payload → ``GraphNode`` (entity_id is the urn). Symmetric with
    :func:`node_to_payload` for verify/reader use."""
    data = {k: v for k, v in payload.items() if k not in _NODE_ROW_RESERVED}
    data.setdefault("urn", entity_id)
    data.setdefault("entityType", payload.get("entityType") or "unknown")
    data.setdefault("displayName", payload.get("displayName") or "")
    return GraphNode.model_validate(data)


# --------------------------------------------------------------------------------------------- #
# A SOURCE graph's node, as version history keeps it (docs/versioning/14-graph-lifecycle-v2.md   #
# §9). The serving reader (``falkordb_provider._node_from_props``) shows a node the way the       #
# platform wrote it; a graph another tool built may use the platform's own names for its data,   #
# or hold a value a field can't take — the copy keeps every one of them.                        #
# --------------------------------------------------------------------------------------------- #

#: A source node's keys that are the PLATFORM's derived bookkeeping, never a person's data: the
#: copy leaves them out (the projector derives them again).
SOURCE_DERIVED_NODE_KEYS = frozenset({
    "gvHash", "searchableText", "level", "levelDigest", "childCount", "urnSource", "nameSource",
})
#: Where the copy keeps a source property whose name the platform keeps for itself.
SOURCE_KEY_PREFIX = "__src."
_TEXT_FIELDS = ("displayName", "qualifiedName", "description", "layerAssignment",
                "sourceSystem", "lastSyncedAt")
_NAME_FALLBACKS = ("name", "title", "label")


def _source_tags(value: Any) -> Optional[list]:
    """A source node's ``tags`` as the node's tags: a list of text, or a JSON list of text in a
    string (as the platform writes it); None for anything else."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if isinstance(value, list) and all(isinstance(t, str) for t in value):
        return value
    return None


def source_node_payload(props: Mapping, label: Optional[str]) -> Optional[dict]:
    """A source graph's node (``properties(n)`` and its label) → canonical node payload, keeping
    every property it holds. None when it has no urn (the reader can't see it either).

    * A key the platform doesn't reserve is a property, as the reader has it.
    * A reserved name fills the node's own field when it holds what the field takes (``urn``,
      text ``displayName``/``description``/…, ``tags`` as a list of text, an ``entityType`` when
      the node has no label).
    * The platform's own bookkeeping (:data:`SOURCE_DERIVED_NODE_KEYS`), an ``entityId`` that is
      the urn and an ``entityType`` that is the label are left out: they say nothing new.
    * A ``properties`` / ``propertiesRaw`` JSON object (the platform's bag) is unpacked; a key
      the node holds natively wins.
    * Anything else under a reserved name is kept as ``__src.<name>``: an ``entityId`` of the
      source's own, a numeric ``description``, a ``properties`` that is plain text.

    A ``name``/``title``/``label`` that is a number still names the node (as its text); the
    property keeps the number. An ordinary node's payload is exactly the reader's."""
    from backend.app.providers.falkordb_provider import (
        _RESERVED_NODE_KEYS, _json_object, _node_from_props,
    )
    urn = props.get("urn")
    clean: Dict[str, Any] = {}
    native: Dict[str, Any] = {}
    kept: Dict[str, Any] = {}
    bags = []
    for k, v in props.items():
        if k not in _RESERVED_NODE_KEYS:
            native[k] = v
        elif v is None or k in SOURCE_DERIVED_NODE_KEYS:
            continue
        elif k == "urn":
            clean[k] = v
        elif k == "entityId":
            if v != urn:
                kept[k] = v
        elif k == "entityType":
            if not label and isinstance(v, str):
                clean[k] = v
            elif v != label:
                kept[k] = v
        elif k in ("properties", "propertiesRaw"):
            bag = _json_object(v)
            if bag is None:
                kept[k] = v
            else:
                bags.append(bag)
        elif k == "tags":
            tags = _source_tags(v)
            if tags is None:
                kept[k] = v
            else:
                clean[k] = tags
        elif k in _TEXT_FIELDS and isinstance(v, str):
            clean[k] = v
        else:
            kept[k] = v
    for k in _NAME_FALLBACKS:
        v = native.get(k)
        if isinstance(v, str):
            clean[k] = v
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            clean[k] = str(v)
    node = _node_from_props(clean, label)
    if node is None:
        return None
    properties = dict(native)
    for bag in bags:
        for k, v in bag.items():
            if k in _RESERVED_NODE_KEYS:
                kept.setdefault(k, v)
            else:
                properties.setdefault(k, v)
    properties.update({f"{SOURCE_KEY_PREFIX}{k}": v for k, v in kept.items()})
    payload = node.model_dump(by_alias=True, exclude_none=True)
    payload["properties"] = properties
    return payload


# --------------------------------------------------------------------------------------------- #
# Values Postgres JSONB can hold                                                                #
# --------------------------------------------------------------------------------------------- #

#: What :func:`storable` had to change, by kind: a NaN or infinite number (JSONB has no such
#: number), a NUL character (JSONB text can't hold one), a value of a kind JSON doesn't have.
STORABLE_PROBLEMS = ("nan", "infinity", "nul", "unsupported")


def storable(value: Any, path: str = "") -> Tuple[Any, List[Dict[str, str]]]:
    """``value`` as version history can store it, and what had to change.

    A date, a moment, a time of day or a duration is stored the one way the platform stores
    them (``moments.from_cell``) — nothing is lost, so nothing is reported. Every other change is
    reported, ``{path, problem, value}``, so a person decides about it: NaN and ±infinity as the
    text ``"NaN"``/``"Infinity"``/``"-Infinity"``, a NUL character removed (from text or a key),
    a value of a kind JSON doesn't have as its text."""
    from backend.common.moments import from_cell
    issues: List[Dict[str, str]] = []

    def walk(v: Any, at: str) -> Any:
        if v is None or isinstance(v, (bool, int)):
            return v
        if isinstance(v, float):
            if math.isfinite(v):
                return v
            text = "NaN" if math.isnan(v) else ("Infinity" if v > 0 else "-Infinity")
            issues.append({"path": at, "problem": "nan" if math.isnan(v) else "infinity",
                           "value": text})
            return text
        if isinstance(v, str):
            if "\x00" not in v:
                return v
            issues.append({"path": at, "problem": "nul", "value": v.replace("\x00", "")[:200]})
            return v.replace("\x00", "")
        if isinstance(v, (list, tuple)):
            return [walk(x, f"{at}[{i}]") for i, x in enumerate(v)]
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                key = str(k)
                if "\x00" in key:
                    issues.append({"path": f"{at}.{key.replace(chr(0), '')}".lstrip("."),
                                   "problem": "nul", "value": key.replace("\x00", "")})
                    key = key.replace("\x00", "")
                out[key] = walk(x, f"{at}.{key}".lstrip("."))
            return out
        converted = from_cell(v)
        if converted is not v:
            return converted
        issues.append({"path": at, "problem": "unsupported", "value": str(v)[:200]})
        return str(v)

    return walk(value, path), issues
