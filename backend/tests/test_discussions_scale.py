"""Conversations at scale: reads cost the same however much there is.

A subject's list, a thread and a summary run a fixed number of statements as threads,
participants and messages grow (people resolved once per page, the six faces per thread
in one windowed read, anchor counts in one GROUP BY). Keyset pages stay stable while new
questions arrive. A big group asked at once is cut at 50 and counted.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.db.models import (
    DiscussionMessageORM, DiscussionORM, DiscussionParticipantORM, GroupMemberORM, GroupORM, NotificationORM,
    ResourceGrantORM, UserORM,
)
from backend.app.services.discussions import service
from tests.common import discussions_world as w
from tests.test_api_rbac_phase2 import _count_queries

BASE = "/api/v1/discussions"


@pytest.fixture(autouse=True)
def unlimited(monkeypatch):
    class _Open:
        async def consume(self, *a, **k):
            return True

        async def retry_after_seconds(self, *a, **k):
            return 1

    monkeypatch.setattr(service, "get_account_limiter", lambda: _Open())


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)
    w.switch(True)


async def _seed_threads(session, n: int, *, people: int, replies: int, start: int = 0, subject=w.V_ENT) -> list[str]:
    """``n`` threads on ``subject``, each with ``people`` participants and ``replies`` replies."""
    for i in range(start, start + people):
        if not await session.get(UserORM, f"usr_p{i:04d}"):
            w.add_user(session, f"usr_p{i:04d}")
    ids = []
    for t in range(start, start + n):
        at = f"2026-11-20T10:{t // 60:02d}:{t % 60:02d}+00:00"
        tid = f"dis_s{t:05d}"
        ids.append(tid)
        session.add(DiscussionORM(id=tid, subject_type="view", subject_id=subject, visibility="open",
                                  status="open", asked_by=w.ADA, excerpt="Why?", message_count=1 + replies,
                                  participant_count=people, last_activity_at=at, last_message_by=w.BEN,
                                  created_at=at, updated_at=at, entity_id=f"urn:{t % 3}"))
    await session.flush()
    for tid in ids:
        session.add(DiscussionMessageORM(discussion_id=tid, kind="question", author_id=w.ADA, body="Why?",
                                         created_at="2026-11-20T09:00:00+00:00"))
        for r in range(replies):
            session.add(DiscussionMessageORM(discussion_id=tid, kind="reply", author_id=f"usr_p{start + r % people:04d}",
                                             body=f"Because {r}", created_at=f"2026-11-20T09:{r // 60 + 1:02d}:{r % 60:02d}+00:00"))
        for p in range(people):
            session.add(DiscussionParticipantORM(discussion_id=tid, user_id=f"usr_p{start + p:04d}", joined_via="replied",
                                                 created_at="2026-11-20T09:00:00+00:00",
                                                 posted_at=f"2026-11-20T09:30:{p % 60:02d}+00:00"))
    await session.commit()
    return ids


async def _get(client, session, path, uid=w.ADA, **params):
    claims = await w.claims_for(session, uid)
    with w.acting(uid, claims), _count_queries(session) as counter:
        r = await client.get(path, params=params)
    assert r.status_code == 200, r.text
    return r.json(), counter["n"]


@pytest.mark.asyncio
async def test_a_subjects_list_and_summary_cost_the_same_however_many_threads(world, db_session, test_client):
    await _seed_threads(db_session, 3, people=2, replies=1)
    small, small_n = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}", limit=50)
    _, small_summary = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}/summary")
    await _seed_threads(db_session, 40, people=25, replies=2, start=100)
    big, big_n = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}", limit=50)
    _, big_summary = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}/summary")
    assert len(small["threads"]) == 3 and len(big["threads"]) == 43
    assert big_n == small_n, (small_n, big_n)
    assert big_summary == small_summary
    assert all(len(t["participantIds"]) == 6 for t in big["threads"][:40])
    assert set(big["people"]) >= {pid for t in big["threads"] for pid in t["participantIds"]}


@pytest.mark.asyncio
async def test_a_thread_costs_the_same_however_many_messages_and_people(world, db_session, test_client):
    [small] = await _seed_threads(db_session, 1, people=2, replies=2)
    [big] = await _seed_threads(db_session, 1, people=150, replies=120, start=500)
    _, small_n = await _get(test_client, db_session, f"{BASE}/{small}")
    detail, big_n = await _get(test_client, db_session, f"{BASE}/{big}")
    assert len(detail["messages"]) == 50 and detail["olderCursor"]
    assert big_n == small_n, (small_n, big_n)


@pytest.mark.asyncio
async def test_keyset_pages_stay_stable_while_new_questions_arrive(world, db_session, test_client):
    original = await _seed_threads(db_session, 12, people=1, replies=0)
    first, _ = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}", limit=5)
    # Newer questions arrive between pages; the rest of the walk is unaffected.
    await _seed_threads(db_session, 4, people=1, replies=0, start=200)
    seen = [t["id"] for t in first["threads"]]
    cursor = first["nextCursor"]
    while cursor:
        page, _ = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}", limit=5, cursor=cursor)
        seen += [t["id"] for t in page["threads"]]
        cursor = page["nextCursor"]
    assert seen == sorted(original, reverse=True)


@pytest.mark.asyncio
async def test_a_hundred_and_twenty_member_group_is_cut_at_fifty(world, db_session, test_client):
    db_session.add(GroupORM(id="grp_all", name="All of finance"))
    for i in range(120):
        w.add_user(db_session, f"usr_g{i:03d}")
    await db_session.flush()
    db_session.add_all([GroupMemberORM(group_id="grp_all", user_id=f"usr_g{i:03d}") for i in range(120)])
    db_session.add(ResourceGrantORM(resource_type="view", resource_id=w.V_ENT, subject_type="group",
                                    subject_id="grp_all", role_name="editor"))
    await db_session.commit()
    who, _ = await _get(test_client, db_session, f"{BASE}/subjects/view/{w.V_ENT}/people")
    assert who["truncated"] == 70
    assert len([p for p in who["viewOwners"] if p["groupId"] == "grp_all"]) == 50
    with w.acting(w.ADA, await w.claims_for(db_session, w.ADA)):
        r = await test_client.post(f"{BASE}/subjects/view/{w.V_ENT}", json={"body": "Everyone?", "clientKey": "all"})
    out = r.json()
    assert r.status_code == 201 and len(out["reached"]) == 50 and out["reached"][0] == w.BEN
    assert {"personId": "grp_all", "reason": "group_too_large"} in out["notReached"]
    told = (await db_session.execute(select(NotificationORM).where(NotificationORM.kind == "discussion.asked"))).all()
    assert len(told) == 50
