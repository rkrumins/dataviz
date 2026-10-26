"""The world the workspace access tests run in.

Shared by ``test_workspace_access_requests`` (asking and answering) and
``test_workspace_directory`` (Find a workspace): two workspaces — Finance,
with a steward, an admin and a member, and Operations, with nobody — an Org
Admin, and someone who belongs nowhere. Requests are made as one of them
with the claims their bindings resolve to at that moment.
"""
from __future__ import annotations

import contextlib
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.common import activity_context
from backend.app.db.models import (
    PermissionORM,
    RoleBindingORM,
    RoleORM,
    RolePermissionORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import resolve
from backend.auth_service.interface import User

WS, WS_OTHER = "ws_fin", "ws_ops"
T0 = "2024-01-01T00:00:00Z"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read",
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)
PEOPLE = {
    "ana": "usr_ana",      # belongs nowhere; asks
    "bob": "usr_bob",      # steward of Finance
    "wanda": "usr_wanda",  # admin of Finance
    "max": "usr_max",      # member of Finance — lets nobody in
    "olga": "usr_olga",    # Org Admin
}


async def seed_steward_catalogue(session: AsyncSession) -> None:
    """The shared test catalogue predates the steward: add what the
    ``20261019_1000_ws_access`` migration adds, and a Data engineer."""
    now = datetime.now(timezone.utc).isoformat()
    session.add(PermissionORM(
        id="workspace:members:add", description="Answer access requests and add people.",
        category="workspace",
    ))
    for name in ("workspace_steward", "workspace_data_engineer"):
        session.add(RoleORM(
            name=name, description=name.replace("_", " ").capitalize(), scope_type="global",
            scope_id=None, is_system=True, created_at=now, updated_at=now,
        ))
    await session.flush()
    grants = [("workspace_steward", p) for p in (*MEMBER_PERMS, "workspace:members:add")]
    grants += [("workspace_data_engineer", p) for p in (
        "workspace:datasource:manage", "workspace:datasource:read", "workspace:view:read",
    )]
    grants += [(r, "workspace:members:add") for r in ("org_admin", "super_admin")]
    session.add_all(RolePermissionORM(role_name=r, permission_id=p) for r, p in grants)
    await session.commit()


async def seed_org_reader_catalogue(session: AsyncSession) -> None:
    """The shared test catalogue predates reading every workspace: add Org
    Auditor and what ``20261026_1200_sa_org_read`` adds — Org reader — with
    their platform permissions and grants as ``rbac_seed`` has them, and
    Super Admin's ``system:org-viewer``."""
    from backend.app.config import rbac_seed

    now = datetime.now(timezone.utc).isoformat()
    roles = ("org_auditor", "org_reader")
    grants = [(r, p) for r, p in rbac_seed.ROLE_GRANTS if r in roles] + [("super_admin", "system:org-viewer")]
    session.add_all(
        PermissionORM(id=p, description=p, category="system") for p in sorted({p for _r, p in grants})
    )
    for name in roles:
        session.add(RoleORM(
            name=name, description=name.replace("_", " ").capitalize(), scope_type="global",
            scope_id=None, is_system=True, created_at=now, updated_at=now,
        ))
    await session.flush()
    session.add_all(RolePermissionORM(role_name=r, permission_id=p) for r, p in grants)
    await session.commit()


async def build_world(session: AsyncSession) -> None:
    session.add_all([WorkspaceORM(id=WS, name="Finance"), WorkspaceORM(id=WS_OTHER, name="Operations")])
    for name, uid in PEOPLE.items():
        session.add(UserORM(
            id=uid, email=f"{name}@example.com", password_hash="x", first_name=name.title(),
            last_name="T", status="active", created_at=T0, updated_at=T0,
        ))
    for uid, role, ws in (
        ("usr_bob", "workspace_steward", WS),
        ("usr_wanda", "workspace_admin", WS),
        ("usr_max", "workspace_member", WS),
        ("usr_olga", "org_admin", None),
    ):
        session.add(RoleBindingORM(
            subject_type="user", subject_id=uid, role_name=role,
            scope_type="workspace" if ws else "global", scope_id=ws,
        ))
    await session.commit()


@contextlib.asynccontextmanager
async def acting_as(session: AsyncSession, name: str):
    """Make the test client's requests ``name``'s, with the claims their
    bindings resolve to now."""
    from backend.app.main import app

    uid = PEOPLE[name]
    claims = await resolve(session, uid)
    user = User(
        id=uid, email=f"{name}@example.com", first_name=name.title(), last_name="T",
        role="user", status="active", created_at=T0, updated_at=T0,
    )

    async def _current():
        activity_context.bind_actor(uid)
        return user

    prev = {dep: app.dependency_overrides.get(dep) for dep in (get_current_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        app.dependency_overrides.update(prev)


def directory(on: bool = True) -> None:
    """Find a workspace on or off, through the cache a gate reads."""
    feature_flags._cache = {**(feature_flags._cache or {}), "workspaceDirectoryEnabled": on}
    feature_flags._cache_ts = time.monotonic()


def days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def in_days(days: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


async def notes(session: AsyncSession, kind: str) -> list:
    """The Inbox rows of one kind, by recipient."""
    from sqlalchemy import select

    from backend.app.db.models import NotificationORM

    return list((await session.execute(
        select(NotificationORM).where(NotificationORM.kind == kind).order_by(NotificationORM.user_id)
    )).scalars().all())


async def events(session: AsyncSession, event_type: str) -> list[dict]:
    """The outbox payloads of one event type."""
    import json

    from sqlalchemy import select

    from backend.app.db.models import OutboxEventORM

    rows = (await session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == event_type)
    )).scalars().all()
    return [json.loads(r.payload) if isinstance(r.payload, str) else r.payload for r in rows]
