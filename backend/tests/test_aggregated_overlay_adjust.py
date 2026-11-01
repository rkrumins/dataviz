"""The rollup cells an overlay's flows move (``draft_overlay_provider._rollup_cells``), one side open.

Selecting a collapsed container on a draft asks its base for every roll-up out of it (no targets
named) or into it (no sources named), and the draft patches that answer with its own flows. With no
sources named no adjustment could be kept, so the draft's own flows were missing from the
in-direction; with no targets named the adjustment was taken among the sources themselves, which
drops every flow out of them.

The ends' chains are given, as the overlay keeps them per patch set: A ⊃ A.c, B ⊃ B.c, C ⊃ C.c.
"""
from backend.app.providers.draft_overlay_provider import _rollup_cells
from backend.common.models.graph import GraphEdge

CHAINS = {"A.c": ["A"], "B.c": ["B"], "C.c": ["C"]}


def _adjust(sources, targets, delta):
    out = {}
    for s, t, sign in delta:
        flow = GraphEdge.model_construct(id=f"{s}-{t}", sourceUrn=s, targetUrn=t, edgeType="LINEAGE",
                                         properties={})
        _rollup_cells([flow], sign, CHAINS, set(sources or []), set(targets or []), out)
    return {pair: v["weight"] for pair, v in out.items()}


def test_no_sources_named_adjusts_every_cell_into_the_targets():
    got = _adjust([], ["B"], [("A.c", "B.c", +1), ("B.c", "C.c", -1)])
    # Every source-side end a stored cell into B can start from, as the base's answer holds them.
    assert got == {("A.c", "B"): 1, ("A", "B"): 1}


def test_no_targets_named_adjusts_every_cell_out_of_the_sources():
    assert _adjust(["A"], None, [("A.c", "B.c", +1), ("C.c", "B.c", -1)]) == {
        ("A", "B.c"): 1, ("A", "B"): 1}


def test_a_flow_that_misses_the_sources_moves_nothing():
    assert _adjust(["A"], ["B"], [("C.c", "B.c", +1)]) == {}
    # And a pair ask answers only the pairs asked about, as it did.
    assert _adjust(["A", "B"], ["A", "B"], [("A.c", "B.c", +1)]) == {("A", "B"): 1}


def test_an_end_with_no_chain_places_only_itself():
    """An end that is not a live node on the overlay's state has no chain: it places itself."""
    assert _adjust(["A", "gone"], ["B"], [("gone", "B.c", +1)]) == {("gone", "B"): 1}
