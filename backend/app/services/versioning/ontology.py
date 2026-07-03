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
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Mapping, Optional, Sequence, Set, Tuple

Entity = Tuple[str, str, Optional[Mapping]]   # (entity_id, kind, payload)
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
class EntityRule:
    """Per-entity-type rules. Empty ``can_contain`` = may contain anything."""
    can_contain: FrozenSet[str] = frozenset()


@dataclass(frozen=True)
class EdgeRule:
    """Per-edge-type rules. Empty ``source_types``/``target_types`` = unrestricted."""
    source_types: FrozenSet[str] = frozenset()
    target_types: FrozenSet[str] = frozenset()
    is_containment: bool = False


@dataclass(frozen=True)
class OntologyRules:
    """Rich, injected ontology rules (see module docstring). ``entity_types`` is
    keyed by canonical type name; ``edge_types`` by UPPERCASED relationship name
    (parity with ``mutation_validator``'s case-insensitive edge lookup)."""
    entity_types: Mapping[str, EntityRule] = field(default_factory=dict)
    edge_types: Mapping[str, EdgeRule] = field(default_factory=dict)
    containment_edge_types: FrozenSet[str] = frozenset()

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
            edt = str(payload.get("edgeType") or payload.get("edge_type") or "")
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
