"""Phase-5 tests: the API-side FalkorDB guardrails actually bound work.

``ProviderManager.acquire_provider_slot`` existed but had ZERO callers,
and the ContextEngine trace semaphore was per-request (engines are
constructed per request), so neither limited anything. These tests pin
the fixed wiring: the slot bounds cache-miss computes and sheds with
``ProviderBusy``; two engines for the same (provider, graph) share ONE
process-wide trace semaphore.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints.graph import _bounded_compute
from backend.app.providers import manager as manager_mod
from backend.app.services.context_engine import ContextEngine
from backend.common.adapters import ProviderBusy


def _engine_with_key(key):
    return SimpleNamespace(provider=SimpleNamespace(manager_cache_key=key))


@pytest.mark.asyncio
async def test_bounded_compute_serializes_and_sheds(monkeypatch) -> None:
    mgr = manager_mod.ProviderManager()
    monkeypatch.setattr(manager_mod, "_MAX_PROVIDER_CONCURRENCY", 1)
    monkeypatch.setattr(manager_mod, "_SEMAPHORE_ACQUIRE_BUDGET_S", 0.05)
    monkeypatch.setattr(
        "backend.app.api.v1.endpoints.graph.provider_manager", mgr,
    )

    engine = _engine_with_key(("prov1", "g1"))
    release = asyncio.Event()
    in_flight = asyncio.Event()

    async def slow_compute():
        in_flight.set()
        await release.wait()
        return "done"

    first = asyncio.create_task(_bounded_compute(engine, slow_compute)())
    await in_flight.wait()

    # Second compute against the same (provider, graph) must shed with
    # ProviderBusy (→ 429 + Retry-After at the HTTP layer) while the
    # only slot is occupied.
    async def fast_compute():
        return "second"

    with pytest.raises(ProviderBusy):
        await _bounded_compute(engine, fast_compute)()

    release.set()
    assert await first == "done"
    # Slot released → next compute runs fine.
    assert await _bounded_compute(engine, fast_compute)() == "second"


@pytest.mark.asyncio
async def test_bounded_compute_degrades_without_cache_key() -> None:
    """Draft/versioned wrapper providers may not expose the manager
    identity — the wrapper must pass the compute through unchanged."""
    engine = SimpleNamespace(provider=SimpleNamespace())  # no manager_cache_key

    async def compute():
        return 42

    wrapped = _bounded_compute(engine, compute)
    assert wrapped is compute
    assert await wrapped() == 42


def _bare_engine(**attrs) -> ContextEngine:
    """A ContextEngine without running __init__ — the semaphore registry
    lives on the class, which is exactly what these tests pin."""
    engine = object.__new__(ContextEngine)
    for name, value in attrs.items():
        setattr(engine, name, value)
    return engine


def test_trace_semaphore_is_shared_per_provider_graph() -> None:
    """Engines are per-request; the semaphore must not be. Same
    (provider, graph) → one semaphore; different graphs → distinct."""
    ContextEngine._TRACE_SEMAPHORES.clear()

    e1 = _bare_engine(provider=SimpleNamespace(manager_cache_key=("p1", "g1")))
    e2 = _bare_engine(provider=SimpleNamespace(manager_cache_key=("p1", "g1")))
    e3 = _bare_engine(provider=SimpleNamespace(manager_cache_key=("p1", "g2")))

    s1 = e1._trace_semaphore()
    s2 = e2._trace_semaphore()
    s3 = e3._trace_semaphore()
    assert s1 is s2
    assert s1 is not s3

    # Fallback key for engines without a manager identity: (ws, ds).
    e4 = _bare_engine(provider=SimpleNamespace(), _workspace_id="ws1", _data_source_id="ds1")
    e5 = _bare_engine(provider=SimpleNamespace(), _workspace_id="ws1", _data_source_id="ds1")
    assert e4._trace_semaphore() is e5._trace_semaphore()
    ContextEngine._TRACE_SEMAPHORES.clear()
