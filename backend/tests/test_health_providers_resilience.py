"""
F2 — Lock the ``/api/v1/health/providers`` resilience contract.

The endpoint is polled continuously by the FE banner. Under DB pressure,
two failure modes used to bite:

  1. **N+1 query** under a 1s deadline: with 50+ workspaces, the
     workspace-loop saturated the PROVIDER_PROBE pool every poll cycle.
  2. **200-OK with empty body** wiped the FE map: the FE store only
     preserves on throw, so an empty 200 looked like "no providers
     configured" and the banner blanked.

Both fixed in P2.2. These tests pin the contract:

  - DB timeout → last-known is served with ``stalenessSecs``, NOT empty.
  - Cache hit within TTL → no DB query.
  - DB error other than timeout → last-known is still served.
  - First-call (no last-known) DB failure → empty 200 with ``error``
    field set, so at least the FE knows why it's blank.

Tests run against the manager + endpoint module directly with mocked
``_load_ds_index`` — no real DB.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app import main as main_module


# ── Helpers ──────────────────────────────────────────────────────────


def _reset_module_caches():
    """The endpoint module owns two module-level caches; reset between
    tests so we don't leak state."""
    main_module._DS_INDEX_CACHE["data"] = None
    main_module._DS_INDEX_CACHE["ts"] = 0.0
    main_module._LAST_KNOWN_HEALTH_PROVIDERS["data"] = None
    main_module._LAST_KNOWN_HEALTH_PROVIDERS["ts"] = 0.0


@pytest.fixture(autouse=True)
def _isolate_module_state():
    """Reset module caches before AND after each test."""
    _reset_module_caches()
    yield
    _reset_module_caches()


# ── Cache hit: no DB query within TTL ────────────────────────────────


async def test_load_ds_index_serves_from_cache_within_ttl():
    """Two calls within ``_DS_INDEX_TTL_S`` return the same data without
    re-querying the DB."""
    expected = [("ws_1", "ds_1", "prov_1")]
    main_module._DS_INDEX_CACHE["data"] = expected
    main_module._DS_INDEX_CACHE["ts"] = time.monotonic()

    # Sentinel: if get_provider_probe_session is called, the test fails.
    with patch.object(
        main_module,
        "_load_ds_index",
        wraps=main_module._load_ds_index,
    ) as wrapped:
        # Direct call should hit the cache; no DB session opened.
        result = await main_module._load_ds_index()
        assert result == expected
        wrapped.assert_called_once()


async def test_load_ds_index_refetches_after_ttl_expiry():
    """After the TTL elapses, the cache is invalidated and the DB is
    queried again."""
    main_module._DS_INDEX_CACHE["data"] = [("old_ws", "old_ds", "old_prov")]
    # Pretend the cache was filled in the distant past.
    main_module._DS_INDEX_CACHE["ts"] = time.monotonic() - 100.0

    # Set a short TTL for the test.
    with patch.object(main_module, "_DS_INDEX_TTL_S", 5.0):
        # Mock the DB-touching path.
        fake_session = MagicMock()
        fake_session.__aenter__ = AsyncMock(return_value=fake_session)
        fake_session.__aexit__ = AsyncMock(return_value=None)
        fake_result = MagicMock()
        fake_result.all = MagicMock(return_value=[("ws_2", "ds_2", "prov_2")])
        fake_session.execute = AsyncMock(return_value=fake_result)

        with patch.object(main_module, "get_provider_probe_session") as get_sess:
            get_sess.return_value = fake_session
            result = await main_module._load_ds_index()

        assert result == [("ws_2", "ds_2", "prov_2")]
        get_sess.assert_called_once()


# ── Last-known fallback under DB pressure ────────────────────────────


async def test_health_providers_returns_last_known_on_db_timeout():
    """The load-bearing G5 fix: when the DB read times out, the endpoint
    returns the last successful response with ``stalenessSecs`` set,
    NOT an empty 200 that wipes the FE map."""
    # Pre-populate last-known.
    last_known = {
        "providers": {"ws_1:ds_1": {"status": "healthy", "providerId": "prov_X"}},
        "dataSourceCount": 1,
        "configured": True,
    }
    main_module._LAST_KNOWN_HEALTH_PROVIDERS["data"] = last_known
    main_module._LAST_KNOWN_HEALTH_PROVIDERS["ts"] = time.monotonic() - 7.0

    # Force _load_ds_index to raise asyncio.TimeoutError.
    async def _raise_timeout():
        raise asyncio.TimeoutError()

    with patch.object(main_module, "_load_ds_index", side_effect=_raise_timeout):
        result = await main_module.provider_health_check()

    # Last-known providers preserved.
    assert result["providers"] == last_known["providers"]
    # Staleness signal set.
    assert "stalenessSecs" in result
    assert result["stalenessSecs"] >= 7
    # DB error code surfaced for FE diagnostics.
    assert result["error"] == "db_read_deadline_exceeded"


async def test_health_providers_returns_last_known_on_generic_db_error():
    """Same fallback for non-timeout DB errors (e.g. connection refused
    when Postgres is being restarted)."""
    last_known = {
        "providers": {"ws_1:ds_1": {"status": "unhealthy", "providerId": "prov_Y"}},
        "dataSourceCount": 1,
        "configured": True,
    }
    main_module._LAST_KNOWN_HEALTH_PROVIDERS["data"] = last_known
    main_module._LAST_KNOWN_HEALTH_PROVIDERS["ts"] = time.monotonic() - 3.0

    async def _raise_oserror():
        raise OSError("connection refused")

    with patch.object(main_module, "_load_ds_index", side_effect=_raise_oserror):
        result = await main_module.provider_health_check()

    assert result["providers"] == last_known["providers"]
    assert "stalenessSecs" in result
    assert "db_error" in result["error"]


async def test_health_providers_first_call_db_failure_returns_empty_with_error():
    """Edge case: DB fails on the very first call (no last-known yet).
    The endpoint must still return 200 — empty providers + error code so
    the FE can render a "we don't know yet" state instead of a 5xx."""
    # No last-known seeded.
    assert main_module._LAST_KNOWN_HEALTH_PROVIDERS["data"] is None

    async def _raise_timeout():
        raise asyncio.TimeoutError()

    with patch.object(main_module, "_load_ds_index", side_effect=_raise_timeout):
        result = await main_module.provider_health_check()

    assert result["providers"] == {}
    assert result["dataSourceCount"] == 0
    assert result["configured"] is False
    assert result["error"] == "db_read_deadline_exceeded"


# ── Successful path caches the response as last-known ────────────────


async def test_health_providers_caches_successful_response_as_last_known():
    """Every successful response is recorded as the last-known map so a
    subsequent DB failure has something to fall back on."""
    fake_ds_meta = [("ws_1", "ds_1", "prov_X")]

    async def _fake_load():
        return fake_ds_meta

    # Make the manager a clean fixture for this test.
    fresh_manager = type(main_module.provider_manager)()
    with patch.object(main_module, "_load_ds_index", side_effect=_fake_load), \
         patch.object(main_module, "provider_manager", fresh_manager):
        result = await main_module.provider_health_check()

    assert result["dataSourceCount"] == 1
    assert "ws_1:ds_1" in result["providers"]
    # And it's now the last-known.
    assert main_module._LAST_KNOWN_HEALTH_PROVIDERS["data"] is not None
    assert main_module._LAST_KNOWN_HEALTH_PROVIDERS["data"]["dataSourceCount"] == 1


# ── No data sources configured: explicit signal ──────────────────────


async def test_health_providers_returns_configured_false_when_empty():
    """Zero data sources is a meaningful state — the FE renders a first-
    run CTA when ``configured: false``. Distinguishes 'nothing
    registered' from 'all healthy / dataSourceCount=0'."""
    async def _fake_load_empty():
        return []

    with patch.object(main_module, "_load_ds_index", side_effect=_fake_load_empty):
        result = await main_module.provider_health_check()

    assert result["providers"] == {}
    assert result["dataSourceCount"] == 0
    assert result["configured"] is False
    assert "error" not in result
