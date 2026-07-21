"""Unit tests for the on-demand STRUCTURAL pair reader
(`FalkorDBProvider._synthesize_ondemand_lineage_pairs`) — the read-side
half of the depth-based materialization boundary.

In boundary regime, pairs involving structural LEAF nodes (no
containment children) are not materialized; `get_aggregated_edges_between`
computes them on demand by anchoring on the leaf endpoint's raw lineage
and walking the OTHER endpoint upward through containment (``*0..k``).
Classification and mixed-pair derivation are keyed on containment DEPTH
(the ``sourceDepth``/``targetDepth`` stamps), never on ontology type
levels — which degenerate on self-nesting types. These tests simulate
that traversal against an in-memory graph and assert:

* "which domains does this column reach" — leaf source resolved to an
  ancestor 8 levels up (Q1, upward walk on the target side);
* the reverse direction — container source, leaf target (Q2);
* source-only fan-out for a leaf node (exact raw targets);
* mixed-DEPTH container pairs (table→domain) derived from the
  materialized depth-diagonal (Q3: anchor the finer endpoint's stored
  cells at its own rank, walk the coarser endpoint upward) — exact
  weights, self-nesting shapes included;
* same-depth pairs are NOT produced here (they come from the
  materialized cells — the sources stay disjoint);
* regime dispatch: cube regime serves only the raw leaf↔leaf mirror;
  the in-graph _AggMeta stamp beats the legacy Redis marker and probe;
  stamp_version < 2 keeps depth-keyed mixed derivation off;
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
_RESOLVE_UP_RE = re.compile(r"RETURN (?:DISTINCT )?c\.urn, a\.urn")
_Q1_RE = re.compile(r"MATCH \(x(?::\w+)?\)-\[r:[\w|]+\]->\(t\) WHERE x\.urn IN \$xs")
_Q2_RE = re.compile(r"MATCH \(s\)-\[r:[\w|]+\]->\(y(?::\w+)?\) WHERE y\.urn IN \$ys")
_RAW_RE = re.compile(r"MATCH \(s(?::\w+)?\)-\[r(?::[\w|]+)?\]->\(t\) WHERE s\.urn IN \$sourceUrns")


def _pattern_types(cypher):
    m = re.search(r"\[r:([\w|]+)\]", cypher)
    return set(m.group(1).split("|")) if m else set()
_CHAIN_RE = re.compile(r"MATCH \(child(?::(\w+))?\) WHERE child\.urn IN \$urns")
_AGG_FANOUT_RE = re.compile(r"MATCH \(x(?::\w+)?\)-\[r:AGGREGATED\]->\(t2\)")
_AGG_FANIN_RE = re.compile(r"MATCH \(s2\)-\[r:AGGREGATED\]->\(y(?::\w+)?\)")


class _FakeGraph:
    """In-memory graph answering the STRUCTURAL reader's Cypher shapes:
    the containment-profile query (leafness + depth per requested urn),
    leaf-anchored raw fan-out/fan-in with ``*0..k`` upward containment
    walks, depth-stamped :AGGREGATED anchor queries (the materialized
    canonical cells), the strict upward resolution query, the in-graph
    ``_AggMeta`` read and the legacy regime probe."""

    def __init__(self):
        self.labels = {}       # urn -> label (display metadata only)
        self.children = {}     # parent_urn -> set(child_urn)
        self.lineage = []      # (edge_id, src_urn, tgt_urn, type)
        self.agg = []          # (src, tgt, weight, types, sd, td) canonical cells
        # (regime, stampVersion). Defaults to a healthy stamped boundary
        # graph; set to None to simulate a pre-_AggMeta graph (readers
        # resolve regime "unknown" — NO probe on the read path — and
        # serve the exact raw mirror + stale).
        self.meta = ("boundary", 2)
        self.chain_cache_down = False  # True → every chain read misses

    def add_node(self, urn, label):
        self.labels[urn] = label

    def contain(self, parent, child):
        self.children.setdefault(parent, set()).add(child)

    def flow(self, eid, src, tgt, etype="FLOWS"):
        self.lineage.append((eid, src, tgt, etype))

    def set_meta(self, regime="boundary", stamp=2):
        self.meta = (regime, stamp)

    def _parents(self):
        out = {}
        for par, kids in self.children.items():
            for k in kids:
                out.setdefault(k, set()).add(par)
        return out

    def depth(self, urn):
        parents = self._parents()

        def d(u, seen=()):
            ps = [p for p in parents.get(u, ()) if p not in seen]
            return 0 if not ps else 1 + max(d(p, (*seen, u)) for p in ps)

        return d(urn)

    def aggregated(self, src, tgt, weight, types=("FLOWS",), sd=None, td=None):
        self.agg.append((src, tgt, weight, list(types),
                         self.depth(src) if sd is None else sd,
                         self.depth(tgt) if td is None else td))

    def _descendants_or_self(self, urn):
        out, stack = {urn}, [urn]
        while stack:
            for child in self.children.get(stack.pop(), ()):
                if child not in out:
                    out.add(child)
                    stack.append(child)
        return out

    legacy_rows = False  # True simulates NULL-aggKey / NULL-stamp rows

    async def proj_ro_query(self, cypher, params=None, timeout=None, **kw):
        """Projection-graph reads: _AggMeta, regime probe, depth-stamped
        :AGGREGATED anchors."""
        params = params or {}
        if "_AggMeta" in cypher:
            if self.meta is None:
                return _Result([])
            regime, stamp = self.meta
            return _Result([[regime, stamp, None, "2026-07-11T00:00:00Z"]])
        if "r.aggKey IS NULL" in cypher:
            # Storage-regime probe: canonical fake cells always conform
            # unless a test explicitly simulates a legacy generation.
            return _Result([[1]] if self.legacy_rows else [])
        if _AGG_FANOUT_RE.search(cypher):
            assert "r.targetDepth <= r.sourceDepth" in cypher
            return _Result([
                [s, t, w, list(ty)] for s, t, w, ty, sd, td in self.agg
                if s in params["xs"] and td <= sd
            ])
        if _AGG_FANIN_RE.search(cypher):
            assert "r.sourceDepth <= r.targetDepth" in cypher
            return _Result([
                [t, s, w, list(ty)] for s, t, w, ty, sd, td in self.agg
                if t in params["ys"] and sd <= td
            ])
        raise AssertionError(f"unhandled proj_ro_query: {cypher}")

    async def ro_query(self, cypher, params=None, timeout=None, **kw):
        params = params or {}
        # NO-WALK GUARD: the aggregated read path must never issue a
        # variable-length containment walk. The only legitimate var-length
        # caller through this fake is the ancestor-chain COMPUTATION
        # (hydration/write path), which anchors per label via _CHAIN_RE.
        if ("*0.." in cypher or "*1.." in cypher) and not _CHAIN_RE.search(cypher):
            raise AssertionError(
                f"containment walk issued on the read path: {cypher}"
            )
        if "count(ch)" in cypher and "OPTIONAL MATCH" in cypher:
            # Leafness probe: urn → child count. Single hop, no depth —
            # depth now comes from the stamped incident cells. (Checked
            # BEFORE the classify regex, whose label-anchored prefix the
            # probe shares.)
            return _Result([
                [u, len(self.children.get(u, ()))]
                for u in params["urns"] if u in self.labels
            ])
        m = _CLASSIFY_RE.search(cypher)
        if m:
            # Per-label urn classification — still used by the hooks'
            # bulk ancestor-chain path (label-driven index anchors).
            lbl = m.group(1)
            return _Result([[u] for u in params["urns"] if self.labels.get(u) == lbl])
        m = _CHAIN_RE.search(cypher)
        if m:
            lbl = m.group(1)
            if lbl is None:
                raise AssertionError(
                    "unlabeled ancestor-chain anchor issued — full node "
                    "scan on servers without unlabeled-index support"
                )
            parent = {}
            for par, kids in self.children.items():
                for k in kids:
                    parent[k] = par
            rows = []
            for u in params["urns"]:
                if self.labels.get(u) != lbl:
                    continue
                chain, cur = [], parent.get(u)
                while cur is not None:
                    chain.append(cur)
                    cur = parent.get(cur)
                rows.append([u, chain])
            return _Result(rows)
        if _RESOLVE_UP_RE.search(cypher):
            raise AssertionError(
                "strict upward-resolution Cypher issued — the read path "
                "must resolve ancestors via the Redis chain cache"
            )
        if _RAW_RE.search(cypher):
            # Exact-endpoint raw mirror (cube/unknown regime, no containment).
            lt = params.get("ltypes") or _pattern_types(cypher)
            cells = {}
            tgts = params.get("targetUrns")
            for eid, s, t, et in self.lineage:
                if s not in params["sourceUrns"] or et not in lt:
                    continue
                if s == t or (tgts is not None and t not in tgts):
                    continue
                eids, types = cells.setdefault((s, t), (set(), []))
                eids.add(eid)
                if et not in types:
                    types.append(et)
            return _Result([[s, t, len(e), ty] for (s, t), (e, ty) in cells.items()])
        if _Q1_RE.search(cypher):
            # Leaf sources: EXACT typed raw fan-out (far endpoints are
            # resolved upward in Python via the chain cache, not here).
            lt = _pattern_types(cypher)
            cells = {}
            for x in params["xs"]:
                for eid, s, t, et in self.lineage:
                    if s != x or et not in lt:
                        continue
                    if "t.urn <> x.urn" in cypher and t == x:
                        continue
                    eids, types = cells.setdefault((x, t), (set(), []))
                    eids.add(eid)
                    if et not in types:
                        types.append(et)
            return _Result([[x, t, len(e), ty] for (x, t), (e, ty) in cells.items()])
        if _Q2_RE.search(cypher):
            # Leaf targets: EXACT typed raw fan-in.
            lt = _pattern_types(cypher)
            cells = {}
            for y in params["ys"]:
                for eid, s, t, et in self.lineage:
                    if t != y or et not in lt:
                        continue
                    eids, types = cells.setdefault((y, s), (set(), []))
                    eids.add(eid)
                    if et not in types:
                        types.append(et)
            return _Result([[y, s, len(e), ty] for (y, s), (e, ty) in cells.items()])
        raise AssertionError(f"unhandled ro_query: {cypher}")


def _make_provider(fake, levels):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = levels
    p._redis = None
    p._ro_query = fake.ro_query
    p._proj_ro_query = fake.proj_ro_query

    async def _cached_label(urn):
        return fake.labels.get(urn)

    async def _buckets(urns):
        by = {}
        for u in dict.fromkeys(u for u in urns if u):
            by.setdefault(fake.labels.get(u) or "", []).append(u)
        return sorted(by.items())

    async def _ancestors_read_through(urns):
        # Read-THROUGH ancestor resolution, exactly as the reader now calls
        # it: a cache hit is free, a miss COMPUTES (and caches) the chain —
        # it never returns a miss, so chain_cache_down (a cold cache) does
        # NOT suppress resolution. urn → [parent, …, root].
        parent = {}
        for par, kids in fake.children.items():
            for k in kids:
                parent[k] = par
        out = {}
        for u in dict.fromkeys(u for u in urns if u):
            chain, cur = [], parent.get(u)
            while cur is not None:
                chain.append(cur)
                cur = parent.get(cur)
            out[u] = chain
        return out

    async def _stamp_depths(urns):
        want = set(urns)
        out = {}
        for s_, t_, w, ty, sd, td in fake.agg:
            if s_ in want and sd is not None:
                out[s_] = max(out.get(s_, -1), int(sd))
            if t_ in want and td is not None:
                out[t_] = max(out.get(t_, -1), int(td))
        return out

    p._get_cached_label = _cached_label
    p._label_buckets = _buckets
    p._compute_and_store_ancestors_bulk = _ancestors_read_through
    p._frontier_depths_from_stamps = _stamp_depths
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
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a7"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a7", "urn:b0", 2, ["FLOWS"]]]


def test_leaf_source_resolves_every_requested_ancestor_level():
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=8)
    p = _make_provider(fake, levels)
    targets = [f"urn:b{i}" for i in range(8)]
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
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
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a0"], ["urn:b7"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a0", "urn:b7", 2, ["FLOWS"]]]


def test_source_only_mode_returns_exact_raw_targets():
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
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
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
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
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []
    assert mixed == [["urn:a1", "urn:b0", 2, ["FLOWS"]]]


def test_mixed_level_pair_reverse_direction():
    """domain→table via the finer target's same-level fan-in."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
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
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a6"], ["urn:b1"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []
    assert mixed == [["urn:a6", "urn:b1", 2, ["FLOWS"]]]


def test_label_spellings_are_irrelevant_to_classification():
    """Classification is STRUCTURAL (leaf = no containment children), so
    alias-variant or entirely unknown label spellings — the failure mode
    that used to silently classify nothing and lose all leaf lineage —
    cannot matter: no label is consulted at all."""
    fake = _FakeGraph()
    levels = {"lvl0": 0, "lvl1": 1, "lvl2": 2}
    for chain in ("a", "b"):
        for i in range(3):
            # Observed graph spellings differ from every declared label.
            fake.add_node(f"urn:{chain}{i}", f"LVL{i}_OBS")
            if i:
                fake.contain(f"urn:{chain}{i-1}", f"urn:{chain}{i}")
    fake.flow(1, "urn:a2", "urn:b2")
    fake.flow(2, "urn:a2", "urn:b2")
    p = _make_provider(fake, levels)
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b0", 2, ["FLOWS"]]]


def test_no_level_map_still_serves_structural_synthesis():
    """Self-nesting and unmapped ontologies have no usable type-level
    map; the structural reader must serve leaf-involving pairs anyway
    (the old reader fell back to exact-endpoint raw synthesis and lost
    every rolled-up pair)."""
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels={})
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b0", 2, ["FLOWS"]]]


def test_no_containment_types_falls_back_to_raw_synthesis():
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels={})
    sentinel = [["urn:a2", "urn:b2", 2, ["FLOWS"]]]
    seen = {}

    async def fake_raw(source_urns, target_urns, lineage_edges, *, timeout=None):
        seen["args"] = (source_urns, target_urns, lineage_edges)
        return sentinel

    p._synthesize_raw_lineage_pairs = fake_raw
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b2"], [], ["FLOWS"],
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

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        return _Result([])   # no fine AGGREGATED cells materialized

    async def ro_query(cypher, params=None, timeout=None, **kw):
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


def test_bulk_ancestor_chains_are_label_driven():
    """Ancestor-chain computation must anchor on the per-label URN
    indexes — the old unlabeled ``MATCH (child) WHERE child.urn IN``
    was a full node scan per chunk (observed timing out for 1776 urns
    on a 1M-node graph, then degrading to per-URN full scans). The fake
    REFUSES unlabeled anchors."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=4)
    p = _make_provider(fake, levels)
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)

    chains = _run(p._compute_ancestor_chains_bulk_cypher(
        ["urn:a3", "urn:b2", "urn:nonexistent"],
    ))
    assert chains["urn:a3"] == ["urn:a2", "urn:a1", "urn:a0"]
    assert chains["urn:b2"] == ["urn:b1", "urn:b0"]
    assert chains["urn:nonexistent"] == []

    # The per-URN path delegates to the same label-driven query.
    assert _run(p._compute_ancestor_chain("urn:b3")) == [
        "urn:b2", "urn:b1", "urn:b0",
    ]


def test_progressive_topdown_drilldown_journey():
    """The canvas journey: lineage exists ONLY at the most granular level
    (column→column), yet every step of a top-down drill must show the
    relationship — domains related at the top, then expanding one side a
    level at a time (visible set = expanded side's children + the other
    side still collapsed) down to the exact columns. Materialized state
    is only what the pipeline writes (the canonical diagonal)."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=4)   # domain(0) ⊃ app(1) ⊃ table(2) ⊃ column(3)
    for i in range(3):
        fake.aggregated(f"urn:a{i}", f"urn:b{i}", 2)   # pipeline diagonal
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        if params and "sourceUrns" in params:
            return _Result([
                [s, t, w, list(ty)] for s, t, w, ty, sl, tl in fake.agg
                if s in params["sourceUrns"]
                and t in (params.get("targetUrns") or [])
            ])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._ensure_connected = noop_connect
    p._proj_ro_query = proj_ro_query

    def edges_between(visible):
        result = _run(p.get_aggregated_edges_between(
            list(visible), list(visible),
            granularity=None,
            containment_edges=["CONTAINS"],
            lineage_edges=["FLOWS"],
        ))
        return {
            (e.source_urn, e.target_urn): e.edge_count
            for e in result.aggregated_edges
        }

    # Step 1 — everything collapsed: which domains relate to each other?
    assert edges_between(["urn:a0", "urn:b0"]) == {("urn:a0", "urn:b0"): 2}
    # Step 2 — expand domain A: its application ↔ the collapsed domain B.
    assert edges_between(["urn:a1", "urn:b0"]) == {("urn:a1", "urn:b0"): 2}
    # Step 3 — expand domain B too: application ↔ application (diagonal).
    assert edges_between(["urn:a1", "urn:b1"]) == {("urn:a1", "urn:b1"): 2}
    # Step 4 — drill A to tables while B stays at application level.
    assert edges_between(["urn:a2", "urn:b1"]) == {("urn:a2", "urn:b1"): 2}
    # Step 5 — drill A to the column itself, B still a container.
    assert edges_between(["urn:a3", "urn:b1"]) == {("urn:a3", "urn:b1"): 2}
    # Step 6 — both sides at the most granular level: the raw truth.
    assert edges_between(["urn:a3", "urn:b3"]) == {("urn:a3", "urn:b3"): 2}


class _FakePipeline:
    def __init__(self, redis):
        self._redis = redis
        self._ops = []

    def execute_command(self, cmd, key, *args):
        self._ops.append((cmd, key, args))

    def hget(self, key, field):
        self._ops.append(("HGET", key, (field,)))

    async def execute(self):
        out = []
        for cmd, key, args in self._ops:
            if cmd == "SADD":
                members = self._redis.sets.setdefault(key, set())
                new = args[0] not in members
                members.add(args[0])
                out.append(1 if new else 0)
            elif cmd == "SCARD":
                out.append(len(self._redis.sets.get(key, set())))
            elif cmd == "HGET":
                out.append(self._redis.hashes.get(key, {}).get(args[0]))
        self._ops = []
        return out


class _FakeWriteRedis:
    def __init__(self):
        self.sets = {}
        self.hashes = {}

    def pipeline(self, transaction=False):
        return _FakePipeline(self)


def test_write_path_hook_emits_only_canonical_pairs():
    """on_lineage_edge_written (interactive lineage writes) must produce
    EXACTLY the canonical level-bridged pairs the batch pipeline stores.
    The old full ancestor cross-product polluted the boundary with
    leaf-involving and mixed-level cells — masking the on-demand
    reader's exact answers until the next full run reconciled."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=4)   # lvl0..lvl3, leaf=3
    p = _make_provider(fake, levels)

    redis = _FakeWriteRedis()
    redis.hashes["labels"] = {
        f"urn:{c}{i}": f"lvl{i}" for c in ("a", "b") for i in range(4)
    }
    merged = []

    async def noop():
        return None

    async def dag_pair(source_urn, target_urn):
        # urn:a3 -> closure {a3: 3, a2: 2, a1: 1, a0: 0}
        def closure(urn):
            chain, idx = urn[4], int(urn[5])
            out = {urn: idx}
            for i in range(idx):
                out[f"urn:{chain}{i}"] = i
            return out

        return closure(source_urn), closure(target_urn), False, False

    async def proj_query(cypher, params=None, timeout=None, **kw):
        merged.extend(params["batch"])

    import time as _time
    from backend.app.providers.falkordb_provider import AggRunMeta
    p._ensure_connected = noop
    p._get_ancestor_dag_pair = dag_pair
    p._agg_meta_cached = (AggRunMeta("boundary", 2, None, None), _time.monotonic())
    p._redis = redis
    p._urn_label_key = lambda: "labels"
    p._level_digest = "digest-1"
    p._proj_query = proj_query

    n = _run(p.on_lineage_edge_written("urn:a3", "urn:b3", "edge-1", "FLOWS"))

    got = {(m["s"], m["t"]) for m in merged}
    # Canonical pairs only: the same-level diagonal for the three
    # non-leaf levels — no leaf-involving pairs, no mixed-level cells.
    assert got == {
        ("urn:a2", "urn:b2"), ("urn:a1", "urn:b1"), ("urn:a0", "urn:b0"),
    }
    assert n == 3
    for m in merged:
        assert m["sl"] == m["tl"]   # aligned chains → diagonal stamps

    # Idempotent replay of the same raw edge writes nothing new.
    merged.clear()
    n2 = _run(p.on_lineage_edge_written("urn:a3", "urn:b3", "edge-1", "FLOWS"))
    assert n2 == 0 and merged == []


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
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
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
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
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
    fake.set_meta("boundary", 2)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        assert "AGGREGATED" in cypher or "_AggMeta" in cypher
        if params and "sourceUrns" in params:
            # The main materialized read: the diagonal cell plus a stale
            # pre-boundary fine cell that must win over the
            # freshly-synthesized duplicate. Filtered by the label-bucket
            # batch actually requested — the read runs once per bucket.
            return _Result([
                row for row in (
                    ["urn:a1", "urn:b1", 5, ["FLOWS"]],
                    ["urn:a2", "urn:b2", 9, ["FLOWS"]],
                ) if row[0] in params["sourceUrns"]
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


def test_unmapped_label_endpoints_still_visible():
    """Nodes whose label is OUTSIDE the ontology (messy ingests) lost all
    aggregated visibility except the leaf-target direction — the original
    full cube stored their pairs label-agnostically. The QU raw anchors
    must serve: unmapped→unmapped (exact raw edge), unmapped→container
    (rolled up), and container→unmapped (exact raw fan-in)."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)          # lvl0 ⊃ lvl1 ⊃ lvl2
    fake.add_node("urn:m1", "Metric")                  # label not in levels
    fake.add_node("urn:m2", "Metric")
    fake.contain("urn:a1", "urn:m1")                   # metrics under tables
    fake.contain("urn:b1", "urn:m2")
    fake.flow(10, "urn:m1", "urn:m2")                  # metric → metric
    fake.flow(11, "urn:a2", "urn:m2")                  # column → metric
    fake.flow(12, "urn:m1", "urn:b2")                  # metric → column
    p = _make_provider(fake, levels)

    # unmapped → unmapped: the exact raw edge.
    rows, _, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:m1"], ["urn:m2"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:m1", "urn:m2", 1, ["FLOWS"]]]

    # unmapped → mapped container: raw fan-out rolled up to the domain
    # (edges m1→m2 under b1⊂b0 and m1→b2 under b0 both resolve to b0).
    rows, _, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:m1"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:m1", "urn:b0", 2, ["FLOWS"]]]

    # mapped container → unmapped: exact raw fan-in resolved upward.
    rows, _, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:m2"], ["CONTAINS"], ["FLOWS"],
    ))
    assert {(r[0], r[1], r[2]) for r in rows} == {("urn:a1", "urn:m2", 2)}


def test_full_cube_regime_skips_mixed_derivation():
    """Against a legacy / fine full cube the stored mixed rows already
    carry every contribution — deriving Q3 on top double-counts (2-6x
    observed). Non-conforming rows (NULL aggKey/stamps) must flip the
    reader to stored-only mixed answers."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)    # diagonal
    fake.aggregated("urn:a1", "urn:b0", 2)    # full-cube mixed cell
    fake.meta = None                          # pre-_AggMeta graph
    fake.legacy_rows = True                   # (probe is write-path-only now)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        if params and "sourceUrns" in params:
            return _Result([
                [s, t, w, list(ty)] for s, t, w, ty, sl, tl in fake.agg
                if s in params["sourceUrns"]
                and t in (params.get("targetUrns") or [])
            ])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._ensure_connected = noop_connect
    p._proj_ro_query = proj_ro_query

    result = _run(p.get_aggregated_edges_between(
        ["urn:a1"], ["urn:b0"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=["FLOWS"],
    ))
    got = {(e.source_urn, e.target_urn): e.edge_count
           for e in result.aggregated_edges}
    # Stored full-cube answer only — NOT 2 (stored) + 2 (derived) = 4.
    assert got == {("urn:a1", "urn:b0"): 2}


def test_fine_regime_marker_skips_mixed_derivation():
    """The pipeline stamps the storage regime into Redis; a 'fine' marker
    (AGGREGATION_MATERIALIZE_FINE_PAIRS runs) must gate Q3 off even when
    every stored row is well-formed."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)
    fake.aggregated("urn:a1", "urn:b0", 2)    # fine-mode mixed cell
    fake.meta = None                          # regime comes from the marker
    p = _make_provider(fake, levels)

    class _MarkerRedis:
        async def get(self, key):
            return b"fine" if key.endswith(":agg:regime") else None

    p._redis = _MarkerRedis()

    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert mixed == []


def test_graph_meta_beats_legacy_marker_and_probe():
    """The in-graph _AggMeta stamp is authoritative: a 'cube' meta node
    disables mixed derivation even when a stale Redis marker says
    'boundary' and the probe would agree — the exact desync that
    double-counted mixed weights when the Redis stamp was lost."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.aggregated("urn:a1", "urn:b1", 2)
    fake.aggregated("urn:a1", "urn:b0", 2)    # cube already stores it
    fake.set_meta("cube", 2)
    p = _make_provider(fake, levels)

    class _StaleMarkerRedis:
        async def get(self, key):
            return b"boundary" if key.endswith(":agg:regime") else None

    p._redis = _StaleMarkerRedis()

    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a1"], ["urn:b0"], ["CONTAINS"], ["FLOWS"],
    ))
    assert mixed == []


def test_self_nesting_mixed_depth_derivation():
    """THE regression this redesign exists for: a 2-type self-nesting
    ontology (every container shares one type label/level) in boundary
    regime. The old type-level reader derived NOTHING below the roots —
    'root→root renders, every expansion shows nothing'. Depth-keyed
    derivation serves child(d1) → collapsed-root(d0) from the stored
    depth-diagonal cells."""
    fake = _FakeGraph()
    # roots r_a ⊃ mid m_a ⊃ leaf l_a (all label "Node"); same for b side.
    for side in ("a", "b"):
        fake.add_node(f"urn:r_{side}", "Node")
        fake.add_node(f"urn:m_{side}", "Node")
        fake.add_node(f"urn:l_{side}", "Node")
        fake.contain(f"urn:r_{side}", f"urn:m_{side}")
        fake.contain(f"urn:m_{side}", f"urn:l_{side}")
    fake.flow(1, "urn:l_a", "urn:l_b")
    fake.flow(2, "urn:l_a", "urn:l_b")
    # Boundary storage: the depth-diagonal only.
    fake.aggregated("urn:r_a", "urn:r_b", 2)
    fake.aggregated("urn:m_a", "urn:m_b", 2)
    fake.set_meta("boundary", 2)
    # Degenerate type-level map — every container the same level.
    p = _make_provider(fake, {"Roots": 0, "Node": 1})

    # Canvas state: side A expanded to its mid container, side B collapsed.
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:m_a"], ["urn:r_b"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == []
    assert mixed == [["urn:m_a", "urn:r_b", 2, ["FLOWS"]]]

    # And the leaf itself against the collapsed far root (Q1).
    rows, mixed, _, _ = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:l_a"], ["urn:r_b"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:l_a", "urn:r_b", 2, ["FLOWS"]]]


def test_failed_subquery_marks_result_truncated():
    """A timed-out on-demand sub-query used to silently drop a whole
    class of edges from the canvas — the result must be flagged as
    partial (truncated) instead of presenting as complete."""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def failing_ro_query(cypher, params=None, timeout=None, **kw):
        raise TimeoutError("classification timed out")

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        if params and "sourceUrns" in params:
            return _Result([])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._ensure_connected = noop_connect
    p._ro_query = failing_ro_query
    p._proj_ro_query = proj_ro_query

    result = _run(p.get_aggregated_edges_between(
        ["urn:a2"], ["urn:b0"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=["FLOWS"],
    ))
    assert result.truncated is True


def test_unknown_regime_serves_raw_mirror_with_stale_and_no_probe():
    """Pre-_AggMeta graph with no Redis marker: the reader must NOT probe
    the cell set (the old LIMIT-1 conformance scan cost 2.0s over 1M cells
    on the read path, every 5 minutes) — it resolves regime 'unknown',
    serves the exact raw mirror, and reports stale/unmaterialized so the
    self-heal trigger fires."""
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    fake.meta = None
    p = _make_provider(fake, levels={"lvl0": 0, "lvl1": 1, "lvl2": 2})

    async def proj_guard(cypher, params=None, timeout=None, **kw):
        assert "r.aggKey IS NULL" not in cypher, (
            "conformance probe issued on the read path"
        )
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._proj_ro_query = proj_guard
    rows, mixed, degraded, reason = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b2"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b2", 2, ["FLOWS"]]]  # exact mirror
    assert mixed == []
    assert reason == "unmaterialized"


def test_boundary_stamp1_reports_legacy_cells():
    """Level-stamped cells without depth stamps (pre-redesign runs):
    depth-keyed derivation is impossible — raw mirror + stale so the
    widened trigger re-materializes."""
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    fake.set_meta("boundary", 1)
    p = _make_provider(fake, levels={"lvl0": 0, "lvl1": 1, "lvl2": 2})
    rows, mixed, degraded, reason = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b2"], ["CONTAINS"], ["FLOWS"],
    ))
    assert rows == [["urn:a2", "urn:b2", 2, ["FLOWS"]]]
    assert mixed == []
    assert reason == "legacy_cells"


def test_cold_chain_cache_resolves_rolled_up_pair_via_read_through():
    """Read-THROUGH ancestor resolution (trigger-model redesign): a cold
    ancestor-chain cache no longer DROPS the rolled-up pair. The chain is
    computed on miss — bounded to the far endpoints, cached — so a2→b0
    resolves alongside the exact a2→b2, and the result is NOT flagged
    chain_cache_miss. This is what decouples read-cache warming from
    materialization and stops the browse-driven re-trigger loop.

    (Still no live containment WALK on the read path: the bound is the
    visible far set, not the graph — that guarantee is unchanged.)"""
    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    fake.chain_cache_down = True  # cold cache — read-through computes anyway
    p = _make_provider(fake, levels)
    rows, mixed, degraded, reason = _run(p._synthesize_ondemand_lineage_pairs(
        ["urn:a2"], ["urn:b0", "urn:b2"], ["CONTAINS"], ["FLOWS"],
    ))
    # Exact pair (a2→b2) AND rolled-up (a2→b0) both resolve; nothing dropped.
    assert {(r[0], r[1], r[2]) for r in rows} == {
        ("urn:a2", "urn:b2", 2), ("urn:a2", "urn:b0", 2),
    }
    assert reason is None


def test_entry_result_carries_freshness_fields():
    """get_aggregated_edges_between surfaces stale/staleReason/
    stampVersion/regime so the engine trigger and the canvas can act."""
    fake = _FakeGraph()
    _seed_deep_chains(fake, depth=3)
    fake.meta = None
    p = _make_provider(fake, levels={"lvl0": 0, "lvl1": 1, "lvl2": 2})

    async def noop_connect():
        return None

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        if params and "sourceUrns" in params:
            return _Result([])
        return await fake.proj_ro_query(cypher, params=params, timeout=timeout)

    p._ensure_connected = noop_connect
    p._proj_ro_query = proj_ro_query
    result = _run(p.get_aggregated_edges_between(
        ["urn:a2"], ["urn:b2"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=["FLOWS"],
    ))
    assert result.stale is True
    assert result.stale_reason == "unmaterialized"
    assert result.regime == "unknown"
    assert result.stamp_version == 1
    # Healthy graphs are NOT stale.
    fake2 = _FakeGraph()
    _seed_deep_chains(fake2, depth=3)
    p2 = _make_provider(fake2, levels={"lvl0": 0, "lvl1": 1, "lvl2": 2})
    p2._ensure_connected = noop_connect

    async def proj2(cypher, params=None, timeout=None, **kw):
        if params and "sourceUrns" in params:
            return _Result([])
        return await fake2.proj_ro_query(cypher, params=params, timeout=timeout)

    p2._proj_ro_query = proj2
    result2 = _run(p2.get_aggregated_edges_between(
        ["urn:a2"], ["urn:b2"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=["FLOWS"],
    ))
    assert result2.stale is False
    assert result2.regime == "boundary" and result2.stamp_version == 2


def test_failed_materialized_batch_degrades_result_but_keeps_successful_rows():
    """A timed-out :AGGREGATED batch used to be silently swallowed by
    `_run_batch`'s ``except Exception: return []`` — the merged result
    presented (and got cached upstream) as complete even though a whole
    label bucket's edges were dropped. It must instead flag the result
    stale/degraded/truncated, exactly like an on-demand sub-query
    failure, WITHOUT dropping the rows the other batch did return."""
    from backend.app.providers.falkordb_provider import AggRunMeta

    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def label_buckets(urns):
        return [("LabelA", ["urn:a-fail"]), ("LabelB", ["urn:b-ok"])]

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        if "LabelA" in cypher:
            raise TimeoutError("batch timed out")
        return _Result([["urn:b-ok", "urn:target", 3, ["FLOWS"]]])

    async def agg_meta():
        return AggRunMeta("boundary", 2, None, "2026-07-17T00:00:00Z")

    p._ensure_connected = noop_connect
    p._label_buckets = label_buckets
    p._proj_ro_query = proj_ro_query
    p._aggregation_run_meta = agg_meta

    result = _run(p.get_aggregated_edges_between(
        ["urn:a-fail", "urn:b-ok"], ["urn:target"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=[],  # short-circuits on-demand synthesis
    ))

    assert result.stale is True
    assert result.stale_reason == "degraded"
    assert result.truncated is True
    got = {
        (e.source_urn, e.target_urn): e.edge_count
        for e in result.aggregated_edges
    }
    assert got == {("urn:b-ok", "urn:target"): 3}


def test_all_materialized_batches_succeed_leaves_flags_unset():
    """Sanity counterpart: when every batch succeeds, the new flag must
    not falsely mark the result stale/truncated."""
    from backend.app.providers.falkordb_provider import AggRunMeta

    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)

    async def noop_connect():
        return None

    async def label_buckets(urns):
        return [("LabelA", ["urn:a-ok"]), ("LabelB", ["urn:b-ok"])]

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        if "LabelA" in cypher:
            return _Result([["urn:a-ok", "urn:target", 1, ["FLOWS"]]])
        return _Result([["urn:b-ok", "urn:target", 3, ["FLOWS"]]])

    async def agg_meta():
        return AggRunMeta("boundary", 2, None, "2026-07-17T00:00:00Z")

    p._ensure_connected = noop_connect
    p._label_buckets = label_buckets
    p._proj_ro_query = proj_ro_query
    p._aggregation_run_meta = agg_meta

    result = _run(p.get_aggregated_edges_between(
        ["urn:a-ok", "urn:b-ok"], ["urn:target"],
        granularity=None,
        containment_edges=["CONTAINS"],
        lineage_edges=[],
    ))

    assert result.stale is False
    assert result.stale_reason is None
    assert result.truncated is False


def test_materialized_read_truncates_on_a_stable_key_not_weight_alone():
    """The :AGGREGATED read caps at AGGREGATED_EDGE_RESULT_CAP rows, and
    ``weight`` is a COUNT — so ties are pervasive and the LIMIT cut lands
    in the middle of a tie group. Ordering by weight ALONE leaves the
    surviving subset arbitrary and free to differ between executions;
    combined with delete-on-oversize (a >1MiB payload is never cached, so
    every canvas open re-runs the query) a large model would render a
    DIFFERENT lineage subset each time it is opened. Pin the keyset the
    same way the paged reads do: weight DESC, then (s.urn, t.urn).
    """
    from backend.app.providers.falkordb_provider import AggRunMeta

    fake = _FakeGraph()
    levels = _seed_deep_chains(fake, depth=3)
    p = _make_provider(fake, levels)

    seen: list = []

    async def noop_connect():
        return None

    async def label_buckets(urns):
        return [("LabelA", ["urn:a"])]

    async def proj_ro_query(cypher, params=None, timeout=None, **kw):
        seen.append(cypher)
        return _Result([])

    async def agg_meta():
        return AggRunMeta("boundary", 2, None, "2026-07-17T00:00:00Z")

    p._ensure_connected = noop_connect
    p._label_buckets = label_buckets
    p._proj_ro_query = proj_ro_query
    p._aggregation_run_meta = agg_meta

    # Both shapes of the materialized read: target-scoped and source-only.
    for targets in (["urn:target"], []):
        _run(p.get_aggregated_edges_between(
            ["urn:a"], targets,
            granularity=None,
            containment_edges=["CONTAINS"],
            lineage_edges=[],
        ))

    agg_reads = [c for c in seen if ":AGGREGATED]->" in c and "LIMIT" in c]
    assert agg_reads, f"expected the materialized :AGGREGATED read, saw: {seen}"
    for cypher in agg_reads:
        assert "ORDER BY r.weight DESC, s.urn, t.urn" in cypher, (
            f"truncation must be deterministic, got: {cypher}"
        )
