"""What conversations do on their own: watcher notices, reminders, retention, archiving.

These pin that a thousand watchers each hear of a new question exactly once — in
batches, across a crash mid-walk — and only those who can open it; that private and
stale questions never fan out; that a question nobody answers reminds the people asked
once and escalates once, and a first response stops both; that what a deleted message
said is blanked after 30 days; that a thread whose subject is gone is archived (and one
whose subject is only soft-deleted is not); and that all of it waits while the switch
is off.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from backend.app.db.models import (
    DiscussionMessageORM, DiscussionORM, DiscussionParticipantORM, NotificationORM, ViewORM, WatchORM,
)
from backend.app.db.repositories import notification_repo
from backend.app.services.discussions import housekeeping as hk
from tests.common import discussions_world as w

NOW = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)
    w.switch(True)


@pytest.fixture
def factory(db_session):
    """Sessions as the control plane opens them: committed on success, rolled back when
    the pass dies."""
    @contextlib.asynccontextmanager
    async def _open():
        try:
            yield db_session
        except BaseException:
            await db_session.rollback()
            raise
    return _open


def _thread(session, tid: str, *, asked_by=w.ADA, subject=("view", w.V_ENT), at: datetime = NOW,
            visibility="open", asked=(w.BEN,), first_response_at=None):
    session.add(DiscussionORM(id=tid, subject_type=subject[0], subject_id=subject[1], visibility=visibility,
                              status="open", asked_by=asked_by, excerpt="Where is revenue from?", message_count=1,
                              participant_count=1 + len(asked), last_activity_at=at.isoformat(),
                              last_message_by=asked_by, created_at=at.isoformat(), updated_at=at.isoformat(),
                              first_response_at=first_response_at))
    session.add(DiscussionParticipantORM(discussion_id=tid, user_id=asked_by, joined_via="asked",
                                         created_at=at.isoformat()))
    for uid in asked:
        session.add(DiscussionParticipantORM(discussion_id=tid, user_id=uid, joined_via="asked_to", asked_to=True,
                                             created_at=at.isoformat()))


async def _told(session, kind: str) -> dict[str, int]:
    rows = (await session.execute(
        select(NotificationORM.user_id, func.count()).where(NotificationORM.kind == kind)
        .group_by(NotificationORM.user_id)
    )).all()
    return dict(rows)


# ── Watchers ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_thousand_watchers_hear_exactly_once_across_a_crash(world, db_session, factory, monkeypatch):
    watchers = [f"usr_w{i:04d}" for i in range(1000)]
    for uid in watchers:
        w.add_user(db_session, uid)
    await db_session.flush()
    # The asker, someone already asked, and a suspended account watch it too.
    db_session.add_all([WatchORM(user_id=u, subject_type="view", subject_id=w.V_ENT)
                        for u in [*watchers, w.ADA, w.BEN, w.CAL]])
    _thread(db_session, "dis_big")
    await db_session.commit()

    real, calls = notification_repo.notify, {"n": 0}

    async def dies_on_the_third_batch(session, **kw):
        calls["n"] += 1
        sent = await real(session, **kw)
        if calls["n"] == 3:
            raise RuntimeError("the process died after sending, before committing")
        return sent

    monkeypatch.setattr(notification_repo, "notify", dies_on_the_third_batch)
    with pytest.raises(RuntimeError):
        await hk.run_pass(factory, now=NOW)
    row = await db_session.get(DiscussionORM, "dis_big")
    await db_session.refresh(row)
    assert sum((await _told(db_session, "discussion.watched")).values()) == 2 * hk.WATCH_BATCH - 3   # two batches kept
    assert row.watchers_notified_at is None and row.watchers_cursor

    monkeypatch.setattr(notification_repo, "notify", real)
    out = await hk.run_pass(factory, now=NOW)
    assert out["fanned"] == 4
    told = await _told(db_session, "discussion.watched")
    assert set(told) == set(watchers) and set(told.values()) == {1}
    await db_session.refresh(row)
    assert row.watchers_notified_at is not None
    assert (await hk.run_pass(factory, now=NOW))["fanned"] == 0
    [one] = await w.notifications(db_session, watchers[0], "discussion.watched")
    assert one.link == f"/views/{w.V_ENT}?discussion=dis_big" and one.actor_id == w.ADA


@pytest.mark.asyncio
async def test_only_readers_hear_and_private_or_stale_questions_never_fan_out(world, db_session, factory):
    db_session.add_all([WatchORM(user_id=u, subject_type="view", subject_id=w.V_WS) for u in (w.GIL, w.EVE)])
    _thread(db_session, "dis_ok", subject=("view", w.V_WS))
    _thread(db_session, "dis_priv", subject=("view", w.V_WS), visibility="private")
    _thread(db_session, "dis_old", subject=("view", w.V_WS), at=NOW - timedelta(hours=25))
    await db_session.commit()
    await hk.run_pass(factory, now=NOW)
    told = await _told(db_session, "discussion.watched")
    assert told == {w.GIL: 1}                                   # Eve can't open a Finance view
    assert [n.resource_id for n in await w.notifications(db_session, w.GIL, "discussion.watched")] == ["dis_ok"]
    old = await db_session.get(DiscussionORM, "dis_old")
    priv = await db_session.get(DiscussionORM, "dis_priv")
    assert old.watchers_notified_at is not None and priv.watchers_notified_at is None


@pytest.mark.asyncio
async def test_nothing_happens_while_the_switch_is_off(world, db_session, factory):
    db_session.add(WatchORM(user_id=w.GIL, subject_type="view", subject_id=w.V_WS))
    _thread(db_session, "dis_wait", subject=("view", w.V_WS), at=NOW - timedelta(days=8))
    await db_session.commit()
    w.switch(False)
    assert (await hk.run_pass(factory, now=NOW))["paused"] is True
    assert await _told(db_session, "discussion.watched") == {}
    assert await _told(db_session, "discussion.reminder") == {}
    # Back on, a question that waited more than a day is marked done without a word.
    w.switch(True)
    await hk.run_pass(factory, now=NOW)
    assert await _told(db_session, "discussion.watched") == {}
    assert (await db_session.get(DiscussionORM, "dis_wait")).watchers_notified_at is not None


# ── Reminders ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reminders_and_escalations_are_sent_once_each(world, db_session, factory):
    _thread(db_session, "dis_quiet", subject=("view", w.V_WS), at=NOW - timedelta(days=4))
    _thread(db_session, "dis_new", subject=("view", w.V_WS), at=NOW - timedelta(days=1))
    _thread(db_session, "dis_answered", subject=("view", w.V_WS), at=NOW - timedelta(days=4),
            first_response_at=(NOW - timedelta(days=3)).isoformat())
    _thread(db_session, "dis_ops", asked_by=w.EVE, subject=("data_source", w.DS_OPS), at=NOW - timedelta(days=8),
            asked=())
    await db_session.commit()

    assert await hk.remind(db_session, now=NOW) == (2, 1)
    assert await hk.remind(db_session, now=NOW) == (0, 0)
    assert await _told(db_session, "discussion.reminder") == {w.BEN: 1}
    # Ops has no admins of its own: its question went to the Org Admins.
    assert await _told(db_session, "discussion.escalated") == {w.OLGA: 1, w.SAM: 1}

    later = NOW + timedelta(days=4)
    assert await hk.remind(db_session, now=later) == (1, 1)          # dis_new reminded; dis_quiet escalated
    escalated = await _told(db_session, "discussion.escalated")
    assert escalated[w.WALT] == 1 and escalated[w.OLGA] == 1         # Finance's own admin, once
    assert await hk.remind(db_session, now=later + timedelta(days=30)) == (0, 1)   # dis_new, at last
    assert (await _told(db_session, "discussion.reminder"))[w.BEN] == 2   # once for each question
    assert [n.resource_id for n in await w.notifications(db_session, w.BEN, "discussion.reminder")
            ].count("dis_answered") == 0


@pytest.mark.asyncio
async def test_a_first_response_stops_the_reminders(world, db_session, factory, test_client):
    from backend.app.services.discussions import service

    class _Open:
        async def consume(self, *a, **k):
            return True

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(service, "get_account_limiter", lambda: _Open())
        with w.acting(w.ADA, await w.claims_for(db_session, w.ADA)):
            r = await test_client.post(f"/api/v1/discussions/subjects/view/{w.V_WS}",
                                       json={"body": "Anyone?", "clientKey": "q"})
        tid = r.json()["thread"]["id"]
        with w.acting(w.BEN, await w.claims_for(db_session, w.BEN)):
            await test_client.post(f"/api/v1/discussions/{tid}/messages", json={"body": "Here.", "clientKey": "a"})
    await db_session.commit()
    assert await hk.remind(db_session, now=datetime.now(timezone.utc) + timedelta(days=8)) == (0, 0)


# ── Retention and archiving ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_what_a_deleted_message_said_is_blanked_after_thirty_days(world, db_session, factory):
    _thread(db_session, "dis_r")
    await db_session.flush()
    for mid, deleted in (("dmsg_old", NOW - timedelta(days=31)), ("dmsg_recent", NOW - timedelta(days=2)),
                         ("dmsg_kept", None)):
        db_session.add(DiscussionMessageORM(id=mid, discussion_id="dis_r", kind="reply", author_id=w.BEN,
                                            body="Secret", mentions=f'["{w.ADA}"]', created_at=NOW.isoformat(),
                                            deleted_at=deleted.isoformat() if deleted else None))
    await db_session.commit()
    assert await hk.retain(db_session, now=NOW) == 1
    rows = {m.id: m for m in (await db_session.execute(
        select(DiscussionMessageORM).execution_options(populate_existing=True))).scalars().all()}
    assert (rows["dmsg_old"].body, rows["dmsg_old"].mentions) == ("", "[]")
    assert rows["dmsg_recent"].body == "Secret" and rows["dmsg_kept"].body == "Secret"
    assert await hk.retain(db_session, now=NOW) == 0


@pytest.mark.asyncio
async def test_a_thread_whose_subject_is_gone_is_archived(world, db_session, factory, test_client):
    _thread(db_session, "dis_gone", subject=("view", "view_purged"))
    _thread(db_session, "dis_ds_gone", subject=("data_source", "ds_purged"))
    _thread(db_session, "dis_soft", subject=("view", w.V_WS))
    _thread(db_session, "dis_live", subject=("data_source", w.DS))
    (await db_session.get(ViewORM, w.V_WS)).deleted_at = NOW.isoformat()
    await db_session.commit()
    assert await hk.archive(db_session, now=NOW) == 2
    assert await hk.archive(db_session, now=NOW) == 0
    archived = {t.id for t in (await db_session.execute(
        select(DiscussionORM).where(DiscussionORM.archived_at.is_not(None))
        .execution_options(populate_existing=True))).scalars().all()}
    assert archived == {"dis_gone", "dis_ds_gone"}
    # The soft-deleted view's thread is hidden, and comes back with the view.
    with w.acting(w.SAM, await w.claims_for(db_session, w.SAM)):
        assert (await test_client.get("/api/v1/discussions/dis_soft")).status_code == 404
        (await db_session.get(ViewORM, w.V_WS)).deleted_at = None
        await db_session.commit()
        assert (await test_client.get("/api/v1/discussions/dis_soft")).status_code == 200
        assert (await test_client.get("/api/v1/discussions/dis_live")).status_code == 200
