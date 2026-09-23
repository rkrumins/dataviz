"""The flat-column <-> normalized-row mapping — what makes the template generic (plan §Template).

One shared column schema across every format (xlsx/csv/tsv/ndjson/json):

    locked identity : entity_id, urn, baseVersion (=content_hash)
    node core       : entityType, displayName, qualifiedName, description, sourceSystem,
                      layerAssignment, tags
    edge core       : edgeType, sourceQualifiedName, targetQualifiedName, sourceUrn, targetUrn,
                      source_entity_id, target_entity_id, confidence
    properties      : dynamic ``prop.<name>`` columns + a ``properties_json`` overflow
    op              : ``_op`` (blank = upsert, ``delete`` = delete)

``normalize`` turns one flat file record into the pipeline's normalized row: properties are
assembled from ``prop.*`` + ``properties_json``, **empty cells are dropped** (a blank never blanks
a field — PATCH semantics), and ``tags``/``confidence`` are coerced. ``denormalize_node`` /
``denormalize_edge`` do the reverse for export, spilling nested/complex property values into
``properties_json`` (mirroring the projector's native-vs-``propertiesRaw`` split so round-trips are
lossless). In TEXT formats a flat-list ``prop.*`` value is written by ``cell_text`` as JSON and read
back by ``parse_list_cells``.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

_NODE_CORE = (
    "urn", "entityType", "displayName", "qualifiedName",
    "description", "sourceSystem", "layerAssignment",
)
_EDGE_CORE = (
    "edgeType", "sourceQualifiedName", "targetQualifiedName",
    # Endpoint URNs: entity ids are minted per graph, so an edge exported from one environment
    # finds its endpoints in another by URN (the same data source onboarded twice shares them).
    "sourceUrn", "targetUrn",
    "source_entity_id", "target_entity_id",
)

_PROP_PREFIX = "prop."


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _clean(v: Any) -> Any:
    return v.strip() if isinstance(v, str) else v


def _is_scalar_or_flat_list(v: Any) -> bool:
    """A value that maps to a ``prop.<name>`` column (vs the ``properties_json`` overflow)."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return True
    if isinstance(v, list):
        return all(x is None or isinstance(x, (str, int, float, bool)) for x in v)
    return False


# Sentinel that flows to the update patch and tells it to REMOVE the property (see
# service._patch_payload). Chosen so it can never collide with real data. An EMPTY cell still means
# "leave unchanged" (PATCH); deletion is always explicit — a ``\N`` token in a prop.<name> cell, or
# a ``null`` value in properties_json.
# Uses a Unicode Private-Use-Area char (never in real data, and — unlike a NUL byte — valid in
# Postgres text/JSONB so the staged row persists).
PROP_DELETE = "__nx_prop_delete__"
_DELETE_TOKENS = {"\\n", "\\N", "\\NULL"}


def _assemble_properties(raw: Dict[str, Any]) -> Dict[str, Any]:
    props: Dict[str, Any] = {}
    for key, val in raw.items():
        if not key.startswith(_PROP_PREFIX):
            continue
        name = key[len(_PROP_PREFIX):]
        if isinstance(val, str) and val.strip() in _DELETE_TOKENS:
            props[name] = PROP_DELETE                 # explicit "delete this property"
        elif not _blank(val):
            props[name] = _clean(val)
    overflow = raw.get("properties_json")
    if not _blank(overflow):
        parsed = json.loads(overflow) if isinstance(overflow, str) else overflow
        if isinstance(parsed, dict):
            for k, v in parsed.items():
                props[k] = PROP_DELETE if v is None else v   # null in properties_json = delete
    return props


def normalize(raw: Dict[str, Any], kind: str) -> Dict[str, Any]:
    """Flat file record -> normalized row (``kind`` is 'node' or 'edge')."""
    out: Dict[str, Any] = {"kind": kind}
    # ``_op`` accepts only blank/'upsert' or 'delete'. An unexpected value almost always means the
    # user's columns are shifted (e.g. a property value that fell into the _op slot) — flag it as
    # invalid rather than silently swallowing it as an upsert (which would drop their edit).
    _op = str(raw.get("_op") or "").strip().lower()
    if _op in ("", "upsert"):
        out["op"] = "upsert"
    elif _op == "delete":
        out["op"] = "delete"
    else:
        out["op"] = "invalid"
        out["op_error"] = (
            f"unexpected _op value {str(raw.get('_op')).strip()!r} — the _op column only accepts "
            "blank or 'delete'; a property value here usually means your columns are shifted")
    # Identity is always carried (empty string for a brand-new row) so the resolver can tell
    # "no id supplied → create" from "id supplied → match".
    out["entity_id"] = str(raw.get("entity_id") or "").strip()
    if not _blank(raw.get("baseVersion")):
        out["baseVersion"] = _clean(raw["baseVersion"])

    for field in (_NODE_CORE if kind == "node" else _EDGE_CORE):
        if not _blank(raw.get(field)):
            out[field] = _clean(raw[field])

    if kind == "node" and not _blank(raw.get("tags")):
        tags = raw["tags"]
        out["tags"] = tags if isinstance(tags, list) else [
            s.strip() for s in str(tags).split(",") if s.strip()
        ]
    if kind == "edge" and not _blank(raw.get("confidence")):
        out["confidence"] = float(raw["confidence"])

    out["properties"] = _assemble_properties(raw)
    return out


def _spill_properties(rec: Dict[str, Any], properties: Optional[Dict[str, Any]]) -> None:
    overflow: Dict[str, Any] = {}
    for key, val in (properties or {}).items():
        if _is_scalar_or_flat_list(val):
            rec[f"{_PROP_PREFIX}{key}"] = val
        else:
            overflow[key] = val
    if overflow:
        rec["properties_json"] = json.dumps(overflow)


def denormalize_node(entity_id: str, base_version: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Node version payload -> flat export record (scalars -> prop.*, nested -> properties_json)."""
    rec: Dict[str, Any] = {"entity_id": entity_id or "", "baseVersion": base_version or "", "_op": ""}
    for field in _NODE_CORE:
        if payload.get(field) is not None:
            rec[field] = payload[field]
    tags = payload.get("tags")
    if tags:
        rec["tags"] = ", ".join(tags) if isinstance(tags, list) else str(tags)
    _spill_properties(rec, payload.get("properties"))
    return rec


def denormalize_edge(
    entity_id: str,
    base_version: str,
    payload: Dict[str, Any],
    *,
    source_qname: Optional[str] = None,
    target_qname: Optional[str] = None,
    source_urn: Optional[str] = None,
    target_urn: Optional[str] = None,
) -> Dict[str, Any]:
    """Edge version payload -> flat export record (endpoint ids, human qualified names and URNs)."""
    rec: Dict[str, Any] = {"entity_id": entity_id or "", "baseVersion": base_version or "", "_op": ""}
    if payload.get("edgeType") is not None:
        rec["edgeType"] = payload["edgeType"]
    if payload.get("sourceEntityId"):
        rec["source_entity_id"] = payload["sourceEntityId"]
    if payload.get("targetEntityId"):
        rec["target_entity_id"] = payload["targetEntityId"]
    if source_qname is not None:
        rec["sourceQualifiedName"] = source_qname
    if target_qname is not None:
        rec["targetQualifiedName"] = target_qname
    if source_urn:
        rec["sourceUrn"] = source_urn
    if target_urn:
        rec["targetUrn"] = target_urn
    if payload.get("confidence") is not None:
        rec["confidence"] = payload["confidence"]
    _spill_properties(rec, payload.get("properties"))
    return rec


def cell_text(value: Any) -> str:
    """A flat-record value as a TEXT cell (csv/tsv, xlsx string cells). A flat list is written as
    JSON so :func:`parse_list_cells` reads it back as the same list — ``str`` would give Python's
    ``"['a', 'b']"``, which re-imports as a string. Scalars stay ``str`` (``5`` vs ``"5"`` already
    compare equal on re-import)."""
    if value is None:
        return ""
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def parse_list_cells(rec: Dict[str, Any]) -> Dict[str, Any]:
    """The TEXT-format inverse of :func:`cell_text` (csv/tsv/xlsx parsers only): a ``prop.*`` cell
    holding a JSON list of scalars becomes that list again; anything else (``"[draft]"``) stays the
    string. ndjson/json values are already typed, so a ``"[1,2]"`` string there stays a string."""
    for key, val in rec.items():
        if not key.startswith(_PROP_PREFIX) or not isinstance(val, str):
            continue
        text = val.strip()
        if not (text.startswith("[") and text.endswith("]")):
            continue
        try:
            parsed = json.loads(text)
        except ValueError:
            continue
        if isinstance(parsed, list) and _is_scalar_or_flat_list(parsed):
            rec[key] = parsed
    return rec
