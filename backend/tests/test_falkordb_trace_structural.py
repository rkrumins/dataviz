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

from backend.app.models.graph import GraphNode
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
        self.degrees = {}      # urn -> {"in": n, "out": n}; ABSENT = unknown, never zero
        # Failure switches for the degree-exact walk (trace_closure):
        #   fail_expand_labels — an expand bucket anchored on one of these
        #       labels raises (a timed-out bucket);
        #   fail_seed — the container descent raises (seed enumeration lost);
        #   fail_walk_degrees — the walk's own degree query raises.
        self.fail_expand_labels = set()
        self.fail_seed = False
        self.fail_walk_degrees = False

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
        if "count(r) AS degree" in cypher:
            # _lineage_degrees: the WALK's own per-anchor degree read (one
            # query per direction per label bucket). Computed from the
            # lineage list, so the walk's estimates are exact against the
            # fake; `fail_walk_degrees` turns it into a failed bucket.
            if self.fail_walk_degrees:
                raise RuntimeError("degree query failed")
            incoming = "<-[r" in cypher
            wanted = set(params["urns"])
            counts = {u: 0 for u in wanted}
            for s, t, _ in self.lineage:
                if incoming and t in wanted:
                    counts[t] += 1
                elif not incoming and s in wanted:
                    counts[s] += 1
            return _Result([[u, c] for u, c in counts.items()])
        if "WHERE id(r) >= $after" in cypher:
            # _page_raw_lineage_single: cursor page over ONE node's
            # adjacency. `self.adjacency[(urn, direction)]` is an ordered
            # [(other_urn, edge_type)] list — the list index IS the fake's
            # `id(r)`, so slicing by `after`/`limit` mirrors a real
            # `WHERE id(r) >= $after ... ORDER BY id(r) LIMIT $limit`. The
            # cursor is INCLUSIVE: it names the next id to consider, so
            # `after=0` is from the start and edge id 0 is reachable.
            # Without an explicit adjacency the page reads the lineage
            # list itself (index == id(r)), so a hub seeded by the walk
            # pages the same edges the expand handler would have returned.
            urn = params["urn"]
            after = params["after"]
            limit = params["limit"]
            incoming = "<-[r" in cypher
            key = (urn, "incoming" if incoming else "outgoing")
            if key in self.adjacency:
                edges = self.adjacency[key]
                page = [(eid, other, et) for eid, (other, et) in enumerate(edges) if eid >= after][:limit]
            else:
                page = []
                for eid, (s, t, et) in enumerate(self.lineage):
                    if eid < after:
                        continue
                    if incoming and t == urn:
                        page.append((eid, s, et))
                    elif not incoming and s == urn:
                        page.append((eid, t, et))
                page = page[:limit]
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
            # otherLabel]. There is NO exclude filter here — the hop returns
            # every incident row and the caller drops the NODE in Python
            # while keeping its EDGE. The lineage list INDEX is the edge's
            # `id(r)` (same convention as the paging branch), so two parallel
            # edges on one (source, target) pair stay distinct rows.
            frontier = set(params.get("frontier", []))
            if any(f"(f:{lbl})" in cypher for lbl in self.fail_expand_labels):
                raise RuntimeError("expand bucket timed out")
            incoming = "<-[r" in cypher
            rows = []
            for eid, (s, t, et) in enumerate(self.lineage):
                if incoming and t in frontier:
                    other = s
                elif not incoming and s in frontier:
                    other = t
                else:
                    continue
                rows.append([s, t, f"raw-{eid}", et, other, None])
            # `LIMIT $limit` is part of the query, not an afterthought the
            # caller applies: a hop that asks for 3 rows gets 3 rows back, so
            # what the caller asked for is observable in what it receives.
            return _Result(rows[:params["limit"]])
        if "RETURN f.urn AS urn, labels(f)[0] AS label" in cypher:
            # _collect_lineage_seed — TWO separately-valid queries (FalkorDB
            # rejects the combined `WITH [f] + collect(DISTINCT d)` form with
            # "_AR_EXP_UpdateEntityIdx: Unable to locate a value with alias
            # f"; only a LIVE engine catches that, never a string-matching
            # fake — the live gate comes in a later task).
            #   (1) does the focus itself carry lineage? → LEAF focus
            focus = params["urn"]
            lin_nodes = {s for s, _, _ in self.lineage} | {t for _, t, _ in self.lineage}
            return _Result([[focus, _label(focus)]] if focus in lin_nodes else [])
        if "RETURN DISTINCT d.urn AS urn, labels(d)[0] AS label" in cypher:
            #   (2) which containment descendants carry lineage? → the
            #       CONTAINER case, truncated at $cap (mirrors the real
            #       LIMIT so seed_capped is exercisable against the fake).
            #       Asked of ONE anchor (`$urn`, _collect_lineage_seed) or
            #       of a SET (`$seeds`, _descendant_lineage_seed) — the
            #       same descent either way.
            if self.fail_seed:
                raise RuntimeError("descent timed out")
            roots = params.get("seeds") or [params["urn"]]
            cap = params["cap"]
            after = params.get("after")
            lin_nodes = {s for s, _, _ in self.lineage} | {t for _, t, _ in self.lineage}
            desc, stack = set(), list(roots)
            while stack:
                x = stack.pop()
                for c in self.children.get(x, []):
                    if c not in desc:
                        desc.add(c)
                        stack.append(c)
            matched = sorted(u for u in desc if u in lin_nodes)
            if after is not None:
                # Keyset resume, INCLUSIVE: the cursor names the next
                # anchor to consider (`d.urn >= $after`).
                matched = [u for u in matched if u >= after]
            return _Result([[u, _label(u)] for u in matched[:cap]])
        raise AssertionError(f"unhandled ro_query: {cypher}")


def _make_provider(fake, levels=None, hydrate=True):
    """Every discovered urn gets a stub node, so tests can assert on what the
    response SHIPS (`result.nodes`) and the closure's hydration honesty rule
    (a node the walk discovered but hydration did not return is a
    `nodes_failed` page) sees a provider that answers. The containment
    hydration that follows is stubbed too — that seam has its own tests;
    here it would just answer Cypher this fake knows nothing about.
    `hydrate` is kept for call-site compatibility; `False` no longer strips
    the stubs (a provider that ships no nodes is a failed provider)."""
    hydrate = True
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

    async def _degrees(urns, edge_types=None):
        # Mirrors get_node_degrees' contract: a urn ABSENT from the result is
        # unknown, not zero.
        return {u: dict(fake.degrees[u]) for u in urns if u in fake.degrees}

    p._ensure_connected = _noop
    p.get_nodes_batch = _no_nodes
    p.get_node = _no_node
    p._collect_ancestor_urns = _no_ancestors
    p.get_node_degrees = _degrees

    if hydrate:
        async def _hydrate(urns):
            return [
                GraphNode(urn=u, entityType=_label(u), displayName=u)
                for u in urns
            ]

        async def _no_chains(urns):
            return {}

        async def _no_containment_edges(urns, ctypes, chains=None):
            return []

        p.get_nodes_batch = _hydrate
        p._compute_and_store_ancestors_bulk = _no_chains
        p._fetch_containment_edges = _no_containment_edges
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


def test_expand_raw_lineage_set_never_filters_far_endpoints_in_the_db():
    """The hop returns EVERY incident row. It used to accept an `exclude`
    that became a `NOT o.urn IN $exclude` clause, applied on hop 1 only —
    which threw away the row for any edge whose far end the client already
    held, and with it the edge. Dropping the node is the caller's job,
    downstream of recording the edge; the query has no business knowing."""
    fake = _TraceFake()
    fake.lineage = [
        ("hub", "keep1", "FLOWS"),
        ("hub", "known", "FLOWS"),
        ("hub", "keep2", "FLOWS"),
    ]
    p = _make_provider(fake)
    seen = []

    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        seen.append(cypher)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    out, failed = _run(p._expand_raw_lineage_set(
        frontier=["hub"], frontier_labels={"hub": "Hub"},
        direction="outgoing", ltypes=["FLOWS"], limit=50, timeout_secs=2.0,
    ))
    assert {r["otherUrn"] for r in out} == {"keep1", "known", "keep2"}
    assert failed == set()
    assert all("$exclude" not in c for c in seen)


def test_collect_lineage_seed_takes_every_lineage_bearing_participant():
    """The seed is the focus's own row plus every lineage-bearing
    descendant — and nothing subtracts from it.

    The caller's `exclude_urns` used to drop matching seed rows here, on
    the reasoning that a node the client holds needs no re-walking. It
    does: what the client holds is the NODE, never the hops it has not
    asked about yet, and starting from an empty seed is how an expand
    came back with nothing at all (see `trace_closure`'s `wanted`)."""
    fake = _TraceFake()
    fake.contain("dom", "leaf_a")
    fake.contain("dom", "leaf_b")
    fake.lineage = [("leaf_a", "leaf_b", "FLOWS"), ("dom", "elsewhere", "FLOWS")]
    p = _make_provider(fake)

    seed, failed = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=10, timeout_secs=2.0,
    ))
    urns = {u for u, _ in seed}
    assert urns == {"dom", "leaf_a", "leaf_b"}
    assert failed is False


def test_collect_lineage_seed_enumerates_in_urn_order_up_to_cap():
    """The seed is an ENUMERATION, not a verdict: descendants come back in urn
    order, at most `cap` of them, and whether the page is partial is decided
    by the walk (which asks for `max_nodes + 1` so a capped enumeration always
    leaves a known pending anchor for the cursor). A cap the estate fits
    under returns everything; a smaller cap trims the tail, never the head."""
    fake = _TraceFake()
    fake.contain("dom", "leaf_a")
    fake.contain("dom", "leaf_b")
    fake.contain("dom", "leaf_c")
    fake.lineage = [
        ("leaf_a", "x", "FLOWS"), ("leaf_b", "x", "FLOWS"), ("leaf_c", "x", "FLOWS"),
    ]
    p = _make_provider(fake)

    all_rows, failed = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=10, timeout_secs=2.0,
    ))
    assert [u for u, _ in all_rows] == ["leaf_a", "leaf_b", "leaf_c"]
    assert failed is False

    trimmed, _ = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=2, timeout_secs=2.0,
    ))
    assert [u for u, _ in trimmed] == ["leaf_a", "leaf_b"]

    resumed, _ = _run(p._collect_lineage_seed(
        "dom", "Domain", ["FLOWS"], ["HAS"], cap=2, timeout_secs=2.0, after_urn="leaf_b",
    ))
    # Inclusive keyset: the cursor names the next anchor to consider.
    assert [u for u, _ in resumed] == ["leaf_b", "leaf_c"]


def test_page_raw_lineage_single_pages_disjoint_by_edge_id():
    """7 outgoing edges off one anchor, limit 3: three calls page 3/3/1
    disjoint rows in edge-id order and paging past the end returns
    ([], None).

    `after_id` is INCLUSIVE — the NEXT id to consider, not the last one seen —
    so a caller resumes at `last + 1`, and `0`/`None` both mean from the start
    WITHOUT skipping edge id 0. The exclusive form could not express "from the
    start" in the `^e:\\d+$` wire grammar at all: `e:0` silently swallowed the
    first edge."""
    fake = _TraceFake()
    fake.adjacency[("hub", "outgoing")] = [(f"t{i}", "FLOWS") for i in range(7)]
    p = _make_provider(fake)

    def _page(after):
        return _run(p._page_raw_lineage_single(
            "hub", "Hub", "outgoing", ["FLOWS"], after, 3, 2.0,
        ))

    page1, last1 = _page(None)
    assert [r["otherUrn"] for r in page1] == ["t0", "t1", "t2"]
    assert last1 == 2
    # Explicit 0 is the same request, and does not eat t0.
    assert [r["otherUrn"] for r in _page(0)[0]] == ["t0", "t1", "t2"]

    page2, last2 = _page(last1 + 1)
    assert [r["otherUrn"] for r in page2] == ["t3", "t4", "t5"]
    assert last2 == 5

    page3, last3 = _page(last2 + 1)
    assert [r["otherUrn"] for r in page3] == ["t6"]
    assert last3 == 6

    page4, last4 = _page(last3 + 1)
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
        if "WHERE id(r) >= $after" in cypher:
            seen["cypher"] = cypher
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy
    rows, _ = _run(p._page_raw_lineage_single(
        "hub", "", "outgoing", ["FLOWS"], None, 10, 2.0,
    ))
    assert "MATCH (f {urn: $urn})" in seen["cypher"]
    assert "MATCH (f:" not in seen["cypher"]
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# trace_closure — the focus-scoped lineage walk.
#
# SAME WARNING as the helper tests above: these fakes PATTERN-MATCH Cypher
# strings. They pin the walk's CONTROL FLOW — seed choice, hop order, budget,
# frontier, cursor — and cannot validate a single character of Cypher. The
# live-engine gate is a later task.
# ---------------------------------------------------------------------------


def test_trace_closure_scopes_to_focus_raw_lineage():
    """trace_closure walks RAW lineage from the focus (upstream + downstream),
    returning exactly the connected chain — regime-independent (no :AGGREGATED
    reads, so it works when boundary mode omits leaf cells) and scoped to the
    focus: a sibling column's UNRELATED lineage never appears."""
    fake = _TraceFake()
    fake.lineage = [
        ("c0", "c1", "FLOWS"),   # upstream of the focus
        ("c1", "c2", "FLOWS"),   # downstream …
        ("c2", "c3", "FLOWS"),   # … chain
        ("c1b", "c9", "FLOWS"),  # a sibling's unrelated lineage — must NOT appear
    ]
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "c1", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=5000,
    ))

    got_edges = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got_edges == {("c0", "c1"), ("c1", "c2"), ("c2", "c3")}
    assert result.upstream_urns == {"c0"}
    assert result.downstream_urns == {"c2", "c3"}


def test_trace_closure_seeds_container_focus_from_leaf_descendants():
    """Tracing a CONTAINER (a Domain with no lineage of its own) seeds from its
    lineage-bearing leaf descendants via CONTAINMENT (down), then walks
    LINEAGE from there. The graph shows ONLY the lineage hop la->lb — the
    containment edges (d1->la, d2->lb) are never rendered as lineage."""
    fake = _TraceFake()
    fake.contain("d1", "la")   # domain d1 ⊃ leaf la
    fake.contain("d2", "lb")   # domain d2 ⊃ leaf lb
    fake.lineage = [("la", "lb", "FLOWS")]   # d1 itself has NO incident lineage
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "d1", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=5000,
    ))

    # Only the lineage hop is a graph edge — containment is NOT a lineage hop.
    got_edges = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got_edges == {("la", "lb")}
    assert "lb" in result.downstream_urns


def test_trace_closure_depth_exhaustion_is_the_frontier():
    """Depth 1/1 on a 5-node chain: the ring the walk STOPPED at (c0 upstream,
    c2 downstream) is the frontier, each carrying the full-graph degree in its
    direction so the canvas can offer '+N more'. What lies beyond (c-1, c3) is
    named by the count, never shipped."""
    fake = _TraceFake()
    fake.lineage = [
        ("c-1", "c0", "FLOWS"),
        ("c0", "c1", "FLOWS"),
        ("c1", "c2", "FLOWS"),
        ("c2", "c3", "FLOWS"),
    ]
    fake.degrees = {
        "c0": {"in": 1, "out": 1},   # one edge in from c-1 — none of it shown
        "c2": {"in": 1, "out": 1},   # one edge out to c3 — none of it shown
    }
    p = _make_provider(fake, hydrate=True)

    result = _run(p.trace_closure(
        "c1", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=5000,
    ))

    assert [(f.urn, f.total_count) for f in result.frontier_up] == [("c0", 1)]
    assert [(f.urn, f.total_count) for f in result.frontier_down] == [("c2", 1)]
    shipped = {n.urn for n in result.nodes}
    assert shipped == {"c1", "c0", "c2"}
    assert "c-1" not in shipped and "c3" not in shipped
    assert result.truncated is False


def test_trace_closure_a_drained_frontier_is_a_dead_end_not_a_frontier():
    """Depth 5 on a 2-hop chain: the walk runs out of GRAPH, not of depth.
    Nothing is left unexpanded, so both frontier lists are empty — a dead end
    reported as a frontier would put a '+N more' chip on a node with nothing
    more behind it."""
    fake = _TraceFake()
    fake.lineage = [("c0", "c1", "FLOWS"), ("c1", "c2", "FLOWS")]
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "c0", upstream_depth=5, downstream_depth=5,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=5000,
    ))

    assert {(e.source_urn, e.target_urn) for e in result.edges} == {
        ("c0", "c1"), ("c1", "c2"),
    }
    assert result.frontier_up == []
    assert result.frontier_down == []
    assert result.truncated is False
    assert result.truncation_reason is None


def test_trace_closure_max_nodes_cut_names_the_hub_and_orphans_no_edge():
    """A hub with 12 downstream children under max_nodes=8: the walk stops
    mid-fan-out. The children it could not ship are absent from `nodes` AND
    their edges are absent too (an edge to a node the canvas never receives
    draws into nothing). The HUB — a node the client HAS — is the frontier
    entry, with the real out-degree so '+N more' can be honest."""
    fake = _TraceFake()
    fake.lineage = [("p", "hub", "FLOWS")] + [
        ("hub", f"c{i}", "FLOWS") for i in range(12)
    ]
    fake.degrees = {
        "hub": {"in": 1, "out": 12},
        "p": {"in": 0, "out": 1},
        **{f"c{i}": {"in": 1, "out": 0} for i in range(12)},
    }
    p = _make_provider(fake, hydrate=True)

    result = _run(p.trace_closure(
        "hub", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=8, timeout_ms=5000,
    ))

    assert result.truncated is True
    assert result.truncation_reason == "max_nodes"
    shipped = {n.urn for n in result.nodes}
    assert len(shipped) == 8
    assert not (shipped & {f"c{i}" for i in range(6, 12)})   # the cut children
    # Orphan-edge invariant: every edge lands on two shipped nodes.
    for e in result.edges:
        assert e.source_urn in shipped and e.target_urn in shipped
    assert [(f.urn, f.total_count) for f in result.frontier_down] == [("hub", 12)]
    # p's whole in-side is shown (in=0), so upstream is an honest dead end.
    assert result.frontier_up == []


def test_trace_closure_seed_urns_walk_every_named_seed_and_what_is_beneath_it():
    """`seed_urns` = a walk CONTINUATION: the caller names where to start,
    so the ANCHOR's own "is this a lineage leaf" probe never fires — the
    walk is not re-derived from a focus the client has already moved past.

    Two rules meet here, and both are about not second-guessing the caller:

    EVERY named seed walks. A seed is an instruction, not a candidate:
    `exclude_urns` governs what is re-SHIPPED, never where the walk starts.
    This request is the real client's own shape — the card being expanded
    and every leaf under it are nodes it already holds, so they are all in
    `exclude_urns` too — and dropping them left the walk with an empty seed
    and the reader with a click that did nothing.

    AND a seed that stands for finer things resolves to them: the
    containment descent DOES run, over the seeds themselves rather than
    over the anchor, because a card the reader never opened is the only
    name they can send and a container carries no lineage of its own."""
    fake = _TraceFake()
    fake.contain("dom", "leaf_a")
    fake.lineage = [
        ("leaf_a", "leaf_b", "FLOWS"),
        ("dom", "d_out", "FLOWS"),
        ("ghost", "g_out", "FLOWS"),
    ]
    p = _make_provider(fake)
    seen = []
    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        seen.append(cypher)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    result = _run(p.trace_closure(
        "dom", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
        seed_urns=["dom", "leaf_a", "ghost"],
        exclude_urns=["dom", "leaf_a", "ghost"],
    ))

    # The anchor's own leaf probe never fires...
    assert all("RETURN f.urn AS urn, labels(f)[0] AS label" not in c for c in seen)
    # ...but the descent does, asked of the SEEDS ($seeds), not the anchor.
    descent = [c for c in seen if "RETURN DISTINCT d.urn AS urn" in c]
    assert len(descent) >= 1
    assert all("$seeds" in c for c in descent)
    got_edges = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got_edges == {("leaf_a", "leaf_b"), ("dom", "d_out"), ("ghost", "g_out")}
    assert "g_out" in result.downstream_urns


def test_trace_closure_a_container_seed_resolves_to_its_lineage_bearing_leaves():
    """The ⊕ on a card the reader has never opened. The client holds the
    card and nothing inside it, so the card's own urn is the only seed it
    can name — and a container carries no lineage of its own, its leaves
    do. Taken literally, that seed walked a node with no lineage on it and
    returned an empty hop set with no frontier and no error."""
    fake = _TraceFake()
    fake.contain("tbl", "col_a")
    fake.contain("tbl", "col_b")
    fake.lineage = [("up_a", "col_a", "FLOWS"), ("up_b", "col_b", "FLOWS")]
    p = _make_provider(fake, hydrate=True)

    result = _run(p.trace_closure(
        "tbl", upstream_depth=1, downstream_depth=0,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
        seed_urns=["tbl"], exclude_urns=["tbl"],
    ))

    assert {(e.source_urn, e.target_urn) for e in result.edges} == {
        ("up_a", "col_a"), ("up_b", "col_b"),
    }
    assert sorted(result.upstream_urns) == ["up_a", "up_b"]


def test_trace_closure_exclude_urns_keep_the_seam_edge_not_the_node():
    """`exclude_urns` = what the client already holds: never re-shipped as a
    NODE, but every EDGE into one still ships — that is the seam that stitches
    this step onto the graph the client has. Uniform at EVERY hop, including
    the first, and no query ever learns the exclude set."""
    fake = _TraceFake()
    fake.lineage = [("f", "a", "FLOWS"), ("f", "x", "FLOWS"), ("a", "x", "FLOWS")]
    p = _make_provider(fake, hydrate=True)
    seen = []
    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        if "AS otherUrn" in cypher:
            seen.append(cypher)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    result = _run(p.trace_closure(
        "f", upstream_depth=0, downstream_depth=2,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
        exclude_urns=["x"],
    ))

    assert all("$exclude" not in c for c in seen)      # no hop filters in the DB
    shipped = {n.urn for n in result.nodes}
    assert shipped == {"f", "a"}
    got_edges = {(e.source_urn, e.target_urn) for e in result.edges}
    assert ("a", "x") in got_edges                     # the hop-2 seam
    assert ("f", "x") in got_edges                     # and the hop-1 seam


def test_trace_closure_keeps_the_diamond_edge_between_two_held_nodes():
    """THE diamond. f→a, f→x and a→x: one depth-1 click hands the client a and
    x but never a→x, because that edge is two hops from f. Continuing from a
    with both f and x excluded is the only way the client can ever learn it —
    and a DB-side exclusion on hop 1 filtered exactly that row away, losing the
    edge for good while a one-shot depth-2 closure showed it plainly. The union
    of the two shallow steps must equal the deep closure."""
    fake = _TraceFake()
    fake.lineage = [("f", "a", "FLOWS"), ("f", "x", "FLOWS"), ("a", "x", "FLOWS")]
    p = _make_provider(fake, hydrate=True)

    def _closure(**kw):
        return _run(p.trace_closure(
            "f", lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
            max_nodes=100, timeout_ms=5000, **kw,
        ))

    first = _closure(upstream_depth=0, downstream_depth=1)
    assert {(e.source_urn, e.target_urn) for e in first.edges} == {("f", "a"), ("f", "x")}

    second = _closure(
        upstream_depth=0, downstream_depth=1,
        seed_urns=["a"], exclude_urns=["f", "x"],
    )
    # The whole point: the edge arrives, x does not come back with it.
    assert {(e.source_urn, e.target_urn) for e in second.edges} == {("a", "x")}
    assert "x" not in {n.urn for n in second.nodes}

    deep = _closure(upstream_depth=0, downstream_depth=2)
    assert (
        {e.id for e in first.edges} | {e.id for e in second.edges}
        == {e.id for e in deep.edges}
    )


def test_trace_closure_cursor_pages_one_hub_to_exhaustion():
    """The hub fallback: `after_cursor` pages ONE node's adjacency in ONE
    direction instead of walking. A cursor names the NEXT id to consider, so
    "e:0" opens the hub from the start and edge id 0 is reachable — under the
    old exclusive `id(r) > $after` it was unreachable by any cursor the wire
    grammar (`^e:\\d+$`) could express. Pages of 3/3/2 over all 8 edges —
    disjoint, complete, and the anchor keeps its cursor until a page comes
    back short."""
    fake = _TraceFake()
    fake.adjacency[("hub", "outgoing")] = [(f"t{i}", "FLOWS") for i in range(8)]
    # Every partner is DRAINED (nothing downstream of it), so the frontier
    # below is the hub and nothing else — an assertion about what the probe
    # rules out, not about partners the fake forgot to describe.
    fake.degrees = {
        "hub": {"in": 0, "out": 8},
        **{f"t{i}": {"in": 1, "out": 0} for i in range(8)},
    }
    p = _make_provider(fake)

    def _page(cursor):
        return _run(p.trace_closure(
            "hub", upstream_depth=0, downstream_depth=1,
            lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
            max_nodes=3, timeout_ms=5000, after_cursor=cursor,
        ))

    page1 = _page("e:0")
    assert [f.urn for f in page1.frontier_down] == ["hub"]
    assert page1.frontier_down[0].next_cursor == "e:3"
    assert page1.frontier_down[0].total_count == 8
    assert page1.downstream_urns == {"t0", "t1", "t2"}   # t0 rides on edge id 0

    page2 = _page(page1.frontier_down[0].next_cursor)
    assert page2.frontier_down[0].next_cursor == "e:6"
    assert page2.downstream_urns == {"t3", "t4", "t5"}

    page3 = _page(page2.frontier_down[0].next_cursor)
    assert page3.downstream_urns == {"t6", "t7"}
    assert page3.frontier_down == []        # short page = the hub is drained

    seen = [e.id for e in page1.edges] + [e.id for e in page2.edges] + [e.id for e in page3.edges]
    assert len(seen) == len(set(seen)) == 8

    # Paging keeps the walk's exclusion discipline: a node the client already
    # holds keeps its EDGE (the seam) but is not re-shipped and is not filed
    # under a direction again.
    excluded_page = _run(p.trace_closure(
        "hub", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=3, timeout_ms=5000, after_cursor="e:0",
        exclude_urns=["t1"],
    ))
    assert excluded_page.downstream_urns == {"t0", "t2"}
    assert len(excluded_page.edges) == 3


def test_trace_closure_a_paged_partner_carries_its_own_frontier():
    """A partner discovered on a CURSOR PAGE was never walked FROM — the page
    read the anchor's adjacency, not the partner's — so it is a boundary node
    exactly like a depth-exhausted ring, and it gets the same treatment: probed,
    and kept in the frontier when it has more than the client can see.

    Filing it under no direction at all was the bug. Every paged-in partner
    shipped with no frontier entry and no probe, and a node with no entry is
    what the lens stamps "no further lineage — the walk ends here". A drained
    hub's partners were told the truth by accident; a live one's were not."""
    fake = _TraceFake()
    fake.adjacency[("hub", "outgoing")] = [(f"t{i}", "FLOWS") for i in range(4)]
    fake.adjacency[("sink", "incoming")] = [(f"u{i}", "FLOWS") for i in range(4)]
    fake.degrees = {
        "hub": {"in": 0, "out": 4},
        "sink": {"in": 4, "out": 0},
        # Three partners have lineage of their own; the fourth is a dead end.
        **{f"t{i}": {"in": 1, "out": 2} for i in range(3)},
        "t3": {"in": 1, "out": 0},
        **{f"u{i}": {"in": 3, "out": 1} for i in range(3)},
        "u3": {"in": 0, "out": 1},
    }
    p = _make_provider(fake)

    page = _run(p.trace_closure(
        "hub", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=4, timeout_ms=5000, after_cursor="e:0",
    ))

    entries = {f.urn: f for f in page.frontier_down}
    assert [entries[f"t{i}"].total_count for i in range(3)] == [2, 2, 2]
    # No cursor on a partner: nothing about IT was left half-read, so its
    # affordance is a re-root via seedUrns, never a resume of someone else's
    # page. (The anchor's own entry keeps the resume.)
    assert all(entries[f"t{i}"].next_cursor is None for i in range(3))
    assert entries["hub"].next_cursor == "e:4"
    # t3 has everything it owns already on screen: an honest dead end, and
    # the fix must not invent a pill for it.
    assert "t3" not in entries
    assert page.frontier_up == []

    # The upstream page files its partners under UP, not under the direction
    # the downstream page happens to use.
    up_page = _run(p.trace_closure(
        "sink", upstream_depth=1, downstream_depth=0,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=4, timeout_ms=5000, after_cursor="e:0",
    ))
    up_entries = {f.urn: f for f in up_page.frontier_up}
    assert [up_entries[f"u{i}"].total_count for i in range(3)] == [3, 3, 3]
    assert "u3" not in up_entries          # in-degree 0: nothing behind it
    assert up_page.frontier_down == []


def test_trace_closure_rejects_an_unreadable_cursor():
    """The endpoint guarantees `e:<int>`; the provider still refuses garbage
    rather than silently paging from the start (which would re-ship a page the
    client already has)."""
    fake = _TraceFake()
    p = _make_provider(fake)

    try:
        _run(p.trace_closure(
            "hub", upstream_depth=0, downstream_depth=1,
            lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
            max_nodes=3, timeout_ms=5000, after_cursor="e:not-an-int",
        ))
    except ValueError as exc:
        assert "invalid cursor" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_trace_closure_a_capped_seed_still_walks_and_still_says_so():
    """A fat container: 8 lineage-bearing leaves, budget 8. The walk is
    degree-exact: it walks as many leaves as FIT (each with its whole hop) and
    names the first it could not afford as the seed cursor — the user sees real
    lineage, never a board of nodes with no edges on it. The response still
    admits both partial truths: `seedTruncated` for the leaves it never walked,
    `truncationReason` for the caller that reads one flag."""
    fake = _TraceFake()
    for i in range(1, 9):
        fake.contain("dom", f"leaf_{i}")
        fake.lineage.append((f"leaf_{i}", f"sink_{i}", "FLOWS"))
    fake.degrees = {
        **{f"leaf_{i}": {"in": 0, "out": 1} for i in range(1, 9)},
        **{f"sink_{i}": {"in": 1, "out": 0} for i in range(1, 9)},
    }
    p = _make_provider(fake, hydrate=True)

    result = _run(p.trace_closure(
        "dom", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=8, timeout_ms=5000,
    ))

    assert result.seed_truncated is True
    assert result.truncated is True
    assert result.truncation_reason == "max_nodes"
    # THE point: lineage actually came back, and every leaf that came back
    # came back WHOLE. Room 7, one leaf + one sink each: three leaves.
    got_edges = {(e.source_urn, e.target_urn) for e in result.edges}
    assert got_edges == {("leaf_1", "sink_1"), ("leaf_2", "sink_2"), ("leaf_3", "sink_3")}
    shipped = {n.urn for n in result.nodes}
    assert len(shipped) == 7
    # A leaf the page could not afford is never shipped half-done — it is the
    # cursor (inclusive-next), not a board of nodes with no edges on them.
    assert "leaf_4" not in shipped
    assert result.frontier_down == []
    assert result.seed_cursor == "s:leaf_4"


def test_trace_closure_a_clean_walk_off_a_capped_seed_is_still_partial():
    """A partial SEED has to survive a walk that goes perfectly. Every walked
    leaf completes inside its budget, so nothing in the hops sets a truncation
    reason — and the answer is STILL partial, because the leaves it walked were
    only some of the container's. Drop that fold and the response quietly
    claims to be the whole picture."""
    fake = _TraceFake()
    for i in range(1, 5):
        fake.contain("dom", f"leaf_{i}")
    fake.lineage = [
        ("leaf_1", "sink_1", "FLOWS"),
        ("leaf_2", "sink_2", "FLOWS"),
        # leaf_3/leaf_4 carry lineage too — incoming, so they seed but add no
        # downstream hop of their own.
        ("src_3", "leaf_3", "FLOWS"),
        ("src_4", "leaf_4", "FLOWS"),
    ]
    fake.degrees = {f"sink_{i}": {"in": 1, "out": 0} for i in (1, 2)}
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "dom", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=5, timeout_ms=5000,
    ))

    assert {(e.source_urn, e.target_urn) for e in result.edges} == {
        ("leaf_1", "sink_1"), ("leaf_2", "sink_2"),
    }
    assert result.frontier_down == []       # every walked leaf is whole; nothing half-read
    assert result.seed_cursor == "s:leaf_3"  # leaf_3 and leaf_4 wait for the next page
    assert result.seed_truncated is True
    assert result.truncated is True
    assert result.truncation_reason == "max_nodes"


def test_trace_closure_asks_each_hop_for_only_what_still_fits():
    """Each expansion asks for exactly what the anchors' degrees promise, plus
    one — the extra row is the concurrent-write tripwire. Asking for the whole
    budget every hop fetched rows the budget check could only throw away —
    paid for in the database, dropped in Python, each taking its edge down."""
    fake = _TraceFake()
    fake.lineage = [
        ("f", "a1", "FLOWS"), ("f", "a2", "FLOWS"),
        ("a1", "b1", "FLOWS"), ("a2", "b2", "FLOWS"),
    ]
    p = _make_provider(fake)
    limits = []
    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        if "AS otherUrn" in cypher:
            limits.append(params["limit"])
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    result = _run(p.trace_closure(
        "f", upstream_depth=0, downstream_depth=2,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=20, timeout_ms=5000,
    ))

    # Hop 1: f has out-degree 2 → LIMIT 3. Hop 2: a1 + a2 have 1 each → LIMIT 3.
    assert limits == [3, 3]
    assert len(result.edges) == 4
    assert result.truncated is False


def test_trace_closure_cut_and_exclusion_leave_no_edge_pointing_at_nothing():
    """The two rules composed, which is where an invariant usually dies: a hop
    cut by `max_nodes` AND a seam edge into an excluded node, in one response.
    Every edge endpoint must be either shipped in `nodes` or already held by the
    client — those are the only two ways the canvas can draw it."""
    fake = _TraceFake()
    fake.lineage = [
        ("p1", "f", "FLOWS"),       # hop 1 upstream
        ("q1", "p1", "FLOWS"),      # hop 2 upstream: fills the budget …
        ("q2", "p1", "FLOWS"),
        ("q3", "p1", "FLOWS"),
        ("f", "d1", "FLOWS"),       # hop 1 downstream
        ("d1", "known", "FLOWS"),   # hop 2 downstream: the seam
        ("d1", "e1", "FLOWS"),      # … and what the budget cut off
        ("d1", "e2", "FLOWS"),
    ]
    p = _make_provider(fake, hydrate=True)

    result = _run(p.trace_closure(
        "f", upstream_depth=2, downstream_depth=2,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=6, timeout_ms=5000,
        exclude_urns=["known"],
    ))

    assert result.truncation_reason == "max_nodes"
    shipped = {n.urn for n in result.nodes}
    assert "known" not in shipped
    drawable = shipped | {"known"}
    for e in result.edges:
        assert e.source_urn in drawable and e.target_urn in drawable
    got_edges = {(e.source_urn, e.target_urn) for e in result.edges}
    # Room 3 at hop 2, split between the sides: p1 needs 3 new nodes and does
    # not fit up's share of 2; d1 needs 2 (the seam into `known` costs nothing)
    # and is walked WHOLE, including the edges the old ring cut dropped.
    assert ("d1", "known") in got_edges      # the seam survived …
    assert ("d1", "e1") in got_edges and ("d1", "e2") in got_edges
    assert ("q1", "p1") not in got_edges     # … and nothing half-read was shipped
    # p1 is re-offered as a cursor-less cut entry with its real degree.
    assert [(f.urn, f.total_count, f.next_cursor, f.reason) for f in result.frontier_up] == [
        ("p1", 3, None, "cut"),
    ]


def test_trace_closure_keeps_parallel_edges_between_one_pair():
    """Two distinct edges between the same pair are two facts, not one. The
    dedup key is the edge id — dedup on (source, target) would silently merge
    a 'reads' and a 'writes' into whichever arrived first."""
    fake = _TraceFake()
    fake.lineage = [("a", "b", "FLOWS"), ("a", "b", "READS")]
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "a", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS", "READS"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=5000,
    ))

    assert len(result.edges) == 2
    assert {e.edge_type for e in result.edges} == {"FLOWS", "READS"}
    assert {(e.source_urn, e.target_urn) for e in result.edges} == {("a", "b")}


def test_trace_closure_frontier_probe_says_unknown_and_drops_the_drained():
    """Probe honesty, both halves. A candidate the degree probe could not
    answer for keeps its entry with NO count (absence is unknown, never zero).
    A candidate whose whole adjacency is already on screen is DROPPED — it has
    nothing more to offer."""
    fake = _TraceFake()
    fake.lineage = [
        ("c-1", "c0", "FLOWS"),
        ("c0", "c1", "FLOWS"),
        ("c1", "c2", "FLOWS"),
    ]
    fake.degrees = {"c2": {"in": 1, "out": 0}}   # c0 absent = unknown
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "c1", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=5000,
    ))

    assert [(f.urn, f.total_count) for f in result.frontier_up] == [("c0", None)]
    assert result.frontier_down == []


def test_trace_closure_a_hop_that_hits_its_own_limit_still_reports_truncated():
    """The silent-truncation trap. One direction, 12 children, max_nodes 8: the
    hub cannot fit the page, so it is PAGED — 7 rows by edge id — and the
    response says so with a real cursor. Without noticing the page came back
    FULL, the response would claim `truncated: false` while five children it
    never asked about sat in the graph — the client would believe it had the
    hub's whole fan-out."""
    fake = _TraceFake()
    fake.lineage = [("hub", f"c{i}", "FLOWS") for i in range(12)]
    fake.degrees = {
        "hub": {"in": 0, "out": 12},
        **{f"c{i}": {"in": 1, "out": 0} for i in range(12)},
    }
    p = _make_provider(fake, hydrate=True)

    result = _run(p.trace_closure(
        "hub", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=8, timeout_ms=5000,
    ))

    assert len({n.urn for n in result.nodes}) == 8
    assert result.truncated is True
    assert result.truncation_reason == "max_nodes"
    assert [(f.urn, f.total_count) for f in result.frontier_down] == [("hub", 12)]
    # A paged hub resumes exactly one past the last edge id it shipped (ids
    # 0..6) — never `e:0`, which would re-ship the page the client holds.
    assert result.frontier_down[0].next_cursor == "e:7"
    assert result.frontier_down[0].reason == "cut"


def test_trace_closure_asymmetric_depth_keeps_the_shallow_side_frontier():
    """Upstream 1, downstream 3: the upstream ring is done two hops before the
    walk is. It still has to survive as frontier — otherwise asking for less
    upstream would report upstream as EXHAUSTED, which is the opposite of what
    the user asked for."""
    fake = _TraceFake()
    fake.lineage = [
        ("c-1", "c0", "FLOWS"),
        ("c0", "c1", "FLOWS"),
        ("c1", "c2", "FLOWS"),
        ("c2", "c3", "FLOWS"),
    ]
    fake.degrees = {"c0": {"in": 1, "out": 1}, "c3": {"in": 1, "out": 0}}
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "c1", upstream_depth=1, downstream_depth=3,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=5000,
    ))

    assert result.downstream_urns == {"c2", "c3"}
    assert [(f.urn, f.total_count) for f in result.frontier_up] == [("c0", 1)]
    # Nothing about c0 was left half-read — it ran out of DEPTH, not budget —
    # so it gets no cursor. Its affordance is a re-root via seedUrns, and a
    # cursor here would promise a continuation that does not exist.
    assert result.frontier_up[0].next_cursor is None
    # Downstream reached the end of the graph before the end of its depth.
    assert result.frontier_down == []


def test_trace_closure_short_budget_drops_the_counts_not_the_frontier():
    """With less than the probe's budget left, the frontier still names every
    boundary node — it just admits it does not know how much is behind them.
    Spending the last of the deadline on '+N' counts would risk the 504 the
    whole method is shaped to avoid."""
    fake = _TraceFake()
    fake.lineage = [("c-1", "c0", "FLOWS"), ("c0", "c1", "FLOWS"), ("c1", "c2", "FLOWS")]
    fake.degrees = {"c0": {"in": 1, "out": 1}, "c2": {"in": 1, "out": 1}}
    p = _make_provider(fake)

    result = _run(p.trace_closure(
        "c1", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"],
        max_nodes=1000, timeout_ms=1000,   # < the 1.5s probe gate
    ))

    assert [(f.urn, f.total_count) for f in result.frontier_up] == [("c0", None)]
    assert [(f.urn, f.total_count) for f in result.frontier_down] == [("c2", None)]
