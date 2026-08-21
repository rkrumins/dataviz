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
    UserORM,
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
    dedupe_unread: bool = False,
) -> int:
    """Queue one notification per recipient. Never notifies the actor
    about their own action — being told what you just did is noise.

    ``dedupe_unread`` skips anyone who already has an unread row of this
    ``kind`` + ``resource_id`` — a stuck source must not re-ring every hour.

    Best-effort: a notification failure must not roll back the action it
    describes.
    """
    recipients = {u for u in user_ids if u and u != actor_id}
    if not recipients:
        return 0
    try:
        if dedupe_unread and resource_id:
            already = (await session.execute(
                select(NotificationORM.user_id).where(
                    NotificationORM.user_id.in_(recipients),
                    NotificationORM.kind == kind,
                    NotificationORM.resource_id == resource_id,
                    NotificationORM.read_at.is_(None),
                )
            )).all()
            recipients -= {row[0] for row in already}
            if not recipients:
                return 0
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

async def workspace_member_count(
    session: AsyncSession, workspace_id: str,
) -> int:
    """How many distinct people are bound to this workspace.

    "Everyone in Finance" means nothing until you know Finance is twelve
    people — an audience the sharer cannot count from the browser,
    because the workspace list they can see is scoped to their own
    memberships. Group bindings expand to their members; a person bound
    twice counts once.
    """
    bindings = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.scope_id == workspace_id,
        )
    )).scalars().all()
    users = {b.subject_id for b in bindings if b.subject_type == "user"}
    group_ids = {b.subject_id for b in bindings if b.subject_type == "group"}
    if group_ids:
        members = (await session.execute(
            select(GroupMemberORM.user_id).where(
                GroupMemberORM.group_id.in_(group_ids)
            )
        )).all()
        users.update(m[0] for m in members)
    return len(users)


async def platform_user_count(session: AsyncSession) -> int:
    """How many people "anyone signed in" actually is.

    Publishing is the one visibility choice whose audience the sharer
    cannot picture. "Everyone in Finance" is twelve people they can
    name; "anyone signed in" is a phrase. Attaching the number is what
    turns publishing from a shrug into a decision.

    Counts ACTIVE accounts only — pending invitees and suspended
    accounts cannot open anything, so including them would overstate
    the reach and make the number untrustworthy the first time someone
    checked it against the admin user list.
    """
    result = await session.execute(
        select(func.count(UserORM.id)).where(UserORM.status == "active")
    )
    return int(result.scalar_one() or 0)


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


async def users_with_global_permission(
    session: AsyncSession, permission: str,
) -> set[str]:
    """Users bound globally to a role that carries ``permission``.

    Sharing deliberately excludes platform owners from workspace bells;
    ops alerts (a source the sweep will not retry) are the opposite —
    globally bound ``system:admin`` is the audience. Group bindings
    expand to their members.
    """
    role_rows = (await session.execute(
        select(RolePermissionORM.role_name).where(
            RolePermissionORM.permission_id == permission,
        )
    )).all()
    roles = {r[0] for r in role_rows}
    if not roles:
        return set()

    bindings = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.scope_type == "global",
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


async def notify_reconcile_suspended(
    session: AsyncSession,
    *,
    workspace_id: str,
    data_source_id: str,
    source_name: str,
) -> int:
    """Bell for a source the breaker just tripped. Workspace managers
    plus globally bound platform admins; unread-deduped per source."""
    managers = await users_who_can(
        session,
        workspace_id=workspace_id,
        permission="workspace:datasource:manage",
    )
    admins = await users_with_global_permission(session, "system:admin")
    return await notify(
        session,
        user_ids=managers | admins,
        kind="reconcile.suspended",
        title=f"{source_name} needs a person",
        body=(
            "Automatic reconciliation stopped after repeated rebuilds "
            "that did not clear the drift."
        ),
        link=f"/ingestion?tab=freshness&fds={data_source_id}",
        resource_type="data_source",
        resource_id=data_source_id,
        dedupe_unread=True,
    )


async def notify_counts_anomaly(
    session: AsyncSession,
    *,
    workspace_id: Optional[str],
    data_source_id: str,
    catalog_item_id: Optional[str],
    source_name: str,
    severity: str,
    direction: str,
    node_delta: int,
) -> int:
    """Bell for a graph that moved far outside its own normal range.

    Same audience and dedupe discipline as :func:`notify_reconcile_suspended`:
    the workspace's data source managers plus globally bound platform admins,
    unread-deduped per source so an incident that keeps moving rings once.

    The copy leads with the number and the direction, because the first
    question anyone asks is "how much, and which way" — and a title that only
    says "anomaly detected" makes them open the page to find out.
    """
    managers = (
        await users_who_can(
            session,
            workspace_id=workspace_id,
            permission="workspace:datasource:manage",
        )
        if workspace_id else set()
    )
    admins = await users_with_global_permission(session, "system:admin")

    magnitude = f"{abs(node_delta):,}"
    verb = "lost" if direction == "drop" else "gained"
    scale = "far outside" if severity == "severe" else "outside"
    # The history view is routed by CATALOG id; the alert knows the data
    # source. When the two cannot be connected — an unregistered graph, a
    # catalog entry since removed — fall back to the freshness cockpit, which
    # is keyed on the data source and is where the sibling ops alert points.
    # A link that lands somewhere useful beats a precise one that 404s.
    link = (
        f"/datasources/{catalog_item_id}/history?ds={data_source_id}"
        if catalog_item_id
        else f"/ingestion?tab=freshness&fds={data_source_id}"
    )
    return await notify(
        session,
        user_ids=managers | admins,
        kind="insights.counts_anomaly",
        title=f"{source_name} {verb} {magnitude} entities",
        body=(
            f"That is {scale} this source's usual movement. "
            "Open the history to see which labels moved and what else was "
            "running at the time."
        ),
        link=link,
        resource_type="data_source",
        resource_id=data_source_id,
        dedupe_unread=True,
    )
