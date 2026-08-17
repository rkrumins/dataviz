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

from backend.app.providers.falkordb_provider import _node_from_props
from backend.common.providers.identity import (
    node_display_name_expr,
    node_identity_expr,
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


def test_the_mapped_property_wins_on_a_mapped_source():
    """The value handed out here is the one every WHERE predicate gets back, so
    it must be the property those predicates can seek on. Preferring the
    canonical urn would hand out a native urn for some nodes and a mapped id for
    others on the SAME source, and no single predicate finds both.

    On a stamped graph this is a distinction without a difference — the stamp
    copies the mapped property onto `urn` rather than moving it, so they agree."""
    node = _node_from_props(
        {"urn": "urn:real", "id": "n1"}, "Table", "id", "name",
    )
    assert node.urn == "n1"


def test_canonical_urn_still_addresses_a_node_that_has_no_mapped_property():
    """The mixed case: a node on a mapped source that never carried the mapped
    property stays addressable instead of being silently dropped."""
    node = _node_from_props({"urn": "urn:real"}, "Table", "id", "name")
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


@pytest.mark.parametrize("hostile", ["id`", "a`b", "`", "x``y"])
def test_quoting_cannot_break_out_of_the_backticks(hostile):
    quoted = quote_property(hostile)
    assert quoted.startswith("`") and quoted.endswith("`")
    assert "`" not in quoted[1:-1]


# ── the full property mapping (MappedCypher) ──────────────────────────

from backend.common.providers.identity import (  # noqa: E402
    PLATFORM_OWNED_PROPERTIES, MappedCypher,
)
from backend.graph.adapters.schema_mapping import SchemaMapping  # noqa: E402


def _mapped() -> MappedCypher:
    return MappedCypher(SchemaMapping(
        identity_field="id", display_name_field="title",
        qualified_name_field="fqn", description_field="descr",
        tags_field="labels",
    ))


def test_conforming_source_emits_canonical_cypher():
    """The no-op contract: a source that maps nothing must produce exactly the
    Cypher this provider emitted before any mapping existed."""
    for m in (MappedCypher(None), MappedCypher(SchemaMapping())):
        assert m.is_conforming
        assert m.ident("n") == "n.`urn`"
        assert m.name("n") == "n.`displayName`"
        assert m.field("qualifiedName", "n") == "n.`qualifiedName`"


def test_mapped_source_renders_its_own_property_names():
    m = _mapped()
    assert not m.is_conforming
    assert m.ident("n") == "coalesce(n.`urn`, n.`id`)"
    assert m.name("x") == "coalesce(x.`displayName`, x.`title`)"
    assert m.field("qualifiedName", "n") == "n.`fqn`"
    assert m.field("description", "t") == "t.`descr`"


def test_ident_prop_is_the_index_seekable_form():
    """`ident()` tolerates a half-stamped graph but cannot use an index;
    `ident_prop()` is the bare access for predicates, MERGE keys and ORDER BY."""
    m = _mapped()
    assert m.ident_prop("n") == "n.`id`"
    assert "coalesce" not in m.ident_prop("n")
    assert MappedCypher(None).ident_prop("n") == "n.`urn`"


@pytest.mark.parametrize("canonical", sorted(PLATFORM_OWNED_PROPERTIES))
def test_platform_owned_properties_are_never_mapped(canonical):
    """The platform invents these, so a foreign graph has no name for them.
    Mapping one would send a query looking for a property nothing writes."""
    assert _mapped().property_for(canonical) == canonical


def test_hydration_maps_every_source_owned_field():
    node = _node_from_props(
        {"id": "n1", "title": "Orders", "fqn": "db.orders",
         "descr": "desc", "labels": '["pii"]', "team": "data"},
        "Table", None, None, _mapped(),
    )
    assert node.urn == "n1"
    assert node.display_name == "Orders"
    assert node.qualified_name == "db.orders"
    assert node.description == "desc"
    assert node.tags == ["pii"]


def test_a_mapped_key_is_not_also_reported_as_a_user_property():
    """`fqn` became `qualifiedName`. Leaving it in `properties` too would show
    the same value twice in the Properties panel."""
    node = _node_from_props(
        {"id": "n1", "title": "Orders", "fqn": "db.orders", "team": "data"},
        "Table", None, None, _mapped(),
    )
    assert node.properties == {"team": "data"}


def test_platform_owned_values_still_hydrate_from_their_literal_names():
    node = _node_from_props(
        {"id": "n1", "title": "T", "layerAssignment": "L", "childCount": 3},
        "Table", None, None, _mapped(),
    )
    assert node.layer_assignment == "L"
    assert node.child_count == 3


# ── composing the two halves of the mapping ───────────────────────────

def _provider(extra_config=None):
    """A bare provider instance — enough to exercise the mapping plumbing
    without a connection."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g"
    p._extra_config = extra_config
    p._mapped = None
    return p


def test_provider_self_seeds_from_stored_schema_mapping():
    """A provider configured the OLD way (extra_config.schemaMapping) is mapped
    from its first query, before anything injects the scoped half."""
    p = _provider({"schemaMapping": {"qualified_name_field": "fqn"}})
    assert p._map.field("qualifiedName", "n") == "n.`fqn`"


def test_scoped_identity_layers_over_stored_schema_mapping():
    """The two halves come from different places — the scoped identity/name from
    the four-scope resolver, everything else from provider config — and both
    have to end up in one mapping."""
    p = _provider({"schemaMapping": {"qualified_name_field": "fqn"}})
    p.set_node_identity("id", "title")
    assert p._map.ident_prop("n") == "n.`id`"
    assert p._map.name("n") == "coalesce(n.`displayName`, n.`title`)"
    assert p._map.field("qualifiedName", "n") == "n.`fqn`", "provider config must survive"


def test_reset_restores_canonical_identity_but_keeps_provider_config():
    """The 'always reset' contract clears the SCOPED half only. extra_config is
    this provider's own configuration, not the previous job's leftovers."""
    p = _provider({"schemaMapping": {"qualified_name_field": "fqn"}})
    p.set_node_identity("id", "title")
    p.set_node_identity(None, None)
    assert p._map.ident("n") == "n.`urn`"
    assert p._map.name("n") == "n.`displayName`"
    assert p._map.field("qualifiedName", "n") == "n.`fqn`"


def test_unreadable_extra_config_degrades_to_conforming():
    p = _provider({"schemaMapping": "not a mapping"})
    assert p._map.ident("n") == "n.`urn`"
