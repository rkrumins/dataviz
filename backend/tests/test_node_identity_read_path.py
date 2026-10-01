"""
Read-time half of the node-identity mapping.

Before this, the mapping only ever reached a provider inside the aggregation
worker, so a source keyed by ``id`` read as an EMPTY graph until someone
re-triggered aggregation — every node was dropped, one silent ``return None`` at
a time, in ``_node_from_props``. These tests pin the read path down: hydration
resolves the mapping with no aggregation run at all, and a conforming graph is
byte-for-byte unaffected.
"""
import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider, _node_from_props
from backend.common.providers.identity import (
    node_display_name_expr,
    node_identity_expr,
    node_name_columns,
    node_name_match,
    node_shown_name_expr,
    quote_property,
)


# ── hydration (the seam that used to drop every id-keyed node) ────────

def test_node_with_no_urn_is_dropped_when_nothing_is_mapped():
    """The historical behaviour, unchanged: without a mapping there is nothing
    to resolve identity from, so the node cannot be represented."""
    assert _node_from_props({"id": "n1", "name": "Orders"}) is None


def test_mapped_identity_hydrates_a_node_that_has_no_urn():
    node = _node_from_props(
        {"id": "n1", "name": "Orders"}, "Table", "id", "name",
    )
    assert node is not None
    assert node.urn == "n1"
    assert node.display_name == "Orders"


def test_native_urn_wins_over_the_mapped_property():
    """A node carrying the platform's own urn keeps it, so a partially stamped
    graph resolves consistently whichever half a node is in."""
    node = _node_from_props(
        {"urn": "urn:real", "id": "n1"}, "Table", "id", "name",
    )
    assert node.urn == "urn:real"


def test_configured_name_property_beats_the_guess_chain():
    """`name`/`title`/`label` is a guess; the configured property is the
    operator telling us where the name actually lives — including under a key
    the guess chain could never have contained."""
    node = _node_from_props(
        {"urn": "u1", "name": "wrong", "nodeTitle": "Right"},
        "Table", "urn", "nodeTitle",
    )
    assert node.display_name == "Right"


def test_display_name_still_falls_back_for_unmapped_sources():
    node = _node_from_props({"urn": "u1", "title": "From title"}, "Table")
    assert node.display_name == "From title"


def test_platform_display_name_outranks_the_mapped_property():
    """`displayName` is the canonical target: once the stamp has filled it, it
    is the answer, and the mapped source property is only the fallback."""
    node = _node_from_props(
        {"urn": "u1", "displayName": "Canonical", "title": "Source"},
        "Table", "urn", "title",
    )
    assert node.display_name == "Canonical"


def test_identity_markers_are_not_leaked_as_user_properties():
    """`urnSource`/`nameSource` are the stamp's own bookkeeping. Un-reserved,
    they would surface in every node's Properties panel."""
    node = _node_from_props(
        {"urn": "u1", "urnSource": "id", "nameSource": "title", "team": "data"},
        "Table",
    )
    assert node.properties == {"team": "data"}


def test_empty_props_is_still_none():
    assert _node_from_props({}) is None
    assert _node_from_props(None) is None


# ── the shared Cypher expressions ─────────────────────────────────────

def test_identity_expr_short_circuits_for_a_conforming_source():
    assert node_identity_expr(None) == "n.`urn`"
    assert node_identity_expr("urn") == "n.`urn`"
    assert node_identity_expr("  ") == "n.`urn`"


def test_identity_expr_coalesces_a_mapped_source():
    assert node_identity_expr("id") == "coalesce(n.`urn`, n.`id`)"


def test_identity_expr_binds_to_the_caller_s_variable():
    """Two call sites use different variable names; hardcoding `n` silently
    produced Cypher that referenced a variable not in scope."""
    assert node_identity_expr("id", "child") == "coalesce(child.`urn`, child.`id`)"


def test_display_name_expr_is_asymmetric_on_purpose():
    """The identity's canonical property and its default SOURCE are both `urn`,
    so `urn` short-circuits. A display name is canonically `displayName` but
    sourced from `name` by default — so `name` must still coalesce."""
    assert node_display_name_expr("displayName") == "n.`displayName`"
    assert node_display_name_expr("name") == "coalesce(n.`displayName`, n.`name`)"


@pytest.mark.parametrize("name_property, props, shown", [
    (None, {"name": "SNOWFLAKE_PROD"}, "SNOWFLAKE_PROD"),
    (None, {"displayName": "orders", "name": "ignored"}, "orders"),
    (None, {"displayName": "", "title": "Sales"}, "Sales"),
    ("assetName", {"assetName": "snowflake-ml", "name": "other"}, "snowflake-ml"),
    ("title", {"name": "first", "title": "second"}, "second"),
])
def test_the_name_columns_are_the_read_paths_order(name_property, props, shown):
    """Search, ranking and the canvas agree on a node's name only if the
    columns are read in ``_node_from_props``'s order."""
    node = _node_from_props({"urn": "u", **props}, name_property=name_property)
    assert node.display_name == shown
    first = next(props[c] for c in node_name_columns(name_property) if props.get(c))
    assert first == shown


def test_the_shown_name_is_the_first_text_of_those_columns():
    text = "CASE WHEN typeOf(n.`{0}`) = 'String' AND n.`{0}` <> '' THEN n.`{0}` END".format
    assert node_shown_name_expr("assetName") == (
        f"coalesce({text('displayName')}, {text('assetName')}, {text('name')}, "
        f"{text('title')}, {text('label')})")
    assert node_shown_name_expr(None, "c", fallback_only=True) == (
        f"coalesce({text('name').replace('n.', 'c.')}, {text('title').replace('n.', 'c.')}, "
        f"{text('label').replace('n.', 'c.')})")


def test_a_name_match_reads_the_fallback_only_without_a_display_name():
    where = node_name_match(None, lambda col: f"{col} CONTAINS $q", "c")
    assert where == (
        "c.displayName CONTAINS $q OR ((c.displayName IS NULL OR c.displayName = '') AND "
        f"{node_shown_name_expr(None, 'c', fallback_only=True)} CONTAINS $q)")


def test_the_simple_searches_match_the_shown_name_or_the_urn():
    """Find in a container, the top-level list and ``/search`` share one
    condition — the configured name property included."""
    provider = FalkorDBProvider.__new__(FalkorDBProvider)
    provider.set_node_identity(None, "assetName")
    cond = provider._name_or_urn_contains("c", "$s")
    assert cond.startswith("toLower(toString(c.displayName)) CONTAINS $s OR ((c.displayName IS NULL")
    assert "c.`assetName`" in cond
    assert cond.endswith(" OR toLower(toString(c.urn)) CONTAINS $s")


@pytest.mark.parametrize("hostile", ["id`", "a`b", "`", "x``y"])
def test_quoting_cannot_break_out_of_the_backticks(hostile):
    quoted = quote_property(hostile)
    assert quoted.startswith("`") and quoted.endswith("`")
    assert "`" not in quoted[1:-1]
