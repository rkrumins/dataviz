"""What an API key may reach: its owner's live authority ∩ its profile ∩ its
selection — on every resource, by every path.

The paths matter as much as the permissions. A person can hold a view
through a workspace role, through an explicit grant, by having created it,
or because it is published to everyone; a key must honour each of those —
the workspace viewer with an editor grant on one view can mint a key that
edits exactly that view — and must never use them to reach past what it was
limited to.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.db.models import (
    PermissionORM,
    RoleBindingORM,
    RoleORM,
    RolePermissionORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import grant_repo
from backend.app.services import view_access
from backend.app.services.permission_service import (
    KEY_GRANTABLE_PERMISSIONS,
    has_permission,
    has_permission_any_workspace,
    key_scope_from_profile,
    resolve_for_api_key,
)

OWNER = "usr_keyowner"


# ── Seed helpers ────────────────────────────────────────────────────


async def _world(session):
    """Three workspaces, a data source in each of the first two, and views
    with every kind of reach the owner can have."""
    session.add(UserORM(
        id=OWNER, email="owner@example.com", password_hash="x-disabled-password-x",
        first_name="Key", last_name="Owner", status="active",
    ))
    for ws in ("ws_a", "ws_b", "ws_c"):
        session.add(WorkspaceORM(id=ws, name=ws))
    session.add(WorkspaceDataSourceORM(id="ds_a", workspace_id="ws_a", provider_id="prov"))
    session.add(WorkspaceDataSourceORM(id="ds_b", workspace_id="ws_b", provider_id="prov"))
    views = [
        ("v_a_ws", "ws_a", "workspace", "usr_other"),      # reached by role in ws_a
        ("v_a_mine", "ws_a", "private", OWNER),            # reached by creatorship
        ("v_b_granted", "ws_b", "private", "usr_other"),   # reached by an editor grant
        ("v_b_other", "ws_b", "workspace", "usr_other"),   # reached by role in ws_b
        ("v_c_public", "ws_c", "enterprise", "usr_other"), # reached by the enterprise tier
    ]
    for vid, ws, visibility, creator in views:
        session.add(ViewORM(
            id=vid, name=vid, workspace_id=ws, visibility=visibility, created_by=creator,
        ))
    # The owner: a member in ws_a, only a viewer in ws_b — plus an editor
    # grant on one private view there.
    session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="workspace_member",
        scope_type="workspace", scope_id="ws_a",
    ))
    session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_b",
    ))
    await session.flush()
    await grant_repo.create_grant(
        session, resource_type="view", resource_id="v_b_granted",
        subject_type="user", subject_id=OWNER, role_name="editor",
    )
    await session.commit()


async def _claims(session, *, views="none", data="none", publish=False, resources="all"):
    scope = key_scope_from_profile(
        "apk_test", kind="personal",
        permissions={"views": views, "data": data, "publish": publish},
        resources=resources,
    )
    return await resolve_for_api_key(session, OWNER, scope)


async def _ctx(session, claims):
    user = type("U", (), {"id": OWNER})()
    return await view_access.ViewerContext.build(session, user=user, claims=claims)


async def _view(session, vid):
    return (await session.execute(select(ViewORM).where(ViewORM.id == vid))).scalar_one()


async def _readable_ids(session, claims) -> set[str]:
    ctx = await _ctx(session, claims)
    scope = await view_access.build_read_scope(session, ctx)
    rows = (await session.execute(
        select(ViewORM.id).where(view_access.readable_views_clause(scope))
    )).scalars().all()
    return set(rows)


# ── Profile parsing ────────────────────────────────────────────────


def test_a_malformed_profile_narrows_never_widens():
    scope = key_scope_from_profile(
        "apk_x", kind="personal",
        permissions={"views": "admin", "data": 7, "publish": True},
        resources={"workspaces": "ws_a"},          # a string, not a list
    )
    assert scope.permissions == frozenset()
    assert not scope.publish
    assert not scope.all_resources and not scope.workspaces


def test_publish_needs_write_and_nothing_administrative_is_grantable():
    scope = key_scope_from_profile(
        "apk_x", kind="personal",
        permissions={"views": "read", "data": "none", "publish": True}, resources="all",
    )
    assert not scope.publish and scope.read_only
    assert not any(p.startswith("system:") or p == "workspace:admin"
                   for p in KEY_GRANTABLE_PERMISSIONS)


# ── Materialization ────────────────────────────────────────────────


async def test_claims_are_the_owners_authority_narrowed_to_the_profile(db_session):
    await _world(db_session)
    claims = await _claims(db_session, views="read", data="read")
    assert claims.global_perms == ()
    assert set(claims.ws_perms) == {"ws_a", "ws_b"}
    assert has_permission(claims, "workspace:view:read", workspace_id="ws_a")
    assert has_permission(claims, "workspace:datasource:read", workspace_id="ws_b")
    # The owner can edit in ws_a; a read key cannot.
    assert not has_permission(claims, "workspace:view:edit", workspace_id="ws_a")
    assert not has_permission(claims, "workspace:datasource:manage", workspace_id="ws_a")


async def test_a_write_profile_never_exceeds_the_owner(db_session):
    await _world(db_session)
    claims = await _claims(db_session, views="write", data="write")
    assert has_permission(claims, "workspace:view:edit", workspace_id="ws_a")
    # Only a viewer in ws_b: the write profile does not lift that.
    assert not has_permission(claims, "workspace:view:edit", workspace_id="ws_b")
    assert not has_permission(claims, "workspace:datasource:manage", workspace_id="ws_b")


async def test_a_workspace_selection_drops_every_other_workspace(db_session):
    await _world(db_session)
    claims = await _claims(db_session, views="read", data="read",
                           resources={"workspaces": ["ws_a"]})
    assert set(claims.ws_perms) == {"ws_a"}
    assert has_permission_any_workspace(claims, "workspace:view:read")
    assert not has_permission(claims, "workspace:view:read", workspace_id="ws_b")


async def test_a_view_selection_does_not_read_the_data_sources_beside_it(db_session):
    await _world(db_session)
    claims = await _claims(db_session, views="read", data="read",
                           resources={"views": ["v_b_other"]})
    assert has_permission(claims, "workspace:view:read", workspace_id="ws_b")
    assert not has_permission(claims, "workspace:datasource:read", workspace_id="ws_b")
    assert claims.key_scope.view_workspaces == {"v_b_other": "ws_b"}


async def test_a_data_source_selection_reaches_data_not_views(db_session):
    await _world(db_session)
    claims = await _claims(db_session, views="read", data="read",
                           resources={"dataSources": ["ds_a"]})
    assert has_permission(claims, "workspace:datasource:read", workspace_id="ws_a")
    assert not has_permission(claims, "workspace:view:read", workspace_id="ws_a")
    assert claims.key_scope.selects_data_source("ds_a", "ws_a")
    assert not claims.key_scope.selects_data_source("ds_b", "ws_b")


async def test_a_deleted_selected_view_admits_nothing(db_session):
    await _world(db_session)
    (await _view(db_session, "v_b_other")).deleted_at = "2026-01-01T00:00:00+00:00"
    await db_session.commit()
    claims = await _claims(db_session, views="read", resources={"views": ["v_b_other"]})
    assert claims.ws_perms == {}
    assert not claims.key_scope.selects_view("v_b_other", "ws_b")


async def test_an_org_level_owner_reaches_every_workspace_without_any_shortcut(db_session):
    await _world(db_session)
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="super_admin",
        scope_type="global", scope_id=None,
    ))
    await db_session.commit()
    claims = await _claims(db_session, views="write", data="write")
    assert claims.global_perms == ()
    assert set(claims.ws_perms) == {"ws_a", "ws_b", "ws_c"}
    assert claims.key_scope.org_wide
    # No administration through a key, however powerful its owner.
    assert not has_permission(claims, "system:admin")
    assert not has_permission(claims, "workspace:admin", workspace_id="ws_c")
    assert not has_permission_any_workspace(claims, "system:org-admin")


async def test_an_org_viewer_owner_gives_a_write_key_only_reads(db_session):
    await _world(db_session)
    db_session.add(PermissionORM(id="system:org-viewer", description="", category="system"))
    db_session.add(RoleORM(name="org_auditor", description="", scope_type="global",
                           scope_id=None, is_system=True,
                           created_at="2026-01-01", updated_at="2026-01-01"))
    db_session.add(RolePermissionORM(role_name="org_auditor", permission_id="system:org-viewer"))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="org_auditor",
        scope_type="global", scope_id=None,
    ))
    await db_session.commit()
    claims = await _claims(db_session, views="write")
    assert has_permission(claims, "workspace:view:read", workspace_id="ws_c")
    assert not has_permission(claims, "workspace:view:edit", workspace_id="ws_c")


# ── Identity paths, honoured and scoped ────────────────────────────


async def test_a_view_grant_lets_a_scoped_key_edit_exactly_that_view(db_session):
    """The user's own case: a workspace viewer with an editor grant on one
    view mints a key limited to that view, and it can edit it — and nothing
    else in the workspace."""
    await _world(db_session)
    claims = await _claims(db_session, views="write", resources={"views": ["v_b_granted"]})
    ctx = await _ctx(db_session, claims)
    granted = await _view(db_session, "v_b_granted")
    sibling = await _view(db_session, "v_b_other")
    assert await view_access.can_read_view(db_session, ctx, granted)
    assert await view_access.can_edit_view(db_session, ctx, granted)
    assert not await view_access.can_read_view(db_session, ctx, sibling)
    assert not await view_access.can_edit_view(db_session, ctx, sibling)
    assert await _readable_ids(db_session, claims) == {"v_b_granted"}


async def test_a_read_key_cannot_edit_even_the_owners_own_view(db_session):
    await _world(db_session)
    claims = await _claims(db_session, views="read")
    ctx = await _ctx(db_session, claims)
    mine = await _view(db_session, "v_a_mine")
    assert await view_access.can_read_view(db_session, ctx, mine)
    assert not await view_access.can_edit_view(db_session, ctx, mine)
    assert not view_access.can_delete_view(ctx, mine)


async def test_the_enterprise_tier_does_not_reach_past_a_selection(db_session):
    await _world(db_session)
    public = await _view(db_session, "v_c_public")

    everything = await _claims(db_session, views="read")
    assert await view_access.can_read_view(
        db_session, await _ctx(db_session, everything), public,
    )
    assert "v_c_public" in await _readable_ids(db_session, everything)

    only_a = await _claims(db_session, views="read", resources={"workspaces": ["ws_a"]})
    assert not await view_access.can_read_view(
        db_session, await _ctx(db_session, only_a), public,
    )
    assert await _readable_ids(db_session, only_a) == {"v_a_ws", "v_a_mine"}


async def test_a_key_without_views_lists_none(db_session):
    await _world(db_session)
    claims = await _claims(db_session, data="read")
    assert await _readable_ids(db_session, claims) == set()


async def test_sharing_and_visibility_need_more_than_edit(db_session):
    await _world(db_session)
    mine = await _view(db_session, "v_a_mine")
    edit = await _ctx(db_session, await _claims(db_session, views="write"))
    assert not view_access.can_change_visibility(edit, mine)
    assert not view_access.can_manage_grants(edit, mine)

    publish = await _ctx(db_session, await _claims(db_session, views="write", publish=True))
    assert view_access.can_change_visibility(publish, mine)
    # Sharing with other people is never something a key does.
    assert not view_access.can_manage_grants(publish, mine)


async def test_a_browser_session_takes_exactly_todays_path(db_session):
    await _world(db_session)
    from backend.app.services.permission_service import resolve

    claims = await resolve(db_session, OWNER)
    assert claims.key_scope is None
    ctx = await _ctx(db_session, claims)
    assert view_access.can_manage_grants(ctx, await _view(db_session, "v_a_mine"))
    assert await _readable_ids(db_session, claims) == {
        "v_a_ws", "v_a_mine", "v_b_granted", "v_b_other", "v_c_public",
    }


# ── Creating views ──────────────────────────────────────────────────


async def test_creating_a_view_needs_the_whole_workspace_and_publish_for_enterprise(db_session):
    from backend.app.api.v1.endpoints.views import authorize_view_create

    await _world(db_session)
    scoped = await _claims(db_session, views="write", resources={"views": ["v_a_ws"]})
    with pytest.raises(HTTPException) as refused:
        await authorize_view_create(
            scoped, db_session, workspace_id="ws_a", data_source_id=None,
            visibility="private",
        )
    assert refused.value.status_code == 403
    assert refused.value.detail["error"] == "api_key_out_of_scope"

    whole = await _claims(db_session, views="write", resources={"workspaces": ["ws_a"]})
    await authorize_view_create(
        whole, db_session, workspace_id="ws_a", data_source_id=None, visibility="private",
    )
    with pytest.raises(HTTPException) as no_publish:
        await authorize_view_create(
            whole, db_session, workspace_id="ws_a", data_source_id=None,
            visibility="enterprise",
        )
    assert no_publish.value.detail["error"] == "api_key_cannot_publish"
