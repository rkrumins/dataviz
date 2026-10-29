"""The people of a draft hear what became of it, in their Inbox — over HTTP, needs Postgres.

A draft's people are its owner, its members and whoever committed to it. They hear, never about
their own doing:

* ``draft.sent_for_review`` when a review of it is opened;
* ``draft.published`` when it is published or its review merged;
* ``draft.discarded`` when it is abandoned;
* ``draft.made_private``, the ones it was made private to no longer — what they staged was saved;
* ``draft.transferred``, its new owner, when it is handed to them.

Each is best-effort: a failure to tell anyone never fails the change.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_private_draft_read import _app


def _stage(eid: str, **fields) -> dict:
    return {"ops": [{"op": "update", "entityKind": "node", "entityId": eid,
                     "payload": {"entityType": "Table", **fields}}]}


async def _told(branch_id: str) -> dict:
    """Who was told what about ``branch_id``: {kind: sorted recipients}."""
    from sqlalchemy import select
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import NotificationORM

    async with get_async_session() as session:
        rows = (await session.execute(select(NotificationORM.kind, NotificationORM.user_id).where(
            NotificationORM.resource_id == branch_id))).all()
    told: dict = {}
    for kind, user_id in rows:
        told.setdefault(kind, []).append(user_id)
    return {kind: sorted(users) for kind, users in told.items()}


async def _notifications_run(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints import versioning as ep

    await models.create_schema_and_partitions()
    app, G = _app()

    async def anyone(*_args):
        return None
    monkeypatch.setattr(ep, "_assert_owner_eligible", anyone)
    monkeypatch.setattr(ep, "_assert_member_eligible", anyone)
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"

    def h(user: str) -> dict:
        return {"X-User": user, "X-Manage": "1", "X-Publish": "1"}

    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=h("alice"))
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=h("alice"))
            assert r.status_code == 200, r.text
            B = f"{V1}/graphs/{gid}/branches"

            async def draft(*savers: str) -> str:
                d = (await c.post(B, json={"visibility": "public", "name": "Q3 fixes"},
                                  headers=h("alice"))).json()["branchId"]
                for i, who in enumerate(savers):
                    r = await c.post(f"{B}/{d}/changes", json=_stage("urn:t:child", description=f"{who} {i}"),
                                     headers=h(who))
                    assert r.status_code == 200, r.text
                    r = await c.post(f"{B}/{d}/commit", json={}, headers=h(who))
                    assert r.status_code == 200, r.text
                return d

            # Sent for review, then merged: its other people hear of both.
            d = await draft("bob", "carol")
            r = await c.post(f"{B}/{d}/merge-requests", json={}, headers=h("alice"))
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]
            assert await _told(d) == {"draft.sent_for_review": ["bob", "carol"]}
            r = await c.post(f"{V1}/merge-requests/{pr}/merge", json={"message": "m"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            assert (await _told(d))["draft.published"] == ["bob", "carol"]

            # Published directly, by someone else than its owner: its owner hears too.
            d = await draft("bob")
            r = await c.post(f"{B}/{d}/members", json={"subjectType": "user", "subjectId": "pat",
                                                       "role": "maintainer"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{B}/{d}/publish", json={"message": "m"}, headers=h("pat"))
            assert r.status_code == 200, r.text
            assert await _told(d) == {"draft.published": ["alice", "bob"]}

            # Discarded.
            d = await draft("bob")
            assert (await c.post(f"{B}/{d}/abandon", headers=h("alice"))).status_code == 200
            assert await _told(d) == {"draft.discarded": ["bob"]}

            # Made private: Bob, who no longer reads it, hears; Dave, a member, still reads it.
            d = await draft("bob", "dave")
            r = await c.post(f"{B}/{d}/members", json={"subjectType": "user", "subjectId": "dave",
                                                       "role": "editor"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            r = await c.post(f"{B}/{d}/visibility", json={"visibility": "private"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            assert await _told(d) == {"draft.made_private": ["bob"]}

            # Handed on: its new owner hears.
            r = await c.post(f"{B}/{d}/transfer", json={"to": "erin"}, headers=h("alice"))
            assert r.status_code == 200, r.text
            assert (await _told(d))["draft.transferred"] == ["erin"]
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_people_of_a_draft_hear_what_became_of_it(data_sources, monkeypatch):
    asyncio.run(_notifications_run(monkeypatch))
