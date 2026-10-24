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
from backend.common.service_accounts import is_person, is_service_account

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

    A service account has no inbox — nobody signs in as one — so what is said
    to one reaches the people who answer for it (``key_audience``). Their copy
    names the account and links to its page; someone who answers for two of
    the accounts told, or is told themselves too, gets each.

    Best-effort: a notification failure must not roll back the action it
    describes — the work is done under a savepoint, so a database error here
    is undone without aborting the caller's transaction.
    """
    wanted = {u for u in user_ids if u}
    try:
        async with session.begin_nested():
            # (recipient, title) → link: one copy for each thing they are told.
            copies: dict[tuple[str, str], Optional[str]] = {
                (u, title): link for u in wanted if not is_service_account(u)
            }
            accounts = sorted(u for u in wanted if is_service_account(u))
            if accounts:
                from backend.app.services.service_account_standing import key_audience

                for account in accounts:
                    audience = await key_audience(session, account)
                    said = f"For “{audience.account}”: {title}"
                    for uid in audience.user_ids:
                        copies.setdefault((uid, said), audience.link)
            copies = {copy: where for copy, where in copies.items() if copy[0] != actor_id}
            if dedupe_unread and resource_id and copies:
                already = {row[0] for row in (await session.execute(
                    select(NotificationORM.user_id).where(
                        NotificationORM.user_id.in_(sorted({uid for uid, _ in copies})),
                        NotificationORM.kind == kind,
                        NotificationORM.resource_id == resource_id,
                        NotificationORM.read_at.is_(None),
                    )
                )).all()}
                copies = {copy: where for copy, where in copies.items() if copy[0] not in already}
            for (uid, said), where in copies.items():
                session.add(NotificationORM(
                    user_id=uid,
                    kind=kind,
                    title=said,
                    body=body,
                    link=where,
                    actor_id=actor_id,
                    resource_type=resource_type,
                    resource_id=resource_id,
                ))
            await session.flush()
            return len(copies)
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
    twice counts once, and a service account is not a person.
    """
    bindings = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.scope_id == workspace_id,
        )
    )).scalars().all()
    users = {
        b.subject_id for b in bindings
        if b.subject_type == "user" and not is_service_account(b.subject_id)
    }
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
    checked it against the admin user list — which lists no service account.
    """
    result = await session.execute(
        select(func.count(UserORM.id)).where(UserORM.status == "active", is_person(UserORM.id))
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
    workspace's publication requests in their bell. Nor are service
    accounts: these are queues and alerts for people to act on, and an
    account is told only what is addressed to it.
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
            if not is_service_account(b.subject_id):
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
    provider_name: Optional[str],
    source_name: str,
    severity: str,
    direction: str,
    node_delta: int,
    node_count: int = 0,
    metric: str = "nodes",
    finding: str = "movement",
    subject_type: Optional[str] = None,
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
    # Nodes and edges fail independently and for different reasons, so the
    # bell has to say which one. "Orders lost 48,900" sends someone looking
    # for missing records when every record is present and every link between
    # them is gone.
    noun = "relationships" if metric == "edges" else "entities"
    # Critical is not a bigger version of severe — it means the graph is
    # nearly gone — so it gets its own sentence rather than a stronger adverb.
    scale = {
        "critical": None,
        "severe": "far outside",
    }.get(severity, "outside")
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
        # The provider is in the TITLE, not the body. An operator running
        # several providers reads the bell as a list, and "Orders lost 4.2M"
        # does not say which deployment to go and look at.
        title=(
            (
                f"{source_name} has stopped reporting"
                if finding == "silent"
                else f"{source_name}: {subject_type} is gone"
                if finding == "type_gone" and subject_type
                else f"{source_name} {verb} {magnitude} {noun}"
            )
            + (f" on {provider_name}" if provider_name else "")
        ),
        body=(
            (
                # Silence is the absence of a signal, so there is no magnitude
                # to lead with — and no chart on which it appears, which is
                # why nobody would otherwise notice.
                "No counts have been observed for this source recently. "
                "Its credentials, its graph, or the provider behind it may "
                "have gone away — nothing on the chart can show this."
                if finding == "silent" else
                # A type reaching zero is categorical, so the usual "outside
                # its normal range" framing does not apply — as a share of a
                # large graph the loss is often unremarkable, which is exactly
                # why it needed its own finding.
                f"Every one of the {magnitude} {noun} of this type has gone. "
                "Nothing about the total size says so, which is why this is "
                "reported on its own."
                if finding == "type_gone" else
                f"Almost nothing is left — {node_count:,} {noun} remain. "
                "Check the source system before anything reloads over it."
                if scale is None else
                f"That is {scale} this source's usual movement."
            )
            + " Open profiling to see which types moved and what else was "
            "running at the time."
        ),
        link=link,
        resource_type="data_source",
        resource_id=data_source_id,
        dedupe_unread=True,
    )
