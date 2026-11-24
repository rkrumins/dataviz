"""GET /api/v1/views/counts — exact view counts per workspace and data source.

The "N views" pills used to count a page of the list (200, or the default 50),
so past that they stopped growing. These pin that the counts are exact at any
size, that they never count a view the caller cannot open, and what the
optional filters narrow.
"""
import contextlib
from datetime import datetime, timezone

from fastapi import HTTPException, status
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import ProviderORM, ViewORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

URL = "/api/v1/views/counts"
WS_FIN, WS_OPS = "ws_fin", "ws_ops"

_MEMBER = ("workspace:view:read", "workspace:datasource:read")


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
    db_session.add(ProviderORM(id="prov_a", name="Warehouse", provider_type="falkordb"))
    db_session.add_all([WorkspaceORM(id=WS_FIN, name="Finance"), WorkspaceORM(id=WS_OPS, name="Operations")])
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_fin_a", workspace_id=WS_FIN, provider_id="prov_a", graph_name="a"),
        WorkspaceDataSourceORM(id="ds_fin_b", workspace_id=WS_FIN, provider_id="prov_a", graph_name="b"),
        WorkspaceDataSourceORM(id="ds_ops_a", workspace_id=WS_OPS, provider_id="prov_a", graph_name="a"),
    ])
    await db_session.commit()


def _view(view_id, ws_id, ds_id=None, *, visibility="workspace", created_by="usr_alice", **kw):
    return ViewORM(id=view_id, name=view_id, workspace_id=ws_id, data_source_id=ds_id,
                   visibility=visibility, created_by=created_by, **kw)


async def test_counts_past_any_page_size_exactly(test_client: AsyncClient, db_session):
    """Well past the list's largest page (200): every view is counted."""
    await _estate(db_session)
    db_session.add_all([_view(f"v_a{i}", WS_FIN, "ds_fin_a") for i in range(230)])
    db_session.add_all([_view(f"v_b{i}", WS_FIN, "ds_fin_b") for i in range(20)])
    db_session.add_all([_view(f"v_n{i}", WS_FIN) for i in range(5)])
    db_session.add_all([_view(f"v_o{i}", WS_OPS, "ds_ops_a") for i in range(60)])
    await db_session.commit()

    resp = await test_client.get(URL)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 315
    # A view with no data source is in its workspace's count, and in no source's.
    assert body["byWorkspace"] == {WS_FIN: 255, WS_OPS: 60}
    assert body["byDataSource"] == {"ds_fin_a": 230, "ds_fin_b": 20, "ds_ops_a": 60}
    # The Explorer's own total, for the same population.
    assert body["total"] == (await test_client.get("/api/v1/views/stats")).json()["total"]


async def test_counts_only_views_the_caller_can_read(test_client: AsyncClient, db_session):
    await _estate(db_session)
    db_session.add_all([
        _view("v_fin_ws", WS_FIN, "ds_fin_a"),
        _view("v_fin_private", WS_FIN, "ds_fin_a", visibility="private"),
        _view("v_bob_private", WS_FIN, "ds_fin_a", visibility="private", created_by="usr_bob"),
        _view("v_ops_ws", WS_OPS, "ds_ops_a"),
        _view("v_ops_public", WS_OPS, "ds_ops_a", visibility="enterprise"),
        _view("v_fin_gone", WS_FIN, "ds_fin_a", deleted_at=datetime.now(timezone.utc).isoformat()),
    ])
    await db_session.commit()

    bob = PermissionClaims(sid="s_bob", ws_perms={WS_FIN: _MEMBER})
    with _auth(user=BOB, claims=bob):
        body = (await test_client.get(URL)).json()
        explorer = (await test_client.get("/api/v1/views/stats")).json()["total"]

    # Finance's shared view, his own private one, and the one published to everyone —
    # never Alice's private view, Operations' workspace view, or a deleted one.
    assert body == {
        "total": 3,
        "byWorkspace": {WS_FIN: 2, WS_OPS: 1},
        "byDataSource": {"ds_fin_a": 2, "ds_ops_a": 1},
    }
    assert body["total"] == explorer


async def test_filters_narrow_every_number(test_client: AsyncClient, db_session):
    await _estate(db_session)
    db_session.add_all([
        _view("v1", WS_FIN, "ds_fin_a"), _view("v2", WS_FIN, "ds_fin_a"),
        _view("v3", WS_FIN, "ds_fin_b"), _view("v4", WS_FIN),
        _view("v5", WS_OPS, "ds_ops_a"),
    ])
    await db_session.commit()

    by_ws = (await test_client.get(URL, params={"workspaceIds": WS_FIN})).json()
    assert by_ws == {
        "total": 4, "byWorkspace": {WS_FIN: 4}, "byDataSource": {"ds_fin_a": 2, "ds_fin_b": 1},
    }

    by_ds = (await test_client.get(URL, params=[("dataSourceIds", "ds_fin_b"), ("dataSourceIds", "ds_ops_a")])).json()
    assert by_ds == {
        "total": 2, "byWorkspace": {WS_FIN: 1, WS_OPS: 1}, "byDataSource": {"ds_fin_b": 1, "ds_ops_a": 1},
    }

    both = (await test_client.get(URL, params=[("workspaceIds", WS_OPS), ("dataSourceIds", "ds_fin_a")])).json()
    assert both == {"total": 0, "byWorkspace": {}, "byDataSource": {}}


async def test_is_its_own_route_not_a_view_id(test_client: AsyncClient):
    resp = await test_client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "byWorkspace": {}, "byDataSource": {}}
