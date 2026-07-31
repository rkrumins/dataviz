"""Regression test — a data source must not override a provider's cacheConnection.

``ProviderManager._merge_extra_config`` used to do a top-level ``base.update(override)``,
so a data source's ``extra_config.cacheConnection`` won on merge. Since the provider's
cache credentials come from its own encrypted blob but the merged config (including
``host``) flowed to ``build_cache_client``, a data source (workspace-scoped,
``workspace:datasource:manage``) could redirect the provider's cache to an attacker
host and exfiltrate the provider's cache credentials on connect. cacheConnection is
now provider-authoritative: a data-source-supplied one is dropped (with a warning).
"""
import pytest

from backend.app.providers.manager import ProviderManager
from backend.app.registry.provider_registry import ProviderRegistry
from backend.graph.adapters.schema_mapping import SchemaMapping


class TestMergeExtraConfigCacheConnection:
    def test_datasource_cache_connection_override_is_dropped(self, caplog):
        provider_cfg = {"cacheConnection": {"host": "provider-cache.internal"}}
        ds_cfg = {"cacheConnection": {"host": "attacker"}}
        with caplog.at_level("WARNING"):
            result = ProviderManager._merge_extra_config(provider_cfg, ds_cfg)
        assert result["cacheConnection"] == {"host": "provider-cache.internal"}
        assert "attacker" not in str(result)
        assert any("cacheConnection" in rec.message for rec in caplog.records)

    def test_datasource_cache_connection_with_no_provider_one_is_absent(self):
        result = ProviderManager._merge_extra_config(
            {"other": "value"}, {"cacheConnection": {"host": "attacker"}}
        )
        assert "cacheConnection" not in result
        assert result["other"] == "value"

    def test_provider_only_cache_connection_passes_through_untouched(self):
        provider_cfg = {"cacheConnection": {"host": "provider-cache.internal"}}
        result = ProviderManager._merge_extra_config(provider_cfg, None)
        assert result["cacheConnection"] == {"host": "provider-cache.internal"}

    def test_benign_datasource_key_still_merges_through(self):
        """The block is cacheConnection-only — other override keys are unaffected."""
        provider_cfg = {
            "cacheConnection": {"host": "provider-cache.internal"},
            "schemaMapping": {"nodeLabel": "Entity", "urnProperty": "urn"},
        }
        ds_cfg = {"schemaMapping": {"nodeLabel": "Node"}}
        result = ProviderManager._merge_extra_config(provider_cfg, ds_cfg)
        assert result["cacheConnection"] == {"host": "provider-cache.internal"}
        assert result["schemaMapping"]["nodeLabel"] == "Node"  # overridden
        assert result["schemaMapping"]["urnProperty"] == "urn"  # preserved from base


class TestRegistryMergeExtraConfigCacheConnection:
    """The deprecated-but-still-live ``ProviderRegistry`` (used by the insights
    cache-warmer/collector) has the same merge and the same exploit path
    (``_merge_extra_config`` -> ``_create_provider_instance`` -> ``build_cache_client``
    with the provider's credentials). It must enforce the same invariant."""

    def test_datasource_cache_connection_override_is_dropped(self, caplog):
        provider_cfg = {"cacheConnection": {"host": "provider-cache.internal"}}
        ds_cfg = {"cacheConnection": {"host": "attacker"}}
        with caplog.at_level("WARNING"):
            result = ProviderRegistry._merge_extra_config(provider_cfg, ds_cfg)
        assert result["cacheConnection"] == {"host": "provider-cache.internal"}
        assert "attacker" not in str(result)

    def test_datasource_cache_connection_with_no_provider_one_is_absent(self):
        result = ProviderRegistry._merge_extra_config(
            {"other": "value"}, {"cacheConnection": {"host": "attacker"}}
        )
        assert "cacheConnection" not in result
        assert result["other"] == "value"

    def test_benign_datasource_key_still_merges_through(self):
        provider_cfg = {
            "cacheConnection": {"host": "provider-cache.internal"},
            "schemaMapping": {"nodeLabel": "Entity", "urnProperty": "urn"},
        }
        ds_cfg = {"schemaMapping": {"nodeLabel": "Node"}}
        result = ProviderRegistry._merge_extra_config(provider_cfg, ds_cfg)
        assert result["cacheConnection"] == {"host": "provider-cache.internal"}
        assert result["schemaMapping"]["nodeLabel"] == "Node"
        assert result["schemaMapping"]["urnProperty"] == "urn"


class TestPropertyUnpackingMappingFields:
    """``properties_separator`` / ``property_overrides`` ride the existing
    ``extra_config.schemaMapping`` blob — no new columns — so they must survive
    both merge implementations and both parse factories."""

    def test_defaults_match_the_platform_schema(self):
        mapping = SchemaMapping()
        assert mapping.properties_separator == "/"
        assert mapping.property_overrides == {}
        assert mapping.is_default is True

    def test_parsed_from_extra_config(self):
        mapping = SchemaMapping.from_extra_config({
            "schemaMapping": {
                "properties_field": "attributes",
                "properties_separator": ".",
                "property_overrides": {"level": "source/level"},
            },
        })
        assert mapping.properties_field == "attributes"
        assert mapping.properties_separator == "."
        assert mapping.property_overrides == {"level": "source/level"}

    def test_datasource_overrides_provider_defaults(self):
        mapping = SchemaMapping.merge(
            {"schemaMapping": {"properties_field": "attributes",
                               "properties_separator": "/"}},
            {"schemaMapping": {"properties_separator": "."}},
        )
        assert mapping.properties_field == "attributes"   # from provider
        assert mapping.properties_separator == "."        # data source wins

    @pytest.mark.parametrize("merger", [ProviderManager, ProviderRegistry])
    def test_survives_both_merge_implementations(self, merger):
        """The deep-merge of ``schemaMapping`` is duplicated in two modules
        that must stay in sync."""
        result = merger._merge_extra_config(
            {"schemaMapping": {"properties_field": "attributes"}},
            {"schemaMapping": {"property_overrides": {"level": "source/level"}}},
        )
        mapping = SchemaMapping.from_extra_config(result)
        assert mapping.properties_field == "attributes"
        assert mapping.property_overrides == {"level": "source/level"}
