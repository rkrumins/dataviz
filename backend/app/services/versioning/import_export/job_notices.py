"""Telling the person who started a bulk property job what became of it, in their Inbox.

A bulk property job (undos included) ends in one of several places: its worker finishes or fails
it, the claim fails one its workers keep dying on, the transfer lane's reaper fails one no worker
took, someone cancels it, a purge cancels it with its graph. None of those writes to the management
database, where the Inbox is, and a job lives in ``graphver``, which may be another database. So one
sweep, on the transfer lane every minute (``worker._job_reap_loop``), looks at every property job
that has ended and that it hasn't stamped yet, and for each:

1. decides whether its owner (``field_scope.actor``) should hear of it: it completed after a minute
   or more, it failed, or someone else cancelled it (:func:`kind_of`);
2. if so, writes them one notification (``notification_repo.notify``, ``once``);
3. stamps the job ``summary.notifiedAt``, whether it told anyone or not, which takes it out of
   ``ix_jobs_property_unnotified``.

The jobs are taken ``FOR UPDATE SKIP LOCKED``, so two workers never look at one job at once. A
crash between 2 and 3 is safe: the job is looked at again, and the notification, already written
(read or not), isn't written twice. Only jobs that ended in the last ``RECENT_SECS`` are looked at,
so the first sweep after an upgrade, or after the lane was down, never announces old jobs.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Mapping, NamedTuple, Optional

from sqlalchemy import Text, bindparam, select, text
from sqlalchemy.dialects.postgresql import ARRAY

from .. import db
from ..models import JOBS_UNNOTIFIED, BranchORM, JobORM
from .property_job import describe

logger = logging.getLogger(__name__)

#: A job that completed sooner than this after it was asked for was watched to the end: no news.
LONG_SECS = 60
#: How long after a job ends it may still be announced.
RECENT_SECS = 3600
#: The most jobs one sweep looks at.
BATCH = 200
#: How much of a failure's reason goes in its title.
_REASON_CHARS = 120
_BODY_CHARS = 280

COMPLETED, FAILED, CANCELLED = "property_job_completed", "property_job_failed", "property_job_cancelled"

_JOBS = JobORM.__table__.fullname
# Guarded on the job having ended: only an ended job is stamped. ``summary`` may be SQL NULL or a
# JSON null; either starts empty.
_STAMP = text(
    f"UPDATE {_JOBS} SET summary = (CASE WHEN jsonb_typeof(summary) = 'object' THEN summary "
    "ELSE CAST('{}' AS jsonb) END) || jsonb_build_object('notifiedAt', CAST(:now AS text)) "
    "WHERE id = ANY(:ids) AND status IN ('completed', 'failed', 'cancelled')"
).bindparams(bindparam("ids", type_=ARRAY(Text)))


class Ended(NamedTuple):
    """An ended bulk property job, as the sweep reads it, with its draft's name, owner and view."""
    id: str
    status: str
    created_at: Optional[str]
    completed_at: Optional[str]
    error_message: Optional[str]
    workspace_id: Optional[str]
    data_source_id: Optional[str]
    branch_id: Optional[str]
    fields: Mapping[str, Any]
    summary: Mapping[str, Any]
    branch_name: Optional[str] = None
    branch_owner: Optional[str] = None
    view_id: Optional[str] = None


class Notice(NamedTuple):
    kind: str
    user_id: str
    title: str
    body: str
    link: Optional[str]
    actor_id: Optional[str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _secs(start: Optional[str], end: Optional[str]) -> float:
    if not start or not end:
        return 0.0
    return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()


def kind_of(job: Ended) -> Optional[str]:
    """What the job's owner is told, or None: it completed ``LONG_SECS`` or more after it was asked
    for (the wait in the queue counts — they waited for it), it failed, or someone other than its
    owner cancelled it. A cancel that names nobody (a purge's, as its graph is deleted) isn't news."""
    owner = job.fields.get("actor")
    if not owner:
        return None
    if job.status == "failed":
        return FAILED
    if job.status == "cancelled":
        by = job.summary.get("cancelledBy")
        return CANCELLED if by and by != owner else None
    if job.status == "completed" and _secs(job.created_at, job.completed_at) >= LONG_SECS:
        return COMPLETED
    return None


def _count(n: int, edges: bool) -> str:
    noun = ("relationship" if n == 1 else "relationships") if edges else ("entity" if n == 1 else "entities")
    return f"{n:,} {noun}"


def _place(job: Ended, view_name: Optional[str]) -> str:
    """Which draft, as its owner knows it: by its name, else by its view's — most drafts have none."""
    name = (job.branch_name or "").strip() or (view_name or "").strip()
    whose = "your" if job.branch_owner == job.fields.get("actor") else "the"
    if not name:
        return f"{whose} draft"
    return f"{whose} {name}" + ("" if name.lower().endswith("draft") else " draft")


def _reason(job: Ended) -> tuple[str, str]:
    """A failure's reason: its first sentence (for the title), and the rest."""
    failure = job.summary.get("failure") if isinstance(job.summary.get("failure"), dict) else {}
    said = " ".join((job.error_message or failure.get("reason") or "").split())
    first, _, rest = said.partition(". ")
    first = first.rstrip(".") or "it stopped before it finished"
    if len(first) > _REASON_CHARS:
        first = first[:_REASON_CHARS - 1].rsplit(" ", 1)[0] + "…"
    return first, rest.strip()


def compose(job: Ended, view_name: Optional[str]) -> Optional[Notice]:
    """The notification ``job``'s owner gets, or None (:func:`kind_of`). ``view_name``: the name of
    its draft's view, None when it has none or it was deleted — the link then opens the data
    source's drafts in its workspace."""
    kind = kind_of(job)
    if kind is None:
        return None
    op = job.fields.get("op") if isinstance(job.fields.get("op"), dict) else {}
    undo = op.get("kind") == "undo"
    label = (f"Undo of “{op.get('sourceLabel') or 'a bulk change'}”" if undo
             else describe(op) if op else "A bulk change")
    edges = job.fields.get("entityKind") == "edge"
    place = _place(job, view_name)
    s = job.summary
    changed = int(s.get("changed") or 0)
    if kind == COMPLETED and undo:
        since = int(s.get("changedSince") or 0)
        title = (f"{label} finished: {_count(changed, edges)} put back in {place}" if changed
                 else f"{label} finished in {place}")
        body = (f"{since:,} had changed since and {'was' if since == 1 else 'were'} left as "
                f"{'it is' if since == 1 else 'they are'}." if since
                else "Everything it changed is back as it was." if changed
                else "Nothing needed putting back.")
    elif kind == COMPLETED:
        left = int((s.get("refused") or {}).get("count") or 0)
        title = (f"{label} finished on {_count(changed, edges)} in {place}" if changed
                 else f"{label} finished in {place}")
        body = (f"{left:,} {'wasn’t' if left == 1 else 'weren’t'} changed. Open the draft to see "
                "which, and why." if left
                else "Open the draft to review the changes before you publish them." if changed
                else "Nothing needed changing.")
    elif kind == FAILED:
        first, rest = _reason(job)
        title = f"{label} failed: {first}"
        body = f"In {place}. " + (rest or ("What it changed before it stopped stays there." if changed
                                           else "Nothing was changed; you can start it again there."))
    else:
        one = changed == 1
        title = f"{label} was stopped in {place}"
        body = ("Open the draft to see what it put back before then." if undo
                else f"The {_count(changed, edges)} it changed {'stays' if one else 'stay'} in the draft. "
                     f"Undo {'it' if one else 'them'} there, or start again." if changed
                else "It stopped before it changed anything. Open the draft to start it again.")
    if view_name is not None and job.view_id:
        link = f"/views/{job.view_id}?branch={job.branch_id}"
    elif job.workspace_id and job.data_source_id:
        link = f"/workspaces/{job.workspace_id}?ds={job.data_source_id}&dstab=versioning"
    else:
        link = None
    return Notice(kind=kind, user_id=job.fields["actor"], title=title, body=body[:_BODY_CHARS],
                  link=link, actor_id=s.get("cancelledBy") if kind == CANCELLED else None)


def pick(*, cutoff: str, limit: int):
    """The oldest ``limit`` property jobs that ended at ``cutoff`` or since and aren't stamped yet,
    read by ``ix_jobs_property_unnotified`` and locked for this sweep (``SKIP LOCKED``: another
    sweep, on another worker, takes the next ones)."""
    return (select(JobORM.id, JobORM.status, JobORM.created_at, JobORM.completed_at,
                   JobORM.error_message, JobORM.workspace_id, JobORM.data_source_id, JobORM.branch_id,
                   JobORM.scope_view_id, JobORM.field_scope, JobORM.summary)
            .where(text(JOBS_UNNOTIFIED), JobORM.completed_at >= cutoff)
            .order_by(JobORM.completed_at).limit(limit)
            .with_for_update(skip_locked=True))


async def ended(s, *, cutoff: str, limit: int) -> List[Ended]:
    """The jobs :func:`pick` takes, each with its draft's name, owner and view (the view it was
    opened from, else the job's search's)."""
    rows = (await s.execute(pick(cutoff=cutoff, limit=limit))).all()
    drafts = {b.id: b for b in (await s.execute(
        select(BranchORM.id, BranchORM.name, BranchORM.owner, BranchORM.originating_view_id)
        .where(BranchORM.id.in_({r.branch_id for r in rows if r.branch_id})))).all()} if rows else {}
    out = []
    for r in rows:
        b = drafts.get(r.branch_id)
        out.append(Ended(
            id=r.id, status=r.status, created_at=r.created_at, completed_at=r.completed_at,
            error_message=r.error_message, workspace_id=r.workspace_id,
            data_source_id=r.data_source_id, branch_id=r.branch_id,
            fields=r.field_scope if isinstance(r.field_scope, dict) else {},
            summary=r.summary if isinstance(r.summary, dict) else {},
            branch_name=b.name if b else None, branch_owner=b.owner if b else None,
            view_id=(b.originating_view_id if b else None) or r.scope_view_id))
    return out


async def tell(m, jobs: List[Ended]) -> int:
    """Write the notifications ``jobs``' owners get, in management session ``m``: once each, however
    often this is called for a job. Returns how many were written."""
    from backend.app.db.models import ViewORM
    from backend.app.db.repositories import notification_repo

    wanted = {j.view_id for j in jobs if j.view_id and kind_of(j)}
    views = dict((await m.execute(select(ViewORM.id, ViewORM.name).where(
        ViewORM.id.in_(wanted), ViewORM.deleted_at.is_(None)))).all()) if wanted else {}
    written = 0
    for job in jobs:
        notice = compose(job, views.get(job.view_id))
        if notice is None:
            continue
        written += await notification_repo.notify(
            m, user_ids=[notice.user_id], kind=notice.kind, title=notice.title, body=notice.body,
            link=notice.link, actor_id=notice.actor_id, resource_type="property_job",
            resource_id=job.id, once=True)
    return written


class JobNotices:
    """The sweep (see the module docstring). ``session_factory``: graphver sessions;
    ``management``: management-database sessions."""

    def __init__(self, *, session_factory: Optional[Callable] = None,
                 management: Optional[Callable] = None) -> None:
        self._session = session_factory or db.graphver_session
        if management is None:
            from backend.app.db.engine import get_async_session
            management = get_async_session
        self._management = management

    async def run_once(self) -> Dict[str, int]:
        """Look at up to ``BATCH`` ended jobs; returns how many it ``looked`` at and ``told``. The
        notifications are committed before the stamps: if they fail, nothing is stamped and the
        jobs are looked at again next time."""
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=RECENT_SECS)).isoformat()
        async with self._session() as s:
            jobs = await ended(s, cutoff=cutoff, limit=BATCH)
            if not jobs:
                return {"looked": 0, "told": 0}
            async with self._management() as m:
                told = await tell(m, jobs)
            await s.execute(_STAMP, {"ids": [j.id for j in jobs], "now": _now()})
        if told:
            logger.info("job notices: told the owners of %d of %d ended bulk property job(s)",
                        told, len(jobs))
        return {"looked": len(jobs), "told": told}
