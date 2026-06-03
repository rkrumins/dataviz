"""Provider capability registry (redesign Phase A) — pure unit, no DB.

The shared, enforced capability that drives write routing and the managed-vs-federated
source model: managed stores (FalkorDB/Spanner/Neo4j) are writable; external catalogs
(DataHub) are read-only views; unknown providers default to the safe read-only/external.
"""
from backend.common.interfaces.provider import ProviderCapability, capability_for


def test_managed_providers_are_writable():
    assert capability_for("falkordb") == ProviderCapability(
        writable=True, full_crud=True, is_external=False, supports_copy=True)
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
