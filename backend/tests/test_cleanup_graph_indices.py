"""THE MATCHER DECIDES WHAT GETS DROPPED FROM A PRODUCTION GRAPH.

`cleanup_graph_indices.py` drops indexes. Getting the match wrong does not
raise, does not fail a check, and is not cheap to undo — the index has to be
rebuilt, which on a multi-gigabyte graph is minutes of that node's time, and
if the wrong one goes the queries that used it fall back to scans.

So the safety property is exactness, and these tests are about the ways an
almost-right matcher would be wrong:

* A COMPOSITE (sourceDepth, targetDepth) must not answer a request to drop
  (sourceDepth) alone. Substring or subset matching takes the composite with
  it — the one index in that family that may actually be load-bearing.
* A row this build's `db.indexes()` formats in a way we do not recognise must
  match NOTHING. Unparsed means untouched; the safe direction is always to
  drop less.
* Node indexes and other people's indexes are not ours to remove.
"""
import importlib.util
import os

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "cleanup_graph_indices",
    os.path.join(os.path.dirname(__file__), "..", "scripts", "cleanup_graph_indices.py"),
)
cleanup = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cleanup)

from backend.app.providers.index_policy import (  # noqa: E402
    CONDITIONAL_EDGE_INDEXES, RETIRED_EDGE_INDEXES, declared_edge_indexes,
)


def _row(*cells):
    """A catalogue row as `read_index_catalogue` shapes one."""
    return {"cells": list(cells), "text": " ".join(cells)}


# ── the exactness property ───────────────────────────────────────────────


def test_a_composite_does_not_answer_a_request_for_one_of_its_columns():
    """The failure that would matter most. (sourceDepth, targetDepth) is the
    index that may genuinely serve the unlabelled frontier bucket; a matcher
    that treats a drop of (sourceDepth) as matching it would remove the one
    thing in that family worth keeping."""
    composite = _row("AGGREGATED", "sourceDepth", "targetDepth")
    assert not cleanup._row_is(composite, "AGGREGATED", ("sourceDepth",))
    assert not cleanup._row_is(composite, "AGGREGATED", ("targetDepth",))
    assert cleanup._row_is(composite, "AGGREGATED", ("sourceDepth", "targetDepth"))


def test_a_single_column_row_matches_only_its_own_column():
    single = _row("AGGREGATED", "sourceDepth")
    assert cleanup._row_is(single, "AGGREGATED", ("sourceDepth",))
    assert not cleanup._row_is(single, "AGGREGATED", ("targetDepth",))
    assert not cleanup._row_is(single, "AGGREGATED", ("sourceDepth", "targetDepth"))


def test_column_order_does_not_change_the_verdict():
    """`db.indexes()` column order varies by version; the properties are a
    set, not a sequence."""
    assert cleanup._row_is(
        _row("AGGREGATED", "targetDepth", "sourceDepth"),
        "AGGREGATED", ("sourceDepth", "targetDepth"))


def test_another_relationship_type_is_never_ours():
    assert not cleanup._row_is(
        _row("CONTAINS", "sourceDepth"), "AGGREGATED", ("sourceDepth",))


def test_a_node_index_is_never_matched():
    """Per-label urn indexes drive every write in the aggregation hot path.
    Dropping one turns each MERGE into a full node scan."""
    assert not cleanup._row_is(_row("dataset", "urn"), "AGGREGATED", ("sourceDepth",))
    assert not cleanup._row_is(_row("schemaField", "urn"), "AGGREGATED", ("targetLevel",))


def test_a_row_we_cannot_parse_matches_nothing():
    """A build whose catalogue we do not understand must cost us nothing but
    a line of output. Unparsed means untouched."""
    opaque = _row("some", "unfamiliar", "shape", "42")
    for ix in RETIRED_EDGE_INDEXES:
        assert not cleanup._row_is(opaque, ix.rel, ix.props)
    assert not cleanup._row_is(_row(), "AGGREGATED", ("sourceDepth",))


# ── scope ────────────────────────────────────────────────────────────────


def test_every_retired_index_is_single_column_and_never_aggkey():
    """aggKey is the one edge index a plan genuinely enters through — the
    reconcile phase's keyed delete. It must never be in scope."""
    for ix in RETIRED_EDGE_INDEXES:
        assert len(ix.props) == 1, f"{ix.props} — composites are not in scope here"
        assert "aggKey" not in ix.props


def test_the_conditional_composites_are_not_dropped_by_this_script():
    """They may serve the unlabelled frontier bucket, where FalkorDB has no
    label-less node index to offer instead. That question needs a PROFILE
    against a real cluster, not a script's opinion."""
    retired = {(ix.rel, ix.props) for ix in RETIRED_EDGE_INDEXES}
    for ix in CONDITIONAL_EDGE_INDEXES:
        assert (ix.rel, ix.props) not in retired


def test_nothing_declared_is_also_retired():
    """Overlap would drop an index the application recreates on the next run:
    a churn loop over an index rebuild, on the largest graphs."""
    declared = {(ix.rel, ix.props) for ix in declared_edge_indexes()}
    retired = {(ix.rel, ix.props) for ix in RETIRED_EDGE_INDEXES}
    assert not (declared & retired)


# ── the DDL it will issue ────────────────────────────────────────────────


def test_both_drop_spellings_are_offered():
    """FalkorDB has carried two. Which one a build takes is not something to
    assume, so the script tries the modern form and falls back."""
    ix = RETIRED_EDGE_INDEXES[0]
    modern, legacy = ix.drop_ddl(), ix.drop_ddl(legacy=True)
    assert modern.startswith("DROP INDEX FOR ()-[r:AGGREGATED]-()")
    assert legacy.startswith("DROP INDEX ON :AGGREGATED(")
    assert modern != legacy


def test_the_create_and_drop_ddl_describe_the_same_index():
    for ix in declared_edge_indexes() + RETIRED_EDGE_INDEXES:
        for prop in ix.props:
            assert f"r.{prop}" in ix.ddl
            assert f"r.{prop}" in ix.drop_ddl()


# ── reading the catalogue ────────────────────────────────────────────────


@pytest.mark.parametrize("reply,expected", [
    ([["Label", "Properties"], [["AGGREGATED", ["sourceDepth"]]], ["stats"]], 1),
    ([["h"], [], ["stats"]], 0),
])
def test_the_catalogue_reader_flattens_nested_property_lists(reply, expected):
    """Some versions return the indexed properties as a nested list. Losing
    them would make every row unparseable — which is safe, but useless."""
    import asyncio

    class _Client:
        async def execute_command(self, *_a):
            return reply

    rows = asyncio.run(cleanup.read_index_catalogue(_Client(), "g"))
    assert len(rows) == expected
    if expected:
        assert cleanup._row_is(rows[0], "AGGREGATED", ("sourceDepth",))


def test_a_catalogue_that_refuses_is_an_error_not_an_empty_result():
    """An empty catalogue would read as "no retired indexes here" and the
    graph would be silently skipped, reported as clean."""
    import asyncio

    class _Refusing:
        async def execute_command(self, *_a):
            raise RuntimeError("unknown command 'db.indexes'")

    with pytest.raises(RuntimeError, match="db.indexes"):
        asyncio.run(cleanup.read_index_catalogue(_Refusing(), "g"))
