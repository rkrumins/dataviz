"""VersionedBranchProvider.get_aggregated_edges_between — roll-ups derived from
the branch's own Postgres state.

THE GAP THIS CLOSES (reported live, 2026-08-30): a data source whose FalkorDB
projection had fallen behind its committed head has EVERY main read routed to
this provider. This method used to answer ``[]`` unconditionally, and
``/graph/edges/aggregated`` is the only channel by which lineage from OUTSIDE
an expanded container reaches its newly visible children — ``children-with-
edges`` returns only lineage BETWEEN the children. So expanding Tableau drew
one line into the platform card and none into the four dashboards inside it,
while the raw lineage sat in Postgres, unqueried.

The contract mirrored here is the one the FalkorDB projection materialises: a
raw lineage edge rolls up to the cross-product of both endpoints' containment
ancestor chains (``common.providers.pair_rules``), restricted to the pairs the
caller actually asked about. With Snowflake collapsed and Tableau expanded that
is four ``platform -> dashboard`` cells plus the coarse ``platform -> platform``
cell the canvas stamps ``isDelegated`` so it does not double-draw.
"""
import asyncio

from backend.app.providers.versioned_branch_provider import VersionedBranchProvider


def _run(coro):
    return asyncio.run(coro)


DASHBOARDS = ["cfo", "customer360", "exec", "sales"]


class _FakeStateSvc:
    """In-memory stand-in for the versioning service's ``*_from_state`` reads.

    The live failing topology (lineage L, containment C):

        snowflake ⊃ sf_db ⊃ sf_table
        tableau   ⊃ cfo, customer360, exec, sales
        sf_table —L→ each dashboard
    """

    NODES = {u: {"urn": u, "displayName": u, "entityType": "node", "properties": {}}
             for u in ["snowflake", "sf_db", "sf_table", "tableau", *DASHBOARDS]}
    EDGES = [
        {"id": "c:sf>db", "sourceUrn": "snowflake", "targetUrn": "sf_db", "edgeType": "CONTAINS"},
        {"id": "c:db>t", "sourceUrn": "sf_db", "targetUrn": "sf_table", "edgeType": "CONTAINS"},
        *[{"id": f"c:tab>{d}", "sourceUrn": "tableau", "targetUrn": d, "edgeType": "CONTAINS"}
          for d in DASHBOARDS],
        *[{"id": f"l:t>{d}", "sourceUrn": "sf_table", "targetUrn": d, "edgeType": "FLOWS_TO"}
          for d in DASHBOARDS],
    ]

    def __init__(self):
        self.edge_reads = 0

    async def get_edges_from_state(self, *, graph_id, branch_id, as_of_seq,
                                   source_urns=None, target_urns=None, any_urns=None,
                                   edge_types=None, min_confidence=None,
                                   limit=100, offset=0):
        self.edge_reads += 1
        out = []
        for e in self.EDGES:
            if edge_types and e["edgeType"] not in edge_types:
                continue
            if source_urns is not None and e["sourceUrn"] not in source_urns:
                continue
            if target_urns is not None and e["targetUrn"] not in target_urns:
                continue
            if any_urns is not None and e["sourceUrn"] not in any_urns and e["targetUrn"] not in any_urns:
                continue
            out.append(dict(e))
        return out[offset:offset + limit]


def _provider(svc=None) -> VersionedBranchProvider:
    return VersionedBranchProvider(svc or _FakeStateSvc(), graph_id="g1", branch_id="b1")


def _agg(p, visible):
    return _run(p.get_aggregated_edges_between(
        source_urns=list(visible), target_urns=list(visible), granularity=None,
        containment_edges=["CONTAINS"], lineage_edges=["FLOWS_TO"]))


COLLAPSED = ["snowflake", "tableau"]
EXPANDED = ["snowflake", "tableau", *DASHBOARDS]


def _cells(result):
    return {(e.source_urn, e.target_urn): e.edge_count for e in result.aggregated_edges}


def test_expanded_container_gets_one_rollup_per_visible_child():
    r = _agg(_provider(), EXPANDED)
    cells = _cells(r)
    # The four flows the user expanded to see — one line each, into the child.
    for d in DASHBOARDS:
        assert cells.get(("snowflake", d)) == 1, f"no roll-up into {d}: {cells}"
    # Plus the coarse platform cell, carrying its true weight; the canvas
    # stamps it isDelegated so it does not double-draw over the four.
    assert cells.get(("snowflake", "tableau")) == 4
    assert len(cells) == 5
    assert r.aggregated_edges[0].edge_types == ["FLOWS_TO"]
    assert r.stale is False and r.truncated is False


def test_collapsed_container_gets_the_single_coarse_rollup():
    r = _agg(_provider(), COLLAPSED)
    assert _cells(r) == {("snowflake", "tableau"): 4}


def test_edges_are_redrawn_on_every_expand_collapse_toggle():
    # Same provider instance across the whole toggle: a cache that only
    # answers the first expand would pass both single-shot tests above.
    p = _provider()
    for _ in range(3):
        assert set(_cells(_agg(p, EXPANDED))) == {
            ("snowflake", "tableau"), *[("snowflake", d) for d in DASHBOARDS]}
        assert set(_cells(_agg(p, COLLAPSED))) == {("snowflake", "tableau")}


def test_a_pair_the_caller_did_not_ask_about_is_never_returned():
    # Only the visible set is answered for: sf_db / sf_table are real
    # containment ancestors of the source endpoint but nobody asked.
    r = _agg(_provider(), EXPANDED)
    asked = set(EXPANDED)
    for e in r.aggregated_edges:
        assert e.source_urn in asked and e.target_urn in asked


def test_no_lineage_types_means_no_derivation_and_no_reads():
    svc = _FakeStateSvc()
    r = _run(_provider(svc).get_aggregated_edges_between(
        source_urns=EXPANDED, target_urns=EXPANDED, granularity=None,
        containment_edges=["CONTAINS"], lineage_edges=[]))
    assert r.aggregated_edges == [] and svc.edge_reads == 0


def test_a_bounded_derivation_says_stale_instead_of_answering_short(monkeypatch):
    """THE SILENCE THAT COST 14 HOURS. This method used to return a bare empty
    result, which on the wire is indistinguishable from "these nodes genuinely
    have no roll-ups between them" — so a wedged projection read as data loss
    and nobody could tell which. The derivation is bounded (hop count, scope
    size); when a bound bites, the short answer must be LABELLED, never handed
    over as a complete one.

    Squeeze the scope cap so the containment descent stops one hop short of
    ``sf_table`` — the source endpoint of every lineage edge. The honest
    outcome is exactly the outage's shape (no cells at all) plus the two fields
    that say why."""
    import backend.app.providers.versioned_branch_provider as vbp

    monkeypatch.setattr(vbp, "_DERIVE_SCOPE_CAP", 7)
    r = _agg(_provider(), EXPANDED)

    assert r.aggregated_edges == [], "premise: the cap must hide the lineage"
    assert r.truncated is True, "a bounded descent must report truncated"
    assert r.stale is True, (
        "an incomplete roll-up answer went out unmarked — this is the wire "
        "shape that made a wedged projection look like empty data"
    )
    assert r.stale_reason == "derive_scope_cap", r.stale_reason


def test_a_chain_deeper_than_the_hop_bound_says_stale_too(monkeypatch):
    """THE OTHER BOUND, AND THE SILENT ONE. The scope cap sets the flag on its
    way out; the hop bound simply fell out of ``for _ in range(...)`` with
    ``truncated`` still False, so a containment chain deeper than the bound
    produced the very wire shape the guard above exists to eliminate — ``cells:
    [], truncated: False, stale: False, reason: None`` — while the docstring
    claimed both bounds report.

    Squeeze the hop bound to 1 against the 2-deep ``snowflake ⊃ sf_db ⊃
    sf_table`` chain: the descent reaches sf_db and stops, so sf_table — the
    source endpoint of every lineage edge — never enters the scope."""
    import backend.app.providers.versioned_branch_provider as vbp

    monkeypatch.setattr(vbp, "_DERIVE_HOP_BOUND", 1)
    r = _agg(_provider(), EXPANDED)

    assert r.aggregated_edges == [], "premise: one hop short of sf_table hides the lineage"
    assert r.truncated is True, "the hop bound bit and the answer went out unmarked"
    assert r.stale is True
    assert r.stale_reason == "derive_hop_bound", r.stale_reason


def test_an_edge_read_that_fills_its_page_says_stale_even_with_cells(monkeypatch):
    """The third bound: every read is issued with ``limit=_DERIVE_SCOPE_CAP``,
    so a chunk that comes back AT the limit has silently dropped edges. Unlike
    the two above this one still returns cells — a short answer that looks
    complete is exactly the shape that costs the hours.

    No containment types, so the descent is skipped and only the lineage read
    can bite: four flows against a cap of four."""
    import backend.app.providers.versioned_branch_provider as vbp

    monkeypatch.setattr(vbp, "_DERIVE_SCOPE_CAP", 4)
    r = _run(_provider().get_aggregated_edges_between(
        source_urns=["sf_table"], target_urns=list(DASHBOARDS), granularity=None,
        containment_edges=[], lineage_edges=["FLOWS_TO"]))

    assert len(r.aggregated_edges) == 4, f"premise: the page is full, {_cells(r)}"
    assert r.truncated is True, "a full page dropped edges and the answer did not say so"
    assert r.stale is True
    assert r.stale_reason == "derive_scope_cap", r.stale_reason


def test_a_derivation_that_hits_no_bound_is_not_marked():
    """The other direction. `truncated` on a complete answer is noise, and the
    canvas treats stale as "this picture may be missing lines" — a guard that
    only checked the flag going up would be satisfied by a provider that always
    sets it."""
    r = _agg(_provider(), EXPANDED)
    assert r.truncated is False and r.stale is False and r.stale_reason is None
