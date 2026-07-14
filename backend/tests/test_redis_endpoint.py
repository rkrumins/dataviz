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
    "REDIS_CLUSTER_NODES", "REDIS_SENTINEL_MASTER", "REDIS_SENTINEL_NODES",
]
for _role in ("STREAMS", "CACHE"):
    _ALL_VARS += [
        f"REDIS_{_role}_MODE", f"REDIS_{_role}_HOST", f"REDIS_{_role}_PORT",
        f"REDIS_{_role}_DB", f"REDIS_{_role}_USERNAME", f"REDIS_{_role}_PASSWORD",
        f"REDIS_{_role}_PASSWORD_FILE", f"REDIS_{_role}_TLS_ENABLED",
        f"REDIS_{_role}_TLS_CA_CERTS", f"REDIS_{_role}_TLS_CERTFILE",
        f"REDIS_{_role}_TLS_KEYFILE", f"REDIS_{_role}_TLS_CERT_REQS",
        f"REDIS_{_role}_TLS_CHECK_HOSTNAME", f"REDIS_{_role}_SENTINEL_MASTER",
        f"REDIS_{_role}_SENTINEL_NODES", f"REDIS_{_role}_SENTINEL_USERNAME",
        f"REDIS_{_role}_SENTINEL_PASSWORD", f"REDIS_{_role}_SENTINEL_PASSWORD_FILE",
        f"REDIS_{_role}_SENTINEL_AUTH_ENABLED", f"REDIS_{_role}_CLUSTER_NODES",
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


def test_empty_password_file_is_an_error(monkeypatch, tmp_path):
    """A zero-byte or whitespace-only secret file (mount race, bad rotation) must
    be a hard error, exactly like a missing file — not a silent empty password."""
    pw = tmp_path / "pw"
    pw.write_text("   \n")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", str(pw))
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


def test_legacy_rediss_url_tls_provenance_uses_real_field_name(monkeypatch):
    """_parse_url's internal key is "tls_enabled"; the real config field (the one
    the Admin page renders source for) is "tls". A stray "tls_enabled" key with no
    "tls" key means the Admin page can't explain why TLS is on."""
    monkeypatch.setenv("CACHE_REDIS_URL", "rediss://cache-host:6379/0")
    c = resolve_redis_config(RedisRole.CACHE)
    assert "tls_enabled" not in c.source
    assert c.source["tls"] == "CACHE_REDIS_URL (legacy)"


def test_legacy_bare_redis_password_is_labelled_legacy(monkeypatch):
    """The STREAMS role's unprefixed REDIS_PASSWORD fallback must label its
    provenance "(legacy)", like the sibling REDIS_USERNAME fallback already does."""
    monkeypatch.setenv("REDIS_PASSWORD", "bare-pw")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.password == "bare-pw"
    assert s.source["password"] == "REDIS_PASSWORD (legacy)"


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


def test_cache_cluster_rejection_cites_cache_reasons(monkeypatch):
    """The CACHE rejection must cite CACHE-only reasons (SCAN/DEL, non-zero DB),
    not the STREAMS-only XADD reason — and must still point at FalkorDB/sentinel."""
    monkeypatch.setenv("REDIS_CACHE_MODE", "cluster")
    with pytest.raises(RedisConfigurationError) as exc:
        resolve_redis_config(RedisRole.CACHE)
    msg = str(exc.value)
    assert "SCAN" in msg
    assert "non-zero DB index" in msg
    assert "XADD" not in msg
    assert "FalkorDB" in msg
    assert "Sentinel" in msg


def test_streams_cluster_rejection_cites_streams_reasons(monkeypatch):
    """The STREAMS rejection must cite the job-broker XADD reason, not the
    CACHE-only SCAN/DEL reason — and must still point at FalkorDB/sentinel."""
    monkeypatch.setenv("REDIS_STREAMS_MODE", "cluster")
    with pytest.raises(RedisConfigurationError) as exc:
        resolve_redis_config(RedisRole.STREAMS)
    msg = str(exc.value)
    assert "XADD" in msg
    assert "SCAN" not in msg
    assert "FalkorDB" in msg
    assert "Sentinel" in msg


# ── mode provenance ─────────────────────────────────────────────────

def test_default_mode_has_default_provenance(monkeypatch):
    """host/port/db/username already record "default" when they fall back;
    mode must be consistent with them instead of having no source entry."""
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.mode == "standalone"
    assert s.source["mode"] == "default"


def test_explicit_mode_records_its_env_var(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.source["mode"] == "REDIS_STREAMS_MODE"


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


def test_sentinel_fields_record_provenance(monkeypatch):
    """A later Admin page renders `source` per field, and other code decides
    "did the operator set this?" via `"<field>" not in cfg.source`. All four
    sentinel fields must be attributable, not just sentinel_password."""
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379,s2:26379")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_USERNAME", "sentinel-user")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_AUTH_ENABLED", "true")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.source["sentinel_master"] == "REDIS_STREAMS_SENTINEL_MASTER"
    assert s.source["sentinel_nodes"] == "REDIS_STREAMS_SENTINEL_NODES"
    assert s.source["sentinel_username"] == "REDIS_STREAMS_SENTINEL_USERNAME"
    assert s.source["sentinel_auth_enabled"] == "REDIS_STREAMS_SENTINEL_AUTH_ENABLED"


def test_sentinel_fields_unset_have_no_provenance(monkeypatch):
    s = resolve_redis_config(RedisRole.STREAMS)
    assert "sentinel_master" not in s.source
    assert "sentinel_nodes" not in s.source
    assert "sentinel_username" not in s.source
    assert "sentinel_auth_enabled" not in s.source


# ── legacy unprefixed sentinel back-compat (STREAMS only) ───────────

def test_legacy_unprefixed_sentinel_vars_enable_sentinel_mode(monkeypatch):
    """The original (pre-central-resolver) bus builder selected Sentinel mode
    implicitly from REDIS_SENTINEL_MASTER + REDIS_SENTINEL_NODES alone — there
    was no MODE variable at all. A deployment following that recipe must keep
    working after the migration, not silently fall back to standalone."""
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379,s2:26379")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.mode == "sentinel"
    assert s.sentinel_master == "mymaster"
    assert s.sentinel_nodes == (("s1", 26379), ("s2", 26379))
    assert s.source["sentinel_master"] == "REDIS_SENTINEL_MASTER (legacy)"
    assert s.source["sentinel_nodes"] == "REDIS_SENTINEL_NODES (legacy)"
    assert "legacy" in s.source["mode"]


def test_legacy_unprefixed_sentinel_vars_do_not_leak_into_cache(monkeypatch):
    """CACHE must never read the unprefixed REDIS_SENTINEL_* vars — that would
    be cross-role inheritance, the exact bug class this module exists to
    prevent."""
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379,s2:26379")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.mode == "standalone"
    assert "sentinel_master" not in c.source
    assert "sentinel_nodes" not in c.source


def test_role_prefixed_sentinel_wins_over_legacy_unprefixed(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "new-master")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "n1:26379")
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "old-master")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "o1:26379")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.sentinel_master == "new-master"
    assert s.sentinel_nodes == (("n1", 26379),)
    assert s.source["sentinel_master"] == "REDIS_STREAMS_SENTINEL_MASTER"


def test_explicit_standalone_mode_beats_legacy_sentinel_inference(monkeypatch):
    """An operator who explicitly sets REDIS_STREAMS_MODE=standalone must get
    standalone, even if the legacy unprefixed Sentinel vars are also set."""
    monkeypatch.setenv("REDIS_STREAMS_MODE", "standalone")
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.mode == "standalone"


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


def test_provider_sentinel_fields_record_provenance():
    """The provider-cache JSON path must attribute sentinel fields too, not just
    the plain host/port/db/username/password/tls fields."""
    override = ProviderCacheOverride(
        provider_id="acme-prod",
        connection={
            "mode": "sentinel", "host": "acme-cache",
            "sentinel": {
                "masterName": "acme-master", "nodes": [{"host": "s1", "port": 26379}],
                "authEnabled": True,
            },
        },
        credentials={"cache_sentinel_username": "sentinel-user"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    for key in ("sentinel_master", "sentinel_nodes", "sentinel_username",
                "sentinel_auth_enabled"):
        assert c.source[key] == "provider:acme-prod"


def test_provider_pool_knob_provenance():
    """build_bus_redis-style callers decide whether to apply their own defaults
    by checking `"<field>" not in cfg.source`; the provider-cache path must
    attribute the pool knobs too, not just host/port/db/username/password/tls —
    and only the knobs the provider JSON actually sets."""
    override = ProviderCacheOverride(
        provider_id="acme-prod",
        connection={
            "host": "acme-cache", "maxConnections": 40, "socketTimeout": 7,
            "socketConnectTimeout": 2.5, "healthCheckInterval": 15,
        },
        credentials={"cache_password": "acme-pw"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    assert c.max_connections == 40
    assert c.socket_timeout == 7
    assert c.socket_connect_timeout == 2.5
    assert c.health_check_interval == 15
    for key in ("max_connections", "socket_timeout", "socket_connect_timeout",
                "health_check_interval"):
        assert c.source[key] == "provider:acme-prod"


def test_provider_pool_knobs_unset_use_defaults_and_have_no_provenance():
    """A provider JSON that sets NONE of the pool knobs must resolve to the
    same defaults as the dataclass AND leave them absent from source — the
    bug this suite guards against claimed provider provenance for values that
    were never read from the provider at all."""
    override = ProviderCacheOverride(
        provider_id="acme-prod",
        connection={"host": "acme-cache"},
        credentials={"cache_password": "acme-pw"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    assert c.max_connections == 20
    assert c.socket_timeout == 10.0
    assert c.socket_connect_timeout == 5.0
    assert c.health_check_interval == 30
    for key in ("max_connections", "socket_timeout", "socket_connect_timeout",
                "health_check_interval"):
        assert key not in c.source


def test_provider_missing_cache_password_is_not_attributed_to_provider():
    """The provider supplied no cache_password. password must be None, and
    source must say "default" — not lie that a provider set a credential it
    never supplied (the Admin page renders this map)."""
    override = ProviderCacheOverride(
        provider_id="acme-prod",
        connection={"host": "acme-cache"},
        credentials={"cache_username": "acme"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    assert c.password is None
    assert c.source["password"] == "default"


def test_provider_legacy_cache_url_attributes_only_what_url_supplied():
    """A legacy cache_redis_url with no username and no explicit db must not
    claim those fields came from the URL."""
    override = ProviderCacheOverride(
        provider_id="old", connection={},
        credentials={"cache_redis_url": "redis://old-cache:6379"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    assert c.host == "old-cache"
    assert c.username is None
    assert c.password is None
    assert c.db == 0
    assert "legacy" in c.source["host"]
    assert c.source["username"] == "default"
    assert c.source["password"] == "default"
    assert c.source["db"] == "default"


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
