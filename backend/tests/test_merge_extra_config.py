"""Regression test — a data source must not override a provider's cacheConnection.

``ProviderManager._merge_extra_config`` used to do a top-level ``base.update(override)``,
so a data source's ``extra_config.cacheConnection`` won on merge. Since the provider's
cache credentials come from its own encrypted blob but the merged config (including
``host``) flowed to ``build_cache_client``, a data source (workspace-scoped,
``workspace:datasource:manage``) could redirect the provider's cache to an attacker
host and exfiltrate the provider's cache credentials on connect. cacheConnection is
now provider-authoritative: a data-source-supplied one is dropped (with a warning).
"""
from backend.app.providers.manager import ProviderManager
from backend.app.registry.provider_registry import ProviderRegistry


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


class TestMergeExtraConfigFalkordbConnection:
    """The same hole, one key over — and the one that reaches the GRAPH
    credentials rather than the cache's.

    ``extra_config.falkordbConnection`` is the provider's connection
    topology: host, port, mode, the cluster's startupNodes, the sentinel
    block, TLS, and the ``authEnabled`` gate.
    ``ProviderRegistry._create_provider_instance`` hands it to the provider
    as ``connection_config=`` **beside the decrypted ``username`` and
    ``password``** — so a data source that could set it would make the
    provider dial an attacker's host and authenticate to it, or flip
    ``authEnabled`` false and dial out unauthenticated. The guard was written
    for ``cacheConnection`` and never extended to its sibling.
    """

    def test_a_data_source_cannot_repoint_the_graph_connection(self, caplog):
        provider_cfg = {"falkordbConnection": {"host": "falkor.internal", "mode": "cluster"}}
        ds_cfg = {"falkordbConnection": {"host": "attacker.example", "authEnabled": False}}
        with caplog.at_level("WARNING"):
            result = ProviderManager._merge_extra_config(provider_cfg, ds_cfg)
        assert result["falkordbConnection"] == {"host": "falkor.internal", "mode": "cluster"}
        assert "attacker" not in str(result)
        assert any("falkordbConnection" in rec.message for rec in caplog.records)

    def test_it_cannot_introduce_one_a_provider_never_had(self):
        result = ProviderManager._merge_extra_config(
            {"other": "value"},
            {"falkordbConnection": {"host": "attacker.example"}},
        )
        assert "falkordbConnection" not in result
        assert result["other"] == "value"

    def test_the_registry_path_is_guarded_too(self, caplog):
        """Two merge implementations, and a guard on one is not a guard."""
        with caplog.at_level("WARNING"):
            result = ProviderRegistry._merge_extra_config(
                {"falkordbConnection": {"host": "falkor.internal"}},
                {"falkordbConnection": {"host": "attacker.example"}},
            )
        assert result["falkordbConnection"] == {"host": "falkor.internal"}
        assert "attacker" not in str(result)
