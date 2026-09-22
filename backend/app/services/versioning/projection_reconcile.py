"""In-place reconcile of a versioned graph's FalkorDB projection.

A heal or an explicit rebuild used to ``GRAPH.DELETE`` the projection and
replay committed main into the empty key. Three things went with the key:

* **Every id.** FalkorDB numbers labels, relationship types and property keys
  in the order they are first written, and falkordb-py decodes results through
  a per-connection copy of those tables that it refreshes only when an id is
  out of range. A rebuild that registers names in a different order leaves
  every long-lived connection decoding with the neighbour's name — the
  incident where every Domain rendered as "Schema Field".
* **Every index.** The provider's ensured-indexes memo outlives the graph.
* **Every ``:AGGREGATED`` rollup**, until a full aggregation job re-derived
  them from scratch.

The reconcile keeps the graph. It diffs what FalkorDB holds against what
Postgres (the system of record) says it should hold and writes only the
difference, then adjusts the rollups by exactly that difference with the same
pair rules a publish uses. This module is the pure part: the raw diff and the
rollup arithmetic. The projector does the I/O.

ROLLUP ARITHMETIC. The stored rollups are a function of FalkorDB's raw state —
every publish keeps them so, by delta. So the reconcile moves them from
f(actual) to f(expected), touching only what the raw difference touches:

* a lineage edge only FalkorDB has → -1 over its pairs as FalkorDB's own
  containment places it (that is what the stored rollups counted);
* a lineage edge only Postgres has → +1 as Postgres places it;
* a lineage edge both have, whose endpoint's containment closure differs
  between the two → -1 the old placement, +1 the new one.

Closures are computed from the two complete edge sets the reconcile already
holds, so planning needs no further reads. Past ``cap`` contributions the
work is handed to the aggregation batch job — which also writes only the
difference — rather than stalling the projector.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from backend.common.derived_artifacts import is_derived_edge_type
from backend.common.providers.pair_rules import ancestor_closure, boundary_pairs, cube_pairs

#: (source urn, relationship type as projected, target urn) — the projector
#: MERGEs one relationship per such triple, so it is the edge's identity in
#: FalkorDB.
EdgeKey = Tuple[str, str, str]


def fingerprint(obj: object) -> str:
    """A short, stable digest of what the projector writes for one item."""
    blob = json.dumps(obj, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class ExpectedNode:
    entity_id: str
    label: str
    payload: dict
    fp: str


@dataclass(frozen=True)
class ExpectedEdge:
    entity_id: str
    payload: dict
    fp: str


@dataclass(frozen=True)
class ActualNode:
    label: str
    fp: Optional[str]


@dataclass(frozen=True)
class ActualEdge:
    fp: Optional[str]


@dataclass
class ProjectionDiff:
    node_upserts: List[str] = field(default_factory=list)          # urns
    node_deletes: List[Tuple[str, str]] = field(default_factory=list)  # (urn, label as stored)
    edge_upserts: List[EdgeKey] = field(default_factory=list)
    edge_deletes: List[EdgeKey] = field(default_factory=list)
    relabelled: Set[str] = field(default_factory=set)

    @property
    def empty(self) -> bool:
        return not (self.node_upserts or self.node_deletes or self.edge_upserts or self.edge_deletes)

    @property
    def writes(self) -> int:
        return (len(self.node_upserts) + len(self.node_deletes)
                + len(self.edge_upserts) + len(self.edge_deletes))


def diff_projection(
    expected_nodes: Mapping[str, ExpectedNode],
    expected_edges: Mapping[EdgeKey, ExpectedEdge],
    actual_nodes: Mapping[str, ActualNode],
    actual_edges: Mapping[EdgeKey, ActualEdge],
) -> ProjectionDiff:
    """The writes that make FalkorDB hold exactly what Postgres says.

    A node whose type changed is deleted under its stored label and written
    under the new one: nodes are merged on (label, urn), so merging under the
    new label alone would leave a duplicate behind. Its edges go with the
    DETACH, so they are written again; an extra edge whose endpoint is being
    deleted needs no write of its own for the same reason.
    """
    d = ProjectionDiff()
    d.relabelled = {
        u for u, e in expected_nodes.items()
        if u in actual_nodes and actual_nodes[u].label != e.label
    }
    for u, e in expected_nodes.items():
        a = actual_nodes.get(u)
        if a is None or u in d.relabelled or a.fp != e.fp:
            d.node_upserts.append(u)
    for u, a in actual_nodes.items():
        if u not in expected_nodes or u in d.relabelled:
            d.node_deletes.append((u, a.label))
    detached = {u for u, _ in d.node_deletes}
    for k, e in expected_edges.items():
        a = actual_edges.get(k)
        if a is None or a.fp != e.fp or k[0] in detached or k[2] in detached:
            d.edge_upserts.append(k)
    for k in actual_edges:
        if k not in expected_edges and k[0] not in detached and k[2] not in detached:
            d.edge_deletes.append(k)
    return d


@dataclass
class RollupPlan:
    #: (source urn, target urn) → {"dw", "dwc", "types", "sd", "td"[, "sl", "tl"]};
    #: None when the work was handed to the batch job.
    pairs: Optional[Dict[Tuple[str, str], Dict[str, object]]]
    stale: bool
    contributions: int


def _containment_parents(keys: Iterable[EdgeKey], cont_types: Set[str]) -> Dict[str, List[str]]:
    parents: Dict[str, List[str]] = {}
    for s, t, c in keys:
        if t.upper() in cont_types:
            ps = parents.setdefault(c, [])
            if s not in ps:
                ps.append(s)
    return parents


def _children_of(parents: Mapping[str, List[str]]) -> Dict[str, List[str]]:
    children: Dict[str, List[str]] = {}
    for c, ps in parents.items():
        for p in ps:
            children.setdefault(p, []).append(c)
    return children


def _local_chain(parents: Mapping[str, List[str]], node: str) -> Dict[str, List[str]]:
    """child → parents for ``node``'s ancestry only — the shape the
    projector's ``_containment_ancestors`` returns, so the canonical rule's
    "is a parent within this chain" test means what it means there."""
    local: Dict[str, List[str]] = {}
    stack, seen = [node], {node}
    while stack:
        n = stack.pop()
        ps = parents.get(n)
        if not ps:
            continue
        local[n] = list(ps)
        for p in ps:
            if p not in seen:
                seen.add(p)
                stack.append(p)
    return local


def _descendants(children: Mapping[str, List[str]], roots: Iterable[str]) -> Set[str]:
    out: Set[str] = set()
    stack = list(roots)
    while stack:
        n = stack.pop()
        for c in children.get(n, ()):
            if c not in out:
                out.add(c)
                stack.append(c)
    return out


def _contribute(
    pairs: Dict[Tuple[str, str], Dict[str, object]],
    key: EdgeKey,
    sign: int,
    parents: Mapping[str, List[str]],
    *,
    canonical: bool,
    level_of: Callable[[str], Optional[int]],
) -> None:
    """One raw lineage edge's contribution to both pair sets — the same rules
    as ``FalkorProjector._compute_rollup_deltas.contribute`` and the batch
    pipeline: ``dw`` over the full ancestor cross-product (cube regime),
    ``dwc`` over the canonical depth-bridged subset (boundary regime)."""
    src, rel, tgt = key
    et = rel.upper()
    cp_s, cp_t = _local_chain(parents, src), _local_chain(parents, tgt)
    if not canonical:
        for sx in ancestor_closure(cp_s, src):
            for tx in ancestor_closure(cp_t, tgt):
                if sx == tx:
                    continue
                e = pairs.setdefault((sx, tx), {"dw": 0, "types": set()})
                e["dw"] += sign
                if sign > 0:
                    e["types"].add(et)
        return
    s_cl = ancestor_closure(cp_s, src)
    t_cl = ancestor_closure(cp_t, tgt)
    s_parents = {p for ps in cp_s.values() for p in ps}
    t_parents = {p for ps in cp_t.values() for p in ps}
    canon = boundary_pairs(
        {a: d for a, d in s_cl.items() if a in s_parents},
        {a: d for a, d in t_cl.items() if a in t_parents},
    )
    depths = {**t_cl, **s_cl}
    for sx, tx in cube_pairs(s_cl, t_cl, include_leaf_mirror=False, s=src, t=tgt):
        e = pairs.setdefault((sx, tx), {"dw": 0, "dwc": 0, "types": set()})
        e["dw"] += sign
        if (sx, tx) in canon:
            e["dwc"] += sign
        sl, tl = level_of(sx), level_of(tx)
        if sl is not None and tl is not None:
            e["sl"], e["tl"] = sl, tl
        e["sd"], e["td"] = depths.get(sx), depths.get(tx)
        if sign > 0:
            e["types"].add(et)


def plan_rollup_deltas(
    expected_keys: Iterable[EdgeKey],
    actual_keys: Iterable[EdgeKey],
    *,
    lineage_types: Set[str],
    cont_types: Set[str],
    canonical: bool,
    cap: int,
    level_of: Callable[[str], Optional[int]],
) -> RollupPlan:
    """The rollup adjustments that move the stored rollups from what FalkorDB's
    raw edges imply to what Postgres's imply. See the module docstring."""
    lineage_types = {t.upper() for t in lineage_types}
    cont_types = {t.upper() for t in cont_types}
    expected = {k for k in expected_keys if not is_derived_edge_type(k[1])}
    actual = {k for k in actual_keys if not is_derived_edge_type(k[1])}

    def lineage(keys: Set[EdgeKey]) -> Set[EdgeKey]:
        return {k for k in keys if k[1].upper() in lineage_types}

    lin_e, lin_a = lineage(expected), lineage(actual)
    added, removed = lin_e - lin_a, lin_a - lin_e

    par_e = _containment_parents(expected, cont_types)
    par_a = _containment_parents(actual, cont_types)
    moved = {
        n for n in set(par_e) | set(par_a)
        if set(par_e.get(n, ())) != set(par_a.get(n, ()))
    }
    affected = moved | _descendants(_children_of(par_e), moved) | _descendants(_children_of(par_a), moved)
    recount = {k for k in lin_e & lin_a if k[0] in affected or k[2] in affected}

    contributions = len(added) + len(removed) + 2 * len(recount)
    if contributions > cap:
        return RollupPlan(pairs=None, stale=True, contributions=contributions)

    pairs: Dict[Tuple[str, str], Dict[str, object]] = {}
    for k in removed | recount:
        _contribute(pairs, k, -1, par_a, canonical=canonical, level_of=level_of)
    for k in added | recount:
        _contribute(pairs, k, +1, par_e, canonical=canonical, level_of=level_of)
    pairs = {k: v for k, v in pairs.items() if v["dw"] != 0 or v.get("dwc", 0) != 0}
    return RollupPlan(pairs=pairs, stale=False, contributions=contributions)
