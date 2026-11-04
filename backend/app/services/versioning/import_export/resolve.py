"""resolve_rows — match normalized import rows to entities and build versioned ops (plan Phase 3).

Pure and deterministic (``mint_id`` injected). Two passes so an edge can reference a node created
earlier in the same import:

* **nodes** match an existing entity by ``entity_id`` -> ``urn`` -> ``qualifiedName`` (else mint a
  new id and register it in the local indexes for later edges);
* **edges** resolve endpoints the same way and key by the ``(src_eid, tgt_eid, EDGE_TYPE)`` triple
  (the type upper-cased, as the edge-integrity gate compares it), keeping the stored spelling.

``qualifiedName`` identifies only a row (or an edge end) that has no urn: it is not unique, so a row
with a urn that matches nothing is a NEW entity, never folded into another urn's entity that
happens to share its qualifiedName; and a qualifiedName that several entities carry (``None`` in
``qname_to_eid``) names none of them — the row is quarantined rather than written to a guess. That
holds inside one file too: a node this batch created answers to the file ``entity_id`` it was
created from, and a later urn-less row carrying its qualifiedName under ANOTHER file entity_id is a
second item, not an update of the first — it is quarantined, and the qualifiedName names neither.

Emits ``{op, entity_kind, entity_id, payload}`` ops (nodes before edges) for
:meth:`GraphVersioningService.apply_ops`, plus a per-row resolution record
(``create|update|delete|invalid`` + status + reasons) for the preview/summary. A partial-acceptance
model: an unresolvable row is quarantined (``invalid`` with a reason), never fatal.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .rowmodel import PROP_DELETE

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
    """Only the properties whose value actually changed (or are new), type-tolerant. A ``PROP_DELETE``
    sentinel is a removal — kept only when the property currently exists (else it's a no-op)."""
    cur = cur_props or {}
    out: Dict[str, Any] = {}
    for k, v in (new_props or {}).items():
        if v == PROP_DELETE:
            if k in cur:
                out[k] = v
        elif not _scalar_eq(v, cur.get(k)):
            out[k] = v
    return out


def _no_deletes(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Strip PROP_DELETE sentinels from a CREATE payload — you can't delete a property on a brand-new
    entity (the sentinel only means something against an existing entity's properties)."""
    props = payload.get("properties")
    if props:
        cleaned = {k: v for k, v in props.items() if v != PROP_DELETE}
        if cleaned:
            payload["properties"] = cleaned
        else:
            payload.pop("properties", None)
    return payload


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


def _lc(values) -> Optional[set]:
    """Lowercased set for case-tolerant type matching, or ``None`` when empty (skip the gate)."""
    s = {str(v).strip().lower() for v in (values or []) if str(v).strip()}
    return s or None


def _canonical_map(values) -> Dict[str, str]:
    """``lowercased type name → declared casing`` (first declared wins), for restoring the
    ontology's exact spelling on emitted ops. The import worker does not run ops through the
    commit-boundary canonicalizer (it does not pass ``ontology_rules`` into ``apply_ops``), so
    a case variant is normalized here instead — otherwise a lowercase ``has`` would project
    case-sensitively as ``:has`` and miss the ``:HAS`` containment predicate."""
    out: Dict[str, str] = {}
    for v in (values or []):
        s = str(v).strip()
        if s:
            out.setdefault(s.lower(), s)
    return out


def _canon(value, canon_map: Dict[str, str]):
    """Declared casing for *value* if it matches a declared type case-insensitively; else
    *value* unchanged (unknown/missing types are left for the per-row gate to judge)."""
    if value is None or not canon_map:
        return value
    return canon_map.get(str(value).strip().lower(), value)


class KeyIndex:
    """A job's reconciliation keys and unique fields, by value: which live nodes of a type carry
    ``value`` in a field the type matches imports by (``match``) or holds unique (``unique``). Built
    by the import worker from the draft's live nodes for the values its file uses, then extended by
    the nodes the job creates. :meth:`overlay` is a window's own copy: what a window creates joins
    the job's only once it is committed."""

    def __init__(self, match: Optional[Mapping[str, Sequence[str]]] = None,
                 unique: Optional[Mapping[str, Sequence[str]]] = None,
                 _base: Optional["KeyIndex"] = None) -> None:
        self.match = {t: list(f) for t, f in (match or {}).items() if f}
        self.unique = {t: list(f) for t, f in (unique or {}).items() if f}
        self.held: Dict[Tuple[str, str, str], set] = {}
        self.urn_of: Dict[str, str] = {}
        self._base = _base

    def overlay(self) -> "KeyIndex":
        return KeyIndex(self.match, self.unique, _base=self)

    def __bool__(self) -> bool:
        return bool(self.match or self.unique)

    def fields(self, etype: Optional[str]) -> List[str]:
        """The fields of ``etype`` this index keeps: those it matches by, then the unique ones."""
        out = list(self.match.get(etype or "", []))
        return out + [f for f in self.unique.get(etype or "", []) if f not in out]

    def values(self, etype: Optional[str], props: Optional[Mapping[str, Any]]) -> List[Tuple[str, str]]:
        return [(f, v) for f in self.fields(etype) if (v := key_value((props or {}).get(f))) is not None]

    def _holders(self, key: Tuple[str, str, str]) -> set:
        own = self.held.get(key, set())
        return own | self._base._holders(key) if self._base is not None else own

    def _name(self, eid: str) -> str:
        return self.urn_of.get(eid) or (self._base._name(eid) if self._base is not None else eid)

    def add(self, etype: Optional[str], props: Optional[Mapping[str, Any]], eid: str,
            urn: Optional[str] = None) -> None:
        for field, value in self.values(etype, props):
            self.held.setdefault((etype or "", field, value), set()).add(eid)
        if urn:
            self.urn_of[eid] = urn

    def node(self, etype: Optional[str], props) -> Tuple[Optional[str], Optional[str]]:
        """The node a row of ``etype`` names by a field its type matches by: ``(id, None)``, or
        ``(None, reason)`` when several carry the value, else ``(None, None)``."""
        for field in self.match.get(etype or "", []):
            value = key_value((props or {}).get(field))
            if value is None:
                continue
            holders = self._holders((etype or "", field, value))
            if len(holders) == 1:
                return next(iter(holders)), None
            if holders:
                return None, (f"{field} '{value}' matches {len(holders)} {etype} entities — "
                              "give the row a urn or an entity_id")
        return None, None

    def end(self, keys: Mapping[str, Any]) -> Tuple[Optional[str], Optional[str]]:
        """The node an edge end names by ``{field: value}`` — any type that matches by the field."""
        for field, raw in keys.items():
            value = key_value(raw)
            types = [t for t, fs in self.match.items() if field in fs]
            if value is None or not types:
                continue
            holders = set().union(*(self._holders((t, field, value)) for t in types))
            if len(holders) == 1:
                return next(iter(holders)), None
            if holders:
                return None, (f"{field} '{value}' matches {len(holders)} entities — "
                              "name the end by its urn")
        return None, None

    def clash(self, etype: Optional[str], props, *, but: Optional[str] = None) -> Optional[str]:
        """Why a node of ``etype`` can't carry ``props``: a unique field's value another node holds."""
        for field in self.unique.get(etype or "", []):
            value = key_value((props or {}).get(field))
            if value is None:
                continue
            others = self._holders((etype or "", field, value)) - {but}
            if others:
                return f"{field} '{value}' is already used by {self._name(sorted(others)[0])}"
        return None


def key_value(v: Any) -> Optional[str]:
    """A field value as keys compare it: a scalar's text, trimmed; ``None`` for a blank, a removal
    or a list or object (no key)."""
    if v is None or v == PROP_DELETE or isinstance(v, (dict, list)):
        return None
    s = str(v).strip()
    return s or None


def resolve_rows(
    rows: Sequence[Mapping[str, Any]],
    indexes: Mapping[str, Any],
    *,
    mint_id: Callable[[], str],
    ontology: Optional[Mapping[str, Any]] = None,
    mint_urn: Optional[Callable[[str], str]] = None,
    identity_prop: Optional[str] = None,
) -> Tuple[List[dict], List[dict]]:
    """Return ``(ops, resolutions)`` for the given normalized ``rows``.

    ``ontology`` (optional ``{"node_types": [...], "edge_types": [...]}``) enables the **per-row
    ontology gate**: a node whose ``entityType`` / an edge whose ``edgeType`` isn't a type the
    ontology defines is quarantined (invalid) rather than written — partial acceptance, so a few bad
    rows don't fail the batch. Absent/empty type lists → the gate is skipped (best-effort).

    ``mint_urn(entityType)``: a new node takes ONE identity, its id and its urn alike — the urn the
    row brings (or its value of the data source's identifier property, ``identity_prop``) when no
    entity holds it (``indexes["taken"]``), else a urn the server mints; a urn only a deleted node
    held brings that node back (``indexes["restore"]``). Without it, a new node keeps the row's urn
    under an id from ``mint_id``. ``indexes["keys"]`` (:class:`KeyIndex`) matches rows and edge ends
    by the fields their types match imports by, and keeps unique fields unique.
    ``indexes["created_from"]``: the job's file entity ids of nodes earlier windows created."""
    urn_to_eid: Dict[str, str] = dict(indexes.get("urn_to_eid") or {})
    qname_to_eid: Dict[str, Optional[str]] = dict(indexes.get("qname_to_eid") or {})   # None: several
    edge_to_eid: Dict[tuple, str] = {(s, t, _etype_key(et)): eid
                                     for (s, t, et), eid in (indexes.get("edge_to_eid") or {}).items()}
    edge_type_of: Dict[str, str] = {}             # an edge created by this batch -> its spelling
    # A node this job created, by the file entity_id of the row that created it (earlier windows'
    # and this one's); and a qualifiedName such a node registered -> that file entity_id (None: its
    # row carried none).
    created_from: Dict[str, str] = dict(indexes.get("created_from") or {})
    qname_from: Dict[str, Optional[str]] = {}
    taken: set = set(indexes.get("taken") or ())
    restore: Dict[str, str] = dict(indexes.get("restore") or {})
    base_keys: Optional[KeyIndex] = indexes.get("keys")
    keys: Optional[KeyIndex] = base_keys.overlay() if base_keys else None
    node_eids: set = set(indexes.get("node_eids") or set())
    current: Dict[str, dict] = dict(indexes.get("current") or {})   # eid -> current payload
    node_types = _lc(ontology.get("node_types")) if ontology else None   # lowercased valid sets | None
    edge_types = _lc(ontology.get("edge_types")) if ontology else None
    node_type_canon = _canonical_map(ontology.get("node_types")) if ontology else {}
    edge_type_canon = _canonical_map(ontology.get("edge_types")) if ontology else {}

    ops: List[dict] = []
    resolutions: List[dict] = []

    node_rows = [r for r in rows if r.get("kind") == "node"]
    edge_rows = [r for r in rows if r.get("kind") == "edge"]

    # ---- pass 1: nodes ----
    for row in node_rows:
        props = row.get("properties") or {}
        ident = key_value(props.get(identity_prop)) if identity_prop else None
        etype = _canon(row.get("entityType"), node_type_canon) if row.get("entityType") else None
        by_key = (lambda t=etype, p=props: keys.node(t, p)) if keys else None
        matched_eid, ambiguous, by = _match_node(row, ident, urn_to_eid, qname_to_eid, node_eids,
                                                 created_from, qname_from, by_key)
        if row.get("op") == "invalid":
            # Still names what it matched: a replace must not read that entity as absent.
            resolutions.append(_resolution(row, "invalid", None if ambiguous else matched_eid,
                                           reasons=[row.get("op_error") or "invalid row"]))
            continue
        if ambiguous:
            if row.get("qualifiedName") and not row.get("urn"):
                qname_to_eid[row["qualifiedName"]] = None   # two items carry it: it names neither
            resolutions.append(_resolution(row, "invalid", None, reasons=[ambiguous]))
            continue
        if row.get("op") == "delete":
            if matched_eid:
                ops.append({"op": "delete", "entity_kind": "node", "entity_id": matched_eid, "payload": None})
                resolutions.append(_resolution(row, "delete", matched_eid))
            else:
                resolutions.append(_resolution(row, "invalid", None, reasons=["delete target not found"]))
            continue
        if node_types is not None and row.get("entityType") and str(row["entityType"]).strip().lower() not in node_types:
            resolutions.append(_resolution(row, "invalid", matched_eid,
                reasons=[f"'{row['entityType']}' is not a valid entity type in this ontology"]))
            continue
        if matched_eid:
            np = _node_payload(row)
            if "entityType" in np:                                # normalize casing before diffing
                np["entityType"] = _canon(np["entityType"], node_type_canon)
            cur = current.get(matched_eid) or {}
            if by == "key":                                       # a team's key named it: the
                np.pop("urn", None)                               # node keeps its own identity
            clash = keys.clash(np.get("entityType") or cur.get("entityType"), props,
                               but=matched_eid) if keys else None
            if clash:
                resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[clash]))
                continue
            changed = _changed_fields(np, cur)
            if not changed:                                       # a true no-op (e.g. an unchanged round-trip)
                resolutions.append(_resolution(row, "unchanged", matched_eid))
                continue
            ops.append({"op": "update", "entity_kind": "node", "entity_id": matched_eid, "payload": changed})
            resolutions.append(_resolution(row, "update", matched_eid,
                                           reasons=[f"matched by {by}"] if by == "key" else None))
            continue
        if not row.get("entityType"):
            resolutions.append(_resolution(row, "invalid", None, reasons=["node create requires entityType"]))
            continue
        urn = row.get("urn")
        if mint_urn is not None and urn and ident and ident != urn:
            resolutions.append(_resolution(row, "invalid", None, reasons=[
                f"urn '{urn}' and {identity_prop} '{ident}' differ — a new item has one identity"]))
            continue
        clash = keys.clash(etype, props) if keys else None
        if clash:
            resolutions.append(_resolution(row, "invalid", None, reasons=[clash]))
            continue
        # One identity, the server's to decide: the row's urn (or identifier value) when nothing
        # holds it, the deleted node that held it brought back, else a urn minted here — the id,
        # the urn and (bound at the write) the identifier property alike.
        wanted, minted = urn or ident, False
        if mint_urn is None:
            eid, node_urn = mint_id(), urn
        elif wanted and wanted in restore:
            eid, node_urn = restore.pop(wanted), wanted
        elif wanted and wanted not in taken and wanted not in node_eids:
            eid = node_urn = wanted
        else:
            eid = node_urn = mint_urn(etype)
            minted = True
        node_eids.add(eid)
        taken.add(eid)
        if row.get("entity_id"):
            created_from[row["entity_id"]] = eid
        for name in {node_urn, wanted} - {None}:          # the file's urn names it in this file too
            urn_to_eid[name] = eid
        if row.get("qualifiedName"):                      # another entity's too: it names neither
            qn = row["qualifiedName"]
            qname_to_eid[qn] = None if qname_to_eid.get(qn, eid) != eid else eid
            qname_from.setdefault(qn, row.get("entity_id") or None)
        p = _no_deletes(_node_payload(row))
        if "entityType" in p:
            p["entityType"] = _canon(p["entityType"], node_type_canon)
        if mint_urn is not None:
            p["urn"] = node_urn
        op = {"op": "create", "entity_kind": "node", "entity_id": eid, "payload": p}
        if minted:
            op["minted"] = True                           # the identifier property takes the urn
        if keys:
            keys.add(etype, props, eid, node_urn)
        ops.append(op)
        resolutions.append(_resolution(row, "create", eid))

    # ---- pass 2: edges ----
    for row in edge_rows:
        if row.get("op") == "invalid":
            resolutions.append(_resolution(row, "invalid", None, reasons=[row.get("op_error") or "invalid row"]))
            continue
        if edge_types is not None and row.get("edgeType") and str(row["edgeType"]).strip().lower() not in edge_types:
            resolutions.append(_resolution(row, "invalid", None,
                reasons=[f"'{row['edgeType']}' is not a valid edge type in this ontology"]))
            continue
        seid, s_ambiguous = _resolve_endpoint(row, "source", node_eids, qname_to_eid, urn_to_eid,
                                              created_from, qname_from, keys, identity_prop)
        teid, t_ambiguous = _resolve_endpoint(row, "target", node_eids, qname_to_eid, urn_to_eid,
                                              created_from, qname_from, keys, identity_prop)
        if not (row.get("edgeType") and seid and teid):
            reason = ("edge missing edgeType" if not row.get("edgeType")
                      else s_ambiguous or t_ambiguous or "edge endpoint not found")
            resolutions.append(_resolution(row, "invalid", None, reasons=[reason]))
            continue
        etype = _canon(row["edgeType"], edge_type_canon)   # declared casing for a new edge
        key = (seid, teid, _etype_key(etype))
        matched_eid = edge_to_eid.get(key)
        if row.get("op") == "delete":
            if matched_eid:
                ops.append({"op": "delete", "entity_kind": "edge", "entity_id": matched_eid, "payload": None})
                resolutions.append(_resolution(row, "delete", matched_eid))
            else:
                resolutions.append(_resolution(row, "invalid", None, reasons=["delete edge not found"]))
            continue
        if matched_eid:
            ep = _edge_payload(row, seid, teid)
            # The matched edge keeps its spelling: a case variant is the same edge, not a retype.
            ep["edgeType"] = (edge_type_of.get(matched_eid)
                              or (current.get(matched_eid) or {}).get("edgeType") or etype)
            changed = _changed_fields(ep, current.get(matched_eid) or {})
            if not changed:
                resolutions.append(_resolution(row, "unchanged", matched_eid))
                continue
            ops.append({"op": "update", "entity_kind": "edge", "entity_id": matched_eid, "payload": changed})
            resolutions.append(_resolution(row, "update", matched_eid))
        else:
            eid = mint_id()
            edge_to_eid[key] = eid
            edge_type_of[eid] = etype
            ep = _no_deletes(_edge_payload(row, seid, teid))
            ep["edgeType"] = etype
            ops.append({"op": "create", "entity_kind": "edge", "entity_id": eid, "payload": ep})
            resolutions.append(_resolution(row, "create", eid))

    return ops, resolutions


def _etype_key(edge_type) -> str:
    """An edge type as edge identity compares it: case-insensitively (as the integrity gate does)."""
    return str(edge_type or "").upper()


def _named(eid, urn, qname, node_eids, urn_to_eid, qname_to_eid, created_from,
           qname_from, by_key=None) -> Tuple[str | None, str | None, str | None]:
    """The entity a row (or an edge end) names: by ``eid`` (an entity's, or the file's own id of a
    node this job created), then ``urn`` (or the identifier property's value), then a field its
    type matches imports by (``by_key``), then — only when it has no urn — ``qname``.
    ``(entity_id | None, None, by)``, or ``(None, reason, None)`` when its qualifiedName or key
    value is carried by several entities, or by a node this batch created from another of the
    file's entity ids. ``by`` says how it matched."""
    if eid and eid in node_eids:
        return eid, None, "entity_id"
    if eid and eid in created_from:
        return created_from[eid], None, "entity_id"
    if urn and urn in urn_to_eid:
        return urn_to_eid[urn], None, "urn"
    if by_key is not None:
        hit, why = by_key()
        if hit or why:
            return hit, why, "key" if hit else None
    if urn:
        return None, None, None             # a urn that matches nothing: a new entity
    if qname and qname in qname_to_eid:
        if qname_to_eid[qname] is None:
            return None, (f"qualifiedName '{qname}' matches more than one entity — "
                          "give the row a urn or an entity_id"), None
        if eid and qname_from.get(qname) not in (None, eid):
            return None, (f"qualifiedName '{qname}' is carried by more than one item in this file — "
                          "give the rows a urn"), None
        return qname_to_eid[qname], None, "qualifiedName"
    return None, None, None


def _match_node(row, ident, urn_to_eid, qname_to_eid, node_eids, created_from,
                qname_from, by_key=None) -> Tuple[str | None, str | None, str | None]:
    return _named(row.get("entity_id"), row.get("urn") or ident, row.get("qualifiedName"),
                  node_eids, urn_to_eid, qname_to_eid, created_from, qname_from, by_key)


def _resolve_endpoint(row, which, node_eids, qname_to_eid, urn_to_eid, created_from,
                      qname_from, keys=None, identity_prop=None) -> Tuple[str | None, str | None]:
    """An edge end: by its entity_id, urn or qualifiedName, or by a property of its node
    (``source.<field>``): the identifier property, read as the urn, or a field its type matches by."""
    named = dict(row.get(f"{which}Keys") or {})
    ident = key_value(named.pop(identity_prop, None)) if identity_prop else None
    by_key = (lambda: keys.end(named)) if keys and named else None
    eid, why, _by = _named(row.get(f"{which}_entity_id"), row.get(f"{which}Urn") or ident,
                           row.get(f"{which}QualifiedName"), node_eids, urn_to_eid, qname_to_eid,
                           created_from, qname_from, by_key)
    return eid, why
