"""Delegated, view-scoped access to the data plane.

The regression being fixed: a view's visibility tier decided who could
*find and open* it, but every route that renders one was gated on
``workspace:datasource:read`` in its workspace — a permission an
``enterprise`` or ``public`` reader does not hold, because those tiers
exist for people who are not in the workspace. The view listed, opened,
returned 200 from the detail route, and then painted an empty canvas.

These tests drive the delegable **context-models** router because it is
DB-only; the canvas router is the other delegable one but needs a live
graph provider, so its confinement is covered by unit tests over the
helpers plus the integration suite.
"""
from __future__ import annotations

import contextlib

import pytest
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import (
    ContextModelORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims

WS = "ws_finance"
OTHER_WS = "ws_marketing"
TEMPLATES = "/api/v1/{ws}/context-models/templates"


@contextlib.contextmanager
def _as(user_id: str, claims: PermissionClaims):
    from backend.app.main import app

    user = type("U", (), {"id": user_id, "email": f"{user_id}@example.com"})()

    async def _user():
        return user

    def _claims():
        return claims

    prev = {
        dep: app.dependency_overrides.get(dep)
        for dep in (get_current_user, get_optional_user, get_permission_claims)
    }
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    try:
        yield
    finally:
        for dep, original in prev.items():
            if original is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = original


async def _seed(session):
    session.add(WorkspaceORM(id=WS, name="Finance"))
    session.add(WorkspaceORM(id=OTHER_WS, name="Marketing"))
    session.add(WorkspaceDataSourceORM(
        id="ds_fin", workspace_id=WS, provider_id="prv_x", graph_name="fin",
    ))
    session.add(ContextModelORM(
        id="cm_tpl", name="Quick Start", is_template=True,
    ))
    for tier in ("private", "enterprise", "public"):
        session.add(ViewORM(
            id=f"view_{tier}", name=tier, workspace_id=WS,
            data_source_id="ds_fin", visibility=tier, created_by="usr_owner",
            config="{}",
        ))
    session.add(ViewORM(
        id="view_elsewhere", name="elsewhere", workspace_id=OTHER_WS,
        visibility="public", created_by="usr_owner", config="{}",
    ))
    await session.commit()


#: Someone with no binding anywhere — the caller an `enterprise`/`public`
#: view is *for*, and the one that used to get an empty canvas.
OUTSIDER = PermissionClaims(sid="s_out", ws_perms={})
#: A real member: holds the permission outright, takes the fast path.
MEMBER = PermissionClaims(
    sid="s_mem", ws_perms={WS: ("workspace:datasource:read",)},
)


# ── the fast path is untouched ───────────────────────────────────────

@pytest.mark.asyncio
async def test_member_reaches_the_route_with_no_view_context(
    test_client: AsyncClient, db_session,
):
    """Holding the permission is still sufficient, exactly as before."""
    await _seed(db_session)
    with _as("usr_member", MEMBER):
        resp = await test_client.get(TEMPLATES.format(ws=WS))
    assert resp.status_code == 200


# ── delegation ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_outsider_is_refused_without_a_view_context(
    test_client: AsyncClient, db_session,
):
    """No ``viewId`` means nothing to scope the request to — plain 403."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.get(TEMPLATES.format(ws=WS))
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "missing_permission"


@pytest.mark.asyncio
async def test_outsider_reaches_the_route_through_a_public_view(
    test_client: AsyncClient, db_session,
):
    """This is the fix: reading the view now carries data access."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_public"},
        )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_a_workspace_member_elsewhere_reaches_an_enterprise_view(
    test_client: AsyncClient, db_session,
):
    """``enterprise`` means "anyone in the organisation" — someone bound to
    a different workspace qualifies, and must be able to actually open it."""
    await _seed(db_session)
    elsewhere = PermissionClaims(
        sid="s_e", ws_perms={OTHER_WS: ("workspace:view:read",)},
    )
    with _as("usr_elsewhere", elsewhere):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_enterprise"},
        )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_an_outsider_cannot_use_an_enterprise_view(
    test_client: AsyncClient, db_session,
):
    """No binding anywhere → not in the organisation → no enterprise reach."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_enterprise"},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_a_view_the_caller_cannot_read_grants_nothing(
    test_client: AsyncClient, db_session,
):
    """Delegation is not "name any view in the workspace"."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_private"},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_a_view_in_another_workspace_grants_nothing(
    test_client: AsyncClient, db_session,
):
    """A readable view cannot be used as a key to a workspace it isn't in —
    and the refusal is the same 403 as a non-existent view, so it doesn't
    confirm the view exists either."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        via_other = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_elsewhere"},
        )
        via_missing = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_nope"},
        )
    assert via_other.status_code == 403
    assert via_other.json() == via_missing.json()


@pytest.mark.asyncio
async def test_a_deleted_view_grants_nothing(
    test_client: AsyncClient, db_session,
):
    await _seed(db_session)
    from sqlalchemy import update
    await db_session.execute(
        update(ViewORM).where(ViewORM.id == "view_public")
        .values(deleted_at="2026-01-01T00:00:00Z")
    )
    await db_session.commit()

    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_public"},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_the_data_source_is_pinned_to_the_views_own(
    test_client: AsyncClient, db_session,
):
    """A view grants reach into ITS source, not whatever the caller names
    alongside it. Otherwise ``?viewId=<public>&dataSourceId=<secret>``
    would read a source the view never touched."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        ok = await test_client.get(TEMPLATES.format(ws=WS), params={
            "viewId": "view_public", "dataSourceId": "ds_fin",
        })
        bad = await test_client.get(TEMPLATES.format(ws=WS), params={
            "viewId": "view_public", "dataSourceId": "ds_somewhere_else",
        })
    assert ok.status_code == 200
    assert bad.status_code == 403


@pytest.mark.asyncio
async def test_narrowing_the_tier_revokes_delegation_immediately(
    test_client: AsyncClient, db_session,
):
    """Delegation is re-derived per request, not a token. Changing the
    view's tier takes effect on the very next call."""
    await _seed(db_session)
    from sqlalchemy import update

    with _as("usr_outsider", OUTSIDER):
        before = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_public"},
        )
    assert before.status_code == 200

    await db_session.execute(
        update(ViewORM).where(ViewORM.id == "view_public")
        .values(visibility="private")
    )
    await db_session.commit()

    with _as("usr_outsider", OUTSIDER):
        after = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_public"},
        )
    assert after.status_code == 403


@pytest.mark.asyncio
async def test_delegation_does_not_reach_the_mutation_surface(
    test_client: AsyncClient, db_session,
):
    """The allow-list is two read routers. The graph router — which holds
    the writes, resync, and the advanced-search ``data_source`` scope mode
    that deliberately escapes view containment — is not delegable, so a
    ``viewId`` buys nothing there."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.get(
            f"/api/v1/{WS}/graph/introspection",
            params={"viewId": "view_public"},
        )
    assert resp.status_code == 403


# ── scope confinement helpers ────────────────────────────────────────

def test_entity_types_can_only_narrow():
    """A delegate's request is intersected with the view's allow-list;
    asking for a type the view doesn't show must not add it."""
    from backend.app.api.v1.endpoints.canvas import _delegate_entity_types
    from backend.app.auth.view_delegation import ViewDelegation
    from backend.app.services.view_scope import EffectiveViewScope

    scope = EffectiveViewScope(
        view_id="v", workspace_id=WS, data_source_id="ds_fin",
        canvas_kind="graph", root_urns=("urn:a",),
        entity_type_allow_list=frozenset({"table", "column"}),
        layer_allow_list=frozenset(), max_depth=5, scope_hash="h1",
    )
    delegation = ViewDelegation(
        view_id="v", workspace_id=WS, data_source_id="ds_fin", scope=scope,
    )

    # Widening attempt is dropped.
    assert _delegate_entity_types(delegation, ["table", "secret"]) == ["table"]
    # No request → the view's own allow-list.
    assert _delegate_entity_types(delegation, None) == ["column", "table"]
    # Members are untouched.
    assert _delegate_entity_types(None, ["anything"]) == ["anything"]


def test_the_cache_key_separates_delegates_from_members():
    """A confined payload and a full one must never collide on one key."""
    from backend.app.api.v1.endpoints.canvas import _delegate_cache_params
    from backend.app.auth.view_delegation import ViewDelegation
    from backend.app.services.view_scope import EffectiveViewScope

    base = {"limit": 100}
    scope = EffectiveViewScope(
        view_id="v", workspace_id=WS, data_source_id="ds_fin",
        canvas_kind="graph", root_urns=(), entity_type_allow_list=frozenset(),
        layer_allow_list=frozenset(), max_depth=5, scope_hash="hash-abc",
    )
    delegation = ViewDelegation(
        view_id="v", workspace_id=WS, data_source_id="ds_fin", scope=scope,
    )

    assert _delegate_cache_params(None, base) == base
    delegated = _delegate_cache_params(delegation, base)
    assert delegated != base
    assert delegated["delegatedScope"] == "hash-abc"
