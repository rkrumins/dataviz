"""DAG-correct aggregation pair rules — the single semantic mirror.

Three writers materialize :AGGREGATED rollups and MUST agree on which
(source_ancestor, target_ancestor) pairs a raw lineage edge contributes
to: the batch pipeline (``falkordb_materialize``, int node ids), the
incremental write hooks (``on_lineage_edge_written/deleted``, URNs) and
the versioning projector (``services/versioning/projection``, URNs).
This module owns that rule so the three cannot drift.

Containment is a DAG, not a chain: a node may have MULTIPLE parents
(a column in a table that sits in two containers) and diamonds are
legal (two parents sharing a grandparent). The closure therefore has
SET semantics — every ancestor appears exactly once, no matter how many
containment paths reach it — which is the invariant that prevents a
raw edge from being double-counted into a shared grandparent.

Depth is CONTAINMENT depth from the root (roots = 0, child = 1 + max
over parents), never ontology type level: type levels are degenerate
for self-nesting types (``Node`` containing ``Node``) while structural
depth is well-defined on any graph.
"""
from __future__ import annotations

from bisect import bisect_right
from typing import Dict, Hashable, Iterator, Mapping, Optional, Sequence, Set, Tuple, TypeVar

K = TypeVar("K", bound=Hashable)


def ancestor_closure(
    parents: Mapping[K, Sequence[K]],
    node: K,
    memo: Optional[Dict[K, Dict[K, int]]] = None,
) -> Dict[K, int]:
    """Ancestors-OR-self of ``node`` → containment depth from the root.

    ``parents`` maps child → all of its parents (a DAG adjacency).
    depth(root) = 0; depth(n) = 1 + max(depth(p) for p in parents[n]).
    Self-parents and cycle-closing links are cut (visited-guard), so the
    walk terminates on dirty data; the cut mirrors the batch pipeline's
    defensive ``_break_cycles``.

    ``memo`` (node → closure) is shared across calls by the caller;
    entries are only written for nodes whose closure was FULLY computed
    outside any cycle cut, so memoized results are traversal-order
    independent.
    """
    if memo is not None:
        hit = memo.get(node)
        if hit is not None:
            return hit

    # Iterative post-order DFS (containment can be deeper than the
    # recursion limit on pathological data).
    on_stack: Set[K] = {node}
    tainted: Set[K] = set()  # closure computed under a cycle cut — do not memoize
    local: Dict[K, Dict[K, int]] = {}
    stack: list = [(node, iter(parents.get(node, ()) or ()))]
    order: list = []
    while stack:
        cur, it = stack[-1]
        advanced = False
        for p in it:
            if p == cur:
                continue  # self-parent: ignore
            if p in on_stack:
                tainted.add(cur)  # cycle cut under cur
                continue
            if p in local or (memo is not None and p in memo):
                continue  # already computed
            stack.append((p, iter(parents.get(p, ()) or ())))
            on_stack.add(p)
            advanced = True
            break
        if not advanced:
            stack.pop()
            on_stack.discard(cur)
            order.append(cur)
            closure: Dict[K, int] = {}
            depth = 0
            for p in parents.get(cur, ()) or ():
                if p == cur:
                    continue
                pcl = local.get(p)
                if pcl is None and memo is not None:
                    pcl = memo.get(p)
                if pcl is None:
                    continue  # cycle-cut link
                if p in tainted:
                    tainted.add(cur)
                for a, d in pcl.items():
                    if closure.get(a, -1) < d:
                        closure[a] = d
                if pcl[p] >= depth:
                    depth = pcl[p] + 1
            closure[cur] = depth
            local[cur] = closure
            if memo is not None and cur not in tainted:
                memo[cur] = closure
    return local[node]


def cube_pairs(
    s_closure: Mapping[K, int],
    t_closure: Mapping[K, int],
    *,
    include_leaf_mirror: bool,
    s: K,
    t: K,
) -> Iterator[Tuple[K, K]]:
    """Full ancestor cross-product for one raw lineage edge ``s -> t``.

    Yields every (ancestor_or_self_of_s, ancestor_or_self_of_t) pair
    exactly once (closures are sets), excluding equal endpoints and the
    raw ``(s, t)`` mirror unless ``include_leaf_mirror`` — the
    ``materialize_leaf_pairs`` knob's semantics in the batch pipeline.
    """
    for sp in s_closure:
        for tp in t_closure:
            if sp == tp:
                continue
            if not include_leaf_mirror and sp == s and tp == t:
                continue
            yield (sp, tp)


def boundary_pairs(
    s_reps: Mapping[K, int],
    t_reps: Mapping[K, int],
) -> Set[Tuple[K, K]]:
    """Canonical depth-diagonal selection, generalized to DAG reps.

    ``s_reps``/``t_reps`` are each endpoint's NON-LEAF ancestors-or-self
    with their containment depths (leaf endpoints pass the non-leaf
    subset of their closure). For every rank R present on either side,
    pair each side's reps at its deepest depth <= R — a SET per side,
    because multi-parent nodes have several reps sharing a depth.
    Pairs are deduped across ranks and equal endpoints are dropped.

    On single-parent chains each side has exactly one rep per depth, so
    this reduces to the legacy rule (one deepest rep per rank) —
    byte-for-byte, pinned by the golden tests.
    """
    if not s_reps or not t_reps:
        return set()

    def index(reps: Mapping[K, int]):
        by_depth: Dict[int, list] = {}
        for n, d in reps.items():
            by_depth.setdefault(d, []).append(n)
        return sorted(by_depth), by_depth

    s_depths, s_by_depth = index(s_reps)
    t_depths, t_by_depth = index(t_reps)
    out: Set[Tuple[K, K]] = set()
    for rank in set(s_depths) | set(t_depths):
        si = bisect_right(s_depths, rank) - 1
        ti = bisect_right(t_depths, rank) - 1
        if si < 0 or ti < 0:
            continue
        for sp in s_by_depth[s_depths[si]]:
            for tp in t_by_depth[t_depths[ti]]:
                if sp != tp:
                    out.add((sp, tp))
    return out
