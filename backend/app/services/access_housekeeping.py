"""Access after it is granted: the reminders the platform sends on its own.

* **Access about to end.** Someone with time-limited access to a workspace
  hears before it ends — a week ahead for a grant of more than two weeks, two
  days ahead for a shorter one, nothing for a day or two of cover — once per
  end date, with the way to ask to keep it (My access).
* **Requests still waiting.** After three days the workspace's approvers are
  reminded; after a week the Org Admins hear too. Once each.
* **Access reviews past their due date.** The workspace's admins and whoever
  started the review hear once.

Runs on the CONTROLPLANE/DEV role only, like the other sweepers, and claims an
advisory lock per pass so two processes never send the same reminder. It
imports repositories only: the control plane starts without the web tier.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.models import (
    AccessRequestORM,
    AccessReviewItemORM,
    AccessReviewORM,
    RoleBindingORM,
    WorkspaceORM,
)
from backend.app.db.repositories import notification_repo, user_repo
from backend.common.roles import role_label

logger = logging.getLogger(__name__)

#: A grant longer than this hears a week ahead; a shorter one two days ahead,
#: and one of two days or less not at all.
_LONG_GRANT = timedelta(days=14)
_REMIND_LONG = timedelta(days=7)
_REMIND_SHORT = timedelta(days=2)
#: A request waiting this long is brought up again, then taken further.
REMIND_AFTER = timedelta(days=3)
ESCALATE_AFTER = timedelta(days=7)
_BATCH = 500
# The shortest lead is two days, so an hour's resolution is plenty.
_DEFAULT_INTERVAL_SECONDS = 3600.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _instant(value: Optional[str]) -> Optional[datetime]:
    """A stored ISO-8601 instant, aware (naive reads as UTC)."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _lead(granted: Optional[datetime], expires: datetime) -> Optional[timedelta]:
    """How far ahead of its end a grant is reminded of — ``None`` for cover
    too short to need it."""
    lifetime = expires - granted if granted else None
    if lifetime is not None and lifetime <= _REMIND_SHORT:
        return None
    return _REMIND_LONG if lifetime is None or lifetime > _LONG_GRANT else _REMIND_SHORT


def _days(span: timedelta) -> int:
    return int(span.total_seconds() // 86400)


async def _live_workspaces(session: AsyncSession, ids: set[str]) -> dict[str, WorkspaceORM]:
    if not ids:
        return {}
    rows = (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id.in_(sorted(ids)), WorkspaceORM.deleted_at.is_(None))
    )).scalars().all()
    return {w.id: w for w in rows}


async def remind_expiring(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """Tell people whose time-limited workspace access ends soon. A grant
    looked at is marked once its reminder is due — sent, or not needed — so
    each end date is considered once; moving the end clears the mark.
    Returns how many reminders went out."""
    now = now or _now()
    bindings = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.subject_type == "user",
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.source == "local",
            RoleBindingORM.expires_at.is_not(None),
            RoleBindingORM.expires_at > now.isoformat(),
            RoleBindingORM.expires_at <= (now + _REMIND_LONG).isoformat(),
            RoleBindingORM.expiry_reminded_at.is_(None),
        ).order_by(RoleBindingORM.expires_at).limit(_BATCH)
    )).scalars().all()
    workspaces = await _live_workspaces(session, {b.scope_id for b in bindings})
    reminded = 0
    for b in bindings:
        expires = _instant(b.expires_at)
        lead = _lead(_instant(b.granted_at), expires) if expires else None
        if expires is not None and lead is not None and expires - now > lead:
            continue  # not yet: a later pass reminds it
        b.expiry_reminded_at = now.isoformat()
        ws = workspaces.get(b.scope_id)
        if expires is None or lead is None or ws is None:
            continue
        days = _days(expires - now)
        when = "within a day" if days < 1 else f"in {days} day{'s' if days != 1 else ''}"
        await notification_repo.notify(
            session,
            user_ids=[b.subject_id],
            kind="access.expiring",
            title=f"Your access to {ws.name} ends {when}",
            body=(
                f"Your {role_label(b.role_name)} access ends on {expires.date().isoformat()}. "
                "If you still need it, ask to keep it on My access."
            ),
            link="/my/access",
            resource_type="role_binding",
            resource_id=b.id,
            dedupe_unread=True,
        )
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.workspace.access_expiring",
            payload={
                "workspace_id": ws.id,
                "binding_id": b.id,
                "user_id": b.subject_id,
                "role": b.role_name,
                "expires_at": b.expires_at,
            },
        )
        reminded += 1
    if bindings:
        await session.flush()
    return reminded


async def nudge_waiting_requests(
    session: AsyncSession, *, now: Optional[datetime] = None,
) -> tuple[int, int]:
    """Bring up requests nobody has answered: to the workspace's approvers
    after :data:`REMIND_AFTER`, to the Org Admins after
    :data:`ESCALATE_AFTER`. Requests waiting on the identity provider are
    IT's to finish, not the approvers'. Returns ``(reminded, escalated)``."""
    now = now or _now()
    rows = (await session.execute(
        select(AccessRequestORM).where(
            AccessRequestORM.status == "pending",
            AccessRequestORM.created_at <= (now - REMIND_AFTER).isoformat(),
            or_(AccessRequestORM.reminded_at.is_(None), AccessRequestORM.escalated_at.is_(None)),
        ).order_by(AccessRequestORM.created_at).limit(_BATCH)
    )).scalars().all()
    if not rows:
        return 0, 0
    workspaces = await _live_workspaces(session, {r.target_id for r in rows})
    names = await user_repo.get_identities_by_ids(session, sorted({r.requester_id for r in rows}))
    # Keeping an exception going is the admins' call alone.
    binding_ids = sorted({r.binding_id for r in rows if r.binding_id})
    exceptions = set((await session.execute(
        select(RoleBindingORM.id).where(
            RoleBindingORM.id.in_(binding_ids), RoleBindingORM.idp_exception.is_(True),
        )
    )).scalars().all()) if binding_ids else set()
    org_admins: Optional[set[str]] = None
    reminded = escalated = 0
    for row in rows:
        waited = now - (_instant(row.created_at) or now)
        ws = workspaces.get(row.target_id)
        if ws is None:
            row.reminded_at = row.reminded_at or now.isoformat()
            row.escalated_at = row.escalated_at or now.isoformat()
            continue
        ident = names.get(row.requester_id)
        who = (ident["name"] or ident["email"]) if ident else "Someone"
        what = f"to keep their access to {ws.name}" if row.binding_id else f"to join {ws.name}"
        if row.reminded_at is None:
            row.reminded_at = now.isoformat()
            approvers = await notification_repo.users_who_can(
                session, workspace_id=ws.id,
                permission="workspace:admin" if row.binding_id in exceptions else "workspace:members:add",
            )
            if not approvers:
                if org_admins is None:
                    org_admins = await notification_repo.users_with_global_permission(
                        session, "system:org-admin",
                    )
                approvers = org_admins
            await notification_repo.notify(
                session,
                user_ids=approvers - {row.requester_id},
                kind="access_request.reminder",
                title=f"{who} is still waiting {what}",
                body=(
                    f"Asked {_days(waited)} days ago, as {role_label(row.requested_role)}. "
                    "Answer it on the Requests tab."
                ),
                link="/workspaces?tab=requests",
                resource_type="access_request",
                resource_id=row.id,
                dedupe_unread=True,
            )
            reminded += 1
        if row.escalated_at is None and waited >= ESCALATE_AFTER:
            row.escalated_at = now.isoformat()
            if org_admins is None:
                org_admins = await notification_repo.users_with_global_permission(
                    session, "system:org-admin",
                )
            await notification_repo.notify(
                session,
                user_ids=org_admins - {row.requester_id},
                kind="access_request.escalated",
                title=f"Nobody has answered {who}'s request {what}",
                body=(
                    f"It has waited {_days(waited)} days. As an Org Admin you can answer it "
                    "on the Requests tab."
                ),
                link="/workspaces?tab=requests",
                resource_type="access_request",
                resource_id=row.id,
                dedupe_unread=True,
            )
            await user_repo.create_outbox_event(
                session,
                event_type="rbac.access_request.escalated",
                payload={
                    "request_id": row.id,
                    "requester_id": row.requester_id,
                    "target_type": row.target_type,
                    "target_id": row.target_id,
                    "workspace_id": ws.id,
                    "requested_role": row.requested_role,
                },
            )
            escalated += 1
    await session.flush()
    return reminded, escalated


async def flag_overdue_reviews(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """Tell a workspace's admins, once, that its access review is past its
    due date — with how much is left. Returns how many reviews it flagged."""
    now = now or _now()
    reviews = (await session.execute(
        select(AccessReviewORM).where(
            AccessReviewORM.status == "open",
            AccessReviewORM.due_at <= now.isoformat(),
            AccessReviewORM.overdue_notified_at.is_(None),
        ).limit(_BATCH)
    )).scalars().all()
    workspaces = await _live_workspaces(session, {r.workspace_id for r in reviews})
    for review in reviews:
        review.overdue_notified_at = now.isoformat()
        ws = workspaces.get(review.workspace_id)
        if ws is None:
            continue
        total, undecided = (await session.execute(
            select(
                func.count(AccessReviewItemORM.id),
                func.count(AccessReviewItemORM.id).filter(AccessReviewItemORM.decision.is_(None)),
            ).where(AccessReviewItemORM.review_id == review.id)
        )).one()
        admins = await notification_repo.users_who_can(
            session, workspace_id=ws.id, permission="workspace:admin",
        )
        await notification_repo.notify(
            session,
            user_ids=admins | ({review.started_by} if review.started_by else set()),
            kind="access_review.overdue",
            title=f"The access review of {ws.name} is past its due date",
            body=f"{undecided} of {total} grants still need a decision.",
            link=f"/workspaces/{ws.id}?tab=members",
            resource_type="access_review",
            resource_id=review.id,
            dedupe_unread=True,
        )
    if reviews:
        await session.flush()
    return len(reviews)


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop until ``shutdown`` is set. A failed pass is logged
    and retried on the next tick."""
    logger.info("Access housekeeping started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            async with session_factory() as session:
                if await claim_this_pass(session, "rbac:access-housekeeping"):
                    expiring = await remind_expiring(session)
                    reminded, escalated = await nudge_waiting_requests(session)
                    overdue = await flag_overdue_reviews(session)
                    await session.commit()
                    if expiring or reminded or escalated or overdue:
                        logger.info(
                            "Access housekeeping: %d ending, %d reminded, %d escalated, %d overdue",
                            expiring, reminded, escalated, overdue,
                        )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning("Access housekeeping failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass  # a whole interval with no shutdown: time for the next pass

    logger.info("Access housekeeping stopped")
