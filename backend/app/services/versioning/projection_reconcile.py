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
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple

#: The platform writes its rollups under exactly this type, and every count the verify
#: compares (``type(r) <> 'AGGREGATED'``) excludes exactly it. Matching it case-blind would
#: drop a customer's own ``aggregated`` edge type from the projection and fail the verify forever.
ROLLUP_EDGE_TYPE = "AGGREGATED"
from backend.common.providers.pair_rules import ancestor_closure, boundary_pairs, cube_pairs

#: A projected node's identity in FalkorDB: every node write MERGEs on (label, urn), so two
#: live entities sharing a urn under different types are two nodes, and a retype is a
#: different key — never just a urn.
NodeKey = Tuple[str, str]
#: A projected edge's identity: (source label, source urn, type, target label, target urn) —
#: the projector MERGEs one relationship per such tuple, label-anchored at both ends.
EdgeKey = Tuple[str, str, str, str, str]


#: Bump when the projector changes WHAT it writes for the same committed content (a new
#: derived field, a different searchable text): every fingerprint moves, so the next
#: reconcile rewrites every item once instead of leaving old-shape nodes behind forever.
PROJECTION_SHAPE = 1


def fingerprint(*parts: object) -> int:
    """A stable signed 64-bit digest of what the projector writes for one item — built
    from Postgres's own content hash of the payload, never the payload itself, so a
    reconcile fingerprints millions of rows without serialising any of them. An int64
    costs FalkorDB 8 bytes per item, not a string."""
    blob = "\x1f".join(str(p) for p in (PROJECTION_SHAPE, *parts))
    return int.from_bytes(hashlib.sha1(blob.encode("utf-8")).digest()[:8], "big", signed=True)


@dataclass(frozen=True)
class ExpectedNode:
    entity_id: str
    ref: object          # how to fetch the payload, only if this node must be written
    fp: int


@dataclass(frozen=True)
class ExpectedEdge:
    entity_id: str
    ref: object
    fp: int


@dataclass(frozen=True)
class ActualNode:
    fp: Optional[int]


@dataclass(frozen=True)
class ActualEdge:
    fp: Optional[int]


@dataclass
class ProjectionDiff:
    node_upserts: List[NodeKey] = field(default_factory=list)
    node_deletes: List[NodeKey] = field(default_factory=list)
    #: (urn, stored label, new label) — relabelled IN PLACE: the node keeps its id, its
    #: edges and the rollup cells on it (a delete-and-recreate took them all).
    relabels: List[Tuple[str, str, str]] = field(default_factory=list)
    edge_upserts: List[EdgeKey] = field(default_factory=list)
    edge_deletes: List[EdgeKey] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.node_upserts or self.node_deletes or self.relabels
                    or self.edge_upserts or self.edge_deletes)

    @property
    def writes(self) -> int:
        return (len(self.node_upserts) + len(self.node_deletes) + len(self.relabels)
                + len(self.edge_upserts) + len(self.edge_deletes))


def diff_projection(
    expected_nodes: Mapping[NodeKey, ExpectedNode],
    expected_edges: Mapping[EdgeKey, ExpectedEdge],
    actual_nodes: Mapping[NodeKey, ActualNode],
    actual_edges: Mapping[EdgeKey, ActualEdge],
) -> ProjectionDiff:
    """The writes that make FalkorDB hold exactly what Postgres says.

    A urn stored under exactly one label that Postgres no longer has, and expected under
    exactly one label FalkorDB does not have, is a retype: relabelled in place, then
    rewritten (its fingerprint covers the label). Stored edges are compared as they will
    read AFTER those relabels, so an edge that survives a retype is left alone. An extra
    edge whose endpoint is being deleted needs no write of its own (the DETACH takes it).
    """
    d = ProjectionDiff()
    missing: Dict[str, List[str]] = {}
    extra: Dict[str, List[str]] = {}
    for label, urn in expected_nodes:
        if (label, urn) not in actual_nodes:
            missing.setdefault(urn, []).append(label)
    for label, urn in actual_nodes:
        if (label, urn) not in expected_nodes:
            extra.setdefault(urn, []).append(label)
    relabel_to: Dict[NodeKey, str] = {}
    for urn, labels in missing.items():
        if len(labels) == 1 and len(extra.get(urn, ())) == 1:
            old, new = extra[urn][0], labels[0]
            d.relabels.append((urn, old, new))
            relabel_to[(old, urn)] = new
    for key, e in expected_nodes.items():
        a = actual_nodes.get(key)
        if a is None or a.fp != e.fp:
            d.node_upserts.append(key)
    for key in actual_nodes:
        if key not in expected_nodes and key not in relabel_to:
            d.node_deletes.append(key)
    detached = set(d.node_deletes)

    def after_relabel(label: str, urn: str) -> str:
        return relabel_to.get((label, urn), label)

    stored: Dict[EdgeKey, ActualEdge] = {}
    for (sl, su, rel, tl, tu), a in actual_edges.items():
        if (sl, su) in detached or (tl, tu) in detached:
            continue                                     # goes with its endpoint
        stored[(after_relabel(sl, su), su, rel, after_relabel(tl, tu), tu)] = a
    for key, e in expected_edges.items():
        a = stored.get(key)
        if a is None or a.fp != e.fp:
            d.edge_upserts.append(key)
    for key in stored:
        if key not in expected_edges:
            d.edge_deletes.append(key)
    return d


@dataclass
class RollupPlan:
    #: (source urn, target urn) → {"dw", "dwc", "types", "sd", "td"[, "sl", "tl"]};
    #: None when the work was handed to the batch job.
    pairs: Optional[Dict[Tuple[str, str], Dict[str, object]]]
    stale: bool
    contributions: int


UrnTriple = Tuple[str, str, str]      # (source urn, type, target urn) — what rollups are keyed on


def urn_triples(keys: Iterable[EdgeKey]) -> Set[UrnTriple]:
    return {(su, rel, tu) for _sl, su, rel, _tl, tu in keys}


def _containment_parents(keys: Iterable[UrnTriple], cont_types: Set[str]) -> Dict[str, List[str]]:
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
    key: UrnTriple,
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
    expected_keys: Iterable[UrnTriple],
    actual_keys: Iterable[UrnTriple],
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
    expected = {k for k in expected_keys if k[1] != ROLLUP_EDGE_TYPE}
    actual = {k for k in actual_keys if k[1] != ROLLUP_EDGE_TYPE}

    upper_of: Dict[str, str] = {}

    def upper(rel: str) -> str:                          # a handful of distinct types
        u = upper_of.get(rel)
        if u is None:
            u = upper_of[rel] = rel.upper()
        return u

    def lineage(keys: Set[UrnTriple]) -> Set[UrnTriple]:
        return {k for k in keys if upper(k[1]) in lineage_types}

    lin_e, lin_a = lineage(expected), lineage(actual)
    added, removed = lin_e - lin_a, lin_a - lin_e

    def containment(keys: Set[UrnTriple]) -> Set[UrnTriple]:
        return {k for k in keys if upper(k[1]) in cont_types}

    cont_e, cont_a = containment(expected), containment(actual)
    par_e = _containment_parents(cont_e, cont_types)
    par_a = _containment_parents(cont_a, cont_types)
    if cont_e == cont_a:
        moved: Set[str] = set()                          # the common case: nothing re-parented
    else:
        moved = {
            n for n in {k[2] for k in cont_e ^ cont_a}
            if set(par_e.get(n, ())) != set(par_a.get(n, ()))
        }
    if not (added or removed or moved):
        return RollupPlan(pairs={}, stale=False, contributions=0)
    affected = moved | _descendants(_children_of(par_e), moved) | _descendants(_children_of(par_a), moved) \
        if moved else set()
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
