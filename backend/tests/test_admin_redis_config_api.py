"""The admin surface must be truthful and must never leak a secret."""
import pytest

from backend.app.api.v1.endpoints.redis_config import build_role_view
from backend.common.adapters.redis_endpoint import RedisRole


def test_role_view_reports_provenance_and_never_the_password(monkeypatch, tmp_path):
    pw = tmp_path / "pw"
    pw.write_text("super-secret")
    ca = tmp_path / "ca.crt"
    ca.write_text("x")

    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", str(pw))
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", str(ca))

    view = build_role_view(RedisRole.CACHE)

    assert view["host"] == "cache.internal"
    assert view["username"] == "cache-user"
    assert view["hasPassword"] is True
    assert view["passwordSource"] == "REDIS_CACHE_PASSWORD_FILE"
    assert view["tls"]["enabled"] is True
    assert view["tls"]["filesReadable"] is True
    assert view["source"]["host"] == "REDIS_CACHE_HOST"
    # the secret itself must appear NOWHERE in the payload
    assert "super-secret" not in repr(view)


def test_unreadable_cert_file_is_reported(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "h")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/nope/missing-ca.crt")
    view = build_role_view(RedisRole.CACHE)
    assert view["tls"]["filesReadable"] is False


def test_misconfigured_role_reports_the_error_not_a_500(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_MODE", "cluster")
    view = build_role_view(RedisRole.CACHE)
    assert view["error"] is not None
    assert "cluster" in view["error"].lower()


# ── sentinel-daemon auth + retry_on_timeout in the role view ────────────────

def test_role_view_reports_sentinel_daemon_auth(monkeypatch, tmp_path):
    """The daemons authenticate separately from the data plane — an operator
    must be able to SEE whether they will be authenticated (dedicated creds,
    reused data-plane creds, or none) without reading env dumps."""
    pw = tmp_path / "spw"
    pw.write_text("sentinel-secret")
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379,s2:26379")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_USERNAME", "sentinel-user")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_PASSWORD_FILE", str(pw))
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_AUTH_ENABLED", "true")

    view = build_role_view(RedisRole.STREAMS)
    assert view["sentinelUsername"] == "sentinel-user"
    assert view["hasSentinelPassword"] is True
    assert view["sentinelPasswordSource"] == "REDIS_STREAMS_SENTINEL_PASSWORD_FILE"
    assert view["sentinelAuthEnabled"] is True
    assert "sentinel-secret" not in repr(view)


def test_role_view_reports_retry_on_timeout_per_role_default():
    s = build_role_view(RedisRole.STREAMS)
    c = build_role_view(RedisRole.CACHE)
    assert s["retryOnTimeout"] is True     # legacy bus builder default
    assert c["retryOnTimeout"] is False    # legacy cache client default


def test_malformed_legacy_url_port_is_an_error_view_not_a_500(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://:sekrit@host:notaport/1")
    view = build_role_view(RedisRole.CACHE)
    assert view["error"] is not None
    assert "CACHE_REDIS_URL" in view["error"]
    assert "sekrit" not in repr(view)


# ── the FalkorDB graph role card ────────────────────────────────────────────

def test_graph_role_view_standalone(monkeypatch, tmp_path):
    from backend.app.api.v1.endpoints.redis_config import build_graph_role_view

    pw = tmp_path / "fpw"
    pw.write_text("graph-secret")
    monkeypatch.setenv("FALKORDB_HOST", "falkordb.other-cluster.svc")
    monkeypatch.setenv("FALKORDB_PORT", "6380")
    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", str(pw))
    monkeypatch.setenv("FALKORDB_TLS_ENABLED", "true")

    view = build_graph_role_view()
    assert view["error"] is None
    assert view["role"] == "falkordb"
    assert view["mode"] == "standalone"
    assert (view["host"], view["port"]) == ("falkordb.other-cluster.svc", 6380)
    assert view["hasPassword"] is True
    assert view["passwordSource"] == "FALKORDB_PASSWORD_FILE"
    assert view["tls"]["enabled"] is True
    assert view["sentinelTls"]["inherited"] is True     # no override → inherit
    assert view["sentinelTls"]["enabled"] is True       # ...the data-plane TLS
    assert view["source"]["host"] == "FALKORDB_HOST"
    assert view["source"]["port"] == "FALKORDB_PORT"
    assert view["configured"] is True
    assert "graph-secret" not in repr(view)


def test_graph_role_view_sentinel_with_daemon_auth_and_tls_override(monkeypatch):
    from backend.app.api.v1.endpoints.redis_config import build_graph_role_view

    monkeypatch.setenv("FALKORDB_MODE", "sentinel")
    monkeypatch.setenv("FALKORDB_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("FALKORDB_SENTINEL_NODES", "s1:26379,s2:26379")
    monkeypatch.setenv("FALKORDB_SENTINEL_USERNAME", "sd-user")
    monkeypatch.setenv("FALKORDB_SENTINEL_PASSWORD", "sd-secret")
    monkeypatch.setenv("FALKORDB_TLS_ENABLED", "true")
    monkeypatch.setenv("FALKORDB_SENTINEL_TLS_ENABLED", "false")  # mixed mode

    view = build_graph_role_view()
    assert view["mode"] == "sentinel"
    assert view["sentinelMaster"] == "mymaster"
    assert view["sentinelNodes"] == ["s1:26379", "s2:26379"]
    assert view["sentinelUsername"] == "sd-user"
    assert view["hasSentinelPassword"] is True
    assert view["sentinelPasswordSource"] == "FALKORDB_SENTINEL_PASSWORD"
    assert view["tls"]["enabled"] is True
    assert view["sentinelTls"]["inherited"] is False
    assert view["sentinelTls"]["enabled"] is False      # plaintext daemons
    assert view["configured"] is True
    assert "sd-secret" not in repr(view)


def test_graph_role_view_cluster_with_address_remap(monkeypatch):
    from backend.app.api.v1.endpoints.redis_config import build_graph_role_view

    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "n1:7000,n2:7001")
    monkeypatch.setenv(
        "FALKORDB_ADDRESS_REMAP", "10.0.0.5:7000=edge-a:7000,10.0.0.6=edge-b",
    )
    view = build_graph_role_view()
    assert view["mode"] == "cluster"
    assert view["clusterNodes"] == ["n1:7000", "n2:7001"]
    assert view["addressRemap"] == [
        {"from": "10.0.0.5:7000", "to": "edge-a:7000"},
        {"from": "10.0.0.6", "to": "edge-b"},
    ]
    assert view["source"]["address_remap"] == "FALKORDB_ADDRESS_REMAP"


def test_graph_role_view_missing_password_file_is_an_error_view(monkeypatch):
    from backend.app.api.v1.endpoints.redis_config import build_graph_role_view

    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", "/nope/missing")
    view = build_graph_role_view()
    assert view["error"] is not None
    assert "FALKORDB_PASSWORD_FILE" in view["error"]


def test_graph_role_view_unconfigured_env_default(monkeypatch):
    from backend.app.api.v1.endpoints.redis_config import build_graph_role_view

    view = build_graph_role_view()
    assert view["error"] is None
    assert view["configured"] is False       # nothing explicitly set
    assert view["mode"] == "standalone"


@pytest.mark.asyncio
async def test_falkordb_test_action_maps_the_probe(monkeypatch):
    """POST /admin/redis/falkordb/test reuses the topology-aware probe —
    sentinel resolves the real master, cluster fans out per shard — instead
    of a bespoke single-host ping."""
    from backend.app.api.v1.endpoints import redis_config as rc
    from backend.app.services.system_status import probes as probes_mod

    async def fake_probe():
        return {"status": "healthy", "error": None, "latencyMs": 4.2,
                "detail": {"mode": "cluster", "shardsUp": 3, "shardsTotal": 3}}

    monkeypatch.setattr(probes_mod, "probe_falkordb", fake_probe)
    out = await rc.test_redis_role("falkordb")
    assert out["ok"] is True
    assert out["latencyMs"] == 4.2
    assert out["detail"]["shardsUp"] == 3

    async def fake_down():
        return {"status": "down", "error": "connect_timeout", "latencyMs": None,
                "detail": {"mode": "sentinel"}}

    monkeypatch.setattr(probes_mod, "probe_falkordb", fake_down)
    out = await rc.test_redis_role("falkordb")
    assert out["ok"] is False
    assert out["error"] == "connect_timeout"
