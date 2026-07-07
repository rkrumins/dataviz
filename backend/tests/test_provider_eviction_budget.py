"""Registry-backed eviction budget resolver + the worker's async-resolver support.

Pure unit tests (no infra):
- ``make_registry_budget_resolver``: the registry value wins; an explicit 0 is
  honoured (unlimited, not "unset"); a missing row / NULL column falls back to
  the env-backed default (``falkor_budget_for``).
- ``ProjectionWorker.evict_once``: consumes BOTH sync and async budget resolvers
  (the ``inspect.isawaitable`` branch), so the env resolver and the registry
  resolver are interchangeable.
"""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

from backend.app.providers import eviction_budget
from backend.app.services.versioning.worker import ProjectionWorker


# ── resolver ──────────────────────────────────────────────────────────

def _resolver(*, registry_value, monkeypatch, env_value=99):
    @asynccontextmanager
    async def _scope():
        yield object()  # session unused — get_falkor_budget is stubbed

    async def fake_get_falkor_budget(session, provider_id):
        return registry_value

    monkeypatch.setattr(eviction_budget.provider_repo, "get_falkor_budget", fake_get_falkor_budget)
    monkeypatch.setattr(eviction_budget.vconfig, "falkor_budget_for", lambda p: env_value)
    return eviction_budget.make_registry_budget_resolver(session_factory=lambda: _scope())


def test_registry_value_wins(monkeypatch):
    resolver = _resolver(registry_value=5, monkeypatch=monkeypatch)
    assert asyncio.run(resolver("prov_A")) == 5


def test_explicit_zero_is_honoured_not_env(monkeypatch):
    # 0 ⇒ unlimited for that provider; must NOT fall through to the env default
    resolver = _resolver(registry_value=0, monkeypatch=monkeypatch, env_value=99)
    assert asyncio.run(resolver("prov_A")) == 0


def test_missing_or_null_falls_back_to_env(monkeypatch):
    resolver = _resolver(registry_value=None, monkeypatch=monkeypatch, env_value=7)
    assert asyncio.run(resolver("default")) == 7


# ── worker consumes sync AND async resolvers ──────────────────────────

class _FakeCache:
    """Minimal CacheManager stand-in: one provider with 3 resident graphs."""
    def __init__(self):
        self.evicted = []

    async def resident_providers(self):
        return ["prov_A"]

    async def resident_count(self, provider):
        return 3

    async def lru_candidates(self, provider, limit):
        return ["g1", "g2", "g3"][:limit]

    async def evict(self, graph_id, *, drop_graph):
        self.evicted.append(graph_id)
        return True


def _evict_with(resolver):
    worker = ProjectionWorker(SimpleNamespace(drop_graph=None), evict_budget=resolver)
    worker._cache = _FakeCache()
    return asyncio.run(worker.evict_once())


def test_evict_once_with_sync_resolver():
    # budget 1, 3 resident → evict the 2 coldest
    assert _evict_with(lambda p: 1) == ["g1", "g2"]


def test_evict_once_with_async_resolver():
    async def budget(p):
        return 1
    assert _evict_with(budget) == ["g1", "g2"]


def test_evict_once_async_zero_budget_skips():
    async def budget(p):
        return 0  # unlimited ⇒ no eviction
    assert _evict_with(budget) == []
