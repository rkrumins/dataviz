"""Ontology validation for staged/published entities (plan §3, §16.5 #6).

Opt-in per graph: a graph with no ``ontology_spec`` is unconstrained (any types).
When a spec is present it restricts the **constrained dimensions only** — set
``entity_types`` to restrict node types, ``edge_types`` to restrict edge types;
an unset dimension stays open. ``ontology_enforcement`` (``strict`` | ``permissive``)
decides whether a violation rejects the write or is returned as a warning. The PR
re-validation gate reuses the same check at publish.

Two validation tiers live here:

* :class:`Ontology` / :func:`validate_entities` — the inline-spec fallback:
  bare type-name set membership against ``graph.ontology_spec``.
* :class:`OntologyRules` / :func:`validate_entities_rich` — the rich commit-
  boundary gate: entity types must be defined, edge source/target entity-type
  compatibility, and containment ``can_contain`` rules. The rules object is
  resolved from the management ontology at the API layer and **injected** (this
  package never imports the management DB — same decoupling as the projector's
  ``target_resolver``). Semantics mirror ``backend/app/ontology/
  mutation_validator.py`` so the interactive pre-write checks and the durable
  commit gate agree: empty ``can_contain``/``source_types``/``target_types``
  = unrestricted; type names match case-insensitively; deletes always pass;
  only CREATES are gated (legacy dirty data must not block property edits).
* :class:`FieldRule` / :func:`field_violations` — the publish gate on property
  values: a field's type, its allowed values, and whether it is required. Like
  ``unique_fields`` it is judged at publish, never while a draft is written, and
  only on the values the publish changes; :class:`FieldFindings` keeps what it
  refuses, page after page.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .import_export.contract import _FIELD_SCHEMA

Entity =Tuple[str, str, Optional[Mapping]]   # (entity_id, kind, payload)
RichEntity = Tuple[str, str, Optional[Mapping], str]   # (entity_id, kind, payload, op)


class Ontology:
    def __init__(self, entity_types: Optional[Set[str]] = None, edge_types: Optional[Set[str]] = None):
        self.entity_types = entity_types
        self.edge_types = edge_types

    @classmethod
    def from_spec(cls, spec: Optional[Mapping]) -> Optional["Ontology"]:
        if not spec:
            return None
        et = set(spec.get("entity_types") or spec.get("entityTypes") or []) or None
        edt = set(spec.get("edge_types") or spec.get("edgeTypes") or []) or None
        if et is None and edt is None:
            return None
        return cls(entity_types=et, edge_types=edt)


@dataclass(frozen=True)
class FieldRule:
    """A field an entity type defines, as a publish judges the property it is stored as: of its
    ``type``, one of ``allowed`` (empty: any value), and — ``required`` — held by every entity of
    the type. ``name`` is how a refusal names it."""
    type: str = "text"
    required: bool = False
    allowed: Tuple[str, ...] = ()
    name: str = ""


@dataclass(frozen=True)
class EntityRule:
    """Per-entity-type rules. Empty ``can_contain`` = may contain anything. ``unique_fields``:
    the fields no two live nodes of the type may share a value of (checked at publish).
    ``fields``: property key → the :class:`FieldRule` a publish holds its values to."""
    can_contain: FrozenSet[str] = frozenset()
    unique_fields: FrozenSet[str] = frozenset()
    fields: Mapping[str, FieldRule] = field(default_factory=dict)


@dataclass(frozen=True)
class EdgeRule:
    """Per-edge-type rules. Empty ``source_types``/``target_types`` = unrestricted. ``fields``:
    property key → the :class:`FieldRule` a publish holds the relationship's values to, as an
    entity type's."""
    source_types: FrozenSet[str] = frozenset()
    target_types: FrozenSet[str] = frozenset()
    is_containment: bool = False
    fields: Mapping[str, FieldRule] = field(default_factory=dict)


@dataclass(frozen=True)
class OntologyRules:
    """Rich, injected ontology rules (see module docstring). ``entity_types`` is
    keyed by canonical type name; ``edge_types`` by UPPERCASED relationship name
    (parity with ``mutation_validator``'s case-insensitive edge lookup)."""
    entity_types: Mapping[str, EntityRule] = field(default_factory=dict)
    edge_types: Mapping[str, EdgeRule] = field(default_factory=dict)
    containment_edge_types: FrozenSet[str] = frozenset()
    # UPPERCASED(edge-type id) → the ontology's exact declared casing. ``edge_types``
    # and ``containment_edge_types`` are keyed UPPERCASE (the case-insensitive lookup
    # contract), which loses the declared casing; this restores it so canonicalization
    # rewrites to what the ontology (and the FalkorDB projection) actually use.
    edge_type_canonical: Mapping[str, str] = field(default_factory=dict)
    # Entity types allowed at the TOP level (with no containment parent). Empty = unconstrained;
    # otherwise any other type must sit inside a parent (see GraphVersioningService._enforce_written).
    root_entity_types: FrozenSet[str] = frozenset()

    def is_root_type(self, name: Optional[str]) -> bool:
        """Whether an entity of this type may be at the top level (case-insensitive)."""
        if not self.root_entity_types:
            return True
        return bool(name) and str(name).upper() in {t.upper() for t in self.root_entity_types}

    def canonical_entity_type(self, name: Optional[str]) -> Optional[str]:
        """Exact match, else case-insensitive; ``None`` if the type is unknown."""
        if not name:
            return None
        if name in self.entity_types:
            return name
        upper = name.upper()
        for k in self.entity_types:
            if k.upper() == upper:
                return k
        return None

    def canonical_edge_type(self, name: Optional[str]) -> Optional[str]:
        """Declared casing for an edge/relationship type matched case-insensitively
        against the ontology (relationship ids + containment/lineage lists); ``None``
        if unknown. The edge-dimension parity of :meth:`canonical_entity_type`.

        Falls back to the UPPERCASE form when the declared-casing map is absent (an
        ``OntologyRules`` built without it), which still normalizes a case variant to a
        single canonical spelling."""
        if not name:
            return None
        upper = str(name).upper()
        declared = self.edge_type_canonical.get(upper)
        if declared is not None:
            return declared
        if upper in self.edge_types:
            return upper
        if upper in self.containment_edge_types:
            return upper
        return None


def canonicalize_payload_types(payload: Optional[Mapping], rules: Optional[OntologyRules]) -> None:
    """Rewrite a payload's ``entityType``/``edgeType`` to the ontology's exact declared
    casing in place, when they match a declared type case-insensitively.

    USER MANDATE (2026-07-06): a case variant of a declared type (``Has``/``HAS``/``has``)
    must NEVER be a violation — normalize it. FalkorDB matches relationship types
    case-sensitively, so a lowercase ``has`` projects as ``:has`` and misses the
    ``:HAS`` containment predicate, flattening the hierarchy; rewriting the payload at
    the commit boundary keeps the durable payload — and therefore the projection —
    canonical. Idempotent; leaves unknown or missing types untouched (the rich gate
    decides those). No-op when ``rules`` is ``None`` or ``payload`` is not a ``dict``."""
    if rules is None or not isinstance(payload, dict):
        return
    et = payload.get("entityType")
    if et:
        canon = rules.canonical_entity_type(et)
        if canon and canon != et:
            payload["entityType"] = canon
    edt = payload.get("edgeType")
    if edt:
        canon = rules.canonical_edge_type(edt)
        if canon and canon != edt:
            payload["edgeType"] = canon


def _rich_edge_src_tgt(payload: Mapping) -> Tuple[Optional[str], Optional[str]]:
    src = payload.get("sourceEntityId") or payload.get("source_entity_id")
    tgt = payload.get("targetEntityId") or payload.get("target_entity_id")
    return src, tgt


def validate_entities_rich(
    entities: Sequence[RichEntity],
    endpoint_types: Mapping[str, str],
    rules: Optional[OntologyRules],
) -> List[dict]:
    """Rich commit-boundary validation (see module docstring). Returns
    ``[{entity_id, kind, reason, rule}]`` — a superset of the legacy violation
    shape, so every existing consumer of ``OntologyViolation.violations`` keeps
    working. ``endpoint_types`` maps entity_id → entityType for edge endpoints
    (an endpoint absent from the map skips that edge's type-compatibility checks
    — the caller couldn't resolve it, a later gate will).

    Only ``create`` ops are gated; ``update``/``delete`` always pass (an update
    can't change an entity's type — patch semantics — and legacy data that
    predates the ontology must not block edits or deletes).
    """
    if rules is None:
        return []
    out: List[dict] = []
    for eid, kind, payload, op in entities:
        if op != "create" or payload is None:
            continue
        if kind == "node":
            et = payload.get("entityType")
            if rules.entity_types and rules.canonical_entity_type(et) is None:
                out.append({
                    "entity_id": eid, "kind": "node", "rule": "unknown_entity_type",
                    "reason": f"Entity type '{et}' is not defined in the active ontology. "
                              f"Known types: {sorted(rules.entity_types)}",
                })
        elif kind == "edge":
            edt = str(payload.get("edgeType") or payload.get("edge_type") or "").strip()
            if not edt:
                # A create with no edgeType can't be typed against a declared schema — reject it
                # with a clear, actionable reason (distinct from an unknown type). Unconstrained
                # schemas (no declared edge types) leave it open, as before.
                if rules.edge_types:
                    out.append({
                        "entity_id": eid, "kind": "edge", "rule": "missing_edge_type",
                        "reason": "Edge is missing edgeType — expected one of "
                                  f"{sorted(rules.edge_types)}.",
                    })
                continue
            edt_upper = edt.upper()
            rule = rules.edge_types.get(edt_upper)
            if rules.edge_types and rule is None:
                out.append({
                    "entity_id": eid, "kind": "edge", "rule": "unknown_edge_type",
                    "reason": f"Relationship type '{edt}' is not defined in the active ontology. "
                              f"Known types: {sorted(rules.edge_types)}",
                })
                continue
            if rule is None:
                continue
            src, tgt = _rich_edge_src_tgt(payload)
            src_type = endpoint_types.get(src) if src else None
            tgt_type = endpoint_types.get(tgt) if tgt else None
            if src_type is not None and rule.source_types and not _type_in(src_type, rule.source_types):
                out.append({
                    "entity_id": eid, "kind": "edge", "rule": "invalid_source",
                    "reason": f"'{src_type}' is not a valid source for relationship '{edt}'. "
                              f"Allowed sources: {sorted(rule.source_types)}",
                })
            if tgt_type is not None and rule.target_types and not _type_in(tgt_type, rule.target_types):
                out.append({
                    "entity_id": eid, "kind": "edge", "rule": "invalid_target",
                    "reason": f"'{tgt_type}' is not a valid target for relationship '{edt}'. "
                              f"Allowed targets: {sorted(rule.target_types)}",
                })
            # Containment: the parent's (source's) can_contain must allow the child type.
            if (rule.is_containment or edt_upper in rules.containment_edge_types) \
                    and src_type is not None and tgt_type is not None:
                canonical_parent = rules.canonical_entity_type(src_type)
                parent_rule = rules.entity_types.get(canonical_parent) if canonical_parent else None
                if parent_rule is not None and parent_rule.can_contain \
                        and not _type_in(tgt_type, parent_rule.can_contain):
                    out.append({
                        "entity_id": eid, "kind": "edge", "rule": "containment_not_allowed",
                        "reason": f"Ontology does not allow '{src_type}' to contain '{tgt_type}'. "
                                  f"Allowed children: {sorted(parent_rule.can_contain)}",
                    })
    return out


def _type_in(name: str, allowed: FrozenSet[str]) -> bool:
    """Case-insensitive membership (parity with mutation_validator's lookups)."""
    if name in allowed:
        return True
    upper = name.upper()
    return any(a.upper() == upper for a in allowed)


def validate_entities(entities: Sequence[Entity], ontology: Optional[Ontology]) -> List[dict]:
    """Return ``[{entity_id, kind, reason}]`` for entities that violate the
    ontology. Empty list = valid (or no ontology). Only constrained dimensions
    are checked; deletes (``payload is None``) are skipped."""
    if ontology is None:
        return []
    out: List[dict] = []
    for eid, kind, payload in entities:
        if payload is None:
            continue
        if kind == "node" and ontology.entity_types is not None:
            et = payload.get("entityType")
            if et not in ontology.entity_types:
                out.append({"entity_id": eid, "kind": "entity_type",
                            "reason": f"entityType {et!r} not allowed by ontology"})
        elif kind == "edge" and ontology.edge_types is not None:
            edt = payload.get("edgeType")
            if edt not in ontology.edge_types:
                out.append({"entity_id": eid, "kind": "edge_type",
                            "reason": f"edgeType {edt!r} not allowed by ontology"})
    return out


# --------------------------------------------------------------------------- #
# Field rules: a property's type, its allowed values, whether it is required  #
# --------------------------------------------------------------------------- #
#: The field types a value is judged by — those the import contract gives a JSON kind of its own
#: (``_FIELD_SCHEMA``). Any other type (text, markdown, a urn, a status, a user …) takes any value,
#: as an import's text does; ``json`` takes anything.
JUDGED_TYPES = frozenset(t for t, spec in _FIELD_SCHEMA.items() if spec)
_URI = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://\S+$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SHOWN_CHARS = 200
_ALLOWED_NAMED = 10
_TYPE_WORDS = {"number": "a number", "progress": "a number", "boolean": "true or false",
               "date": "a date (YYYY-MM-DD)", "datetime": "a date and time (ISO 8601)",
               "url": "a web address", "email": "an email address", "tags": "a list of tags"}


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == []


def value_text(value: Any) -> Optional[str]:
    """A scalar as an allowed value names it: its text, trimmed; a boolean ``true``/``false``; a
    whole decimal as its integer (``2.0`` is ``2``). ``None`` for no value, a list or a group."""
    if value is None or isinstance(value, (dict, list)):
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    return text or None


def _number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    try:
        return math.isfinite(float(str(value).replace(",", "").strip()))
    except ValueError:
        return False


def _iso(value: Any, with_time: bool) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    try:
        date.fromisoformat(text[:10])
        if len(text) == 10:
            return True
        datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
        return with_time
    except ValueError:
        return False


def _of_type(field_type: str, value: Any) -> bool:
    """Whether a value reads as the field's type. Lenient where the data is: a number or a boolean
    stored as its text (a CSV import's ``"42"``, ``"true"``) is one; a date-time field takes a bare
    date; tags take a list of scalars, or one text (an import's comma-separated cell)."""
    spec = _FIELD_SCHEMA.get(field_type.lower()) or {}
    kind, fmt = spec.get("type"), spec.get("format")
    if kind == "number":
        return _number(value)
    if kind == "boolean":
        return isinstance(value, bool) or (isinstance(value, str) and value.strip().lower() in ("true", "false"))
    if kind == "array":
        return isinstance(value, str) or (
            isinstance(value, list) and all(not isinstance(v, (dict, list)) for v in value))
    if fmt == "date":
        return _iso(value, with_time=False)
    if fmt == "date-time":
        return _iso(value, with_time=True)
    if fmt == "uri":
        return isinstance(value, str) and bool(_URI.match(value.strip()))
    if fmt == "email":
        return isinstance(value, str) and bool(_EMAIL.match(value.strip()))
    return True


def _shown(value: Any) -> Any:
    """A value as a refusal quotes it: a long text, list or group cut short (as text)."""
    if isinstance(value, str):
        return value if len(value) <= _SHOWN_CHARS else value[:_SHOWN_CHARS] + "…"
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, default=str)
        return value if len(text) <= _SHOWN_CHARS else text[:_SHOWN_CHARS] + "…"
    return value


def _quoted(value: Any) -> str:
    shown = _shown(value)
    return f"'{shown if isinstance(shown, str) else json.dumps(shown, ensure_ascii=False, default=str)}'"


def allowed_phrase(allowed: Sequence[str]) -> str:
    """The allowed values as a refusal lists them: the first few, and how many more."""
    named = ", ".join(f"'{a}'" for a in allowed[:_ALLOWED_NAMED])
    more = len(allowed) - _ALLOWED_NAMED
    return named + (f" (or {more} more)" if more > 0 else "")


def field_value_problem(rule: FieldRule, value: Any) -> Optional[Tuple[str, str]]:
    """Why a value breaks the field — ``(rule, reason)``, ``rule`` ``field_type`` or
    ``field_not_allowed`` — or ``None``. An empty value is no value (``required`` judges that). A
    list (tags) is allowed when each of its items is; so is an import's comma-separated text."""
    if _empty(value):
        return None
    label = rule.name or "This field"
    ftype = (rule.type or "text").lower()
    if ftype in JUDGED_TYPES and not _of_type(ftype, value):
        return "field_type", f"{label} should be {_TYPE_WORDS.get(ftype, ftype)} — {_quoted(value)} isn't."
    if rule.allowed:
        items = value if isinstance(value, list) else (
            [v for v in value.split(",") if v.strip()] if ftype == "tags" and isinstance(value, str) else [value])
        bad = next((v for v in items if value_text(v) not in rule.allowed), None)
        if bad is not None:
            return "field_not_allowed", (f"{label} must be one of {allowed_phrase(rule.allowed)} — "
                                         f"{_quoted(bad)} isn't.")
    return None


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def _is_edge(payload: Mapping) -> bool:
    """An edge's payload names both its ends; a node's names neither."""
    return (("sourceEntityId" in payload or "source_entity_id" in payload)
            and ("targetEntityId" in payload or "target_entity_id" in payload))


def _type_of(payload: Mapping, edge: bool, rules: OntologyRules) -> Optional[str]:
    """The payload's type as the ontology spells it — ``None`` when the ontology has no such type."""
    if edge:
        return rules.canonical_edge_type(payload.get("edgeType") or payload.get("edge_type"))
    return rules.canonical_entity_type(payload.get("entityType"))


def field_violations(entities: Iterable[Tuple[str, Optional[Mapping], Optional[Mapping]]],
                     rules: Optional[OntologyRules]) -> List[dict]:
    """What a publish refuses by the field rules (``EntityRule.fields``, ``EdgeRule.fields``). For
    each entity ``(entity_id, value written, value on main before — None for a new one)``: a
    property given a value its field refuses (not of its type, or not one of its allowed values),
    and a required field left without a value. A relationship's properties are read where it keeps
    them: nested, or — an old one — at the top of its payload.

    Only what the publish CHANGES is judged, so data that predates a rule stays publishable: a new
    entity — or one whose type changes — on every field of its type; any other on the fields whose
    value it changes (a required one emptied or removed included). Deletes pass.
    ``[{entity_id, kind, type, name, urn, rule, field, fieldName, value, reason}]``, ``kind``
    ``node`` or ``edge`` — a relationship, which has no name or urn, adds its ends (``source``,
    ``target``) — and ``rule`` one of ``field_type``, ``field_not_allowed`` and ``field_required``."""
    if rules is None:
        return []
    from .entity_serde import _split_endpoints_props
    out: List[dict] = []
    for eid, after, before in entities:
        if not after:
            continue
        edge = _is_edge(after)
        etype = _type_of(after, edge, rules)
        rule = (rules.edge_types.get(etype.upper()) if edge else rules.entity_types.get(etype)) if etype else None
        if rule is None or not rule.fields:
            continue
        if before is not None and (_is_edge(before) != edge or _type_of(before, edge, rules) != etype):
            before = None
        if edge:
            src, tgt, _confidence, props = _split_endpoints_props(after)
            was = _split_endpoints_props(before)[3] if before is not None else {}
        else:
            props = after.get("properties") or {}
            was = (before.get("properties") or {}) if before is not None else {}
        what = f"{etype} relationship" if edge else etype
        for key, f in sorted(rule.fields.items()):
            value = props.get(key)
            if before is not None and (key in props) == (key in was) and _same(value, was.get(key)):
                continue
            found: Optional[Tuple[str, str]] = None
            if _empty(value):
                if f.required and (before is None or not _empty(was.get(key))):
                    found = "field_required", (
                        f"{f.name or key} is required for a new {what}." if before is None
                        else f"{f.name or key} is required on {what}{'s' if edge else ''} — it can't be emptied "
                             "or removed.")
            else:
                found = field_value_problem(f, value)
            if found:
                v = {"entity_id": eid, "kind": "edge" if edge else "node", "type": etype,
                     "name": None if edge else after.get("displayName"), "urn": None if edge else after.get("urn"),
                     "rule": found[0], "field": key, "fieldName": f.name or key,
                     "value": _shown(value), "reason": found[1]}
                if edge:
                    v.update(source=src, target=tgt)
                out.append(v)
    return out


#: The field violations a refused publish names; past them it counts.
FIELD_EXAMPLES = 100
#: The refused entities each per-field count names by id: as many as one bulk property job names
#: (``config.PROPERTY_JOB_MAX_IDS``), so one job can fix them all.
FIELD_IDS_MAX = 20_000


class FieldFindings:
    """What a publish's field checks found, page after page (:func:`field_violations`): the first
    ``FIELD_EXAMPLES`` violations, how many there are in all, and per entity or relationship type,
    field and rule how many and which (the first ``FIELD_IDS_MAX``) — so a publish of a million
    entities holds a hundred of them, and a bounded list of ids per field, never all."""

    def __init__(self) -> None:
        self.examples: List[dict] = []
        self.total = 0
        # (kind, type, field, rule) -> [name, n, ids]: an entity type and a relationship type may
        # share a name, and are counted apart.
        self._by: Dict[Tuple[str, str, str, str], List[Any]] = {}

    def add(self, found: Sequence[dict]) -> None:
        self.examples += found[:max(0, FIELD_EXAMPLES - len(self.examples))]
        self.total += len(found)
        for v in found:
            held = self._by.setdefault((v["kind"], v["type"], v["field"], v["rule"]),
                                       [v.get("fieldName") or v["field"], 0, []])
            held[1] += 1
            if len(held[2]) < FIELD_IDS_MAX:
                held[2].append(v["entity_id"] if v["kind"] == "edge" else f"gv:{v['entity_id']}")

    def __bool__(self) -> bool:
        return self.total > 0

    def by_field(self) -> List[dict]:
        """``[{entityKind, entityType, field, fieldName, rule, count, ids, idsComplete}]``, the most
        refused first. ``entityKind``: ``node``, ``entityType`` an entity type, or ``edge``, a
        relationship type. ``ids``: the refused entities as a bulk property job names them — a node
        as ``gv:<entity id>``, which reaches one new in the draft too, a relationship by its own id
        — at most ``FIELD_IDS_MAX``; ``idsComplete``: they are all of them."""
        return sorted(({"entityKind": k, "entityType": t, "field": f, "fieldName": name, "rule": r,
                        "count": n, "ids": list(ids), "idsComplete": len(ids) == n}
                       for (k, t, f, r), (name, n, ids) in self._by.items()),
                      key=lambda e: (-e["count"], e["entityType"], e["field"], e["rule"], e["entityKind"]))
