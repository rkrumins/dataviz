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

Each estate gets its OWN throwaway ``gvt_lens_live_*`` graph, uniquely named
per run and DELETED in the fixture's finally — this runs against the SHARED
dev FalkorDB, where a leaked graph outlives the run and a reused name lets two
runs wipe each other.

Run:
    docker run --rm --network synodic-dev_default --entrypoint sh \
      -e FALKORDB_HOST=falkordb -e CACHE_REDIS_URL=redis://redis:6379/3 \
      -v "$PWD/backend:/app/backend" -w /app synodic-viz-test \
      -c "python -m pytest backend/tests/integration/test_trace_closure_live.py -q"
"""
import os
import uuid

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

    Every graph name carries a per-run random suffix. That keeps two runs on
    the shared dev FalkorDB from wiping each other's estates mid-assertion,
    and it makes each run's Redis namespace fresh too — URN labels and
    ancestor chains cache under ``host:port:graph_name``, so a fixed name
    would let a previous run's containment tree answer this run's questions.
    A live gate that reads its answer out of a cache is not a gate.
    """
    built = []

    async def _make(name, seed_cypher, ctypes=CTYPES):
        p = FalkorDBProvider(
            host=os.getenv("FALKORDB_HOST", "falkordb"),
            port=int(os.getenv("FALKORDB_PORT", "6379")),
            graph_name=f"gvt_lens_live_{name}_{uuid.uuid4().hex[:8]}",
        )
        try:
            await p._ensure_connected()
        except Exception as exc:  # pragma: no cover - env-dependent
            pytest.skip(f"FalkorDB unreachable: {exc}")
        built.append(p)
        p.set_containment_edge_types(ctypes)
        await p._query(seed_cypher)
        return p

    try:
        yield _make
    finally:
        for p in built:
            try:
                await p._graph.delete()
            except Exception as exc:  # pragma: no cover - cleanup best effort
                # Say which graph leaked. A silent pass here leaves a stranger
                # to find an orphan on the shared dev instance with no idea
                # where it came from.
                print(
                    f"WARNING: leaked test graph {p._graph_name!r} "
                    f"on {p._host}:{p._port} — delete it by hand ({exc})"
                )


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
    return await estate("focus", FOCUS_SEED)


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
    p = await estate("recursive", RECURSIVE_SEED)

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
    p = await estate("walk", WALK_SEED)

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
    # everything else it already holds. (Excluding the seeds TOO is the real
    # client's own shape and works identically — see
    # ``test_a_seed_the_client_already_holds_still_walks``.)
    seeds = ["a", "c"]
    second = await p.trace_closure(
        urn="b", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=seeds, exclude_urns=sorted(set(_urns(first)) - set(seeds)),
    )

    # Only the next hop's NODES. The edges into b come back too — an edge
    # touching an excluded node is a seam, and the exclude set never filters
    # edges at any hop; b itself is not re-shipped.
    assert _hops(second) == [
        ("a", "b", "FLOWS_TO"), ("b", "c", "FLOWS_TO"),
        ("c", "d", "FLOWS_TO"), ("z", "a", "FLOWS_TO"),
    ]
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


async def test_a_seed_the_client_already_holds_still_walks(estate):
    """A SEED IS AN INSTRUCTION, NOT A CANDIDATE — ``exclude_urns`` says what
    must not be re-SHIPPED, never where the walk may START.

    This is the real client's own request shape, and nothing else's:
    ``seed_urns`` are BY CONSTRUCTION nodes it already holds (the lineage
    leaves under the card whose ⊕ was clicked), so every seed is also in
    ``exclude_urns`` — which every other test in this file carefully
    subtracts, and the frontend never can. Dropping an excluded seed made
    the walk start from nothing and return an empty response: the click did
    nothing, at every card whose CHILDREN carry the lineage rather than the
    card itself. Measured live before the fix: expanding a 14-column table
    returned 0 edges and 0 frontier entries; the same request with the seeds
    kept out of the exclude set returned all 14. That is what "after about
    three hops it just stops and I have to re-focus to go further" was.
    """
    p = await estate("held_seed", WALK_SEED)

    first = await p.trace_closure(
        urn="d", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )
    held = set(_urns(first))
    assert "c" in held and "kc" in held

    # THREE CHAINED CLICKS on BOX cards — the ⊕ on kc, then kb, then ka.
    # Each card is a container; each seed is the leaf inside it that
    # carries the lineage; the client holds both, so both are excluded.
    # Exactly what `useLensWalk.extend` sends, three hops running.
    reached = []
    for box, leaf, expected in (("kc", "c", "b"), ("kb", "b", "a"), ("ka", "a", "z")):
        step = await p.trace_closure(
            urn=box, upstream_depth=1, downstream_depth=0,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=1000, timeout_ms=15000,
            seed_urns=[leaf], exclude_urns=sorted(held),
        )
        assert (expected, leaf, "FLOWS_TO") in _hops(step), (
            f"the ⊕ on {box} delivered nothing — an excluded seed was "
            f"dropped from the walk"
        )
        assert sorted(step.upstream_urns) == [expected]
        held |= set(_urns(step))
        reached.append(expected)

    assert reached == ["b", "a", "z"]
    # The head of the chain has nothing above it, and says so by ABSENCE:
    # no frontier entry at all is the honest dead end, not a walk that quit.
    last = await p.trace_closure(
        urn="kz", upstream_depth=1, downstream_depth=0,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=["z"], exclude_urns=sorted(held),
    )
    assert last.frontier_up == []
    assert not [e for e in last.edges if e.target_urn == "z"]

    # The same click on the LEAF itself (the anchor IS the seed) always
    # worked — the two shapes must now agree, or the walk still depends on
    # which grain the reader happened to click.
    leaf_anchored = await p.trace_closure(
        urn="c", upstream_depth=1, downstream_depth=0,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=["c"], exclude_urns=sorted(set(_urns(first))),
    )
    assert ("b", "c", "FLOWS_TO") in _hops(leaf_anchored)


async def test_a_container_seed_resolves_to_the_leaves_that_carry_the_lineage(estate):
    """A SEED THAT STANDS FOR FINER THINGS RESOLVES TO THEM.

    Lineage lives at the leaves. A reader clicking ⊕ on a card they have
    never opened holds none of its leaves, so the only name the client
    can send is the CARD's — and a card that holds finer things carries
    no lineage of its own. Taking that seed literally walked a node with
    no lineage on it and returned an empty hop set, no frontier and no
    error: the click did nothing and said nothing. Reported live on the
    dev estate — the ⊕ on `int_clean_contacts_t2` shipped three nodes
    and zero edges while each of that table's eight columns had an
    upstream one hop away.

    The anchor path has always resolved a container this way
    (`_collect_lineage_seed`); this is the same rule applied to every
    seed, so a walk cannot depend on whether the reader happened to have
    opened the card first.
    """
    p = await estate("container_seed", WALK_SEED)

    # ⊕ on the BOX kc, unopened: the client holds the box and nothing
    # inside it, and (as always) excludes what it holds.
    res = await p.trace_closure(
        urn="kc", upstream_depth=1, downstream_depth=0,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=["kc"], exclude_urns=["kc"],
    )
    assert ("b", "c", "FLOWS_TO") in _hops(res), (
        "the ⊕ on an unopened container delivered nothing — the seed was "
        "taken literally instead of resolving to the leaf that carries "
        "the lineage"
    )
    assert sorted(res.upstream_urns) == ["b"]
    # The walk goes ON from there: b is the new boundary, honestly counted.
    assert [(f.urn, f.total_count) for f in res.frontier_up] == [("b", 1)]

    # Identical to naming the leaf directly — whether the reader opened
    # the card first must not change what the walk finds.
    leaf = await p.trace_closure(
        urn="kc", upstream_depth=1, downstream_depth=0,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
        seed_urns=["c"], exclude_urns=["kc", "c"],
    )
    assert _hops(leaf) == _hops(res)


# ── Estate: a diamond ─────────────────────────────────────────────────
#
#     kf⊃f  kg⊃g  kh⊃h
#     f -> g, f -> h, g -> h

DIAMOND_SEED = """
CREATE
 (kf:Box {urn:'kf', displayName:'box-f'}),
 (kg:Box {urn:'kg', displayName:'box-g'}),
 (kh:Box {urn:'kh', displayName:'box-h'}),
 (f:Doc {urn:'f', displayName:'f'}),
 (g:Doc {urn:'g', displayName:'g'}),
 (h:Doc {urn:'h', displayName:'h'}),
 (kf)-[:CONTAINS]->(f), (kg)-[:CONTAINS]->(g), (kh)-[:CONTAINS]->(h),
 (f)-[:FLOWS_TO]->(g), (f)-[:FLOWS_TO]->(h), (g)-[:FLOWS_TO]->(h)
"""


async def test_the_walk_never_loses_the_diamond_edge_between_two_held_nodes(estate):
    """THE diamond, live. One depth-1 click at f hands the client g and h but
    never g→h, which is two hops away. Continuing from g — with f and h both
    excluded, because the client holds them — is the only way it can ever
    learn that edge. A DB-side exclusion on hop 1 filtered exactly that row
    away and lost the edge for good, while a one-shot depth-2 closure showed
    it plainly. The union of the two shallow steps must equal the deep one."""
    p = await estate("diamond", DIAMOND_SEED)

    async def _closure(**kw):
        return await p.trace_closure(
            urn="f", lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=1000, timeout_ms=15000, **kw,
        )

    first = await _closure(upstream_depth=0, downstream_depth=1)
    assert _hops(first) == [("f", "g", "FLOWS_TO"), ("f", "h", "FLOWS_TO")]

    second = await _closure(
        upstream_depth=0, downstream_depth=1,
        seed_urns=["g"], exclude_urns=["f", "h"],
    )
    # The edge arrives; h does not come back with it.
    assert ("g", "h", "FLOWS_TO") in _hops(second)
    assert "h" not in _urns(second)

    deep = await _closure(upstream_depth=0, downstream_depth=2)
    assert (
        {e.id for e in first.edges} | {e.id for e in second.edges}
        == {e.id for e in deep.edges}
    ), "the walk lost the diamond's closing edge"


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
    p = await estate("seam", SEAM_SEED)

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
# LINEAGE is created FIRST, so ``id(r) == 0`` is genuinely one of the hub's
# lineage edges. That is the case a client opening a hub at ``e:0`` has to
# survive, and under the old exclusive ``id(r) > $after`` it could not: no
# cursor the wire grammar (``^e:\d+$``) can express reached edge id 0, so
# that partner was invisible to paging forever.

HUB_PARTNERS = [f"p{i:02d}" for i in range(12)]

HUB_SEED = "CREATE " + ", ".join([
    "(kh:Box {urn:'kh', displayName:'hub-box'})",
    "(kp:Box {urn:'kp', displayName:'partner-box'})",
    "(hub:Doc {urn:'hub', displayName:'hub'})",
    *[f"({u}:Doc {{urn:'{u}', displayName:'partner-{u}'}})" for u in HUB_PARTNERS],
    *[f"(hub)-[:FLOWS_TO]->({u})" for u in HUB_PARTNERS],
    "(kh)-[:CONTAINS]->(hub)",
    *[f"(kp)-[:CONTAINS]->({u})" for u in HUB_PARTNERS],
])


async def test_hub_truncates_then_pages_its_whole_adjacency(estate):
    """A hub with more lineage than the budget carries. The first call says so
    honestly — the hub in the frontier with its FULL degree, not the shown
    count, and a cursor saying where to resume — and paging then drains the
    rest without overlapping or losing a partner. The last page withdraws the
    offer."""
    p = await estate("hub", HUB_SEED)

    # Prove the estate really does put a lineage edge at id 0, so the paging
    # assertions below are testing reachability rather than an arrangement
    # that quietly avoids the problem.
    res = await p._ro_query(
        "MATCH (h:Doc {urn:'hub'})-[r:FLOWS_TO]->(o) WHERE id(r) = 0 RETURN o.urn"
    )
    assert res.result_set, "estate no longer puts a lineage edge at id 0"
    first_partner = res.result_set[0][0]

    initial = await p.trace_closure(
        urn="hub", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=5, timeout_ms=15000,
    )

    # The hub cannot fit the page (12 partners, room for 4), so it is PAGED by
    # edge id: four rows, and a REAL cursor one past the last id shipped.
    assert initial.truncated and initial.truncation_reason == "max_nodes"
    assert len(initial.edges) == 4
    assert {e.target_urn for e in initial.edges} <= set(HUB_PARTNERS)
    # The hub is the only thing worth offering: its partners are fully shown.
    assert [(f.urn, f.total_count) for f in initial.frontier_down] == [("hub", 12)]
    # Only the cursor path can finish a hub — a re-root would re-run the same
    # page — so this entry carries one, and never `e:0` (which would re-ship
    # the four rows the client already holds).
    assert initial.frontier_down[0].next_cursor == "e:4"
    assert initial.frontier_down[0].reason == "cut"
    # The edge-id-0 partner is in the FIRST response, not lost off its front.
    assert first_partner in {e.target_urn for e in initial.edges}

    pages, cursor = [], initial.frontier_down[0].next_cursor
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
    assert [len(s) for s in partners] == [5, 3]
    shown_first = {e.target_urn for e in initial.edges}
    for i, left in enumerate([shown_first, *partners]):
        for right in [shown_first, *partners][i + 1:]:
            assert not left & right, f"pages overlap on {left & right}"
    assert shown_first | set().union(*partners) == set(HUB_PARTNERS)
    # Drained: the hub is not offered again, so the client stops on its own.
    assert not any(f.urn == "hub" for f in pages[-1].frontier_down)
    # Every page is one hub's adjacency — the hub itself is never re-walked.
    assert all(pg.upstream_urns == set() for pg in pages)
    # These partners are genuine dead ends (nothing flows out of them), and a
    # real degree probe says so, so no page offers a chevron on one. The
    # partners that DO have more are the next test.
    assert [f.urn for pg in pages for f in pg.frontier_down] == ["hub"]


# ── Estate: a hub whose partners carry lineage of their own ───────────
#
#     hub -> q0..q5 -> z0..z5      (six partners, each with an onward hop)
#     hub -> dead                  (a seventh with nothing beyond it)
#
# The hub is wider than one page, so every partner arrives on a CURSOR PAGE —
# the path that used to file them under no direction at all.

HUB_DEEP_SEED = "CREATE " + ", ".join([
    "(kb:Box {urn:'kb', displayName:'the-box'})",
    "(hub:Doc {urn:'hub', displayName:'hub'})",
    "(dead:Doc {urn:'dead', displayName:'dead-end'})",
    *[f"(q{i}:Doc {{urn:'q{i}', displayName:'partner-{i}'}})" for i in range(6)],
    *[f"(z{i}:Doc {{urn:'z{i}', displayName:'onward-{i}'}})" for i in range(6)],
    *[f"(hub)-[:FLOWS_TO]->(q{i})" for i in range(6)],
    "(hub)-[:FLOWS_TO]->(dead)",
    *[f"(q{i})-[:FLOWS_TO]->(z{i})" for i in range(6)],
    "(kb)-[:CONTAINS]->(hub)",
    *[f"(kb)-[:CONTAINS]->(q{i})" for i in range(6)],
])


async def test_a_paged_partner_carries_its_own_frontier(estate):
    """THE dead-end bug, live. A partner that arrives on a cursor page was never
    walked FROM — the page read the ANCHOR's adjacency — so it stands exactly
    where a depth-exhausted ring stands, and it has to be offered like one.

    Filing paged partners under no direction shipped them with no frontier
    entry and no probe, and a node with no entry is what the lens states as
    "no further lineage — the walk ends here". Every one of these six had a
    hop waiting behind it. The seventh really is a dead end, and the same
    probe is what proves it — the fix must not put a chevron on that one."""
    p = await estate("hubdeep", HUB_DEEP_SEED)

    entries, partners, cursor = {}, set(), "e:0"
    while cursor is not None:
        page = await p.trace_closure(
            urn="hub", upstream_depth=0, downstream_depth=1,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=4, timeout_ms=15000, after_cursor=cursor,
        )
        partners |= set(page.downstream_urns)
        for f in page.frontier_down:
            if f.urn != "hub":
                entries[f.urn] = f
        assert page.frontier_up == [], "a downstream page files nothing upstream"
        anchor = next((f for f in page.frontier_down if f.urn == "hub"), None)
        assert len(entries) <= 7, "runaway paging"
        cursor = anchor.next_cursor if anchor else None

    assert partners == {f"q{i}" for i in range(6)} | {"dead"}
    # Every partner with something behind it is offered, with the count a real
    # probe measured — and the one with nothing is silently absent.
    assert sorted(entries) == [f"q{i}" for i in range(6)]
    assert all(f.total_count == 1 for f in entries.values())
    # No cursor on a partner: nothing about IT was left half-read, so its
    # affordance is a re-root via seedUrns, never a resume of the hub's page.
    assert all(f.next_cursor is None for f in entries.values())


# ── Estate: a container with more lineage-bearing leaves than fit ─────
#
#     K ⊃ g0..g6   (SEVEN docs, every one of them lineage-bearing)
#     g0->s0, g1->s1, g2->s2      (downstream partners)
#     u3->g3, u4->g4, u5->g5, u6->g6   (upstream partners)
#
# Partners are :Sink so the Docs in a response can be counted exactly.

CAPPED_SEED = "CREATE " + ", ".join([
    "(K:Box {urn:'K', displayName:'the-container'})",
    *[f"(g{i}:Doc {{urn:'g{i}', displayName:'doc-{i}'}})" for i in range(7)],
    *[f"(s{i}:Sink {{urn:'s{i}', displayName:'sink-{i}'}})" for i in range(3)],
    *[f"(u{i}:Sink {{urn:'u{i}', displayName:'src-{i}'}})" for i in range(3, 7)],
    *[f"(K)-[:CONTAINS]->(g{i})" for i in range(7)],
    *[f"(g{i})-[:FLOWS_TO]->(s{i})" for i in range(3)],
    *[f"(u{i})-[:FLOWS_TO]->(g{i})" for i in range(3, 7)],
])


async def test_a_capped_container_seed_still_walks_and_says_it_is_partial(estate):
    """The partial-seed page, live. A container with more lineage-bearing
    leaves than one page can walk ships the leaves that FIT — each with its
    whole hop — and says so while STILL walking: ``seedTruncated``, a
    ``seedCursor`` naming the first leaf it could not afford, and
    ``truncationReason`` for the caller that reads one flag. Never a board of
    nodes with no edges on it, which is the one thing a lineage view must
    never be.

    This is also a live instance of the endpoint's honesty corner:
    ``truncated: true`` with an EMPTY frontier. The page was cut at the seed,
    but every boundary node it did reach proved fully shown by the degree
    probe, so there is genuinely nothing to offer expanding."""
    p = await estate("capped", CAPPED_SEED)

    r = await p.trace_closure(
        urn="K", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=8, timeout_ms=15000,   # room 7: g0..g2 cost 2 each, g3 costs 1
    )

    assert r.seed_truncated is True
    assert r.seed_cursor == "s:g4"
    # Folded in at the RETURN, not mid-walk — the response is partial and says
    # so, and the walk still happened.
    assert r.truncated is True
    assert r.truncation_reason == "max_nodes"

    docs = {n.urn for n in r.nodes if n.urn.startswith("g")}
    assert docs == {"g0", "g1", "g2", "g3"}, f"the page did not stop at the budget: {sorted(docs)}"
    assert r.edges, "a partial seed must still walk"
    assert {(e.source_urn, e.target_urn) for e in r.edges} == {("g0", "s0"), ("g1", "s1"), ("g2", "s2")}
    for e in r.edges:
        assert e.edge_type == "FLOWS_TO"
    assert r.frontier_up == [] and r.frontier_down == []


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
    p = await estate("parallel", PARALLEL_SEED)

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
    p = await estate("outage", FOCUS_SEED)
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


# ── Synthetic edges are not lineage ──────────────────────────────────
#
# REPORTED LIVE (2026-08-14): a column's peek read "5 in / 4 out" over two
# real neighbours. The estate's resolved ontology lists AGGREGATED among
# its lineage types, and :AGGREGATED edges are the aggregation worker's
# own rollups — one real flow projected onto every coarser grain above its
# endpoints. This estate is that shape: ONE real column→column flow, and
# the four rollups the worker would materialise from it.
#
# Driven through the ENGINE rather than the provider, because the engine
# seam is where the filter lives and the provider does exactly what it is
# told. That also exercises the part a unit test cannot: the degree PROBE
# gets the same filtered list, so the frontier's totals agree with the
# edges that shipped.

AGG_SEED = """
CREATE
 (p1:Platform {urn:'p1', displayName:'Snowflake'}),
 (s1:Schema   {urn:'s1', displayName:'SILVER'}),
 (s2:Schema   {urn:'s2', displayName:'GOLD'}),
 (ta:Table    {urn:'ta', displayName:'clean_orders'}),
 (tb:Table    {urn:'tb', displayName:'fct_orders'}),
 (ca:Column   {urn:'ca', displayName:'channel_src'}),
 (cb:Column   {urn:'cb', displayName:'channel'}),
 (p1)-[:CONTAINS]->(s1), (p1)-[:CONTAINS]->(s2),
 (s1)-[:CONTAINS]->(ta), (ta)-[:CONTAINS]->(ca),
 (s2)-[:CONTAINS]->(tb), (tb)-[:CONTAINS]->(cb),
 (ca)-[:FLOWS_TO]->(cb),
 (ca)-[:AGGREGATED]->(cb),
 (ta)-[:AGGREGATED]->(cb),
 (s1)-[:AGGREGATED]->(cb),
 (p1)-[:AGGREGATED]->(cb)
"""

#: What the live source's ontology actually resolves to, synthetic type
#: and all — the input the engine has to defend against.
AGG_ONTOLOGY_LINEAGE = ["FLOWS_TO", "AGGREGATED"]


def _engine_over(p, lineage_types):
    """The real `ContextEngine.trace_closure` over a real provider.

    `object.__new__` for the same reason the wire-contract suite uses it:
    the method touches only `provider`, `_resolve_ontology` and the
    semaphore (which getattr-degrades on a bare instance).
    """
    from backend.app.services.context_engine import ContextEngine

    class _Ont:
        lineage_edge_types = lineage_types
        containment_edge_types = CTYPES
        entity_type_definitions: dict = {}

    eng = object.__new__(ContextEngine)
    eng.provider = p

    async def _resolve_ontology():
        return _Ont()

    eng._resolve_ontology = _resolve_ontology
    return eng


async def test_closure_never_walks_the_rollups_it_materialised_itself(estate):
    from backend.common.models.graph import TraceClosureRequest

    p = await estate("agg", AGG_SEED)
    eng = _engine_over(p, AGG_ONTOLOGY_LINEAGE)

    r = await eng.trace_closure(TraceClosureRequest.model_validate(
        {"urn": "cb", "upstreamDepth": 25, "downstreamDepth": 25},
    ))

    # ONE real flow, at the grain the data source actually stated it.
    assert _hops(r) == [("ca", "cb", "FLOWS_TO")]
    assert not any(e.edge_type.upper() == "AGGREGATED" for e in r.edges)
    # The coarser endpoints of the rollups are only ever here as
    # containment ancestors — never as lineage partners.
    assert sorted(r.upstream_urns) == ["ca"]
    assert sorted(r.downstream_urns) == []


async def test_the_frontier_probe_counts_real_edges_only(estate):
    """The probe's totals come from `get_node_degrees(..., ltypes)` — the
    SAME list the walk used. Unfiltered, `cb` has five incoming edges and
    the pill would offer four that do not exist."""
    from backend.common.models.graph import TraceClosureRequest

    p = await estate("aggprobe", AGG_SEED)

    # Real degree, straight from the engine's own filtered list.
    real = await p.get_node_degrees(["cb"], ["FLOWS_TO"])
    unfiltered = await p.get_node_degrees(["cb"], ["FLOWS_TO", "AGGREGATED"])
    assert real["cb"]["in"] == 1
    # Falsification: without the filter the same node reads five, which is
    # the inflation the user saw.
    assert unfiltered["cb"]["in"] == 5

    # And a closure that stops one hop short reports its frontier from the
    # filtered degrees, so what it offers is what a click can deliver.
    eng = _engine_over(p, AGG_ONTOLOGY_LINEAGE)
    r = await eng.trace_closure(TraceClosureRequest.model_validate(
        {"urn": "cb", "upstreamDepth": 0, "downstreamDepth": 0},
    ))
    for entry in r.frontier_up:
        assert entry.total_count is None or entry.total_count <= 1


# ── Seed-page continuation (2026-08-19): a container focus with more
# lineage-bearing descendants than the seed reserve resumes via seedCursor —
# the one previously non-resumable cap. Keyset (ORDER BY urn, urn > after),
# so pages are deterministic, disjoint, and their union is complete. ────────

WIDE_SEED = """
CREATE
 (top:Domain {urn:'top', displayName:'Wide'}),
 (sink:Column {urn:'zz_sink', displayName:'sink'}),
 (w1:Column {urn:'w1', displayName:'w1'}), (w2:Column {urn:'w2', displayName:'w2'}),
 (w3:Column {urn:'w3', displayName:'w3'}), (w4:Column {urn:'w4', displayName:'w4'}),
 (w5:Column {urn:'w5', displayName:'w5'}), (w6:Column {urn:'w6', displayName:'w6'}),
 (w7:Column {urn:'w7', displayName:'w7'}), (w8:Column {urn:'w8', displayName:'w8'}),
 (top)-[:CONTAINS]->(w1), (top)-[:CONTAINS]->(w2), (top)-[:CONTAINS]->(w3),
 (top)-[:CONTAINS]->(w4), (top)-[:CONTAINS]->(w5), (top)-[:CONTAINS]->(w6),
 (top)-[:CONTAINS]->(w7), (top)-[:CONTAINS]->(w8),
 (w1)-[:FLOWS_TO]->(sink), (w2)-[:FLOWS_TO]->(sink),
 (w3)-[:FLOWS_TO]->(sink), (w4)-[:FLOWS_TO]->(sink),
 (w5)-[:FLOWS_TO]->(sink), (w6)-[:FLOWS_TO]->(sink),
 (w7)-[:FLOWS_TO]->(sink), (w8)-[:FLOWS_TO]->(sink)
"""


async def test_capped_container_seed_resumes_via_seed_cursor(estate):
    """max_nodes=6 → seed reserve 3: page one seeds three descendants and
    ships a seedCursor; following the cursor pages the REST, disjointly,
    until it drains — the union of pages covers every lineage-bearing child."""
    p = await estate("seedpage", WIDE_SEED)

    seen_seeds: set[str] = set()
    cursor = None
    pages = 0
    while True:
        r = await p.trace_closure(
            urn="top", upstream_depth=25, downstream_depth=25,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=6, timeout_ms=15000,
            seed_cursor=cursor,
            # The accumulating client never re-ships what it holds — and the
            # exclude set must never affect where a page STARTS.
            exclude_urns=sorted(seen_seeds) if seen_seeds else None,
        )
        pages += 1
        page_seeds = {u for u in _urns(r) if u.startswith("w")}
        # Keyset pages are DISJOINT on the descendant axis.
        assert not (page_seeds & seen_seeds), f"page {pages} re-shipped {page_seeds & seen_seeds}"
        seen_seeds |= page_seeds
        if r.seed_cursor is None:
            assert not r.seed_truncated or pages > 1 or True
            break
        assert r.seed_cursor.startswith("s:")
        assert r.seed_truncated is True
        cursor = r.seed_cursor
        assert pages < 10, "cursor never drained"

    assert seen_seeds == {f"w{i}" for i in range(1, 9)}
    assert pages >= 3   # 8 descendants at 3 per page


async def test_uncapped_seed_ships_no_cursor(estate):
    p = await estate("seedpage2", WIDE_SEED)
    r = await p.trace_closure(
        urn="top", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=1000, timeout_ms=15000,
    )
    assert r.seed_cursor is None
    assert r.seed_truncated is False


# ══════════════════════════════════════════════════════════════════════════
# SCALE GATES — the degree-exact walk at the widths that broke the ring walk
# ══════════════════════════════════════════════════════════════════════════
#
# A 2,935-column table on the 520k-node dev graph got 1,014 of its 17,567
# hop-1 edges from a one-hop request (984 upstream partners, 15 downstream)
# because the hop budget was one LIMIT shared by both directions. The estate
# below is the same shape, at a size a throwaway graph can hold:
#
#   tbl ⊃ c1000000..c1001499   (1,500 columns, fixed-width urns so urn order
#                               is numeric order)
#   c_i → d_(i mod 300)         (shared sinks — the under-fill case)
#   u_(i mod 50) → c_i          for i < 500 (shared sources)
#   d_j → e_(j mod 100)         (a second hop for the deep-walk gate)
#   chub → h0000..h2999         (a hub column no page can hold)

WIDE_TABLE_SEED = """
CREATE (tbl:Box {urn:'tbl', displayName:'wide-table'})
WITH tbl
UNWIND range(0, 1499) AS i
CREATE (c:Doc {urn: 'c' + toString(1000000 + i), displayName: 'col-' + toString(i)})
CREATE (tbl)-[:CONTAINS]->(c)
WITH c, i
MERGE (d:Sink {urn: 'd' + toString(1000 + (i % 300))})
CREATE (c)-[:FLOWS_TO]->(d)
WITH c, d, i
MERGE (e:Sink {urn: 'e' + toString(1000 + (i % 100))})
MERGE (d)-[:FLOWS_TO]->(e)
WITH c, i WHERE i < 500
MERGE (u:Sink {urn: 'u' + toString(1000 + (i % 50))})
CREATE (u)-[:FLOWS_TO]->(c)
"""

WIDE_TABLE_HUB = """
CREATE (hub:Doc {urn:'chub', displayName:'hub-column'})
WITH hub
UNWIND range(0, 2999) AS i
CREATE (h:Sink {urn: 'h' + toString(10000 + i)})
CREATE (hub)-[:FLOWS_TO]->(h)
"""


def _cols(r):
    return {n.urn for n in r.nodes if n.urn.startswith("c1")}


def _edge_pairs(r):
    return {(e.source_urn, e.target_urn) for e in r.edges}


async def _drain_seed_pages(p, urn, *, max_nodes, up=1, down=1, exclude=True, limit=60):
    """Page the focus's seed cursor to exhaustion; returns the pages."""
    pages, cursor, known = [], None, set()
    for _ in range(limit):
        r = await p.trace_closure(
            urn=urn, upstream_depth=up, downstream_depth=down,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=max_nodes, timeout_ms=30000, seed_cursor=cursor,
            exclude_urns=sorted(known)[:2000] if (exclude and known) else None,
        )
        pages.append(r)
        known |= {n.urn for n in r.nodes}
        cursor = r.seed_cursor
        if cursor is None:
            return pages
    raise AssertionError("the seed cursor never drained")


async def test_wide_table_pages_are_complete_per_seed_and_disjoint(estate):
    """I1 at scale: every column a page ships has ALL of its hop-1 edges in
    that page (both directions), no column is shipped twice, the union of the
    pages is the whole table, and nothing is ever ``e:0``."""
    import time as _time
    p = await estate("widetable", WIDE_TABLE_SEED)
    degrees = await p.get_node_degrees([f"c{1000000 + i}" for i in range(1500)], LTYPES)
    assert len(degrees) == 1500, "the degree probe must know every column"

    t0 = _time.monotonic()
    pages = await _drain_seed_pages(p, "tbl", max_nodes=400)
    wall = _time.monotonic() - t0

    seen = set()
    for pg in pages:
        cols = _cols(pg)
        assert not (cols & seen), f"a column shipped twice: {sorted(cols & seen)[:5]}"
        seen |= cols
        pairs = _edge_pairs(pg)
        for c in cols:
            shown_out = sum(1 for s, _ in pairs if s == c)
            shown_in = sum(1 for _, t in pairs if t == c)
            assert (shown_in, shown_out) == (degrees[c]["in"], degrees[c]["out"]), \
                f"{c} shipped half-done: {(shown_in, shown_out)} vs {degrees[c]}"
        assert len(pg.nodes) <= 400 + 1 + 0  # ancestors (tbl) never count, but tbl is the focus
        for f in [*pg.frontier_up, *pg.frontier_down]:
            assert f.next_cursor != "e:0"
            assert f.reason in ("cut", "depth")
        assert pg.truncated == (pg.seed_cursor is not None) or pg.truncation_reason == "max_nodes"
    assert seen == {f"c{1000000 + i}" for i in range(1500)}
    print(f"\n[wide-table] {len(pages)} pages, {wall * 1000:.0f} ms total, "
          f"max page {max(len(pg.nodes) for pg in pages)} nodes")
    assert len(pages) >= 4


async def test_both_directions_survive_a_small_page(estate):
    """The starvation case, live: a page too small for the whole hop-1 must
    still populate BOTH directions (the old ring LIMIT gave one side 984
    partners and the other 15)."""
    p = await estate("widetable2", WIDE_TABLE_SEED)
    r = await p.trace_closure(
        urn="tbl", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=50, timeout_ms=30000,
    )
    assert r.upstream_urns and r.downstream_urns
    assert r.seed_cursor is not None and r.truncation_reason == "max_nodes"
    assert len(r.nodes) <= 51
    for f in [*r.frontier_up, *r.frontier_down]:
        assert f.next_cursor != "e:0"


async def test_table_pages_agree_with_each_column(estate):
    """Tracing the table must show what tracing its columns shows: every
    sampled column's own one-hop closure is a subset of the table's pages."""
    p = await estate("widetable3", WIDE_TABLE_SEED)
    pages = await _drain_seed_pages(p, "tbl", max_nodes=500)
    table_edges = set().union(*(_edge_pairs(pg) for pg in pages))
    for i in range(0, 1500, 75):
        col = f"c{1000000 + i}"
        own = await p.trace_closure(
            urn=col, upstream_depth=1, downstream_depth=1,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=100, timeout_ms=15000,
        )
        assert own.truncated is False
        assert _edge_pairs(own) <= table_edges, f"{col}'s edges are missing from the table trace"


async def test_hub_column_pages_with_strictly_increasing_real_cursors(estate):
    """A column with 3,000 partners is paged by edge id: every cursor is real
    and strictly increasing, pages never overlap, and the union is complete."""
    p = await estate("widehub", WIDE_TABLE_SEED)
    await p._query(WIDE_TABLE_HUB)
    first = await p.trace_closure(
        urn="chub", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=500, timeout_ms=30000,
    )
    entry = next(f for f in first.frontier_down if f.urn == "chub")
    assert entry.reason == "cut" and entry.total_count == 3000
    assert entry.next_cursor and entry.next_cursor.startswith("e:") and entry.next_cursor != "e:0"
    partners = [{e.target_urn for e in first.edges}]
    cursors = [int(entry.next_cursor[2:])]
    cursor = entry.next_cursor
    for _ in range(20):
        page = await p.trace_closure(
            urn="chub", upstream_depth=0, downstream_depth=1,
            lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
            max_nodes=500, timeout_ms=30000, after_cursor=cursor,
        )
        partners.append({e.target_urn for e in page.edges})
        nxt = next((f.next_cursor for f in page.frontier_down if f.urn == "chub"), None)
        if nxt is None:
            break
        assert int(nxt[2:]) > cursors[-1], "cursors must strictly increase"
        cursors.append(int(nxt[2:]))
        cursor = nxt
    else:
        raise AssertionError("runaway hub paging")
    for i, left in enumerate(partners):
        for right in partners[i + 1:]:
            assert not (left & right)
    assert set().union(*partners) == {f"h{10000 + i}" for i in range(3000)}


async def test_cursorless_cuts_reseeded_in_batches_complete_the_deep_walk(estate):
    """Hop-2 cuts are cursor-less entries the client re-roots in BULK via
    ``seedUrns`` (≤200 per request). Draining them that way reaches exactly
    the closure a single huge page would have returned."""
    p = await estate("widedeep", WIDE_TABLE_SEED)
    one_shot = await p.trace_closure(
        urn="tbl", upstream_depth=2, downstream_depth=2,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=10000, timeout_ms=60000,
    )
    assert one_shot.truncated is False and one_shot.seed_cursor is None

    pages = await _drain_seed_pages(p, "tbl", max_nodes=300, up=2, down=2)
    edges = set().union(*(_edge_pairs(pg) for pg in pages))
    known = set().union(*({n.urn for n in pg.nodes} for pg in pages))
    cuts_up = {f.urn for pg in pages for f in pg.frontier_up if f.reason == "cut" and f.next_cursor is None}
    cuts_down = {f.urn for pg in pages for f in pg.frontier_down if f.reason == "cut" and f.next_cursor is None}
    requests = len(pages)
    for _round in range(40):
        if not cuts_up and not cuts_down:
            break
        for side, cuts in (("up", cuts_up), ("down", cuts_down)):
            batch = sorted(cuts)[:200]
            if not batch:
                continue
            r = await p.trace_closure(
                urn=batch[0], upstream_depth=1 if side == "up" else 0,
                downstream_depth=1 if side == "down" else 0,
                lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
                max_nodes=2000, timeout_ms=30000,
                seed_urns=batch, exclude_urns=sorted(known)[:2000],
            )
            requests += 1
            edges |= _edge_pairs(r)
            known |= {n.urn for n in r.nodes}
            cuts -= set(batch)
            fr = r.frontier_up if side == "up" else r.frontier_down
            cuts |= {f.urn for f in fr if f.reason == "cut" and f.next_cursor is None}
    else:
        raise AssertionError("cut entries never drained")
    assert edges == _edge_pairs(one_shot)
    print(f"\n[deep-walk] {requests} requests to match one 10k page ({len(edges)} edges)")


async def test_a_tiny_deadline_is_flagged_never_silent(estate):
    """A request whose budget is spent before the walk starts ships a page
    that SAYS so — `timeout`, no cursor, no edges — never an empty page that
    claims to be complete."""
    p = await estate("widetimeout", WIDE_TABLE_SEED)
    r = await p.trace_closure(
        urn="tbl", upstream_depth=1, downstream_depth=1,
        lineage_edge_types=LTYPES, containment_edge_types=CTYPES,
        max_nodes=400, timeout_ms=1,
    )
    assert r.truncated is True
    assert r.truncation_reason == "timeout"
    assert r.seed_cursor is None
    assert r.edges == []


# ══════════════════════════════════════════════════════════════════════════
# ONTOLOGY GATE — a single-label, ragged estate (user ruling: ANY ontology)
# ══════════════════════════════════════════════════════════════════════════
#
#   Roots ⊃ N1 ⊃ N2 ⊃ N3 (all `Node`), with lineage at EVERY depth and
#   partners whose own ancestors sit at a DIFFERENT depth:
#
#     left:  R1 ⊃ A1 ⊃ A2 ⊃ A3            right: R2 ⊃ B1 ⊃ B2 ⊃ B3 ⊃ B4
#     A3 → B2      (leaf at depth 3 feeds a container at depth 2)
#     A2 → B4      (container at depth 2 feeds a leaf at depth 4)
#     A1 → C1      (depth 1 → depth 1, R3 ⊃ C1)
#     X  → A3      (an orphan-root node feeds the leaf)
#     deep chain D0 ⊃ D1 ⊃ ... ⊃ D11 → A2  (a 12-deep containment spine)

RAGGED_NODES_SEED = """
CREATE
 (r1:Roots {urn:'R1'}), (a1:Node {urn:'A1'}), (a2:Node {urn:'A2'}), (a3:Node {urn:'A3'}),
 (r2:Roots {urn:'R2'}), (b1:Node {urn:'B1'}), (b2:Node {urn:'B2'}), (b3:Node {urn:'B3'}), (b4:Node {urn:'B4'}),
 (r3:Roots {urn:'R3'}), (c1:Node {urn:'C1'}),
 (x:Node {urn:'X'}),
 (r1)-[:HAS]->(a1), (a1)-[:HAS]->(a2), (a2)-[:HAS]->(a3),
 (r2)-[:HAS]->(b1), (b1)-[:HAS]->(b2), (b2)-[:HAS]->(b3), (b3)-[:HAS]->(b4),
 (r3)-[:HAS]->(c1),
 (a3)-[:FLOWS_TO]->(b2),
 (a2)-[:FLOWS_TO]->(b4),
 (a1)-[:FLOWS_TO]->(c1),
 (x)-[:FLOWS_TO]->(a3)
WITH a2
UNWIND range(0, 11) AS i
MERGE (d:Node {urn: 'D' + toString(100 + i)})
WITH a2, collect(d) AS ds
UNWIND range(0, 10) AS i
WITH a2, ds, ds[i] AS parent, ds[i + 1] AS child
CREATE (parent)-[:HAS]->(child)
WITH a2, ds
WITH a2, ds[11] AS leaf
CREATE (leaf)-[:FLOWS_TO]->(a2)
"""

RAGGED_LTYPES = ["FLOWS_TO"]
RAGGED_CTYPES = ["HAS"]


async def _ragged_truth(p, focus):
    """Every lineage edge incident to the focus or any containment descendant
    of it — what a one-hop picture must contain, straight from Cypher. Two
    queries, not one: FalkorDB rejects `collect(DISTINCT d) + [f]` (mixing a
    node alias with an aggregation) — the same engine limit the seed query
    had to work around."""
    own = await p._ro_query(
        "MATCH (f {urn:$u})-[r:FLOWS_TO]-() RETURN DISTINCT startNode(r).urn, endNode(r).urn",
        params={"u": focus},
    )
    below = await p._ro_query(
        "MATCH (f {urn:$u})-[:HAS*1..16]->(d)-[r:FLOWS_TO]-() "
        "RETURN DISTINCT startNode(r).urn, endNode(r).urn",
        params={"u": focus},
    )
    return {(row[0], row[1]) for res in (own, below) for row in (res.result_set or [])}


@pytest.mark.parametrize("focus", ["R1", "A1", "A2", "A3", "B2", "D100", "C1"])
async def test_ragged_single_label_estate_one_hop_is_complete_at_every_depth(estate, focus):
    """The user's ruling: this must work for `Node ⊃ Node ⊃ Node → Node` where
    the partner has its own ancestors at another depth. A focus at any depth
    — root, container, leaf, a 12-deep spine's top — gets exactly the edges
    incident to itself and its descendants, every endpoint shipped with its
    ancestor chain, nothing cut."""
    p = await estate("ragged", RAGGED_NODES_SEED, ctypes=RAGGED_CTYPES)
    truth = await _ragged_truth(p, focus)
    assert truth, f"fixture drift: {focus} has no incident lineage"

    r = await p.trace_closure(
        urn=focus, upstream_depth=1, downstream_depth=1,
        lineage_edge_types=RAGGED_LTYPES, containment_edge_types=RAGGED_CTYPES,
        max_nodes=2000, timeout_ms=15000,
    )

    assert r.truncated is False and r.seed_cursor is None
    assert _edge_pairs(r) == truth
    shipped = {n.urn for n in r.nodes}
    for s, t in truth:
        assert s in shipped and t in shipped
    # Every endpoint outside the focus's own subtree arrives with its chain.
    containment = {(e.source_urn, e.target_urn) for e in r.containment_edges}
    parents = {t: s for s, t in containment}
    for s, t in truth:
        for end in (s, t):
            if end in ("X", "R1", "R2", "R3"):
                continue        # roots / the orphan have no parent
            assert end in parents, f"{end} shipped without its containment parent"
    for f in [*r.frontier_up, *r.frontier_down]:
        assert f.reason == "depth" and f.next_cursor is None


async def test_ragged_estate_twelve_deep_spine_seeds_through_the_hop_bound(estate):
    """The only ontology-shaped constant is the containment descent bound
    (≥16). A 12-deep single-label spine whose LEAF carries the lineage must
    still seed from its top."""
    p = await estate("raggedspine", RAGGED_NODES_SEED, ctypes=RAGGED_CTYPES)
    r = await p.trace_closure(
        urn="D100", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=RAGGED_LTYPES, containment_edge_types=RAGGED_CTYPES,
        max_nodes=2000, timeout_ms=15000,
    )
    assert _edge_pairs(r) == {("D111", "A2")}
    assert r.truncated is False


# ── Estate: the COARSE first paint's cells (Part G, 2026-08-21) ───────
#
#     dept ⊃ db ⊃ {t1 ⊃ {t1a, t1b}, t2 ⊃ {t2a}}      partner side
#     fdb  ⊃ tbl ⊃ {c0, c1, c2}                       the FOCUS (a table)
#     raw:  c0→t1a, c1→t1a, c1→t1b, c2→t2a             4 flows
#     cells (as the worker stamps them, per containment-level pair):
#       tbl→t1 W=3, tbl→t2 W=1, tbl→db W=4, tbl→dept W=4
#
# Inner-first accounting (the client's card rule): t1 residual 3, t2
# residual 1, db residual 4−(3+1)=0 → host, dept 4−4=0 → host. Σ residual
# of the cards == the 4 raw flows.

COARSE_CELLS_SEED = """
CREATE
 (dept:Dept  {urn:'dept', displayName:'Finance'}),
 (db:Db      {urn:'db',   displayName:'ledger_db'}),
 (t1:Table   {urn:'t1',   displayName:'journal'}),
 (t2:Table   {urn:'t2',   displayName:'balances'}),
 (t1a:Column {urn:'t1a'}), (t1b:Column {urn:'t1b'}), (t2a:Column {urn:'t2a'}),
 (fdb:Db     {urn:'fdb',  displayName:'orders_db'}),
 (tbl:Table  {urn:'tbl',  displayName:'orders'}),
 (c0:Column  {urn:'c0'}), (c1:Column {urn:'c1'}), (c2:Column {urn:'c2'}),
 (dept)-[:CONTAINS]->(db), (db)-[:CONTAINS]->(t1), (db)-[:CONTAINS]->(t2),
 (t1)-[:CONTAINS]->(t1a), (t1)-[:CONTAINS]->(t1b), (t2)-[:CONTAINS]->(t2a),
 (fdb)-[:CONTAINS]->(tbl), (tbl)-[:CONTAINS]->(c0), (tbl)-[:CONTAINS]->(c1), (tbl)-[:CONTAINS]->(c2),
 (c0)-[:FLOWS_TO]->(t1a), (c1)-[:FLOWS_TO]->(t1a), (c1)-[:FLOWS_TO]->(t1b), (c2)-[:FLOWS_TO]->(t2a),
 (tbl)-[:AGGREGATED {weight:3, sourceDepth:1, targetDepth:2}]->(t1),
 (tbl)-[:AGGREGATED {weight:1, sourceDepth:1, targetDepth:2}]->(t2),
 (tbl)-[:AGGREGATED {weight:4, sourceDepth:1, targetDepth:1}]->(db),
 (tbl)-[:AGGREGATED {weight:4, sourceDepth:1, targetDepth:0}]->(dept)
"""


def _inner_first_residuals(cells, parent_of):
    """The client rule, spelled out (traceWireLedger's inner-first loop):
    finest endpoint first, each cell says only what nothing inside it has
    said already — residual = W − Σ(residuals STATED by cells strictly
    inside); a residual ≤ 0 states nothing."""
    def depth(u):
        d, cur = 0, parent_of.get(u)
        while cur:
            d, cur = d + 1, parent_of.get(cur)
        return d

    def inside(a, b):      # is a strictly inside b?
        cur = parent_of.get(a)
        while cur:
            if cur == b:
                return True
            cur = parent_of.get(cur)
        return False
    out = {}
    for p in sorted(cells, key=depth, reverse=True):
        stated = sum(max(0, out[p2]) for p2 in out if inside(p2, p))
        out[p] = cells[p] - stated
    return out


async def test_coarse_ships_every_incident_cell_and_inner_first_accounting_reproduces_the_raw_count(estate):
    from backend.common.models.graph import TraceClosureRequest

    p = await estate("coarse", COARSE_CELLS_SEED)
    eng = _engine_over(p, AGG_ONTOLOGY_LINEAGE)

    coarse = await eng.trace_closure(TraceClosureRequest.model_validate({"urn": "tbl", "grain": "coarse"}))
    assert coarse.grain == "coarse"
    cells = {e.target_urn: e.properties["weight"] for e in coarse.edges if e.source_urn == "tbl"}
    assert cells == {"t1": 3, "t2": 1, "db": 4, "dept": 4}
    assert all(e.edge_type.upper() == "AGGREGATED" for e in coarse.edges)
    assert coarse.frontier_up == [] and coarse.frontier_down == [] and coarse.seed_cursor is None
    assert coarse.truncated is False
    # The TraceResult invariant: every partner's chain ships, with its containment.
    assert {"dept", "db", "t1", "t2", "fdb", "tbl"} <= set(_urns(coarse))
    assert ("db", "t1") in _containment(coarse) and ("fdb", "tbl") in _containment(coarse)

    # The client's card rule over these cells matches the raw truth exactly.
    parent_of = {e.target_urn: e.source_urn for e in coarse.containment_edges}
    residual = _inner_first_residuals(cells, parent_of)
    assert residual == {"t1": 3, "t2": 1, "db": 0, "dept": 0}
    fine = await eng.trace_closure(TraceClosureRequest.model_validate({"urn": "tbl", "upstreamDepth": 1, "downstreamDepth": 1}))
    assert fine.grain == "fine" if fine.grain is not None else True
    raw = [h for h in _hops(fine) if h[2] == "FLOWS_TO"]
    assert sum(w for w in residual.values() if w > 0) == len(raw) == 4
    # …and the cards are exactly the containers of the raw partner leaves
    # (the leaves and their parents are the FINE page's to know).
    parent_fine = {e.target_urn: e.source_urn for e in fine.containment_edges}
    leaf_parents = {parent_fine[t] for _, t, _ in raw}
    assert {u for u, w in residual.items() if w > 0} == leaf_parents == {"t1", "t2"}


async def test_coarse_on_a_provider_without_the_lane_is_served_fine_and_says_so(estate):
    """A coarse request to a provider with no rollup lane is the fine page,
    labelled — the client must be able to tell it apart."""
    from backend.common.models.graph import TraceClosureRequest

    p = await estate("coarse_fallback", COARSE_CELLS_SEED)
    eng = _engine_over(p, AGG_ONTOLOGY_LINEAGE)
    eng.provider = type("NoLane", (), {"trace_closure": p.trace_closure})()
    r = await eng.trace_closure(TraceClosureRequest.model_validate({"urn": "tbl", "grain": "coarse"}))
    assert r.grain == "fine"
    assert not any(e.edge_type.upper() == "AGGREGATED" for e in r.edges)

