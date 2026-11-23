"""Conversations' background work: what the platform sends and tidies on its own.

* **Watchers** hear about each new open question on what they watch
  (``discussion.watched``). Each pass walks one question's watchers 200 at a time, in
  the unique watch index's order from ``watchers_cursor``; the cursor is saved in the
  same transaction as the notifications, so each watcher hears exactly once even if
  the process dies mid-walk (``dedupe_unread`` is a second guard). Only people who can
  open the subject hear, never the asker or someone already in the thread; private
  questions never fan out; a question still waiting after 24 hours — say the switch
  was off — is marked done without a word.
* **Reminders.** A question three days old that nobody but its asker has answered
  reminds the people asked (``discussion.reminder``); at seven days the workspace's
  admins hear, else the Org Admins (``discussion.escalated``). Once each. A question
  whose subject is soft-deleted waits, and is reminded once the subject is restored.
* **Retention.** A message deleted more than 30 days ago loses its body and mentions.
* **Archiving.** A thread whose subject no longer exists at all is archived — checked
  with id-correlated reads per batch of subjects, never a JOIN. (A soft-deleted subject
  only hides its threads: they return when it is restored.)

Runs on the CONTROLPLANE/DEV role, like the other sweepers, every 15 seconds (retention
and archiving hourly); each transaction claims an advisory lock so two processes never
do the same work. Watcher notices, reminders and escalations pause while
``conversationsEnabled`` is off; retention and archiving never do — turning questions off
must not keep what a deleted message said. Imports
repositories only: the control plane starts without the web tier.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.models import (
    DiscussionMessageORM,
    DiscussionORM,
    ViewORM,
    WorkspaceDataSourceORM,
)
from backend.app.db.repositories import discussion_repo as repo, notification_repo, user_repo
from backend.app.jobs import metrics
from backend.app.services.discussions import readers as rd
from backend.app.services.feature_flags import feature_flags

logger = logging.getLogger(__name__)

FLAG = "conversationsEnabled"
LOCK = "collaboration:discussions-housekeeping"
WATCH_BATCH = 200
#: Batches of watchers one pass sends, at most — each its own transaction.
BATCHES_PER_PASS = 25
STALE_FANOUT = timedelta(hours=24)
REMIND_AFTER = timedelta(days=3)
ESCALATE_AFTER = timedelta(days=7)
RETAIN_DELETED = timedelta(days=30)
_BATCH = 500
_INTERVAL_SECONDS = 15.0
_SLOW_EVERY = timedelta(hours=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _who(session: AsyncSession, user_id: str) -> str:
    ident = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    return (ident["name"] or ident["email"]) if ident else "Someone"


# ── Watchers ─────────────────────────────────────────────────────────


async def fan_out_one(session: AsyncSession, *, now: Optional[datetime] = None) -> bool:
    """One batch of watchers for the oldest open question whose watchers haven't all
    heard. False when nothing is waiting."""
    now = now or _now()
    thread = (await session.execute(
        select(DiscussionORM).where(
            DiscussionORM.watchers_notified_at.is_(None), DiscussionORM.visibility == "open",
            DiscussionORM.deleted_at.is_(None),
        ).order_by(DiscussionORM.created_at, DiscussionORM.id).limit(1)
    )).scalar_one_or_none()
    if thread is None:
        return False
    stamp = now.isoformat()
    subject = None if thread.archived_at else await rd.load_subject(session, thread.subject_type, thread.subject_id)
    if subject is None or thread.created_at < (now - STALE_FANOUT).isoformat():
        thread.watchers_notified_at = stamp
        await session.flush()
        return True
    watchers = await repo.watchers_after(session, thread.subject_type, thread.subject_id, thread.watchers_cursor,
                                         WATCH_BATCH)
    told: set[str] = set()
    if watchers:
        readers = await rd.readers_of(session, subject)
        inside = set((await repo.participants(session, thread.id, watchers)).keys())
        told = await readers.among(session, [u for u in watchers if u not in inside and u != thread.asked_by])
        thread.watchers_cursor = watchers[-1]
    if len(watchers) < WATCH_BATCH:
        thread.watchers_notified_at = stamp
    # The cursor is written first, so it and the notices are one transaction however the
    # driver treats the notices' savepoint.
    await session.flush()
    if told:
        await notification_repo.notify(
            session, user_ids=sorted(told), kind="discussion.watched",
            title=f"{await _who(session, thread.asked_by)} asked about {subject.name}",
            body=thread.excerpt, link=rd.thread_link(subject, thread.id), actor_id=thread.asked_by,
            resource_type="discussion", resource_id=thread.id, dedupe_unread=True,
        )
        metrics.increment("discussion_watchers_notified_total", value=float(len(told)))
    return True


# ── Reminders ────────────────────────────────────────────────────────


async def remind(session: AsyncSession, *, now: Optional[datetime] = None) -> tuple[int, int]:
    """Remind the people asked about questions nobody but the asker has answered after
    :data:`REMIND_AFTER`; escalate after :data:`ESCALATE_AFTER`. Returns ``(reminded, escalated)``."""
    now = now or _now()
    due = select(DiscussionORM).where(
        DiscussionORM.status == "open", DiscussionORM.first_response_at.is_(None),
        DiscussionORM.created_at <= (now - REMIND_AFTER).isoformat(),
        DiscussionORM.deleted_at.is_(None), DiscussionORM.archived_at.is_(None),
        or_(DiscussionORM.reminded_at.is_(None),
            and_(DiscussionORM.escalated_at.is_(None),
                 DiscussionORM.created_at <= (now - ESCALATE_AFTER).isoformat())),
    ).order_by(DiscussionORM.created_at, DiscussionORM.id).limit(_BATCH)
    reminded = escalated = 0
    stamp = now.isoformat()
    after = None
    while True:
        stmt = due if after is None else due.where(or_(
            DiscussionORM.created_at > after[0],
            and_(DiscussionORM.created_at == after[0], DiscussionORM.id > after[1])))
        rows = (await session.execute(stmt)).scalars().all()
        r, e = await _remind_batch(session, rows, now=now, stamp=stamp)
        reminded, escalated = reminded + r, escalated + e
        if len(rows) < _BATCH:
            break
        # Past the batch: threads skipped below are left as they are, and must not hold up the rest.
        after = (rows[-1].created_at, rows[-1].id)
    await session.flush()
    if reminded:
        metrics.increment("discussions_reminders_total", value=float(reminded))
    if escalated:
        metrics.increment("discussions_escalated_total", value=float(escalated))
    return reminded, escalated


async def _remind_batch(session: AsyncSession, rows, *, now: datetime, stamp: str) -> tuple[int, int]:
    reminded = escalated = 0
    subjects = await rd.load_subjects(session, [(t.subject_type, t.subject_id) for t in rows])
    for thread in rows:
        subject = subjects.get((thread.subject_type, thread.subject_id))
        if subject is None:
            # Soft-deleted (its question is reminded once it is restored) or gone (archived).
            continue
        readers = await rd.readers_of(session, subject)
        waited = (now - datetime.fromisoformat(thread.created_at)).days
        who = await _who(session, thread.asked_by)
        link = rd.thread_link(subject, thread.id)
        if thread.reminded_at is None:
            thread.reminded_at = stamp
            asked = [p.user_id for p in (await repo.participants(session, thread.id)).values()
                     if p.asked_to and not p.muted]
            await notification_repo.notify(
                session, user_ids=sorted(await readers.among(session, asked)), kind="discussion.reminder",
                title=f"{who} is still waiting for an answer about {subject.name}",
                body=f"Asked {waited} days ago: {thread.excerpt}", link=link, actor_id=None,
                resource_type="discussion", resource_id=thread.id, dedupe_unread=True,
            )
            reminded += 1
        if thread.escalated_at is None and thread.created_at <= (now - ESCALATE_AFTER).isoformat():
            thread.escalated_at = stamp
            admins = await rd.workspace_admins(session, subject.workspace_id) or await rd.org_admins(session)
            await notification_repo.notify(
                session, user_ids=sorted(await readers.among(session, admins - {thread.asked_by})),
                kind="discussion.escalated",
                title=f"Nobody has answered {who}'s question about {subject.name}",
                body=f"It has waited {waited} days: {thread.excerpt}", link=link, actor_id=None,
                resource_type="discussion", resource_id=thread.id, dedupe_unread=True,
            )
            escalated += 1
    return reminded, escalated


# ── Retention and archiving ──────────────────────────────────────────


async def retain(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """Blank what messages deleted more than :data:`RETAIN_DELETED` ago said."""
    now = now or _now()
    ids = (await session.execute(
        select(DiscussionMessageORM.id).where(
            DiscussionMessageORM.deleted_at <= (now - RETAIN_DELETED).isoformat(),
            or_(DiscussionMessageORM.body != "", DiscussionMessageORM.mentions != "[]"),
        ).limit(_BATCH * 2)
    )).scalars().all()
    if ids:
        await session.execute(
            update(DiscussionMessageORM).where(DiscussionMessageORM.id.in_(list(ids)))
            .values(body="", mentions=json.dumps([])).execution_options(synchronize_session=False)
        )
        metrics.increment("discussions_blanked_total", value=float(len(ids)))
    return len(ids)


async def archive(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """Archive the threads of subjects that no longer exist at all, walking the subjects
    of unarchived threads a batch at a time."""
    now = now or _now()
    archived, after = 0, None
    while True:
        stmt = select(DiscussionORM.subject_type, DiscussionORM.subject_id).where(
            DiscussionORM.archived_at.is_(None),
        ).group_by(DiscussionORM.subject_type, DiscussionORM.subject_id)
        if after is not None:
            stmt = stmt.where(or_(DiscussionORM.subject_type > after[0],
                                  and_(DiscussionORM.subject_type == after[0], DiscussionORM.subject_id > after[1])))
        refs = [tuple(r) for r in (await session.execute(
            stmt.order_by(DiscussionORM.subject_type, DiscussionORM.subject_id).limit(_BATCH)
        )).all()]
        if not refs:
            if archived:
                metrics.increment("discussions_archived_total", value=float(archived))
            return archived
        views = {i for t, i in refs if t == "view"}
        sources = {i for t, i in refs if t == "data_source"}
        there = set()
        if views:
            there |= {("view", i) for i in (await session.execute(
                select(ViewORM.id).where(ViewORM.id.in_(sorted(views))))).scalars().all()}
        if sources:
            there |= {("data_source", i) for i in (await session.execute(
                select(WorkspaceDataSourceORM.id).where(WorkspaceDataSourceORM.id.in_(sorted(sources))))).scalars().all()}
        for t, i in refs:
            if (t, i) in there:
                continue
            result = await session.execute(
                update(DiscussionORM).where(DiscussionORM.subject_type == t, DiscussionORM.subject_id == i,
                                            DiscussionORM.archived_at.is_(None))
                .values(archived_at=now.isoformat()).execution_options(synchronize_session=False)
            )
            archived += int(result.rowcount or 0)
        after = refs[-1]


# ── The loop ─────────────────────────────────────────────────────────


async def run_pass(session_factory, *, now: Optional[datetime] = None, slow: bool = True) -> dict:
    """One pass: watcher batches (each its own transaction), then reminders — and, when
    ``slow``, retention and archiving. While the switch is off only retention and archiving
    run (``paused`` in the result)."""
    out = {"fanned": 0, "reminded": 0, "escalated": 0, "blanked": 0, "archived": 0}
    on = await feature_flags.is_enabled_self_session(FLAG, default=False)
    if not on:
        out["paused"] = True
    now = now or _now()
    for _ in range(BATCHES_PER_PASS if on else 0):
        async with session_factory() as session:
            if not await claim_this_pass(session, LOCK):
                return out
            did = await fan_out_one(session, now=now)
            await session.commit()
        if not did:
            break
        out["fanned"] += 1
    async with session_factory() as session:
        if await claim_this_pass(session, LOCK):
            if on:
                out["reminded"], out["escalated"] = await remind(session, now=now)
            if slow:
                out["blanked"] = await retain(session, now=now)
                out["archived"] = await archive(session, now=now)
            await session.commit()
    return out


async def run_sweeper(session_factory, shutdown: asyncio.Event, *, interval: float = _INTERVAL_SECONDS) -> None:
    """Background loop until ``shutdown`` is set. A failed pass is logged and retried."""
    logger.info("Discussions housekeeping started (interval=%.0fs)", interval)
    last_slow: Optional[datetime] = None
    while not shutdown.is_set():
        try:
            now = _now()
            slow = last_slow is None or now - last_slow >= _SLOW_EVERY
            out = await run_pass(session_factory, now=now, slow=slow)
            if slow:
                last_slow = now
            if any(v for k, v in out.items() if k != "paused"):
                logger.info("Discussions housekeeping: %s", " ".join(f"{k}={v}" for k, v in out.items()))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must survive blips
            logger.warning("Discussions housekeeping failed: %s", exc, exc_info=True)
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass                                        # the interval ran out: the next pass
    logger.info("Discussions housekeeping stopped")


__all__ = ["run_sweeper", "run_pass", "fan_out_one", "remind", "retain", "archive"]
