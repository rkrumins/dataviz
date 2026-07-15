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
