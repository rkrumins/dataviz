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

    from backend.app.services.revocation_service import (
        REVOCATION_SOCKET_TIMEOUT_S, build_revocation_backend,
    )

    build_revocation_backend()

    assert captured["username"] == "app"
    assert captured["password"] == "s3cret"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/streams/ca.crt"

    # Revocation is on the hot auth path and must fail open FAST — both
    # the connect and per-command budgets are the tight, env-tunable
    # REVOCATION_SOCKET_TIMEOUT_S, and redis-py must NOT retry after a
    # timeout (a retry would silently double the fail-open budget on
    # every authenticated request during a Redis blip). The STREAMS role
    # default for retry_on_timeout is True (correct for the bus) — this
    # asserts revocation overrides it back to False.
    assert captured["socket_timeout"] == REVOCATION_SOCKET_TIMEOUT_S
    assert captured["socket_connect_timeout"] == REVOCATION_SOCKET_TIMEOUT_S
    assert captured["retry_on_timeout"] is False


def test_get_revocation_service_falls_back_on_config_error(monkeypatch):
    """A RedisConfigurationError from resolve_redis_config (missing/empty
    *_PASSWORD_FILE during a secret-mount race, incomplete sentinel config,
    a stray cluster var, ...) must NOT escape get_revocation_service().

    get_revocation_service() runs on every authenticated request. If the
    error propagated, the module-level singleton would stay None and every
    subsequent request would repeat the same unhandled exception — turning
    a config typo or a secret-rotation blip into a total, unrecoverable
    auth outage. Auth must keep failing OPEN via the in-memory fallback.
    """
    import backend.app.services.revocation_service as revocation_service
    from backend.common.adapters.redis_endpoint import RedisConfigurationError

    def _boom():
        raise RedisConfigurationError(
            "streams: sentinel mode requires REDIS_STREAMS_SENTINEL_MASTER "
            "and REDIS_STREAMS_SENTINEL_NODES."
        )

    monkeypatch.setattr(revocation_service, "build_revocation_backend", _boom)

    # conftest.py installs a module-wide InMemoryBackend singleton at
    # import time via configure_revocation_service(), so we must reset it
    # to None here to actually exercise the construction path — otherwise
    # get_revocation_service() would just return the pre-installed
    # instance without ever calling build_revocation_backend().
    original_instance = revocation_service._INSTANCE
    revocation_service._INSTANCE = None
    try:
        svc = revocation_service.get_revocation_service()
        assert isinstance(svc, revocation_service.RevocationService)
        assert isinstance(svc._backend, revocation_service.InMemoryBackend)

        # And the fallback is actually usable — the fail-open call sites
        # in dependencies.py must be able to await is_revoked() without
        # raising.
        import asyncio
        assert asyncio.run(svc.is_revoked("some-sid")) is False
    finally:
        revocation_service._INSTANCE = original_instance
