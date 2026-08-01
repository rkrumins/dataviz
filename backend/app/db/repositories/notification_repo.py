"""In-app notifications: write on the action, read from the bell.

Notifications are written in the same transaction as the thing they
describe. Every sharing flow in this product ends in someone needing to
know — a view was shared with you, your publication request was
answered, an admin is waiting on you — and until now every one of them
ended in silence: the fact was recorded on a timeline nobody thinks to
open. The outbox still carries these events for external consumers;
this table is what the in-app bell reads.

Recipient resolution lives here too, because "who should hear about
this" is a question about role bindings, not about views.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable, Optional, Sequence

from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    GroupMemberORM,
    NotificationORM,
    RoleBindingORM,
    RolePermissionORM,
)

logger = logging.getLogger(__name__)


class NotificationEntry(BaseModel):
    id: str
    kind: str
    title: str
    body: Optional[str] = None
    link: Optional[str] = None
    actorId: Optional[str] = None
    actorName: Optional[str] = None
    resourceType: Optional[str] = None
    resourceId: Optional[str] = None
    readAt: Optional[str] = None
    createdAt: str


async def notify(
    session: AsyncSession,
    *,
    user_ids: Iterable[str],
    kind: str,
    title: str,
    body: Optional[str] = None,
    link: Optional[str] = None,
    actor_id: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
) -> int:
    """Queue one notification per recipient. Never notifies the actor
    about their own action — being told what you just did is noise.

    Best-effort: a notification failure must not roll back the action it
    describes.
    """
    recipients = {u for u in user_ids if u and u != actor_id}
    if not recipients:
        return 0
    try:
        for uid in recipients:
            session.add(NotificationORM(
                user_id=uid,
                kind=kind,
                title=title,
                body=body,
                link=link,
                actor_id=actor_id,
                resource_type=resource_type,
                resource_id=resource_id,
            ))
        await session.flush()
        return len(recipients)
    except Exception:  # noqa: BLE001 — audit aid, never the write contract
        logger.exception("notify failed (kind=%s resource=%s)", kind, resource_id)
        return 0


async def list_for_user(
    session: AsyncSession,
    user_id: str,
    *,
    limit: int = 30,
    unread_only: bool = False,
) -> list[NotificationEntry]:
    """This user's newest notifications."""
    from backend.app.db.repositories.view_repo import resolve_user_ids

    query = select(NotificationORM).where(NotificationORM.user_id == user_id)
    if unread_only:
        query = query.where(NotificationORM.read_at.is_(None))
    query = query.order_by(NotificationORM.created_at.desc()).limit(limit)
    rows = (await session.execute(query)).scalars().all()
    if not rows:
        return []
    actors = await resolve_user_ids(session, {r.actor_id for r in rows})
    return [
        NotificationEntry(
            id=r.id,
            kind=r.kind,
            title=r.title,
            body=r.body,
            link=r.link,
            actorId=r.actor_id,
            actorName=actors.get(r.actor_id or "", (None, None))[0],
            resourceType=r.resource_type,
            resourceId=r.resource_id,
            readAt=r.read_at,
            createdAt=r.created_at,
        )
        for r in rows
    ]


async def unread_count(session: AsyncSession, user_id: str) -> int:
    result = await session.execute(
        select(func.count(NotificationORM.id)).where(
            NotificationORM.user_id == user_id,
            NotificationORM.read_at.is_(None),
        )
    )
    return int(result.scalar_one() or 0)


async def mark_read(
    session: AsyncSession, user_id: str, notification_ids: Optional[Sequence[str]] = None,
) -> int:
    """Mark some (or all) of this user's notifications read. Scoped to the
    caller's own rows — an id from someone else's list does nothing."""
    now = datetime.now(timezone.utc).isoformat()
    stmt = (
        update(NotificationORM)
        .where(
            NotificationORM.user_id == user_id,
            NotificationORM.read_at.is_(None),
        )
        .values(read_at=now)
    )
    if notification_ids is not None:
        if not notification_ids:
            return 0
        stmt = stmt.where(NotificationORM.id.in_(list(notification_ids)))
    result = await session.execute(stmt)
    return int(result.rowcount or 0)


# ── recipient resolution ─────────────────────────────────────────────

async def users_who_can(
    session: AsyncSession, *, workspace_id: str, permission: str,
) -> set[str]:
    """Every user who holds ``permission`` in this workspace.

    Walks role bindings rather than permission claims because claims are
    per-session and we need the answer for people who aren't here. Group
    bindings expand to their members. Global bindings that imply the
    permission everywhere (``system:admin`` / ``system:org-admin``) are
    deliberately NOT included: a platform owner does not want every
    workspace's publication requests in their bell.
    """
    role_rows = (await session.execute(
        select(RolePermissionORM.role_name).where(
            RolePermissionORM.permission_id.in_([permission, "workspace:admin"])
        )
    )).all()
    roles = {r[0] for r in role_rows}
    if not roles:
        return set()

    bindings = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.scope_id == workspace_id,
            RoleBindingORM.role_name.in_(roles),
        )
    )).scalars().all()

    users: set[str] = set()
    group_ids: set[str] = set()
    for b in bindings:
        if b.subject_type == "user":
            users.add(b.subject_id)
        elif b.subject_type == "group":
            group_ids.add(b.subject_id)

    if group_ids:
        members = (await session.execute(
            select(GroupMemberORM.user_id).where(
                GroupMemberORM.group_id.in_(group_ids)
            )
        )).all()
        users.update(m[0] for m in members)
    return users
