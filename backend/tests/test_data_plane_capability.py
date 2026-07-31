"""Data-plane view-capability gate.

The five workspace data routers (graph / canvas / assignments / assets
/ context-models), the cached-schema/-ontology reads, and versioning
``GET /resolve`` accept EITHER ``workspace:datasource:read`` membership
OR a ``viewId`` capability context: the caller can read that view, the
view belongs to the path workspace, and (for graph-data routes) the
requested data source is the view's resolved source. That is what
makes an ``enterprise`` view actually open for a non-member — before
this gate the metadata plane said yes and every data call 403'd.

Deny-path assertions only check the GATE (401/403/404); allow-path
assertions check "not 401/403" because handlers may still 4xx/5xx on
missing providers in the SQLite harness.

Also pinned here: the two state-changing routes that hid under the
read gate (``vocab-alignment/confirm``, ``graph/changes``) now require
``workspace:datasource:manage`` — capability holders and read-only
members both get 403.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import (
    ProviderORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


WS_A = "ws_cap_a"
WS_B = "ws_cap_b"
DS_A1 = "ds_cap_a1"   # ws_a primary — enterprise view's source
DS_A2 = "ds_cap_a2"   # ws_a secondary
DS_B = "ds_cap_b"     # ws_b's source
PROV = "prov_cap"

OUTSIDER = _user("usr_cap_outsider")
MEMBER = _user("usr_cap_member")

EMPTY_CLAIMS = PermissionClaims(sid="s_cap_empty")
MEMBER_CLAIMS = PermissionClaims(sid="s_cap_member", ws_perms={WS_A: (
    "workspace:datasource:read", "workspace:view:read",
)})


async def _seed(db_session):
    db_session.add(WorkspaceORM(id=WS_A, name="Cap A"))
    db_session.add(WorkspaceORM(id=WS_B, name="Cap B"))
    db_session.add(ProviderORM(id=PROV, name="Cap Prov", provider_type="falkordb"))
    db_session.add(WorkspaceDataSourceORM(
        id=DS_A1, workspace_id=WS_A, provider_id=PROV,
        label="A primary", graph_name="cap_a1", is_primary=True,
    ))
    db_session.add(WorkspaceDataSourceORM(
        id=DS_A2, workspace_id=WS_A, provider_id=PROV,
        label="A secondary", graph_name="cap_a2", is_primary=False,
    ))
    db_session.add(WorkspaceDataSourceORM(
        id=DS_B, workspace_id=WS_B, provider_id=PROV,
        label="B primary", graph_name="cap_b", is_primary=True,
    ))
    views = {
        "enterprise": ViewORM(
            id="view_cap_ent", name="ent", workspace_id=WS_A,
            data_source_id=DS_A1, visibility="enterprise",
            created_by="usr_cap_author",
        ),
        "workspace": ViewORM(
            id="view_cap_ws", name="wsv", workspace_id=WS_A,
            data_source_id=DS_A1, visibility="workspace",
            created_by="usr_cap_author",
        ),
        "private": ViewORM(
            id="view_cap_priv", name="priv", workspace_id=WS_A,
            data_source_id=DS_A1, visibility="private",
            created_by="usr_cap_author",
        ),
        "deleted": ViewORM(
            id="view_cap_del", name="del", workspace_id=WS_A,
            data_source_id=DS_A1, visibility="enterprise",
            created_by="usr_cap_author",
            deleted_at="2026-07-30T00:00:00+00:00",
        ),
    }
    for v in views.values():
        db_session.add(v)
    await db_session.commit()
    return {k: v.id for k, v in views.items()}


# Representative reads, one per gated surface. All carry dataSourceId
# where the surface expects one.
def _capability_reads(view_id):
    q = {"viewId": view_id, "dataSourceId": DS_A1}
    return [
        ("GET", f"/api/v1/{WS_A}/assets/rule-sets", q),
        ("GET", f"/api/v1/{WS_A}/context-models/templates", q),
        ("GET", f"/api/v1/{WS_A}/graph/metadata/schema", q),
        ("POST", f"/api/v1/{WS_A}/graph/canvas/bootstrap", q),
        (
            "GET",
            f"/api/v1/admin/workspaces/{WS_A}/datasources/{DS_A1}/cached-schema",
            {"viewId": view_id},
        ),
        (
            "GET",
            f"/api/v1/admin/workspaces/{WS_A}/datasources/{DS_A1}/cached-ontology",
            {"viewId": view_id},
        ),
        ("GET", f"/api/v1/{WS_A}/versioning/resolve", q),
    ]


async def _request(client, method, path, params, json_body=None):
    if method == "GET":
        return await client.get(path, params=params)
    if method == "POST":
        return await client.post(path, params=params, json=json_body or {})
    if method == "DELETE":
        return await client.delete(path, params=params)
    raise AssertionError(method)


# ── capability allow paths ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_enterprise_view_capability_passes_every_gate(
    test_client: AsyncClient, db_session,
):
    ids = await _seed(db_session)
    for method, path, params in _capability_reads(ids["enterprise"]):
        with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
            r = await _request(test_client, method, path, params)
        assert r.status_code not in (401, 403), (
            f"{method} {path} → {r.status_code}: {r.text[:200]}"
        )


@pytest.mark.asyncio
async def test_member_reads_unchanged(test_client: AsyncClient, db_session):
    """The membership path must be byte-identical to before — no viewId
    needed, same statuses."""
    await _seed(db_session)
    with _auth(user=MEMBER, claims=MEMBER_CLAIMS):
        r = await test_client.get(f"/api/v1/{WS_A}/assets/rule-sets")
    assert r.status_code not in (401, 403)


# ── capability deny paths ────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("tier,expected", [
    ("workspace", 404),   # tier doesn't reach an outsider → hidden
    ("private", 404),
    ("deleted", 404),
])
async def test_unreadable_view_capability_denied(
    test_client: AsyncClient, db_session, tier, expected,
):
    ids = await _seed(db_session)
    with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
        r = await test_client.get(
            f"/api/v1/{WS_A}/assets/rule-sets",
            params={"viewId": ids[tier]},
        )
    assert r.status_code == expected, r.text


@pytest.mark.asyncio
async def test_no_view_context_still_403(test_client: AsyncClient, db_session):
    await _seed(db_session)
    with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
        r = await test_client.get(f"/api/v1/{WS_A}/assets/rule-sets")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_anonymous_401(test_client: AsyncClient, db_session):
    ids = await _seed(db_session)
    with _auth(user=None, claims=None):
        r = await test_client.get(
            f"/api/v1/{WS_A}/graph/metadata/schema",
            params={"viewId": ids["enterprise"], "dataSourceId": DS_A1},
        )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_view_of_other_workspace_404(test_client: AsyncClient, db_session):
    """A readable view can't unlock a DIFFERENT workspace's data plane."""
    ids = await _seed(db_session)
    with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
        r = await test_client.get(
            f"/api/v1/{WS_B}/graph/metadata/schema",
            params={"viewId": ids["enterprise"], "dataSourceId": DS_B},
        )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_wrong_data_source_same_workspace_403(
    test_client: AsyncClient, db_session,
):
    """The capability is pinned to the view's resolved source — a
    sibling source in the same workspace stays closed."""
    ids = await _seed(db_session)
    with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
        r = await test_client.get(
            f"/api/v1/{WS_A}/graph/metadata/schema",
            params={"viewId": ids["enterprise"], "dataSourceId": DS_A2},
        )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_foreign_ds_binding_closed_for_members_too(
    test_client: AsyncClient, db_session,
):
    """Pre-existing cross-tenant hole: dataSourceId was never verified
    to belong to the path workspace. Now it 404s for everyone."""
    await _seed(db_session)
    with _auth(user=MEMBER, claims=MEMBER_CLAIMS):
        r = await test_client.get(
            f"/api/v1/{WS_A}/graph/metadata/schema",
            params={"dataSourceId": DS_B},
        )
    assert r.status_code == 404


# ── mutations stay closed ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_capability_cannot_mutate(test_client: AsyncClient, db_session):
    ids = await _seed(db_session)
    q = {"viewId": ids["enterprise"], "dataSourceId": DS_A1}
    cases = [
        ("POST", f"/api/v1/{WS_A}/graph/vocab-alignment/confirm",
         {**q, "declared": "x"}),
        ("POST", f"/api/v1/{WS_A}/graph/changes",
         {**q, "branchId": "br_x"}),
        ("DELETE", f"/api/v1/{WS_A}/assets/rule-sets/rs_x", q),
        ("POST", f"/api/v1/{WS_A}/graph/assignments/compute", q),
        ("POST", f"/api/v1/{WS_A}/graph/save", q),
    ]
    for method, path, params in cases:
        with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
            r = await _request(test_client, method, path, params)
        assert r.status_code == 403, (
            f"{method} {path} → {r.status_code}: {r.text[:200]}"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,params", [
    ("POST", f"/api/v1/{WS_A}/graph/vocab-alignment/confirm",
     {"dataSourceId": DS_A1, "declared": "x"}),
    ("POST", f"/api/v1/{WS_A}/graph/changes",
     {"dataSourceId": DS_A1, "branchId": "br_x"}),
])
async def test_write_under_read_holes_closed(
    test_client: AsyncClient, db_session, method, path, params,
):
    """These two state-changing routes previously required only the
    read baseline. A read-only member must now get 403."""
    await _seed(db_session)
    with _auth(user=MEMBER, claims=MEMBER_CLAIMS):
        r = await _request(test_client, method, path, params)
    assert r.status_code == 403, f"{method} {path} → {r.status_code}: {r.text[:200]}"
