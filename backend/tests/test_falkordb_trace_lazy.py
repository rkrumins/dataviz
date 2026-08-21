"""The LAZY trace — ``FalkorDBProvider.trace_closure_lazy``.

The fine closure walk fetches a focus's whole leaf-grain lineage before the
first paint; measured on the 2.08M-node estate that is 9.7 s for one
attribute. The lazy path replaces it for the FIRST PAINT and for every
EXPANSION: one grain, one hop, no caps, cursors for everything that does not
fit a page.

What these tests pin, in the order the reader meets them:

  * **coarse** (``drill=False``) on a rollup estate ships the focus, its
    chain, the lineage-carrying children INSIDE it, and every partner one
    hop away AT THE ROLLUP'S GRAIN with its weight — and nothing finer. A
    coarse response that leaked the raw column-grain hops would be the
    9.7-second walk again under a new name.
  * **coarse** on a rollup-LESS estate (the pipeline shape: containers all
    the way down, flow only at the leaves) falls back to a raw depth-1
    closure around the focus subtree, because there is no rollup standing
    in for the flow.
  * **drill** ships ONLY the named card's contributing children and THEIR
    hop-1 lineage, with the far endpoints' ancestor chains — a partner the
    client cannot place is a partner it drops, and a dropped partner is then
    miscounted as "outside this view".
  * **cursors, not caps.** A full children page ships ``seedCursor``; a full
    edge page files its anchor in the frontier with ``nextCursor``. Neither
    is a truncation, and ``max_nodes`` cannot truncate this path at all.

The fake answers the exact Cypher SHAPES this path emits. It cannot validate
that the Cypher is *correct* against a real engine (see the live
certification in the task report) — it validates the response CONTRACT: what
ships, what does not, and what the cursors say.
"""
import asyncio
import re

from backend.app.models.graph import GraphNode
from backend.app.providers.falkordb_provider import (
    CLOSURE_LAZY_EDGES_PER_ANCHOR,
    FalkorDBProvider,
)


def _run(coro):
    return asyncio.run(coro)


class _Result:
    def __init__(self, result_set=None):
        self.result_set = result_set or []


class _LazyFake:
    """A small estate, answered through the query shapes the lazy path emits.

    ``lineage`` rows are ``(source, target, edge_type, weight)``; the list
    INDEX is the row's ``id(r)``, so the cursor tests page a stable order.
    """

    def __init__(self):
        self.children = {}      # parent urn -> [child urn]
        self.parent = {}        # child urn -> parent urn
        self.labels = {}        # urn -> label
        self.lineage = []       # (src, tgt, type, weight)
        self.queries = []       # every cypher this fake was asked

    def contain(self, parent, child):
        self.children.setdefault(parent, []).append(child)
        self.parent[child] = parent

    def label(self, urn, label):
        self.labels[urn] = label
        return urn

    def flow(self, src, tgt, edge_type="FLOWS", weight=None):
        self.lineage.append((src, tgt, edge_type, weight))

    def rollup(self, src, tgt, weight):
        self.lineage.append((src, tgt, "AGGREGATED", weight))

    # -- graph helpers the fake answers from -------------------------------

    def _incident(self, urn, lane):
        return [row for row in self.lineage
                if (row[0] == urn or row[1] == urn) and row[2] in lane]

    def _descendants(self, urn):
        out, stack = [], list(self.children.get(urn, []))
        while stack:
            u = stack.pop()
            out.append(u)
            stack.extend(self.children.get(u, []))
        return out

    def _lane_of(self, cypher):
        """The rel-type alternation the query asked for, as a set — from
        both the bound (`[r:A|B]`) and the anonymous (`[:A|B]`) forms."""
        types = set()
        for head in re.findall(r"\[\w*:([A-Z_|]+)", cypher):
            types.update(t for t in head.split("|") if t)
        return types

    # -- the query surface --------------------------------------------------

    async def ro_query(self, cypher, params=None, timeout=None, **kwargs):
        params = params or {}
        self.queries.append(cypher)

        # _lineage_children_page, shallow: direct children carrying lineage.
        if "RETURN c.urn AS urn" in cypher and "DISTINCT" not in cypher:
            lane = self._lane_of(cypher) - {"HAS"}
            rows = []
            for c in sorted(self.children.get(params["urn"], [])):
                if params.get("after") and c <= params["after"]:
                    continue
                if self._incident(c, lane):
                    rows.append([c, self.labels.get(c, "")])
            return _Result(rows[:params["lim"]])

        # _lineage_children_page, deep: children that only HOST the lineage.
        if "RETURN DISTINCT c.urn AS urn" in cypher:
            lane = self._lane_of(cypher) - {"HAS"}
            rows = []
            for c in sorted(self.children.get(params["urn"], [])):
                if params.get("after") and c <= params["after"]:
                    continue
                if any(self._incident(d, lane) for d in self._descendants(c)):
                    rows.append([c, self.labels.get(c, "")])
            return _Result(rows[:params["lim"]])

        # _page_raw_lineage_single: one anchor, one direction, id-ordered.
        if "WHERE id(r) >= $after" in cypher:
            lane = self._lane_of(cypher)
            incoming = "<-[r" in cypher
            urn = params["urn"]
            rows = []
            for eid, (s, t, et, w) in enumerate(self.lineage):
                if et not in lane or eid < params["after"]:
                    continue
                if incoming and t == urn:
                    rows.append([eid, s, t, et, w, s, self.labels.get(s, "")])
                elif not incoming and s == urn:
                    rows.append([eid, s, t, et, w, t, self.labels.get(t, "")])
            return _Result(rows[:params["limit"]])

        # _expand_raw_lineage_set: one hop for a whole frontier.
        if "AS otherUrn" in cypher:
            lane = self._lane_of(cypher)
            incoming = "<-[r" in cypher
            frontier = set(params.get("frontier", []))
            rows = []
            for eid, (s, t, et, w) in enumerate(self.lineage):
                if et not in lane:
                    continue
                if incoming and t in frontier:
                    other = s
                elif not incoming and s in frontier:
                    other = t
                else:
                    continue
                rows.append([s, t, f"e{eid}", et, w, other, self.labels.get(other, "")])
            return _Result(rows[:params["limit"]])

        # _collect_lineage_seed, part 1: does the focus itself carry lineage?
        if "RETURN f.urn AS urn, labels(f)[0] AS label" in cypher:
            lane = self._lane_of(cypher) - {"HAS"}
            urn = params["urn"]
            if self._incident(urn, lane):
                return _Result([[urn, self.labels.get(urn, "")]])
            return _Result([])

        # _collect_lineage_seed, part 2: which descendants carry lineage?
        if "RETURN DISTINCT d.urn AS urn" in cypher:
            lane = self._lane_of(cypher) - {"HAS"}
            rows = [[d, self.labels.get(d, "")]
                    for d in sorted(self._descendants(params["urn"]))
                    if self._incident(d, lane)]
            return _Result(rows[:params["cap"]])

        return _Result([])

    async def proj_ro_query(self, cypher, params=None, timeout=None, **kwargs):
        return _Result([])


def _make_provider(fake):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    p._ro_query = fake.ro_query
    p._proj_ro_query = fake.proj_ro_query

    async def _noop():
        return None

    async def _get_node(urn):
        return GraphNode(urn=urn, entityType=fake.labels.get(urn, ""), displayName=urn)

    async def _batch(urns):
        return [GraphNode(urn=u, entityType=fake.labels.get(u, ""), displayName=u)
                for u in urns]

    async def _batch_detailed(urns):
        # The seam the closure paths hydrate through: (nodes, buckets_failed).
        # Both walks use it, which is how they share `nodes_failed` /
        # `nodes_partial` rather than each inventing a verdict.
        return await _batch(urns), 0

    async def _chains(urns):
        out = {}
        for u in urns:
            chain, cursor = [], fake.parent.get(u)
            while cursor and cursor not in chain:
                chain.append(cursor)
                cursor = fake.parent.get(cursor)
            out[u] = chain
        return out

    p._ensure_connected = _noop
    p.get_node = _get_node
    p.get_nodes_batch = _batch
    p._get_nodes_batch_detailed = _batch_detailed
    p._compute_and_store_ancestors_bulk = _chains
    return p


def _cfo_estate():
    """The rollup estate: raw flow at column grain, :AGGREGATED rollups at
    dataset AND container grain above it — the shape the coarse first paint
    exists for."""
    f = _LazyFake()
    for urn, label in [
        ("tableau", "dataPlatform"), ("cfo", "dashboard"), ("aov", "chart"),
        ("aov.channel", "schemaField"), ("aov.avg", "schemaField"),
        ("snowflake", "dataPlatform"), ("INTERMEDIATE_T2", "container"),
        ("orders", "dataset"), ("orders.channel", "schemaField"), ("orders.net", "schemaField"),
        ("REPORTING", "container"), ("rpt", "dataset"),
        ("rpt.channel", "schemaField"), ("rpt.gross", "schemaField"),
    ]:
        f.label(urn, label)
    for parent, child in [
        ("tableau", "cfo"), ("cfo", "aov"), ("aov", "aov.channel"), ("aov", "aov.avg"),
        ("snowflake", "INTERMEDIATE_T2"), ("snowflake", "REPORTING"),
        ("INTERMEDIATE_T2", "orders"), ("orders", "orders.channel"), ("orders", "orders.net"),
        ("REPORTING", "rpt"), ("rpt", "rpt.channel"), ("rpt", "rpt.gross"),
    ]:
        f.contain(parent, child)
    f.flow("orders.channel", "aov.channel")
    f.flow("orders.net", "aov.avg")
    f.flow("rpt.gross", "aov.avg")
    f.rollup("orders", "aov", 2)
    f.rollup("rpt", "aov", 1)
    f.rollup("INTERMEDIATE_T2", "cfo", 2)
    f.rollup("REPORTING", "cfo", 1)
    return f


def _pipeline_estate(depth=3):
    """The rollup-LESS estate: ROOT ⊃ aN ⊃ … with the flow only at the
    deepest level and no :AGGREGATED anywhere. Coarse has no rollup to read,
    so it must fall back to a raw depth-1 closure around the focus subtree."""
    f = _LazyFake()
    f.label("ROOT", "Roots")
    for chain in ("a", "b"):
        parent = "ROOT"
        for d in range(1, depth + 1):
            urn = f"{chain}{d}"
            f.label(urn, "Node")
            f.contain(parent, urn)
            parent = urn
    f.flow(f"a{depth}", f"b{depth}")
    return f


def _lazy(p, urn, **kw):
    kw.setdefault("upstream_depth", 1)
    kw.setdefault("downstream_depth", 1)
    kw.setdefault("lineage_edge_types", ["FLOWS"])
    kw.setdefault("containment_edge_types", ["HAS"])
    kw.setdefault("aggregated_edge_type", "AGGREGATED")
    kw.setdefault("drill", False)
    kw.setdefault("page_size", 100)
    kw.setdefault("timeout_ms", 5000)
    return _run(p.trace_closure_lazy(urn=urn, **kw))


# ── coarse: the rollup estate ───────────────────────────────────────────


def test_coarse_ships_the_focus_its_chain_its_contents_and_hop_1_partners():
    """The R1 first paint, exactly: the focus (cfo) open over the contents
    that carry lineage (aov), anchored by its chain (tableau), with the two
    partners one hop upstream at the grain the rollup lane states them
    (INTERMEDIATE_T2, REPORTING) and THEIR chain (snowflake). Nothing else —
    the reader has opened nothing yet."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo")

    assert {n.urn for n in res.nodes} == {
        "cfo", "aov", "tableau", "INTERMEDIATE_T2", "REPORTING", "snowflake",
    }
    assert res.upstream_urns == {"INTERMEDIATE_T2", "REPORTING"}
    assert res.downstream_urns == set()


def test_coarse_draws_at_the_rollup_grain_and_carries_the_weight():
    """A rollup without its weight is a line with no number on it: the
    client's grain rule reads `properties.weight` to decide what a coarse
    wire still has left to say against the raw detail beneath it."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo")

    drawn = {(e.source_urn, e.target_urn): e for e in res.edges}
    assert set(drawn) == {("INTERMEDIATE_T2", "cfo"), ("REPORTING", "cfo")}
    assert all(e.edge_type == "AGGREGATED" for e in res.edges)
    assert drawn[("INTERMEDIATE_T2", "cfo")].properties["weight"] == 2
    assert drawn[("REPORTING", "cfo")].properties["weight"] == 1


def test_coarse_ships_no_raw_hop_and_nothing_below_the_partner_grain():
    """THE POINT OF THE WHOLE PATH. The estate's raw column-grain hops
    (orders.channel → aov.channel and friends) exist and are reachable in one
    containment step from what shipped — and none of them is here. A coarse
    response that leaked them would be the eager walk again."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo")

    shipped = {n.urn for n in res.nodes}
    assert not any(e.edge_type != "AGGREGATED" for e in res.edges)
    for finer in ("orders", "rpt", "orders.channel", "orders.net", "rpt.gross", "aov.avg"):
        assert finer not in shipped, f"{finer} is below the partner grain"


def test_coarse_ships_the_containment_for_everything_it_ships():
    """A partner the client cannot anchor is a partner it drops — and a
    dropped partner is then counted as 'outside this view', which is the one
    lie a lazy trace must not tell about its own results."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo")

    pairs = {(e.source_urn, e.target_urn) for e in res.containment_edges}
    assert pairs == {
        ("tableau", "cfo"), ("cfo", "aov"),
        ("snowflake", "INTERMEDIATE_T2"), ("snowflake", "REPORTING"),
    }


def test_coarse_is_never_a_truncation():
    """No node cap exists on this path: `page_size` is a page, and a page
    that fills says so with a cursor, never with `truncated`."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo", page_size=1)

    assert res.truncated is False
    assert res.truncation_reason is None


# ── coarse: the rollup-less estate ──────────────────────────────────────


def test_coarse_without_a_rollup_lane_falls_back_to_a_raw_depth_1_closure():
    """No :AGGREGATED anywhere, and the focus (a1) carries no lineage of its
    own — its DESCENDANT does. Coarse seeds from the lineage-bearing
    descendants and takes their one hop, which is the raw depth-1 closure
    around the focus subtree."""
    p = _make_provider(_pipeline_estate(depth=3))
    res = _lazy(p, "a1")

    assert {n.urn for n in res.nodes} == {"a1", "a2", "a3", "b3", "b2", "b1", "ROOT"}
    assert [(e.source_urn, e.target_urn, e.edge_type) for e in res.edges] == [
        ("a3", "b3", "FLOWS"),
    ]
    assert res.downstream_urns == {"b3"}


def test_coarse_reaches_the_lineage_through_containers_that_only_host_it():
    """`a1`'s child `a2` carries no lineage edge itself — `a3` beneath it
    does. The child still has to ship, or the reader has no way down to the
    flow at all (the pipeline estates are containers all the way down)."""
    p = _make_provider(_pipeline_estate(depth=3))
    res = _lazy(p, "ROOT")

    shipped = {n.urn for n in res.nodes}
    assert {"a1", "b1"} <= shipped, "the hosting children must ship"


# ── drill ────────────────────────────────────────────────────────────────


def test_drill_ships_only_the_card_s_contributing_children():
    """Opening INTERMEDIATE_T2 asks about INTERMEDIATE_T2, and nothing else.
    Its sibling REPORTING's contents are not part of that question."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "INTERMEDIATE_T2", drill=True)

    shipped = {n.urn for n in res.nodes}
    assert "orders" in shipped
    assert "rpt" not in shipped
    assert "orders.channel" not in shipped, "a drill is ONE level, not a subtree"


def test_drill_refines_the_wires_to_the_grain_it_revealed():
    """The reason to open a card: the wire that ended at INTERMEDIATE_T2 now
    has a finer statement to make (orders → aov, weight 2) and the client's
    grain rule retires the coarse one against it."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "INTERMEDIATE_T2", drill=True)

    drawn = {(e.source_urn, e.target_urn): e for e in res.edges}
    assert set(drawn) == {("orders", "aov")}
    assert drawn[("orders", "aov")].properties["weight"] == 2


def test_drill_ships_the_far_endpoint_s_whole_chain():
    """`aov` is the other end of the newly-revealed wire. Without cfo and
    tableau the client cannot place it, would drop the wire, and would then
    report the pair as unplaceable."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "INTERMEDIATE_T2", drill=True)

    shipped = {n.urn for n in res.nodes}
    assert {"aov", "cfo", "tableau"} <= shipped
    pairs = {(e.source_urn, e.target_urn) for e in res.containment_edges}
    assert {("tableau", "cfo"), ("cfo", "aov"), ("INTERMEDIATE_T2", "orders")} <= pairs


def test_drill_down_to_leaf_grain_reaches_the_raw_hops():
    """One more level: `orders`' children carry the RAW flow, so drilling it
    is where the column-grain hops finally arrive — on demand, for the one
    card the reader opened."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "orders", drill=True)

    assert {(e.source_urn, e.target_urn, e.edge_type) for e in res.edges} == {
        ("orders.channel", "aov.channel", "FLOWS"),
        ("orders.net", "aov.avg", "FLOWS"),
    }
    assert {"orders.channel", "orders.net", "aov.channel", "aov.avg"} <= {n.urn for n in res.nodes}


def test_drill_one_level_of_a_pipeline_estate_is_one_level():
    """Roots ⊃ a1 ⊃ a2 ⊃ a3: opening ROOT reveals a1 and b1, and stops. The
    reader walks the chain a level per click; nothing pre-loads the depth."""
    p = _make_provider(_pipeline_estate(depth=3))
    res = _lazy(p, "ROOT", drill=True)

    shipped = {n.urn for n in res.nodes}
    assert {"a1", "b1"} <= shipped
    assert "a2" not in shipped and "b2" not in shipped


# ── cursors, not caps ────────────────────────────────────────────────────


def test_a_full_children_page_ships_a_keyset_cursor_and_the_next_page_resumes():
    """`snowflake` holds two lineage-carrying containers. At a page size of
    one, the first response says so with `seedCursor` — and the continuation
    picks up strictly past it rather than re-shipping page one."""
    p = _make_provider(_cfo_estate())
    first = _lazy(p, "snowflake", drill=True, page_size=1)

    assert first.seed_truncated is True
    assert first.seed_cursor == "s:INTERMEDIATE_T2"
    assert first.truncated is False, "a page is not a truncation"

    second = _lazy(p, "snowflake", drill=True, page_size=1, seed_cursor=first.seed_cursor)
    assert "REPORTING" in {n.urn for n in second.nodes}
    assert "INTERMEDIATE_T2" not in {n.urn for n in second.nodes}


def test_a_page_that_fits_files_no_cursor_at_all():
    """A page is bounded by its ANCHORS, and an expansion whose edges all fit
    is FINISHED. Bounding it by edges instead was measured at 837 cursors —
    837 follow-up requests — for one drill of a 751-child layer, because a
    tripped hop cannot say which anchor's rows it dropped."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "aov", drill=True, downstream_depth=0)

    assert res.truncated is False
    assert all(f.next_cursor is None for f in res.frontier_up)


def test_a_page_full_of_edges_resumes_with_ONE_cursor_not_a_storm():
    """The measured failure this shape exists to prevent: a layer whose 29
    objects carry 6,557 rollup edges between them used to trip a flat limit
    and file 476 per-anchor cursors — 476 requests to finish ONE expansion.
    The page now stops at its edge ceiling and resumes with the keyset
    cursor over the card's contents: exactly one."""
    f = _LazyFake()
    f.label("layer", "layer")
    for i in range(60):
        kid = f.label(f"obj{i:03d}", "object")
        f.contain("layer", kid)
        for j in range(300):
            f.rollup(kid, f.label(f"far{i:03d}_{j:03d}", "object"), 1)
    p = _make_provider(f)
    res = _lazy(p, "layer", drill=True, upstream_depth=0)

    assert res.truncated is False
    assert res.seed_cursor is not None, "an unfinished page must resume"
    assert res.seed_truncated is True
    assert [f_.next_cursor for f_ in res.frontier_down].count("e:0") == 0, \
        "the ceiling is not a mega-hub — no per-anchor cursors"

    # And the resume is EXACT: the next page starts strictly past the last
    # child this one walked, so no child is walked twice or skipped.
    walked = {n.urn for n in res.nodes if n.urn.startswith("obj")}
    assert res.seed_cursor == f"s:{max(walked)}"
    nxt = _lazy(p, "layer", drill=True, upstream_depth=0, seed_cursor=res.seed_cursor)
    assert not ({n.urn for n in nxt.nodes if n.urn.startswith("obj")} & walked)


def test_a_genuine_hub_still_terminates_with_a_resumable_cursor():
    """The multiple exists so a mega-hub cannot make one page unbounded.
    One child with more incident edges than the fan-out allows trips it, and
    the anchors it could not finish come back resumable — chatty, but never
    a lost edge."""
    f = _LazyFake()
    f.label("box", "container")
    f.label("hub", "dataset")
    f.contain("box", "hub")
    for i in range(CLOSURE_LAZY_EDGES_PER_ANCHOR + 20):
        f.label(f"src{i:04d}", "dataset")
        f.flow(f"src{i:04d}", "hub")
    p = _make_provider(f)
    res = _lazy(p, "box", drill=True, downstream_depth=0)

    assert res.truncated is False, "a page is not a truncation"
    assert {f.urn: f.next_cursor for f in res.frontier_up}.get("hub") == "e:0"


def test_a_cursor_page_returns_that_anchor_s_next_edges_and_nothing_else():
    """The paging shape: one node, one direction, one page. It does not
    re-derive the card's children — the client already has them open."""
    p = _make_provider(_cfo_estate())
    page = _lazy(
        p, "aov.avg", after_cursor="e:0", upstream_depth=1, downstream_depth=0,
        page_size=1,
    )

    assert [(e.source_urn, e.target_urn) for e in page.edges] == [("orders.net", "aov.avg")]
    assert page.frontier_up[0].next_cursor == "e:2", "resume one past the row shipped"

    rest = _lazy(
        p, "aov.avg", after_cursor="e:2", upstream_depth=1, downstream_depth=0,
        page_size=10,
    )
    assert [(e.source_urn, e.target_urn) for e in rest.edges] == [("rpt.gross", "aov.avg")]
    assert rest.frontier_up[0].next_cursor is None, "a short page is the end"


def test_every_partner_is_a_frontier_so_the_counts_read_as_floors():
    """This walk asked ONE hop. What lies beyond a partner is genuinely
    unknown, so each is filed as a boundary the client reads as '+' — and
    with no cursor, because the resume there is a re-root, not a page."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo")

    assert {f.urn for f in res.frontier_up} == {"INTERMEDIATE_T2", "REPORTING"}
    assert all(f.next_cursor is None for f in res.frontier_up)
    assert res.frontier_down == []


def test_max_nodes_can_never_truncate_this_path():
    """The ruling, as a test: 'we cannot be applying limits for this'. Even
    a page size of one over an estate many times that size reports no
    truncation — only cursors."""
    p = _make_provider(_cfo_estate())
    for anchor, drill in (("cfo", False), ("snowflake", True), ("aov", True)):
        res = _lazy(p, anchor, drill=drill, page_size=1)
        assert res.truncation_reason != "max_nodes"
        assert res.truncated is False, f"{anchor} reported a truncation"


# ── direction ────────────────────────────────────────────────────────────


def test_direction_zeroing_is_honoured_on_both_shapes():
    """The engine zeroes the unwanted direction's depth; the lazy walk reads
    that as 'do not ask'. A downstream-only trace of cfo has nothing to say
    (its whole flow is upstream) and must say exactly that."""
    p = _make_provider(_cfo_estate())
    res = _lazy(p, "cfo", upstream_depth=0, downstream_depth=1)

    assert res.edges == []
    assert res.upstream_urns == set()
    assert {n.urn for n in res.nodes} == {"cfo", "aov", "tableau"}
