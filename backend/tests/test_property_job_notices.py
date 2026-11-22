"""The person who started a bulk property job hears what became of it, once.

The notices sweep (``import_export.job_notices``) tells a job's owner when it completed after a
minute or more, failed, or was stopped by someone else — never of a job they watched to the end,
nor of their own stop. It looks only at jobs that ended in the last hour, so an upgrade never
announces old ones, and at most ``BATCH`` a pass. A notification is written once per job whatever
its read state, so a sweep that dies between telling and stamping tells nobody twice.

What reads ``graphver`` is shown here as the SQL it sends; the sweep itself, on Postgres, is in
``integration/test_property_job_notices_e2e.py``.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from backend.app.db.models import NotificationORM, ViewORM, WorkspaceORM
from backend.app.db.repositories import notification_repo
from backend.app.services.versioning.import_export import job_notices
from backend.app.services.versioning.import_export.job_notices import (
    CANCELLED, COMPLETED, FAILED, Ended, JobNotices, compose, kind_of,
)
from backend.app.services.versioning.models import JOBS_UNNOTIFIED, JobORM

T0 = datetime(2026, 11, 22, 9, 0, tzinfo=timezone.utc)
SET = {"kind": "set", "key": "owner", "value": "ops"}
RENAME = {"kind": "rename", "key": "owner", "to": "steward"}


def _job(status="completed", secs=90, *, op=None, summary=None, actor="alice", **over) -> Ended:
    fields = {"actor": actor, "op": op or SET, **over.pop("fields", {})}
    return Ended(**{
        "id": "vjob_1", "status": status, "created_at": T0.isoformat(),
        "completed_at": (T0 + timedelta(seconds=secs)).isoformat(), "error_message": None,
        "workspace_id": "ws1", "data_source_id": "ds1", "branch_id": "br_1", "fields": fields,
        "summary": summary or {}, "branch_name": None, "branch_owner": "alice", "view_id": "view_1",
        **over})


# ── who hears of what ─────────────────────────────────────────────────────────
def test_a_job_watched_to_the_end_is_no_news():
    assert kind_of(_job(secs=59)) is None
    assert kind_of(_job(secs=60)) == COMPLETED


def test_the_wait_in_the_queue_counts_toward_the_minute():
    """From when it was asked for: a job that waited ten minutes and ran for two seconds was
    waited for."""
    assert kind_of(_job(secs=602)) == COMPLETED


def test_a_failure_is_news_however_quick():
    assert kind_of(_job("failed", secs=1)) == FAILED


def test_a_stop_is_news_only_when_someone_else_made_it():
    assert kind_of(_job("cancelled", summary={"cancelled": True, "cancelledBy": "bob"})) == CANCELLED
    assert kind_of(_job("cancelled", summary={"cancelled": True, "cancelledBy": "alice"})) is None
    # A purge's, as the graph is deleted, names nobody.
    assert kind_of(_job("cancelled", summary={})) is None


def test_a_job_with_no_owner_tells_nobody():
    assert kind_of(_job("failed", actor=None)) is None


# ── what they read ────────────────────────────────────────────────────────────
def test_a_completed_job_says_what_it_did_where():
    n = compose(_job(summary={"changed": 1204}), "Sales")
    assert n.kind == COMPLETED and n.user_id == "alice" and n.actor_id is None
    assert n.title == "Set owner finished on 1,204 entities in your Sales draft"
    assert n.body == "Open the draft to review the changes before you publish them."
    assert n.link == "/views/view_1?branch=br_1"


def test_what_it_couldnt_change_is_counted_with_where_to_see_why():
    n = compose(_job(summary={"changed": 10, "refused": {"count": 3}}), "Sales")
    assert n.body == "3 weren’t changed. Open the draft to see which, and why."


def test_the_drafts_own_name_comes_first_and_a_draft_not_theirs_is_the():
    n = compose(_job(summary={"changed": 1}, branch_name="Q3 fixes", branch_owner="carol"), "Sales")
    assert n.title == "Set owner finished on 1 entity in the Q3 fixes draft"
    assert compose(_job(branch_name="Pricing draft"), None).title.endswith("in your Pricing draft")


def test_a_relationship_job_counts_relationships():
    n = compose(_job(summary={"changed": 2}, fields={"entityKind": "edge"}), "Sales")
    assert n.title == "Set owner finished on 2 relationships in your Sales draft"


def test_a_failure_says_why_and_what_next():
    reason = ("The draft was being published while this job ran, so it stopped. 3 commit(s) it had "
              "written are in the draft's history; the rest was not edited.")
    n = compose(_job("failed", op=RENAME, error_message=reason), "Sales")
    assert n.kind == FAILED
    assert n.title == ("Rename owner → steward failed: The draft was being published while this job "
                       "ran, so it stopped")
    assert n.body == ("In your Sales draft. 3 commit(s) it had written are in the draft's history; "
                      "the rest was not edited.")
    one = compose(_job("failed", error_message="boom", summary={"changed": 5}), "Sales")
    assert one.title == "Set owner failed: boom"
    assert one.body == "In your Sales draft. What it changed before it stopped stays there."
    assert compose(_job("failed", error_message="boom"), "Sales").body == \
        "In your Sales draft. Nothing was changed; you can start it again there."


def test_a_long_reason_is_cut_in_the_title():
    n = compose(_job("failed", error_message="word " * 60), None)
    assert len(n.title) < 160 and n.title.endswith("…")


def test_an_undo_reads_as_an_undo():
    undo = {"kind": "undo", "key": "owner", "sourceJobId": "vjob_0", "sourceLabel": "Set owner"}
    n = compose(_job(op=undo, summary={"changed": 40, "changedSince": 2}), "Sales")
    assert n.title == "Undo of “Set owner” finished: 40 entities put back in your Sales draft"
    assert n.body == "2 had changed since and were left as they are."
    assert compose(_job("failed", op=undo, error_message="boom"), "Sales").title == \
        "Undo of “Set owner” failed: boom"


def test_a_stop_by_someone_else_names_them_as_its_actor():
    n = compose(_job("cancelled", summary={"changed": 300, "cancelledBy": "bob"}), "Sales")
    assert n.kind == CANCELLED and n.actor_id == "bob" and n.user_id == "alice"
    assert n.title == "Set owner was stopped in your Sales draft"
    assert n.body == "The 300 entities it changed stay in the draft. Undo them there, or start again."
    one = compose(_job("cancelled", summary={"changed": 1, "cancelledBy": "bob"}), "Sales")
    assert one.body == "The 1 entity it changed stays in the draft. Undo it there, or start again."
    none = compose(_job("cancelled", summary={"cancelledBy": "bob"}), "Sales")
    assert none.body == "It stopped before it changed anything. Open the draft to start it again."


def test_with_its_view_gone_the_link_opens_the_data_sources_drafts():
    n = compose(_job(summary={"changed": 1}), None)
    assert n.link == "/workspaces/ws1?ds=ds1&dstab=versioning"
    assert n.title == "Set owner finished on 1 entity in your draft"


# ── what the sweep reads ──────────────────────────────────────────────────────
def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def test_the_sweep_reads_the_index_the_oldest_recent_first_a_batch_at_a_time_locked():
    sql = _sql(job_notices.pick(cutoff="2026-11-22T08:00:00+00:00", limit=200))
    assert JOBS_UNNOTIFIED in sql                    # written out, as the index's predicate is
    assert "graphver.jobs.completed_at >= '2026-11-22T08:00:00+00:00'" in sql
    assert "ORDER BY graphver.jobs.completed_at" in sql
    assert sql.rstrip().endswith("LIMIT 200 FOR UPDATE SKIP LOCKED")
    index = next(i for i in JobORM.__table__.indexes if i.name == "ix_jobs_property_unnotified")
    assert [c.name for c in index.columns] == ["completed_at"]
    assert str(index.dialect_options["postgresql"]["where"]) == JOBS_UNNOTIFIED


def test_the_stamp_is_guarded_on_the_job_having_ended():
    stamp = str(job_notices._STAMP)
    assert "'notifiedAt'" in stamp and "status IN ('completed', 'failed', 'cancelled')" in stamp


class _Graphver:
    """What a sweep does in ``graphver``: the stamps it sends, or a crash on the next ``fail``."""

    def __init__(self, fail: int = 0):
        self.stamps: list = []
        self.fail = fail

    async def execute(self, stmt, params=None):
        assert stmt is job_notices._STAMP
        if self.fail:
            self.fail -= 1
            raise RuntimeError("the worker died")
        self.stamps.append(list(params["ids"]))


def _sweep(monkeypatch, db_session, gv: _Graphver, jobs):
    seen: dict = {}

    async def ended(_s, *, cutoff, limit):
        seen.update(cutoff=cutoff, limit=limit)
        stamped = {i for ids in gv.stamps for i in ids}
        return [j for j in jobs if j.id not in stamped][:limit]

    @contextlib.asynccontextmanager
    async def graphver():
        yield gv

    @contextlib.asynccontextmanager
    async def management():
        yield db_session

    monkeypatch.setattr(job_notices, "ended", ended)
    return JobNotices(session_factory=graphver, management=management), seen


async def _told(db_session, job_id=None):
    q = select(NotificationORM).where(NotificationORM.resource_type == "property_job")
    if job_id:
        q = q.where(NotificationORM.resource_id == job_id)
    return (await db_session.execute(q)).scalars().all()


async def test_the_sweep_looks_back_an_hour_and_a_batch_at_most(monkeypatch, db_session):
    sweep, seen = _sweep(monkeypatch, db_session, _Graphver(), [_job("failed", id=f"vjob_{i}")
                                                                for i in range(3)])
    monkeypatch.setattr(job_notices, "BATCH", 2)
    assert await sweep.run_once() == {"looked": 2, "told": 2}
    cutoff = datetime.fromisoformat(seen["cutoff"])
    assert abs((datetime.now(timezone.utc) - cutoff).total_seconds() - 3600) < 60
    assert seen["limit"] == 2
    assert await sweep.run_once() == {"looked": 1, "told": 1}
    assert await sweep.run_once() == {"looked": 0, "told": 0}


async def test_every_job_looked_at_is_stamped_told_or_not(monkeypatch, db_session):
    gv = _Graphver()
    quick, failed = _job(id="vjob_q", secs=5), _job("failed", id="vjob_f")
    sweep, _ = _sweep(monkeypatch, db_session, gv, [quick, failed])
    assert await sweep.run_once() == {"looked": 2, "told": 1}
    assert gv.stamps == [["vjob_q", "vjob_f"]]
    assert [n.resource_id for n in await _told(db_session)] == ["vjob_f"]


async def test_a_sweep_that_dies_before_its_stamp_tells_nobody_twice(monkeypatch, db_session):
    gv = _Graphver(fail=1)
    sweep, _ = _sweep(monkeypatch, db_session, gv, [_job("failed", id="vjob_f", error_message="boom")])
    with pytest.raises(RuntimeError):
        await sweep.run_once()
    assert len(await _told(db_session, "vjob_f")) == 1 and gv.stamps == []
    # Read in between: still not told again.
    await notification_repo.mark_read(db_session, "alice")
    assert await sweep.run_once() == {"looked": 1, "told": 0}
    assert len(await _told(db_session, "vjob_f")) == 1 and gv.stamps == [["vjob_f"]]


async def test_the_link_and_name_come_from_the_view_when_it_is_there(monkeypatch, db_session):
    db_session.add(WorkspaceORM(id="ws1", name="WS"))
    db_session.add(ViewORM(id="view_1", name="Sales", workspace_id="ws1"))
    db_session.add(ViewORM(id="view_gone", name="Old", workspace_id="ws1",
                           deleted_at=T0.isoformat()))
    await db_session.flush()
    jobs = [_job("failed", id="vjob_a", error_message="boom"),
            _job("failed", id="vjob_b", error_message="boom", view_id="view_gone")]
    sweep, _ = _sweep(monkeypatch, db_session, _Graphver(), jobs)
    await sweep.run_once()
    told = {n.resource_id: n for n in await _told(db_session)}
    assert told["vjob_a"].link == "/views/view_1?branch=br_1"
    assert told["vjob_a"].body.startswith("In your Sales draft.")
    assert told["vjob_b"].link == "/workspaces/ws1?ds=ds1&dstab=versioning"


# ── told once, read or not ────────────────────────────────────────────────────
async def test_once_holds_whatever_the_read_state(db_session):
    async def tell(**kw):
        return await notification_repo.notify(
            db_session, user_ids=["alice"], kind=FAILED, title="t", resource_type="property_job",
            resource_id="vjob_once", **kw)

    assert await tell(once=True) == 1
    assert await tell(once=True) == 0
    await notification_repo.mark_read(db_session, "alice")
    assert await tell(once=True) == 0
    # Where an unread one only is looked for, a read one doesn't count.
    assert await tell(dedupe_unread=True) == 1
