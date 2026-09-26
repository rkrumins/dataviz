"""GraphVersioningService.aggregated_overlay_adjust with one side left open.

Selecting a collapsed container on a draft asks its base for every roll-up out
of it (no targets named) or into it (no sources named), and the draft patches
that answer with this adjustment. With no sources named no adjustment could be
kept, so the draft's own flows were missing from the in-direction, while every
delta edge's target still cost a Postgres containment walk. With no targets
named the adjustment was taken among the sources themselves, which drops every
flow out of them.

The containment walk is stubbed (the live store is exercised in
tests/integration/test_draft_overlay_delta.py): A ⊃ A.c, B ⊃ B.c, C ⊃ C.c.
"""
import asyncio
import contextlib

from backend.app.services.versioning.service import GraphVersioningService

PARENT = {"A.c": "A", "B.c": "B", "C.c": "C"}


def _svc():
    @contextlib.asynccontextmanager
    async def _session():
        yield None

    svc = GraphVersioningService(session_factory=_session)
    svc.walked = []

    async def _eid_for_urn(s, graph_id, branch_id, urn, as_of_seq=None):
        return urn

    async def _containment_ancestors(s, graph_id, branch_id, node_ids, cset, as_of_seq, max_climb=64):
        (eid,) = node_ids
        svc.walked.append(eid)
        return {eid, *([PARENT[eid]] if eid in PARENT else [])}, {}

    async def _current_values(s, graph_id, branch_id, ids, as_of_seq=None):
        return {e: {"urn": e} for e in ids}

    svc._eid_for_urn = _eid_for_urn
    svc._containment_ancestors = _containment_ancestors
    svc._current_values = _current_values
    return svc


def _adjust(svc, sources, targets, delta):
    out = asyncio.run(svc.aggregated_overlay_adjust(
        graph_id="g", branch_id="d", source_urns=sources, target_urns=targets,
        lineage_delta=delta, containment_edge_types=["CONTAINS"]))
    return {pair: v["weight"] for pair, v in out.items()}


def test_no_sources_named_adjusts_every_cell_into_the_targets():
    svc = _svc()
    got = _adjust(svc, [], ["B"], [("A.c", "B.c", "LINEAGE", +1), ("B.c", "C.c", "LINEAGE", -1)])
    # Every source-side end a stored cell into B can start from, as the base's
    # answer holds them.
    assert got == {("A.c", "B"): 1, ("A", "B"): 1}
    # The flow that does not reach B costs no walk of its source.
    assert sorted(svc.walked) == ["A.c", "B.c", "C.c"]


def test_no_targets_named_adjusts_every_cell_out_of_the_sources():
    svc = _svc()
    got = _adjust(svc, ["A"], None, [("A.c", "B.c", "LINEAGE", +1), ("C.c", "B.c", "LINEAGE", -1)])
    assert got == {("A", "B.c"): 1, ("A", "B"): 1}
    assert sorted(svc.walked) == ["A.c", "B.c", "C.c"]


def test_a_delta_edge_that_misses_the_sources_walks_nothing_more():
    svc = _svc()
    assert _adjust(svc, ["A"], ["B"], [("C.c", "B.c", "LINEAGE", +1)]) == {}
    assert svc.walked == ["C.c"]
    # And a pair ask answers only the pairs asked about, as it did.
    assert _adjust(_svc(), ["A", "B"], ["A", "B"], [("A.c", "B.c", "LINEAGE", +1)]) == {("A", "B"): 1}
