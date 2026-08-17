"""
Golden Cypher for the mapped FalkorDB provider.

Phase B rewrites the identity reference in ~40 query builders. Reviewing that by
reading diffs does not scale, so the contract is pinned here instead: for one
conforming source and one mapped source, assert the SHAPE of what each builder
emits. A regression shows up as a diff in a string, not as an empty canvas three
services downstream.

The provider is constructed without a connection — these tests are about the
Cypher, not about running it.
"""
import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.providers.identity import MappedCypher
from backend.graph.adapters.schema_mapping import SchemaMapping


def _provider(*, mapped: bool, projection_mode: str = "in_source"):
    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g"
    p._extra_config = None
    p._projection_mode = projection_mode
    p._mapped = MappedCypher(
        SchemaMapping(identity_field="id", display_name_field="title")
        if mapped else None
    )
    return p


@pytest.fixture
def conforming():
    return _provider(mapped=False)


@pytest.fixture
def mapped():
    return _provider(mapped=True)


# ── the three identity renderings ─────────────────────────────────────

def test_conforming_source_renders_the_canonical_property(conforming):
    assert conforming._ident() == "n.`urn`"
    assert conforming._ident("child") == "child.`urn`"
    assert conforming._ident_key() == "`urn`"


def test_mapped_source_renders_its_own_property(mapped):
    assert mapped._ident() == "n.`id`"
    assert mapped._ident("child") == "child.`id`"
    assert mapped._ident_key() == "`id`"


def test_predicates_never_use_coalesce(mapped):
    """A `coalesce` cannot use an index, and every one of these renderings ends
    up in a WHERE, a map literal or an ORDER BY. On a multi-million-node graph
    that is the difference between a seek and a full label scan."""
    for rendered in (mapped._ident(), mapped._ident("s"), mapped._ident_key()):
        assert "coalesce" not in rendered


# ── the map-literal form MERGE depends on ─────────────────────────────

def test_identity_key_is_usable_as_a_map_literal_key(mapped):
    """This is the form that makes a fully-mapped provider possible at all: a
    MERGE cannot key on an expression, but it can key on a real property, and a
    mapped source HAS a real property."""
    cypher = f"MERGE (n:Table {{{mapped._ident_key()}: $urn}})"
    assert cypher == "MERGE (n:Table {`id`: $urn})"


@pytest.mark.parametrize("hostile", ["id`", "we`ird"])
def test_a_hostile_property_name_cannot_escape_the_map_literal(hostile):
    p = _provider(mapped=False)
    p._mapped = MappedCypher(SchemaMapping(identity_field=hostile))
    key = p._ident_key()
    assert key.startswith("`") and key.endswith("`")
    assert "`" not in key[1:-1]


# ── projection placement ──────────────────────────────────────────────

def test_dedicated_projection_stays_canonical_even_on_a_mapped_source():
    """A dedicated projection is a separate graph the platform creates and
    populates itself. Keying its stub nodes by the SOURCE's property would look
    for something nothing ever wrote there."""
    p = _provider(mapped=True, projection_mode="dedicated")
    assert p._proj_ident_key() == "`urn`"
    # …while reads of the real source graph stay mapped.
    assert p._ident() == "n.`id`"


def test_in_source_projection_uses_the_source_identity():
    """Here the 'projection' IS the source graph, so the rollup MERGE has to key
    on the customer's own identity or it creates a duplicate node set beside the
    real one."""
    p = _provider(mapped=True, projection_mode="in_source")
    assert p._proj_ident_key() == "`id`"


# ── the mapping self-seeds ────────────────────────────────────────────

def test_a_provider_with_no_injection_still_maps_from_its_own_config():
    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g"
    p._projection_mode = "in_source"
    p._extra_config = {"schemaMapping": {"identity_field": "uuid"}}
    p._mapped = None
    assert p._ident() == "n.`uuid`"
    assert p._ident_key() == "`uuid`"
