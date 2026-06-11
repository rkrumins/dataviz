"""Tests for FalkorDB cluster/sentinel connection config: request-model
validation, and that BOTH provider-instantiation paths (ProviderManager AND
the deprecated ProviderRegistry used by the stats collector + read path) plumb
connection_config + credentials + cache_redis_url into FalkorDBProvider.

The instantiation tests construct the real FalkorDBProvider (it does not
connect in __init__) and inspect its stored attributes — no live FalkorDB.
"""
import pytest
from pydantic import ValidationError

from backend.common.models.management import ProviderCreateRequest


def _falkor_req(falkordb_connection, creds=None):
    return ProviderCreateRequest(
        name="t",
        providerType="falkordb",
        host="h",
        port=6379,
        credentials=creds,
        extraConfig={"falkordbConnection": falkordb_connection},
    )


# ── request validation ──────────────────────────────────────────────

def test_valid_cluster_config_accepted():
    req = _falkor_req({"mode": "cluster", "cluster": {"startupNodes": [["n1", 7000], ["n2", 7001]]}})
    assert req.extra_config["falkordbConnection"]["mode"] == "cluster"


def test_valid_sentinel_config_accepted():
    req = _falkor_req({"mode": "sentinel", "sentinel": {"masterName": "m", "nodes": [["s1", 26379]]}})
    assert req.extra_config["falkordbConnection"]["sentinel"]["masterName"] == "m"


def test_standalone_needs_no_nodes():
    req = _falkor_req({"mode": "standalone"})
    assert req.extra_config["falkordbConnection"]["mode"] == "standalone"


def test_bad_mode_rejected():
    with pytest.raises(ValidationError):
        _falkor_req({"mode": "galaxy"})


def test_cluster_requires_nodes():
    with pytest.raises(ValidationError):
        _falkor_req({"mode": "cluster", "cluster": {"startupNodes": []}})


def test_sentinel_requires_master_name():
    with pytest.raises(ValidationError):
        _falkor_req({"mode": "sentinel", "sentinel": {"nodes": [["s1", 26379]]}})


def test_node_with_bad_port_rejected():
    with pytest.raises(ValidationError):
        _falkor_req({"mode": "cluster", "cluster": {"startupNodes": [["n1", "notaport"]]}})


def test_bad_socket_timeout_rejected():
    with pytest.raises(ValidationError):
        _falkor_req({"mode": "standalone", "socketTimeout": -3})


def test_cache_redis_url_is_an_allowed_credential():
    # ConnectionCredentials has extra="forbid"; cache_redis_url must be declared.
    req = _falkor_req(
        {"mode": "cluster", "cluster": {"startupNodes": [["n1", 7000]]}},
        creds={"cache_redis_url": "redis://:pw@cache:6379/0"},
    )
    assert req.credentials.cache_redis_url == "redis://:pw@cache:6379/0"


# ── instantiation plumbing (both paths) ─────────────────────────────

_FALKOR_CONN = {"mode": "cluster", "cluster": {"startupNodes": [["n1", 7000]]}}
_CREDS = {"username": "u", "password": "p", "cache_redis_url": "redis://cache:6379/0"}


def _assert_plumbed(inst):
    assert inst._connection_config == _FALKOR_CONN
    assert inst._cache_redis_url == "redis://cache:6379/0"
    assert inst._username == "u"
    assert inst._password == "p"


def test_provider_manager_plumbs_connection_config():
    from backend.app.providers.manager import ProviderManager

    inst = ProviderManager._create_provider_instance(
        "falkordb", "h", 6379, "g", False,
        credentials=_CREDS, extra_config={"falkordbConnection": _FALKOR_CONN},
    )
    _assert_plumbed(inst)


def test_provider_registry_plumbs_connection_config():
    # Regression guard for the stats collector + viz read path (#3): the
    # deprecated registry previously dropped creds + extra_config entirely.
    from backend.app.registry.provider_registry import provider_registry

    inst = provider_registry._create_provider_instance(
        "falkordb", "h", 6379, "g", False,
        credentials=_CREDS, extra_config={"falkordbConnection": _FALKOR_CONN},
    )
    _assert_plumbed(inst)
