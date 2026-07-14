"""Regression: token revocation MUST authenticate.

revocation_service used to call from_url(REDIS_URL) directly, so REDIS_PASSWORD /
REDIS_USERNAME / REDIS_TLS_* were ignored. Enabling AUTH on the bus therefore
authenticated the job stream while breaking auth on every request. This is the
test that would have caught it.
"""
import pytest


def test_revocation_client_carries_auth_and_tls(monkeypatch):
    for v in ("REDIS_STREAMS_HOST", "REDIS_STREAMS_PASSWORD", "REDIS_TLS_ENABLED"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("REDIS_URL", "redis://bus:6379/0")
    monkeypatch.setenv("REDIS_USERNAME", "app")
    monkeypatch.setenv("REDIS_PASSWORD", "s3cret")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_CERTS", "/certs/streams/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.revocation_service import build_revocation_backend

    build_revocation_backend()

    assert captured["username"] == "app"
    assert captured["password"] == "s3cret"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/streams/ca.crt"
