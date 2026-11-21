"""Question counts for a page of cards: ``GET /discussions/summaries``.

What each card shows is what its subject's own summary says — the same private-thread
audience, the same unread rule — for up to 100 subjects in a fixed number of reads.
Subjects the caller can't open, and those with nothing to show, are left out, so the
answer never says that one exists.
"""
from __future__ import annotations

import pytest
from sqlalchemy import update

from backend.app.db.models import (
    DiscussionORM, DiscussionParticipantORM, ViewORM, WorkspaceDataSourceORM,
)
from backend.app.services.discussions import service
from tests.common import discussions_world as w
from tests.test_api_rbac_phase2 import _count_queries

BASE = "/api/v1/discussions"
URL = f"{BASE}/summaries"
VIEWS = [w.V_PRIV, w.V_WS, w.V_ENT, "view_nope"]
SOURCES = [w.DS, w.DS_OPS, "ds_gone", "ds_nope"]


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


async def call(client, session, uid, path, **kw):
    with w.acting(uid, await w.claims_for(session, uid)):
        return await client.get(path, **kw)


async def counts(client, session, uid, subject_type, ids, **kw):
    r = await call(client, session, uid, URL, params={"type": subject_type, "ids": ids}, **kw)
    assert r.status_code == 200, r.text
    return r.json()["summaries"]


async def ask(client, session, uid, subject, key, **body):
    with w.acting(uid, await w.claims_for(session, uid)):
        r = await client.post(f"{BASE}/subjects/{subject}", json={"body": "Why?", "clientKey": key, **body})
    assert r.status_code == 201, r.text
    return r.json()["thread"]["id"]


def thread(tid, subject_type, subject_id, *, asked_by, visibility="private", status="open", at=w.T0):
    return DiscussionORM(id=tid, subject_type=subject_type, subject_id=subject_id, visibility=visibility,
                         status=status, asked_by=asked_by, excerpt="Why?", message_count=1, participant_count=1,
                         last_activity_at=at, last_message_by=asked_by, created_at=at, updated_at=at)


def asker(tid, uid):
    return DiscussionParticipantORM(discussion_id=tid, user_id=uid, joined_via="asked", created_at=w.T0,
                                    last_read_at=w.T0)


async def seed_threads(session, client):
    """Open and private questions on the views and the sources, in every state."""
    a = await ask(client, session, w.ADA, f"view/{w.V_WS}", "a")
    await ask(client, session, w.ADA, f"view/{w.V_WS}", "b", visibility="private")
    c = await ask(client, session, w.GIL, f"view/{w.V_WS}", "c")
    await ask(client, session, w.ADA, f"data_source/{w.DS}", "d")
    await ask(client, session, w.ADA, f"data_source/{w.DS}", "e", visibility="private")
    await ask(client, session, w.EVE, f"data_source/{w.DS_OPS}", "f")
    await session.execute(update(DiscussionORM).where(DiscussionORM.id == a).values(status="answered"))
    await session.execute(update(DiscussionORM).where(DiscussionORM.id == c).values(status="closed"))
    # Private, asked by Rita alone: Gina (an editor grantee) maintains the view without being in it.
    session.add(thread("dis_rita", "view", w.V_PRIV, asked_by=w.RITA))
    # A source in the trash, with a question on it.
    session.add(WorkspaceDataSourceORM(id="ds_gone", workspace_id=w.WS, provider_id="prov", graph_name="gone",
                                       label="Gone", created_by=w.BEN, created_at=w.T0, updated_at=w.T0,
                                       deleted_at=w.T0))
    await session.flush()
    session.add_all([asker("dis_rita", w.RITA), thread("dis_gone", "data_source", "ds_gone", asked_by=w.ADA,
                                                        visibility="open")])
    await session.commit()


# ── What a card shows ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_each_count_is_what_the_subjects_own_summary_says(world, db_session, test_client):
    await seed_threads(db_session, test_client)
    for uid in (w.ADA, w.BEN, w.WALT, w.GIL, w.GINA, w.RITA, w.EVE, w.OSCAR, w.OLGA):
        for subject_type, ids in (("view", VIEWS), ("data_source", SOURCES)):
            batch = await counts(test_client, db_session, uid, subject_type, ids)
            expected = {}
            for i in ids:
                one = await call(test_client, db_session, uid, f"{BASE}/subjects/{subject_type}/{i}/summary")
                if one.status_code == 200 and one.json()["total"]:
                    expected[i] = {k: one.json()[k] for k in ("open", "answered", "total", "unread")}
            assert batch == expected, (uid, subject_type)


@pytest.mark.asyncio
async def test_a_private_thread_counts_only_for_its_audience(world, db_session, test_client):
    await seed_threads(db_session, test_client)
    on_ws = {uid: (await counts(test_client, db_session, uid, "view", [w.V_WS])).get(w.V_WS, {}).get("total")
             for uid in (w.GIL, w.ADA, w.BEN, w.WALT)}
    assert on_ws == {w.GIL: 2, w.ADA: 3, w.BEN: 3, w.WALT: 3}   # Gil isn't in Ada's private one
    on_priv = {uid: (await counts(test_client, db_session, uid, "view", [w.V_PRIV])).get(w.V_PRIV, {}).get("open")
               for uid in (w.RITA, w.GINA, w.BEN, w.WALT)}
    assert on_priv == {w.RITA: 1, w.GINA: 1, w.BEN: 1, w.WALT: 1}   # asker, maintainers, admin
    on_ds = {uid: (await counts(test_client, db_session, uid, "data_source", [w.DS])).get(w.DS, {}).get("total")
             for uid in (w.GIL, w.ADA, w.BEN)}
    assert on_ds == {w.GIL: 1, w.ADA: 2, w.BEN: 2}


@pytest.mark.asyncio
async def test_unread_is_what_the_reader_has_not_read(world, db_session, test_client):
    await seed_threads(db_session, test_client)
    ben = await counts(test_client, db_session, w.BEN, "view", [w.V_WS])
    assert ben[w.V_WS] == {"open": 1, "answered": 1, "total": 3, "unread": 3}   # asked of him, all three
    assert (await counts(test_client, db_session, w.ADA, "view", [w.V_WS]))[w.V_WS]["unread"] == 0


@pytest.mark.asyncio
async def test_subjects_the_caller_cant_open_and_those_with_nothing_are_left_out(world, db_session, test_client):
    await seed_threads(db_session, test_client)
    assert await counts(test_client, db_session, w.EVE, "view", VIEWS) == {}             # Ops only
    assert set(await counts(test_client, db_session, w.EVE, "data_source", SOURCES)) == {w.DS_OPS}
    assert set(await counts(test_client, db_session, w.GIL, "view", VIEWS)) == {w.V_WS}  # not the private view
    assert set(await counts(test_client, db_session, w.SAM, "data_source", SOURCES)) == {w.DS, w.DS_OPS}  # not the trash
    assert w.V_ENT not in await counts(test_client, db_session, w.ADA, "view", VIEWS)    # no questions


@pytest.mark.asyncio
async def test_how_many_ids_and_how_long(world, db_session, test_client):
    def get(**params):
        return call(test_client, db_session, w.ADA, URL, params=params)

    assert (await get(type="view", ids=[f"v{i}" for i in range(100)])).status_code == 200
    assert (await get(type="view", ids=[f"v{i}" for i in range(101)])).status_code == 422
    assert (await get(type="view")).status_code == 422
    assert (await get(type="view", ids=["x" * 129])).status_code == 422
    assert (await get(type="graph", ids=["v1"])).status_code == 422
    assert (await get(type="view", ids=[w.V_WS, w.V_WS])).status_code == 200


# ── Cost, caching, the switch ────────────────────────────────────────


async def _views_with_questions(session, n: int) -> list[str]:
    """``n`` workspace views, each with an open question and a private one Ada isn't in."""
    ids = [f"view_n{i:03d}" for i in range(n)]
    session.add_all([ViewORM(id=v, name=v, workspace_id=w.WS, data_source_id=w.DS, visibility="workspace",
                             created_by=w.BEN) for v in ids])
    await session.flush()
    for v in ids:
        session.add_all([thread(f"o_{v}", "view", v, asked_by=w.GIL, visibility="open"),
                         thread(f"p_{v}", "view", v, asked_by=w.GIL)])
    await session.flush()
    session.add_all([asker(f"p_{v}", w.GIL) for v in ids] + [asker(f"o_{v}", w.GIL) for v in ids])
    await session.commit()
    return ids


async def _sources_with_questions(session, n: int) -> list[str]:
    ids = [f"ds_n{i:03d}" for i in range(n)]
    session.add_all([WorkspaceDataSourceORM(id=d, workspace_id=w.WS, provider_id="prov", graph_name=d, label=d,
                                            created_by=w.BEN, created_at=w.T0, updated_at=w.T0) for d in ids])
    await session.flush()
    for d in ids:
        session.add_all([thread(f"o_{d}", "data_source", d, asked_by=w.GIL, visibility="open"),
                         thread(f"p_{d}", "data_source", d, asked_by=w.GIL)])
    await session.flush()
    session.add_all([asker(f"p_{d}", w.GIL) for d in ids])
    await session.commit()
    return ids


@pytest.mark.asyncio
@pytest.mark.parametrize("subject_type, make", [("view", _views_with_questions),
                                                ("data_source", _sources_with_questions)])
async def test_a_hundred_cards_cost_what_one_does(world, db_session, test_client, subject_type, make):
    ids = await make(db_session, 100)
    claims = await w.claims_for(db_session, w.ADA)

    async def run(some):
        with w.acting(w.ADA, claims), _count_queries(db_session) as counter:
            r = await test_client.get(URL, params={"type": subject_type, "ids": some})
        assert r.status_code == 200, r.text
        return r.json()["summaries"], counter["n"]

    one, one_n = await run(ids[:1])
    many, many_n = await run(ids)
    assert one == {ids[0]: {"open": 1, "answered": 0, "total": 1, "unread": 0}}
    assert len(many) == 100 and all(c == one[ids[0]] for c in many.values())
    assert many_n == one_n, (one_n, many_n)


@pytest.mark.asyncio
async def test_an_unchanged_answer_is_a_304(world, db_session, test_client):
    await seed_threads(db_session, test_client)
    first = await call(test_client, db_session, w.BEN, URL, params={"type": "view", "ids": VIEWS})
    etag = first.headers["ETag"]
    assert first.headers["Cache-Control"] == "private, max-age=0, must-revalidate"
    same = await call(test_client, db_session, w.BEN, URL, params={"type": "view", "ids": VIEWS},
                      headers={"If-None-Match": etag})
    assert same.status_code == 304
    await ask(test_client, db_session, w.ADA, f"view/{w.V_ENT}", "new")
    moved = await call(test_client, db_session, w.BEN, URL, params={"type": "view", "ids": VIEWS},
                       headers={"If-None-Match": etag})
    assert moved.status_code == 200 and moved.json()["summaries"][w.V_ENT]["open"] == 1


@pytest.mark.asyncio
async def test_counts_still_read_with_the_switch_off(world, db_session, test_client):
    await seed_threads(db_session, test_client)
    w.switch(False)
    assert (await counts(test_client, db_session, w.ADA, "view", [w.V_WS]))[w.V_WS]["total"] == 3
