"""resolve_rows — match normalized import rows to entities and build versioned ops (plan Phase 3).

Pure and deterministic (``mint_id`` injected). Two passes so an edge can reference a node created
earlier in the same import:

* **nodes** match an existing entity by ``entity_id`` -> ``urn`` -> ``qualifiedName`` (else mint a
  new id and register it in the local indexes for later edges);
* **edges** resolve endpoints via those node indexes and key by the ``(src_eid, tgt_eid, edge_type)``
  triple (the same keying :meth:`sync_ingest` uses).

Emits ``{op, entity_kind, entity_id, payload}`` ops (nodes before edges) for
:meth:`GraphVersioningService.apply_ops`, plus a per-row resolution record
(``create|update|delete|invalid`` + status + reasons) for the preview/summary. A partial-acceptance
model: an unresolvable row is quarantined (``invalid`` with a reason), never fatal.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Mapping, Sequence, Tuple

_NODE_FIELDS = (
    "urn", "entityType", "displayName", "qualifiedName",
    "description", "sourceSystem", "layerAssignment",
)

_STATUS = {"create": "new", "update": "updated", "unchanged": "unchanged",
           "delete": "deleted", "invalid": "invalid"}


def _scalar_eq(a: Any, b: Any) -> bool:
    """Type-tolerant equality so a CSV round-trip (which stringifies everything) is a no-op:
    ``5 == "5"``, ``True == "True"``. Nested values (dict/list) compare exactly."""
    if a is None or b is None:
        return a == b
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a == b
    return str(a).strip() == str(b).strip()


def _changed_props(new_props: Mapping[str, Any], cur_props: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """Only the properties whose value actually changed (or are new) — type-tolerant."""
    cur = cur_props or {}
    return {k: v for k, v in (new_props or {}).items() if not _scalar_eq(v, cur.get(k))}


def _changed_fields(new_payload: Mapping[str, Any], cur: Mapping[str, Any]) -> Dict[str, Any]:
    """Field-level diff of a provided payload vs the current stored payload. Returns only the
    fields that genuinely changed (empty => unchanged). ``properties`` is diffed per-key so an
    update patches just the changed/added properties; ``tags`` compares as an unordered set."""
    cur = cur or {}
    changed: Dict[str, Any] = {}
    for field, value in new_payload.items():
        if field == "properties":
            pc = _changed_props(value, cur.get("properties"))
            if pc:
                changed["properties"] = pc
        elif field == "tags":
            if set(value or []) != set(cur.get("tags") or []):
                changed["tags"] = value
        elif not _scalar_eq(value, cur.get(field)):
            changed[field] = value
    return changed


def _node_payload(row: Mapping[str, Any]) -> Dict[str, Any]:
    p: Dict[str, Any] = {}
    for field in _NODE_FIELDS:
        if row.get(field) not in (None, ""):
            p[field] = row[field]
    if row.get("tags"):
        p["tags"] = row["tags"]
    if row.get("properties"):
        p["properties"] = row["properties"]
    return p


def _edge_payload(row: Mapping[str, Any], seid: str, teid: str) -> Dict[str, Any]:
    p: Dict[str, Any] = {"edgeType": row["edgeType"], "sourceEntityId": seid, "targetEntityId": teid}
    if row.get("confidence") is not None:
        p["confidence"] = row["confidence"]
    if row.get("properties"):
        p["properties"] = row["properties"]
    return p


def _resolution(row: Mapping[str, Any], resolved_op: str, eid: str | None, *, reasons=None) -> Dict[str, Any]:
    return {
        "_row_index": row.get("_row_index"),
        "kind": row.get("kind"),
        "resolved_op": resolved_op,
        "matched_entity_id": eid,
        "status": _STATUS[resolved_op],
        "reasons": list(reasons or []),
    }


def resolve_rows(
    rows: Sequence[Mapping[str, Any]],
    indexes: Mapping[str, Any],
    *,
    mint_id: Callable[[], str],
) -> Tuple[List[dict], List[dict]]:
    """Return ``(ops, resolutions)`` for the given normalized ``rows``."""
    urn_to_eid: Dict[str, str] = dict(indexes.get("urn_to_eid") or {})
    qname_to_eid: Dict[str, str] = dict(indexes.get("qname_to_eid") or {})
    edge_to_eid: Dict[tuple, str] = dict(indexes.get("edge_to_eid") or {})
    node_eids: set = set(indexes.get("node_eids") or set())
    current: Dict[str, dict] = dict(indexes.get("current") or {})   # eid -> current payload

    ops: List[dict] = []
    resolutions: List[dict] = []

    node_rows = [r for r in rows if r.get("kind") == "node"]
    edge_rows = [r for r in rows if r.get("kind") == "edge"]

    # ---- pass 1: nodes ----
    for row in node_rows:
        matched_eid = _match_node(row, urn_to_eid, qname_to_eid, node_eids)
        if row.get("op") == "delete":
            if matched_eid:
                ops.append({"op": "delete", "entity_kind": "node", "entity_id": matched_eid, "payload": None})
                resolutions.append(_resolution(row, "delete", matched_eid))
            else:
                resolutions.append(_resolution(row, "invalid", None, reasons=["delete target not found"]))
            continue
        if matched_eid:
            changed = _changed_fields(_node_payload(row), current.get(matched_eid) or {})
            if not changed:                                       # a true no-op (e.g. an unchanged round-trip)
                resolutions.append(_resolution(row, "unchanged", matched_eid))
                continue
            ops.append({"op": "update", "entity_kind": "node", "entity_id": matched_eid, "payload": changed})
            resolutions.append(_resolution(row, "update", matched_eid))
            continue
        if not row.get("entityType"):
            resolutions.append(_resolution(row, "invalid", None, reasons=["node create requires entityType"]))
            continue
        eid = mint_id()
        node_eids.add(eid)
        if row.get("urn"):
            urn_to_eid[row["urn"]] = eid
        if row.get("qualifiedName"):
            qname_to_eid[row["qualifiedName"]] = eid
        ops.append({"op": "create", "entity_kind": "node", "entity_id": eid, "payload": _node_payload(row)})
        resolutions.append(_resolution(row, "create", eid))

    # ---- pass 2: edges ----
    for row in edge_rows:
        seid = _resolve_endpoint(row, "source", node_eids, qname_to_eid, urn_to_eid)
        teid = _resolve_endpoint(row, "target", node_eids, qname_to_eid, urn_to_eid)
        if not (row.get("edgeType") and seid and teid):
            reason = "edge missing edgeType" if not row.get("edgeType") else "edge endpoint not found"
            resolutions.append(_resolution(row, "invalid", None, reasons=[reason]))
            continue
        key = (seid, teid, row["edgeType"])
        matched_eid = edge_to_eid.get(key)
        if row.get("op") == "delete":
            if matched_eid:
                ops.append({"op": "delete", "entity_kind": "edge", "entity_id": matched_eid, "payload": None})
                resolutions.append(_resolution(row, "delete", matched_eid))
            else:
                resolutions.append(_resolution(row, "invalid", None, reasons=["delete edge not found"]))
            continue
        if matched_eid:
            changed = _changed_fields(_edge_payload(row, seid, teid), current.get(matched_eid) or {})
            if not changed:
                resolutions.append(_resolution(row, "unchanged", matched_eid))
                continue
            ops.append({"op": "update", "entity_kind": "edge", "entity_id": matched_eid, "payload": changed})
            resolutions.append(_resolution(row, "update", matched_eid))
        else:
            eid = mint_id()
            edge_to_eid[key] = eid
            ops.append({"op": "create", "entity_kind": "edge", "entity_id": eid,
                        "payload": _edge_payload(row, seid, teid)})
            resolutions.append(_resolution(row, "create", eid))

    return ops, resolutions


def _match_node(row, urn_to_eid, qname_to_eid, node_eids) -> str | None:
    eid = row.get("entity_id")
    if eid and eid in node_eids:
        return eid
    if row.get("urn") and row["urn"] in urn_to_eid:
        return urn_to_eid[row["urn"]]
    if row.get("qualifiedName") and row["qualifiedName"] in qname_to_eid:
        return qname_to_eid[row["qualifiedName"]]
    return None


def _resolve_endpoint(row, which, node_eids, qname_to_eid, urn_to_eid) -> str | None:
    eid = row.get(f"{which}_entity_id")
    if eid and eid in node_eids:
        return eid
    qname = row.get(f"{which}QualifiedName")
    if qname and qname in qname_to_eid:
        return qname_to_eid[qname]
    urn = row.get(f"{which}Urn")
    if urn and urn in urn_to_eid:
        return urn_to_eid[urn]
    return None
