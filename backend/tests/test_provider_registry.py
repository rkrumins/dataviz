"""
Phase 3 — Unit tests for backend.app.registry.provider_registry.ProviderRegistry

Tests target the pure-logic helpers and cache behavior. Methods that require
a database session (get_provider_for_workspace, etc.) are not tested here.
"""
import pytest

from backend.app.registry.provider_registry import ProviderRegistry
from backend.common.interfaces.provider import GraphDataProvider


# ---------------------------------------------------------------------------
# Minimal stub for cache tests (no real connection needed)
# ---------------------------------------------------------------------------

class _StubProvider(GraphDataProvider):
    """Lightweight stub that satisfies the GraphDataProvider interface."""

    @property
    def name(self) -> str:
        return "stub"

    async def close(self) -> None:
        pass

    # All other abstract methods are left unimplemented — these tests
    # only exercise cache management, not provider behaviour.


# ---------------------------------------------------------------------------
# Tests — _create_provider_instance
# ---------------------------------------------------------------------------


class TestCreateProviderInstance:
    def test_falkordb_provider(self):
        reg = ProviderRegistry()
        provider = reg._create_provider_instance(
            provider_type="falkordb",
            host="localhost", port=6379, graph_name="test_graph",
            tls_enabled=False, credentials={},
        )
        from backend.app.providers.falkordb_provider import FalkorDBProvider
        assert isinstance(provider, FalkorDBProvider)

    def test_unknown_provider_raises(self):
        reg = ProviderRegistry()
        with pytest.raises(ValueError, match="Unknown provider_type"):
            reg._create_provider_instance(
                provider_type="nonexistent",
                host=None, port=None, graph_name=None,
                tls_enabled=False, credentials={},
            )

    def test_provider_type_is_case_insensitive(self):
        """FalkorDB should be resolved regardless of case."""
        reg = ProviderRegistry()
        provider = reg._create_provider_instance(
            provider_type="FALKORDB",
            host="localhost", port=6379, graph_name="g",
            tls_enabled=False, credentials={},
        )
        from backend.app.providers.falkordb_provider import FalkorDBProvider
        assert isinstance(provider, FalkorDBProvider)


# ---------------------------------------------------------------------------
# Tests — _merge_extra_config
# ---------------------------------------------------------------------------


class TestMergeExtraConfig:
    def test_both_none_returns_none(self):
        result = ProviderRegistry._merge_extra_config(None, None)
        assert result is None

    def test_provider_only(self):
        result = ProviderRegistry._merge_extra_config({"a": 1}, None)
        assert result == {"a": 1}

    def test_datasource_only(self):
        result = ProviderRegistry._merge_extra_config(None, {"b": 2})
        assert result == {"b": 2}

    def test_overlapping_keys_datasource_wins(self):
        result = ProviderRegistry._merge_extra_config({"k": "old"}, {"k": "new"})
        assert result["k"] == "new"

    def test_deep_merge_schema_mapping(self):
        """schemaMapping sub-key is deep-merged, not wholesale replaced."""
        provider_cfg = {
            "schemaMapping": {"nodeLabel": "Entity", "urnProperty": "urn"},
            "other": "value",
        }
        ds_cfg = {
            "schemaMapping": {"nodeLabel": "Node"},
        }
        result = ProviderRegistry._merge_extra_config(provider_cfg, ds_cfg)
        assert result["schemaMapping"]["nodeLabel"] == "Node"  # overridden
        assert result["schemaMapping"]["urnProperty"] == "urn"  # preserved from base
        assert result["other"] == "value"

    def test_schema_mapping_only_in_datasource(self):
        """When only datasource has schemaMapping, no deep merge needed."""
        result = ProviderRegistry._merge_extra_config(
            {"a": 1},
            {"schemaMapping": {"nodeLabel": "X"}},
        )
        assert result["schemaMapping"]["nodeLabel"] == "X"
        assert result["a"] == 1


# ---------------------------------------------------------------------------
# Tests — evict_all / cache behavior
# ---------------------------------------------------------------------------


class TestCacheBehavior:
    async def test_evict_all_clears_all_caches(self):
        reg = ProviderRegistry()
        stub = _StubProvider()
        reg._providers[("prov1", "graph1")] = stub
        reg._legacy_providers["conn1"] = stub
        reg._default_ws_id = "ws_123"

        await reg.evict_all()

        assert len(reg._providers) == 0
        assert len(reg._legacy_providers) == 0
        assert reg._default_ws_id is None

    async def test_evict_data_source_removes_specific_key(self):
        reg = ProviderRegistry()
        stub = _StubProvider()
        reg._providers[("prov1", "g1")] = stub
        reg._providers[("prov2", "g2")] = stub

        await reg.evict_data_source("prov1", "g1")

        assert ("prov1", "g1") not in reg._providers
        assert ("prov2", "g2") in reg._providers

    def test_cache_key_is_provider_id_graph_name_tuple(self):
        """Verify the cache uses (provider_id, graph_name) as key."""
        reg = ProviderRegistry()
        stub = _StubProvider()

        key = ("provider_abc", "my_graph")
        reg._providers[key] = stub
        assert reg._providers[("provider_abc", "my_graph")] is stub
