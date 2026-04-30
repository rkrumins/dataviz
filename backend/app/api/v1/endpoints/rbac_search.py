"""Unified RBAC search (Phase 4.5).

A single endpoint that returns mixed-type hits across users, groups,
workspaces, roles, and permissions. Backs the search bar mounted at
the top of the Permissions admin surface — admins can find any RBAC
entity without remembering which tab to open.

  GET /api/v1/admin/rbac/search?q=&types=

Each hit carries ``type``, ``id``, ``displayName``, ``secondary``,
and a server-side ``score`` (3=exact id, 2=prefix, 1=substring).
The endpoint returns up to 25 hits ranked by ``score`` then
alphabetic.

Implementation runs five small queries (one per entity type) in
parallel via ``asyncio.gather``. A single SQL UNION across all five
tables is tempting but unwieldy: each table has a different shape
and ``WHERE`` clause, so five focused queries are clearer and easier
to optimize per-table.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    GroupORM, PermissionORM, RoleORM, UserORM, WorkspaceORM,
)
from backend.auth_service.interface import User
from backend.common.models.rbac import RBACSearchHit


logger = logging.getLogger(__name__)
router = APIRouter()


MAX_RESULTS = 25
PER_TYPE_CAP = 8  # per-table fetch cap before global ranking


def _score(query: str, *fields: str | None) -> int:
    """Score the strength of the match.

    3 = an exact equality match against any field
    2 = a prefix match
    1 = a substring match
    0 = no match (caller should skip)
    """
    q = query.lower()
    best = 0
    for raw in fields:
        if not raw:
            continue
        v = raw.lower()
        if v == q:
            return 3
        if v.startswith(q):
            best = max(best, 2)
        elif q in v:
            best = max(best, 1)
    return best


async def _search_users(session: AsyncSession, q: str) -> list[RBACSearchHit]:
    pat = f"%{q.lower()}%"
    rows = await session.execute(
        select(UserORM)
        .where(
            or_(
                UserORM.email.ilike(pat),
                UserORM.first_name.ilike(pat),
                UserORM.last_name.ilike(pat),
                UserORM.id.ilike(pat),
            )
        )
        .limit(PER_TYPE_CAP)
    )
    out: list[RBACSearchHit] = []
    for u in rows.scalars().all():
        full = f"{u.first_name} {u.last_name}".strip() or u.email
        score = _score(q, u.id, u.email, full, u.first_name, u.last_name)
        if score == 0:
            continue
        out.append(RBACSearchHit(
            type="user",
            id=u.id,
            display_name=full,
            secondary=u.email,
            score=score,
        ))
    return out


async def _search_groups(session: AsyncSession, q: str) -> list[RBACSearchHit]:
    pat = f"%{q.lower()}%"
    rows = await session.execute(
        select(GroupORM)
        .where(
            GroupORM.deleted_at.is_(None),
            or_(
                GroupORM.id.ilike(pat),
                GroupORM.name.ilike(pat),
                GroupORM.description.ilike(pat),
            ),
        )
        .limit(PER_TYPE_CAP)
    )
    out: list[RBACSearchHit] = []
    for g in rows.scalars().all():
        score = _score(q, g.id, g.name, g.description)
        if score == 0:
            continue
        out.append(RBACSearchHit(
            type="group",
            id=g.id,
            display_name=g.name,
            secondary=g.description or g.id,
            score=score,
        ))
    return out


async def _search_workspaces(session: AsyncSession, q: str) -> list[RBACSearchHit]:
    pat = f"%{q.lower()}%"
    rows = await session.execute(
        select(WorkspaceORM)
        .where(
            WorkspaceORM.deleted_at.is_(None),
            or_(
                WorkspaceORM.id.ilike(pat),
                WorkspaceORM.name.ilike(pat),
                WorkspaceORM.description.ilike(pat),
            ),
        )
        .limit(PER_TYPE_CAP)
    )
    out: list[RBACSearchHit] = []
    for w in rows.scalars().all():
        score = _score(q, w.id, w.name, w.description)
        if score == 0:
            continue
        out.append(RBACSearchHit(
            type="workspace",
            id=w.id,
            display_name=w.name,
            secondary=w.description or w.id,
            score=score,
        ))
    return out


async def _search_roles(session: AsyncSession, q: str) -> list[RBACSearchHit]:
    pat = f"%{q.lower()}%"
    rows = await session.execute(
        select(RoleORM)
        .where(
            or_(
                RoleORM.name.ilike(pat),
                RoleORM.description.ilike(pat),
            )
        )
        .limit(PER_TYPE_CAP)
    )
    out: list[RBACSearchHit] = []
    for r in rows.scalars().all():
        score = _score(q, r.name, r.description)
        if score == 0:
            continue
        out.append(RBACSearchHit(
            type="role",
            id=r.name,
            display_name=r.name,
            secondary=r.description or ("System role" if r.is_system else "Custom role"),
            score=score,
        ))
    return out


async def _search_permissions(session: AsyncSession, q: str) -> list[RBACSearchHit]:
    pat = f"%{q.lower()}%"
    rows = await session.execute(
        select(PermissionORM)
        .where(
            or_(
                PermissionORM.id.ilike(pat),
                PermissionORM.description.ilike(pat),
            )
        )
        .limit(PER_TYPE_CAP)
    )
    out: list[RBACSearchHit] = []
    for p in rows.scalars().all():
        score = _score(q, p.id, p.description)
        if score == 0:
            continue
        out.append(RBACSearchHit(
            type="permission",
            id=p.id,
            display_name=p.id,
            secondary=p.description,
            score=score,
        ))
    return out


_SEARCH_HANDLERS = {
    "user": _search_users,
    "group": _search_groups,
    "workspace": _search_workspaces,
    "role": _search_roles,
    "permission": _search_permissions,
}


@router.get(
    "",
    response_model=list[RBACSearchHit],
    response_model_by_alias=True,
)
async def search_rbac(
    q: str = Query(..., min_length=1, description="Search query"),
    types: str | None = Query(
        default=None,
        description=(
            "Optional comma-separated allow-list of entity types: "
            "user, group, workspace, role, permission. Defaults to all."
        ),
    ),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> list[RBACSearchHit]:
    """Unified search across the five RBAC entity types.

    Hits are ranked by ``score`` (descending), then by display name
    (ascending). Up to 25 results are returned.
    """
    q = q.strip()
    if not q:
        return []

    if types:
        wanted = {t.strip() for t in types.split(",") if t.strip()}
        wanted &= set(_SEARCH_HANDLERS.keys())
    else:
        wanted = set(_SEARCH_HANDLERS.keys())

    if not wanted:
        return []

    coros = [_SEARCH_HANDLERS[t](session, q) for t in wanted]
    nested = await asyncio.gather(*coros)
    flat: list[RBACSearchHit] = [hit for batch in nested for hit in batch]
    flat.sort(key=lambda h: (-h.score, h.display_name.lower()))
    return flat[:MAX_RESULTS]
