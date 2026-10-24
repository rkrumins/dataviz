"""The world the data-source transfer tests run in.

Three workspaces — Finance (where the source lives), Risk and Ops — and the people who matter
to a move: an admin of each side, an admin of both, a member and a viewer of Finance, a team
bound in Finance as viewers, a viewer of Risk and an Org Admin. Finance's primary source,
Orders, carries a view of every kind: private, shared with the workspace, shared with someone,
published, in the trash and waiting to be published — plus a view with no source of its own,
which reads Orders as Finance's default. A second source, Ledger, has nothing on it.

Requests are made as one of them, with the claims their bindings resolve to at that moment.
The version store is faked (it runs on Postgres only): ``version_store`` records relocations
and answers with whatever facts a test sets.
"""
from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.common import activity_context
from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    ProviderORM,
    ResourceGrantORM,
    RoleBindingORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import resolve
from backend.app.services.versioning import lifecycle, purge_worker
from backend.auth_service.interface import User

A, B, C = "ws_fin", "ws_risk", "ws_ops"
DS, DS2 = "ds_orders", "ds_ledger"
TEAM = "grp_analysts"
PROVIDER = "prov_falkor"
T0 = "2024-01-01T00:00:00+00:00"
T1 = "2024-02-01T00:00:00+00:00"

PEOPLE = {
    "ada": "usr_ada",      # admin of Finance only
    "bea": "usr_bea",      # admin of Risk only
    "cy": "usr_cy",        # admin of Finance and Risk
    "max": "usr_max",      # member of Finance; made the views
    "mia": "usr_mia",      # member of Finance and Risk
    "val": "usr_val",      # viewer of Finance
    "tom": "usr_tom",      # in the Analysts team, bound in Finance as viewers
    "rui": "usr_rui",      # viewer of Risk
    "olga": "usr_olga",    # Org Admin
}

#: The views on Orders: (id, visibility, trashed, publish requested).
VIEWS = (
    ("view_private", "private", False, False),
    ("view_team", "workspace", False, False),
    ("view_shared", "workspace", False, False),   # val holds a grant on it
    ("view_open", "enterprise", False, False),
    ("view_trash", "workspace", True, False),
    ("view_asked", "workspace", False, True),
)
#: In Finance with no source of its own: it reads Orders as the default.
LOOSE = "view_loose"


async def build_world(session: AsyncSession) -> None:
    session.add_all([
        WorkspaceORM(id=A, name="Finance"),
        WorkspaceORM(id=B, name="Risk"),
        WorkspaceORM(id=C, name="Ops"),
    ])
    for name, uid in PEOPLE.items():
        session.add(UserORM(
            id=uid, email=f"{name}@example.com", password_hash="x", first_name=name.title(),
            last_name="T", status="active", created_at=T0, updated_at=T0,
        ))
    session.add(GroupORM(id=TEAM, name="Analysts"))
    await session.flush()
    session.add(GroupMemberORM(group_id=TEAM, user_id=PEOPLE["tom"]))
    for subject_type, subject, role, ws in (
        ("user", "usr_ada", "workspace_admin", A),
        ("user", "usr_bea", "workspace_admin", B),
        ("user", "usr_cy", "workspace_admin", A),
        ("user", "usr_cy", "workspace_admin", B),
        ("user", "usr_max", "workspace_member", A),
        ("user", "usr_mia", "workspace_member", A),
        ("user", "usr_mia", "workspace_member", B),
        ("user", "usr_val", "workspace_viewer", A),
        ("user", "usr_rui", "workspace_viewer", B),
        ("group", TEAM, "workspace_viewer", A),
        ("user", "usr_olga", "org_admin", None),
    ):
        session.add(RoleBindingORM(
            subject_type=subject_type, subject_id=subject, role_name=role,
            scope_type="workspace" if ws else "global", scope_id=ws,
        ))
    session.add(ProviderORM(id=PROVIDER, name="Falkor", provider_type="falkordb"))
    await session.flush()
    session.add_all([
        WorkspaceDataSourceORM(id=DS, workspace_id=A, provider_id=PROVIDER, graph_name="orders",
                               label="Orders", is_primary=True, created_at=T0, updated_at=T0),
        WorkspaceDataSourceORM(id=DS2, workspace_id=A, provider_id=PROVIDER, graph_name="ledger",
                               label="Ledger", created_at=T1, updated_at=T1),
    ])
    await session.flush()
    for vid, visibility, trashed, asked in VIEWS:
        session.add(ViewORM(
            id=vid, name=vid.replace("view_", "").title(), workspace_id=A, data_source_id=DS,
            visibility=visibility, created_by=PEOPLE["max"], created_at=T0, updated_at=T0,
            deleted_at=T1 if trashed else None,
            publish_requested_by=PEOPLE["max"] if asked else None,
            publish_requested_at=T1 if asked else None,
        ))
    session.add(ViewORM(id=LOOSE, name="Loose", workspace_id=A, data_source_id=None,
                        visibility="private", created_by=PEOPLE["max"], created_at=T0, updated_at=T0))
    session.add(ResourceGrantORM(resource_type="view", resource_id="view_shared",
                                 subject_type="user", subject_id=PEOPLE["val"], role_name="viewer"))
    await session.commit()


async def add_view(session: AsyncSession, vid: str, *, ws: str, ds: Optional[str],
                   visibility: str = "workspace", created_at: str = T0) -> None:
    session.add(ViewORM(id=vid, name=vid, workspace_id=ws, data_source_id=ds, visibility=visibility,
                        created_by=PEOPLE["max"], created_at=created_at, updated_at=created_at))
    await session.commit()


@contextlib.asynccontextmanager
async def acting_as(session: AsyncSession, name: str):
    """Make the test client's requests ``name``'s, with the claims their bindings resolve to now."""
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


@dataclass
class FakeVersionStore:
    """What the version store would say, and what was asked of it — and of the caches, which
    have no Redis to talk to here."""
    facts: Optional[dict] = None
    busy: Optional[str] = None
    down: bool = False
    relocations: list = field(default_factory=list)
    invalidations: list = field(default_factory=list)


def fake_version_store(monkeypatch) -> FakeVersionStore:
    from backend.app.services import data_source_transfer

    store = FakeVersionStore()

    async def invalidate_reads(**kwargs):
        store.invalidations.append(kwargs)

    monkeypatch.setattr(data_source_transfer, "_invalidate_reads", invalidate_reads)

    async def relocation_facts(ds_id):
        if store.down:
            raise RuntimeError("version store down")
        return store.facts

    async def rehome(*, data_source_id, to_workspace_id, refuse_busy=True, **_kw):
        if store.down:
            raise RuntimeError("version store down")
        if refuse_busy and store.busy:
            raise purge_worker.MoveBlocked(
                f"Version control is busy with this data source ({store.busy}).")
        store.relocations.append((data_source_id, to_workspace_id, refuse_busy))
        return (store.facts or {}).get("graphId")

    monkeypatch.setattr(lifecycle, "relocation_facts", relocation_facts)
    monkeypatch.setattr(purge_worker, "rehome_graph_for_data_source", rehome)
    return store
