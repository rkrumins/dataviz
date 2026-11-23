"""What changed since you last looked, watching, and who a publish tells — over HTTP, against Postgres.

* The digest: ``main``'s versions since the reader's marker, newest first, each with what it
  recorded of itself (an import's, a publish's; a fork's beginning nothing), who published them,
  the cap, the last 7 days for a reader with no marker, the reviews waiting on them (asked, not
  approved, or approved before the draft changed again), and the entities they watch that changed.
* A publish, an undo and a restore answer before anyone is told: the worker's pass
  (``digest.tell_pending``) tells each watcher who reads the graph once — the graph's or an
  entity's watcher — never the author, whose caught-up marker moves with the commit; nothing of one
  rolled back; nobody a second time while one is still unread; a pass that fails tells again.
* Hundreds watching: two passes at once tell each of them once, a batch at a time.
* A fork has a digest, a marker and watchers of its own.
* Every query the digest and a publish make is served by an index.

Needs ``GRAPHVER_E2E=1`` and a live Postgres holding both schemas (``MANAGEMENT_DB_URL``).
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import db, digest, models
from backend.app.services.versioning import service as service_mod

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_private_draft_read import _app

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")
WS = "ws1"
V1 = f"/api/v1/{WS}/versioning"


def h(user: str) -> dict:
    return {"X-User": user, "X-Manage": "1", "X-Publish": "1"}


async def _seed(run: str, people, readers) -> str:
    """A data source in ``WS`` labelled after the run, ``people`` in the directory and ``readers``
    reading the workspace. Returns the data source's id."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import (ProviderORM, RoleBindingORM, UserORM, WorkspaceDataSourceORM,
                                       WorkspaceORM)

    ds = f"ds_dg_{run}"
    async with get_async_session() as s:
        if await s.get(WorkspaceORM, WS) is None:
            s.add(WorkspaceORM(id=WS, name="Digest"))
        s.add(ProviderORM(id=f"prov_dg_{run}", name=f"falkor-dg-{run}", provider_type="falkordb"))
        await s.flush()
        s.add(WorkspaceDataSourceORM(id=ds, workspace_id=WS, provider_id=f"prov_dg_{run}",
                                     graph_name=f"gvt_dg_{run}", label=f"Ledger {run}"))
        for uid in people:
            s.add(UserORM(id=uid, email=f"{uid}@example.com", password_hash="x",
                          first_name=uid.split("_")[0].title(), last_name="Smith", status="active",
                          created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z"))
        for uid in readers:
            s.add(RoleBindingORM(subject_type="user", subject_id=uid, role_name="workspace_viewer",
                                 scope_type="workspace", scope_id=WS))
    return ds


async def _told(ds: str) -> dict:
    """What the people watching ``ds`` were told: {user: [(title, body)]}."""
    from sqlalchemy import select
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import NotificationORM

    async with get_async_session() as s:
        rows = (await s.execute(select(NotificationORM).where(
            NotificationORM.resource_id == ds, NotificationORM.kind == digest.KIND)
            .order_by(NotificationORM.created_at))).scalars().all()
    told: dict = {}
    for r in rows:
        told.setdefault(r.user_id, []).append((r.title, r.body, r.link, r.actor_id))
    return told


async def _read(ds: str, user: str) -> None:
    """``user`` reads what they were told of ``ds``."""
    from sqlalchemy import update
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import NotificationORM

    async with get_async_session() as s:
        await s.execute(update(NotificationORM).where(
            NotificationORM.resource_id == ds, NotificationORM.user_id == user,
            NotificationORM.read_at.is_(None)).values(read_at=datetime.now(timezone.utc).isoformat()))
        await s.commit()


def _stage(eid: str, **fields) -> dict:
    return {"ops": [{"op": "update", "entityKind": "node", "entityId": eid, "payload": fields}]}


async def _ids(gid: str) -> dict:
    """urn → entity id of ``gid``'s nodes: an import over HTTP names them ``urn:uuid:…``."""
    from sqlalchemy import select
    from backend.app.services.versioning.models import NodeVersionORM

    async with db.graphver_session() as s:
        return dict((await s.execute(select(NodeVersionORM.urn, NodeVersionORM.entity_id).where(
            NodeVersionORM.graph_id == gid, NodeVersionORM.urn.is_not(None)).distinct())).all())


class _Harness:
    def __init__(self, c, gid):
        self.c, self.gid = c, gid
        self.g = f"{V1}/graphs/{gid}"

    async def digest(self, user):
        r = await self.c.get(f"{self.g}/digest", headers=h(user))
        assert r.status_code == 200, r.text
        return r.json()

    async def seen(self, user, seq):
        r = await self.c.post(f"{self.g}/digest/seen", json={"seq": seq}, headers=h(user))
        assert r.status_code == 200, r.text
        return r.json()

    async def watch(self, user, urn=None):
        r = await self.c.put(f"{self.g}/watch", json={"entityUrn": urn} if urn else {}, headers=h(user))
        assert r.status_code == 200, r.text

    async def draft(self, user, *changes, name="Fixes"):
        """A public draft of ``user``'s with each of ``changes`` (``(entity id, fields)``) saved."""
        b = f"{self.g}/branches"
        r = await self.c.post(b, json={"visibility": "public", "name": name}, headers=h(user))
        assert r.status_code == 201, r.text
        d = r.json()["branchId"]
        for eid, fields in changes:
            r = await self.c.post(f"{b}/{d}/changes", json=_stage(eid, **fields), headers=h(user))
            assert r.status_code == 200, r.text
        r = await self.c.post(f"{b}/{d}/commit", json={}, headers=h(user))
        assert r.status_code == 200, r.text
        return d

    async def publish(self, user, d, message):
        return await self.c.post(f"{self.g}/branches/{d}/publish", json={"message": message},
                                 headers=h(user))


async def _harness(monkeypatch):
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints import graph_digest

    await models.create_schema_and_partitions()
    app, G = _app()
    app.include_router(graph_digest.router, prefix="/api/v1/{ws_id}/versioning/graphs/{graph_id}")
    monkeypatch.setattr(G, "provider_manager", _StubManager())
    monkeypatch.setattr(G, "get_graph_cache", lambda: _StubCache())
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _digest_run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints.versioning import get_versioning_service

    run = os.urandom(3).hex()
    alice, bob, carol, dave = (f"{n}_{run}" for n in ("alice", "bob", "carol", "dave"))
    ds = await _seed(run, (alice, bob, carol, dave), readers=(alice, bob, carol))
    svc = get_versioning_service()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id=WS, actor=alice))["graph_id"]
    label = f"Ledger {run}"
    try:
        async with await _harness(monkeypatch) as c:
            x = _Harness(c, gid)
            r = await c.post(f"{x.g}/bulk-ingest", content=_IMPORT_NDJSON, headers=h(alice))
            assert r.status_code == 200, r.text
            ids = await _ids(gid)
            child, root = ids["urn:t:child"], ids["urn:t:root"]
            assert child != "urn:t:child"                         # watched by urn, kept by id

            # No marker: the last 7 days, newest first, each with what it recorded.
            got = await x.digest(bob)
            assert (got["since"], got["window"], got["head"]["seq"]) == (None, "last_7_days", 2)
            assert [(v["seq"], v["kind"], v["counts"]) for v in got["versions"]] == [
                (2, "import", {"added": 3, "changed": 0, "removed": 0}),        # 2 nodes, 1 edge
                (1, "genesis", {"added": 0, "changed": 0, "removed": 0})]
            assert got["versions"][0]["author"] == {"id": alice, "name": "Alice Smith"}
            assert (got["total"], got["truncated"], got["reviewsWaiting"]) == (2, False, [])
            assert got["authors"] == [{"id": alice, "name": "Alice Smith", "versions": 2}]

            for who in (alice, bob, carol):
                await x.seen(who, 2)
            await x.watch(alice)                                  # the author: never told
            await x.watch(bob)
            await x.watch(carol, "urn:t:child")
            await x.watch(carol, "urn:t:root")                    # left alone by what follows
            await x.watch(dave)                                   # can't read the workspace

            d = await x.draft(alice, (child, {"description": "Owned by finance"}))
            r = await x.publish(alice, d, "Q3 fixes")
            assert r.status_code == 200, r.text
            assert await _told(ds) == {}                          # the publish told nobody itself
            assert await digest.tell_pending() == 2
            link = f"/workspaces/{WS}?ds={ds}&dstab=versioning&whatsnew=1"
            assert await _told(ds) == {
                bob: [(f"New version of “{label}”", "Version #3: “Q3 fixes”. 1 changed.", link,
                       alice)],
                carol: [(f"“Imported Child” changed in “{label}”", "Version #3: “Q3 fixes”. 1 changed.",
                         link, alice)]}

            got = await x.digest(bob)
            assert (got["since"]["seq"], got["window"], got["total"]) == (2, "since_seen", 1)
            [v] = got["versions"]
            assert (v["seq"], v["kind"], v["message"], v["counts"]) == (
                3, "squash_publish", "Q3 fixes", {"added": 0, "changed": 1, "removed": 0})
            assert v["version"] == got["head"]["version"] and v["at"]
            got = await x.digest(carol)
            assert [(w["urn"], w["name"], w["change"], w["seq"]) for w in got["watchedChanged"]] == [
                ("urn:t:child", "Imported Child", "changed", 3)]
            # Alice had seen everything before her own version: she has seen it too.
            got = await x.digest(alice)
            assert (got["since"]["seq"], got["versions"]) == (3, [])

            # A review asking Bob: waiting on him until he approves, and again once it changes.
            d = await x.draft(carol, (root, {"description": "Top"}), name="Roots")
            r = await c.post(f"{x.g}/branches/{d}/merge-requests",
                             json={"title": "Root owners", "reviewers": [bob]}, headers=h(carol))
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]
            assert [(w["id"], w["title"], w["url"], w["author"]["id"])
                    for w in (await x.digest(bob))["reviewsWaiting"]] == [
                (pr, "Root owners", f"/workspaces/{WS}/reviews?pr={pr}", carol)]
            assert (await x.digest(alice))["reviewsWaiting"] == []           # not asked
            r = await c.post(f"{V1}/merge-requests/{pr}/approve", json={}, headers=h(bob))
            assert r.status_code == 200, r.text
            assert (await x.digest(bob))["reviewsWaiting"] == []
            r = await c.post(f"{x.g}/branches/{d}/changes", json=_stage(root, description="Top!"),
                             headers=h(carol))
            assert r.status_code == 200, r.text
            r = await c.post(f"{x.g}/branches/{d}/commit", json={}, headers=h(carol))
            assert r.status_code == 200, r.text
            assert [w["id"] for w in (await x.digest(bob))["reviewsWaiting"]] == [pr]   # stale

            # A review asking a team of Bob's waits on him, as the review inbox has it, until one
            # of the team approves it.
            team = f"g_fin_{run}"

            async def teams(actor):
                return (team,) if actor in (alice, bob) else ()
            with monkeypatch.context() as m:
                m.setattr(service_mod, "_load_actor_groups", teams)
                d2 = await x.draft(carol, (child, {"description": "Team"}), name="Team")
                pr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor=carol, title="Team owners",
                                              reviewer_groups=[team])
                assert [w["id"] for w in (await x.digest(bob))["reviewsWaiting"]] == [pr2, pr]
                r = await c.get(f"{V1}/review-inbox", params={"queue": "needs_review"}, headers=h(bob))
                assert {i["prId"] for i in r.json()["items"]} == {pr2, pr}, r.text
                r = await c.post(f"{V1}/merge-requests/{pr2}/approve", json={}, headers=h(alice))
                assert r.status_code == 200, r.text
                assert [w["id"] for w in (await x.digest(bob))["reviewsWaiting"]] == [pr]

            # An undo tells the graph's watchers, in its own words, once they read what they were
            # told before; Carol's root was not touched.
            await _read(ds, bob)
            await _read(ds, carol)
            commit = (await x.digest(bob))["head"]["version"]
            r = await c.post(f"{x.g}/commits/{commit}/revert", json={}, headers=h(alice))
            assert r.status_code == 200, r.text
            assert await digest.tell_pending() == 2
            told = await _told(ds)
            assert told[bob][-1][:2] == (f"A change to “{label}” was undone",
                                          "Version #4. 1 changed.")
            assert len(told[carol]) == 2 and told[carol][-1][0] == f"“Imported Child” changed in “{label}”"
            assert alice not in told and dave not in told

            # A publish rolled back after it was noted tells nobody; one whose telling fails lands.
            before = await _told(ds)

            async def refuse(*_a, **_kw):
                raise RuntimeError("refused at the last moment")

            d = await x.draft(alice, (child, {"description": "Rolled back"}), name="Gone")
            with monkeypatch.context() as m:
                m.setattr(type(svc), "_resolve_live_prs", refuse)
                with pytest.raises(RuntimeError):
                    await svc.publish(graph_id=gid, branch_id=d, actor=alice, message="never lands")
            assert await digest.tell_pending() == 0
            assert (await x.digest(bob))["head"]["seq"] == 4 and await _told(ds) == before

            # A publish lands whatever its own after-commit step meets; a pass that fails tells
            # nobody and leaves its place, so the next tells them, once. Bob read the undo's; Carol,
            # whose is still unread, is told nothing more.
            async def broken(*_a, **_kw):
                raise ConnectionError("the management database is out of reach")

            with monkeypatch.context() as m:
                m.setattr(digest, "_caught_up", broken)
                r = await x.publish(alice, d, "lands anyway")
                assert r.status_code == 200, r.text
            assert (await x.digest(bob))["head"]["seq"] == 5 and await _told(ds) == before
            await _read(ds, bob)
            with monkeypatch.context() as m:
                m.setattr(digest, "_tell_batch", broken)
                assert await digest.tell_pending() == 0
            assert await _told(ds) == before
            assert await digest.tell_pending() == 1
            told = await _told(ds)
            assert told[bob][-1][:2] == (f"New version of “{label}”",
                                          "Version #5: “lands anyway”. 1 changed.")
            assert told[carol] == before[carol]
            assert await digest.tell_pending() == 0

            # The cap: the newest first, the rest said; and the last 7 days, cut by time.
            monkeypatch.setattr(digest, "VERSIONS_MAX", 2)
            got = await x.digest(bob)
            assert ([v["seq"] for v in got["versions"]], got["truncated"], got["total"]) == ([5, 4], True, 3)
            async with db.graphver_session() as s:
                from sqlalchemy import update
                from backend.app.services.versioning.models import CommitORM
                old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
                await s.execute(update(CommitORM).where(CommitORM.graph_id == gid,
                                                        CommitORM.commit_seq <= 3).values(created_at=old))
            monkeypatch.setattr(digest, "VERSIONS_MAX", 50)
            got = await x.digest(dave)
            assert (got["window"], [v["seq"] for v in got["versions"]], got["total"]) == (
                "last_7_days", [5, 4], 2)
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_digest_and_what_a_publish_tells_its_watchers(data_sources, monkeypatch):
    asyncio.run(_digest_run(monkeypatch))


async def _fork_run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints.versioning import get_versioning_service

    run = os.urandom(3).hex()
    alice, bob = f"alice_{run}", f"bob_{run}"
    ds = await _seed(run, (alice, bob), readers=(alice, bob))
    svc = get_versioning_service()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id=WS, actor=alice))["graph_id"]
    try:
        async with await _harness(monkeypatch) as c:
            parent = _Harness(c, gid)
            r = await c.post(f"{parent.g}/bulk-ingest", content=_IMPORT_NDJSON, headers=h(alice))
            assert r.status_code == 200, r.text
            child = (await _ids(gid))["urn:t:child"]
            fork = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor=alice,
                                        data_source_id=f"dsfork_dg_{run}")
            x = _Harness(c, fork["graph_id"])
            await parent.seen(bob, 2)
            await x.watch(bob)
            got = await x.digest(bob)
            # The fork begins at its parent's head, and its beginning recorded nothing.
            assert [(v["seq"], v["kind"], v["counts"]) for v in got["versions"]] == [(2, "genesis", None)]
            assert got["since"] is None                         # the parent's marker is not its own
            assert (await x.seen(bob, 2))["seq"] == 2
            d = await x.draft(alice, (child, {"description": "Fork only"}))
            r = await x.publish(alice, d, "In the fork")
            assert r.status_code == 200, r.text
            got = await x.digest(bob)
            assert [(v["seq"], v["message"]) for v in got["versions"]] == [(3, "In the fork")]
            assert (await parent.digest(bob))["versions"] == []
            assert await digest.tell_pending() == 1
            told = await _told(f"dsfork_dg_{run}")
            assert [t[0] for t in told[bob]] == ["New version of “this graph”"]   # no row of its own
            assert await _told(ds) == {}
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_fork_has_a_digest_marker_and_watchers_of_its_own(data_sources, monkeypatch, forks_on):
    asyncio.run(_fork_run(monkeypatch))


_PLANNED = ("commits", "node_versions", "merge_requests", "graph_seen", "graph_watches",
            "graph_watch_told", "graphver.graphs", "notifications", "role_bindings", "group_members")


async def _plans_run(monkeypatch) -> None:
    from sqlalchemy import event, text
    from backend.app.api.v1.endpoints.versioning import get_versioning_service
    from backend.app.db import engine as mgmt

    run = os.urandom(3).hex()
    alice, bob = f"alice_{run}", f"bob_{run}"
    ds = await _seed(run, (alice, bob), readers=(alice, bob))
    svc = get_versioning_service()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id=WS, actor=alice))["graph_id"]
    seen, on = [], [False]

    def capture(_conn, _cursor, statement, parameters, _context, _many):
        if on[0] and statement.lstrip().upper().startswith("SELECT") and any(
                t in statement for t in _PLANNED):
            seen.append((statement, parameters))

    try:
        async with await _harness(monkeypatch) as c:
            x = _Harness(c, gid)
            r = await c.post(f"{x.g}/bulk-ingest", content=_IMPORT_NDJSON, headers=h(alice))
            assert r.status_code == 200, r.text
            child = (await _ids(gid))["urn:t:child"]
            await x.watch(bob)
            await x.watch(bob, "urn:t:child")
            await x.seen(bob, 1)
            d = await x.draft(alice, (child, {"description": "Planned"}))
            r = await c.post(f"{x.g}/branches/{d}/merge-requests", json={"reviewers": [bob]},
                             headers=h(alice))
            assert r.status_code == 201, r.text
            for engine in (db.get_engine(), mgmt.get_engine()):
                event.listen(engine.sync_engine, "before_cursor_execute", capture)
            on[0] = True
            await x.digest(bob)
            on[0] = False
            r = await x.publish(alice, d, "planned")
            assert r.status_code == 200, r.text
            on[0] = True
            assert await digest.tell_pending() == 1                 # the watchers told
            on[0] = False
            for engine in (db.get_engine(), mgmt.get_engine()):
                event.remove(engine.sync_engine, "before_cursor_execute", capture)
        tables = {t for s, _p in seen for t in _PLANNED if t in s}
        assert tables == set(_PLANNED), tables
        assert any("graph_watches.data_source_id" in s for s, _p in seen)    # who to tell
        async with db.get_engine().connect() as conn:
            await conn.execute(text("SET enable_seqscan = off"))
            for statement, parameters in seen:
                plan = "\n".join(r[0] for r in (await conn.exec_driver_sql(
                    "EXPLAIN " + statement, parameters)).all())
                # merge_requests is a control-plane table: its live reviews are read through the
                # partial index on them (uq_mr_live_source_branch).
                assert "Seq Scan" not in plan, f"{statement}\n{plan}"
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_every_query_the_digest_and_a_publish_make_is_served_by_an_index(data_sources, monkeypatch):
    asyncio.run(_plans_run(monkeypatch))


async def _crowd_run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints.versioning import get_versioning_service
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories import graph_watch_repo

    run = os.urandom(3).hex()
    author = f"alice_{run}"
    people = [f"w{i:03d}_{run}" for i in range(300)]
    ds = await _seed(run, [author, *people], readers=[author, *people])
    svc = get_versioning_service()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id=WS, actor=author))["graph_id"]
    try:
        async with await _harness(monkeypatch) as c:
            x = _Harness(c, gid)
            r = await c.post(f"{x.g}/bulk-ingest", content=_IMPORT_NDJSON, headers=h(author))
            assert r.status_code == 200, r.text
            await x.watch(people[0])                          # starts the telling at the head
            async with get_async_session() as s:
                for p in people[1:]:
                    await graph_watch_repo.watch(s, p, ds, None)
                await s.commit()
            child = (await _ids(gid))["urn:t:child"]
            d = await x.draft(author, (child, {"description": "For everyone"}))
            r = await x.publish(author, d, "For everyone")
            assert r.status_code == 200, r.text
            assert await _told(ds) == {}                      # the publish told nobody itself
            monkeypatch.setattr(digest, "TELL_BATCH", 40)
            both = await asyncio.gather(digest.tell_pending(), digest.tell_pending())
            assert sum(both) + await digest.tell_pending() == len(people)
            told = await _told(ds)
            assert sorted(told) == sorted(people) and {len(t) for t in told.values()} == {1}
            assert await digest.tell_pending() == 0
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_hundreds_watching_are_each_told_once_by_two_passes_at_once(data_sources, monkeypatch):
    asyncio.run(_crowd_run(monkeypatch))
