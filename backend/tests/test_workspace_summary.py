"""GET /api/v1/admin/workspaces/summary — the estate's numbers, defined once.

The dashboard, the workspaces page and the admin overview used to add these
up separately in the browser, from different snapshots, and quoted different
totals. They now all read this endpoint, so what it counts is pinned here:
which workspaces each caller covers, a graph mounted twice counted once,
sources still being measured kept out of the sums, and views counted exactly
as the Explorer counts them.
"""
import contextlib
import json
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import (
    DataSourceCountRollupORM,
    DataSourceStatsORM,
    ProviderORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

URL = "/api/v1/admin/workspaces/summary"
WS_FIN, WS_OPS = "ws_fin", "ws_ops"

_MEMBER = (
    "workspace:view:create", "workspace:view:edit", "workspace:view:delete",
    "workspace:view:read", "workspace:datasource:read",
)


def _user(user_id: str) -> User:
    return User(
        id=user_id, email=f"{user_id}@example.com", first_name="T", last_name="U",
        role="user", status="active",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    )


BOB = _user("usr_bob")


@contextlib.contextmanager
def _auth(*, user, claims):
    from backend.app.main import app

    async def _current():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="x")
        return user

    async def _optional():
        return user

    prev = {dep: app.dependency_overrides.get(dep)
            for dep in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _optional
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            app.dependency_overrides[dep] = fn


async def _estate(db_session):
    """Two workspaces. ``g1`` is mounted in both; one source is cold, one paused,
    one in the trash."""
    now = datetime.now(timezone.utc).isoformat()
    db_session.add(ProviderORM(id="prov_a", name="Warehouse", provider_type="falkordb"))
    db_session.add_all([
        WorkspaceORM(id=WS_FIN, name="Finance"),
        WorkspaceORM(id=WS_OPS, name="Operations"),
    ])
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_fin_g1", workspace_id=WS_FIN, provider_id="prov_a", graph_name="g1"),
        WorkspaceDataSourceORM(id="ds_fin_cold", workspace_id=WS_FIN, provider_id="prov_a", graph_name="g2"),
        WorkspaceDataSourceORM(id="ds_ops_g1", workspace_id=WS_OPS, provider_id="prov_a", graph_name="g1"),
        WorkspaceDataSourceORM(id="ds_ops_paused", workspace_id=WS_OPS, provider_id="prov_a",
                               graph_name="g3", is_active=False),
        WorkspaceDataSourceORM(id="ds_ops_trash", workspace_id=WS_OPS, provider_id="prov_a",
                               graph_name="g4", deleted_at=now),
    ])

    def stats(ds_id, nodes, edges, types):
        return DataSourceStatsORM(
            data_source_id=ds_id, node_count=nodes, edge_count=edges,
            entity_type_counts=json.dumps(types), updated_at=now,
        )

    db_session.add_all([
        stats("ds_fin_g1", 100, 50, {"Table": 60, "Column": 40}),
        stats("ds_ops_g1", 100, 50, {"Table": 60, "Column": 40}),
        stats("ds_ops_paused", 10, 5, {"Dashboard": 10}),
        stats("ds_ops_trash", 999, 999, {"Ghost": 1}),
    ])
    await db_session.commit()


async def _views(db_session):
    """Readable to different people: Bob is a member of Finance only."""
    db_session.add_all([
        ViewORM(id="v_fin_ws", name="Finance shared", workspace_id=WS_FIN,
                data_source_id="ds_fin_g1", visibility="workspace", created_by="usr_alice"),
        ViewORM(id="v_fin_private", name="Alice's", workspace_id=WS_FIN,
                visibility="private", created_by="usr_alice"),
        ViewORM(id="v_ops_ws", name="Ops shared", workspace_id=WS_OPS,
                data_source_id="ds_ops_g1", visibility="workspace", created_by="usr_alice"),
        ViewORM(id="v_ops_public", name="Ops for everyone", workspace_id=WS_OPS,
                visibility="enterprise", created_by="usr_alice"),
        ViewORM(id="v_fin_deleted", name="Gone", workspace_id=WS_FIN, visibility="workspace",
                created_by="usr_alice", deleted_at=datetime.now(timezone.utc).isoformat()),
    ])
    await db_session.commit()


def _row(body, ws_id):
    return next(w for w in body["workspaces"] if w["id"] == ws_id)


async def test_summary_is_its_own_route_not_a_workspace_id(test_client: AsyncClient):
    resp = await test_client.get(URL)
    assert resp.status_code == 200
    assert resp.json()["coverage"] == "all"
    assert resp.json()["totals"]["workspaces"] == 0


async def test_a_graph_mounted_twice_is_counted_once(test_client: AsyncClient, db_session):
    await _estate(db_session)
    body = (await test_client.get(URL)).json()
    totals = body["totals"]

    assert totals["workspaces"] == 2
    # Trashed sources are not sources; the paused one still is.
    assert totals["dataSources"] == 4
    assert totals["activeDataSources"] == 3
    assert totals["pendingDataSources"] == 1
    # g1 once (100) + the paused g3 (10); the cold g2 is pending, not zero.
    assert totals["nodes"] == 110
    assert totals["edges"] == 55
    assert totals["entityTypes"] == ["Column", "Dashboard", "Table"]
    assert totals["sharedGraphs"] == 1

    fin, ops = _row(body, WS_FIN), _row(body, WS_OPS)
    assert (fin["dataSources"], fin["pendingDataSources"], fin["nodes"]) == (2, 1, 100)
    assert fin["sources"]["ds_fin_cold"]["pending"] is True
    # Each workspace counts its own sources, so the rows add up past the total.
    assert (ops["dataSources"], ops["activeDataSources"], ops["nodes"]) == (2, 1, 110)
    assert "ds_ops_trash" not in ops["sources"]


async def test_the_bulk_stats_and_the_summary_share_one_estate(test_client: AsyncClient, db_session):
    await _estate(db_session)
    bulk = (await test_client.get("/api/v1/admin/workspaces/datasources/cached-stats")).json()["data"]
    summary = (await test_client.get(URL)).json()
    keys = {f"{w['id']}/{ds}" for w in summary["workspaces"] for ds in w["sources"]}
    assert set(bulk) == keys


async def test_views_are_the_explorers_total(test_client: AsyncClient, db_session):
    await _estate(db_session)
    await _views(db_session)

    admin = (await test_client.get(URL)).json()
    assert admin["totals"]["views"] == 4
    assert admin["totals"]["views"] == (await test_client.get("/api/v1/views/stats")).json()["total"]

    bob = PermissionClaims(sid="s_bob", ws_perms={WS_FIN: _MEMBER})
    with _auth(user=BOB, claims=bob):
        body = (await test_client.get(URL)).json()
        explorer = (await test_client.get("/api/v1/views/stats")).json()["total"]

    # Finance's shared view plus the one published to everyone; never Alice's private one.
    assert body["totals"]["views"] == 2 == explorer
    fin = _row(body, WS_FIN)
    assert fin["views"] == 1
    assert fin["sources"]["ds_fin_g1"]["views"] == 1


async def test_a_member_covers_only_their_workspaces(test_client: AsyncClient, db_session):
    await _estate(db_session)
    bob = PermissionClaims(sid="s_bob", ws_perms={WS_FIN: _MEMBER})
    with _auth(user=BOB, claims=bob):
        body = (await test_client.get(URL)).json()
    assert body["coverage"] == "granted"
    assert [w["id"] for w in body["workspaces"]] == [WS_FIN]
    assert body["totals"]["dataSources"] == 2
    assert body["totals"]["nodes"] == 100
    assert body["totals"]["sharedGraphs"] == 0


async def test_organisation_wide_roles_cover_every_workspace(test_client: AsyncClient, db_session):
    await _estate(db_session)
    for perm in ("system:org-admin", "system:org-viewer"):
        claims = PermissionClaims(sid="s_org", global_perms=(perm,))
        with _auth(user=BOB, claims=claims):
            body = (await test_client.get(URL)).json()
            listed = (await test_client.get("/api/v1/admin/workspaces")).json()
            opened = await test_client.get(f"/api/v1/admin/workspaces/{WS_OPS}")
        assert body["coverage"] == "all", perm
        assert {w["id"] for w in body["workspaces"]} == {WS_FIN, WS_OPS}, perm
        assert {w["id"] for w in listed} == {WS_FIN, WS_OPS}, perm
        assert opened.status_code == 200, perm


async def test_the_list_counts_only_views_the_caller_can_open(test_client: AsyncClient, db_session):
    """The list's ``viewCount`` is the summary's per-workspace count — never
    someone else's private views."""
    await _estate(db_session)
    await _views(db_session)
    admin = {w["id"]: w["viewCount"] for w in (await test_client.get("/api/v1/admin/workspaces")).json()}
    assert admin == {WS_FIN: 2, WS_OPS: 2}

    bob = PermissionClaims(sid="s_bob", ws_perms={WS_FIN: _MEMBER})
    with _auth(user=BOB, claims=bob):
        listed = (await test_client.get("/api/v1/admin/workspaces")).json()
        summary = (await test_client.get(URL)).json()
    assert {w["id"]: w["viewCount"] for w in listed} == {WS_FIN: 1} == {
        w["id"]: w["views"] for w in summary["workspaces"]
    }


async def test_the_list_still_loads_when_view_access_cannot_be_worked_out(
    test_client: AsyncClient, db_session,
):
    """Workspace grants unavailable: views refuse (503), but the list the whole
    app depends on still loads — without counts rather than with wrong ones."""
    await _estate(db_session)
    await _views(db_session)
    claims = PermissionClaims(sid="s_org", global_perms=("system:org-viewer",), ws_available=False)
    with _auth(user=BOB, claims=claims):
        resp = await test_client.get("/api/v1/admin/workspaces")
    assert resp.status_code == 200
    assert {w["id"]: w["viewCount"] for w in resp.json()} == {WS_FIN: None, WS_OPS: None}


TREND = "/api/v1/admin/workspaces/summary/trend"


async def _rollups(db_session):
    """Day rollups, as profiling keeps them: g1 through both of its mounts (one
    graph, 100 then 110), g2 and the paused g3 from yesterday."""
    today = datetime.now(timezone.utc).date()

    def roll(ds_id, days_ago, nodes, edges):
        return DataSourceCountRollupORM(
            data_source_id=ds_id, grain="day", bucket_start=(today - timedelta(days=days_ago)).isoformat(),
            node_count=nodes, edge_count=edges,
        )

    db_session.add_all([
        roll("ds_fin_g1", 2, 100, 50), roll("ds_ops_g1", 2, 100, 50),
        roll("ds_fin_cold", 1, 7, 3), roll("ds_ops_paused", 1, 10, 5),
        roll("ds_fin_g1", 0, 110, 55), roll("ds_ops_g1", 0, 110, 55),
    ])
    await db_session.commit()


async def test_the_trend_counts_a_shared_graph_once_and_ends_where_the_summary_is(
    test_client: AsyncClient, db_session,
):
    await _estate(db_session)
    await _views(db_session)
    await _rollups(db_session)
    trend = (await test_client.get(TREND)).json()
    summary = (await test_client.get(URL)).json()

    assert len(trend["days"]) == 30
    assert trend["days"][-1] == datetime.now(timezone.utc).date().isoformat()
    # Nothing measured before three days ago: unknown, not zero.
    assert trend["nodes"][:27] == [None] * 27
    # g1 once (not 200), then g2 and g3 join, then g1 grows.
    assert trend["nodes"][-3:] == [100, 117, 127]
    assert trend["edges"][-3:] == [50, 58, 63]
    for key, total in (("views", "views"), ("workspaces", "workspaces"), ("dataSources", "dataSources")):
        assert trend[key][-1] == summary["totals"][total], key
    assert trend["views"][0] == 0  # every view here was made today


async def test_the_trend_covers_only_the_callers_workspaces(test_client: AsyncClient, db_session):
    await _estate(db_session)
    await _rollups(db_session)
    bob = PermissionClaims(sid="s_bob", ws_perms={WS_FIN: _MEMBER})
    with _auth(user=BOB, claims=bob):
        trend = (await test_client.get(TREND)).json()
    # Finance mounts g1 and g2; Operations' paused g3 is not Bob's.
    assert trend["nodes"][-3:] == [100, 107, 117]
    assert trend["workspaces"][-1] == 1
