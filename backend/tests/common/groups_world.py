"""The world the workspace-group and identity-provider-link tests run in.

Two workspaces — Lab, and Other — and the people who matter: Ada, Lab's admin; Stu, its
steward (sees its members, adds people one by one); Max, a member of Lab; Ben and Dee,
people to put in groups; Cal, suspended; Root, a Super Admin (the only one who links a
group to the identity provider). A platform group, Finance readers, is bound in Lab as
viewers — Lab doesn't own it. Ben's last sign-in asserted the identity-provider groups
ML-Engineers and Finance-All; Dee's connection asserted ML-Engineers and HR-Secret; Gus,
deleted, had ML-Engineers too.

Requests are made as one of them (``acting``) with the claims their bindings would give.
"""
from __future__ import annotations

import contextlib
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (
    GroupORM,
    IdpProviderORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    UserIdentityORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

WS, OTHER = "ws_lab", "ws_other"
T0 = "2026-11-20T00:00:00+00:00"
PLATFORM_GROUP = "grp_finance"
PROVIDER = "idp_corp"
WORKSPACE_PERMS = (
    "workspace:admin", "workspace:members:add", "workspace:catalog:read", "workspace:datasource:manage",
    "workspace:datasource:publish", "workspace:datasource:read", "workspace:native-query:read",
    "workspace:ontology:read", "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)
STEWARD_PERMS = (
    "workspace:members:add", "workspace:datasource:read", "workspace:view:read", "workspace:view:edit",
)
MEMBER_PERMS = ("workspace:datasource:read", "workspace:view:read", "workspace:view:edit")


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid[4:].title(), last_name="T",
                role="user", status="active", created_at=T0, updated_at=T0)


ADA, STU, MAX, BEN, DEE, CAL, ROOT, GUS = (
    _user(u) for u in ("usr_ada", "usr_stu", "usr_max", "usr_ben", "usr_dee", "usr_cal", "usr_root", "usr_gus")
)
CLAIMS = {
    ADA.id: PermissionClaims(sid="s_ada", ws_perms={WS: WORKSPACE_PERMS}),
    STU.id: PermissionClaims(sid="s_stu", ws_perms={WS: STEWARD_PERMS}),
    MAX.id: PermissionClaims(sid="s_max", ws_perms={WS: MEMBER_PERMS}),
    BEN.id: PermissionClaims(sid="s_ben", ws_perms={}),
    DEE.id: PermissionClaims(sid="s_dee", ws_perms={}),
    ROOT.id: PermissionClaims(sid="s_root", global_perms=("system:admin",), ws_perms={}),
}


@contextlib.contextmanager
def acting(user: User):
    from backend.app.main import app

    async def _u():
        return user

    deps = (get_current_user, get_optional_user, get_permission_claims)
    saved = {k: app.dependency_overrides.get(k) for k in deps}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: CLAIMS[user.id]
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


async def build_world(session: AsyncSession) -> None:
    for user, state in ((ADA, "active"), (STU, "active"), (MAX, "active"), (BEN, "active"), (DEE, "active"),
                        (CAL, "suspended"), (ROOT, "active"), (GUS, "active")):
        session.add(UserORM(
            id=user.id, email=user.email, password_hash="x", first_name=user.first_name, last_name="T",
            status=state, created_at=T0, updated_at=T0, deleted_at=T0 if user is GUS else None,
            metadata_=json.dumps({"idp_groups": ["ML-Engineers", "Finance-All"]}) if user is BEN
            else json.dumps({"idp_groups": ["ML-Engineers"]}) if user is GUS else None,
        ))
    session.add_all([
        WorkspaceORM(id=WS, name="Lab"),
        WorkspaceORM(id=OTHER, name="Other"),
        IdpProviderORM(id=PROVIDER, slug="corp", display_name="Corporate SSO", kind="oidc"),
        GroupORM(id=PLATFORM_GROUP, name="Finance readers"),
    ])
    await session.flush()
    session.add_all([
        UserIdentityORM(user_id=DEE.id, provider_id=PROVIDER, external_id="dee-sub",
                        metadata_=json.dumps({"groups": ["ML-Engineers", "HR-Secret"], "attributes": {}})),
        RoleBindingORM(subject_type="user", subject_id=ROOT.id, role_name="super_admin", scope_type="global"),
        RoleBindingORM(subject_type="user", subject_id=ADA.id, role_name="workspace_admin",
                       scope_type="workspace", scope_id=WS),
        RoleBindingORM(subject_type="group", subject_id=PLATFORM_GROUP, role_name="workspace_viewer",
                       scope_type="workspace", scope_id=WS),
    ])
    await session.commit()


async def kinds(session: AsyncSession, user_id: str) -> dict[str, str]:
    rows = (await session.execute(
        select(NotificationORM).where(NotificationORM.user_id == user_id).execution_options(populate_existing=True)
    )).scalars().all()
    return {n.kind: n.link for n in rows}


async def events(session: AsyncSession, prefix: str) -> list[tuple[str, dict]]:
    rows = (await session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like(f"{prefix}%"))
    )).scalars().all()
    return [(e.event_type, json.loads(e.payload)) for e in rows]
