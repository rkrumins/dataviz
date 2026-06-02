"""Ontology validation for staged/published entities (plan §3, §16.5 #6).

Opt-in per graph: a graph with no ``ontology_spec`` is unconstrained (any types).
When a spec is present it restricts the **constrained dimensions only** — set
``entity_types`` to restrict node types, ``edge_types`` to restrict edge types;
an unset dimension stays open. ``ontology_enforcement`` (``strict`` | ``permissive``)
decides whether a violation rejects the write or is returned as a warning. The PR
re-validation gate reuses the same check at publish.
"""
from __future__ import annotations

from typing import List, Mapping, Optional, Sequence, Set, Tuple

Entity = Tuple[str, str, Optional[Mapping]]   # (entity_id, kind, payload)


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
