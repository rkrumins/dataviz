"""
F2 — Lock the manager fast-fail gate contract.

When the warmup loop has recently observed a provider as unhealthy, the
manager's ``get_provider`` MUST fast-fail in <5ms with NO socket I/O,
NO lock acquisition, NO instantiation attempt. Concurrent users on a
known-bad provider all reject in parallel instead of serialising
through the per-key lock and each paying full slow-path latency.

Conversely, when the observation is stale (>``max_age_s``), the gate is
bypassed and the slow path runs — letting real traffic re-probe the
provider in case it has recovered without warmup having seen it yet.

These tests validate the gate logic itself via direct calls to the
predicate, plus an integration-shaped test against ``get_provider`` with
mocked dependencies. No real DB, no real provider drivers.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.providers.manager import ProviderManager
from backend.app.providers.state import ProbeOutcome, ProviderState
from backend.common.adapters import ProviderUnavailable


# ── Predicate-level tests on ProviderState.is_recent_unhealthy ───────


def test_is_recent_unhealthy_true_for_fresh_failure():
    state = ProviderState(cache_key=("p", "g"))
    state.last_observation = ProbeOutcome.from_warmup(
        ok=False, reason="dns_unresolvable", elapsed_ms=1500,
    )
    assert state.is_recent_unhealthy(max_age_s=60.0) is True


def test_is_recent_unhealthy_false_for_stale_failure():
    """Old observations must NOT gate the slow path — let real traffic
    re-probe. ``max_age_s=60`` is the production default; we simulate
    staleness by faking ``observed_at`` 120s in the past."""
    state = ProviderState(cache_key=("p", "g"))
    stale_obs = ProbeOutcome(
        ok=False,
        reason="dns_unresolvable",
        elapsed_ms=1500,
        source="warmup",
        observed_at=time.monotonic() - 120.0,
    )
    state.last_observation = stale_obs
    assert state.is_recent_unhealthy(max_age_s=60.0) is False


def test_is_recent_unhealthy_false_for_healthy_observation():
    state = ProviderState(cache_key=("p", "g"))
    state.last_observation = ProbeOutcome.from_warmup(
        ok=True, reason="ok", elapsed_ms=12,
    )
    assert state.is_recent_unhealthy(max_age_s=60.0) is False


def test_is_recent_unhealthy_false_when_no_observation():
    state = ProviderState(cache_key=("p", "g"))
    assert state.last_observation is None
    assert state.is_recent_unhealthy(max_age_s=60.0) is False


# ── Integration: get_provider fast-fails on recent unhealthy ─────────


class _FakeDataSource:
    """Stand-in for a data_source ORM row. Just exposes the fields
    ``get_provider`` reads."""
    def __init__(self, *, id: str, provider_id: str, graph_name: str = "g"):
        self.id = id
        self.provider_id = provider_id
        self.graph_name = graph_name
        self.extra_config = None


def _patch_data_source_lookup(mgr: ProviderManager, ds: _FakeDataSource, monkeypatch):
    """Make ``data_source_repo.get_data_source_orm`` return our fake
    without hitting the DB. ``get_provider`` does ``from ..db.repositories
    import data_source_repo`` lazily so we patch the module post-import."""
    from backend.app.db.repositories import data_source_repo as _dsr

    async def _fake_get(_session, _data_source_id):
        return ds

    monkeypatch.setattr(_dsr, "get_data_source_orm", _fake_get)


async def test_get_provider_fast_fails_when_warmup_says_recent_unhealthy(monkeypatch):
    """The load-bearing contract: ``get_provider`` raises
    ``ProviderUnavailable`` synchronously, never reaching the slow
    instantiation path. Verified by elapsed wall-clock + the absence of
    any side effect on the breaker/lock state."""
    mgr = ProviderManager()
    ds = _FakeDataSource(id="ds_1", provider_id="prov_X", graph_name="g")
    cache_key = (ds.provider_id, ds.graph_name)

    _patch_data_source_lookup(mgr, ds, monkeypatch)

    # Pre-populate the unhealthy state — this is what the warmup loop
    # would do via record_probe_failure.
    state = ProviderState(cache_key=cache_key)
    state.last_observation = ProbeOutcome.from_warmup(
        ok=False, reason="dns_unresolvable", elapsed_ms=1500,
    )
    mgr._provider_states[cache_key] = state

    fake_session = MagicMock()

    t0 = time.monotonic()
    with pytest.raises(ProviderUnavailable) as exc_info:
        await mgr.get_provider("ws_1", fake_session, data_source_id="ds_1")
    elapsed_ms = (time.monotonic() - t0) * 1000

    # Must fast-fail (<50ms even on a slow CI box).
    assert elapsed_ms < 50, f"Gate took {elapsed_ms:.1f}ms — should be <50ms"
    # The error message identifies it came from warmup, not from a real probe.
    assert "warmup" in str(exc_info.value).lower()
    # No instantiation breaker was created (gate runs before that).
    assert cache_key not in mgr._instantiation_breakers
    # No lock was created (gate runs before lock acquisition).
    assert cache_key not in mgr._locks


async def test_get_provider_bypasses_gate_when_observation_is_stale(monkeypatch):
    """A stale unhealthy observation must NOT block the slow path —
    real traffic should re-probe in case the provider recovered without
    warmup having reached it yet."""
    mgr = ProviderManager()
    ds = _FakeDataSource(id="ds_1", provider_id="prov_X", graph_name="g")
    cache_key = (ds.provider_id, ds.graph_name)

    _patch_data_source_lookup(mgr, ds, monkeypatch)

    # Make the observation stale (90s old; default max_age_s is 60s).
    stale_state = ProviderState(cache_key=cache_key)
    stale_state.last_observation = ProbeOutcome(
        ok=False,
        reason="dns_unresolvable",
        elapsed_ms=1500,
        source="warmup",
        observed_at=time.monotonic() - 90.0,
    )
    mgr._provider_states[cache_key] = stale_state

    # Patch _instantiate_from_provider so the slow path doesn't actually
    # try to talk to a real provider. We just want to assert the gate
    # let us through to the slow path.
    fake_provider = MagicMock()
    fake_provider.close = AsyncMock()
    mgr._instantiate_from_provider = AsyncMock(return_value=fake_provider)

    fake_session = MagicMock()
    result = await mgr.get_provider("ws_1", fake_session, data_source_id="ds_1")

    # Slow path ran (proxy returned), proving the gate did NOT short-circuit.
    assert result is not None
    mgr._instantiate_from_provider.assert_awaited_once()


async def test_get_provider_bypasses_gate_when_no_observation(monkeypatch):
    """First-time provider lookup (no warmup observation yet): gate must
    NOT fire. Otherwise a brand-new provider would never get its first
    successful instantiation."""
    mgr = ProviderManager()
    ds = _FakeDataSource(id="ds_1", provider_id="prov_NEW", graph_name="g")

    _patch_data_source_lookup(mgr, ds, monkeypatch)

    # No state recorded; gate should be a no-op.
    fake_provider = MagicMock()
    fake_provider.close = AsyncMock()
    mgr._instantiate_from_provider = AsyncMock(return_value=fake_provider)

    fake_session = MagicMock()
    result = await mgr.get_provider("ws_1", fake_session, data_source_id="ds_1")

    assert result is not None
    mgr._instantiate_from_provider.assert_awaited_once()


async def test_get_provider_returns_cached_without_consulting_gate(monkeypatch):
    """Cache hit must return the cached provider immediately, BEFORE the
    gate fires. The gate exists to protect SLOW-path instantiation, not
    to invalidate cached healthy providers."""
    mgr = ProviderManager()
    ds = _FakeDataSource(id="ds_1", provider_id="prov_X", graph_name="g")
    cache_key = (ds.provider_id, ds.graph_name)

    _patch_data_source_lookup(mgr, ds, monkeypatch)

    # Pre-cache a fake provider.
    cached = MagicMock(name="cached_provider")
    mgr._providers[cache_key] = cached

    # Even with a recent unhealthy observation, the cached provider wins.
    state = ProviderState(cache_key=cache_key)
    state.last_observation = ProbeOutcome.from_warmup(
        ok=False, reason="dns_unresolvable", elapsed_ms=1500,
    )
    mgr._provider_states[cache_key] = state

    fake_session = MagicMock()
    result = await mgr.get_provider("ws_1", fake_session, data_source_id="ds_1")

    assert result is cached
