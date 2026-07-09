"""Unit tests for the on-demand fine-pair reader
(`FalkorDBProvider._synthesize_ondemand_lineage_pairs`) — the read-side
half of the level-based materialization boundary.

Pairs involving leaf-LEVEL nodes are no longer materialized (they scale
as edges × depth and OOM the instance); `get_aggregated_edges_between`
computes them on demand by anchoring on the leaf endpoint's raw lineage
and walking the OTHER endpoint upward through containment (``*0..k``).
These tests simulate that traversal against an in-memory graph and
assert the questions the boundary must keep answering:

* "which domains does this column reach" — leaf source resolved to an
  ancestor 8 levels up (Q1, upward walk on the target side);
* the reverse direction — non-leaf source, leaf target (Q2);
* source-only fan-out for a leaf node (exact raw targets);
* coarse (non-leaf × non-leaf) pairs are NOT produced here (they come
  from the materialized cells — the two sources stay disjoint);
* legacy fallback to exact raw synthesis when no level map is injected;
* `get_aggregated_edges_between` merges materialized + on-demand rows,
  deduping in favor of the materialized row.
"""
import asyncio
import re

from backend.app.providers.falkordb_provider import FalkorDBProvider


class _Result:
    def __init__(self, result_set=None):
        self.result_set = result_set or []


_CLASSIFY_RE = re.compile(r"MATCH \(n:(\w+)\) WHERE n\.urn IN \$urns")
_Q1_RE = re.compile(r"MATCH \(x:(\w+)\)-\[r\]->\(t\) .*MATCH \(y\)-\[:")
_Q2_RE = re.compile(r"MATCH \(s\)-\[r\]->\(y:(\w+)\)")
_SRC_ONLY_RE = re.compile(r"MATCH \(x:(\w+)\)-\[r\]->\(t\) .*AND t\.urn <> x\.urn")


class _FakeGraph:
    """In-memory graph answering the reader's Cypher shapes: per-label
    URN classification, and the leaf-anchored fan-out queries with
    ``*0..k`` upward containment walks on the far endpoint."""

    def __init__(self):
        self.labels = {}       # urn -> label
        self.children = {}     # parent_urn -> set(child_urn)
        self.lineage = []      # (edge_id, src_urn, tgt_urn, type)

    def add_node(self, urn, label):
        self.labels[urn] = label

    def contain(self, parent, child):
        self.children.setdefault(parent, set()).add(child)

    def flow(self, eid, src, tgt, etype="FLOWS"):
        self.lineage.append((eid, src, tgt, etype))

    def _descendants_or_self(self, urn):
        out, stack = {urn}, [urn]
        while stack:
            for child in self.children.get(stack.pop(), ()):
                if child not in out:
                    out.add(child)
                    stack.append(child)
        return out

    async def ro_query(self, cypher, params=None, timeout=None):
        params = params or {}
        m = _CLASSIFY_RE.search(cypher)
        if m:
            lbl = m.group(1)
            return _Result([[u] for u in params["urns"] if self.labels.get(u) == lbl])
        m = _Q1_RE.search(cypher)
        if m:
            # leaf sources: raw fan-out, target resolved upward to any $ys
            lbl, cells = m.group(1), {}
            for x in params["xs"]:
                if self.labels.get(x) != lbl:
                    continue
                for eid, s, t, et in self.lineage:
                    if s != x or et not in params["lt"]:
                        continue
                    for y in params["ys"]:
                        if x != y and t in self._descendants_or_self(y):
                            eids, types = cells.setdefault((x, y), (set(), []))
                            eids.add(eid)
                            if et not in types:
                                types.append(et)
            return _Result([[x, y, len(e), t] for (x, y), (e, t) in cells.items()])
        m = _Q2_RE.search(cypher)
        if m:
            # leaf targets: raw fan-in, source resolved upward to any $xs
            lbl, cells = m.group(1), {}
            for y in params["ys"]:
                if self.labels.get(y) != lbl:
                    continue
                for eid, s, t, et in self.lineage:
                    if t != y or et not in params["lt"]:
                        continue
                    for x in params["xs"]:
                        if x != y and s in self._descendants_or_self(x):
                            eids, types = cells.setdefault((x, y), (set(), []))
                            eids.add(eid)
                            if et not in types:
                                types.append(et)
            return _Result([[x, y, len(e), t] for (x, y), (e, t) in cells.items()])
        m = _SRC_ONLY_RE.search(cypher)
        if m:
            lbl, cells = m.group(1), {}
            for x in params["xs"]:
                if self.labels.get(x) != lbl:
                    continue
                for eid, s, t, et in self.lineage:
                    if s != x or et not in params["lt"] or t == x:
                        continue
                    eids, types = cells.setdefault((x, t), (set(), []))
                    eids.add(eid)
                    if et not in types:
                        types.append(et)
            return _Result([[x, t, len(e), ty] for (x, t), (e, ty) in cells.items()])
        raise AssertionError(f"unhandled ro_query: {cypher}")


def _make_provider(fake, levels):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = levels
    p._redis = None
    p._ro_query = fake.ro_query
    return p


def _run(coro):
    return asyncio.run(coro)


def _seed_deep_chains(fake, depth=8):
    """Two containment chains of `depth` levels (lvl0 ⊃ … ⊃ lvl7=leaf),
    lineage a_leaf -> b_leaf (×2 parallel edges). Returns the level map."""
    levels = {f"lvl{i}": i for i in range(depth)}
    for chain in ("a", "b"):
        for i in range(depth):
            fake.add_node(f"urn:{chain}{i}", f"lvl{i}")
            if i:
                fake.contain(f"urn:{chain}{i-1}", f"urn:{chain}{i}")
    leaf = depth - 1
    fake.flow(1, f"urn:a{leaf}", f"urn:b{leaf}")
    fake.flow(2, f"urn:a{leaf}", f"urn:b{leaf}")
    return levels


def test_leaf_source_resolves_ancestor_eight_levels_up():
    """'Which domains does this column reach' — leaf column at level 7,
    domain at level 0, answered via the upward *0..k walk."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=8)
    p = _make_provider(fake, levels)
    rows = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a7"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a7", "urn:b0", 2, ["FLOWS"]]]


def test_leaf_source_resolves_every_requested_ancestor_level():
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=8)
    p = _make_provider(fake, levels)
    targets = [f"urn:b{i}" for i in range(8)]
    rows = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a7"], targets, ["CONTAINS"], ["FLOWS"],
    ))
    assert {(r[0], r[1], r[2]) for r in rows} == {
        ("urn:a7", f"urn:b{i}", 2) for i in range(8)
    }


def test_nonleaf_source_to_leaf_target_uses_reverse_walk():
    """Q2: domain → column resolves the SOURCE upward from the raw edge."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=8)
    p = _make_provider(fake, levels)
    rows = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a0"], ["urn:b7"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a0", "urn:b7", 2, ["FLOWS"]]]


def test_source_only_mode_returns_exact_raw_targets():
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)
    rows = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], None, ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b2", 2, ["FLOWS"]]]


def test_nonleaf_pairs_are_not_produced_on_demand():
    """Coarse cells come from materialized rows — the reader must not
    duplicate them (disjointness of the two sources)."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)
    rows = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:b1"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []


def test_missing_level_map_falls_back_to_raw_synthesis():
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels={})
    sentinel = [["urn:a2", "urn:b2", 2, ["FLOWS"]]]
    seen = {}

    async def fake_raw(source_urns, target_urns, lineage_edges, *, timeout=None):
        seen["args"] = (source_urns, target_urns, lineage_edges)
        return sentinel

    p._synthesize_raw_lineage_pairs = fake_raw
    rows = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b2"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == sentinel
    assert seen["args"] == (["urn:a2"], ["urn:b2"], ["FLOWS"])


def test_get_aggregated_edges_between_merges_and_dedupes():
    """Materialized coarse rows + on-demand fine rows in one response;
    a pair present in both keeps the materialized row's weight."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None):
        assert "AGGREGATED" in cypher
        # coarse cell lvl1→lvl1 plus a stale pre-boundary fine cell that
        # must win over the freshly-synthesized duplicate
        return _Result([
            ["urn:a1", "urn:b1", 5, ["FLOWS"]],
            ["urn:a2", "urn:b2", 9, ["FLOWS"]],
        ])

    p._ensure_connected = noop_connect
    p._proj_ro_query = proj_ro_query
    result = _run(p.get_aggregated_edges_between(
        ["urn:a2", "urn:a1"], ["urn:b2", "urn:b1", "urn:b0"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=["FLOWS"],
    ))
    got = {
        (e.source_urn, e.target_urn): e.edge_count
        for e in result.aggregated_edges
    }
    assert got == {
        ("urn:a1", "urn:b1"): 5,   # materialized coarse cell
        ("urn:a2", "urn:b2"): 9,   # materialized wins over on-demand (weight 2)
        ("urn:a2", "urn:b1"): 2,   # on-demand: column → parent table
        ("urn:a2", "urn:b0"): 2,   # on-demand: column → grandparent domain
        ("urn:a1", "urn:b2"): 2,   # on-demand: parent table → column
    }
