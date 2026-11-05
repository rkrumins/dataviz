"""resolve_rows — match normalized import rows to entities and build versioned ops (plan Phase 3).

Pure and deterministic (``mint_id`` injected). Two passes so an edge can reference a node created
earlier in the same import:

* **nodes** match an existing entity by ``entity_id`` -> their pointers (``urn``, the identifier
  value; not stored) -> ``qualifiedName`` (else a new node — its id derived from its first pointer,
  or minted — registered in the local indexes for later edges);
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

from backend.common.property_patch import apply_patch

from ..ids import derived_entity_id, uuid_urn
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


_ABSENT = object()


def _same(a: Any, b: Any) -> bool:
    if a is _ABSENT or b is _ABSENT:
        return a is b
    return _scalar_eq(a, b)


def _stale(row: Mapping[str, Any], eid: str, hash_of: Mapping[str, str],
           bases: Mapping[tuple, dict]) -> Optional[dict]:
    """The version a row was exported at (its baseVersion) when the entity has changed since
    and this graph holds that version; else None — the row is current, carries no
    baseVersion, or names a version from elsewhere (another graph's export) — and it applies as
    it stands."""
    at = row.get("baseVersion")
    if not at or eid not in hash_of or hash_of[eid] == at:
        return None
    return bases.get((eid, at))


def _rebase(patch: Mapping[str, Any], base: Mapping[str, Any],
            cur: Mapping[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """patch cut to its user's own edits since base, the version its row was exported at,
    and the fields both sides changed differently. A cell still at its base value isn't an edit,
    so cur's value stands; one only the row changed applies; one both changed alike is a no-op;
    one both changed differently clashes. Tags merge as a set, keeping both sides' changes."""
    out: Dict[str, Any] = {}
    clashes: List[str] = []
    for field, value in patch.items():
        if field == "properties":
            was_props, now_props, props = base.get("properties") or {}, cur.get("properties") or {}, {}
            for k, v in value.items():
                mine = _ABSENT if v == PROP_DELETE else v
                was, now = was_props.get(k, _ABSENT), now_props.get(k, _ABSENT)
                if _same(mine, was):
                    continue
                if _same(now, was) or _same(mine, now):
                    props[k] = v
                else:
                    clashes.append(k)
            if props:
                out["properties"] = props
        elif field == "tags":
            mine, was = set(value or []), set(base.get("tags") or [])
            if mine != was:
                now = list(cur.get("tags") or [])
                out["tags"] = [t for t in now if t not in was - mine] + sorted(mine - was - set(now))
        elif not _scalar_eq(value, base.get(field)):
            if _scalar_eq(cur.get(field), base.get(field)) or _scalar_eq(value, cur.get(field)):
                out[field] = value
            else:
                clashes.append(field)
    return out, clashes


def _changed_since(fields: List[str]) -> str:
    return (f"changed since you exported it: {', '.join(fields)} — export again, or clear "
            "baseVersion to overwrite")


_STALE_DELETE = ("changed since you exported it — export again, or clear baseVersion to delete it "
                 "anyway")


#: A delete of what the graph doesn't hold — deleted already (a delta sent again), or never there:
#: there is nothing to do, so nothing to refuse, and the row says so (a mistyped name isn't silent).
_ALREADY_GONE = "nothing to delete: it isn't in the graph (deleted already, or never there)"


def _named_already(first: int, noun: str) -> str:
    return f"row {first + 1} of this file already names this {noun} — give each {noun} one row"


def _identity_edit(given: Optional[str], eid: str, cur: Mapping[str, Any],
                   urn_to_eid: Mapping[str, str]) -> Optional[str]:
    """What a matched row's pointer given says of its node eid: None when it names it
    (as its urn, or by a name this import knows it by), "other" when it names another entity,
    "new" when it names nothing — a rename an import doesn't make: a node's urn is its
    identity."""
    if not given:
        return None
    hits = {urn_to_eid[n] for n in pointers(given) if n in urn_to_eid}
    own = cur.get("urn")
    if eid in hits or (own and (uuid_urn(own) or own) == (uuid_urn(given) or given)):
        return None
    return "other" if hits else "new"


_BY = {"entity_id": "its entity_id", "key": "the field it matches by"}


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


def pointers(*values: Any) -> List[str]:
    """What a row (or an edge end) points at its node by — its urn, then its value of the data
    source's identifier property — each as given and, a ``urn:uuid:`` in any case, in canonical
    form too, so a stored urn spelled either way is found. Blanks and repeats dropped."""
    out: List[str] = []
    for v in values:
        given = key_value(v)
        for name in (given, uuid_urn(given)):
            if name and name not in out:
                out.append(name)
    return out


def pointer_seed(*values: Any) -> Optional[str]:
    """The name a new node's id is derived from: the first pointer, in canonical form."""
    for v in values:
        given = key_value(v)
        if given:
            return uuid_urn(given) or given
    return None


def pointer_id(scope: str, name: str) -> str:
    """The id of a node an import makes from ``name``: a ``urn:uuid:`` (v5) of the graph's
    identity scope — its data source — and the name, so a file imported again names the same
    node however often it is sent. ``pointer:`` keeps these seeds apart from a create's key."""
    return derived_entity_id("node", f"{scope}/pointer:{name}")


def resolve_rows(
    rows: Sequence[Mapping[str, Any]],
    indexes: Mapping[str, Any],
    *,
    mint_id: Callable[[], str],
    ontology: Optional[Mapping[str, Any]] = None,
    mint_urn: Optional[Callable[[str], str]] = None,
    identity_prop: Optional[str] = None,
    derive_urn: Optional[Callable[[str], str]] = None,
) -> Tuple[List[dict], List[dict]]:
    """Return ``(ops, resolutions)`` for the given normalized ``rows``.

    ``ontology`` (optional ``{"node_types": [...], "edge_types": [...]}``) enables the **per-row
    ontology gate**: a node whose ``entityType`` / an edge whose ``edgeType`` isn't a type the
    ontology defines is quarantined (invalid) rather than written — partial acceptance, so a few bad
    rows don't fail the batch. Absent/empty type lists → the gate is skipped (best-effort).

    The ids a file carries are POINTERS (:func:`pointers`): a row's urn and its value of the data
    source's identifier property (``identity_prop``) name a node that holds one as its urn, or
    whose id an earlier import derived from it (``indexes["urn_to_eid"]`` maps both, and a second
    name a row gave a node in this job), and are not stored. Two that name different entities
    refuse the row. ``mint_urn(entityType)``: a new node takes ONE identity, the server's — a
    pointer only a deleted node held brings that node back (``indexes["restore"]``); else a free
    ``urn:uuid:`` pointer is kept; else ``derive_urn(seed)`` derives it from the first pointer, so
    a re-import names it again; else (no pointer) a new urn is minted. Its identifier property
    takes the urn at the write. Without ``mint_urn``, a new node keeps the row's urn under an id
    from ``mint_id``. ``indexes["keys"]`` (:class:`KeyIndex`) matches rows and edge ends by the
    fields their types match imports by, and keeps unique fields unique.
    ``indexes["created_from"]``: the job's file entity ids of nodes it matched or created."""
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
    # An offline edit is reconciled, never silently lost: a stale row (its entity changed since its
    # baseVersion) applies only its own edits; and one entity takes one row of a file.
    hash_of: Mapping[str, str] = indexes.get("hash_of") or {}      # eid -> its head's content hash
    bases: Mapping[tuple, dict] = indexes.get("bases") or {}        # (eid, hash) -> that version
    edge_eids: set = set(indexes.get("edge_eids") or ())           # live edges rows name by id
    earlier: Mapping[str, int] = indexes.get("earlier") or {}       # eid -> an earlier window's row
    seen: Dict[str, int] = {}                                       # eid -> this window's row for it
    after: Dict[str, dict] = {}                                     # eid -> as that row left it
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
        names = pointers(row.get("urn"), ident)
        etype = _canon(row.get("entityType"), node_type_canon) if row.get("entityType") else None
        by_key = (lambda t=etype, p=props: keys.node(t, p)) if keys else None
        matched_eid, ambiguous, by = _named(row.get("entity_id"), names, row.get("qualifiedName"),
                                            node_eids, urn_to_eid, qname_to_eid, created_from,
                                            qname_from, by_key)
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
        first = earlier.get(matched_eid, seen.get(matched_eid)) if matched_eid else None
        if row.get("op") == "delete":
            if matched_eid and first is not None:
                resolutions.append(_resolution(row, "invalid", matched_eid,
                                               reasons=[_named_already(first, "node")]))
            elif matched_eid and _stale(row, matched_eid, hash_of, bases) is not None:
                resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[_STALE_DELETE]))
            elif matched_eid:
                ops.append({"op": "delete", "entity_kind": "node", "entity_id": matched_eid, "payload": None})
                resolutions.append(_resolution(row, "delete", matched_eid))
                seen[matched_eid] = row.get("_row_index")
            else:
                resolutions.append(_resolution(row, "unchanged", None, reasons=[_ALREADY_GONE]))
            continue
        if node_types is not None and row.get("entityType") and str(row["entityType"]).strip().lower() not in node_types:
            resolutions.append(_resolution(row, "invalid", matched_eid,
                reasons=[f"'{row['entityType']}' is not a valid entity type in this ontology"]))
            continue
        if matched_eid:
            np = _node_payload(row)
            if "entityType" in np:                                # normalize casing before diffing
                np["entityType"] = _canon(np["entityType"], node_type_canon)
            cur = after.get(matched_eid) or current.get(matched_eid) or {}
            notes: List[str] = []
            other = None
            if mint_urn is not None:                              # a pointer is never stored
                for column, given in (("urn", key_value(row.get("urn"))), (identity_prop, ident)):
                    said = _identity_edit(given, matched_eid, cur, urn_to_eid)
                    if said == "other":
                        other = column
                    elif said == "new":
                        notes.append(f"{column} '{given}' isn't stored: an import never changes a "
                                     "node's urn — keep your own id in another property")
            if other:
                resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[(
                    f"{_BY.get(by, 'it')} and its {other} name two different entities — "
                    "give it one of them")]))
                continue
            if by == "key" or mint_urn is not None:               # the file's ids point at the
                np.pop("urn", None)                               # node: it keeps its own
                held = np.get("properties") or {}
                if (mint_urn is not None and identity_prop in held
                        and key_value(held[identity_prop]) != cur.get("urn")):
                    np["properties"] = {k: v for k, v in held.items() if k != identity_prop}
            clash = keys.clash(np.get("entityType") or cur.get("entityType"), props,
                               but=matched_eid) if keys else None
            if clash:
                resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[clash]))
                continue
            # Later rows of this window that point at it the same way find it too.
            if row.get("entity_id") and row["entity_id"] != matched_eid:
                created_from.setdefault(row["entity_id"], matched_eid)
            for name in names:
                urn_to_eid.setdefault(name, matched_eid)
            base = _stale(row, matched_eid, hash_of, bases)
            if base is not None:                                  # changed since it was exported
                np, clashes = _rebase(np, base, cur)
                if clashes:                                   # a second row's clash is its own
                    resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[
                        _named_already(first, "node") if first is not None
                        else _changed_since(clashes), *notes]))
                    continue
            changed = _changed_fields(np, cur)
            if changed and first is not None:                     # a second row, saying otherwise
                resolutions.append(_resolution(row, "invalid", matched_eid,
                                               reasons=[_named_already(first, "node")]))
                continue
            seen.setdefault(matched_eid, row.get("_row_index"))
            if not changed:                                       # a true no-op (e.g. an unchanged round-trip)
                resolutions.append(_resolution(row, "unchanged", matched_eid, reasons=notes))
                continue
            after[matched_eid] = apply_patch(cur, changed)
            ops.append({"op": "update", "entity_kind": "node", "entity_id": matched_eid, "payload": changed})
            resolutions.append(_resolution(row, "update", matched_eid,
                                           reasons=[*notes, *([f"matched by {by}"] if by == "key" else [])]))
            continue
        if not row.get("entityType"):
            resolutions.append(_resolution(row, "invalid", None, reasons=["node create requires entityType"]))
            continue
        urn = row.get("urn")
        clash = keys.clash(etype, props) if keys else None
        if clash:
            resolutions.append(_resolution(row, "invalid", None, reasons=[clash]))
            continue
        # One identity, the server's to decide — the id, the urn and (bound at the write) the
        # identifier property alike: the deleted node a pointer names brought back; else a free
        # urn:uuid the row brings, so an entity keeps its id from one environment to the next;
        # else one derived from the row's first pointer, which a re-import derives again; else
        # (it points by nothing) a urn minted here.
        minted = False
        restored = next((n for n in names if n in restore), None)
        free = next((n for n in names if uuid_urn(n) == n and n not in taken
                     and n not in node_eids), None)
        seed = pointer_seed(urn, ident)
        if mint_urn is None:
            eid, node_urn = mint_id(), urn
        elif restored:
            eid, node_urn = restore.pop(restored), restored
        elif free:
            eid = node_urn = free
        elif seed and derive_urn is not None:
            eid = node_urn = derive_urn(seed)
        else:
            eid = node_urn = mint_urn(etype)
            minted = True
        node_eids.add(eid)
        taken.add(eid)
        if row.get("entity_id"):
            created_from[row["entity_id"]] = eid
        for name in set(names) | {node_urn} - {None}:     # what the file calls it names it here
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
            if identity_prop in (p.get("properties") or {}):          # a pointer, not a value:
                p["properties"] = {k: v for k, v in p["properties"].items()   # the write binds
                                   if k != identity_prop}                     # it to the urn
        op = {"op": "create", "entity_kind": "node", "entity_id": eid, "payload": p}
        if minted:
            op["minted"] = True                           # the identifier property takes the urn
        if keys:
            keys.add(etype, props, eid, node_urn)
        seen[eid], after[eid] = row.get("_row_index"), p
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
            if row.get("op") == "delete" and row.get("edgeType") and not (s_ambiguous or t_ambiguous):
                # An end that's gone took its edges with it: nothing is left to delete.
                resolutions.append(_resolution(row, "unchanged", None, reasons=[_ALREADY_GONE]))
                continue
            reason = ("edge missing edgeType" if not row.get("edgeType")
                      else s_ambiguous or t_ambiguous or "edge endpoint not found")
            resolutions.append(_resolution(row, "invalid", None, reasons=[reason]))
            continue
        etype = _canon(row["edgeType"], edge_type_canon)   # declared casing for a new edge
        key = (seid, teid, _etype_key(etype))
        matched_eid = edge_to_eid.get(key)
        named = row.get("entity_id")
        if named and named in edge_eids:                  # an exported edge, by its own id
            held = current.get(named) or {}
            if (held.get("sourceEntityId"), held.get("targetEntityId"),
                    _etype_key(held.get("edgeType"))) != key:
                resolutions.append(_resolution(row, "invalid", named, reasons=[(
                    f"its ends or type differ from edge {named}'s — to re-point an edge, mark its "
                    "row _op=delete and add a new row without an entity_id")]))
                continue
            matched_eid = named                           # that edge, beside any parallel one
        first = earlier.get(matched_eid, seen.get(matched_eid)) if matched_eid else None
        if row.get("op") == "delete":
            if matched_eid and first is not None:
                resolutions.append(_resolution(row, "invalid", matched_eid,
                                               reasons=[_named_already(first, "edge")]))
            elif matched_eid and _stale(row, matched_eid, hash_of, bases) is not None:
                resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[_STALE_DELETE]))
            elif matched_eid:
                ops.append({"op": "delete", "entity_kind": "edge", "entity_id": matched_eid, "payload": None})
                resolutions.append(_resolution(row, "delete", matched_eid))
                seen[matched_eid] = row.get("_row_index")
            else:
                resolutions.append(_resolution(row, "unchanged", None, reasons=[_ALREADY_GONE]))
            continue
        if matched_eid:
            ep = _edge_payload(row, seid, teid)
            # The matched edge keeps its spelling: a case variant is the same edge, not a retype.
            ep["edgeType"] = (edge_type_of.get(matched_eid)
                              or (current.get(matched_eid) or {}).get("edgeType") or etype)
            cur = after.get(matched_eid) or current.get(matched_eid) or {}
            base = _stale(row, matched_eid, hash_of, bases)
            if base is not None:                          # changed since it was exported
                ep, clashes = _rebase(ep, base, cur)
                if clashes:
                    resolutions.append(_resolution(row, "invalid", matched_eid, reasons=[
                        _named_already(first, "edge") if first is not None
                        else _changed_since(clashes)]))
                    continue
            changed = _changed_fields(ep, cur)
            if changed and first is not None:             # a second row, saying otherwise
                resolutions.append(_resolution(row, "invalid", matched_eid,
                                               reasons=[_named_already(first, "edge")]))
                continue
            seen.setdefault(matched_eid, row.get("_row_index"))
            if not changed:
                resolutions.append(_resolution(row, "unchanged", matched_eid))
                continue
            after[matched_eid] = apply_patch(cur, changed)
            ops.append({"op": "update", "entity_kind": "edge", "entity_id": matched_eid, "payload": changed})
            resolutions.append(_resolution(row, "update", matched_eid))
        else:
            eid = mint_id()
            edge_to_eid[key] = eid
            edge_type_of[eid] = etype
            ep = _no_deletes(_edge_payload(row, seid, teid))
            ep["edgeType"] = etype
            seen[eid], after[eid] = row.get("_row_index"), ep
            ops.append({"op": "create", "entity_kind": "edge", "entity_id": eid, "payload": ep})
            resolutions.append(_resolution(row, "create", eid))

    return ops, resolutions


def _etype_key(edge_type) -> str:
    """An edge type as edge identity compares it: case-insensitively (as the integrity gate does)."""
    return str(edge_type or "").upper()


def _named(eid, names, qname, node_eids, urn_to_eid, qname_to_eid, created_from,
           qname_from, by_key=None) -> Tuple[str | None, str | None, str | None]:
    """The entity a row (or an edge end) names: by ``eid`` (an entity's, or the file's own id of a
    node this job matched or created), then the ``names`` it points at its node by
    (:func:`pointers`: its urn, its identifier value), then a field its type matches imports by
    (``by_key``), then — only when it points by no name — ``qname``. ``(entity_id | None, None,
    by)``, or ``(None, reason, None)`` when its names point at two entities, or its qualifiedName
    or key value is carried by several, or by a node this batch created from another of the
    file's entity ids. ``by`` says how it matched."""
    if eid and eid in node_eids:
        return eid, None, "entity_id"
    if eid and eid in created_from:
        return created_from[eid], None, "entity_id"
    hits = {urn_to_eid[n] for n in names if n in urn_to_eid}
    if len(hits) > 1:
        return None, ("its urn and its identifier value name two different entities — "
                      "give it one of them"), None
    if hits:
        return next(iter(hits)), None, "urn"
    if by_key is not None:
        hit, why = by_key()
        if hit or why:
            return hit, why, "key" if hit else None
    if names:
        return None, None, None             # names that match nothing: a new entity
    if qname and qname in qname_to_eid:
        if qname_to_eid[qname] is None:
            return None, (f"qualifiedName '{qname}' matches more than one entity — "
                          "give the row a urn or an entity_id"), None
        if eid and qname_from.get(qname) not in (None, eid):
            return None, (f"qualifiedName '{qname}' is carried by more than one item in this file — "
                          "give the rows a urn"), None
        return qname_to_eid[qname], None, "qualifiedName"
    return None, None, None


def _resolve_endpoint(row, which, node_eids, qname_to_eid, urn_to_eid, created_from,
                      qname_from, keys=None, identity_prop=None) -> Tuple[str | None, str | None]:
    """An edge end: by its entity_id, urn or qualifiedName, or by a property of its node
    (``source.<field>``): the identifier property, read as the urn, or a field its type matches by."""
    named = dict(row.get(f"{which}Keys") or {})
    ident = named.pop(identity_prop, None) if identity_prop else None
    by_key = (lambda: keys.end(named)) if keys and named else None
    eid, why, _by = _named(row.get(f"{which}_entity_id"), pointers(row.get(f"{which}Urn"), ident),
                           row.get(f"{which}QualifiedName"), node_eids, urn_to_eid, qname_to_eid,
                           created_from, qname_from, by_key)
    return eid, why
