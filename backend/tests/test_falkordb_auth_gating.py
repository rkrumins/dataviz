"""Tests for the per-provider FalkorDB auth gate (falkordbConnection.authEnabled).

When auth is disabled for a provider, the FalkorDB graph credentials must be
nulled at a single chokepoint so NOTHING sends AUTH (pool kwargs, preflight,
connection-config / cache-fallback inherit). A dedicated cache_redis_url keeps
its own embedded auth and is intentionally NOT gated. Both instantiation paths
(manager + the deprecated registry) must read + forward the flag.

No live FalkorDB — the provider does not connect in __init__.
"""
from unittest.mock import AsyncMock

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider


def test_auth_enabled_true_retains_credentials():
    p = FalkorDBProvider(
        host="x", graph_name="g",
        username="u", password="p", auth_enabled=True,
    )
    assert p._auth_enabled is True
    assert p._username == "u"
    assert p._password == "p"


def test_auth_disabled_nulls_graph_credentials():
    p = FalkorDBProvider(
        host="x", graph_name="g",
        username="u", password="p",
        cache_redis_url="redis://:pw@cache:6379/0",
        auth_enabled=False,
    )
    assert p._auth_enabled is False
    assert p._username is None
    assert p._password is None
    # A dedicated cache Redis keeps its own embedded auth — not gated.
    assert p._cache_redis_url == "redis://:pw@cache:6379/0"


def test_default_auth_enabled_is_true():
    p = FalkorDBProvider(host="x", graph_name="g", username="u", password="p")
    assert p._auth_enabled is True
    assert p._username == "u"


@pytest.mark.asyncio
async def test_preflight_sends_no_password_when_auth_disabled(monkeypatch):
    captured = {}

    async def fake_preflight(host, port, *, deadline_s, password=None,
                             username=None, ssl_context=None,
                             detect_cluster=False):
        captured["password"] = password
        captured["username"] = username
        from backend.common.interfaces.preflight import PreflightResult
        return PreflightResult.success(peer=f"{host}:{port}", elapsed_ms=1)

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight",
        fake_preflight,
    )
    p = FalkorDBProvider(
        host="x", graph_name="g", username="u", password="p", auth_enabled=False,
    )
    await p.preflight()
    assert captured["password"] is None  # gated → no AUTH attempted
    assert captured["username"] is None


# ── both instantiation paths read + forward authEnabled ─────────────

_CREDS = {"username": "u", "password": "p"}


def _conn(auth_enabled=None):
    fc = {"mode": "standalone"}
    if auth_enabled is not None:
        fc["authEnabled"] = auth_enabled
    return {"falkordbConnection": fc}


def test_manager_forwards_auth_disabled():
    from backend.app.providers.manager import ProviderManager

    inst = ProviderManager._create_provider_instance(
        "falkordb", "h", 6379, "g", False,
        credentials=_CREDS, extra_config=_conn(auth_enabled=False),
    )
    assert inst._auth_enabled is False
    assert inst._username is None and inst._password is None


def test_registry_forwards_auth_disabled():
    from backend.app.registry.provider_registry import provider_registry

    inst = provider_registry._create_provider_instance(
        "falkordb", "h", 6379, "g", False,
        credentials=_CREDS, extra_config=_conn(auth_enabled=False),
    )
    assert inst._auth_enabled is False
    assert inst._username is None and inst._password is None


def test_manager_defaults_auth_enabled_when_flag_absent():
    from backend.app.providers.manager import ProviderManager

    inst = ProviderManager._create_provider_instance(
        "falkordb", "h", 6379, "g", False,
        credentials=_CREDS, extra_config=_conn(),  # no authEnabled key
    )
    assert inst._auth_enabled is True
    assert inst._username == "u" and inst._password == "p"


def test_manager_forwards_tls_enabled():
    from backend.app.providers.manager import ProviderManager

    inst = ProviderManager._create_provider_instance(
        "falkordb", "h", 6379, "g", True,  # tls_enabled positional
        credentials=_CREDS, extra_config=_conn(),
    )
    assert inst._tls_enabled is True


def test_registry_forwards_tls_enabled():
    from backend.app.registry.provider_registry import provider_registry

    inst = provider_registry._create_provider_instance(
        "falkordb", "h", 6379, "g", True,
        credentials=_CREDS, extra_config=_conn(),
    )
    assert inst._tls_enabled is True
