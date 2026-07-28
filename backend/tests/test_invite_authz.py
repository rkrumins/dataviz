"""Phase 15 — who may create an invite, and what they may put in it.

Inviting used to be ``require_admin`` (``system:admin`` only), which is
too narrow: a workspace admin is the person who actually knows who
should join their workspace. Widening that is only safe under one rule
— **you cannot grant what you do not hold** — so these tests are about
the ceiling, not the happy path.

The conftest client is a platform admin. Each test here swaps the
claims override for a narrower principal.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.models import GroupORM, RoleORM, RolePermissionORM, WorkspaceORM
from backend.app.main import app
from backend.app.services.permission_service import (
    _WORKSPACE_CATEGORY_LEAVES,
    PermissionClaims,
)
from backend.auth_service.interface import User

WS_ADMIN_ID = "usr_wsadmin0001"


@pytest.fixture
def as_workspace_admin():
    """Re-bind identity AND claims to a workspace admin of ``ws_own``.

    The claims are built the way ``resolve()`` builds them — expanding
    ``workspace:admin`` into ``_WORKSPACE_CATEGORY_LEAVES`` — because
    that is what a real JWT carries. Hand-writing a bare
    ``("workspace:admin",)`` would test a principal the system never
    actually produces, and would fail the ceiling for ordinary
    workspace roles that a workspace admin legitimately holds.

    A DISTINCT user id matters too: ``created_by`` is the ownership
    boundary for listing and revoking, so sharing the platform admin's
    id would quietly make those checks untestable.
    """
    def _apply(workspace_id: str = "ws_own"):
        def _override_claims():
            return PermissionClaims(
                sid="sess_ws_admin",
                global_perms=(),
                ws_perms={workspace_id: tuple(sorted(_WORKSPACE_CATEGORY_LEAVES))},
            )

        async def _override_user():
            return User(
                id=WS_ADMIN_ID, email="wsadmin@example.com",
                first_name="Ws", last_name="Admin", role="user",
                status="active", auth_provider="local",
                created_at="2024-01-01T00:00:00Z",
                updated_at="2024-01-01T00:00:00Z",
            )

        app.dependency_overrides[get_permission_claims] = _override_claims
        app.dependency_overrides[get_current_user] = _override_user

    prev_claims = app.dependency_overrides.get(get_permission_claims)
    prev_user = app.dependency_overrides.get(get_current_user)
    yield _apply
    for dep, prev in ((get_permission_claims, prev_claims), (get_current_user, prev_user)):
        if prev is not None:
            app.dependency_overrides[dep] = prev
        else:
            app.dependency_overrides.pop(dep, None)


async def _seed(db_session):
    db_session.add(WorkspaceORM(id="ws_own", name="Mine"))
    db_session.add(WorkspaceORM(id="ws_other", name="Theirs"))
    await db_session.commit()


async def _mint(test_client, **body):
    return await test_client.post("/api/v1/admin/users/invite", json=body)


# ── what a workspace admin CAN do ────────────────────────────────────


@pytest.mark.asyncio
async def test_workspace_admin_can_invite_into_their_own_workspace(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    await _seed(db_session)
    as_workspace_admin()

    r = await _mint(test_client, role="workspace_member", workspaceId="ws_own")
    assert r.status_code == 201, r.text
    assert r.json()["workspaceId"] == "ws_own"


@pytest.mark.asyncio
async def test_workspace_admin_can_cap_and_scope_their_link(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    await _seed(db_session)
    as_workspace_admin()

    r = await _mint(
        test_client, role="workspace_viewer", workspaceId="ws_own",
        maxUses=5, emailDomain="company.com",
    )
    assert r.status_code == 201, r.text
    assert r.json()["maxUses"] == 5
    assert r.json()["emailDomain"] == "company.com"


# ── what a workspace admin CANNOT do ─────────────────────────────────


@pytest.mark.asyncio
async def test_cannot_invite_into_a_workspace_they_do_not_administer(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    await _seed(db_session)
    as_workspace_admin()

    r = await _mint(test_client, role="workspace_member", workspaceId="ws_other")
    assert r.status_code == 403
    assert "not an administrator" in r.json()["detail"]


@pytest.mark.asyncio
async def test_cannot_invite_a_privileged_role(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """workspace_admin carries ``workspace:admin`` — the permission that
    lets an account grant further access. Minting one from a lesser
    account would make the ceiling self-defeating."""
    await _seed(db_session)
    as_workspace_admin()

    r = await _mint(
        test_client, role="workspace_admin", workspaceId="ws_own",
        email="new-admin@example.com",
    )
    assert r.status_code == 403
    assert "administrative permissions" in r.json()["detail"]


@pytest.mark.asyncio
async def test_cannot_invite_a_global_role(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    await _seed(db_session)
    as_workspace_admin()

    r = await _mint(test_client, role="org_admin", email="boss@example.com")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_cannot_create_an_organisation_wide_invite(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """A role-less invite creates an activated account with no scope at
    all. That is an organisation-level act, not a workspace one."""
    await _seed(db_session)
    as_workspace_admin()

    r = await _mint(test_client)
    assert r.status_code == 403
    assert "platform administrator" in r.json()["detail"]


@pytest.mark.asyncio
async def test_cannot_attach_groups(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """Groups are global: membership carries into every workspace the
    group is bound into. A workspace admin has no authority out there,
    and the schema has no notion of who owns a group."""
    await _seed(db_session)
    db_session.add(GroupORM(id="grp_global", name="Everyone"))
    await db_session.commit()
    as_workspace_admin()

    r = await _mint(
        test_client, role="workspace_member", workspaceId="ws_own",
        groupIds=["grp_global"], allowShareableWithGroups=True,
    )
    assert r.status_code == 403
    assert "organisation-wide" in r.json()["detail"]


@pytest.mark.asyncio
async def test_a_system_role_is_stopped_by_the_privileged_rule_first(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """A custom workspace role bundling a ``system:*`` permission is
    classified privileged, so it is refused for want of an email pin
    before the ceiling is even consulted. Two independent guards; this
    pins which one fires."""
    from datetime import datetime, timezone

    await _seed(db_session)
    now = datetime.now(timezone.utc).isoformat()
    db_session.add(RoleORM(
        name="ws_sneaky", description="looks harmless",
        scope_type="workspace", scope_id="ws_own",
        is_system=False, created_at=now, updated_at=now, created_by=None,
    ))
    db_session.add(RolePermissionORM(
        role_name="ws_sneaky", permission_id="system:users:manage",
    ))
    await db_session.commit()
    as_workspace_admin()

    r = await _mint(test_client, role="ws_sneaky", workspaceId="ws_own")
    assert r.status_code == 400
    assert "privileged" in r.json()["detail"]

    # With the email pin supplied, the privileged rule is satisfied and
    # the ceiling is what refuses it.
    r = await _mint(
        test_client, role="ws_sneaky", workspaceId="ws_own",
        email="target@example.com",
    )
    assert r.status_code == 403
    assert "administrative permissions" in r.json()["detail"]


@pytest.mark.asyncio
async def test_the_ceiling_catches_a_permission_the_admin_leaf_set_does_not_cover(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """The ceiling proper, and the drift it exists for.

    ``workspace:admin`` implies the leaves in
    ``_WORKSPACE_CATEGORY_LEAVES`` — a fixed set. A ``workspace:*``
    permission added to the catalogue but not to that set is one a
    workspace admin does NOT hold, and it is neither ``workspace:admin``
    nor ``system:*``, so the privileged rule waves it through. Without
    the ceiling, a custom role would launder it to an invitee.
    """
    from datetime import datetime, timezone
    from backend.app.db.models import PermissionORM

    await _seed(db_session)
    now = datetime.now(timezone.utc).isoformat()
    db_session.add(PermissionORM(
        id="workspace:billing:manage",
        description="Newer permission, not in the admin leaf set",
        category="workspace",
    ))
    db_session.add(RoleORM(
        name="ws_billing", description="custom",
        scope_type="workspace", scope_id="ws_own",
        is_system=False, created_at=now, updated_at=now, created_by=None,
    ))
    db_session.add(RolePermissionORM(
        role_name="ws_billing", permission_id="workspace:billing:manage",
    ))
    await db_session.commit()
    as_workspace_admin()

    r = await _mint(test_client, role="ws_billing", workspaceId="ws_own")
    assert r.status_code == 403
    assert "which you do not have" in r.json()["detail"]


# ── the list is scoped by creator ────────────────────────────────────


@pytest.mark.asyncio
async def test_a_non_platform_admin_only_sees_their_own_links(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """Widening who can invite must not also widen who can see every
    outstanding invitation in the organisation."""
    await _seed(db_session)

    # Minted by the platform admin the conftest client impersonates.
    someone_elses = (await _mint(test_client)).json()["inviteId"]

    as_workspace_admin()
    mine = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_own",
    )).json()["inviteId"]

    listed = await test_client.get("/api/v1/admin/users/invites?status=all")
    assert listed.status_code == 200
    ids = {i["id"] for i in listed.json()}
    assert mine in ids
    assert someone_elses not in ids


@pytest.mark.asyncio
async def test_cannot_revoke_or_inspect_someone_elses_link(
    test_client: AsyncClient, db_session, as_workspace_admin,
):
    """404, not 403: a caller who may not act on a link should not learn
    that it exists."""
    await _seed(db_session)
    theirs = (await _mint(test_client)).json()["inviteId"]

    as_workspace_admin()
    assert (await test_client.post(
        f"/api/v1/admin/users/invites/{theirs}/revoke")).status_code == 404
    assert (await test_client.get(
        f"/api/v1/admin/users/invites/{theirs}/redemptions")).status_code == 404


# ── platform admins keep full reach ──────────────────────────────────


@pytest.mark.asyncio
async def test_platform_admin_is_unaffected(test_client: AsyncClient, db_session):
    await _seed(db_session)
    db_session.add(GroupORM(id="grp_ok", name="Fine"))
    await db_session.commit()

    assert (await _mint(test_client)).status_code == 201
    assert (await _mint(
        test_client, role="workspace_admin", workspaceId="ws_other",
        email="admin@example.com",
    )).status_code == 201
    assert (await _mint(
        test_client, groupIds=["grp_ok"], allowShareableWithGroups=True,
    )).status_code == 201
