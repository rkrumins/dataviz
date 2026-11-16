"""The signals and a graph's health over HTTP (``endpoints/versioned_graph_health.py``) on the unit
harness: the real routes, permissions and composition, in front of the in-memory settings store
(``settings_world``), a Redis stood in for, and the versioning service's answers stood in for.

* ``GET /admin/versioning/signals``: system administrators only; every id, 0 when nothing
  happened, its hours and the graphs it named most, by name; with Redis out of reach,
  ``unavailable`` and no counts.
* ``GET /{ws}/versioning/graphs/{g}/health``: read with the data-source read in the graph's
  workspace; its shape; what each part says; a fork's root's copy, named; and each part that can't
  be read, null with its problem.
* Neither route is open to an API key.

Against Postgres and a real Redis: ``integration/test_graph_health_live.py``.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioned_graph_health as vgh
from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth import api_key_surface
from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.main import app
from backend.app.services.graph_store import topology
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.settings import health, service, signals
from backend.app.services.settings.service import Graph
from backend.tests.test_settings_signals import NOW, FakeRedis

_SIGNALS = "/api/v1/admin/versioning/signals"
_HEALTH = "/api/v1/ws_1/versioning/graphs/{}/health"
_GB = 1 << 30
_LEAVES = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:view:read")
PERSONAS = {
    "system_admin": PermissionClaims(sid="sess_test", global_perms=("system:admin",)),
    "org_admin": PermissionClaims(sid="sess_test", global_perms=("system:org-admin",)),
    "admin_here": PermissionClaims(sid="sess_test",
                                   ws_perms={"ws_1": ("workspace:admin",) + _LEAVES}),
    "member": PermissionClaims(sid="sess_test", ws_perms={"ws_1": _LEAVES}),
    "member_elsewhere": PermissionClaims(sid="sess_test", ws_perms={"ws_2": _LEAVES}),
}
GRAPHS = [Graph("g_1", "ws_1", "ds_1", None, True),
          Graph("g_fork", "ws_1", "dsfork_1", "g_1", False),
          Graph("g_9", "ws_2", "ds_9", None, True)]
CONTRACT = {"asOf", "head", "serving", "versionsBehind", "readMode", "progress", "lastUpdate",
            "memory", "lastBuild", "signals", "follows", "problems"}


def _rev(seq: int) -> dict:
    return {"commit_id": f"cmt_{seq}", "created_at": f"2026-11-16T1{seq % 10}:00:00+00:00",
            "actor": "usr_1", "message": f"Version {seq}"}


def _wm(**kw) -> dict:
    """A watermark as ``projection_watermark`` answers it, with the fields health reads."""
    return {"committed": 9, "committed_revision": _rev(9), "projected": 7, "served": 7,
            "served_revision": _rev(7), "status": "idle", "falkor_graph_name": "g_fin",
            "falkor_provider": "prov_1", "residency": "standard", "residency_state": "resident",
            "size_bytes": 4 * _GB, "last_read_at": "2026-11-16T13:00:00+00:00",
            "last_projected_at": "2026-11-16T12:30:00+00:00", "candidate": None,
            "retired_keys": [], **kw}


class _Versioning:
    """The versioning service, as the routes ask it: each graph's row and watermark."""

    def __init__(self):
        self.watermarks = {
            "g_1": _wm(),
            # A fork's is its root's, as the fork reads it: here from Postgres.
            "g_fork": _wm(served=None, served_revision=None, reads_through="g_1",
                          reads_from="overlay", falkor_graph_name=None, falkor_provider=None,
                          residency=None, candidate=None),
            "g_9": _wm(),
        }
        self.unreadable = set()

    async def get_graph(self, graph_id):
        g = next((g for g in GRAPHS if g.graph_id == graph_id), None)
        return None if g is None else {
            "graph_id": g.graph_id, "workspace_id": g.workspace_id,
            "data_source_id": g.data_source_id, "fork_parent_graph_id": g.fork_parent_graph_id,
            "deleted_at": None}

    async def projection_watermark(self, graph_id):
        if graph_id in self.unreadable:
            raise ConnectionError("the graph store is out of reach")
        return dict(self.watermarks[graph_id])

    async def projection_placements(self, graph_ids):
        return {g.graph_id: {"workspace_id": g.workspace_id, "data_source_id": g.data_source_id}
                for g in GRAPHS if g.graph_id in graph_ids}


@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        WorkspaceORM(id="ws_1", name="Finance"), WorkspaceORM(id="ws_2", name="Elsewhere"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_1", provider_id="prov_1",
                               graph_name="g_fin", label="Ledger"),
        WorkspaceDataSourceORM(id="dsfork_1", workspace_id="ws_1", provider_id="prov_1",
                               label="Ledger fork", fork_of_data_source_id="ds_1"),
        WorkspaceDataSourceORM(id="ds_9", workspace_id="ws_2", provider_id="prov_1",
                               graph_name="g_other", label="Other"),
    ])
    await db_session.commit()


@pytest.fixture
def world(settings_world, test_client, estate, monkeypatch):
    """The graphs above, their watermarks, a Redis in memory, the graph store's nodes as last
    read; signed in as a system administrator."""
    async def graphs(*, workspace_id=None, graph_id=None, data_source_id=None):
        return [g for g in GRAPHS if workspace_id in (None, g.workspace_id)
                and graph_id in (None, g.graph_id) and data_source_id in (None, g.data_source_id)]

    async def last_read(**_kw):
        return SimpleNamespace(), False

    def placed(snapshot, provider_id, key, **_kw):
        return SimpleNamespace(master=SimpleNamespace(endpoint=f"falkor-0:6379/{key}"))

    redis, versioning = FakeRedis(), _Versioning()
    monkeypatch.setattr(service, "graphs", graphs)
    monkeypatch.setattr(signals, "_redis", lambda: redis)
    monkeypatch.setattr(signals, "_clock", lambda: NOW)
    monkeypatch.setattr(topology, "snapshot_for_request", last_read)
    monkeypatch.setattr(topology, "placement_for_graph", placed)
    app.dependency_overrides[get_versioning_service] = lambda: versioning
    as_("system_admin")
    signals.reset()
    yield SimpleNamespace(settings=settings_world, redis=redis, versioning=versioning)
    signals.reset()


def as_(persona: str) -> None:
    app.dependency_overrides[get_permission_claims] = lambda: PERSONAS[persona]


async def _flushed(*bumps) -> None:
    """Signals counted, then flushed to the Redis in memory, as a process does."""
    for signal_id, graph_id, n in bumps:
        signals.bump(signal_id, graph_id=graph_id, n=n)
    assert await signals.flush() > 0


# ── The gates ─────────────────────────────────────────────────────────────────────────────────────
_ROUTES = {("GET", _SIGNALS): "system:admin",
           ("GET", "/api/v1/{ws_id}/versioning/graphs/{graph_id}/health"):
               "workspace:datasource:read"}


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_each_route_has_its_gate_and_neither_is_open_to_an_api_key():
    found = {(m, p): (r, d) for m, p, r, d in api_key_surface.routes(app) if (m, p) in _ROUTES}
    assert set(found) == set(_ROUTES)
    for key, perm in _ROUTES.items():
        route, dependant = found[key]
        assert _gate_perms(dependant) == {perm}, key
        assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE
    every = {route.endpoint.__name__ for _m, _p, route, _d in api_key_surface.routes(app)
             if route.endpoint.__module__ == vgh.__name__}
    assert every == {r.endpoint.__name__ for r, _d in found.values()}


# ── Signals ───────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("persona, status", [("system_admin", 200), ("org_admin", 403),
                                             ("admin_here", 403), ("member", 403)])
async def test_only_system_administrators_read_the_signals(world, test_client, persona, status):
    as_(persona)
    got = await test_client.get(_SIGNALS)
    assert got.status_code == status, got.text


async def test_every_signal_is_there_with_its_hours_and_the_graphs_it_named_most(world,
                                                                                 test_client):
    await _flushed(("builds.dropped", "g_1", 2), ("builds.dropped", "g_9", 3),
                   ("builds.dropped", "g_gone", 1), ("drafts.idle_closed", None, 4))
    body = (await test_client.get(_SIGNALS, params={"window": "24h"})).json()
    assert (body["window"], body["unavailable"]) == ("24h", False) and body["asOf"]
    assert [s["id"] for s in body["signals"]] == list(signals.IDS)
    by_id = {s["id"]: s for s in body["signals"]}
    dropped = by_id["builds.dropped"]
    assert dropped["count"] == sum(dropped["byHour"]) == 6 and len(dropped["byHour"]) == 24
    assert dropped["byHour"][-1] == 6
    assert dropped["topGraphs"] == [
        {"graphId": "g_9", "dataSourceId": "ds_9", "name": "Other", "count": 3},
        {"graphId": "g_1", "dataSourceId": "ds_1", "name": "Ledger", "count": 2},
        {"graphId": "g_gone", "dataSourceId": None, "name": None, "count": 1}]   # not live
    assert by_id["drafts.idle_closed"] == {"id": "drafts.idle_closed", "count": 4,
                                           "byHour": [0] * 23 + [4], "topGraphs": []}
    assert all(s["count"] == 0 and s["topGraphs"] == [] for s in body["signals"]
               if s["id"] not in ("builds.dropped", "drafts.idle_closed"))
    for window, hours in (("1h", 1), ("7d", 168)):
        got = (await test_client.get(_SIGNALS, params={"window": window})).json()
        assert {len(s["byHour"]) for s in got["signals"]} == {hours}
    assert (await test_client.get(_SIGNALS, params={"window": "2d"})).status_code == 422


async def test_signals_say_unavailable_with_no_counts_when_redis_is_out_of_reach(world,
                                                                                 test_client):
    world.redis.down = True
    got = await test_client.get(_SIGNALS)
    assert got.status_code == 200
    body = got.json()
    assert (body["unavailable"], body["signals"], body["window"]) == (True, [], "24h")


# ── Health: who may read it ───────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("persona, status", [("system_admin", 200), ("org_admin", 200),
                                             ("admin_here", 200), ("member", 200),
                                             ("member_elsewhere", 403)])
async def test_a_graphs_health_is_read_with_the_data_source_read_in_its_workspace(
        world, test_client, persona, status):
    as_(persona)
    got = await test_client.get(_HEALTH.format("g_1"))
    assert got.status_code == status, got.text


async def test_a_graph_of_another_workspace_has_no_health_here(world, test_client):
    assert (await test_client.get(_HEALTH.format("g_9"))).status_code == 404
    assert (await test_client.get(_HEALTH.format("g_nope"))).status_code == 404


# ── Health: what it says ──────────────────────────────────────────────────────────────────────────
async def test_a_graphs_health_composes_each_part_from_what_is_kept(world, test_client):
    world.settings.set("reads.mode", "graph", "ds_1", "in_place")
    world.versioning.watermarks["g_1"]["candidate"] = {
        "id": "build_1", "step": "queued", "waiting": "no room for a copy on its node (capacity)",
        "error": None, "since": "2026-11-16T13:10:00+00:00"}
    await _flushed(("builds.waited_for_room", "g_1", 3), ("reads.asked_to_retry", "g_1", 2),
                   ("reads.asked_to_retry", "g_9", 5), ("drafts.idle_closed", "g_1", 1))
    got = await test_client.get(_HEALTH.format("g_1"))
    assert got.status_code == 200, got.text
    body = got.json()
    assert set(body) == CONTRACT
    assert body["head"] == {"seq": 9, "version": {"commitId": "cmt_9",
                                                  "at": "2026-11-16T19:00:00+00:00",
                                                  "actor": "usr_1", "message": "Version 9"}}
    assert body["serving"] == {"seq": 7, "version": {"commitId": "cmt_7",
                                                     "at": "2026-11-16T17:00:00+00:00",
                                                     "actor": "usr_1", "message": "Version 7"},
                               "source": "graph_store"}
    assert body["versionsBehind"] == 2
    mode = body["readMode"]
    assert (mode["effective"], mode["declared"], mode["source"]) == ("in_place", "in_place",
                                                                     "graph")
    assert isinstance(mode["why"], list)
    assert body["progress"] is None
    assert body["memory"] == {"bytes": 4 * _GB, "node": "falkor-0:6379/g_fin", "loaded": True,
                              "state": "resident", "rehydratingSince": None, "class": "standard",
                              "lastReadAt": "2026-11-16T13:00:00+00:00"}
    assert body["lastBuild"] == {"outcome": "waiting", "since": "2026-11-16T13:10:00+00:00",
                                 "at": None, "waitingFor": "room", "attempts": None,
                                 "why": "no room for a copy on its node (capacity)",
                                 "copyRemovedAfter": None, "windowSecs": None}
    counts = {s["id"]: s["count24h"] for s in body["signals"]}
    assert list(counts) == list(signals.IDS)
    assert counts == {**dict.fromkeys(signals.IDS, 0), "builds.waited_for_room": 3,
                      "reads.asked_to_retry": 2, "drafts.idle_closed": 1}
    assert body["follows"] is None
    # How long its last update took, and its rows and rate, are not kept anywhere: none is made up.
    assert body["lastUpdate"] is None
    assert [p["part"] for p in body["problems"]] == ["lastUpdate"]


async def test_a_graph_its_database_serves_reads_at_its_head(world, test_client):
    world.versioning.watermarks["g_1"].update(served=None, served_revision=None,
                                               residency_state="evicted")
    body = (await test_client.get(_HEALTH.format("g_1"))).json()
    assert body["serving"] == {"seq": 9, "version": body["head"]["version"], "source": "database"}
    assert body["versionsBehind"] == 0
    assert (body["memory"]["loaded"], body["memory"]["node"]) == (False, None)   # not in memory
    assert body["memory"]["state"] == "evicted"
    # Being loaded, as the inventory says it: not "unloaded", and since when.
    world.versioning.watermarks["g_1"].update(residency_state="rehydrating",
                                               rehydrating_since="2026-11-16T13:20:00+00:00")
    memory = (await test_client.get(_HEALTH.format("g_1"))).json()["memory"]
    assert (memory["state"], memory["loaded"], memory["rehydratingSince"]) == (
        "rehydrating", False, "2026-11-16T13:20:00+00:00")


async def test_a_fork_reports_its_roots_copy_and_says_so(world, test_client):
    world.settings.set("reads.mode", "graph", "ds_1", "in_place")
    await _flushed(("builds.dropped", "g_1", 1), ("reads.from_database_while_behind", "g_1", 4),
                   ("imports.replace_refused_by_guard", "g_fork", 1),
                   ("imports.replace_refused_by_guard", "g_1", 7),
                   ("drafts.idle_closed", "g_fork", 2))
    body = (await test_client.get(_HEALTH.format("g_fork"))).json()
    # Its root, named: the panel says whose health it shows.
    assert body["follows"] == {"graphId": "g_1", "dataSourceId": "ds_1", "label": "Ledger"}
    assert body["serving"]["source"] == "database"                # it reads its root there
    assert (body["memory"]["class"], body["memory"]["node"]) == ("standard",
                                                                 "falkor-0:6379/g_fin")
    mode = body["readMode"]
    assert mode["effective"] == "in_place" and "follows_root" in {w["code"] for w in mode["why"]}
    counts = {s["id"]: s["count24h"] for s in body["signals"]}
    # The copy's and its reads' are its root's; its imports and drafts are its own.
    assert (counts["builds.dropped"], counts["reads.from_database_while_behind"]) == (1, 4)
    assert (counts["imports.replace_refused_by_guard"], counts["drafts.idle_closed"]) == (1, 2)


async def test_each_part_that_cant_be_read_is_null_with_its_problem(world, test_client,
                                                                    monkeypatch):
    async def no_context(session):
        raise ConnectionError("the settings store is out of reach")

    async def no_nodes(**_kw):
        return None, True

    world.versioning.unreadable.add("g_1")
    world.redis.down = True
    monkeypatch.setattr(service, "context", no_context)
    body = (await test_client.get(_HEALTH.format("g_1"))).json()
    assert set(body) == CONTRACT
    for part in ("head", "serving", "versionsBehind", "readMode", "lastUpdate", "memory",
                 "lastBuild", "signals"):
        assert body[part] is None, part
    assert [p["part"] for p in body["problems"]] == [
        "head", "serving", "versionsBehind", "readMode", "lastUpdate", "memory", "lastBuild",
        "signals"]
    assert all(p["message"] for p in body["problems"])
    # The graph store's nodes not read yet: its copy is known, the node holding it is not.
    world.versioning.unreadable.clear()
    monkeypatch.setattr(topology, "snapshot_for_request", no_nodes)
    body = (await test_client.get(_HEALTH.format("g_1"))).json()
    assert body["memory"]["node"] is None and body["memory"]["bytes"] == 4 * _GB
    assert "memory.node" in {p["part"] for p in body["problems"]}


# ── The last build ────────────────────────────────────────────────────────────────────────────────
def _build(**kw) -> dict:
    return {"outcome": "none", "since": None, "at": None, "waitingFor": None, "why": None,
            "attempts": None, "copyRemovedAfter": None, "windowSecs": None, **kw}


def test_the_last_build_is_the_one_in_flight_else_the_one_whose_copy_is_still_kept():
    # Nothing in flight and nothing kept: no switch within the retire grace; no more is known.
    assert health._last_build(_wm(), 900) == _build(windowSecs=900)
    assert health._last_build(_wm()) == _build()
    running = _wm(candidate={"id": "b", "waiting": None, "error": "the copy timed out",
                             "attempts": 1, "since": "t0"})
    assert health._last_build(running) == _build(outcome="running", since="t0",
                                                 why="the copy timed out", attempts=1)
    switched = _wm(projected=8, retired_keys=[
        {"name": "old", "retireAfter": "t9", "afterSeq": 5},              # a move's, no build
        {"name": "k_b", "retireAfter": "t2", "afterSeq": 0, "build": "b1"},
        {"name": "g_fin_old", "retireAfter": "t8", "afterSeq": 8, "build": "b2"}])
    # When it switched, and from when the copy its readers left is removed: each time named.
    assert health._last_build(switched, 900) == _build(
        outcome="switched", at="2026-11-16T12:30:00+00:00", copyRemovedAfter="t8")
    # Written to since it switched: when it switched isn't known any more.
    assert health._last_build({**switched, "projected": 9})["at"] is None
    # Given up without a switch: why isn't recorded, so nothing says "dropped after its
    # attempts"; its own copy is retired at once, so its time is when it was given up.
    given_up = _wm(retired_keys=[{"name": "k_b", "retireAfter": "t2", "afterSeq": 0,
                                  "build": "b1"}])
    assert health._last_build(given_up) == _build(outcome="not_switched", at="t2",
                                                  copyRemovedAfter="t2")


@pytest.mark.parametrize("why, waiting_for", [
    # The words the projector records with each wait (projection.py).
    ("no room for a copy on its node (capacity)", "room"),
    ("no room for a copy on its node (too_large); no room for a seed", "room"),
    ("a lineage-summaries job is building the serving key's summaries", "summaries"),
    ("a capacity pass is under way; try again shortly", "lock"),
    ("graph g_1 is busy with another change; try again shortly", "lock"),
    ("something else entirely", None),
])
def test_a_waiting_build_says_what_it_waits_for(why, waiting_for):
    found = health._last_build(_wm(candidate={"id": "b", "waiting": why, "since": "t0"}))
    assert (found["outcome"], found["waitingFor"], found["why"]) == ("waiting", waiting_for, why)


async def test_with_no_build_kept_the_health_says_how_far_back_it_sees(world, test_client):
    world.settings.set("updates.retireGraceSecs", "platform", "", 1_800)
    body = (await test_client.get(_HEALTH.format("g_1"))).json()
    assert body["lastBuild"] == _build(windowSecs=1_800)
