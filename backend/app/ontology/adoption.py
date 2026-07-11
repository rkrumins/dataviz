"""Ontology adoption: how well a data source's PHYSICAL (profiled) graph matches the
ontology's DECLARED types.

Pure, side-effect-free (mirrors ``gate.py``). Every physical type is classified as:

- **exact** — physical id equals a declared id, same casing → correctly classified,
  hitting the FalkorDB per-label URN index.
- **case-drift** — matches a declared id case-insensitively but not exactly (physical
  ``has`` vs declared ``HAS``) → present but NOT hitting labels/indices; fix the casing.
- **unmapped** — matches no declared id → the ontology doesn't classify it.

"Match %" is the correctly-classified (exact) share, both instance-weighted (each type
weighted by its profiled count) and by-type (each distinct type = 1). Declared types not
present in the graph are surfaced separately as "unused" (informational).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Sequence


@dataclass
class TypeStat:
    id: str
    count: int


@dataclass
class DriftStat:
    id: str          # the physical spelling in the graph
    declared: str    # the declared spelling it should match
    count: int


@dataclass
class DimensionAdoption:
    """Adoption for one dimension (entity types OR relationship types)."""
    exact: List[TypeStat] = field(default_factory=list)
    case_drift: List[DriftStat] = field(default_factory=list)
    unmapped: List[TypeStat] = field(default_factory=list)
    declared_unused: List[str] = field(default_factory=list)
    match_weighted: float = 100.0
    match_by_type: float = 100.0
    total_types: int = 0
    total_instances: int = 0

    @property
    def exact_instances(self) -> int:
        return sum(e.count for e in self.exact)

    @property
    def drift_instances(self) -> int:
        return sum(x.count for x in self.case_drift)

    @property
    def unmapped_instances(self) -> int:
        return sum(u.count for u in self.unmapped)


@dataclass
class SourceAdoption:
    nodes: DimensionAdoption
    edges: DimensionAdoption
    match_weighted: float
    match_by_type: float


def _pct(part: float, whole: float) -> float:
    return round(part / whole * 100, 1) if whole else 100.0


def classify_dimension(
    declared: Iterable[str], physical: Sequence[Mapping[str, Any]]
) -> DimensionAdoption:
    """Classify each physical ``{id, count}`` against the declared type-id set."""
    declared_ids = list(dict.fromkeys(str(d) for d in declared))     # dedupe, keep order
    exact_set = set(declared_ids)
    lower_to_declared: Dict[str, str] = {}
    for d in declared_ids:
        lower_to_declared.setdefault(d.lower(), d)                   # first-seen declared casing wins

    exact: List[TypeStat] = []
    drift: List[DriftStat] = []
    unmapped: List[TypeStat] = []
    matched_declared_lower: set = set()
    total_instances = 0
    exact_instances = 0

    for p in physical:
        pid = str(p.get("id"))
        cnt = int(p.get("count", 0) or 0)
        total_instances += cnt
        low = pid.lower()
        if pid in exact_set:
            exact.append(TypeStat(pid, cnt))
            exact_instances += cnt
            matched_declared_lower.add(low)
        elif low in lower_to_declared:
            drift.append(DriftStat(pid, lower_to_declared[low], cnt))
            matched_declared_lower.add(low)
        else:
            unmapped.append(TypeStat(pid, cnt))

    total_types = len(physical)
    declared_unused = [d for d in declared_ids if d.lower() not in matched_declared_lower]

    return DimensionAdoption(
        exact=exact,
        case_drift=drift,
        unmapped=unmapped,
        declared_unused=declared_unused,
        match_weighted=_pct(exact_instances, total_instances),
        match_by_type=_pct(len(exact), total_types),
        total_types=total_types,
        total_instances=total_instances,
    )


def dimension_to_wire(d: DimensionAdoption) -> Dict[str, Any]:
    """camelCase JSON for the frontend."""
    return {
        "matchWeighted": d.match_weighted,
        "matchByType": d.match_by_type,
        "totalTypes": d.total_types,
        "totalInstances": d.total_instances,
        "exact": [{"id": e.id, "count": e.count} for e in d.exact],
        "caseDrift": [{"id": x.id, "declared": x.declared, "count": x.count} for x in d.case_drift],
        "unmapped": [{"id": u.id, "count": u.count} for u in d.unmapped],
        "declaredUnused": d.declared_unused,
    }


def build_source_adoption(
    *, entity_ids: Iterable[str], edge_ids: Iterable[str], schema_stats: Mapping[str, Any]
) -> SourceAdoption:
    """Adoption for one data source from its profiled ``schema_stats`` (camelCase,
    as persisted by the insights service)."""
    nodes = classify_dimension(entity_ids, schema_stats.get("entityTypeStats") or [])
    edges = classify_dimension(edge_ids, schema_stats.get("edgeTypeStats") or [])

    total = nodes.total_instances + edges.total_instances
    exact = nodes.exact_instances + edges.exact_instances
    total_types = nodes.total_types + edges.total_types
    exact_types = len(nodes.exact) + len(edges.exact)
    return SourceAdoption(
        nodes=nodes,
        edges=edges,
        match_weighted=_pct(exact, total),
        match_by_type=_pct(exact_types, total_types),
    )
