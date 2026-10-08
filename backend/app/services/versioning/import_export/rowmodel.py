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

A view package's format-2 line (``stream.native_pages``) carries the stored payload whole as an
object, which ``normalize(..., native=True)`` reads into the same normalized row.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from backend.common.property_patch import PROP_DELETE

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


# Sentinel that flows to the update patch and tells it to REMOVE the property — the one internal
# removal form every write path shares (backend.common.property_patch). An EMPTY cell still means
# "leave unchanged" (PATCH); deletion is always explicit — a ``\N`` token in a prop.<name> cell, or
# a ``null`` value in properties_json.
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


def normalize(raw: Dict[str, Any], kind: str, *, native: bool = False) -> Dict[str, Any]:
    """Flat file record -> normalized row (``kind`` is 'node' or 'edge'). ``native``: the record
    comes from a view package, whose lines may be format 2 (an object ``payload``) — only there:
    in a plain NDJSON import a ``payload`` key is the user's own column, not a format."""
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
    if native and isinstance(raw.get("payload"), dict):
        _expand_payload(out, raw, kind)
        return out

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


#: The portable names of an edge's ends, which a format-2 package line carries beside its payload
#: (an edge's payload holds only its endpoints' entity ids, minted per graph).
_EDGE_ENDS = ("sourceQualifiedName", "targetQualifiedName", "sourceUrn", "targetUrn")


def _expand_payload(out: Dict[str, Any], raw: Dict[str, Any], kind: str) -> None:
    """A format-2 package line — ``{kind, entity_id, baseVersion, payload}``, the stored payload
    whole — as the normalized row its format-1 (flat) record gives: the same fields, read from the
    payload rather than from columns. No ``prop.*`` spill, ``properties_json`` or comma-joined tags
    to undo, so the properties arrive exactly as they were stored. The payload's other top-level
    keys (a node's ``lastSyncedAt``, an edge's ``discriminator``) are not read: a format-1 record
    has no column for them, and the import writes only these fields (``resolve``)."""
    payload = raw["payload"]
    if kind == "node":
        for field in _NODE_CORE:
            if not _blank(payload.get(field)):
                out[field] = _clean(payload[field])
        tags = payload.get("tags")
        if tags:
            out["tags"] = tags if isinstance(tags, list) else [
                s.strip() for s in str(tags).split(",") if s.strip()
            ]
    else:
        for field, key in (("edgeType", "edgeType"), ("source_entity_id", "sourceEntityId"),
                           ("target_entity_id", "targetEntityId")):
            if not _blank(payload.get(key)):
                out[field] = _clean(payload[key])
        for field in _EDGE_ENDS:
            if not _blank(raw.get(field)):
                out[field] = _clean(raw[field])
        if payload.get("confidence") is not None:
            out["confidence"] = float(payload["confidence"])
    out["properties"] = dict(payload.get("properties") or {})


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


_NODE_COL_ORDER = ["entity_id", "urn", "entityType", "displayName", "qualifiedName",
                   "description", "sourceSystem", "layerAssignment", "tags", "baseVersion"]
_EDGE_COL_ORDER = ["entity_id", "edgeType", "sourceQualifiedName", "targetQualifiedName",
                   "sourceUrn", "targetUrn",
                   "source_entity_id", "target_entity_id", "confidence", "baseVersion"]


def column_order(records: List[Dict[str, Any]], schema_props: Optional[Dict[str, List[str]]] = None) -> List[str]:
    """Deterministic, EDIT-READY column order (csv/tsv/xlsx; ndjson ignores).

    Property management is TABULAR — **every property is its own ``prop.<name>`` column**, like a
    spreadsheet/Airtable grid, so 10–50 properties are 10–50 columns you edit in place (never a
    bulky JSON blob). The property columns are the union of: what entities actually have + what the
    ontology defines for the types present (``schema_props`` = ``{"node": [...], "edge": [...]}``),
    so a defined-but-empty property is still a column to fill. ``properties_json`` is demoted to a
    pure OVERFLOW column for genuinely nested/complex values — emitted only when a record needs it.
    The full editable node core (description/tags/layer/…) is always present; edge columns only when
    the export has edges."""
    has_edge = any(r.get("kind") == "edge" for r in records)
    schema_props = schema_props or {}
    cols: List[str] = ["kind"] + list(_NODE_COL_ORDER)
    if has_edge:
        cols += [c for c in _EDGE_COL_ORDER if c not in cols]
    prop_cols = {k for r in records for k in r if k.startswith("prop.")}
    prop_cols |= {f"prop.{n}" for n in (schema_props.get("node") or [])}
    if has_edge:
        prop_cols |= {f"prop.{n}" for n in (schema_props.get("edge") or [])}
    cols += sorted(prop_cols)
    if any("properties_json" in r for r in records):    # overflow only — nested values, when present
        cols.append("properties_json")
    cols.append("_op")
    seen, out = set(), []                                # dedup, preserve order
    for c in cols:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out
