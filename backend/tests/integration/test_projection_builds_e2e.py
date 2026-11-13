"""A new version built beside the serving key (read mode ``beside``: Keep serving, switch when ready),
end to end against Postgres and an in-memory FalkorDB that copies keys as ``GRAPH.COPY`` does.

A graph that reads ``beside`` has a publish larger than ``buildAboveRows`` built in a second key:
the serving key is copied (``copying``), the commits since are written into the copy
(``catching_up``), the copy is checked against main and readers are switched to it in one
transaction (``switching``); the old key is retired after a grace period. Until the switch the
serving key is never written: it keeps serving its version whole, and the watermark says a build is
under way. A smaller publish, a graph that reads in place, or New-version builds off: written in
place, as before. A build that cannot copy (no room, by ``noRoomPolicy``) waits or is written in
place; one that keeps failing is dropped, and the change written in place. A rebuild drops a build.
Every step is recorded in Postgres, so a fresh projector (a pod restart) takes the build up where it
was.
"""
from __future__ import annotations

import asyncio
import copy
import os

import pytest

from backend.app.services.versioning import build_policy, cache_manager, keymigrate, residency
from backend.app.services.versioning import db, projection
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.residency import Admitted
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_projection_liveness_e2e import LiveFalkor, LiveGraph, _seed
from backend.tests.integration.test_versioning_projection import (
    FakeGraph,
    _assert_matches_main,
    _edit_publish,
    _node,
)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


class CopyGraph(LiveGraph):
    """A LiveGraph that ``GRAPH.COPY`` copies whole into a key of its own, and that does not exist
    until it is written or copied into."""

    def __init__(self, store: "BuildFalkor"):
        super().__init__()
        self._store = store
        self.copies = 0

    async def copy(self, clone: str):
        if not self.exists:
            raise RuntimeError("Invalid graph operation on empty key")
        target = self._store.graphs.get(clone)
        if target is not None and target.exists:
            raise RuntimeError("destination key already exists")
        twin = CopyGraph(self._store)
        for key, value in self.__dict__.items():
            if key not in ("_store", "copies"):
                twin.__dict__[key] = copy.deepcopy(value)
        self._store.graphs[clone] = twin
        self.copies += 1
        return twin

    async def delete(self):
        self.drop()


class BuildFalkor(LiveFalkor):
    """LiveFalkor whose graphs copy: this test's keys and every key built beside one."""

    def __call__(self, name, provider_id=None):
        if name in self.ours or any(name.startswith(o + keymigrate.BUILD_SUFFIX) for o in self.ours):
            graph = self.graphs.get(name)
            if graph is None:
                graph = self.graphs[name] = CopyGraph(self)
                graph.exists = name in self.ours
            return graph
        return FakeGraph()


def _policy(**over):
    return build_policy.BuildPolicy({**build_policy.defaults().values, "buildAboveRows": 1,
                                     **over})


@pytest.fixture
def builds_on(monkeypatch):
    """New-version builds on, a build for any window of more than one row, room for a copy, no
    summaries job running. Returns a setter for the policy and the copy room (an exception there
    is raised by the admission), and what was reserved and given back: a copy's room is reserved
    for its build when it fits (``("held", build id)``)."""
    from backend.app.services.aggregation.admission import AggregationAdmission

    state = {"policy": _policy(), "room": Admitted(True, "node1", None, None), "switch": True,
             "reserved": [], "released": []}

    async def resolve(session=None):
        return state["policy"]

    async def switch(session=None):
        return state["switch"]

    async def room(graph_id, provider, key, holder, **k):
        if isinstance(state["room"], BaseException):
            raise state["room"]
        if not state["room"].fits:
            return state["room"], None
        state["reserved"].append(("held", holder))
        return state["room"], ("held", holder)

    async def release(self, held):
        state["released"].append(held)

    async def no_job(_ds):
        return False

    monkeypatch.setattr(build_policy, "resolve", resolve)
    monkeypatch.setattr(build_policy, "current", lambda: state["policy"])
    monkeypatch.setattr(build_policy, "switch_state", switch)
    monkeypatch.setattr(residency, "admit_build_copy", room)
    monkeypatch.setattr(AggregationAdmission, "release", release)
    monkeypatch.setattr(cache_manager, "_rollups_running", no_job)
    return state


def _create(*ids) -> list:
    return [{"op": "create", "entity_kind": "node", "entity_id": i, "payload": _node(i)}
            for i in ids]


async def _ps(gid: str) -> ProjectionStateORM:
    async with db.graphver_session() as s:
        return await s.get(ProjectionStateORM, gid)


async def _beside(svc, gid: str) -> None:
    found, _before = await svc.set_read_mode(gid, "beside")
    assert found


def _snapshot(graph) -> tuple:
    return copy.deepcopy((graph.nodes, graph.edges, graph.proj_meta))


async def _run_a_large_publish_is_built_beside_and_switched_to() -> None:
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    old = (await _ps(gid)).falkor_graph_name
    before = _snapshot(serving)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")

    # Pass 1: asked for, then copied: the build's key holds exactly the version served.
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state["step"] == "catching_up" and ps.candidate_seq == 3, ps.candidate_state
    name = ps.candidate_graph_name
    assert name == f"{old}#b1"
    assert fake.graphs[name].proj_meta["seq"] == 3
    wm = await svc.projection_watermark(gid)
    assert (wm["projected"], wm["served"], wm["candidate"]["step"]) == (3, 3, "catching_up"), wm

    # Pass 2: the commits since are written into the build's key, never into the serving key.
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_seq == 4 and ps.falkor_graph_name == old
    assert _snapshot(serving) == before, "the serving key was written during the build"
    assert (await svc.projection_watermark(gid))["served"] == 3

    # Pass 3: checked against main, then switched to in one step; the old key is retired.
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.projected_commit_seq, ps.served_commit_seq) == (name, 4, 4)
    assert ps.candidate_state is None and ps.candidate_graph_name is None
    (entry,) = ps.retired_keys
    assert (entry["name"], entry["afterSeq"], entry["build"]) == (old, 4, entry["build"])
    await _assert_matches_main(svc, fake, gid)
    assert _snapshot(serving) == before, "the old key is left as it served until retired"
    assert (await svc.projection_watermark(gid))["candidate"] is None


def test_a_large_publish_is_built_beside_and_switched_to(builds_on):
    asyncio.run(_run_a_large_publish_is_built_beside_and_switched_to())


async def _run_a_small_publish_or_another_mode_is_written_in_place(state) -> None:
    for policy, mode, switch in ((_policy(buildAboveRows=1000), "beside", True),
                                 (_policy(), "in_place", True),
                                 (_policy(), "beside", False)):
        state["policy"], state["switch"] = policy, switch
        svc, fake = GraphVersioningService(), BuildFalkor()
        gid, proj, serving = await _seed(svc, fake)
        await svc.set_read_mode(gid, mode)
        await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
        await proj.project_graph(gid)
        ps = await _ps(gid)
        assert ps.candidate_state is None and ps.projected_commit_seq == 4, (mode, switch)
        await _assert_matches_main(svc, fake, gid)


def test_a_small_publish_or_another_mode_is_written_in_place(builds_on):
    asyncio.run(_run_a_small_publish_or_another_mode_is_written_in_place(builds_on))


async def _run_no_room_waits_or_writes_in_place(state) -> None:
    state["room"] = Admitted(False, "node1", 1024, "capacity")
    # wait: the serving key keeps serving, and the build asks again shortly.
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state["step"] == "queued" and ps.candidate_state["retryAt"]
    assert "no room" in ps.candidate_state["waiting"] and ps.projected_commit_seq == 3
    assert serving.copies == 0
    # in_place: dropped, and the next pass writes it into the serving key.
    state["policy"] = _policy(noRoomPolicy="in_place")
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        row.candidate_state = {**row.candidate_state, "retryAt": None}
    await proj.project_graph(gid)
    assert (await _ps(gid)).candidate_state is None
    await proj.project_graph(gid)
    assert (await _ps(gid)).projected_commit_seq == 4
    await _assert_matches_main(svc, fake, gid)


def test_no_room_waits_or_writes_in_place(builds_on):
    asyncio.run(_run_no_room_waits_or_writes_in_place(builds_on))


async def _run_a_failing_build_is_tried_again_then_written_in_place(state, monkeypatch) -> None:
    state["policy"] = _policy(buildMaxAttempts=2)
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")

    async def broken(self, clone):
        raise ConnectionError("the node went away mid-copy")

    monkeypatch.setattr(CopyGraph, "copy", broken)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    # Failed in the pass that found room: asked again, room included, after a backoff.
    assert (ps.candidate_state["attempts"], ps.candidate_state["step"]) == (1, "queued")
    assert "went away" in ps.candidate_state["error"] and ps.candidate_state["retryAt"]
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        row.candidate_state = {**row.candidate_state, "retryAt": None}
    await proj.project_graph(gid)                       # the second attempt: given up, dropped
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.retired_keys[-1]["name"].endswith("#b1")
    await proj.project_graph(gid)                       # and written in place
    assert (await _ps(gid)).projected_commit_seq == 4
    await _assert_matches_main(svc, fake, gid)


def test_a_failing_build_is_tried_again_then_written_in_place(builds_on, monkeypatch):
    asyncio.run(_run_a_failing_build_is_tried_again_then_written_in_place(builds_on, monkeypatch))


async def _run_a_fresh_projector_takes_a_build_up_where_it_was() -> None:
    """A pod restart between steps: every step is in Postgres, and the build's key says what it
    holds, so a new projector, on another worker, carries the build on to the switch."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    await proj.project_graph(gid)                       # copied
    restarted = FalkorProjector(graph_client_factory=fake)
    await restarted.project_graph(gid)                  # caught up
    # Another publish while the build catches up: the next pass writes it into the build too.
    await _edit_publish(svc, gid, "a", _create("F"), "more")
    await FalkorProjector(graph_client_factory=fake).project_graph(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["step"], ps.candidate_seq) == ("catching_up", 5)
    await FalkorProjector(graph_client_factory=fake).project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 5
    await _assert_matches_main(svc, fake, gid)


def test_a_fresh_projector_takes_a_build_up_where_it_was(builds_on):
    asyncio.run(_run_a_fresh_projector_takes_a_build_up_where_it_was())


async def _run_a_rebuild_drops_the_build() -> None:
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    await proj.project_graph(gid)
    name = (await _ps(gid)).candidate_graph_name
    assert await svc.request_projection_rebuild(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.retired_keys[-1]["name"] == name
    assert ps.status == "rebuilding" and ps.projected_commit_seq == 0


def test_a_rebuild_drops_the_build(builds_on):
    asyncio.run(_run_a_rebuild_drops_the_build())


async def _run_a_lost_build_key_is_copied_again_and_an_unrecorded_version_adopted() -> None:
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    await proj.project_graph(gid)                       # copied at 3
    name = (await _ps(gid)).candidate_graph_name
    fake.graphs[name].drop()                            # its node restarted without it
    await proj.project_graph(gid)                       # found gone before writing: from a copy
    ps = await _ps(gid)
    assert (ps.candidate_state["step"], ps.candidate_state["attempts"]) == ("copying", 1)
    assert "gone" in ps.candidate_state["error"]
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        row.candidate_state = {**row.candidate_state, "retryAt": None}
    await proj.project_graph(gid)                       # copied again
    await proj.project_graph(gid)                       # caught up: the key's marker says 4
    async with db.graphver_session() as s:              # ...killed before it recorded that
        row = await s.get(ProjectionStateORM, gid)
        assert row.candidate_seq == 4
        row.candidate_seq = 3
    await proj.project_graph(gid)                       # the marker is written last: adopted
    assert (await _ps(gid)).candidate_seq == 4
    await proj.project_graph(gid)                       # and switched to
    ps = await _ps(gid)
    assert ps.candidate_state is None and (ps.falkor_graph_name, ps.served_commit_seq) == (name, 4)
    await _assert_matches_main(svc, fake, gid)


def test_a_lost_build_key_is_copied_again_and_an_unrecorded_version_adopted(builds_on):
    asyncio.run(_run_a_lost_build_key_is_copied_again_and_an_unrecorded_version_adopted())


async def _run_a_copys_room_is_held_while_it_copies_and_asked_for_again_after_a_restart(
        state, monkeypatch) -> None:
    from backend.app.services.versioning.errors import LockBusy

    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")

    # A capacity pass holds the lock admission takes: the build waits, no attempt counted.
    state["room"] = LockBusy("a capacity pass is under way; try again shortly")
    await proj.project_graph(gid)
    ps = await _ps(gid)
    build_id = ps.candidate_state["id"]
    assert (ps.candidate_state["step"], ps.candidate_state["attempts"]) == ("queued", 0)
    assert "capacity pass" in ps.candidate_state["waiting"] and ps.candidate_state["retryAt"]
    assert serving.copies == 0 and state["reserved"] == []

    # Room: reserved for the build while it copies, and given back once the copy has landed.
    state["room"] = Admitted(True, "node1", None, None)
    await _no_backoff(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state["step"] == "catching_up" and serving.copies == 1
    assert state["reserved"] == state["released"] == [("held", build_id)]

    # Its pod stops mid-copy: the build is found copying, with what the copy left under its
    # name. It asks for room again, and with none, waits, the leftover dropped meanwhile: no copy.
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        row.candidate_state, row.candidate_seq = {**row.candidate_state, "step": "copying"}, None
    state["room"] = Admitted(False, "node1", 1024, "capacity")
    restarted = FalkorProjector(graph_client_factory=fake)
    await restarted.project_graph(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["step"], ps.candidate_state["attempts"]) == ("queued", 0)
    assert "no room" in ps.candidate_state["waiting"] and serving.copies == 1
    assert not fake.graphs[ps.candidate_graph_name].exists, "the leftover is dropped"

    # Room again: a fresh copy, its room held and given back, then on to the switch.
    state["room"] = Admitted(True, "node1", None, None)
    await _no_backoff(gid)
    await restarted.project_graph(gid)
    assert serving.copies == 2 and state["released"] == [("held", build_id)] * 2
    await restarted.project_graph(gid)                  # caught up
    await restarted.project_graph(gid)                  # switched
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 4
    await _assert_matches_main(svc, fake, gid)

    # A copy that fails gives its room back too.
    async def broken(self, clone):
        raise ConnectionError("the node went away mid-copy")

    monkeypatch.setattr(CopyGraph, "copy", broken)
    await _edit_publish(svc, gid, "a", _create("F", "G"), "another change")
    await restarted.project_graph(gid)
    ps = await _ps(gid)
    second = ps.candidate_state["id"]
    assert ps.candidate_state["attempts"] == 1 and "went away" in ps.candidate_state["error"]
    assert state["released"][-1] == ("held", second) and len(state["reserved"]) == 3


async def _no_backoff(gid: str) -> None:
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        row.candidate_state = {**row.candidate_state, "retryAt": None}


def test_a_copys_room_is_held_while_it_copies_and_asked_for_again_after_a_restart(
        builds_on, monkeypatch):
    asyncio.run(_run_a_copys_room_is_held_while_it_copies_and_asked_for_again_after_a_restart(
        builds_on, monkeypatch))
