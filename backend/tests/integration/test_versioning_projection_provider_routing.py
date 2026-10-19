"""Provider-aware projection routing — needs Postgres (fake FalkorDB handles).

The projector's graph factory contract is ``(name, provider_id=None)``; a graph pinned to
a provider must project into THAT provider's handle (the same instance the per-provider
read path and aggregation worker use), an unpinned/None provider falls back to the
default handle, an awaitable factory result is awaited (the registry factory resolves
provider rows asynchronously), and eviction drops the graph on its pinned provider.

A moved graph's old key (``keymigrate.retire_moved_keys``) is dropped on its own provider only
once the new key has caught up and the grace period has passed, and only under the graph's
projection lock. A key another data source or catalog entry reads and another graph's pin are kept
(PROTECTED); a key without the projector's pass marker is kept with its entry, unless it is one of
the graph's own platform keys; when its readers cannot be asked, the key waits for the next run.

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
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import func, select

from backend.app.providers import falkor_graph_registry
from backend.app.services.versioning import config, db, keymigrate, models, projection
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.tests.integration.test_versioning_projection import (
    FakeGraph,
    _Result,
    _edit_publish,
    _node,
)


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


# ── a moved graph's old key is dropped once the new key has caught up ──

class _Keys:
    """Per-provider FakeGraphs keyed (provider, name). A RO_QUERY on a key that does not exist
    raises as FalkorDB does, and the marker read answers from the key's pass marker."""

    def __init__(self):
        self.keys: dict = {}
        self.drops: list = []

    def __call__(self, name, provider_id=None):
        return _Key(self, provider_id, name)


class _Key:
    def __init__(self, keys, provider_id, name):
        self._keys, self._at = keys, (provider_id, name)

    async def query(self, cypher, params=None):
        return await self._keys.keys.setdefault(self._at, FakeGraph()).query(cypher, params)

    async def ro_query(self, cypher, params=None, timeout=None):
        g = self._keys.keys.get(self._at)
        if g is None:
            raise RuntimeError("Invalid graph operation on empty key")
        if cypher == projection._MARKER_READ:
            return _Result([[g.proj_meta["seq"]]] if g.proj_meta else [])
        return await g.query(cypher, params)

    async def delete(self):
        self._keys.drops.append(self._at)
        self._keys.keys.pop(self._at, None)


async def _retired(gid):
    async with db.graphver_session() as s:
        return (await s.get(models.ProjectionStateORM, gid)).retired_keys


async def _run_retire() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    keys = _Keys()
    proj = FalkorProjector(keys)
    asked: list = []

    async def nobody(provider, name, exclude_ds):
        asked.append((provider, name, exclude_ds))
        return []

    async def moved(*, caught_up=True):
        """A graph projected into its own key K1 on prov_A, moved to its platform key on prov_B
        and, unless asked otherwise, caught up there. Returns ``(graph_id, data_source_id, K1)``."""
        ds, k1 = "ds_" + os.urandom(4).hex(), "gvt_k1_" + os.urandom(3).hex()
        gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u",
                                      falkor_graph_name=k1, falkor_provider="prov_A",
                                      owns_falkor_graph=True))["graph_id"]
        await _edit_publish(svc, gid, "u", [
            {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("A")}], "s")
        await proj.project_graph(gid)
        assert keys.keys[("prov_A", k1)].proj_meta, "the old key carries its pass marker"
        await svc.move_projection(graph_id=gid, provider="prov_B",
                                  key=keymigrate.owned_key(gid, 1), actor="admin", shard_map={})
        if caught_up:
            await proj.project_graph(gid)
        return gid, ds, k1

    async def retire(gid, **kw):
        return [r for r in await keymigrate.retire_moved_keys(proj, **kw) if r["graphId"] == gid]

    # Not before the new key has caught up, nor before the grace period has passed.
    gid, ds, k1 = await moved(caught_up=False)
    assert await retire(gid, key_in_use=nobody) == []
    await proj.project_graph(gid)
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    assert await retire(gid, key_in_use=nobody, now=past) == []
    assert [e["name"] for e in await _retired(gid)] == [k1]
    assert ("prov_A", k1) not in keys.drops

    # Then the old key is dropped, on its own provider, and its entry goes. Its readers were asked
    # leaving out only the graph's own data source.
    assert await retire(gid, key_in_use=nobody) == [
        {"graphId": gid, "key": k1, "provider": "prov_A", "verdict": "dropped"}]
    assert keys.drops == [("prov_A", k1)] and ("prov_A", k1) not in keys.keys
    # (A run walks every graph's entries, other tests' too.)
    assert [a for a in asked if a[1] == k1] == [("prov_A", k1, ds)]
    assert await _retired(gid) is None
    assert await retire(gid, key_in_use=nobody) == []                       # a second run: no-op
    assert keys.keys[("prov_B", keymigrate.owned_key(gid, 1))].nodes      # the new key is served

    # Another data source or catalog entry reads it: kept, and its entry goes (PROTECTED).
    gid, ds, k1 = await moved()

    async def bound(*_a):
        return [{"kind": "dataSource", "dataSourceId": "ds_other"}]

    (out,) = await retire(gid, key_in_use=bound)
    assert out["verdict"].startswith("PROTECTED") and ("prov_A", k1) not in keys.drops, out
    assert await _retired(gid) is None

    # Who reads it cannot be asked: kept, with its entry, for the next run.
    gid, ds, k1 = await moved()

    async def down(*_a):
        raise RuntimeError("management database unreachable")

    assert await retire(gid, key_in_use=down) == []
    assert [e["name"] for e in await _retired(gid)] == [k1]

    # A pass (or an evict) holds the graph's gvproj lock: nothing happens until it is free.
    async with db.graphver_lock_session() as lock_s:
        lock = func.hashtext(f"gvproj:{gid}")
        assert await lock_s.scalar(select(func.pg_try_advisory_lock(lock)))
        assert await retire(gid, key_in_use=nobody) == []
        assert [e["name"] for e in await _retired(gid)] == [k1]
        await lock_s.execute(select(func.pg_advisory_unlock(lock)))
    assert [r["verdict"] for r in await retire(gid, key_in_use=nobody)] == ["dropped"]

    # Another graph has since been pinned to the old key: kept, and its entry goes.
    gid, ds, k1 = await moved()
    await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                           actor="u", falkor_graph_name=k1, falkor_provider="prov_A")
    (out,) = await retire(gid, key_in_use=nobody)
    assert out["verdict"].startswith("PROTECTED") and ("prov_A", k1) not in keys.drops, out
    assert await _retired(gid) is None

    # A key without our pass marker may not be one the projector wrote: kept, and so is its
    # entry, which the inventory shows, so it is not lost track of.
    gid, ds, k1 = await moved()
    keys.keys[("prov_A", k1)].proj_meta = {}
    assert await retire(gid, key_in_use=nobody) == []
    assert ("prov_A", k1) in keys.keys and ("prov_A", k1) not in keys.drops
    assert [e["name"] for e in await _retired(gid)] == [k1]

    # One of the graph's own platform keys is ours by its name: a reseed cut short leaves it with
    # data and no marker, and once the graph has moved off it, it is dropped all the same.
    gid, ds, k1 = await moved()
    t1, t2 = keymigrate.owned_key(gid, 1), keymigrate.owned_key(gid, 2)
    await svc.move_projection(graph_id=gid, provider="prov_B", key=t2, actor="admin", shard_map={})
    await proj.project_graph(gid)
    keys.keys[("prov_B", t2)].proj_meta = {}                       # the reseed never finished
    await svc.move_projection(graph_id=gid, provider="prov_B", key=t1, actor="admin", shard_map={})
    await proj.project_graph(gid)
    assert {r["key"]: r["verdict"] for r in await retire(gid, key_in_use=nobody)} == {
        k1: "dropped", t2: "dropped"}
    assert ("prov_B", t2) in keys.drops and await _retired(gid) is None

    # A key that is already gone counts as dropped, and nothing is sent to it.
    gid, ds, k1 = await moved()
    del keys.keys[("prov_A", k1)]
    assert [r["verdict"] for r in await retire(gid, key_in_use=nobody)] == ["gone"]
    assert ("prov_A", k1) not in keys.drops and await _retired(gid) is None

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_moved_graphs_old_key_is_dropped_once_the_new_one_caught_up(monkeypatch):
    monkeypatch.setattr(config, "RETIRE_GRACE_SECS", 0)
    asyncio.run(_run_retire())



# ── the admin move, end to end: A to B, a failing target, and back ──

async def _run_move_between_providers() -> None:
    from fastapi import BackgroundTasks

    from backend.app.api.v1.endpoints import versioning_admin as va

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    keys = _Keys()

    def falkor(name, provider_id=None):
        if provider_id != "prov_C":
            return keys(name, provider_id)

        async def down(*_a, **_k):
            raise ConnectionError("prov_C is unreachable")
        return SimpleNamespace(query=down, ro_query=down, delete=down)

    proj = FalkorProjector(falkor)
    recorded: list = []

    async def usable(*_a, **_k):
        return None

    async def unbound(*_a, **_k):
        return []

    async def get_ds(*_a):
        return SimpleNamespace(projection_mode=None, provider_id="prov_A")

    async def listed(provider_id):
        return {n for p, n in keys.keys if p == provider_id}

    async def as_is(session, wm):
        return wm

    async def record(session, event_type, **fields):
        recorded.append(event_type)
        return True

    class _NoJobs:
        async def execute(self, stmt):
            return SimpleNamespace(scalar_one_or_none=lambda: None)

    async def move(gid, **body):
        background = BackgroundTasks()
        with patch.object(va.managed_sources, "assert_provider_usable", usable), \
                patch.object(va.managed_sources, "graph_key_bindings", unbound), \
                patch.object(va.data_source_repo, "get_data_source_orm", get_ds), \
                patch.object(va.falkor_graph_registry, "list_graph_keys", listed), \
                patch.object(va, "_watermark_model", as_is), \
                patch.object(va.recorder, "record_for_request", record):
            out = await va.move_projection(gid, va.ProjectionMoveRequest.model_validate(body),
                                           background, user=SimpleNamespace(id="usr_admin"),
                                           session=_NoJobs())
        assert [(t.func, t.args) for t in background.tasks] == (
            [(va.rebuild_now, (gid,))] if out["changed"] else [])
        return out

    def content(provider, name):
        g = keys.keys[(provider, name)]
        return g.entity_ids(), set(g.edges)

    async def main_content(gid):
        st = await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid))
        return set(st["nodes"]), set(st["edges"])

    # A graph projecting into its own key K1 on prov_A, caught up.
    k1 = "gvt_k1_" + os.urandom(3).hex()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u", falkor_graph_name=k1, falkor_provider="prov_A",
                                  owns_falkor_graph=True))["graph_id"]
    await _edit_publish(svc, gid, "u", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("A")}], "s")
    await proj.project_graph(gid)
    at_move = content("prov_A", k1)
    epoch = (await svc.projection_watermark(gid))["epoch"]

    # Move to prov_B: the graph's first platform key there, reseeded from scratch.
    gvp = keymigrate.owned_key(gid, 1)
    out = await move(gid, providerId="prov_B")
    assert (out["changed"], out["from"], out["to"]) == (
        True, {"providerId": "prov_A", "key": k1}, {"providerId": "prov_B", "key": gvp}), out
    wm = out["watermark"]
    assert (wm["fresh"], wm["status"], wm["epoch"]) == (False, "reseeding", epoch + 1), wm
    assert wm["read_route"]["main"] == "postgres"
    assert [(e["provider"], e["name"]) for e in wm["retired_keys"]] == [("prov_A", k1)]
    assert recorded == ["platform.versioning.projection_moved"]

    # A publish during the move is read from Postgres; then the new key catches up to it. The old
    # key is as it was at the move.
    await _edit_publish(svc, gid, "u", [
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("B")}], "m")
    assert {"A", "B"} <= (await main_content(gid))[0]
    await proj.project_graph(gid)
    wm = await svc.projection_watermark(gid)
    assert (wm["fresh"], wm["falkor_provider"], wm["falkor_graph_name"]) == (True, "prov_B", gvp)
    assert content("prov_B", gvp) == await main_content(gid)
    assert content("prov_A", k1) == at_move

    # Asked again, nothing moves, mints or is recorded.
    epoch = wm["epoch"]
    out = await move(gid, providerId="prov_B")
    assert out["changed"] is False and out["to"] == {"providerId": "prov_B", "key": gvp}
    assert (await svc.projection_watermark(gid))["epoch"] == epoch
    assert recorded == ["platform.versioning.projection_moved"]

    # A target that cannot be written: reads stay on Postgres, and the error shows.
    await move(gid, providerId="prov_C")
    with pytest.raises(ConnectionError):
        await proj.project_graph(gid)
    wm = await svc.projection_watermark(gid)
    assert (wm["fresh"], wm["read_route"]["main"]) == (False, "postgres")
    assert "prov_C is unreachable" in wm["last_error"]

    # Moved back onto K1, which still exists: accepted as the graph's own retired key, and the
    # failed target is queued instead. The next pass reconciles K1 in place.
    out = await move(gid, providerId="prov_A", key=k1)
    assert out["changed"] is True and out["to"] == {"providerId": "prov_A", "key": k1}
    assert sorted((e["provider"], e["name"]) for e in await _retired(gid)) == [
        ("prov_B", gvp), ("prov_C", gvp)]
    await proj.project_graph(gid)
    assert (await svc.projection_watermark(gid))["fresh"] is True
    assert content("prov_A", k1) == await main_content(gid)
    assert ("prov_A", k1) not in keys.drops

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_move_between_providers_e2e():
    asyncio.run(_run_move_between_providers())

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
