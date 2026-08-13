"""Unit tests for the STRUCTURAL trace drill-down (System B).

``expand_aggregated`` drills an :AGGREGATED edge one step deeper. When
the expanded edge carries containment-depth stamps
(``sourceDepth``/``targetDepth``), the drill is structural: each
anchor's DIRECT containment children (each side advancing from its own
depth — ragged pairs keep the childless side at the anchor), read
against the stored cells agg-first with the existing empty→raw
fallback. Ontology type levels — degenerate on self-nesting types,
where they made every drill return nothing — are not consulted;
unstamped (pre-depth) edges keep the legacy type-level descent.

The BFS peer-rollup (``_expand_aggregated_set``) likewise buckets its
frontier by stamped depth and filters cells with
``r.sourceDepth = r.targetDepth = depth(f)`` instead of the degenerate
type-level pair filter.
"""
import asyncio

from backend.app.providers.falkordb_provider import FalkorDBProvider


class _Result:
    def __init__(self, result_set=None):
        self.result_set = result_set or []


def _label(urn):
    """The fake's label convention: the urn's prefix before any '_'.
    `tbl_a` is a `tbl`, `ctr1` is a `ctr1`. Enough to exercise the
    label-filtered branch without a real graph."""
    return urn.split("_")[0]


def _run(coro):
    return asyncio.run(coro)


class _TraceFake:
    """Answers exactly the structural-drill Cypher shapes."""

    def __init__(self):
        self.children = {}     # parent_urn -> [child_urn]
        self.lineage = []      # (src, tgt, type)
        self.agg = {}          # (src, tgt) -> {weight, sd, td, types}
        self.meta = ("cube", 2)
        self.adjacency = {}    # (urn, direction) -> [(other_urn, edge_type)], id(r) == list index

    def contain(self, parent, child):
        self.children.setdefault(parent, []).append(child)

    def aggregated(self, src, tgt, weight, sd, td, types=("FLOWS",)):
        self.agg[(src, tgt)] = {
            "weight": weight, "sd": sd, "td": td, "types": list(types),
        }

    async def proj_ro_query(self, cypher, params=None, timeout=None, **kwargs):
        # **kwargs: the provider's query wrappers pass telemetry kwargs
        # (op=...) — a fake that rejects them fails as 'descendants_failed'.
        params = params or {}
        if "_AggMeta" in cypher:
            regime, stamp = self.meta
            return _Result([[regime, stamp, None, "2026-07-11T00:00:00Z"]])
        if "r.sourceDepth IS NOT NULL AND r.targetDepth IS NOT NULL" in cypher:
            # _edge_depth_stamps
            e = self.agg.get((params["s"], params["t"]))
            if e is None or e["sd"] is None or e["td"] is None:
                return _Result([])
            return _Result([[e["sd"], e["td"]]])
        if "MATCH (f)-[r:AGGREGATED]->()" in cypher:
            rows = {}
            for (s, t), e in self.agg.items():
                if s in params["urns"] and e["sd"] is not None:
                    rows[s] = max(rows.get(s, -1), e["sd"])
            return _Result([[u, d] for u, d in rows.items()])
        if "MATCH ()-[r:AGGREGATED]->(f)" in cypher:
            rows = {}
            for (s, t), e in self.agg.items():
                if t in params["urns"] and e["td"] is not None:
                    rows[t] = max(rows.get(t, -1), e["td"])
            return _Result([[u, d] for u, d in rows.items()])
        if "MATCH (s)-[r:AGGREGATED]->(t)" in cypher and "sUrns" in params:
            # _edges_between_sets_once AGGREGATED branch
            rows = []
            for (s, t), e in self.agg.items():
                if s in params["sUrns"] and t in params["tUrns"]:
                    rows.append([
                        s, t, "AGGREGATED", f"{s}|{t}",
                        {"sourceEdgeTypes": e["types"], "weight": e["weight"]},
                    ])
            return _Result(rows)
        raise AssertionError(f"unhandled proj_ro_query: {cypher}")

    def _subtree(self, urn):
        """Every descendant of `urn`, any depth — what an unstepped
        partner side contributes."""
        out, stack = [], list(self.children.get(urn, []))
        while stack:
            c = stack.pop()
            if c in out:
                continue
            out.append(c)
            stack.extend(self.children.get(c, []))
        return out

    async def ro_query(self, cypher, params=None, timeout=None, **kwargs):
        params = params or {}
        if "RETURN 'd' AS side" in cypher and "RETURN 'p' AS side" in cypher:
            # The ASYMMETRIC collectors: one side steps, the partner
            # contributes itself and its whole subtree.
            drilled = params["drill"]
            partner = params["partner"]
            types = params.get("types")
            if "labels(a)[0] IN $types" in cypher and types is not None:
                # Level variant — the opened side is label-filtered.
                kids = [c for c in self._subtree(drilled) if _label(c) in types]
                if _label(drilled) in types:
                    kids = [drilled, *kids]
            else:
                kids = list(self.children.get(drilled, []))
            return _Result([
                ["d", kids],
                ["p", [partner]],
                ["p", self._subtree(partner)],
            ])
        if "RETURN 's' AS side" in cypher and "type(c) IN $ctypes" in cypher:
            # _collect_children_pair, symmetric
            s_kids = list(self.children.get(params["source"], []))
            t_kids = list(self.children.get(params["target"], []))
            return _Result([["s", s_kids], ["t", t_kids]])
        if "type(r) IN $ltypes" in cypher and "sUrns" in params:
            # raw fallback of _edges_between_sets_once
            rows = []
            for s, t, et in self.lineage:
                if s in params["sUrns"] and t in params["tUrns"] and et in params["ltypes"]:
                    rows.append([s, t, et, f"raw-{s}-{t}", {}])
            return _Result(rows)
        if "WHERE id(r) > $after" in cypher:
            # _page_raw_lineage_single: cursor page over ONE node's
            # adjacency. `self.adjacency[(urn, direction)]` is an ordered
            # [(other_urn, edge_type)] list — the list index IS the fake's
            # `id(r)`, so slicing by `after`/`limit` mirrors a real
            # `WHERE id(r) > $after ... ORDER BY id(r) LIMIT $limit`.
            urn = params["urn"]
            after = params["after"]
            limit = params["limit"]
            incoming = "<-[r" in cypher
            edges = self.adjacency.get((urn, "incoming" if incoming else "outgoing"), [])
            page = [(eid, other, et) for eid, (other, et) in enumerate(edges) if eid > after][:limit]
            rows = []
            for eid, other, et in page:
                if incoming:
                    rows.append([eid, other, urn, et, other, None])
                else:
                    rows.append([eid, urn, other, et, other, None])
            return _Result(rows)
        if "AS otherUrn" in cypher:
            # _expand_raw_lineage_set: one BFS hop over raw lineage for a
            # frontier SET. Incoming (upstream) matches edges whose TARGET
            # is in the frontier; outgoing (downstream) whose SOURCE is.
            # ``otherUrn`` is the far (newly discovered) endpoint. Row
            # shape: [sourceUrn, targetUrn, edgeId, edgeType, otherUrn,
            # otherLabel]. `exclude`, when present, drops rows whose far
            # endpoint is excluded — simulating the real `NOT o.urn IN
            # $exclude` WHERE clause.
            frontier = set(params.get("frontier", []))
            exclude = set(params.get("exclude") or [])
            incoming = "<-[r" in cypher
            rows = []
            for s, t, et in self.lineage:
                if incoming and t in frontier:
                    other = s
                elif not incoming and s in frontier:
                    other = t
                else:
                    continue
                if other in exclude:
                    continue
                rows.append([s, t, f"raw-{s}-{t}", et, other, None])
            return _Result(rows)
        if "RETURN f.urn AS urn, labels(f)[0] AS label" in cypher:
            # _collect_lineage_seed — TWO separately-valid queries (FalkorDB
            # rejects the combined `WITH [f] + collect(DISTINCT d)` form with
            # "_AR_EXP_UpdateEntityIdx: Unable to locate a value with alias
            # f"; only a LIVE engine catches that, never a string-matching
            # fake — the live gate comes in a later task).
            #   (1) does the focus itself carry lineage? → LEAF focus
            focus = params["urn"]
            lin_nodes = {s for s, _, _ in self.lineage} | {t for _, t, _ in self.lineage}
            return _Result([[focus, None]] if focus in lin_nodes else [])
        if "RETURN DISTINCT d.urn AS urn, labels(d)[0] AS label" in cypher:
            #   (2) which containment descendants carry lineage? → CONTAINER
            #       focus, truncated at $cap (mirrors the real LIMIT so
            #       seed_capped is exercisable against the fake).
            focus = params["urn"]
            cap = params["cap"]
            lin_nodes = {s for s, _, _ in self.lineage} | {t for _, t, _ in self.lineage}
            desc, stack = set(), [focus]
            while stack:
                x = stack.pop()
                for c in self.children.get(x, []):
                    if c not in desc:
                        desc.add(c)
                        stack.append(c)
            matched = sorted(u for u in desc if u in lin_nodes)
            return _Result([[u, None] for u in matched[:cap]])
        raise AssertionError(f"unhandled ro_query: {cypher}")


def _make_provider(fake, levels=None):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = levels or {"Roots": 0, "Node": 1}
    p._redis = None
    p._ro_query = fake.ro_query
    p._proj_ro_query = fake.proj_ro_query

    async def _noop():
        return None

    async def _no_nodes(urns):
        return []

    async def _no_node(urn):
        return None

    async def _no_ancestors(urns, ctypes):
        return []

    p._ensure_connected = _noop
    p.get_nodes_batch = _no_nodes
    p.get_node = _no_node
    p._collect_ancestor_urns = _no_ancestors
    return p


def _seed_self_nesting(fake):
    """roots r_a ⊃ m_a ⊃ l_a (all one self-nesting type), same for b;
    full cube stored with depth stamps."""
    for side in ("a", "b"):
        fake.contain(f"r_{side}", f"m_{side}")
        fake.contain(f"m_{side}", f"l_{side}")
    fake.lineage.append(("l_a", "l_b", "FLOWS"))
    fake.aggregated("r_a", "r_b", 2, 0, 0)
    fake.aggregated("m_a", "m_b", 2, 1, 1)
    fake.aggregated("m_a", "r_b", 2, 1, 0)
    fake.aggregated("r_a", "m_b", 2, 0, 1)
    fake.aggregated("l_a", "m_b", 2, 2, 1)
    fake.aggregated("m_a", "l_b", 2, 1, 2)
    fake.aggregated("l_a", "r_b", 2, 2, 0)
    fake.aggregated("r_a", "l_b", 2, 0, 2)


def test_structural_drill_returns_child_edges_on_self_nesting():
    """THE trace regression: drilling root→root on a self-nesting graph
    must surface the child-level cells. The legacy type-level descent
    found no descendants (no type exists at 'level 2') and every drill
    came back empty."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    p = _make_provider(fake)

    result = _run(p.expand_aggregated(
        "r_a", "r_b", next_level=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    got = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got == {("m_a", "m_b")}

    # Drill the resulting child pair — the next depth works too.
    result = _run(p.expand_aggregated(
        "m_a", "m_b", next_level=2,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    got = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got == {("l_a", "l_b")}


def test_ragged_childless_side_stays_at_anchor():
    """Expanding (m_a → l_b) where l_b is a leaf: the target side stays
    at the anchor and the source side advances — the stored (l_a, l_b)
    cell renders."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    fake.aggregated("l_a", "l_b", 2, 2, 2)
    p = _make_provider(fake)

    result = _run(p.expand_aggregated(
        "m_a", "l_b", next_level=2,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    got = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got == {("l_a", "l_b")}


def test_structural_drill_ignores_engine_use_raw_heuristic():
    """The engine's ``use_raw = level >= finest_level`` misclassifies on
    self-nesting maps (finest type level is 1, so EVERY drill reads raw
    lineage between containers — nothing). A stamped edge must read the
    stored cells first regardless of the flag."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    p = _make_provider(fake)

    result = _run(p.expand_aggregated(
        "r_a", "r_b", next_level=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
        use_raw_edges=True,   # the degenerate heuristic's output
    ))
    got = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got == {("m_a", "m_b")}


def test_leaf_drill_falls_back_to_raw_lineage():
    """At the finest grain the cube omits the raw leaf↔leaf mirror by
    default — the agg-first read comes back empty and the existing
    empty→raw fallback serves the raw truth."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    # The seed has no stored (l_a, l_b) mirror — the drill's agg read
    # between the leaf children is empty, forcing the raw fallback.
    p = _make_provider(fake)

    result = _run(p.expand_aggregated(
        "m_a", "m_b", next_level=2,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    got = {(e.source_urn, e.target_urn, e.edge_type) for e in result.edges}
    assert got == {("l_a", "l_b", "FLOWS")}


def test_unstamped_edge_dispatches_to_legacy_type_level_path():
    """Pre-depth generations (no stamps on the expanded edge) must keep
    the legacy type-level descent until the next materialization."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    fake.agg[("r_a", "r_b")]["sd"] = None   # stamp-less legacy edge
    fake.agg[("r_a", "r_b")]["td"] = None
    p = _make_provider(fake)
    called = {}

    async def legacy(source_urn, target_urn, target_level, ctypes, limit,
                     drill_anchor=None):
        called["legacy"] = True
        return [], []

    p._collect_descendants_pair_at_level = legacy
    result = _run(p.expand_aggregated(
        "r_a", "r_b", next_level=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    assert called.get("legacy") is True
    assert result.edges == []


def test_frontier_depths_resolved_from_stamped_cells():
    fake = _TraceFake()
    _seed_self_nesting(fake)
    p = _make_provider(fake)
    depths = _run(p._frontier_depths_from_stamps(["m_a", "l_b", "ghost"]))
    assert depths == {"m_a": 1, "l_b": 2}


def test_bfs_peer_rollup_filters_cells_by_frontier_depth():
    """The BFS wave for a depth-1 frontier must read ONLY the d1↔d1
    cells — the type-level filter matched every Node↔Node cell at every
    depth on self-nesting graphs (mixed granularities in one wave)."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    p = _make_provider(fake)
    seen = {}

    orig = fake.proj_ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        if "r.sourceDepth = $fDepth" in cypher:
            seen["depth_filter"] = params["fDepth"]
            # Serve exactly the matching cells like the real store would.
            rows = []
            for (s, t), e in fake.agg.items():
                if s in params["frontier"] and e["sd"] == params["fDepth"] \
                        and e["td"] == params["fDepth"]:
                    rows.append([
                        s, t, f"{s}|{t}", "AGGREGATED",
                        e["types"], e["weight"], None,
                    ])
            return _Result(rows)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._proj_ro_query = spy
    out = _run(p._expand_aggregated_set(
        frontier=["m_a"], frontier_labels={"m_a": "Node"},
        direction="outgoing", level=1, ltypes=None,
        limit=50, timeout_secs=2.0,
    ))
    assert seen.get("depth_filter") == 1
    # Only the d1↔d1 cell — the mixed-depth cells (m_a→r_b at d1→d0,
    # m_a→l_b at d1→d2) stay out of this wave.
    assert {(e["sourceUrn"], e["targetUrn"]) for e in out} == {("m_a", "m_b")}


# ── Asymmetric drill: only the OPENED anchor descends ─────────────────
#
# Stepping both sides in lockstep is why opening a Data Domain against a
# Table five containment levels below returned nothing. The level path
# filtered the Table side to types at the Domain's next level (a Table
# has none), and the structural path walked the Table down to its
# columns — either way the two sets could never meet, and the caller was
# told "nothing here connects" about lineage that plainly exists.


def _seed_deep_chain(fake):
    """dom ⊃ app ⊃ ctr1 ⊃ ctr2 ⊃ db ⊃ tbl_a, and a peer table tbl_b that
    feeds it. Seven levels with `ctr` REPEATED — the shape no type→level
    map can describe."""
    for parent, child in [
        ("dom", "app"), ("app", "ctr1"), ("ctr1", "ctr2"),
        ("ctr2", "db"), ("db", "tbl_a"), ("tbl_a", "col_a"),
        # The partner has children of its own. Without this the
        # symmetric drill is rescued by the childless-side fallback and
        # the fixture cannot reproduce the reported failure at all.
        ("tbl_b", "col_b"),
    ]:
        fake.contain(parent, child)
    fake.lineage.append(("tbl_a", "tbl_b", "FLOWS"))
    fake.aggregated("dom", "tbl_b", 1, 0, 5)
    fake.aggregated("app", "tbl_b", 1, 1, 5)


def test_drilling_a_domain_against_a_table_five_levels_below_finds_edges():
    """The reported bug. The partner is the QUESTION, not another thing
    to descend — it contributes itself and its subtree so the two sides
    can meet however far apart they sit."""
    fake = _TraceFake()
    _seed_deep_chain(fake)
    p = _make_provider(fake)

    result = _run(p.expand_aggregated(
        "dom", "tbl_b", next_level=None,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
        drill_anchor="dom",
    ))
    assert result.edges, "opening the domain against a table must not come back empty"
    assert any(e.source_urn == "app" for e in result.edges)


def test_partner_side_is_never_stepped_away_from_the_question():
    """Without drill_anchor both sides advance and the answer is empty —
    the behaviour that produced 'nothing connects'. Kept as the contrast
    so the fix cannot silently regress into it."""
    fake = _TraceFake()
    _seed_deep_chain(fake)
    p = _make_provider(fake)

    symmetric = _run(p.expand_aggregated(
        "dom", "tbl_b", next_level=None,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    asymmetric = _run(p.expand_aggregated(
        "dom", "tbl_b", next_level=None,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
        drill_anchor="dom",
    ))
    assert len(asymmetric.edges) >= len(symmetric.edges)


def test_no_level_requests_the_structural_drill():
    """A caller whose ontology repeats a type at two depths has no single
    honest level to send. `None` is that admission, and it must route to
    the structural path rather than to a type-level query for level 1."""
    fake = _TraceFake()
    _seed_self_nesting(fake)
    fake.agg[("r_a", "r_b")]["sd"] = None
    fake.agg[("r_a", "r_b")]["td"] = None
    p = _make_provider(fake)
    called = {}

    async def legacy(source_urn, target_urn, target_level, ctypes, limit,
                     drill_anchor=None):
        called["legacy"] = True
        return [], []

    p._collect_descendants_pair_at_level = legacy
    _run(p.expand_aggregated(
        "r_a", "r_b", next_level=None,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))
    assert called.get("legacy") is None, "next_level=None must not reach the type-level path"


def test_an_anchor_that_matches_nothing_falls_back_to_itself():
    """Both collectors must end `or [anchor]`. The level helper did not,
    so a side could come back empty and short-circuit the whole expand
    to zero edges — the asymmetry between the two was itself a bug."""
    fake = _TraceFake()
    _seed_deep_chain(fake)
    p = _make_provider(fake)
    p._entity_type_levels = {"THING": 0}

    s_urns, t_urns = _run(p._collect_descendants_pair_at_level(
        "dom", "tbl_b", 99, ["HAS"], 100,
    ))
    assert s_urns == ["dom"]
    assert t_urns == ["tbl_b"]


# ── Closure walk primitives: seed / hop / page ─────────────────────────────
#
# _expand_raw_lineage_set, _collect_lineage_seed and _page_raw_lineage_single
# back the upcoming trace_closure (added in a later task). Fakes here only
# pattern-match Cypher strings and cannot validate real Cypher syntax — see
# _collect_lineage_seed's own comment below for a case a live engine caught
# that no string-matching fake could.


def test_expand_raw_lineage_set_exclude_filters_far_endpoints():
    """`exclude` adds a parameterized `NOT o.urn IN $exclude` clause and
    drops excluded far-endpoints from the hop; without it the clause is
    absent and nothing is filtered."""
    fake = _TraceFake()
    fake.lineage = [
        ("hub", "keep1", "FLOWS"),
        ("hub", "drop1", "FLOWS"),
        ("hub", "keep2", "FLOWS"),
    ]
    p = _make_provider(fake)
    seen = []

    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        seen.append(cypher)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    out = _run(p._expand_raw_lineage_set(
        frontier=["hub"], frontier_labels={"hub": "Hub"},
        direction="outgoing", ltypes=["FLOWS"], limit=50, timeout_secs=2.0,
        exclude=["drop1"],
    ))
    assert {r["otherUrn"] for r in out} == {"keep1", "keep2"}
    assert any("NOT o.urn IN $exclude" in c for c in seen)

    seen.clear()
    out2 = _run(p._expand_raw_lineage_set(
        frontier=["hub"], frontier_labels={"hub": "Hub"},
        direction="outgoing", ltypes=["FLOWS"], limit=50, timeout_secs=2.0,
    ))
    assert {r["otherUrn"] for r in out2} == {"keep1", "drop1", "keep2"}
    assert all("NOT o.urn IN $exclude" not in c for c in seen)


def test_collect_lineage_seed_exclude_keeps_focus_row():
    """`exclude` drops a descendant seed row but never the focus's own
    row, even when the focus urn is itself listed in `exclude`."""
    fake = _TraceFake()
    fake.contain("dom", "leaf_a")
    fake.contain("dom", "leaf_b")
    fake.lineage = [("leaf_a", "leaf_b", "FLOWS"), ("dom", "elsewhere", "FLOWS")]
    p = _make_provider(fake)

    seed, capped = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=10, timeout_secs=2.0,
        exclude={"leaf_a", "dom"},
    ))
    urns = {u for u, _ in seed}
    assert "leaf_a" not in urns
    assert "dom" in urns
    assert "leaf_b" in urns
    assert capped is False


def test_collect_lineage_seed_seed_capped_reflects_limit_hit():
    """seed_capped is False when the descendants query returns fewer rows
    than its LIMIT, True when it returns exactly `cap` rows (the cap was
    hit and more may exist)."""
    fake = _TraceFake()
    fake.contain("dom", "leaf_a")
    fake.contain("dom", "leaf_b")
    fake.contain("dom", "leaf_c")
    fake.lineage = [
        ("leaf_a", "x", "FLOWS"), ("leaf_b", "x", "FLOWS"), ("leaf_c", "x", "FLOWS"),
    ]
    p = _make_provider(fake)

    _, capped_small = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=10, timeout_secs=2.0,
    ))
    assert capped_small is False

    _, capped_hit = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=3, timeout_secs=2.0,
    ))
    assert capped_hit is True


def test_page_raw_lineage_single_pages_disjoint_by_edge_id():
    """7 outgoing edges off one anchor, limit 3: three calls page 3/3/1
    disjoint rows in edge-id order, the last call's last_edge_id resumes
    the next page correctly, and paging past the end returns ([], None)."""
    fake = _TraceFake()
    fake.adjacency[("hub", "outgoing")] = [(f"t{i}", "FLOWS") for i in range(7)]
    p = _make_provider(fake)

    page1, last1 = _run(p._page_raw_lineage_single(
        "hub", "Hub", "outgoing", ["FLOWS"], None, 3, 2.0,
    ))
    assert [r["otherUrn"] for r in page1] == ["t0", "t1", "t2"]
    assert last1 == 2

    page2, last2 = _run(p._page_raw_lineage_single(
        "hub", "Hub", "outgoing", ["FLOWS"], last1, 3, 2.0,
    ))
    assert [r["otherUrn"] for r in page2] == ["t3", "t4", "t5"]
    assert last2 == 5

    page3, last3 = _run(p._page_raw_lineage_single(
        "hub", "Hub", "outgoing", ["FLOWS"], last2, 3, 2.0,
    ))
    assert [r["otherUrn"] for r in page3] == ["t6"]
    assert last3 == 6

    page4, last4 = _run(p._page_raw_lineage_single(
        "hub", "Hub", "outgoing", ["FLOWS"], last3, 3, 2.0,
    ))
    assert page4 == []
    assert last4 is None

    all_urns = [r["otherUrn"] for r in page1 + page2 + page3]
    assert len(all_urns) == len(set(all_urns)) == 7


def test_page_raw_lineage_single_upstream_flips_source_target():
    """Upstream direction (`<-[r]-`): sourceUrn is always the edge's true
    source (the far endpoint `o`), targetUrn is the anchor — otherUrn
    stays the far endpoint regardless of direction."""
    fake = _TraceFake()
    fake.adjacency[("hub", "incoming")] = [("up0", "FLOWS"), ("up1", "FLOWS")]
    p = _make_provider(fake)

    rows, last = _run(p._page_raw_lineage_single(
        "hub", "Hub", "incoming", ["FLOWS"], None, 10, 2.0,
    ))
    assert [(r["sourceUrn"], r["targetUrn"], r["otherUrn"]) for r in rows] == [
        ("up0", "hub", "up0"),
        ("up1", "hub", "up1"),
    ]
    assert last == 1


def test_page_raw_lineage_single_unlabeled_anchor_falls_back():
    """A falsy `label` drops the label qualifier from the anchor match —
    a single-node scan, accepted as a cheaper cost than an unlabeled
    bucket across a whole frontier."""
    fake = _TraceFake()
    fake.adjacency[("hub", "outgoing")] = [("t0", "FLOWS")]
    p = _make_provider(fake)
    seen = {}

    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        if "WHERE id(r) > $after" in cypher:
            seen["cypher"] = cypher
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy
    rows, _ = _run(p._page_raw_lineage_single(
        "hub", "", "outgoing", ["FLOWS"], None, 10, 2.0,
    ))
    assert "MATCH (f {urn: $urn})" in seen["cypher"]
    assert "MATCH (f:" not in seen["cypher"]
    assert len(rows) == 1
