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
* mixed-level non-leaf pairs (table→domain) derived from the
  materialized same-level diagonal (Q3: anchor the finer endpoint's
  :AGGREGATED cells, walk the coarser endpoint upward) — exact weights;
* same-level pairs are NOT produced here (they come from the
  materialized cells — the sources stay disjoint);
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
_RESOLVE_UP_RE = re.compile(r"RETURN c\.urn, a\.urn")
_AGG_FANOUT_RE = re.compile(r"MATCH \(x:(\w+)\)-\[r:AGGREGATED\]->\(t2\)")
_AGG_FANIN_RE = re.compile(r"MATCH \(s2\)-\[r:AGGREGATED\]->\(y:(\w+)\)")


class _FakeGraph:
    """In-memory graph answering the reader's Cypher shapes: per-label
    URN classification, leaf-anchored raw fan-out queries with ``*0..k``
    upward containment walks, same-level :AGGREGATED anchor queries (the
    materialized diagonal), and the strict upward resolution query."""

    def __init__(self):
        self.labels = {}       # urn -> label
        self.children = {}     # parent_urn -> set(child_urn)
        self.lineage = []      # (edge_id, src_urn, tgt_urn, type)
        self.agg = []          # (src_urn, tgt_urn, weight, types) same-level cells

    def add_node(self, urn, label):
        self.labels[urn] = label

    def contain(self, parent, child):
        self.children.setdefault(parent, set()).add(child)

    def flow(self, eid, src, tgt, etype="FLOWS"):
        self.lineage.append((eid, src, tgt, etype))

    def aggregated(self, src, tgt, weight, types=("FLOWS",), sl=None, tl=None):
        lvl = lambda u: int(re.search(r"(\d+)", self.labels[u]).group(1))
        self.agg.append((src, tgt, weight, list(types),
                         lvl(src) if sl is None else sl,
                         lvl(tgt) if tl is None else tl))

    def _descendants_or_self(self, urn):
        out, stack = {urn}, [urn]
        while stack:
            for child in self.children.get(stack.pop(), ()):
                if child not in out:
                    out.add(child)
                    stack.append(child)
        return out

    async def proj_ro_query(self, cypher, params=None, timeout=None):
        """Projection-graph reads: same-level :AGGREGATED anchors."""
        params = params or {}
        m = _AGG_FANOUT_RE.search(cypher)
        if m:
            lbl = m.group(1)
            return _Result([
                [s, t, w, list(ty)] for s, t, w, ty, sl, tl in self.agg
                if s in params["xs"] and self.labels.get(s) == lbl
                and tl <= params["maxTl"]
            ])
        m = _AGG_FANIN_RE.search(cypher)
        if m:
            lbl = m.group(1)
            return _Result([
                [t, s, w, list(ty)] for s, t, w, ty, sl, tl in self.agg
                if t in params["ys"] and self.labels.get(t) == lbl
                and sl <= params["maxSl"]
            ])
        raise AssertionError(f"unhandled proj_ro_query: {cypher}")

    async def ro_query(self, cypher, params=None, timeout=None):
        params = params or {}
        m = _CLASSIFY_RE.search(cypher)
        if m:
            lbl = m.group(1)
            return _Result([[u] for u in params["urns"] if self.labels.get(u) == lbl])
        if _RESOLVE_UP_RE.search(cypher):
            # strict upward resolution: c.urn IN $cs, a.urn IN $as_, a above c
            return _Result([
                [c, a] for c in params["cs"] for a in params["as_"]
                if a != c and c in self._descendants_or_self(a)
            ])
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
    p._proj_ro_query = fake.proj_ro_query
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
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a7"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a7", "urn:b0", 2, ["FLOWS"]]]


def test_leaf_source_resolves_every_requested_ancestor_level():
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=8)
    p = _make_provider(fake, levels)
    targets = [f"urn:b{i}" for i in range(8)]
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
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
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a0"], ["urn:b7"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a0", "urn:b7", 2, ["FLOWS"]]]


def test_source_only_mode_returns_exact_raw_targets():
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], None, ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b2", 2, ["FLOWS"]]]


def test_same_level_pairs_are_not_produced_on_demand():
    """Same-level cells come from materialized rows — the reader must not
    duplicate them (disjointness of the sources)."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)
    p = _make_provider(fake, levels)
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:b1"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []


def test_mixed_level_pair_derived_from_materialized_diagonal():
    """table→domain is no longer materialized (only the same-level
    diagonal is) — it is derived by anchoring on the table's same-level
    :AGGREGATED cells and walking the far endpoint upward. Exact weight."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)   # materialized table→table
    p = _make_provider(fake, levels)
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []
    assert mixed == [["urn:a1", "urn:b0", 2, ["FLOWS"]]]


def test_mixed_level_pair_reverse_direction():
    """domain→table via the finer target's same-level fan-in."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)
    p = _make_provider(fake, levels)
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a0"], ["urn:b1"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []
    assert mixed == [["urn:a0", "urn:b1", 2, ["FLOWS"]]]


def test_mixed_level_pair_deep_hierarchy():
    """L6 container → L1 container across an 8-level hierarchy: the
    anchor is the L6 same-level cell; the walk climbs five levels."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=8)
    fake.aggregated("urn:a6", "urn:b6", 2)
    p = _make_provider(fake, levels)
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a6"], ["urn:b1"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []
    assert mixed == [["urn:a6", "urn:b1", 2, ["FLOWS"]]]


def test_alias_variant_labels_still_classify_and_anchor():
    """Solidatus-style sources spell labels differently than the ontology
    declares (declared 'lvl2' observed as 'LVL2_OBS'). The reader must
    translate through the entity alias map or it silently classifies
    nothing and mixed-granularity views lose all leaf lineage."""
    fake = _FakeGraph()
    levels = {"lvl0": 0, "lvl1": 1, "lvl2": 2}
    for chain in ("a", "b"):
        for i in range(3):
            # Graph labels use the OBSERVED spelling for the leaf level.
            observed = f"LVL{i}_OBS" if i == 2 else f"lvl{i}"
            fake.add_node(f"urn:{chain}{i}", observed)
            if i:
                fake.contain(f"urn:{chain}{i-1}", f"urn:{chain}{i}")
    fake.flow(1, "urn:a2", "urn:b2")
    fake.flow(2, "urn:a2", "urn:b2")
    p = _make_provider(fake, levels)
    p._source_entity_aliases = {"LVL2": ["LVL2_OBS"]}
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b0", 2, ["FLOWS"]]]


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
    rows, mixed = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b2"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == sentinel
    assert seen["args"] == (["urn:a2"], ["urn:b2"], ["FLOWS"])


def test_trace_drilldown_falls_back_to_raw_when_aggregated_empty():
    """The trace drill (expand Object→Object edge to attribute grain)
    reads :AGGREGATED between the two descendant sets when the requested
    level is not classified as finest. Post-boundary those cells don't
    exist — the read must fall back to RAW lineage instead of silently
    returning an empty drill (the 'trace stops at Object' regression)."""
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels={"lvl0": 0, "lvl1": 1, "lvl2": 2})

    async def proj_ro_query(cypher, params=None, timeout=None):
        return _Result([])   # no fine AGGREGATED cells materialized

    async def ro_query(cypher, params=None, timeout=None):
        # the raw-edge branch of _edges_between_sets_once
        assert "type(r) IN $ltypes" in cypher
        rows = [
            [s, t, et, eid, {}]
            for eid, s, t, et in fake.lineage
            if s in params["sUrns"] and t in params["tUrns"]
            and et in params["ltypes"]
        ]
        return _Result(rows)

    p._proj_ro_query = proj_ro_query
    p._ro_query = ro_query
    edges = _run(p._edges_between_sets(
        ["urn:a2"], ["urn:b2"], level=2, ltypes=["FLOWS"],
        use_raw=False, limit=100,
    ))
    assert [(e.source_urn, e.target_urn) for e in edges] == [
        ("urn:a2", "urn:b2"), ("urn:a2", "urn:b2"),
    ]
    assert all(e.edge_type == "FLOWS" for e in edges)


def test_full_cross_product_matrix_six_levels():
    """The audit contract: on a 6-level hierarchy (domain ⊃ application ⊃
    container ⊃ schema ⊃ table ⊃ column) with column→column lineage,
    EVERY (source-level × target-level) query combination — all 36 —
    must return exactly the one pair with the exact weight. Materialized
    state is only the canonical diagonal the pipeline writes; everything
    else must be derived. This is 'which domains does this column reach,
    6 levels up' and every drill-down step in between."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=6)   # a0..a5 / b0..b5, leaf=5
    for i in range(5):                          # the pipeline's diagonal
        fake.aggregated(f"urn:a{i}", f"urn:b{i}", 2)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None):
        if params and "sourceUrns" in params:
            return _Result([
                [s, t, w, list(ty)] for s, t, w, ty, sl, tl in fake.agg
                if s in params["sourceUrns"]
                and t in (params.get("targetUrns") or [])
            ])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._ensure_connected = noop_connect
    p._proj_ro_query = proj_ro_query

    for i in range(6):
        for j in range(6):
            result = _run(p.get_aggregated_edges_between(
                [f"urn:a{i}"], [f"urn:b{j}"],
                granularity=None,
                containment_edges=["CONTAINS"],
                lineage_edges=["FLOWS"],
            ))
            got = {
                (e.source_urn, e.target_urn): e.edge_count
                for e in result.aggregated_edges
            }
            assert got == {(f"urn:a{i}", f"urn:b{j}"): 2}, (
                f"cross-product cell (L{i} → L{j}) wrong: {got}"
            )


def test_mixed_level_weight_sums_stored_and_derived_portions():
    """Doubly-ragged exactness: table_a1 reaches domain_b0 through BOTH a
    ragged raw edge (column directly under the domain → stored canonical
    cell (a1,b0) w=1) AND aligned edges (stored diagonal (a1,b1) w=5,
    b1 under b0). The response weight for (a1,b0) must be 1+5=6 — the
    stored portion plus the strictly-below derived portion, summed, not
    one dropping the other."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 5)            # aligned diagonal
    fake.aggregated("urn:a1", "urn:b0", 1)            # ragged canonical
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None):
        if params and "sourceUrns" in params:
            return _Result([
                ["urn:a1", "urn:b1", 5, ["FLOWS"]],
                ["urn:a1", "urn:b0", 1, ["FLOWS"]],
            ])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._ensure_connected = noop_connect
    p._proj_ro_query = proj_ro_query
    result = _run(p.get_aggregated_edges_between(
        ["urn:a1"], ["urn:b1", "urn:b0"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=["FLOWS"],
    ))
    got = {
        (e.source_urn, e.target_urn): e.edge_count
        for e in result.aggregated_edges
    }
    assert got == {
        ("urn:a1", "urn:b1"): 5,
        ("urn:a1", "urn:b0"): 6,   # 1 stored (ragged rep) + 5 derived
    }


def test_get_aggregated_edges_between_merges_and_dedupes():
    """Materialized diagonal rows + on-demand rows in one response;
    a pair present in both keeps the materialized row's weight."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 5)   # materialized same-level cell
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None):
        assert "AGGREGATED" in cypher
        if params and "sourceUrns" in params:
            # The main materialized read: the diagonal cell plus a stale
            # pre-boundary fine cell that must win over the
            # freshly-synthesized duplicate.
            return _Result([
                ["urn:a1", "urn:b1", 5, ["FLOWS"]],
                ["urn:a2", "urn:b2", 9, ["FLOWS"]],
            ])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

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
        ("urn:a1", "urn:b1"): 5,   # materialized same-level cell
        ("urn:a2", "urn:b2"): 9,   # materialized wins over on-demand (weight 2)
        ("urn:a2", "urn:b1"): 2,   # on-demand: column → parent table
        ("urn:a2", "urn:b0"): 2,   # on-demand: column → grandparent domain
        ("urn:a1", "urn:b2"): 2,   # on-demand: parent table → column
        ("urn:a1", "urn:b0"): 5,   # on-demand mixed level, from the diagonal
    }
