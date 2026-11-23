"""The world the conversations tests run in.

Finance (``ws_fin``) and Ops (``ws_ops``), and the people who matter, each holding only
what their role bindings give them (claims are resolved from the bindings, as at sign-in):

* Ada — a Viewer in Finance;  Ben — a Member there, who made its views and its source;
* Walt — Finance's Workspace Admin;  Olga — an Org Admin;  Sam — a Super Admin;
* Oscar — an org-wide reader (``system:org-viewer``);
* Eve — a Viewer in Ops only;  Gil — in the Finance viewers group (bound as Viewer);
* Xena — her Viewer binding in Finance expired;  Cal — a Viewer, but suspended;
* Gina — an editor grant on the private view;  Rita — in a group with a viewer grant on it;
* a service account bound as a Member in Finance.

Views in Finance on the General ledger source: private, workspace and enterprise tiers.
"""
from __future__ import annotations

import contextlib
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    NotificationORM,
    OutboxEventORM,
    PermissionORM,
    ResourceGrantORM,
    RoleBindingORM,
    RoleORM,
    RolePermissionORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services import permission_service
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

WS, OPS = "ws_fin", "ws_ops"
DS, DS_OPS = "ds_fin", "ds_ops"
V_PRIV, V_WS, V_ENT = "view_priv", "view_ws", "view_ent"
T0 = "2026-11-20T00:00:00+00:00"
PAST = "2026-01-01T00:00:00+00:00"
FLAG = "conversationsEnabled"

ADA, BEN, WALT, OLGA, SAM, OSCAR, EVE, GIL, XENA, CAL, GINA, RITA = (
    "usr_ada", "usr_ben", "usr_walt", "usr_olga", "usr_sam", "usr_oscar", "usr_eve", "usr_gil",
    "usr_xena", "usr_cal", "usr_gina", "usr_rita",
)
BOT = "svc_finbot0000"
PEOPLE = (ADA, BEN, WALT, OLGA, SAM, OSCAR, EVE, GIL, XENA, CAL, GINA, RITA)
G_VIEWERS, G_READERS = "grp_fin_viewers", "grp_readers"


def user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid.split("_", 1)[1].title(), last_name="T",
                role="user", status="active", created_at=T0, updated_at=T0)


def add_user(session: AsyncSession, uid: str, *, status: str = "active", deleted: bool = False) -> None:
    session.add(UserORM(id=uid, email=f"{uid}@example.com", password_hash="x",
                        first_name=uid.split("_", 1)[1].title(), last_name="T", status=status,
                        created_at=T0, updated_at=T0, deleted_at=T0 if deleted else None))


def bind(uid: str, role: str, ws: str | None = None, *, subject_type: str = "user", expires_at=None):
    return RoleBindingORM(subject_type=subject_type, subject_id=uid, role_name=role,
                          scope_type="workspace" if ws else "global", scope_id=ws, expires_at=expires_at)


async def seed(session: AsyncSession) -> None:
    for uid in PEOPLE:
        add_user(session, uid, status="suspended" if uid == CAL else "active")
    add_user(session, BOT)
    session.add_all([WorkspaceORM(id=WS, name="Finance"), WorkspaceORM(id=OPS, name="Ops")])
    # An org-wide reader: the role the platform ships as org_reader.
    session.add(PermissionORM(id="system:org-viewer", description="Read every workspace.", category="system"))
    session.add(RoleORM(name="org_reader", description="Reads every workspace.", scope_type="global",
                        is_system=True, created_at=T0, updated_at=T0))
    await session.flush()
    session.add(RolePermissionORM(role_name="org_reader", permission_id="system:org-viewer"))
    session.add_all([
        GroupORM(id=G_VIEWERS, name="Finance viewers"), GroupORM(id=G_READERS, name="Ledger readers"),
    ])
    await session.flush()
    session.add_all([
        GroupMemberORM(group_id=G_VIEWERS, user_id=GIL), GroupMemberORM(group_id=G_READERS, user_id=RITA),
        bind(ADA, "workspace_viewer", WS), bind(BEN, "workspace_member", WS), bind(WALT, "workspace_admin", WS),
        bind(OLGA, "org_admin"), bind(SAM, "super_admin"), bind(OSCAR, "org_reader"),
        bind(EVE, "workspace_viewer", OPS), bind(G_VIEWERS, "workspace_viewer", WS, subject_type="group"),
        bind(XENA, "workspace_viewer", WS, expires_at=PAST), bind(CAL, "workspace_viewer", WS),
        bind(BOT, "workspace_member", WS),
        WorkspaceDataSourceORM(id=DS, workspace_id=WS, provider_id="prov", graph_name="ledger",
                               label="General ledger", created_by=BEN, created_at=T0, updated_at=T0),
        WorkspaceDataSourceORM(id=DS_OPS, workspace_id=OPS, provider_id="prov", graph_name="ops",
                               label="Ops graph", created_by=EVE, created_at=T0, updated_at=T0),
    ])
    await session.flush()
    for vid, tier in ((V_PRIV, "private"), (V_WS, "workspace"), (V_ENT, "enterprise")):
        session.add(ViewORM(id=vid, name=f"{tier.title()} ledger", workspace_id=WS, data_source_id=DS,
                            visibility=tier, created_by=BEN))
    await session.flush()
    session.add_all([
        ResourceGrantORM(resource_type="view", resource_id=V_PRIV, subject_type="user", subject_id=GINA,
                         role_name="editor"),
        ResourceGrantORM(resource_type="view", resource_id=V_PRIV, subject_type="group", subject_id=G_READERS,
                         role_name="viewer"),
    ])
    await session.commit()


async def claims_for(session: AsyncSession, uid: str) -> PermissionClaims:
    """What signing in would give them."""
    return await permission_service.resolve(session, uid, sid=f"s_{uid}")


@contextlib.contextmanager
def acting(who: User | str, claims: PermissionClaims):
    from backend.app.main import app

    person = user(who) if isinstance(who, str) else who

    async def _u():
        return person

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


def switch(on: bool) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), FLAG: on}
    feature_flags._cache_ts = time.monotonic()


async def notifications(session: AsyncSession, uid: str, kind: str | None = None) -> list[NotificationORM]:
    stmt = select(NotificationORM).where(NotificationORM.user_id == uid).execution_options(populate_existing=True)
    if kind:
        stmt = stmt.where(NotificationORM.kind == kind)
    return list((await session.execute(stmt.order_by(NotificationORM.created_at))).scalars().all())


async def events(session: AsyncSession, prefix: str) -> list[OutboxEventORM]:
    return list((await session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like(f"{prefix}%")).order_by(OutboxEventORM.id)
    )).scalars().all())


class Counted:
    """A metrics backend keeping how far each counter was bumped, whatever its labels."""

    def __init__(self):
        self.counts: dict[str, float] = {}

    def increment(self, name, labels, value=1.0):
        self.counts[name] = self.counts.get(name, 0) + value

    def observe(self, name, labels, value):
        pass

    def gauge_set(self, name, labels, value):
        pass

    def gauge_inc(self, name, labels, value=1.0):
        pass

    def gauge_dec(self, name, labels, value=1.0):
        pass
