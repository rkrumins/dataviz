"""What changed since you last looked, and watching, over HTTP (``endpoints/graph_digest.py``) on the
unit harness: the real routes, permissions and repository against SQLite, the versioning store's
answer stood in for (``digest.read``), and who a publish tells (``digest.tell_watchers``) against
the same database.

* Each route has the data-source read in the graph's workspace as its gate; a graph elsewhere is
  a 404; an API key is refused.
* A marker and a watch are their owner's alone; the marker only moves forward, save from past
  the head of a graph re-created under its data source.
* No marker: the last 7 days, said so. The versions, their counts (null where none were
  recorded), the cap, the authors, the reviews and the watched entities, as the store answers.
* A fork is read and marked like any graph, forks on or off.
* A publish tells each watcher who may read the graph once, never its author; a caught-up author
  has seen it; telling nobody never raises.

The store's own queries, the notifications a real publish sends and their query plans run against
Postgres: ``integration/test_graph_digest_live.py``.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from backend.app.api.v1.endpoints import graph_digest
from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth import api_key_surface
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.models import (GraphSeenORM, GraphWatchORM, NotificationORM, ProviderORM,
                                   UserORM, WorkspaceDataSourceORM, WorkspaceORM)
from backend.app.db.repositories import graph_watch_repo
from backend.app.main import app
from backend.app.services import permission_service
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import digest
from backend.auth_service.interface import User

_V = "/api/v1/ws_1/versioning/graphs/{}"
_LEAVES = ("workspace:datasource:read", "workspace:view:read")
PERSONAS = {
    "member": PermissionClaims(sid="sess_test", ws_perms={"ws_1": _LEAVES}),
    "member_elsewhere": PermissionClaims(sid="sess_test", ws_perms={"ws_2": _LEAVES}),
    "no_read": PermissionClaims(sid="sess_test", ws_perms={"ws_1": ("workspace:view:read",)}),
}
HEAD = 215
GRAPHS = {"g_1": ("ws_1", "ds_1", None), "g_fork": ("ws_1", "dsfork_1", "g_1"),
          "g_9": ("ws_2", "ds_9", None)}


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid.title(), last_name="Tester",
                role="user", status="active")


def as_(uid: str, persona: str = "member") -> None:
    app.dependency_overrides[get_current_user] = lambda: _user(uid)
    app.dependency_overrides[get_permission_claims] = lambda: PERSONAS[persona]


def _version(seq: int, actor="usr_alice", counts=(3, 1, 0), kind="squash_publish") -> dict:
    return {"seq": seq, "commitId": f"cmt_{seq}", "kind": kind, "message": f"Change {seq}",
            "actor": actor, "at": f"2026-11-16T10:{seq % 60:02d}:00+00:00",
            "counts": None if counts is None else dict(zip(("added", "changed", "removed"), counts, strict=True))}


class _Versioning:
    """The versioning service, as the routes ask it: each graph's row."""

    async def get_graph(self, graph_id):
        if graph_id not in GRAPHS:
            return None
        ws, ds, parent = GRAPHS[graph_id]
        return {"graph_id": graph_id, "workspace_id": ws, "data_source_id": ds,
                "fork_parent_graph_id": parent, "deleted_at": None, "main_head_commit_seq": HEAD}


class _Store:
    """``digest.read``, as the versioning store answers it: records what it was asked."""

    def __init__(self):
        self.asked = []
        self.versions = [_version(s) for s in range(HEAD, HEAD - 5, -1)]
        self.truncated = False
        self.reviews = []
        self.watched = []

    async def read(self, svc, *, graph_id, after, cutoff, actor, urns, limit=None):
        self.asked.append(SimpleNamespace(graph_id=graph_id, after=after, cutoff=cutoff, actor=actor,
                                          urns=sorted(urns)))
        if after is not None and after > HEAD:      # an earlier graph's marker: the time window
            after = None
        shown = [v for v in self.versions if after is None or v["seq"] > after]
        return {"head": {"seq": HEAD, "commitId": f"cmt_{HEAD}"}, "after": after,
                "versions": shown, "truncated": self.truncated,
                "total": HEAD - after if after is not None else (None if self.truncated else len(shown)),
                "reviews": self.reviews, "reviewsMore": False, "watched": self.watched}


@pytest.fixture
async def world(test_client, db_session, monkeypatch):
    db_session.add_all([
        WorkspaceORM(id="ws_1", name="Finance"), WorkspaceORM(id="ws_2", name="Elsewhere"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_1", provider_id="prov_1",
                               graph_name="g_fin", label="Ledger"),
        WorkspaceDataSourceORM(id="dsfork_1", workspace_id="ws_1", provider_id="prov_1",
                               label="Ledger fork", fork_of_data_source_id="ds_1"),
        *[UserORM(id=f"usr_{n}", email=f"{n}@example.com", password_hash="x", first_name=n.title(),
                  last_name="Smith", status="active", created_at="2024-01-01T00:00:00Z",
                  updated_at="2024-01-01T00:00:00Z") for n in ("alice", "bob", "carol")],
    ])
    await db_session.commit()
    store = _Store()
    monkeypatch.setattr(digest, "read", store.read)
    app.dependency_overrides[get_versioning_service] = lambda: _Versioning()
    as_("usr_bob")
    return SimpleNamespace(store=store, session=db_session)


# ── The gates ─────────────────────────────────────────────────────────────────────────────────────
_ROUTES = {(m, "/api/v1/{ws_id}/versioning/graphs/{graph_id}" + p)
           for m, p in (("GET", "/digest"), ("POST", "/digest/seen"), ("GET", "/watch"),
                        ("PUT", "/watch"), ("DELETE", "/watch"))}


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_each_route_reads_the_data_source_and_none_is_open_to_an_api_key():
    found = {(m, p): (r, d) for m, p, r, d in api_key_surface.routes(app) if (m, p) in _ROUTES}
    assert set(found) == _ROUTES
    for key, (route, dependant) in found.items():
        assert _gate_perms(dependant) == {"workspace:datasource:read"}, key
        assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE
    every = {route.endpoint.__name__ for _m, _p, route, _d in api_key_surface.routes(app)
             if route.endpoint.__module__ == graph_digest.__name__}
    assert every == {r.endpoint.__name__ for r, _d in found.values()}


@pytest.mark.parametrize("persona, status", [("member", 200), ("member_elsewhere", 403),
                                             ("no_read", 403)])
async def test_the_digest_is_read_with_the_data_source_read_in_its_workspace(world, test_client,
                                                                              persona, status):
    as_("usr_bob", persona)
    for method, path, kw in (("GET", "/digest", {}), ("POST", "/digest/seen", {"json": {"seq": 1}}),
                             ("GET", "/watch", {}), ("PUT", "/watch", {"json": {}}),
                             ("DELETE", "/watch", {})):
        got = await test_client.request(method, _V.format("g_1") + path, **kw)
        assert got.status_code == status, (method, path, got.text)


async def test_a_graph_of_another_workspace_or_none_at_all_is_not_found(world, test_client):
    for gid in ("g_9", "g_nope"):
        assert (await test_client.get(_V.format(gid) + "/digest")).status_code == 404
        assert (await test_client.put(_V.format(gid) + "/watch", json={})).status_code == 404
        assert (await test_client.post(_V.format(gid) + "/digest/seen",
                                       json={"seq": 1})).status_code == 404
    assert world.store.asked == []


# ── The marker ────────────────────────────────────────────────────────────────────────────────────
async def test_with_no_marker_the_digest_covers_the_last_seven_days_and_says_so(world, test_client):
    before = datetime.now(timezone.utc)
    got = await test_client.get(_V.format("g_1") + "/digest")
    assert got.status_code == 200, got.text
    body = got.json()
    assert (body["since"], body["window"]) == (None, "last_7_days")
    asked = world.store.asked[-1]
    assert (asked.graph_id, asked.after, asked.actor) == ("g_1", None, "usr_bob")
    assert before - timedelta(days=7, seconds=5) <= asked.cutoff <= datetime.now(timezone.utc) - timedelta(days=7)
    assert body["total"] == 5 and [v["seq"] for v in body["versions"]] == [215, 214, 213, 212, 211]


async def test_the_marker_only_moves_forward(world, test_client):
    url = _V.format("g_1") + "/digest/seen"
    first = (await test_client.post(url, json={"seq": 212})).json()
    assert first["seq"] == 212 and first["at"]
    assert (await test_client.post(url, json={"seq": 210})).json()["seq"] == 212    # never back
    assert (await test_client.post(url, json={"seq": 214})).json()["seq"] == 214
    refused = await test_client.post(url, json={"seq": HEAD + 1})                 # not published
    assert refused.status_code == 422 and refused.json()["detail"]["type"] == "not_published_yet"
    assert (await test_client.post(url, json={"seq": -1})).status_code == 422
    body = (await test_client.get(_V.format("g_1") + "/digest")).json()
    assert body["since"]["seq"] == 214 and body["window"] == "since_seen"
    assert world.store.asked[-1].after == 214
    assert [v["seq"] for v in body["versions"]] == [215] and body["total"] == 1


async def test_a_marker_past_the_head_is_of_an_earlier_graph_and_moves_back(world, test_client):
    world.session.add(GraphSeenORM(user_id="usr_bob", data_source_id="ds_1", seen_seq=900,
                                   seen_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))
    await world.session.commit()
    body = (await test_client.get(_V.format("g_1") + "/digest")).json()
    assert (body["since"], body["window"]) == (None, "last_7_days")
    moved = await test_client.post(_V.format("g_1") + "/digest/seen", json={"seq": 3})
    assert moved.json()["seq"] == 3


async def test_markers_and_watches_are_each_persons_own(world, test_client):
    as_("usr_alice")
    await test_client.post(_V.format("g_1") + "/digest/seen", json={"seq": 214})
    await test_client.put(_V.format("g_1") + "/watch", json={})
    await test_client.put(_V.format("g_1") + "/watch", json={"entityUrn": "urn:t:orders"})
    as_("usr_bob")
    body = (await test_client.get(_V.format("g_1") + "/digest")).json()
    assert body["since"] is None and world.store.asked[-1].urns == []
    assert (await test_client.get(_V.format("g_1") + "/watch")).json() == {
        "graph": False, "entities": [], "entitiesMax": graph_watch_repo.ENTITIES_MAX}
    # Bob's own writes leave Alice's rows as they were.
    await test_client.post(_V.format("g_1") + "/digest/seen", json={"seq": 211})
    await test_client.delete(_V.format("g_1") + "/watch", params={"entityUrn": "urn:t:orders"})
    rows = (await world.session.execute(select(GraphSeenORM.user_id, GraphSeenORM.seen_seq)
                                        .order_by(GraphSeenORM.user_id))).all()
    assert [tuple(r) for r in rows] == [("usr_alice", 214), ("usr_bob", 211)]
    watches = (await world.session.execute(select(GraphWatchORM.user_id, GraphWatchORM.entity_urn))).all()
    assert sorted((tuple(w) for w in watches), key=lambda w: (w[0], w[1] or "")) == [
        ("usr_alice", None), ("usr_alice", "urn:t:orders")]
    as_("usr_alice")
    await test_client.get(_V.format("g_1") + "/digest")
    assert world.store.asked[-1].urns == ["urn:t:orders"] and world.store.asked[-1].after == 214


# ── What the digest says ──────────────────────────────────────────────────────────────────────────
async def test_the_digest_names_people_keeps_unrecorded_counts_null_and_links_reviews(world,
                                                                                      test_client):
    world.store.versions = [_version(215, "usr_alice"), _version(214, None, counts=None, kind="sync"),
                            _version(213, "usr_carol"), _version(212, "usr_alice"),
                            _version(211, "usr_gone", counts=(0, 0, 0))]
    world.store.truncated = True
    world.store.reviews = [{"id": "pr_1", "title": "Q4 owners", "author": "usr_carol",
                            "at": "2026-11-16T09:00:00+00:00"}]
    world.store.watched = [{"urn": "urn:t:orders", "entityId": "e_orders", "name": "Orders",
                            "change": "changed", "seq": 213, "at": "2026-11-16T10:13:00+00:00"}]
    body = (await test_client.get(_V.format("g_1") + "/digest")).json()
    assert set(body) == {"since", "window", "head", "versions", "total", "truncated", "authors",
                         "reviewsWaiting", "reviewsMore", "watchedChanged"}
    assert body["head"] == {"seq": 215, "version": "cmt_215"}
    assert (body["truncated"], body["total"]) == (True, None)      # the time window, cut short
    first, sync = body["versions"][0], body["versions"][1]
    assert first == {"seq": 215, "version": "cmt_215", "kind": "squash_publish",
                     "at": "2026-11-16T10:35:00+00:00", "message": "Change 215",
                     "author": {"id": "usr_alice", "name": "Alice Smith"},
                     "counts": {"added": 3, "changed": 1, "removed": 0}}
    assert sync["counts"] is None and sync["author"] == {"id": None, "name": None}
    assert body["versions"][4]["counts"] == {"added": 0, "changed": 0, "removed": 0}
    assert body["versions"][4]["author"] == {"id": "usr_gone", "name": None}   # not in the directory
    assert body["authors"] == [{"id": "usr_alice", "name": "Alice Smith", "versions": 2},
                               {"id": None, "name": None, "versions": 1},
                               {"id": "usr_carol", "name": "Carol Smith", "versions": 1},
                               {"id": "usr_gone", "name": None, "versions": 1}]
    assert body["reviewsWaiting"] == [{"id": "pr_1", "title": "Q4 owners",
                                       "author": {"id": "usr_carol", "name": "Carol Smith"},
                                       "at": "2026-11-16T09:00:00+00:00",
                                       "url": "/workspaces/ws_1/reviews?pr=pr_1"}]
    assert body["watchedChanged"] == world.store.watched


async def test_a_fork_is_read_marked_and_watched_while_forks_are_off(world, test_client):
    url = _V.format("g_fork")
    assert (await test_client.get(url + "/digest")).status_code == 200
    assert world.store.asked[-1].graph_id == "g_fork"
    assert (await test_client.post(url + "/digest/seen", json={"seq": 214})).json()["seq"] == 214
    assert (await test_client.put(url + "/watch", json={})).json()["graph"] is True
    rows = (await world.session.execute(select(GraphSeenORM.data_source_id))).scalars().all()
    assert rows == ["dsfork_1"]                         # the fork's own, not its parent's


# ── Watching ──────────────────────────────────────────────────────────────────────────────────────
async def test_watching_the_graph_and_entities_in_it(world, test_client):
    url = _V.format("g_1") + "/watch"
    assert (await test_client.put(url)).json()["graph"] is True                # no body: the graph
    await test_client.put(url, json={"entityUrn": "urn:t:orders"})
    got = (await test_client.put(url, json={"entityUrn": "urn:t:orders"})).json()   # twice is once
    assert got["graph"] is True and [e["urn"] for e in got["entities"]] == ["urn:t:orders"]
    assert got["entities"][0]["since"]
    assert (await test_client.put(url, json={"entityUrn": ""})).status_code == 422
    got = (await test_client.delete(url, params={"entityUrn": "urn:t:orders"})).json()
    assert got["entities"] == [] and got["graph"] is True
    got = (await test_client.delete(url)).json()
    assert got == {"graph": False, "entities": [], "entitiesMax": graph_watch_repo.ENTITIES_MAX}
    assert (await test_client.delete(url)).status_code == 200                  # not watched: no change


async def test_watching_more_entities_than_the_limit_is_refused(world, test_client, monkeypatch):
    monkeypatch.setattr(graph_watch_repo, "ENTITIES_MAX", 2)
    url = _V.format("g_1") + "/watch"
    for urn in ("urn:a", "urn:b"):
        assert (await test_client.put(url, json={"entityUrn": urn})).status_code == 200
    refused = await test_client.put(url, json={"entityUrn": "urn:c"})
    assert refused.status_code == 409 and refused.json()["detail"]["limit"] == 2
    assert (await test_client.put(url, json={"entityUrn": "urn:a"})).status_code == 200   # held
    assert (await test_client.put(url, json={})).json()["graph"] is True       # the graph isn't one


# ── What a version records, and who published ─────────────────────────────────────────────────────
def test_counts_are_what_a_version_recorded_and_null_where_it_recorded_none():
    assert digest.counts_of({"create": 4, "update": 2, "delete": 1}) == {"added": 4, "changed": 2,
                                                                         "removed": 1}
    rebased = {"create": 1, "update": 0, "delete": 0, "rebased": {"create": 9}, "from_seq": 3}
    assert digest.counts_of(rebased) == {"added": 1, "changed": 0, "removed": 0}
    assert digest.counts_of({"nodes": 30, "edges": 12}) == {"added": 42, "changed": 0, "removed": 0}
    for unrecorded in (None, {}, {"from_seq": 1}, "x", []):
        assert digest.counts_of(unrecorded) is None, unrecorded


def test_authors_are_most_versions_first_then_most_recent():
    versions = [{"actor": a} for a in ("usr_c", "usr_a", "usr_b", "usr_a", None, "usr_b")]
    assert digest.authors(versions) == [("usr_a", 2), ("usr_b", 2), ("usr_c", 1), (None, 1)]


# ── Telling the people who watch it ───────────────────────────────────────────────────────────────
def _commit(seq=216, kind="squash_publish", actor="usr_alice", message="Fix owner emails",
            stats=None):
    return SimpleNamespace(commit_seq=seq, kind=kind, actor=actor, message=message,
                           stats={"create": 12, "update": 3, "delete": 1} if stats is None else stats)


def test_what_a_watcher_is_told_says_what_changed():
    graph = digest._copy(_commit(), "Ledger", [], whole=True)
    assert graph == ("New version of “Ledger”",
                     "Version #216: “Fix owner emails”. 12 added, 3 changed, 1 removed.")
    one = digest._copy(_commit(stats={}), "Ledger", ["Orders"], whole=False)
    assert one == ("“Orders” changed in “Ledger”", "Version #216: “Fix owner emails”.")
    many = digest._copy(_commit(kind="revert", stats={"create": 0, "update": 2, "delete": 0}),
                        "Ledger", ["A", "B", "C", "D", "E"], whole=False)
    assert many == ("5 things you watch changed in “Ledger”",
                    "Version #216. 2 changed. It changed “A”, “B”, “C” and 2 more.")
    both = digest._copy(_commit(kind="restore"), "Ledger", ["A", "B"], whole=True)
    assert both[0] == "“Ledger” was restored to an earlier version"
    assert both[1].endswith("It changed “A” and “B”, which you watch.")
    assert digest._copy(_commit(kind="revert"), "L", [], whole=True)[0] == "A change to “L” was undone"


@pytest.fixture
def telling(world, monkeypatch):
    """``tell_watchers`` against the test database, with the watched entities a version changed
    and who reads the workspace stood in for."""
    from contextlib import asynccontextmanager

    from backend.app.db import engine

    @asynccontextmanager
    async def session():
        yield world.session
        await world.session.commit()

    readers = {"usr_bob", "usr_carol", "usr_alice"}
    changed = {"urn:t:orders": "Orders", "urn:t:invoices": "Invoices"}

    async def changed_in(graph_id, seq, urns):
        return {u: changed[u] for u in urns if u in changed}

    async def resolve(s, user_id, **_kw):
        return PermissionClaims(sid="", ws_perms={"ws_1": _LEAVES} if user_id in readers else {})

    monkeypatch.setattr(engine, "get_async_session", session)
    monkeypatch.setattr(digest, "_changed_in", changed_in)
    monkeypatch.setattr(permission_service, "resolve", resolve)
    return SimpleNamespace(readers=readers, session=world.session)


async def _watch(s, user_id, urn=None, ds="ds_1"):
    await graph_watch_repo.watch(s, user_id, ds, urn)


async def _told(s):
    rows = (await s.execute(select(NotificationORM).order_by(NotificationORM.user_id))).scalars().all()
    return {r.user_id: (r.kind, r.title, r.body, r.link, r.actor_id, r.resource_id) for r in rows}


async def test_a_publish_tells_each_watcher_once_and_never_its_author(telling):
    s = telling.session
    await _watch(s, "usr_alice")                                   # the author
    await _watch(s, "usr_bob")                                     # the graph and two entities
    for urn in ("urn:t:orders", "urn:t:invoices"):
        await _watch(s, "usr_bob", urn)
        await _watch(s, "usr_carol", urn)                          # two entities, both changed
    await _watch(s, "usr_dave", "urn:t:orders")                    # can't read the workspace
    await _watch(s, "usr_erin", "urn:t:unchanged")                 # watches nothing it changed
    await _watch(s, "usr_frank", ds="ds_9")                        # another graph
    telling.readers.update({"usr_erin", "usr_frank"})
    await s.commit()
    n = await digest.tell_watchers(graph_id="g_1", workspace_id="ws_1", data_source_id="ds_1",
                                   commit=_commit())
    told = await _told(s)
    assert n == 2 and sorted(told) == ["usr_bob", "usr_carol"]
    link = "/workspaces/ws_1?ds=ds_1&dstab=versioning"
    assert told["usr_bob"] == (
        "watch.new_version", "New version of “Ledger”",
        "Version #216: “Fix owner emails”. 12 added, 3 changed, 1 removed. "
        "It changed “Invoices” and “Orders”, which you watch.", link, "usr_alice", "ds_1")
    assert told["usr_carol"][1:3] == ("2 things you watch changed in “Ledger”",
                                      "Version #216: “Fix owner emails”. 12 added, 3 changed, "
                                      "1 removed. It changed “Invoices” and “Orders”.")


async def test_an_author_who_had_seen_everything_has_seen_their_own_version(telling):
    s = telling.session
    s.add_all([GraphSeenORM(user_id="usr_alice", data_source_id="ds_1", seen_seq=215),
               GraphSeenORM(user_id="usr_bob", data_source_id="ds_1", seen_seq=215),
               GraphSeenORM(user_id="usr_carol", data_source_id="ds_1", seen_seq=210)])
    await s.commit()
    await digest.tell_watchers(graph_id="g_1", workspace_id="ws_1", data_source_id="ds_1",
                               commit=_commit(216))
    await digest.tell_watchers(graph_id="g_1", workspace_id="ws_1", data_source_id="ds_1",
                               commit=_commit(218, actor="usr_carol"))     # 211…217 unseen: kept
    marks = dict((await s.execute(select(GraphSeenORM.user_id, GraphSeenORM.seen_seq))).all())
    assert marks == {"usr_alice": 216, "usr_bob": 215, "usr_carol": 210}


async def test_telling_the_watchers_never_raises_and_gives_up_in_time(telling, monkeypatch):
    s = telling.session
    await _watch(s, "usr_bob")
    await s.commit()

    async def broken(graph_id, seq, urns):
        raise ConnectionError("the graph store is out of reach")

    await _watch(s, "usr_carol", "urn:t:orders")
    await s.commit()
    monkeypatch.setattr(digest, "_changed_in", broken)
    assert await digest.tell_watchers(graph_id="g_1", workspace_id="ws_1", data_source_id="ds_1",
                                      commit=_commit()) == 0

    async def slow(**_kw):
        await asyncio.sleep(1)

    monkeypatch.setattr(digest, "TELL_TIMEOUT_SECS", 0.05)
    monkeypatch.setattr(digest, "_tell", slow)
    assert await digest.tell_watchers(graph_id="g_1", workspace_id="ws_1", data_source_id="ds_1",
                                      commit=_commit()) == 0


async def test_past_the_time_allowed_those_told_so_far_stay_told(telling, monkeypatch):
    s = telling.session
    for user_id in ("usr_bob", "usr_carol"):
        await _watch(s, user_id)
    await s.commit()
    resolve = permission_service.resolve

    async def slow_for_carol(session, user_id, **kw):
        if user_id == "usr_carol":
            await asyncio.sleep(5)
        return await resolve(session, user_id, **kw)

    monkeypatch.setattr(permission_service, "resolve", slow_for_carol)
    monkeypatch.setattr(digest, "_TELL_CHUNK", 1)
    monkeypatch.setattr(digest, "TELL_TIMEOUT_SECS", 0.5)
    assert await digest.tell_watchers(graph_id="g_1", workspace_id="ws_1", data_source_id="ds_1",
                                      commit=_commit()) == 0         # gave up, and says nothing more
    assert sorted(await _told(s)) == ["usr_bob"]


def test_only_what_a_person_published_tells_the_watchers(monkeypatch):
    noted = []
    monkeypatch.setattr(digest.db, "after_commit", lambda session, step: noted.append(step))
    graph = SimpleNamespace(id="g_1", workspace_id="ws_1", data_source_id="ds_1")
    for kind in ("squash_publish", "revert", "restore", "edit", "import", "sync", "genesis"):
        digest.note(object(), graph, _commit(kind=kind))
    assert len(noted) == 3
