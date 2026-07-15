"""Provider-aware projection routing — needs Postgres (fake FalkorDB handles).

The projector's graph factory contract is ``(name, provider_id=None)``; a graph pinned to
a provider must project into THAT provider's handle (the same instance the per-provider
read path and aggregation worker use), an unpinned/None provider falls back to the
default handle, an awaitable factory result is awaited (the registry factory resolves
provider rows asynchronously), and eviction drops the graph on its pinned provider.

The ``make_registry_graph_factory``/``list_graph_keys`` unit tests below (no Postgres
needed — ``session_factory``/``provider_repo`` are stubbed) pin the fail-loud contract: a
PINNED provider that is missing/inactive/non-falkordb/no-host, or whose lookup raises,
must RAISE ``ProviderConfigurationError`` instead of silently routing to the env-default
FalkorDB instance (the data-corruption risk this guards against). The genuinely
unrouted/``None`` case is unchanged — env default.
"""
import asyncio
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from backend.app.providers import falkor_graph_registry
from backend.app.services.versioning import db, models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.interfaces.provider import ProviderConfigurationError


class Recorder:
    """Per-provider fake FalkorDB: records which (provider, graph name) got writes/drops."""

    def __init__(self):
        self.queries: list = []       # (provider_id, name)
        self.drops: list = []         # (provider_id, name)

    def factory(self, *, awaitable: bool):
        async def _make(name, provider_id=None):
            async def _query(cypher, params=None):
                self.queries.append((provider_id, name))
                return None

            async def _delete():
                self.drops.append((provider_id, name))
            return SimpleNamespace(query=_query, delete=_delete)

        if awaitable:
            return _make                              # factory returns an awaitable

        def _sync(name, provider_id=None):
            # same recording handle, resolved synchronously
            loop = asyncio.get_event_loop()
            return loop.run_until_complete(_make(name, provider_id)) \
                if not loop.is_running() else _SyncHandle(self, name, provider_id)
        return _sync


class _SyncHandle:
    def __init__(self, rec, name, provider_id):
        self._rec, self._name, self._pid = rec, name, provider_id

    async def query(self, cypher, params=None):
        self._rec.queries.append((self._pid, self._name))
        return None

    async def delete(self):
        self._rec.drops.append((self._pid, self._name))


async def _seed(svc, *, provider, name):
    gid = (await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u",
        falkor_graph_name=name, falkor_provider=provider))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A",
         "payload": {"urn": "A", "entityType": "Dataset", "displayName": "A"}}])
    return gid


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    rec = Recorder()

    # ── awaitable factory: pinned provider routes writes to that provider's handle ──
    proj = FalkorProjector(rec.factory(awaitable=True))
    name_b = "gvt_route_" + os.urandom(3).hex()
    gid_b = await _seed(svc, provider="prov_B", name=name_b)
    r = await proj.project_graph(gid_b)
    assert r["noop"] is False, r
    assert {p for p, _n in rec.queries} == {"prov_B"}, rec.queries
    assert all(n == name_b for _p, n in rec.queries)

    # ── None provider falls back to the default handle (provider_id=None) ──
    rec.queries.clear()
    name_d = "gvt_route_" + os.urandom(3).hex()
    gid_d = await _seed(svc, provider=None, name=name_d)
    await proj.project_graph(gid_d)
    assert {p for p, _n in rec.queries} == {None}, rec.queries

    # ── sync factory (env-instance shape) still works through the same call sites ──
    rec.queries.clear()
    proj_sync = FalkorProjector(rec.factory(awaitable=False))
    name_s = "gvt_route_" + os.urandom(3).hex()
    gid_s = await _seed(svc, provider="prov_S", name=name_s)
    await proj_sync.project_graph(gid_s)
    assert {p for p, _n in rec.queries} == {"prov_S"}, rec.queries

    # ── drop routes to the pinned provider (the eviction path's contract) ──
    await proj.drop_graph(name_b, "prov_B")
    assert rec.drops[-1] == ("prov_B", name_b), rec.drops

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_provider_routing_e2e():
    asyncio.run(_run())


# ── pinned-unresolvable provider fails loud (no Postgres needed — stubbed lookup) ──

def _row(**overrides):
    base = dict(is_active=True, provider_type="falkordb", host="falkordb-host", port=6379)
    base.update(overrides)
    return SimpleNamespace(**base)


def _stub_provider_lookup(monkeypatch, *, row=None, raises=None, creds=None):
    """Stub ``provider_repo.get_provider_orm``/``get_credentials`` for the registry's
    ``from ... import provider_repo`` (same cached module object, so patching its
    attributes here is visible wherever that name is looked up)."""
    from backend.app.db.repositories import provider_repo

    async def fake_get_provider_orm(session, provider_id):
        if raises:
            raise raises
        return row

    async def fake_get_credentials(session, provider_id):
        return creds or {}

    monkeypatch.setattr(provider_repo, "get_provider_orm", fake_get_provider_orm)
    monkeypatch.setattr(provider_repo, "get_credentials", fake_get_credentials)


@asynccontextmanager
async def _fake_session_scope():
    yield object()  # session unused — provider_repo calls are stubbed


def _fake_session_factory():
    return _fake_session_scope()


def _refusing_session_factory():
    def _boom():
        raise AssertionError("must not hit the DB for a genuinely unrouted/None provider_id")
    return _boom


async def test_resolve_raises_for_inactive_pinned_provider(monkeypatch):
    _stub_provider_lookup(monkeypatch, row=_row(is_active=False))
    graph = falkor_graph_registry.make_registry_graph_factory(session_factory=_fake_session_factory)
    with pytest.raises(ProviderConfigurationError):
        await graph("g1", provider_id="prov_bad")


async def test_resolve_raises_for_non_falkordb_pinned_provider(monkeypatch):
    _stub_provider_lookup(monkeypatch, row=_row(provider_type="neo4j"))
    graph = falkor_graph_registry.make_registry_graph_factory(session_factory=_fake_session_factory)
    with pytest.raises(ProviderConfigurationError):
        await graph("g1", provider_id="prov_bad")


async def test_resolve_raises_for_missing_host_pinned_provider(monkeypatch):
    _stub_provider_lookup(monkeypatch, row=_row(host=None))
    graph = falkor_graph_registry.make_registry_graph_factory(session_factory=_fake_session_factory)
    with pytest.raises(ProviderConfigurationError):
        await graph("g1", provider_id="prov_bad")


async def test_resolve_raises_for_unknown_pinned_provider(monkeypatch):
    _stub_provider_lookup(monkeypatch, row=None)
    graph = falkor_graph_registry.make_registry_graph_factory(session_factory=_fake_session_factory)
    with pytest.raises(ProviderConfigurationError):
        await graph("g1", provider_id="prov_missing")


async def test_resolve_raises_on_lookup_exception(monkeypatch):
    _stub_provider_lookup(monkeypatch, raises=RuntimeError("db unreachable"))
    graph = falkor_graph_registry.make_registry_graph_factory(session_factory=_fake_session_factory)
    with pytest.raises(ProviderConfigurationError):
        await graph("g1", provider_id="prov_bad")


@pytest.mark.integration  # dials the ENV FalkorDB (the client cache's build-time
# verify PING reaches localhost:6379) — needs a live instance, unlike the
# stubbed unit tests in this module.
async def test_resolve_none_provider_still_uses_env_default(monkeypatch):
    # genuinely-unrouted case is UNCHANGED — must not even touch the DB
    graph = falkor_graph_registry.make_registry_graph_factory(
        session_factory=_refusing_session_factory())
    result = await graph("g1", provider_id=None)
    assert result is not None


async def test_list_graph_keys_raises_for_inactive_pinned_provider(monkeypatch):
    _stub_provider_lookup(monkeypatch, row=_row(is_active=False))
    with pytest.raises(ProviderConfigurationError):
        await falkor_graph_registry.list_graph_keys(
            provider_id="prov_bad", session_factory=_fake_session_factory)


async def test_list_graph_keys_raises_on_lookup_exception(monkeypatch):
    _stub_provider_lookup(monkeypatch, raises=RuntimeError("db unreachable"))
    with pytest.raises(ProviderConfigurationError):
        await falkor_graph_registry.list_graph_keys(
            provider_id="prov_bad", session_factory=_fake_session_factory)


async def test_list_graph_keys_none_provider_unchanged(monkeypatch):
    # genuinely-unrouted case is UNCHANGED — must not even touch the DB; falls through
    # to the (unreachable-in-tests) env default, which is a "cannot verify" None, not
    # a raise.
    result = await falkor_graph_registry.list_graph_keys(
        provider_id=None, session_factory=_refusing_session_factory())
    assert result is None or isinstance(result, set)


if __name__ == "__main__":
    asyncio.run(_run())
    print("provider-aware projection routing (pinned/default/sync-factory/drop) e2e: OK")
