"""The reaper files a versioned graph under its data source's workspace where the two disagree.

A data source moved before moves carried their graphs left its graph filed under the old
workspace: readable there through the graph routes, external where the source went, and missed by
the trash and the purge, which look a graph up under its source's workspace. The management
database decides tenancy, so the graph follows its source — tombstone and all.

The version store is faked here (its reads, and the re-filing itself, which
``integration/test_versioning_data_source_lifecycle.py`` runs for real); the data sources are
real rows.
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.versioning import purge_worker
from backend.app.services.versioning.errors import JobActive
from backend.app.services.versioning.service import GraphVersioningService


@pytest.fixture
async def sources(db_session):
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_moved", workspace_id="ws_b", provider_id="prov_a",
                               graph_name="moved"),
        WorkspaceDataSourceORM(id="ds_trashed", workspace_id="ws_b", provider_id="prov_a",
                               graph_name="trashed", deleted_at="2026-10-19T00:00:00+00:00"),
        WorkspaceDataSourceORM(id="ds_both_trashed", workspace_id="ws_b", provider_id="prov_a",
                               graph_name="both", deleted_at="2026-10-19T00:00:00+00:00"),
        WorkspaceDataSourceORM(id="ds_home", workspace_id="ws_a", provider_id="prov_a",
                               graph_name="home"),
    ])
    await db_session.commit()


async def test_each_misplaced_graph_follows_its_source(db_session, sources, monkeypatch):
    graphs = [  # (data_source_id, the graph's workspace, the graph's tombstone)
        ("ds_moved", "ws_a", None),
        ("ds_trashed", "ws_a", None),
        ("ds_both_trashed", "ws_a", "2026-10-19T00:00:00+00:00"),
        ("ds_home", "ws_a", None),
        ("dsfork_a", "ws_a", None),      # a fork's generated id: no source row, the purge's
    ]

    class _Graphs:
        async def execute(self, _stmt):
            return SimpleNamespace(all=lambda: graphs)

    @asynccontextmanager
    async def gv_sessions():
        yield _Graphs()

    @asynccontextmanager
    async def app_sessions():
        yield db_session

    refiled = []

    async def move(self, data_source_id, new_workspace_id, *, from_workspace_id, refuse_open_work,
                   tombstone_by):
        refiled.append((data_source_id, new_workspace_id, from_workspace_id, refuse_open_work,
                        tombstone_by))
        assert self._session is gv_sessions
        return ["graph_x"]

    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", move)
    reaper = purge_worker.Reaper(app_session_factory=lambda: app_sessions(),
                                 graphver_session_factory=gv_sessions)

    assert await reaper._misplaced_graphs() == 3
    assert refiled == [
        ("ds_moved", "ws_b", "ws_a", False, None),
        ("ds_trashed", "ws_b", "ws_a", False, "reaper"),     # the delete it missed
        ("ds_both_trashed", "ws_b", "ws_a", False, None),
    ]


async def test_a_graph_it_cannot_refile_yet_waits_and_the_rest_are_refiled(
    db_session, sources, monkeypatch,
):
    """A graph a job still runs on waits for a later pass: a job runs in the workspace it was
    queued in. Any other failure is logged and skipped. Neither stops the pass, nor counts."""
    graphs = [
        ("ds_moved", "ws_a", None),
        ("ds_trashed", "ws_a", None),
        ("ds_both_trashed", "ws_a", "2026-10-19T00:00:00+00:00"),
    ]

    class _Graphs:
        async def execute(self, _stmt):
            return SimpleNamespace(all=lambda: graphs)

    @asynccontextmanager
    async def gv_sessions():
        yield _Graphs()

    @asynccontextmanager
    async def app_sessions():
        yield db_session

    refiled = []

    async def move(self, data_source_id, new_workspace_id, **_kw):
        if data_source_id == "ds_moved":
            raise JobActive("job_a", "a job is still running on this graph")
        if data_source_id == "ds_trashed":
            raise OSError("connection reset")
        refiled.append(data_source_id)
        return ["graph_x"]

    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", move)
    reaper = purge_worker.Reaper(app_session_factory=lambda: app_sessions(),
                                 graphver_session_factory=gv_sessions)

    assert await reaper._misplaced_graphs() == 1
    assert refiled == ["ds_both_trashed"]


async def test_the_source_is_held_while_its_graph_is_refiled(db_session, sources, monkeypatch):
    """A person's move holds its source's row (FOR UPDATE) from before its graph moves until the
    source commits. The reaper reads the row again FOR SHARE SKIP LOCKED and holds it while it
    re-files the graph: a source being moved is skipped, never moved back from under the move,
    and the reaper waits for no one."""
    graphs = [("ds_moved", "ws_a", None)]

    class _Graphs:
        async def execute(self, _stmt):
            return SimpleNamespace(all=lambda: graphs)

    @asynccontextmanager
    async def gv_sessions():
        yield _Graphs()

    open_sessions = []

    @asynccontextmanager
    async def app_sessions():
        open_sessions.append(db_session)
        try:
            yield db_session
        finally:
            open_sessions.pop()

    locks = []

    def _on(state):
        if state.is_select and any(d.get("entity") is WorkspaceDataSourceORM
                                   for d in state.statement.column_descriptions):
            arg = state.statement._for_update_arg
            locks.append(None if arg is None else ("share" if arg.read else "update",
                                                   arg.skip_locked))
    event.listen(db_session.sync_session, "do_orm_execute", _on)

    held = []

    async def move(self, data_source_id, new_workspace_id, **_kw):
        held.append((locks[-1], len(open_sessions)))
        return ["graph_x"]

    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", move)
    reaper = purge_worker.Reaper(app_session_factory=lambda: app_sessions(),
                                 graphver_session_factory=gv_sessions)

    assert await reaper._misplaced_graphs() == 1
    assert held == [(("share", True), 1)]
