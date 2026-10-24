"""A provider transition never waits on Redis.

The warmup loop is the one thing that opens and force-closes every provider's
circuit breakers (``record_probe_success`` / ``record_probe_failure``; the
contract itself is pinned in ``test_provider_warmup_recovery.py``). On a
transition it also tells browsers that provider state moved, through the
change registry in Redis. If that notification were awaited, a Redis that
hangs rather than refusing would hold the loop for as long as its client's
timeouts allow, and every other provider's probes, and so its breaker, would
wait behind it: at exactly the moment Redis is the thing that is unwell.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.changes import publish as change_publish
from backend.app.providers.manager import ProviderManager
from backend.app.providers.state import ProbeOutcome, ProviderState
from backend.common.adapters import BreakerState


class _HangingRegistry:
    """A Redis that takes the command and never answers."""

    def __init__(self) -> None:
        self.bumped: list[str] = []

    async def bump(self, topic: str):
        self.bumped.append(topic)
        await asyncio.Event().wait()


@pytest.fixture
def hanging_registry(monkeypatch):
    registry = _HangingRegistry()
    monkeypatch.setattr(change_publish, "get_registry", lambda: registry)
    yield registry
    for task in list(change_publish._inflight):
        task.cancel()


def _unhealthy(prov_id: str, graph_name: str) -> ProviderState:
    state = ProviderState(cache_key=(prov_id, graph_name))
    state.last_observation = ProbeOutcome.from_warmup(
        ok=False, reason="dns_unresolvable", elapsed_ms=1200,
    )
    state.consecutive_failures = 2
    return state


async def test_a_recovery_closes_the_breaker_without_waiting_on_the_notification(
    hanging_registry,
):
    mgr = ProviderManager()
    cache_key = ("prov_X", "graph_a")
    breaker = mgr._get_instantiation_breaker(cache_key)
    breaker.open()
    mgr._provider_states[cache_key] = _unhealthy("prov_X", "graph_a")

    await asyncio.wait_for(
        mgr.record_probe_success("prov_X", source="warmup"), timeout=0.5,
    )

    assert breaker.current_state == BreakerState.CLOSED.value
    await asyncio.sleep(0)
    # Still announced, just not waited for.
    assert set(hanging_registry.bumped) == {"providers:health", "providers:status"}


async def test_a_breaker_trip_does_not_wait_on_the_notification(hanging_registry):
    mgr = ProviderManager()

    for _ in range(mgr._PRE_TRIP_AFTER_N):
        await asyncio.wait_for(
            mgr.record_probe_failure(
                "prov_Y", reason="dns_unresolvable", source="warmup",
            ),
            timeout=0.5,
        )

    breaker = mgr._instantiation_breakers[("prov_Y", "")]
    assert breaker.current_state == BreakerState.OPEN.value
    await asyncio.sleep(0)
    assert "providers:health" in hanging_registry.bumped
