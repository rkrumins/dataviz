"""Unit tests for the shared Redis TLS helpers + their parsing in the FalkorDB
connection config. No network — pure kwarg/SSLContext construction."""
import ssl

from backend.common.adapters.redis_tls import (
    TLSSettings,
    build_ssl_context,
    tls_client_kwargs,
    tls_pool_kwargs,
)
from backend.app.providers.falkordb_connection import load_connection_config


def test_disabled_returns_empty():
    t = TLSSettings(enabled=False)
    assert tls_pool_kwargs(t) == {}
    assert tls_client_kwargs(t) == {}
    assert build_ssl_context(t) is None
    assert tls_pool_kwargs(None) == {}
    assert tls_client_kwargs(None) == {}


def test_client_kwargs_enabled():
    t = TLSSettings.from_fields(
        enabled=True, ca_certs="/ca.pem", certfile="/c.pem", keyfile="/k.pem",
        cert_reqs="required", check_hostname=True,
    )
    kw = tls_client_kwargs(t)
    assert kw["ssl"] is True
    assert kw["ssl_ca_certs"] == "/ca.pem"
    assert kw["ssl_certfile"] == "/c.pem"
    assert kw["ssl_keyfile"] == "/k.pem"
    assert kw["ssl_cert_reqs"] == "required"
    assert kw["ssl_check_hostname"] is True


def test_file_uri_prefix_is_stripped_from_cert_paths():
    """Operators / GCP tooling pass a ``file:`` URI (e.g.
    ``REDIS_CACHE_TLS_CA_CERTS=file:/etc/certs/redis-ca-bundle.pem``). redis-py
    and ssl.load_verify_locations want a bare path — a literal ``file:/...``
    silently fails verification (SSL_VERIFY_FAILED). Both forms must normalize."""
    for raw, want in [
        ("file:/etc/certs/redis-ca-bundle.pem", "/etc/certs/redis-ca-bundle.pem"),
        ("file:///etc/certs/ca.pem", "/etc/certs/ca.pem"),
        ("  file:/etc/certs/ca.pem  ", "/etc/certs/ca.pem"),
        ("/plain/path/ca.pem", "/plain/path/ca.pem"),          # untouched
    ]:
        t = TLSSettings.from_fields(
            enabled=True, ca_certs=raw, certfile=raw, keyfile=raw,
        )
        assert t.ca_certs == want
        assert t.certfile == want
        assert t.keyfile == want
        kw = tls_client_kwargs(t)
        assert kw["ssl_ca_certs"] == want
        # build_ssl_context reads the same normalized tls.ca_certs (single source
        # of normalization is from_fields), so the preflight path is covered too.


def test_pool_kwargs_sets_connection_class_not_ssl_flag():
    from redis.asyncio.connection import SSLConnection
    t = TLSSettings.from_fields(enabled=True, cert_reqs="none")
    kw = tls_pool_kwargs(t)
    # Raw ConnectionPool needs connection_class, NOT ssl=True.
    assert kw["connection_class"] is SSLConnection
    assert "ssl" not in kw
    assert kw["ssl_cert_reqs"] == "none"


def test_cert_reqs_none_forces_check_hostname_off():
    t = TLSSettings.from_fields(enabled=True, cert_reqs="none", check_hostname=True)
    assert t.check_hostname is False  # CERT_NONE is incompatible with it


def test_unknown_cert_reqs_defaults_required():
    t = TLSSettings.from_fields(enabled=True, cert_reqs="bogus")
    assert t.cert_reqs == "required"


def test_build_ssl_context_no_client_cert():
    t = TLSSettings.from_fields(enabled=True, cert_reqs="none", check_hostname=True)
    ctx = build_ssl_context(t)
    assert isinstance(ctx, ssl.SSLContext)
    assert ctx.verify_mode == ssl.CERT_NONE
    assert ctx.check_hostname is False


def test_load_config_parses_tls_object():
    cfg = load_connection_config(
        {"tls": {"enabled": True, "caCertPath": "/ca.pem",
                 "verifyMode": "optional", "checkHostname": False}},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.tls_enabled is True
    assert cfg.tls_ca_certs == "/ca.pem"
    assert cfg.tls_cert_reqs == "optional"
    assert cfg.tls_check_hostname is False
    assert cfg.tls_settings().enabled is True


def test_load_config_tls_via_connection_flag():
    cfg = load_connection_config(
        None, host="h", port=1, username=None, password=None, tls_enabled=True,
    )
    assert cfg.tls_enabled is True


def test_load_config_tls_env_fallback(monkeypatch):
    monkeypatch.setenv("FALKORDB_TLS_ENABLED", "true")
    monkeypatch.setenv("FALKORDB_TLS_CA_CERTS", "/env/ca.pem")
    cfg = load_connection_config(None, host="h", port=1, username=None, password=None)
    assert cfg.tls_enabled is True
    assert cfg.tls_ca_certs == "/env/ca.pem"


def test_load_config_tls_absent_is_disabled():
    cfg = load_connection_config(None, host="h", port=1, username=None, password=None)
    assert cfg.tls_enabled is False
    assert tls_client_kwargs(cfg.tls_settings()) == {}
