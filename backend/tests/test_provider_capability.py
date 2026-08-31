"""Provider capability registry (redesign Phase A) — pure unit, no DB.

The shared, enforced capability that drives write routing and the managed-vs-federated
source model: managed stores (FalkorDB/Spanner/Neo4j) are writable; external catalogs
(DataHub) are read-only views; unknown providers default to the safe read-only/external.

``capability_for`` now reads ``backend.common.providers.catalog`` (T-E) rather than a
hardcoded dict -- see ``test_capability_for_reads_the_catalog`` below.
"""
import backend.app.providers.falkordb  # noqa: F401  (registers "falkordb" -- see catalog/__init__.py docstring)
from backend.common.interfaces.provider import ProviderFeature, capability_for
from backend.common.providers.catalog import descriptor_for


def test_managed_providers_are_writable():
    falkor = capability_for("falkordb")
    # Not a full ProviderCapability(...) equality: falkordb's `features` set
    # (see test_capability_for_reads_the_catalog) is non-empty, so a 4-field
    # literal (features defaulting to frozenset()) would never compare equal.
    assert falkor.writable is True and falkor.full_crud is True
    assert falkor.is_external is False and falkor.supports_copy is True
    assert capability_for("spanner").writable is True and capability_for("spanner").full_crud is True
    # Neo4j writes (create) but not full CRUD (update/delete edges unsupported today)
    neo = capability_for("neo4j")
    assert neo.writable is True and neo.full_crud is False and neo.is_external is False


def test_external_catalog_is_read_only_view():
    dh = capability_for("datahub")
    assert dh.writable is False and dh.is_external is True


def test_lookup_is_case_insensitive_and_safe_default():
    assert capability_for("FalkorDB").writable is True
    for unknown in ("totally-unknown", "", None):
        cap = capability_for(unknown)
        assert cap.writable is False and cap.is_external is True   # safe: never write a store we don't model


def test_capability_for_reads_the_catalog():
    """capability_for(x) is exactly descriptor_for(x).capability -- the
    catalog is the only source now, not a copy of it."""
    import backend.common.interfaces.provider as provider_module
    assert not hasattr(provider_module, "PROVIDER_CAPABILITIES")
    for type_id in ("falkordb", "neo4j", "spanner", "datahub"):
        assert capability_for(type_id) == descriptor_for(type_id).capability


def test_falkordb_features_include_trace_closure_neo4j_does_not():
    assert capability_for("falkordb").supports(ProviderFeature.TRACE_CLOSURE) is True
    assert capability_for("neo4j").supports(ProviderFeature.TRACE_CLOSURE) is False
    assert capability_for("neo4j").supports(ProviderFeature.SCHEMA_DISCOVERY) is True
