"""A fork is read through its root's store with its own changes over it — needs Postgres.

ContextEngine reads a fork's main as it reads a draft: its root's store — the root's own provider
while the root's projection holds its head in the key it publishes, else the root's Postgres
reader — with the fork's patch set laid over it, and a draft on the fork over that. A fork of a
fork reads through the same root. Past ``GRAPHVER_FORK_REWIND_MAX`` entities to classify, the fork
reads its own layered rows in Postgres instead. Deep search goes to the root's store.

The Postgres reads find what a fork only inherited — a node by its urn, a listing, a
neighbourhood — where they looked in the fork's own rows alone.
"""
import os

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.projection import FalkorProjector
from backend.tests.integration.test_fork_data_sources import WS, _client, _fork, _mgmt, _parent
from backend.tests.integration.test_fork_overlay_delta import _d, _e, _n, _run, _u
from backend.tests.integration.test_versioning_projection import FakeFalkor

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]


class _RootStore:
    """The root's own provider, as the registry builds it for the root's data source."""
    name = "root-store"

    def __init__(self, key):
        self.manager_cache_key = key
        self.searches = []

    async def deep_search(self, query, *, deadline_ms=None):
        self.searches.append(query)
        return "the root's page"


class _Registry:
    def __init__(self, provider):
        self.provider = provider
        self.asked = []

    async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
        self.asked.append(data_source_id)
        return self.provider


def test_a_fork_reads_its_roots_store_with_its_changes_over_it(monkeypatch, forks_on):
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    from backend.app.services.context_engine import ContextEngine

    async def case(svc):
        parent_ds, gid = await _parent(svc, pinned=True)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[
            _n("A"), _n("B"), _e("eAB", "A", "B")])
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
        fork_ds, fgid = fork["dataSourceId"], fork["graphId"]
        await svc.apply_ops(graph_id=fgid, actor="u_forker", message="fork", ops=[
            _u("A", "A fork"), _n("N")])
        await svc.apply_ops(graph_id=gid, actor="alice", message="root", ops=[_n("P")])

        async def engine(registry, ds=fork_ds, branch=None):
            async with _mgmt() as session:
                return await ContextEngine.for_workspace(
                    WS, registry, session, data_source_id=ds, actor="u_forker", branch_id=branch)

        async def names(p):
            out = {}
            for urn in ("A", "B", "N", "P"):
                node = await p.get_node(urn)
                out[urn] = node.display_name if node else None
            return out

        # The root's projection lags its head: its store is its Postgres reader.
        e = await engine(_Registry(None))
        assert isinstance(e.provider, DraftOverlayProvider) and e.provider._fork and e._writes_main
        assert e.provider._gid == fgid
        assert isinstance(e.provider._base, VersionedBranchProvider) and e.provider._base._gid == gid
        assert await names(e.provider) == {"A": "A fork", "B": "B", "N": "N", "P": None}
        assert e.provider.manager_cache_key is None              # nothing of FalkorDB's to admit

        # Once it holds the head, the root's own provider, built from the root's data source.
        await FalkorProjector(graph_client_factory=FakeFalkor()).project_graph(gid)
        wm = await svc.projection_watermark(gid)
        registry = _Registry(_RootStore((wm["falkor_provider"], wm["falkor_graph_name"])))
        e = await engine(registry)
        assert e.provider._base is registry.provider and registry.asked == [parent_ds]
        # Its reads take the root shard's admission slot, as the root's own reads do.
        assert e.provider.manager_cache_key == registry.provider.manager_cache_key
        # Deep search runs there: the fork's own changes are not in it, and the note says so.
        assert await e.provider.deep_search("q") == "the root's page"
        assert registry.provider.searches == ["q"]
        assert "the fork's own changes are not searchable" in e.provider.search_scope_note
        # A provider that serves another key than the root's pin is not read from.
        assert isinstance((await engine(_Registry(_RootStore(("prov_x", "elsewhere"))))).provider._base,
                          VersionedBranchProvider)

        # A draft on the fork overlays the fork's main; a fork of the fork reads the same root.
        d = await svc.open_draft(graph_id=fgid, owner="u_forker")
        e = await engine(registry, branch=d)
        assert isinstance(e.provider, DraftOverlayProvider) and e.provider._branch == d
        assert e.provider._base._fork and e.provider._base._base is registry.provider
        async with _client() as c:
            leaf = (await _fork(c, fgid)).json()
        e = await engine(registry, ds=leaf["dataSourceId"])
        assert e.provider._gid == leaf["graphId"] and e.provider._base is registry.provider
        assert registry.asked[-1] == parent_ds

        # Past the ceiling: the fork's own layered reads, which search does not reach.
        monkeypatch.setattr(config, "FORK_REWIND_MAX", 1)
        e = await engine(registry)
        assert isinstance(e.provider, VersionedBranchProvider) and e.provider._gid == fgid
        assert await names(e.provider) == {"A": "A fork", "B": "B", "N": "N", "P": None}
        with pytest.raises(NotImplementedError, match="a fork reads through its parent"):
            await e.provider.deep_search(None)
    _run(case)


def test_a_fork_finds_what_it_only_inherited():
    async def case(svc):
        root = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                       workspace_id="ws1", actor="alice"))["graph_id"]
        await svc.apply_ops(graph_id=root, actor="alice", message="seed", ops=[
            _n("A"), _n("B"), _n("C"), _e("cAB", "A", "B", "CONTAINS"), _e("fBC", "B", "C")],
            containment_edge_types=CONT)
        fork = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws1",
                                     actor="bob"))["graph_id"]
        await svc.apply_ops(graph_id=fork, actor="bob", message="own", ops=[_n("N")])

        # A neighbourhood, from a node the fork only inherited.
        around = await svc.neighbors_from_state(graph_id=fork, urn="B")
        assert {n["urn"] for n in around["nodes"]} == {"A", "B", "C"}
        assert {e["id"] for e in around["edges"]} == {"cAB", "fBC"}
        # Listings: the fork's own rows and what it inherited, in name order, paged across both.
        nodes = await svc.get_nodes_from_state(graph_id=fork, containment_edge_types=CONT)
        assert [(n["urn"], n["childCount"]) for n in nodes] == [("A", 1), ("B", 0), ("C", 0), ("N", 0)]
        page = await svc.get_nodes_from_state(graph_id=fork, limit=2, offset=1)
        assert [n["urn"] for n in page] == ["B", "C"]
        assert [n["urn"] for n in await svc.get_nodes_from_state(graph_id=fork, search_query="c")] \
            == ["C"]
        assert [e["id"] for e in await svc.get_edges_from_state(graph_id=fork, edge_types=["FLOWS"])] \
            == ["fBC"]
        top = await svc.top_level_from_state(graph_id=fork, containment_edge_types=CONT)
        assert [n["urn"] for n in top["nodes"]] == ["A", "C", "N"]
        # What the fork changed of it is decided by the fork's rows.
        await svc.apply_ops(graph_id=fork, actor="bob", message="own", ops=[_d("C"), _u("A", "Z")])
        nodes = await svc.get_nodes_from_state(graph_id=fork)
        assert [(n["urn"], n["displayName"]) for n in nodes] == [("B", "B"), ("N", "N"), ("A", "Z")]
        assert (await svc.neighbors_from_state(graph_id=fork, urn="C"))["nodes"] == []
    _run(case)


def test_a_forks_cached_reads_move_with_its_roots_store(forks_on):
    """A fork's cached canvas reads are keyed by its own data source, and its root's writes and
    projections bump only the root's cache: an answer a fork built across a root publish (its
    patch set at one root head, the store read at the next) was served for the cache's hour. A
    fork's key now carries its root's committed and projected seqs as its engine read them: a root
    commit or projection moves it, and an answer built across one is not served after it."""
    from backend.app.api.v1.endpoints.graph import _cache_scope
    from backend.app.providers.manager import provider_manager
    from backend.app.services.context_engine import ContextEngine

    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A")])
        async with _client() as c:
            fork_ds = (await _fork(c, gid)).json()["dataSourceId"]

        async def scope():
            async with _mgmt() as session:
                engine = await ContextEngine.for_workspace(WS, provider_manager, session,
                                                           data_source_id=fork_ds, actor="u_forker")
                return _cache_scope(engine)

        before = await scope()
        assert await scope() == before                              # the root stood still
        await svc.apply_ops(graph_id=gid, actor="alice", message="root", ops=[_n("B")])
        assert await scope() != before
    _run(case)


def test_a_request_on_a_fork_reads_its_version_and_root_once(forks_on):
    """Each request on a fork built its engine with some thirty statements before its read: the
    fork's and its root's rows each in a session of their own, the main branch ids again and
    again, the ceiling, the root's watermark (two sessions), and on its first read the version
    once more. One session now reads the fork's version, its ceiling (kept per version), its root
    and the root's store, and hands the version to the overlay: a request on a fork costs a few
    statements more than the same request on its root."""
    from sqlalchemy import event

    from backend.app.providers.manager import provider_manager
    from backend.app.services.context_engine import ContextEngine
    from backend.app.services.versioning import db

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
        async with _client() as c:
            fork_ds = (await _fork(c, gid)).json()["dataSourceId"]
        fgid = (await svc.get_graph_by_data_source(fork_ds))["graph_id"]
        await svc.apply_ops(graph_id=fgid, actor="u_forker", message="own", ops=[_n("F")])

        async def cost(ds):
            sent = []

            def record(conn, cursor, statement, params, context, executemany):
                sent.append(statement)

            async def request():
                async with _mgmt() as session:
                    engine = await ContextEngine.for_workspace(WS, provider_manager, session,
                                                               data_source_id=ds, actor="u_forker")
                    await engine.provider.get_node("A")

            await request()                                     # warm: the delta is cached
            # Both pools: the lookups that route a read run on one of their own.
            engines = (db.get_engine().sync_engine, db.get_route_engine().sync_engine)
            for engine in engines:
                event.listen(engine, "before_cursor_execute", record)
            try:
                await request()
            finally:
                for engine in engines:
                    event.remove(engine, "before_cursor_execute", record)
            return len(sent)

        root, fork = await cost(parent_ds), await cost(fork_ds)
        assert fork <= root + 8, (root, fork)
    _run(case)
