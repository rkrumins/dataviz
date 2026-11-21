"""Questions and conversations: asking, replying, answering, closing, reading.

These pin the life of a thread (and what is refused on the way: a closed thread, a
full one, a stale version, someone who may not), that a retried post is answered with
the original, the caps and the rate limit, that conversations go read-only while the
switch is off, who hears what (and who never does: the actor, the muted, anyone who
can't open the subject), that a private thread shows through nothing — not a list, a
count or a summary — and the outbox events, which carry ids and never a body.
"""
from __future__ import annotations

import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from backend.app.db.models import (
    DiscussionORM, DiscussionParticipantORM, GroupMemberORM, NotificationORM, ResourceGrantORM,
)
from backend.app.services.discussions import service
from tests.common import discussions_world as w

BASE = "/api/v1/discussions"


class _Limiter:
    allow = True

    async def consume(self, scope, identity, limit):
        return self.allow

    async def retry_after_seconds(self, scope, identity, limit, consumed=False):
        return 42


@pytest.fixture(autouse=True)
def limiter(monkeypatch):
    held = _Limiter()
    monkeypatch.setattr(service, "get_account_limiter", lambda: held)
    return held


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)
    w.switch(True)


async def call(client: AsyncClient, session, uid: str, method: str, path: str, **kw):
    with w.acting(uid, await w.claims_for(session, uid)):
        return await client.request(method, path, **kw)


async def ask(client, session, uid=w.ADA, subject=f"view/{w.V_WS}", status=201, **body):
    payload = {"body": "Where does revenue come from?", "clientKey": f"k-{uid}-{len(body)}", **body}
    r = await call(client, session, uid, "POST", f"{BASE}/subjects/{subject}", json=payload)
    assert r.status_code == status, r.text
    return r.json()


async def reply(client, session, uid, thread_id, text="From the ledger.", key=None, status=201, **body):
    r = await call(client, session, uid, "POST", f"{BASE}/{thread_id}/messages",
                   json={"body": text, "clientKey": key or f"r-{uid}-{text}", **body})
    assert r.status_code == status, r.text
    return r.json()


async def thread_row(session, tid) -> DiscussionORM:
    return (await session.execute(
        select(DiscussionORM).where(DiscussionORM.id == tid).execution_options(populate_existing=True)
    )).scalar_one()


# ── Asking ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_asking_reaches_the_owners_and_says_who_it_could_not(world, db_session, test_client):
    out = await ask(test_client, db_session, recipientIds=[w.EVE], entityId="urn:li:dataset:gl",
                    entityLabel="gl_entries")
    thread = out["thread"]
    assert out["reached"] == [w.BEN] and out["usedFallback"] is False
    assert out["notReached"] == [{"personId": w.EVE, "reason": "cannot_read"}]
    assert thread["status"] == "open" and thread["messageCount"] == 1 and thread["version"] == 1
    assert thread["subject"] == {"type": "view", "id": w.V_WS, "name": "Workspace ledger", "workspaceId": w.WS,
                                 "workspaceName": "Finance", "link": f"/views/{w.V_WS}"}
    assert thread["entityId"] == "urn:li:dataset:gl" and thread["participantCount"] == 2
    assert [m["roles"] for m in thread["messages"]] == [["asker"]]
    assert {w.ADA, w.BEN} <= set(thread["people"])
    [told] = await w.notifications(db_session, w.BEN, "discussion.asked")
    assert told.link == f"/views/{w.V_WS}?discussion={thread['id']}"
    assert await w.notifications(db_session, w.ADA) == []            # never the actor
    [event] = await w.events(db_session, "collaboration.discussion.asked")
    payload = json.loads(event.payload)
    assert payload["discussion_id"] == thread["id"] and "revenue" not in event.payload


@pytest.mark.asyncio
async def test_a_retried_ask_is_answered_with_the_original(world, db_session, test_client):
    first = await ask(test_client, db_session, clientKey="same")
    again = await ask(test_client, db_session, clientKey="same", status=200)
    assert again["thread"]["id"] == first["thread"]["id"] and again["reached"] == [w.BEN]
    assert len((await db_session.execute(select(DiscussionORM))).scalars().all()) == 1
    assert len(await w.notifications(db_session, w.BEN, "discussion.asked")) == 1


@pytest.mark.asyncio
async def test_a_question_about_a_data_source_links_to_its_questions_tab(world, db_session, test_client):
    out = await ask(test_client, db_session, subject=f"data_source/{w.DS}", route={"viewOwners": True,
                                                                                    "dataContacts": True})
    assert out["reached"] == [w.BEN]                                  # its derived owner
    [told] = await w.notifications(db_session, w.BEN, "discussion.asked")
    assert told.link == (f"/workspaces/{w.WS}?tab=data&section=sources&ds={w.DS}&dstab=questions"
                         f"&discussion={out['thread']['id']}")


@pytest.mark.asyncio
async def test_what_a_post_may_say_and_who_it_may_mention(world, db_session, test_client):
    for body in ("   ", "x" * 10_001):
        r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/subjects/view/{w.V_WS}",
                       json={"body": body, "clientKey": "k"})
        assert r.status_code == 422 and r.json()["detail"]["type"] == "body_invalid"
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/subjects/view/{w.V_WS}",
                   json={"body": "Hi", "clientKey": "k", "mentions": [w.EVE, w.GIL]})
    assert r.status_code == 422
    assert r.json()["detail"] == {"type": "cannot_mention", "message": r.json()["detail"]["message"],
                                  "personIds": [w.EVE]}
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/subjects/view/{w.V_WS}",
                   json={"body": "Hi", "clientKey": "k", "mentions": [f"usr_{i}" for i in range(21)]})
    assert r.status_code == 422
    out = await ask(test_client, db_session, mentions=[w.GIL])
    assert out["thread"]["messages"][0]["mentions"] == [w.GIL]
    assert len(await w.notifications(db_session, w.GIL, "discussion.mentioned")) == 1
    # A subject you can't open can't be asked about.
    r = await call(test_client, db_session, w.EVE, "POST", f"{BASE}/subjects/view/{w.V_WS}",
                   json={"body": "Hi", "clientKey": "k2"})
    assert r.status_code == 404 and r.json()["detail"]["type"] == "not_found"


@pytest.mark.asyncio
async def test_posting_too_fast_is_refused_with_when_to_try_again(world, db_session, test_client, limiter):
    limiter.allow = False
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/subjects/view/{w.V_WS}",
                   json={"body": "Hi", "clientKey": "k"})
    assert r.status_code == 429
    assert r.headers["Retry-After"] == "42" and r.json()["detail"]["type"] == "rate_limited"


@pytest.mark.asyncio
async def test_a_service_account_never_writes(world, db_session, test_client):
    r = await call(test_client, db_session, w.BOT, "POST", f"{BASE}/subjects/view/{w.V_WS}",
                   json={"body": "Hi", "clientKey": "k"})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "person_required"


# ── Replying ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_replies_move_the_counters_and_a_retry_is_the_original(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    own = await reply(test_client, db_session, w.ADA, tid, "Anyone?")
    assert own["thread"]["messageCount"] == 2
    assert (await thread_row(db_session, tid)).first_response_at is None      # the asker isn't a response
    out = await reply(test_client, db_session, w.BEN, tid, key="ben-1")
    row = await thread_row(db_session, tid)
    assert out["thread"]["messageCount"] == 3 and row.first_response_at is not None
    assert row.last_message_by == w.BEN and out["message"]["roles"] == ["view_owner", "data_owner"]
    again = await reply(test_client, db_session, w.BEN, tid, key="ben-1", status=200)
    assert again["message"]["id"] == out["message"]["id"]
    assert (await thread_row(db_session, tid)).message_count == 3
    # Someone new who replies joins the thread.
    await reply(test_client, db_session, w.GIL, tid, "Me too")
    assert (await thread_row(db_session, tid)).participant_count == 3


@pytest.mark.asyncio
async def test_replies_ring_once_per_thread_and_never_the_muted(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    await reply(test_client, db_session, w.BEN, tid, "First")
    await reply(test_client, db_session, w.BEN, tid, "Second")
    assert len(await w.notifications(db_session, w.ADA, "discussion.replied")) == 1     # dedupe_unread
    r = await call(test_client, db_session, w.ADA, "PUT", f"{BASE}/{tid}/me", json={"muted": True})
    assert r.json() == {"muted": True, "following": True}
    await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/read")
    await reply(test_client, db_session, w.BEN, tid, "Third")
    unread = [n for n in await w.notifications(db_session, w.ADA, "discussion.replied") if n.read_at is None]
    assert unread == []
    # Unfollowing stops replies too; a mention still reaches someone following nothing.
    await call(test_client, db_session, w.ADA, "PUT", f"{BASE}/{tid}/me", json={"muted": False, "following": False})
    await reply(test_client, db_session, w.BEN, tid, "Fourth")
    assert [n for n in await w.notifications(db_session, w.ADA, "discussion.replied") if n.read_at is None] == []
    await reply(test_client, db_session, w.BEN, tid, "Fifth, Ada?", mentions=[w.ADA])
    assert len(await w.notifications(db_session, w.ADA, "discussion.mentioned")) == 1


@pytest.mark.asyncio
async def test_a_closed_or_full_thread_takes_no_replies(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    await db_session.execute(update(DiscussionORM).where(DiscussionORM.id == tid).values(message_count=501))
    r = await call(test_client, db_session, w.BEN, "POST", f"{BASE}/{tid}/messages", json={"body": "x", "clientKey": "a"})
    assert r.status_code == 422 and r.json()["detail"]["type"] == "too_many_replies"
    await db_session.execute(update(DiscussionORM).where(DiscussionORM.id == tid).values(
        message_count=2, participant_count=200))
    r = await call(test_client, db_session, w.GIL, "POST", f"{BASE}/{tid}/messages", json={"body": "x", "clientKey": "b"})
    assert r.status_code == 422 and r.json()["detail"]["type"] == "too_many_participants"
    await reply(test_client, db_session, w.BEN, tid, "Already in it, so fine")
    await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/close",
               json={"expectedVersion": (await thread_row(db_session, tid)).version})
    r = await call(test_client, db_session, w.BEN, "POST", f"{BASE}/{tid}/messages", json={"body": "x", "clientKey": "c"})
    assert r.status_code == 409 and r.json()["detail"]["type"] == "wrong_status"


@pytest.mark.asyncio
async def test_editing_is_the_authors_and_checked_against_its_version(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    m = (await reply(test_client, db_session, w.BEN, tid, "Typo"))["message"]
    path = f"{BASE}/{tid}/messages/{m['id']}"
    r = await call(test_client, db_session, w.ADA, "PATCH", path, json={"body": "Mine", "expectedVersion": 1})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "not_author"
    r = await call(test_client, db_session, w.BEN, "PATCH", path, json={"body": "Fixed", "expectedVersion": 1})
    assert r.status_code == 200 and r.json()["message"]["editedAt"] and r.json()["message"]["version"] == 2
    r = await call(test_client, db_session, w.BEN, "PATCH", path, json={"body": "Again", "expectedVersion": 1})
    assert r.status_code == 409
    assert r.json()["detail"]["type"] == "stale" and r.json()["detail"]["current"]["body"] == "Fixed"
    r = await call(test_client, db_session, w.BEN, "PATCH", path, json={"body": "Fixed", "expectedVersion": 1})
    assert r.status_code == 200                                     # already says that
    # Editing the question changes the excerpt lists show.
    q = (await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}")).json()["messages"][0]
    await call(test_client, db_session, w.ADA, "PATCH", f"{BASE}/{tid}/messages/{q['id']}",
               json={"body": "Where does profit come from?", "expectedVersion": 1})
    assert (await thread_row(db_session, tid)).excerpt == "Where does profit come from?"


# ── Answering and closing ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_accepting_an_answer(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    m = (await reply(test_client, db_session, w.BEN, tid))["message"]
    r = await call(test_client, db_session, w.GIL, "POST", f"{BASE}/{tid}/answer",
                   json={"messageId": m["id"], "expectedVersion": 1})
    assert r.status_code == 403                                     # a reader, not the asker
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/answer",
                   json={"messageId": m["id"], "expectedVersion": 1})
    assert r.status_code == 200, r.text
    thread = r.json()["thread"]
    assert thread["status"] == "answered" and thread["answerMessageId"] == m["id"] and thread["version"] == 2
    assert thread["resolvedBy"] == w.ADA and thread["resolvedAt"] and w.ADA in r.json()["people"]
    assert len(await w.notifications(db_session, w.BEN, "discussion.answered")) == 1
    # Asking again is fine; asking from an old version for something else is stale.
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/answer",
                   json={"messageId": m["id"], "expectedVersion": 1})
    assert r.status_code == 200 and r.json()["thread"]["version"] == 2
    r = await call(test_client, db_session, w.ADA, "DELETE", f"{BASE}/{tid}/answer", json={"expectedVersion": 1})
    assert r.status_code == 409 and r.json()["detail"]["current"]["version"] == 2
    r = await call(test_client, db_session, w.BEN, "DELETE", f"{BASE}/{tid}/answer", json={"expectedVersion": 2})
    assert r.status_code == 200 and r.json()["thread"]["status"] == "open" and r.json()["thread"]["resolvedBy"] is None
    [event] = await w.events(db_session, "collaboration.discussion.answered")
    assert json.loads(event.payload)["message_id"] == m["id"]


@pytest.mark.asyncio
async def test_closing_tells_the_asker_when_someone_else_did_it(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    r = await call(test_client, db_session, w.GIL, "POST", f"{BASE}/{tid}/close", json={"expectedVersion": 1})
    assert r.status_code == 403                                     # neither asker, asked, owner nor admin
    r = await call(test_client, db_session, w.BEN, "POST", f"{BASE}/{tid}/close", json={"expectedVersion": 1})
    assert r.status_code == 200 and r.json()["thread"]["status"] == "closed"
    assert r.json()["thread"]["resolvedBy"] == w.BEN
    assert len(await w.notifications(db_session, w.ADA, "discussion.closed")) == 1
    r = await call(test_client, db_session, w.BEN, "POST", f"{BASE}/{tid}/close", json={"expectedVersion": 1})
    assert r.status_code == 200                                     # already closed
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/reopen", json={"expectedVersion": 1})
    assert r.status_code == 409 and r.json()["detail"]["type"] == "stale"
    r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/reopen", json={"expectedVersion": 2})
    assert r.status_code == 200 and r.json()["thread"]["status"] == "open"
    # Closing your own question tells nobody.
    await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/close", json={"expectedVersion": 3})
    assert len(await w.notifications(db_session, w.ADA, "discussion.closed")) == 1
    kinds = [e.event_type for e in await w.events(db_session, "collaboration.discussion.")]
    assert kinds.count("collaboration.discussion.closed") == 2 and "collaboration.discussion.reopened" in kinds


@pytest.mark.asyncio
async def test_two_people_answering_at_once_one_wins_and_the_other_is_stale(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    a = (await reply(test_client, db_session, w.BEN, tid, "A"))["message"]["id"]
    b = (await reply(test_client, db_session, w.WALT, tid, "B"))["message"]["id"]
    first = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/answer",
                       json={"messageId": a, "expectedVersion": 1})
    second = await call(test_client, db_session, w.BEN, "POST", f"{BASE}/{tid}/answer",
                        json={"messageId": b, "expectedVersion": 1})
    assert first.status_code == 200 and second.status_code == 409
    assert second.json()["detail"]["current"]["answerMessageId"] == a


# ── Deleting ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deleting_messages_and_questions(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    m = (await reply(test_client, db_session, w.BEN, tid, "Secret sauce"))["message"]
    await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/answer",
               json={"messageId": m["id"], "expectedVersion": 1})
    r = await call(test_client, db_session, w.GIL, "DELETE", f"{BASE}/{tid}/messages/{m['id']}")
    assert r.status_code == 403
    r = await call(test_client, db_session, w.WALT, "DELETE", f"{BASE}/{tid}/messages/{m['id']}")  # an admin
    assert r.status_code == 200
    gone = r.json()["message"]
    assert gone["body"] == "" and gone["deletedAt"] and r.json()["thread"]["status"] == "open"   # un-accepted
    [event] = await w.events(db_session, "collaboration.discussion_message.deleted")
    assert "sauce" not in event.payload
    r = await call(test_client, db_session, w.GIL, "DELETE", f"{BASE}/{tid}")
    assert r.status_code == 403
    r = await call(test_client, db_session, w.ADA, "DELETE", f"{BASE}/{tid}")
    assert r.status_code == 204
    assert (await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}")).status_code == 404
    assert len(await w.events(db_session, "collaboration.discussion.deleted")) == 1


# ── Read-only while the switch is off ───────────────────────────────


@pytest.mark.asyncio
async def test_with_the_switch_off_conversations_are_read_only(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    m = (await reply(test_client, db_session, w.BEN, tid))["message"]
    w.switch(False)
    for method, path, body in (
        ("POST", f"{BASE}/subjects/view/{w.V_WS}", {"body": "Hi", "clientKey": "z"}),
        ("POST", f"{BASE}/{tid}/messages", {"body": "Hi", "clientKey": "y"}),
        ("PATCH", f"{BASE}/{tid}/messages/{m['id']}", {"body": "Hi", "expectedVersion": 1}),
    ):
        r = await call(test_client, db_session, w.BEN, method, path, json=body)
        assert r.status_code == 403 and r.json()["detail"]["type"] == "feature_disabled", path
    r = await call(test_client, db_session, w.GIL, "PUT", f"{BASE}/{tid}/me", json={"following": True})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "feature_disabled"
    got = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}")
    assert got.status_code == 200 and got.json()["access"]["canReply"] is False
    assert (await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/read")).status_code == 200
    assert (await call(test_client, db_session, w.ADA, "PUT", f"{BASE}/{tid}/me", json={"muted": True})).status_code == 200
    assert (await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/close",
                       json={"expectedVersion": 1})).status_code == 200
    assert (await call(test_client, db_session, w.ADA, "DELETE", f"{BASE}/{tid}")).status_code == 204


# ── Private threads and what shows of them ──────────────────────────


@pytest.mark.asyncio
async def test_a_private_question_shows_through_nothing(world, db_session, test_client):
    private = (await ask(test_client, db_session, visibility="private", clientKey="p",
                         entityId="urn:x"))["thread"]
    await ask(test_client, db_session, uid=w.GIL, clientKey="o", entityId="urn:x")
    assert private["privateAudience"][0] == w.ADA and set(private["privateAudience"]) >= {w.BEN, w.WALT}
    assert w.GIL not in private["privateAudience"]

    async def seen_by(uid):
        listed = (await call(test_client, db_session, uid, "GET", f"{BASE}/subjects/view/{w.V_WS}")).json()
        summary = (await call(test_client, db_session, uid, "GET", f"{BASE}/subjects/view/{w.V_WS}/summary")).json()
        one = await call(test_client, db_session, uid, "GET", f"{BASE}/{private['id']}")
        return len(listed["threads"]), summary["total"], summary["byEntity"]["urn:x"]["total"], one.status_code

    assert await seen_by(w.GIL) == (1, 1, 1, 404)            # a reader who isn't in it
    assert await seen_by(w.ADA) == (2, 2, 2, 200)            # the asker
    assert await seen_by(w.BEN) == (2, 2, 2, 200)            # the view's owner, asked
    assert await seen_by(w.WALT) == (2, 2, 2, 200)           # the workspace's admin
    r = await call(test_client, db_session, w.GIL, "POST", f"{BASE}/{private['id']}/messages",
                   json={"body": "Peek", "clientKey": "peek"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_losing_access_hides_the_thread_and_getting_it_back_returns_it(world, db_session, test_client):
    tid = (await ask(test_client, db_session, uid=w.GIL))["thread"]["id"]
    member = (await db_session.execute(select(GroupMemberORM).where(GroupMemberORM.user_id == w.GIL))).scalar_one()
    await db_session.delete(member)
    await db_session.commit()
    assert (await call(test_client, db_session, w.GIL, "GET", f"{BASE}/{tid}")).status_code == 404
    db_session.add(GroupMemberORM(group_id=w.G_VIEWERS, user_id=w.GIL))
    await db_session.commit()
    assert (await call(test_client, db_session, w.GIL, "GET", f"{BASE}/{tid}")).status_code == 200


# ── Lists, summaries, reading, mentions ─────────────────────────────


@pytest.mark.asyncio
async def test_unread_until_read_and_the_summary_etag(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    url = f"{BASE}/subjects/view/{w.V_WS}/summary"
    first = await call(test_client, db_session, w.BEN, "GET", url)
    assert first.json()["unread"] == 1 and first.json()["open"] == 1 and first.json()["watching"] is False
    etag = first.headers["ETag"]
    same = await call(test_client, db_session, w.BEN, "GET", url, headers={"If-None-Match": etag})
    assert same.status_code == 304
    listed = (await call(test_client, db_session, w.BEN, "GET", f"{BASE}/subjects/view/{w.V_WS}")).json()
    assert listed["threads"][0]["unread"] is True and listed["latest"]
    read = await call(test_client, db_session, w.BEN, "POST", f"{BASE}/{tid}/read")
    assert read.json()["lastReadAt"]
    assert [n.read_at for n in await w.notifications(db_session, w.BEN, "discussion.asked")] != [None]
    after = await call(test_client, db_session, w.BEN, "GET", url, headers={"If-None-Match": etag})
    assert after.status_code == 200 and after.json()["unread"] == 0


@pytest.mark.asyncio
async def test_list_filters_and_a_bad_cursor(world, db_session, test_client):
    a = (await ask(test_client, db_session, clientKey="a", entityId="urn:a"))["thread"]["id"]
    b = (await ask(test_client, db_session, uid=w.GIL, clientKey="b"))["thread"]["id"]
    m = (await reply(test_client, db_session, w.BEN, a))["message"]["id"]
    await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{a}/answer", json={"messageId": m, "expectedVersion": 1})

    async def ids(**params):
        r = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/view/{w.V_WS}", params=params)
        assert r.status_code == 200, r.text
        return [t["id"] for t in r.json()["threads"]]

    assert await ids() == [a, b]                                    # most recently active first
    assert await ids(status="answered") == [a] and await ids(status="open") == [b]
    assert await ids(entityId="urn:a") == [a] and await ids(mine="true") == [a]
    page = (await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/view/{w.V_WS}",
                       params={"limit": 1})).json()
    assert [t["id"] for t in page["threads"]] == [a] and page["nextCursor"]
    assert await ids(cursor=page["nextCursor"]) == [b]
    r = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/view/{w.V_WS}", params={"cursor": "nope"})
    assert r.status_code == 400 and r.json()["detail"]["type"] == "invalid_cursor"
    r = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/view/{w.V_WS}", params={"limit": 51})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_a_thread_pages_back_and_polls_forward(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    for i in range(4):
        await reply(test_client, db_session, w.BEN, tid, f"Reply {i}")
    newest = (await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}", params={"limit": 2})).json()
    assert [m["body"] for m in newest["messages"]] == ["Reply 2", "Reply 3"] and newest["olderCursor"]
    older = (await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}",
                        params={"limit": 10, "cursor": newest["olderCursor"]})).json()
    assert [m["kind"] for m in older["messages"]] == ["question", "reply", "reply"] and older["olderCursor"] is None
    since = newest["messages"][-1]["createdAt"]
    await reply(test_client, db_session, w.BEN, tid, "Reply 4")
    polled = (await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}", params={"since": since})).json()
    assert [m["body"] for m in polled["messages"]] == ["Reply 4"]


@pytest.mark.asyncio
async def test_mentionable_people_can_open_it(world, db_session, test_client):
    r = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/view/{w.V_WS}/mentionable",
                   params={"q": "i"})
    found = {p["id"]: p["hint"] for p in r.json()["people"]}
    assert w.GIL in found and w.EVE not in found and w.GINA not in found and w.ADA not in found
    r = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/view/{w.V_WS}/mentionable")
    assert [(p["id"], p["hint"]) for p in r.json()["people"]] == [(w.BEN, "View owner")]
    r = await call(test_client, db_session, w.BEN, "GET", f"{BASE}/subjects/view/{w.V_PRIV}/mentionable",
                   params={"q": "a"})
    assert {p["id"] for p in r.json()["people"]} <= {w.WALT, w.OLGA, w.SAM, w.GINA, w.RITA}


@pytest.mark.asyncio
async def test_following_a_thread_joins_it(world, db_session, test_client):
    tid = (await ask(test_client, db_session))["thread"]["id"]
    r = await call(test_client, db_session, w.GIL, "PUT", f"{BASE}/{tid}/me", json={"following": True})
    assert r.json() == {"muted": False, "following": True}
    row = (await db_session.execute(select(DiscussionParticipantORM).where(
        DiscussionParticipantORM.discussion_id == tid, DiscussionParticipantORM.user_id == w.GIL,
    ))).scalar_one()
    assert row.joined_via == "followed"
    await reply(test_client, db_session, w.BEN, tid)
    assert len(await w.notifications(db_session, w.GIL, "discussion.replied")) == 1
    assert (await db_session.execute(select(NotificationORM).where(NotificationORM.user_id == w.EVE))).first() is None


@pytest.mark.asyncio
async def test_a_retry_racing_its_original_is_caught_by_the_unique_key(world, db_session, test_client, monkeypatch):
    """Two copies of one post in flight both miss the up-front lookup; the second's insert
    meets the unique (author, clientKey) index, its savepoint rolls back — counters
    untouched — and it answers 200 with the first."""
    tid = (await ask(test_client, db_session))["thread"]["id"]
    first = await reply(test_client, db_session, w.BEN, tid, key="race")
    real = service.repo.message_by_key
    calls = {"n": 0}

    async def miss_once(session, author_id, client_key):
        calls["n"] += 1
        return None if calls["n"] == 1 else await real(session, author_id, client_key)

    monkeypatch.setattr(service.repo, "message_by_key", miss_once)
    again = await reply(test_client, db_session, w.BEN, tid, key="race", status=200)
    assert again["message"]["id"] == first["message"]["id"] and calls["n"] == 2
    assert (await thread_row(db_session, tid)).message_count == 2


# ── Watching, and your own conversations ────────────────────────────


@pytest.mark.asyncio
async def test_watching_a_subject(world, db_session, test_client):
    url = f"{BASE}/subjects/view/{w.V_WS}/watch"
    assert (await call(test_client, db_session, w.GIL, "PUT", url)).json() == {"watching": True}
    assert (await call(test_client, db_session, w.GIL, "PUT", url)).json() == {"watching": True}   # still once
    assert (await call(test_client, db_session, w.EVE, "PUT", url)).status_code == 404            # can't open it
    await ask(test_client, db_session)
    await ask(test_client, db_session, visibility="private", clientKey="priv")
    listed = (await call(test_client, db_session, w.GIL, "GET", "/api/v1/me/watches")).json()
    assert [(i["subject"]["id"], i["open"]) for i in listed["items"]] == [(w.V_WS, 1)]   # not the private one
    w.switch(False)
    assert (await call(test_client, db_session, w.GIL, "PUT", url)).status_code == 403
    assert (await call(test_client, db_session, w.GIL, "DELETE", url)).json() == {"watching": False}
    assert (await call(test_client, db_session, w.GIL, "GET", "/api/v1/me/watches")).json()["items"] == []


@pytest.mark.asyncio
async def test_your_boxes_and_what_is_waiting(world, db_session, test_client):
    to_ben = (await ask(test_client, db_session, clientKey="1"))["thread"]["id"]            # asked of Ben
    mine = (await ask(test_client, db_session, uid=w.BEN, clientKey="2", mentions=[w.ADA]))["thread"]["id"]
    await call(test_client, db_session, w.BEN, "PUT", f"{BASE}/subjects/view/{w.V_ENT}/watch")
    watched = (await ask(test_client, db_session, uid=w.EVE, subject=f"view/{w.V_ENT}", clientKey="3",
                         route={"viewOwners": False, "dataContacts": False}))["thread"]["id"]

    async def box(uid, name, **params):
        r = await call(test_client, db_session, uid, "GET", "/api/v1/me/discussions", params={"box": name, **params})
        assert r.status_code == 200, r.text
        return [t["id"] for t in r.json()["threads"]]

    assert await box(w.BEN, "to-me") == [to_ben]
    assert await box(w.BEN, "mine") == [mine]
    assert await box(w.ADA, "mentions") == [mine]
    assert await box(w.BEN, "watching") == [watched]
    assert await box(w.BEN, "to-me", status="closed") == []
    url = "/api/v1/me/discussions/summary"
    summary = await call(test_client, db_session, w.BEN, "GET", url)
    assert summary.json() == {"toMe": {"unread": 1, "waiting": 1}, "mine": {"unread": 0, "open": 1},
                              "mentions": {"unread": 0}, "watching": {"unread": 0}, "totalUnread": 1}
    assert (await call(test_client, db_session, w.BEN, "GET", url,
                       headers={"If-None-Match": summary.headers["ETag"]})).status_code == 304
    await reply(test_client, db_session, w.BEN, to_ben, "On it")
    after = (await call(test_client, db_session, w.BEN, "GET", url)).json()
    assert after["toMe"] == {"unread": 0, "waiting": 0}


@pytest.mark.asyncio
async def test_a_box_reads_past_subjects_you_can_no_longer_open(world, db_session, test_client):
    """Threads about a subject the caller lost are left out of a page without leaving it
    short, and the cursor moves past what was skipped."""
    keep = [(await ask(test_client, db_session, uid=w.GIL, clientKey=f"k{i}"))["thread"]["id"] for i in range(2)]
    # Gil can open the private view for a while, asks there, then loses it.
    db_session.add(ResourceGrantORM(resource_type="view", resource_id=w.V_PRIV, subject_type="user",
                                      subject_id=w.GIL, role_name="viewer"))
    await db_session.commit()
    gone = [(await ask(test_client, db_session, uid=w.GIL, subject=f"view/{w.V_PRIV}", clientKey=f"g{i}"))
            ["thread"]["id"] for i in range(3)]
    grant = (await db_session.execute(select(ResourceGrantORM).where(ResourceGrantORM.subject_id == w.GIL))).scalar_one()
    await db_session.delete(grant)
    await db_session.commit()
    r = await call(test_client, db_session, w.GIL, "GET", "/api/v1/me/discussions", params={"box": "mine", "limit": 2})
    page = r.json()
    assert [t["id"] for t in page["threads"]] == list(reversed(keep)) and page["nextCursor"] is None
    assert not set(gone) & {t["id"] for t in page["threads"]}
    summary = (await call(test_client, db_session, w.GIL, "GET", "/api/v1/me/discussions/summary")).json()
    assert summary["mine"]["open"] == 2


# ── Private threads on data sources and in your boxes ───────────────


@pytest.mark.asyncio
async def test_a_private_question_about_a_data_source_shows_through_nothing(world, db_session, test_client):
    subject = f"data_source/{w.DS}"
    private = (await ask(test_client, db_session, subject=subject, visibility="private", clientKey="p",
                         entityId="urn:x"))["thread"]
    await ask(test_client, db_session, uid=w.GIL, subject=subject, clientKey="o", entityId="urn:x")

    async def seen_by(uid):
        listed = (await call(test_client, db_session, uid, "GET", f"{BASE}/subjects/{subject}")).json()
        summary = (await call(test_client, db_session, uid, "GET", f"{BASE}/subjects/{subject}/summary")).json()
        one = await call(test_client, db_session, uid, "GET", f"{BASE}/{private['id']}")
        return len(listed["threads"]), summary["total"], summary["byEntity"]["urn:x"]["total"], one.status_code

    assert await seen_by(w.GIL) == (1, 1, 1, 404)            # a reader who isn't in it
    assert await seen_by(w.ADA) == (2, 2, 2, 200)            # the asker
    assert await seen_by(w.BEN) == (2, 2, 2, 200)            # the source's derived owner, asked
    assert await seen_by(w.WALT) == (2, 2, 2, 200)           # the workspace's admin


@pytest.mark.asyncio
async def test_a_private_question_never_shows_in_what_you_watch(world, db_session, test_client):
    from backend.app.services.discussions import housekeeping as hk

    await call(test_client, db_session, w.GIL, "PUT", f"{BASE}/subjects/view/{w.V_WS}/watch")
    await ask(test_client, db_session, visibility="private", clientKey="p")
    shared = (await ask(test_client, db_session, clientKey="o"))["thread"]["id"]
    while await hk.fan_out_one(db_session):
        pass
    await db_session.commit()
    r = await call(test_client, db_session, w.GIL, "GET", "/api/v1/me/discussions", params={"box": "watching"})
    assert r.status_code == 200 and [t["id"] for t in r.json()["threads"]] == [shared]
    summary = (await call(test_client, db_session, w.GIL, "GET", "/api/v1/me/discussions/summary")).json()
    assert summary == {"toMe": {"unread": 0, "waiting": 0}, "mine": {"unread": 0, "open": 0},
                       "mentions": {"unread": 0}, "watching": {"unread": 1}, "totalUnread": 1}


@pytest.mark.asyncio
async def test_a_data_source_in_the_trash_hides_its_threads_and_restoring_it_shows_them(world, db_session,
                                                                                      test_client):
    from backend.app.db.repositories import data_source_repo

    subject = f"data_source/{w.DS}"
    tid = (await ask(test_client, db_session, subject=subject))["thread"]["id"]

    async def seen():
        one = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/{tid}")
        listed = await call(test_client, db_session, w.ADA, "GET", f"{BASE}/subjects/{subject}")
        mine = await call(test_client, db_session, w.ADA, "GET", "/api/v1/me/discussions", params={"box": "mine"})
        summary = await call(test_client, db_session, w.ADA, "GET", "/api/v1/me/discussions/summary")
        return (one.status_code, listed.status_code, [t["id"] for t in mine.json()["threads"]],
                summary.json()["mine"]["open"])

    assert await seen() == (200, 200, [tid], 1)
    assert await data_source_repo.soft_delete_data_source(db_session, w.DS, actor=w.WALT)
    await db_session.commit()
    assert await seen() == (404, 404, [], 0)
    assert await data_source_repo.restore_data_source(db_session, w.DS) is not None
    await db_session.commit()
    assert await seen() == (200, 200, [tid], 1)


@pytest.mark.asyncio
async def test_answering_closing_and_reopening_are_counted(world, db_session, test_client, monkeypatch):
    from backend.app.jobs import metrics

    counted = w.Counted()
    monkeypatch.setattr(metrics, "_backend", counted)
    tid = (await ask(test_client, db_session))["thread"]["id"]
    m = (await reply(test_client, db_session, w.BEN, tid))["message"]
    for path, body in (("answer", {"messageId": m["id"], "expectedVersion": 1}),
                       ("answer", {"messageId": m["id"], "expectedVersion": 2}),     # already: not again
                       ("close", {"expectedVersion": 2}), ("reopen", {"expectedVersion": 3})):
        r = await call(test_client, db_session, w.ADA, "POST", f"{BASE}/{tid}/{path}", json=body)
        assert r.status_code == 200, r.text
    assert {k: v for k, v in counted.counts.items() if k.startswith("discussions_")} == {
        "discussions_asked_total": 1, "discussions_replies_total": 1, "discussions_answered_total": 1,
        "discussions_closed_total": 1, "discussions_reopened_total": 1,
    }
