"""
F2 — Lock the warmup→breaker recovery contract.

The single most important behaviour Phase F protects:

  1. ``false → true`` transition (recovery): the manager resets every
     matching breaker AND evicts the cached provider so the pool gets
     rebuilt against the recovered host.
  2. ``true → false`` (failure): after ``_PRE_TRIP_AFTER_N`` consecutive
     observed failures, the manager pre-trips the instantiation breaker
     so user requests fast-fail without paying connect-probe latency.
  3. Steady-state same-state observations: no breaker mutations, no
     evictions, no log spam.

Without these tests, a future refactor silently breaks the recovery loop
and the user sees the original "auto-recovery doesn't work" symptom.

These tests exercise the manager directly with mocked breakers — no DB,
no Redis, no providers. Every test runs in <50ms.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.providers.manager import ProviderManager
from backend.app.providers.state import ProbeOutcome, ProviderState
from backend.common.adapters import BreakerState


# ── Helpers ──────────────────────────────────────────────────────────


def _fresh_manager() -> ProviderManager:
    """A clean manager — no cached providers, no breakers, no states."""
    return ProviderManager()


def _make_unhealthy_state(
    prov_id: str, graph_name: str = "g", consecutive_failures: int = 2,
) -> ProviderState:
    """Pre-populate state as if warmup had previously observed failure.

    Defaults to 2 consecutive failures — a REAL outage per the recovery-
    eviction debounce (_EVICT_ON_RECOVERY_AFTER_N). Pass 1 to model a
    single-probe blip, which must NOT evict."""
    state = ProviderState(cache_key=(prov_id, graph_name))
    state.last_observation = ProbeOutcome.from_warmup(
        ok=False, reason="dns_unresolvable", elapsed_ms=1200,
    )
    state.consecutive_failures = consecutive_failures
    return state


# ── Recovery: false → true ────────────────────────────────────────────


async def test_record_probe_success_resets_instantiation_breaker():
    """Critical contract: when warmup observes recovery, the
    instantiation breaker must transition to CLOSED so the next user
    request can re-instantiate against the recovered host."""
    mgr = _fresh_manager()
    cache_key = ("prov_X", "graph_a")

    # Set up: instantiation breaker open as if recent failures tripped it.
    breaker = mgr._get_instantiation_breaker(cache_key)
    breaker.open()
    assert breaker.current_state == BreakerState.OPEN.value

    # Pre-populate the unhealthy state so the manager has a transition
    # to detect (false → true).
    mgr._provider_states[cache_key] = _make_unhealthy_state("prov_X", "graph_a")

    # Act: warmup observes success.
    await mgr.record_probe_success("prov_X", source="warmup")

    # Breaker must be closed now.
    assert breaker.current_state == BreakerState.CLOSED.value, (
        f"Expected CLOSED after recovery; got {breaker.current_state}"
    )
    # consecutive_failures reset.
    assert mgr._provider_states[cache_key].consecutive_failures == 0


async def test_record_probe_success_evicts_cached_provider_on_recovery():
    """A cached provider holds a connection pool pointed at the
    previously-broken host. On recovery we MUST evict so the next user
    request rebuilds the pool against the recovered endpoint."""
    mgr = _fresh_manager()
    cache_key = ("prov_X", "graph_a")

    # Mock cached provider with an async close() and NO in-flight ops — a
    # bare MagicMock's inflight_ops() returns a truthy mock, which reads as
    # "busy" and defers the close to a background task the test never sees.
    fake_provider = MagicMock()
    fake_provider.close = AsyncMock()
    fake_provider.inflight_ops = MagicMock(return_value=0)
    mgr._providers[cache_key] = fake_provider
    mgr._provider_states[cache_key] = _make_unhealthy_state("prov_X", "graph_a")

    await mgr.record_probe_success("prov_X", source="warmup")

    # Cache must be empty.
    assert cache_key not in mgr._providers
    # close() was called during eviction.
    fake_provider.close.assert_awaited_once()


async def test_single_probe_blip_recovery_does_not_evict():
    """DEBOUNCE: one failed probe (a busy node, a timeout spike) followed by
    a success is a blip, not an outage. Evicting on it dumped EVERY per-graph
    instance of the provider at once — fleets with 100s of graphs
    re-instantiated everything continuously. Breakers still get force-closed;
    only the pool-dumping eviction is gated."""
    mgr = _fresh_manager()
    cache_key = ("prov_X", "graph_a")

    fake_provider = MagicMock()
    fake_provider.close = AsyncMock()
    fake_provider.inflight_ops = MagicMock(return_value=0)
    mgr._providers[cache_key] = fake_provider
    mgr._provider_states[cache_key] = _make_unhealthy_state(
        "prov_X", "graph_a", consecutive_failures=1,
    )

    await mgr.record_probe_success("prov_X", source="warmup")

    assert cache_key in mgr._providers            # NOT evicted
    fake_provider.close.assert_not_awaited()
    assert mgr._provider_states[cache_key].consecutive_failures == 0


async def test_open_breaker_recovery_evicts_despite_short_streak():
    """An OPEN instantiation breaker proves a real outage regardless of the
    probe streak — recovery from it must still rebuild the pools."""
    mgr = _fresh_manager()
    cache_key = ("prov_X", "graph_a")

    fake_provider = MagicMock()
    fake_provider.close = AsyncMock()
    fake_provider.inflight_ops = MagicMock(return_value=0)
    mgr._providers[cache_key] = fake_provider
    mgr._provider_states[cache_key] = _make_unhealthy_state(
        "prov_X", "graph_a", consecutive_failures=1,
    )
    mgr._get_instantiation_breaker(cache_key).open()

    await mgr.record_probe_success("prov_X", source="warmup")

    assert cache_key not in mgr._providers        # evicted: breaker proved outage
    fake_provider.close.assert_awaited_once()


async def test_record_probe_success_no_eviction_when_already_healthy():
    """Steady-state true→true must NOT trigger eviction. Only transitions
    from a previously-unhealthy state count."""
    mgr = _fresh_manager()
    cache_key = ("prov_X", "graph_a")

    fake_provider = MagicMock()
    fake_provider.close = AsyncMock()
    mgr._providers[cache_key] = fake_provider

    # No prior state, so no transition is detected.
    await mgr.record_probe_success("prov_X", source="warmup")

    # Cache untouched, close NOT called.
    assert cache_key in mgr._providers
    fake_provider.close.assert_not_awaited()


# ── Failure: true → false → false → … pre-trips after N ───────────────


async def test_record_probe_failure_does_not_pre_trip_on_first_failure():
    """One observed failure isn't enough — N=2 default absorbs single-
    cycle network blips."""
    mgr = _fresh_manager()
    cache_key = ("prov_Y", "")

    await mgr.record_probe_failure("prov_Y", reason="dns_unresolvable", source="warmup")

    breaker = mgr._instantiation_breakers.get(cache_key)
    if breaker is not None:
        assert breaker.current_state != BreakerState.OPEN.value, (
            "Breaker tripped on first failure — should require N≥2"
        )
    state = mgr._provider_states.get(cache_key)
    assert state is not None
    assert state.consecutive_failures == 1


async def test_record_probe_failure_pre_trips_after_N_consecutive():
    """After ``_PRE_TRIP_AFTER_N`` observed failures, the breaker must
    open so user requests fast-fail with NO socket I/O."""
    mgr = _fresh_manager()
    cache_key = ("prov_Y", "")

    # Default _PRE_TRIP_AFTER_N is 2 — fire two failures.
    n = mgr._PRE_TRIP_AFTER_N
    for _ in range(n):
        await mgr.record_probe_failure(
            "prov_Y", reason="dns_unresolvable", source="warmup",
        )

    breaker = mgr._instantiation_breakers[cache_key]
    assert breaker.current_state == BreakerState.OPEN.value, (
        f"Breaker should be OPEN after {n} consecutive failures; "
        f"got {breaker.current_state}"
    )


async def test_record_probe_failure_pre_trip_is_idempotent():
    """Calling failure many times after the breaker is already open must
    not raise or thrash state."""
    mgr = _fresh_manager()
    cache_key = ("prov_Y", "")
    n = mgr._PRE_TRIP_AFTER_N

    for _ in range(n + 5):
        await mgr.record_probe_failure(
            "prov_Y", reason="dns_unresolvable", source="warmup",
        )

    breaker = mgr._instantiation_breakers[cache_key]
    assert breaker.current_state == BreakerState.OPEN.value
    state = mgr._provider_states[cache_key]
    assert state.consecutive_failures == n + 5


async def test_success_after_failures_resets_consecutive_counter():
    """Failure → failure → success: counter must reset to zero."""
    mgr = _fresh_manager()
    cache_key = ("prov_Z", "")

    await mgr.record_probe_failure("prov_Z", reason="connect_timeout", source="warmup")
    await mgr.record_probe_failure("prov_Z", reason="connect_timeout", source="warmup")
    await mgr.record_probe_success("prov_Z", source="warmup")

    state = mgr._provider_states[cache_key]
    assert state.consecutive_failures == 0
    assert state.last_observation is not None and state.last_observation.ok


# ── Multi-graph providers: all matching keys updated together ────────


async def test_recovery_resets_breakers_for_all_matching_graph_names():
    """One provider can back multiple workspaces with different
    ``graph_name`` values. A recovery observation must update ALL
    matching cache_keys, not just one."""
    mgr = _fresh_manager()

    # Two cache_keys for the same provider_id, different graph_names.
    key_a = ("prov_M", "graph_alpha")
    key_b = ("prov_M", "graph_beta")
    breaker_a = mgr._get_instantiation_breaker(key_a)
    breaker_b = mgr._get_instantiation_breaker(key_b)
    breaker_a.open()
    breaker_b.open()
    mgr._provider_states[key_a] = _make_unhealthy_state("prov_M", "graph_alpha")
    mgr._provider_states[key_b] = _make_unhealthy_state("prov_M", "graph_beta")

    await mgr.record_probe_success("prov_M", source="warmup")

    assert breaker_a.current_state == BreakerState.CLOSED.value
    assert breaker_b.current_state == BreakerState.CLOSED.value


# ── Multi-provider isolation: one provider's outage never gates another ──


async def test_provider_failures_are_isolated_per_provider():
    """PINNING TEST — the audit invariant: breakers, warmup states, and the
    fast-fail read gate are all keyed per (provider_id, graph_name). Provider A
    hard-down (pre-tripped breaker, read-gating state) must leave provider B's
    state, breaker, and gate completely untouched — several FalkorDB providers
    of the same type coexist and fail independently."""
    mgr = _fresh_manager()
    for _ in range(mgr._PRE_TRIP_AFTER_N):
        await mgr.record_probe_failure("prov_A", reason="tcp_refused", source="warmup")
    await mgr.record_probe_success("prov_B", source="warmup")

    a_state = mgr._provider_states[("prov_A", "")]
    b_state = mgr._provider_states[("prov_B", "")]
    assert a_state.blocks_reads(max_age_s=60.0) is True
    assert b_state.blocks_reads(max_age_s=60.0) is False
    assert mgr._instantiation_breakers[("prov_A", "")].current_state == \
        BreakerState.OPEN.value
    assert ("prov_B", "") not in mgr._instantiation_breakers or (
        mgr._instantiation_breakers[("prov_B", "")].current_state
        != BreakerState.OPEN.value
    )
    # ...and A's recovery doesn't touch B either.
    await mgr.record_probe_success("prov_A", source="warmup")
    assert mgr._provider_states[("prov_B", "")] is b_state


async def test_auth_reason_never_pre_trips_even_after_unlearn_change():
    """The un-learn work must not weaken the invariant: auth_required /
    auth_failed are 'reachable but misconfigured' — recorded as reachable,
    failure streak reset, breaker left closed, reads never gated."""
    mgr = _fresh_manager()
    for _ in range(mgr._PRE_TRIP_AFTER_N + 1):
        await mgr.record_probe_failure("prov_A", reason="auth_required", source="warmup")

    state = mgr._provider_states[("prov_A", "")]
    assert state.consecutive_failures == 0
    assert state.blocks_reads(max_age_s=60.0) is False
    breaker = mgr._instantiation_breakers.get(("prov_A", ""))
    assert breaker is None or breaker.current_state != BreakerState.OPEN.value
