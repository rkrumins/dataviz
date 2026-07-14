"""Unit tests for the central Redis endpoint resolver.

The invariant under test: cache and streams are INDEPENDENT. A credential or a
cert configured for one role must never reach the other, and neither inherits
from FalkorDB. Regressions here re-open the bug where REDIS_PASSWORD was
honoured by the bus but silently ignored by token revocation.
"""
import pytest

from backend.common.adapters.redis_endpoint import (
    ProviderCacheOverride,
    RedisConfigurationError,
    RedisEndpointConfig,
    RedisRole,
    resolve_redis_config,
)

_ALL_VARS = [
    "REDIS_URL", "REDIS_USERNAME", "REDIS_PASSWORD", "CACHE_REDIS_URL",
    "REDIS_TLS_ENABLED", "REDIS_TLS_CA_CERTS", "REDIS_TLS_CERTFILE",
    "REDIS_TLS_KEYFILE", "REDIS_TLS_CERT_REQS", "REDIS_TLS_CHECK_HOSTNAME",
    "REDIS_CLUSTER_NODES",
]
for _role in ("STREAMS", "CACHE"):
    _ALL_VARS += [
        f"REDIS_{_role}_MODE", f"REDIS_{_role}_HOST", f"REDIS_{_role}_PORT",
        f"REDIS_{_role}_DB", f"REDIS_{_role}_USERNAME", f"REDIS_{_role}_PASSWORD",
        f"REDIS_{_role}_PASSWORD_FILE", f"REDIS_{_role}_TLS_ENABLED",
        f"REDIS_{_role}_TLS_CA_CERTS", f"REDIS_{_role}_TLS_CERTFILE",
        f"REDIS_{_role}_TLS_KEYFILE", f"REDIS_{_role}_TLS_CERT_REQS",
        f"REDIS_{_role}_TLS_CHECK_HOSTNAME", f"REDIS_{_role}_SENTINEL_MASTER",
        f"REDIS_{_role}_SENTINEL_NODES", f"REDIS_{_role}_CLUSTER_NODES",
        f"REDIS_{_role}_MAX_CONNECTIONS", f"REDIS_{_role}_SOCKET_TIMEOUT",
        f"REDIS_{_role}_SOCKET_CONNECT_TIMEOUT", f"REDIS_{_role}_HEALTH_CHECK_INTERVAL",
    ]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for v in _ALL_VARS:
        monkeypatch.delenv(v, raising=False)


# ── role isolation: THE invariant ───────────────────────────────────

def test_cache_and_streams_are_fully_independent(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_HOST", "streams.internal")
    monkeypatch.setenv("REDIS_STREAMS_USERNAME", "bus-user")
    monkeypatch.setenv("REDIS_STREAMS_PASSWORD", "bus-pw")
    monkeypatch.setenv("REDIS_STREAMS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_STREAMS_TLS_CA_CERTS", "/certs/streams/ca.crt")

    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")

    s = resolve_redis_config(RedisRole.STREAMS)
    c = resolve_redis_config(RedisRole.CACHE)

    assert (s.host, s.username, s.password) == ("streams.internal", "bus-user", "bus-pw")
    assert (c.host, c.username, c.password) == ("cache.internal", "cache-user", "cache-pw")
    assert s.tls.ca_certs == "/certs/streams/ca.crt"
    assert c.tls.ca_certs == "/certs/cache/ca.crt"


def test_streams_password_never_leaks_into_cache(monkeypatch):
    """Only the bus is configured. The cache must NOT inherit its credentials."""
    monkeypatch.setenv("REDIS_STREAMS_PASSWORD", "bus-pw")
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.password is None
    assert c.username is None


# ── secret refs ─────────────────────────────────────────────────────

def test_password_file_wins_over_password_env(monkeypatch, tmp_path):
    pw = tmp_path / "pw"
    pw.write_text("from-file\n")          # trailing newline must be stripped
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "from-env")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", str(pw))
    cfg = resolve_redis_config(RedisRole.CACHE)
    assert cfg.password == "from-file"
    assert cfg.source["password"] == "REDIS_CACHE_PASSWORD_FILE"


def test_missing_password_file_is_an_error(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", "/nope/missing")
    with pytest.raises(RedisConfigurationError, match="REDIS_CACHE_PASSWORD_FILE"):
        resolve_redis_config(RedisRole.CACHE)


# ── legacy back-compat, role-scoped ─────────────────────────────────

def test_legacy_redis_url_maps_to_streams_only(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://:legacy-pw@old-host:6380/0")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert (s.host, s.port, s.db, s.password) == ("old-host", 6380, 0, "legacy-pw")
    assert "legacy" in s.source["host"]
    # The cache must NOT pick up REDIS_URL.
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.host == "localhost" and c.password is None


def test_legacy_cache_url_maps_to_cache_only(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://cache-host:6379/1")
    c = resolve_redis_config(RedisRole.CACHE)
    assert (c.host, c.db) == ("cache-host", 1)
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.host == "localhost"


def test_role_prefixed_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://legacy:6379/1")
    monkeypatch.setenv("REDIS_CACHE_HOST", "new-host")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.host == "new-host"
    assert c.source["host"] == "REDIS_CACHE_HOST"


def test_legacy_rediss_url_enables_tls(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "rediss://cache-host:6379/0")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.tls.enabled is True


# ── cluster is rejected for BOTH roles ──────────────────────────────

@pytest.mark.parametrize("role", [RedisRole.STREAMS, RedisRole.CACHE])
def test_cluster_mode_is_rejected(monkeypatch, role):
    monkeypatch.setenv(f"REDIS_{role.value.upper()}_MODE", "cluster")
    with pytest.raises(RedisConfigurationError, match="cluster"):
        resolve_redis_config(role)


def test_legacy_redis_cluster_nodes_still_rejected(monkeypatch):
    monkeypatch.setenv("REDIS_CLUSTER_NODES", "n1:7000")
    with pytest.raises(RedisConfigurationError, match="cluster"):
        resolve_redis_config(RedisRole.STREAMS)


# ── sentinel ────────────────────────────────────────────────────────

def test_sentinel_mode(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379,s2:26379")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.mode == "sentinel"
    assert s.sentinel_master == "mymaster"
    assert s.sentinel_nodes == (("s1", 26379), ("s2", 26379))


def test_sentinel_without_master_is_an_error(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    with pytest.raises(RedisConfigurationError, match="sentinel"):
        resolve_redis_config(RedisRole.STREAMS)


# ── per-provider cache override ─────────────────────────────────────

def test_provider_override_replaces_global_cache_wholesale(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "global-cache")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "global-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/global/ca.crt")

    override = ProviderCacheOverride(
        provider_id="acme-prod",
        connection={
            "host": "acme-cache", "port": 6380, "db": 0,
            "tls": {"enabled": True, "caCertPath": "/certs/acme/ca.crt"},
        },
        credentials={"cache_username": "acme", "cache_password": "acme-pw"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)

    assert (c.host, c.port) == ("acme-cache", 6380)
    assert (c.username, c.password) == ("acme", "acme-pw")
    # Whole-endpoint: it must NOT inherit the global CA or the global password.
    assert c.tls.ca_certs == "/certs/acme/ca.crt"
    assert c.password != "global-pw"
    assert c.source["host"] == "provider:acme-prod"


def test_provider_legacy_cache_url_still_works():
    override = ProviderCacheOverride(
        provider_id="old", connection={},
        credentials={"cache_redis_url": "redis://:pw@old-cache:6379/1"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    assert (c.host, c.db, c.password) == ("old-cache", 1, "pw")
    assert "legacy" in c.source["host"]


def test_provider_cluster_mode_is_rejected():
    override = ProviderCacheOverride(
        provider_id="p", connection={"mode": "cluster", "host": "h"}, credentials={},
    )
    with pytest.raises(RedisConfigurationError, match="cluster"):
        resolve_redis_config(RedisRole.CACHE, provider_cache=override)


# ── describe() must never leak the password ─────────────────────────

def test_describe_redacts_the_password(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "h")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "super-secret")
    text = resolve_redis_config(RedisRole.CACHE).describe()
    assert "super-secret" not in text
    assert "h" in text


# ── pool knobs must be attributable ─────────────────────────────────

def test_pool_knobs_record_provenance(monkeypatch):
    """build_bus_redis (Task 3) decides whether to apply its caller-supplied
    defaults by asking whether the env explicitly set a knob. Without a source
    entry the caller's default silently overrides the operator's env."""
    monkeypatch.setenv("REDIS_STREAMS_MAX_CONNECTIONS", "50")
    monkeypatch.setenv("REDIS_STREAMS_SOCKET_TIMEOUT", "3.5")
    cfg = resolve_redis_config(RedisRole.STREAMS)
    assert cfg.max_connections == 50
    assert cfg.socket_timeout == 3.5
    assert cfg.source["max_connections"] == "REDIS_STREAMS_MAX_CONNECTIONS"
    assert cfg.source["socket_timeout"] == "REDIS_STREAMS_SOCKET_TIMEOUT"


def test_pool_knobs_unset_have_no_provenance(monkeypatch):
    cfg = resolve_redis_config(RedisRole.STREAMS)
    assert cfg.max_connections == 20
    assert "max_connections" not in cfg.source
