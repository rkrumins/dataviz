"""The trash says why a data source is stuck there, and a refused restore says why too.

A purge that failed, or that live forks hold back, used to read as "Being deleted" for ever.
``purge_worker`` now answers with the purge's state and its reason, and both routes pass them on.
The state itself is pinned against Postgres in ``integration/test_graph_lifecycle_purge.py``.
"""
from __future__ import annotations

import pytest

from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.versioning import purge_worker
from backend.app.services.versioning.purge_worker import PurgeState

DS = "/api/v1/admin/workspaces/ws_1/data-sources"
GONE = "2026-10-01T00:00:00+00:00"

STATES = {
    "ds_none": PurgeState(),
    "ds_queued": PurgeState("queued", final=True),
    "ds_failed": PurgeState("failed", "connection reset by peer", final=True),
    "ds_forks": PurgeState("blocked", "2 fork(s) still read this graph's history", forks=2),
}


@pytest.fixture
async def trash(db_session, monkeypatch):
    db_session.add_all([WorkspaceORM(id="ws_1", name="Finance"),
                        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb")])
    db_session.add(WorkspaceDataSourceORM(id="ds_live", workspace_id="ws_1", provider_id="prov_1",
                                          graph_name="g_live", label="Live", is_primary=True))
    for ds in STATES:
        db_session.add(WorkspaceDataSourceORM(id=ds, workspace_id="ws_1", provider_id="prov_1",
                                              graph_name=f"g_{ds}", label=ds, deleted_at=GONE))
    await db_session.commit()

    async def _state(*, data_source_id, deleted_at):
        assert deleted_at == GONE              # a purge queued since then counts, done or not
        return STATES[data_source_id]

    monkeypatch.setattr(purge_worker, "purge_state_for_data_source", _state)


@pytest.mark.asyncio
async def test_the_trash_shows_each_purge_state_and_its_reason(test_client, trash):
    resp = await test_client.get(f"{DS}/deleted")
    assert resp.status_code == 200, resp.text
    rows = {r["id"]: r for r in resp.json()}
    got = {ds: (r["purgeState"], r["purgeReason"], r["liveForks"], r["purging"], r["restorable"])
           for ds, r in rows.items()}
    assert got == {
        "ds_none": ("none", None, 0, False, True),
        "ds_queued": ("queued", None, 0, True, False),
        # Stopped, not "being deleted": the reason is the job's own.
        "ds_failed": ("failed", "connection reset by peer", 0, False, False),
        # Nothing queued yet, so it can still be restored; it just will not be purged.
        "ds_forks": ("blocked", "2 fork(s) still read this graph's history", 2, False, True),
    }


@pytest.mark.asyncio
async def test_a_refused_restore_says_why_the_purge_stopped(test_client, trash, monkeypatch):
    async def _refuse(*, data_source_id, workspace_id, deleted_at):
        assert deleted_at == GONE
        return STATES["ds_failed"]

    monkeypatch.setattr(purge_worker, "restore_graphs_for_data_source", _refuse)
    resp = await test_client.post(f"{DS}/ds_failed/restore")
    assert resp.status_code == 409, resp.text
    assert "connection reset by peer" in resp.json()["detail"]
    assert "can no longer be restored" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_a_trash_the_graph_is_too_busy_for_is_503_lock_busy(test_client, trash, db_session,
                                                                  monkeypatch):
    """The tombstone waits a bounded time for saves in flight; past it the person is told the graph
    is busy, and nothing went to the trash."""
    from backend.app.services.versioning.errors import LockBusy

    db_session.add(WorkspaceDataSourceORM(id="ds_other", workspace_id="ws_1", provider_id="prov_1",
                                          graph_name="g_other", label="Other"))
    await db_session.commit()

    async def _busy(**_k):
        raise LockBusy("graph g_live is busy with another change; try again shortly", retry_after=5)

    monkeypatch.setattr(purge_worker, "tombstone_graphs_for_data_source", _busy)
    resp = await test_client.delete(f"{DS}/ds_live")
    assert resp.status_code == 503, resp.text
    assert resp.json()["detail"]["type"] == "lock_busy" and resp.headers["Retry-After"] == "5"
    assert "ds_live" not in {r["id"] for r in (await test_client.get(f"{DS}/deleted")).json()}
