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

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.versioning import purge_worker


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

    async def rehome(*, data_source_id, to_workspace_id, refuse_busy, tombstone_by, session_factory):
        refiled.append((data_source_id, to_workspace_id, refuse_busy, tombstone_by))
        assert session_factory is gv_sessions
        return "graph_x"

    monkeypatch.setattr(purge_worker, "rehome_graph_for_data_source", rehome)
    reaper = purge_worker.Reaper(app_session_factory=lambda: app_sessions(),
                                 graphver_session_factory=gv_sessions)

    assert await reaper._misplaced_graphs() == 3
    assert refiled == [
        ("ds_moved", "ws_b", False, None),
        ("ds_trashed", "ws_b", False, "reaper"),     # the delete it missed
        ("ds_both_trashed", "ws_b", False, None),
    ]
