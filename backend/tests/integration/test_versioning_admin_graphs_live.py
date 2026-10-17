"""The fleet inventory (``GET /admin/versioning/graphs``) against Postgres.

* It lists every versioned graph — a live data source's own graph, a fork and an orphan whose data
  source is gone — but not a deleted one, each with its provider, key, ownership and state.
* It pages by graph id: each page continues where the last stopped, and none repeats a graph.
* It filters by provider, status, workspace, kind (main, fork or orphan) and a search that matches
  a graph id, data source id, key or data-source label.

Needs ``GRAPHVER_E2E=1`` and Postgres.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

_ADMIN = SimpleNamespace(id="usr_admin")


async def _seed_data_source(ds: str, ws: str, label: str) -> None:
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

    async with get_async_session() as s:
        if await s.get(WorkspaceORM, ws) is None:
            s.add(WorkspaceORM(id=ws, name=f"Workspace {ws}"))
        s.add(ProviderORM(id=f"prov_{ds}", name=f"prov_{ds}", provider_type="falkordb"))
        await s.flush()
        s.add(WorkspaceDataSourceORM(id=ds, workspace_id=ws, provider_id=f"prov_{ds}", label=label))
        await s.commit()


async def _seed_graph(gid, *, ws, ds, provider, head=3, projected=3, status="idle", error=None,
                      owned=False, fork_of=None, deleted=False):
    async with db.graphver_session() as s:
        s.add(GraphORM(id=gid, data_source_id=ds, workspace_id=ws, kind="manual",
                       main_head_commit_seq=head, fork_parent_graph_id=fork_of,
                       deleted_at=models._now() if deleted else None))
        s.add(ProjectionStateORM(graph_id=gid, projected_commit_seq=projected,
                                 target_commit_seq=projected, status=status,
                                 falkor_provider=provider, falkor_graph_name=f"gvt_{gid}",
                                 owns_falkor_graph=owned, last_error=error))


async def _list(**kw):
    args = dict(provider=None, status=None, workspace_id=None, kind=None, q=None, cursor=None,
                limit=50)
    return await va.list_graphs(**{**args, **kw}, _user=_ADMIN)


async def _ids(**kw):
    return [g["graphId"] for g in (await _list(**kw))["graphs"]]


async def _run() -> None:
    from backend.app.db.engine import close_db

    await models.create_schema_and_partitions()
    tag = os.urandom(4).hex()
    ws, other_ws = f"ws_inv_{tag}", f"ws_inv2_{tag}"
    prov, other_prov = f"falkor_{tag}", f"falkor2_{tag}"
    live_ds, other_ds = f"ds_inv_{tag}", f"ds_inv2_{tag}"
    await _seed_data_source(live_ds, ws, f"Customer 360 {tag}")
    await _seed_data_source(other_ds, other_ws, f"Billing {tag}")

    main, fork, orphan, failed, gone, elsewhere = (
        f"graph_{tag}_{n}" for n in ("a_main", "b_fork", "c_orphan", "d_failed", "e_gone", "f_ws2"))
    await _seed_graph(main, ws=ws, ds=live_ds, provider=prov, owned=True)
    await _seed_graph(fork, ws=ws, ds=f"dsfork_{tag}", provider=prov, head=5, projected=2,
                      fork_of=main)
    await _seed_graph(orphan, ws=ws, ds=f"ds_deleted_{tag}", provider=other_prov,
                      status="evicted", projected=0)
    await _seed_graph(failed, ws=ws, ds=f"ds_deleted2_{tag}", provider=prov,
                      error="connection refused")
    await _seed_graph(gone, ws=ws, ds=f"ds_deleted3_{tag}", provider=prov, deleted=True)
    await _seed_graph(elsewhere, ws=other_ws, ds=other_ds, provider=other_prov)

    # Everything in the workspace but the deleted graph, forks and orphans included, by graph id.
    page = await _list(workspace_id=ws)
    assert [g["graphId"] for g in page["graphs"]] == [main, fork, orphan, failed]
    assert page["nextCursor"] is None
    rows = {g["graphId"]: g for g in page["graphs"]}
    assert rows[main] | {"lastProjectedAt": None, "updatedAt": None} == {
        "graphId": main, "workspaceId": ws, "workspaceName": f"Workspace {ws}",
        "dataSourceId": live_ds, "dataSourceLabel": f"Customer 360 {tag}",
        "providerName": f"prov_{live_ds}", "providerType": "falkordb", "kind": "manual",
        "falkorGraphName": f"gvt_{main}", "falkorProvider": prov, "committed": 3,
        "projected": 3, "target": 3, "lag": 0, "status": "idle", "lastError": None,
        "lastProjectedAt": None, "progressDone": None, "progressTotal": None, "updatedAt": None,
        "owned": True, "forkParentGraphId": None, "orphan": False,
    }
    assert rows[fork]["forkParentGraphId"] == main and rows[fork]["lag"] == 3
    assert rows[fork]["orphan"] is False, "a fork's data source id is never a management row"
    assert rows[orphan]["orphan"] is True and rows[orphan]["dataSourceLabel"] is None
    assert rows[orphan]["status"] == "evicted"

    # Keyset paging: two at a time, in order, no graph twice, and the last page says so.
    seen, cursor = [], None
    while True:
        page = await _list(workspace_id=ws, limit=2, cursor=cursor)
        assert len(page["graphs"]) <= 2
        seen += [g["graphId"] for g in page["graphs"]]
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert seen == [main, fork, orphan, failed]

    # Filters.
    assert await _ids(workspace_id=ws, kind="main") == [main]
    assert await _ids(workspace_id=ws, kind="fork") == [fork]
    assert await _ids(workspace_id=ws, kind="orphan") == [orphan, failed]
    assert await _ids(provider=other_prov) == [orphan, elsewhere]
    assert await _ids(workspace_id=ws, status="failed") == [failed]
    assert await _ids(workspace_id=ws, status="lagging") == [fork]
    assert await _ids(workspace_id=ws, status="evicted") == [orphan]
    assert await _ids(workspace_id=ws, status="fresh") == [main]
    assert await _ids(q=f"Customer 360 {tag}") == [main], "the data-source label matches"
    assert await _ids(q=f"gvt_{fork}") == [fork], "the FalkorDB key matches"
    assert await _ids(q=f"ds_deleted_{tag}") == [orphan], "the data source id matches"
    assert await _ids(q=f"{tag}_f_ws2") == [elsewhere], "the graph id matches"
    assert await _ids(q=f"{tag}%") == [], "a search is literal, not a LIKE pattern"

    await db.dispose_engine()
    await close_db()


def test_the_inventory_lists_pages_and_filters_every_versioned_graph():
    asyncio.run(_run())
