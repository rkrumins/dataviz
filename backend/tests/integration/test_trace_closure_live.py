"""LIVE FalkorDB coverage for the focus-scoped trace closure walk.

WHY THIS EXISTS. ``test_falkordb_trace_structural.py`` fakes ``_ro_query`` and
pattern-matches Cypher STRINGS. That cannot prove the Cypher is even valid.
It shipped a query FalkorDB rejects outright —

    WITH [f] + collect(DISTINCT d) AS cands
    → _AR_EXP_UpdateEntityIdx: Unable to locate a value with alias f

— while the unit suite stayed green, silently breaking the container-focus
seed ("trace a Data Domain" returned an empty closure). Only a live engine
catches that class of bug, so every Cypher the closure emits gets exercised
here against a real one: the two seed probes, the per-hop expand, the cursor
page, the degree probe, the ancestor hydration, the containment fetch.

Each estate gets its OWN throwaway ``gvt_lens_live_*`` graph, DELETED in the
fixture's finally — this runs against the SHARED dev FalkorDB, where a leaked
graph outlives the run.

Run:
    docker run --rm --network synodic-dev_default --entrypoint sh \
      -e FALKORDB_HOST=falkordb -e CACHE_REDIS_URL=redis://redis:6379/3 \
      -v "$PWD/backend:/app/backend" -w /app synodic-viz-test \
      -c "python -m pytest backend/tests/integration/test_trace_closure_live.py -q"
"""
import os

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider

pytestmark = pytest.mark.integration

LTYPES = ["FLOWS_TO"]
CTYPES = ["CONTAINS"]


@pytest.fixture()
async def estate():
    """Build a provider on a dedicated throwaway graph and seed it.

    Connect, skip if the engine is unreachable, configure containment the way
    ``ContextEngine._resolve_ontology`` does before calling the provider (or
    ancestor hydration cannot classify containment), seed, hand the provider
    back. The teardown DELETES every graph it built.

    The provider's Redis namespace is flushed first: URN labels and ancestor
    chains cache under ``host:port:graph_name``, so a previous run of the same
    test would otherwise grade an edited estate against a stale containment
    tree — a live gate that reads its answer out of a cache is not a gate.
    """
    built = []

    async def _make(name, seed_cypher, ctypes=CTYPES):
        p = FalkorDBProvider(
            host=os.getenv("FALKORDB_HOST", "falkordb"),
            port=int(os.getenv("FALKORDB_PORT", "6379")),
            graph_name=name,
        )
        try:
            await p._ensure_connected()
        except Exception as exc:  # pragma: no cover - env-dependent
            pytest.skip(f"FalkorDB unreachable: {exc}")
        built.append(p)
        p.set_containment_edge_types(ctypes)
        if p._redis is not None:
            try:
                async for key in p._redis.scan_iter(match=f"{p.physical_graph_id()}:*"):
                    await p._redis.delete(key)
            except Exception:
                pass
        await p._query("MATCH (n) DETACH DELETE n")
        await p._query(seed_cypher)
        return p

    try:
        yield _make
    finally:
        for p in built:
            try:
                await p._graph.delete()
            except Exception:
                pass


def _hops(result):
    return sorted((e.source_urn, e.target_urn, e.edge_type) for e in result.edges)


def _urns(result):
    return sorted(n.urn for n in result.nodes)


def _containment(result):
    return sorted((e.source_urn, e.target_urn) for e in result.containment_edges)


# ── Estate: one column's lineage among its siblings' ──────────────────
#
#     d1 ⊃ t1 ⊃ c1   (first_name — the FOCUS)
#     d1 ⊃ t1 ⊃ c1b  (a SIBLING column of the same table)
#     d2 ⊃ t2 ⊃ c2   (full_name)
#     d3 ⊃ t3 ⊃ c9   (unrelated)
#
#     c1  -[FLOWS_TO]-> c2    (the focus's lineage)
#     c1b -[FLOWS_TO]-> c9    (the SIBLING's UNRELATED lineage)

FOCUS_SEED = """
CREATE
 (d1:Domain {urn:'d1', displayName:'CRM'}),
 (d2:Domain {urn:'d2', displayName:'Analytics'}),
 (d3:Domain {urn:'d3', displayName:'Other'}),
 (t1:Table  {urn:'t1', displayName:'customers'}),
 (t2:Table  {urn:'t2', displayName:'dim_customer'}),
 (t3:Table  {urn:'t3', displayName:'unrelated'}),
 (c1:Column {urn:'c1', displayName:'first_name'}),
 (c1b:Column{urn:'c1b',displayName:'last_name'}),
 (c2:Column {urn:'c2', displayName:'full_name'}),
 (c9:Column {urn:'c9', displayName:'other_col'}),
 (d1)-[:CONTAINS]->(t1), (t1)-[:CONTAINS]->(c1), (t1)-[:CONTAINS]->(c1b),
 (d2)-[:CONTAINS]->(t2), (t2)-[:CONTAINS]->(c2),
 (d3)-[:CONTAINS]->(t3), (t3)-[:CONTAINS]->(c9),
 (c1)-[:FLOWS_TO]->(c2),
 (c1b)-[:FLOWS_TO]->(c9)
"""


@pytest.fixture()
async def provider(estate):
    return await estate("gvt_lens_live_focus", FOCUS_SEED)


async def test_leaf_focus_is_scoped_to_the_column_not_the_table(provider):
    """Tracing ONE column returns that column's lineage — not its table's.
    c1's sibling c1b has its own unrelated lineage (c1b->c9) which must never
    appear. This is the "first_name is 1 of 1000 columns" requirement."""
    r = await provider.trace_closure(
        urn="c1", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    # Only the focus's own lineage hop — attribute→attribute, regime-independent.
    assert _hops(r) == [("c1", "c2", "FLOWS_TO")]
    # The sibling's lineage and the unrelated domain never enter the closure.
    for leaked in ("c1b", "c9", "d3", "t3"):
        assert leaked not in _urns(r)
    assert sorted(r.downstream_urns) == ["c2"]
    assert sorted(r.upstream_urns) == []


async def test_leaf_focus_hydrates_the_full_containment_ancestor_tree(provider):
    """Every participant carries its containment ancestors up to the top-most
    node, so the focus view can nest it. Containment arrives in its OWN list —
    never as a lineage hop."""
    r = await provider.trace_closure(
        urn="c1", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    for ancestor in ("t1", "d1", "t2", "d2"):
        assert ancestor in _urns(r), f"missing containment ancestor {ancestor}"
    assert not r.truncated, f"unexpected truncation: {r.truncation_reason}"

    containment = {(e.source_urn, e.target_urn) for e in r.containment_edges}
    assert {("d1", "t1"), ("t1", "c1"), ("d2", "t2"), ("t2", "c2")} <= containment
    # THE INVARIANT: containment is never a hop.
    assert all(e.edge_type != "CONTAINS" for e in r.edges)


async def test_container_focus_seeds_down_through_containment(provider):
    """A Domain has no lineage of its own. Containment is walked DOWN to find
    which leaves under it participate, and the closure then walks LINEAGE from
    them — surfacing BOTH columns' lineage."""
    r = await provider.trace_closure(
        urn="d1", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    hops = _hops(r)
    assert ("c1", "c2", "FLOWS_TO") in hops
    assert ("c1b", "c9", "FLOWS_TO") in hops
    assert all(e.edge_type != "CONTAINS" for e in r.edges)


async def test_leaf_drill_surfaces_column_lineage_via_raw_fallback(provider):
    """The "attributes vanish" fix. Drilling the (t1, t2) pair is a STRUCTURAL
    one-hop descent to their columns; no :AGGREGATED leaf cells exist here
    (boundary regime), so the agg-first read comes back empty and the empty→raw
    fallback must surface the real column→column edge.

    ``next_level=None`` is how this branch REQUESTS that structural drill: a
    caller who cannot name a level is not confused — a type living at two
    containment depths has no single ``hierarchy.level`` — and the dispatch
    reads it as the structural request. (The reference worktree drills
    structurally unconditionally and passes a vestigial level here; that
    always-structural dispatch is not on this branch, where a named level with
    no depth stamps on the pair still takes the legacy type-level descent.)"""
    r = await provider.expand_aggregated(
        "t1", "t2", next_level=None,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=100, timeout_ms=15000,
    )

    assert ("c1", "c2", "FLOWS_TO") in _hops(r), (
        f"leaf drill lost the column lineage (attributes vanished): {_hops(r)}"
    )


# ── Estate: same-label folders nested deeper than the label count ─────
#
#     f0 ⊃ fa ⊃ fa2 ⊃ da   (and fa2 ⊃ dq, which carries no lineage)
#     f0 ⊃ fb ⊃ fb2 ⊃ db
#     da -[FLOWS_TO]-> db
#
# Three containment levels on a two-label ontology: the hop bound has to come
# from physical depth, not from counting labels.

RECURSIVE_SEED = """
CREATE
 (f0:Folder {urn:'f0',  displayName:'root'}),
 (fa:Folder {urn:'fa',  displayName:'branch-a'}),
 (fa2:Folder{urn:'fa2', displayName:'branch-a-inner'}),
 (fb:Folder {urn:'fb',  displayName:'branch-b'}),
 (fb2:Folder{urn:'fb2', displayName:'branch-b-inner'}),
 (da:Doc    {urn:'da',  displayName:'doc-a'}),
 (db:Doc    {urn:'db',  displayName:'doc-b'}),
 (dq:Doc    {urn:'dq',  displayName:'doc-quiet'}),
 (f0)-[:CONTAINS]->(fa), (fa)-[:CONTAINS]->(fa2), (fa2)-[:CONTAINS]->(da),
 (fa2)-[:CONTAINS]->(dq),
 (f0)-[:CONTAINS]->(fb), (fb)-[:CONTAINS]->(fb2), (fb2)-[:CONTAINS]->(db),
 (da)-[:FLOWS_TO]->(db)
"""


async def test_mid_container_focus_walks_a_recursive_containment_spine(estate):
    """Focus a Folder half-way down a Folder⊃Folder⊃Folder⊃Doc estate. It has
    no lineage of its own, so the seed walks containment DOWN — to the one
    descendant Doc that actually carries lineage, not to every leaf under it —
    and the closure then walks lineage from there, across into the other
    branch. Both branches come back with their whole multi-level spine."""
    p = await estate("gvt_lens_live_recursive", RECURSIVE_SEED)

    r = await p.trace_closure(
        urn="fa", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    # Seeded down to the lineage-bearing Doc ONLY: dq shares da's folder and
    # carries no lineage, so it is never a seed and never enters the closure.
    assert _hops(r) == [("da", "db", "FLOWS_TO")]
    assert "dq" not in _urns(r)
    assert sorted(r.downstream_urns) == ["db"]

    # Every Folder ancestor of both participants, three levels deep on a
    # two-label ontology — physical containment depth, not label depth.
    assert set(_urns(r)) == {"f0", "fa", "fa2", "da", "fb", "fb2", "db"}
    assert _containment(r) == [
        ("f0", "fa"), ("f0", "fb"), ("fa", "fa2"), ("fa2", "da"),
        ("fb", "fb2"), ("fb2", "db"),
    ]
    # THE INVARIANT: containment places nodes, it is never walked as a hop.
    assert all(e.edge_type != "CONTAINS" for e in r.edges)
    assert not r.truncated, r.truncation_reason


# ── Estate: a five-node chain, one leaf per container ─────────────────
#
#     kz⊃z  ka⊃a  kb⊃b  kc⊃c  kd⊃d
#     z -> a -> b -> c -> d

WALK_SEED = """
CREATE
 (kz:Box {urn:'kz', displayName:'box-z'}),
 (ka:Box {urn:'ka', displayName:'box-a'}),
 (kb:Box {urn:'kb', displayName:'box-b'}),
 (kc:Box {urn:'kc', displayName:'box-c'}),
 (kd:Box {urn:'kd', displayName:'box-d'}),
 (z:Doc {urn:'z', displayName:'z'}),
 (a:Doc {urn:'a', displayName:'a'}),
 (b:Doc {urn:'b', displayName:'b'}),
 (c:Doc {urn:'c', displayName:'c'}),
 (d:Doc {urn:'d', displayName:'d'}),
 (kz)-[:CONTAINS]->(z), (ka)-[:CONTAINS]->(a), (kb)-[:CONTAINS]->(b),
 (kc)-[:CONTAINS]->(c), (kd)-[:CONTAINS]->(d),
 (z)-[:FLOWS_TO]->(a), (a)-[:FLOWS_TO]->(b),
 (b)-[:FLOWS_TO]->(c), (c)-[:FLOWS_TO]->(d)
"""


async def test_the_walk_sequence_covers_what_one_deep_closure_would(estate):
    """The walk driven the way the UI will drive it: click a leaf, then expand
    what came back at the edges. Staged, because the point is the SEQUENCE —
    two shallow steps have to add up to the deep closure they replace, or the
    server-driven walk quietly loses lineage the one-shot trace showed."""
    p = await estate("gvt_lens_live_walk", WALK_SEED)

    # ── (a) the click: one hop each way from a mid-chain leaf ──────────
    first = await p.trace_closure(
        urn="b", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    assert _hops(first) == [("a", "b", "FLOWS_TO"), ("b", "c", "FLOWS_TO")]
    assert set(_urns(first)) == {"a", "b", "c", "ka", "kb", "kc"}
    assert sorted(first.upstream_urns) == ["a"]
    assert sorted(first.downstream_urns) == ["c"]
    assert not first.truncated, first.truncation_reason
    # The counts come from the LIVE degree probe, and they are honest: a has
    # exactly one more upstream (z->a), c one more downstream (c->d), and
    # neither of those is on the board yet. No cursor — nothing is being paged.
    assert [(f.urn, f.total_count) for f in first.frontier_up] == [("a", 1)]
    assert [(f.urn, f.total_count) for f in first.frontier_down] == [("c", 1)]
    assert first.frontier_up[0].next_cursor is None
    assert first.frontier_down[0].next_cursor is None

    # ── (b) the continuation: expand the leaves under the returned boxes ──
    # The client seeds from the frontier leaves it wants opened and excludes
    # everything else it already holds. Seeds are deliberately NOT excluded:
    # an excluded seed is dropped from the walk.
    seeds = ["a", "c"]
    second = await p.trace_closure(
        urn="b", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=seeds, exclude_urns=sorted(set(_urns(first)) - set(seeds)),
    )

    # ONLY the next hop. The two edges the client already holds do not come
    # back — at hop 1 the exclude set is a DB-side NOT filter — and neither
    # does any lineage node it already had.
    assert _hops(second) == [("c", "d", "FLOWS_TO"), ("z", "a", "FLOWS_TO")]
    assert sorted(second.upstream_urns) == ["z"]
    assert sorted(second.downstream_urns) == ["d"]
    # What DOES come back beside the new pair: the anchors this step was told
    # to expand from (the focus and its seeds) and every participant's spine.
    # Ancestor hydration is unconditional — the canvas cannot nest a node
    # whose containment chain it was not given.
    assert set(_urns(second)) == {
        "z", "a", "b", "c", "d", "kz", "ka", "kb", "kc", "kd",
    }

    # ── (c) the two steps ARE the deep closure ─────────────────────────
    direct = await p.trace_closure(
        urn="b", upstream_depth=2, downstream_depth=2,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    assert set(_urns(first)) | set(_urns(second)) == set(_urns(direct))
    assert (
        {e.id for e in first.edges} | {e.id for e in second.edges}
        == {e.id for e in direct.edges}
    ), "the walk lost an edge the one-shot depth-2 closure shows"


# ── Estate: a three-node cycle ────────────────────────────────────────
#
#     km⊃m  kn⊃n  ko⊃o
#     m -> n -> o -> m

SEAM_SEED = """
CREATE
 (km:Box {urn:'km', displayName:'box-m'}),
 (kn:Box {urn:'kn', displayName:'box-n'}),
 (ko:Box {urn:'ko', displayName:'box-o'}),
 (m:Doc {urn:'m', displayName:'m'}),
 (n:Doc {urn:'n', displayName:'n'}),
 (o:Doc {urn:'o', displayName:'o'}),
 (km)-[:CONTAINS]->(m), (kn)-[:CONTAINS]->(n), (ko)-[:CONTAINS]->(o),
 (m)-[:FLOWS_TO]->(n), (n)-[:FLOWS_TO]->(o), (o)-[:FLOWS_TO]->(m)
"""


async def test_a_later_hop_keeps_the_seam_edge_into_an_excluded_node(estate):
    """An edge INTO a node the client already holds is the SEAM that stitches
    this step onto the graph it has — without it the new nodes float free. The
    exclude set is a DB-side filter at hop 1 only, precisely so deeper hops can
    still report the seam; this walks two hops around a cycle back onto the
    excluded node and requires the edge without the node."""
    p = await estate("gvt_lens_live_seam", SEAM_SEED)

    r = await p.trace_closure(
        urn="n", upstream_depth=0, downstream_depth=2,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=["n"], exclude_urns=["m"],
    )

    # Hop 2 comes back around to m: the edge ships, the node does not.
    assert ("o", "m", "FLOWS_TO") in _hops(r)
    assert "m" not in _urns(r)
    assert sorted(r.downstream_urns) == ["o"]
    # Cycle-safe: the walk stops at the visited node instead of going round.
    assert _hops(r) == [("n", "o", "FLOWS_TO"), ("o", "m", "FLOWS_TO")]


# ── Estate: one hub with twelve downstream partners ───────────────────
#
# Containment is created FIRST so it takes the low relationship ids: the
# cursor grammar is ``e:<id(r)>`` resumed with ``id(r) > $after`` and has no
# from-the-start value, so a client opens a hub at ``e:0``.

HUB_PARTNERS = [f"p{i:02d}" for i in range(12)]

HUB_SEED = "CREATE " + ", ".join([
    "(kh:Box {urn:'kh', displayName:'hub-box'})",
    "(kp:Box {urn:'kp', displayName:'partner-box'})",
    "(hub:Doc {urn:'hub', displayName:'hub'})",
    *[f"({u}:Doc {{urn:'{u}', displayName:'partner-{u}'}})" for u in HUB_PARTNERS],
    "(kh)-[:CONTAINS]->(hub)",
    *[f"(kp)-[:CONTAINS]->({u})" for u in HUB_PARTNERS],
    *[f"(hub)-[:FLOWS_TO]->({u})" for u in HUB_PARTNERS],
])


async def test_hub_truncates_then_pages_its_whole_adjacency(estate):
    """A hub with more lineage than the budget carries. The first call says so
    honestly — the hub in the frontier with its FULL degree, not the shown
    count — and the cursor then drains the rest in pages that never overlap
    and never lose a partner. The last page withdraws the offer."""
    p = await estate("gvt_lens_live_hub", HUB_SEED)

    initial = await p.trace_closure(
        urn="hub", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=5, timeout_ms=15000,
    )

    # max_nodes reserves half for the seed, so the hop carries 4 of the 12.
    assert initial.truncated and initial.truncation_reason == "max_nodes"
    assert len(initial.edges) == 4
    assert {e.target_urn for e in initial.edges} <= set(HUB_PARTNERS)
    # The hub is the only thing worth offering: its partners are fully shown.
    assert [(f.urn, f.total_count) for f in initial.frontier_down] == [("hub", 12)]
    # A cut is not a page — the initial call hands back no cursor.
    assert initial.frontier_down[0].next_cursor is None

    pages, cursor = [], "e:0"
    while cursor is not None:
        page = await p.trace_closure(
            urn="hub", upstream_depth=0, downstream_depth=1,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=5, timeout_ms=15000, after_cursor=cursor,
        )
        pages.append(page)
        assert len(pages) <= 5, "runaway paging"
        entry = next((f for f in page.frontier_down if f.urn == "hub"), None)
        cursor = entry.next_cursor if entry else None

    partners = [{e.target_urn for e in pg.edges} for pg in pages]
    assert [len(s) for s in partners] == [5, 5, 2]
    for i, left in enumerate(partners):
        for right in partners[i + 1:]:
            assert not left & right, f"pages overlap on {left & right}"
    assert set().union(*partners) == set(HUB_PARTNERS)
    # Drained: the hub is not offered again, so the client stops on its own.
    assert not any(f.urn == "hub" for f in pages[-1].frontier_down)
    # Every page is one hub's adjacency — the hub itself is never re-walked.
    assert all(pg.upstream_urns == set() for pg in pages)


# ── Estate: two distinct edges on one (source, target) pair ───────────

PARALLEL_SEED = """
CREATE
 (kx:Box {urn:'kx', displayName:'box-x'}),
 (x:Doc {urn:'x', displayName:'x'}),
 (y:Doc {urn:'y', displayName:'y'}),
 (kx)-[:CONTAINS]->(x), (kx)-[:CONTAINS]->(y),
 (x)-[:FLOWS_TO]->(y),
 (x)-[:FLOWS_TO]->(y)
"""


async def test_parallel_edges_both_survive_the_walk(estate):
    """Two DISTINCT relationships on the same (source, target) pair are two
    real relationships. Anything that dedupes by pair rather than by edge id
    silently merges them and the canvas loses one."""
    p = await estate("gvt_lens_live_parallel", PARALLEL_SEED)

    r = await p.trace_closure(
        urn="x", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    parallel = [e for e in r.edges if (e.source_urn, e.target_urn) == ("x", "y")]
    assert len(parallel) == 2, f"parallel edges collapsed: {_hops(r)}"
    assert len({e.id for e in parallel}) == 2
    # One partner discovered, twice over — the node is not duplicated with it.
    assert sorted(r.downstream_urns) == ["y"]
    assert _urns(r).count("y") == 1


async def test_closure_survives_a_cache_outage(estate):
    """The cache is an OPTIMIZATION, never a hard dependency —
    ``build_cache_client`` returns None by construction when no cache endpoint
    resolves, and the dedicated cache Redis can simply be down. Two store-backs
    on this path used to run unguarded and throw away work that had already
    succeeded: the ancestor chains (leaving `ancestors_failed` and a trace with
    no containment tree) and the URN labels (dropping every reader onto the
    unlabeled full-scan path the cache exists to avoid). Proven live, because
    both failures are invisible to a fake that never had a client to lose."""
    p = await estate("gvt_lens_live_outage", FOCUS_SEED)
    p._redis = None

    r = await p.trace_closure(
        urn="c1", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )

    # Ancestors computed uncached rather than discarded: whole tree, no flag.
    assert not r.truncated, r.truncation_reason
    assert r.truncation_reason != "ancestors_failed"
    assert _hops(r) == [("c1", "c2", "FLOWS_TO")]
    assert {("d1", "t1"), ("t1", "c1"), ("d2", "t2"), ("t2", "c2")} <= set(_containment(r))

    # Labels still resolve off the graph with no cache to read or write, so
    # anchors stay label-qualified index seeks instead of collapsing into the
    # unlabeled bucket. This is the assertion that discriminates: the closure
    # above is CORRECT either way, just slow the wrong way round.
    assert await p._resolve_urn_labels_bulk(["c1", "t1", "d1"]) == {
        "c1": "Column", "t1": "Table", "d1": "Domain",
    }
    assert await p._label_buckets(["c1", "t1"]) == [("Column", ["c1"]), ("Table", ["t1"])]

    # And the continuation shape, whose seed anchors come from exactly that
    # lookup, still walks.
    cont = await p.trace_closure(
        urn="c1", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=["c1"], exclude_urns=["d1"],
    )
    assert _hops(cont) == [("c1", "c2", "FLOWS_TO")]
    assert cont.truncation_reason != "ancestors_failed"
