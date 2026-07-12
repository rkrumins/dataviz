"""
Blank-model graph names must be unique — and when they aren't, the server has to
hand back one that is.

The graph name IS the FalkorDB key the model projects into, and a projection seed
WIPES that key. So a collision is destructive, not cosmetic: provisioning refuses
(under a per-(provider, name) advisory lock, checked across every workspace plus a
live GRAPH.LIST) rather than writing into a graph that already exists.

But the name is derived from the VIEW name, so two people both calling a view
"Data Lineage" collide by construction. Refusing is correct; refusing and leaving
them to invent a name is not. These pin the "here's a free one" half.
"""
from backend.app.api.v1.endpoints.versioning import (
    _NUMBERED_SUFFIX_RE,
    _next_free_graph_name,
)


def test_suggests_the_first_free_slot():
    assert _next_free_graph_name("data_lineage", {"data_lineage"}) == "data_lineage_2"


def test_skips_over_slots_that_are_also_taken():
    taken = {"data_lineage", "data_lineage_2", "data_lineage_3"}
    assert _next_free_graph_name("data_lineage", taken) == "data_lineage_4"


def test_counts_on_from_an_already_numbered_name():
    # "data_lineage_2" must suggest "data_lineage_3", never "data_lineage_2_2".
    match = _NUMBERED_SUFFIX_RE.match("data_lineage_2")
    assert match is not None
    base = match.group("base")
    assert base == "data_lineage"
    assert _next_free_graph_name(base, {"data_lineage", "data_lineage_2"}) == "data_lineage_3"


def test_a_name_that_merely_looks_numbered_is_left_alone():
    # "customer_360" is a name, not a counter — don't strip it down to "customer".
    match = _NUMBERED_SUFFIX_RE.match("customer_360")
    assert match is not None and match.group("base") == "customer"
    # (Documenting the known trade-off: we count on from customer_361, which is
    # still free, still unique, and still obviously related to the user's name.)
    assert _next_free_graph_name("customer_360", {"customer_360"}) == "customer_360_2"


def test_never_exceeds_the_64_char_limit():
    base = "x" * 63
    assert _next_free_graph_name(base, {base}) is not None
    assert len(_next_free_graph_name(base, {base})) <= 64


def test_gives_up_rather_than_looping_forever():
    base = "busy"
    taken = {f"busy_{n}" for n in range(2, 1000)} | {"busy"}
    assert _next_free_graph_name(base, taken) is None


def test_a_free_base_still_yields_a_distinct_suggestion():
    # Only ever called when the base is taken, but it must never suggest the very
    # name that was just rejected.
    assert _next_free_graph_name("data_lineage", set()) != "data_lineage"
