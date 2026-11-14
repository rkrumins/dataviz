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
was. With ``buildMode`` reseed, or auto when no copy fits, the build's key is seeded from Postgres
instead (``seeding``) on the node with most room, the serving key's lineage summaries carried over,
resumable page by page, and seeded again rather than copied when a later step fails.
"""
from __future__ import annotations

import asyncio
import copy
import os
import re
from datetime import datetime, timedelta, timezone

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
    _Result,
    _assert_matches_main,
    _edit_publish,
    _node,
)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


_SUMMARY_WRITE = re.compile(
    r"UNWIND \$batch AS row MATCH \(a:(\w+) \{urn: row\.s\}\) MATCH \(b:(\w+) \{urn: row\.t\}\) "
    r"MERGE \(a\)-\[r:AGGREGATED\]->\(b\) SET r \+= row\.p RETURN count\(r\)")


class CopyGraph(LiveGraph):
    """A LiveGraph that ``GRAPH.COPY`` copies whole into a key of its own, and that does not exist
    until it is written or copied into. It holds lineage summaries apart from the raw graph
    (``summaries``: (source label, source urn, target label, target urn) -> the cell's properties;
    ``markers``: label -> properties), and answers the statements a seeded build carries them over
    with (``projection._copy_summaries``)."""

    def __init__(self, store: "BuildFalkor"):
        super().__init__()
        self._store = store
        self.copies = 0
        self.summaries: dict = {}
        self.markers: dict = {}
        self.seed_of = None

    def _summaries_answer(self, cypher: str, params: dict):
        if cypher == projection._SUMMARIES_PAGE:
            return _Result([[la, sa, lb, sb, dict(props)]
                            for (la, sa, lb, sb), props in self.summaries.items()
                            if params["lo"] <= self._ids.get(sa, -1) < params["hi"]])
        if cypher == projection._SUMMARIES_CLEAR:
            self.summaries.clear()
            return _Result([])
        if cypher == projection._SUMMARIES_ANY:
            return _Result([[1]] if self.summaries else [])
        if cypher == projection._SEED_DONE_WRITE:
            self.seed_of = params["build"]
            return _Result([])
        if cypher == projection._SEED_DONE_READ:
            return _Result([[self.seed_of]])
        m = re.fullmatch(r"MATCH \(m:(\w+)\) RETURN properties\(m\)", cypher)
        if m:
            found = self.markers.get(m.group(1))
            return _Result([[dict(found)]] if found else [])
        m = re.fullmatch(r"MERGE \(m:(\w+) \{id: \$id\}\) SET m \+= \$props", cypher)
        if m:
            self.markers[m.group(1)] = {**self.markers.get(m.group(1), {}), **params["props"],
                                        "id": params["id"]}
            return _Result([])
        m = re.fullmatch(r"MATCH \(m:(\w+)\) DELETE m", cypher)
        if m:
            self.markers.pop(m.group(1), None)
            return _Result([])
        m = _SUMMARY_WRITE.fullmatch(cypher)
        if m:
            landed = 0
            for row in params["batch"]:
                ends = [self.nodes.get(row[k]) for k in ("s", "t")]
                if all(e is not None and e.get("_label") == lb
                       for e, lb in zip(ends, (m.group(1), m.group(2)))):
                    key = (m.group(1), row["s"], m.group(2), row["t"])
                    self.summaries[key] = {**self.summaries.get(key, {}), **row["p"]}
                    landed += 1
            return _Result([[landed]])
        return None

    async def ro_query(self, cypher, params=None, timeout=None):
        if self.exists and not self.unreachable:
            answer = self._summaries_answer(cypher, params or {})
            if answer is not None:
                return answer
        return await super().ro_query(cypher, params, timeout)

    async def query(self, cypher, params=None):
        answer = self._summaries_answer(cypher, params or {})
        if answer is not None:
            self.exists = True
            return answer
        return await super().query(cypher, params)

    def drop(self):
        super().drop()
        self.summaries, self.markers, self.seed_of = {}, {}, None

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

    from backend.app.providers import falkor_graph_registry

    state = {"policy": _policy(), "room": Admitted(True, "node1", None, None), "switch": True,
             "reserved": [], "released": [], "seed_room": Admitted(True, "node2", None, None),
             "seeded_on": [], "summaries_met": False}

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

    async def seed_room(graph_id, provider, taken, record, key=None):
        """A seed placed on the node with most room: a key of the graph's own beside the serving
        one (``#b9``, which this test's store answers for), recorded while admitted. A move's is
        admitted on its own key."""
        if not state["seed_room"].fits:
            return state["seed_room"], None
        if key is None:
            serving = min((n for n in taken if n and keymigrate.BUILD_SUFFIX not in n), key=len)
            key = f"{serving}{keymigrate.BUILD_SUFFIX}9"
        state["seeded_on"].append(key)
        return state["seed_room"], key if await record(key, state["seed_room"].master) else None

    async def graph_keys(provider_id=None, **_kw):
        return set()

    async def summaries_met(_ds, _since):
        return state["summaries_met"]

    async def no_job(_ds):
        return False

    monkeypatch.setattr(build_policy, "resolve", resolve)
    monkeypatch.setattr(build_policy, "current", lambda: state["policy"])
    monkeypatch.setattr(build_policy, "switch_state", switch)
    monkeypatch.setattr(residency, "admit_build_copy", room)
    monkeypatch.setattr(residency, "admit_build_seed", seed_room)
    monkeypatch.setattr(falkor_graph_registry, "list_graph_keys", graph_keys)
    monkeypatch.setattr(AggregationAdmission, "release", release)
    monkeypatch.setattr(cache_manager, "_rollups_running", no_job)
    monkeypatch.setattr(projection, "_rollups_ran_since", summaries_met)
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
    # No room for a copy on the serving key's node, nor for a seed on any node.
    state["room"] = Admitted(False, "node1", 1024, "capacity")
    state["seed_room"] = Admitted(False, "node2", 2048, "capacity")
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


async def _run_a_rebuild_drops_the_build(state) -> None:
    """With rebuilds written in place (``buildForRebuilds`` off), a rebuild drops a window's
    build, its key retired at once, and replays main into the serving key."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    await proj.project_graph(gid)
    name = (await _ps(gid)).candidate_graph_name
    state["policy"] = _policy(buildForRebuilds=False)
    assert await svc.request_projection_rebuild(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.retired_keys[-1]["name"] == name
    assert ps.status == "rebuilding" and ps.projected_commit_seq == 0


def test_a_rebuild_drops_the_build(builds_on):
    asyncio.run(_run_a_rebuild_drops_the_build(builds_on))


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
    state["seed_room"] = Admitted(False, "node2", 2048, "capacity")
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


def _summaries_on(graph) -> None:
    """The serving key's lineage summaries, as a summaries job left them: one cell between two of
    its nodes, and the job's and the projector's markers."""
    (sa, na), (sb, nb) = sorted(graph.nodes.items())[:2]
    graph.summaries[(na["_label"], sa, nb["_label"], sb)] = {
        "weight": 3, "aggKey": f"{sa}|{sb}", "sourceEdgeTypes": ["FLOWS_TO"], "gvSeq": 3}
    graph.markers["_AggMeta"] = {"id": "singleton", "regime": "cube", "edgeCount": 1}
    graph.markers["_GVRollupMeta"] = {"id": "meta", "seq": 3}


async def _run_a_large_publish_is_seeded_from_postgres_with_the_serving_keys_summaries(
        state) -> None:
    state["policy"] = _policy(buildMode="reseed")
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    old = (await _ps(gid)).falkor_graph_name
    _summaries_on(serving)
    before = copy.deepcopy((_snapshot(serving), serving.summaries, serving.markers))
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")

    # Pass 1: seeded from Postgres on the node with most room, at the version served; a summaries
    # job met the copy of the serving key's summaries, so it starts again.
    state["summaries_met"] = True
    await proj.project_graph(gid)
    ps = await _ps(gid)
    name = ps.candidate_graph_name
    assert state["seeded_on"] == [name] and name == f"{old}#b9" and serving.copies == 0
    assert (ps.candidate_state["step"], ps.candidate_state["mode"]) == ("seeding", "reseed")
    assert (ps.candidate_state["seedSeq"], ps.candidate_state["summaryRestarts"]) == (3, 1)
    wm = await svc.projection_watermark(gid)
    assert (wm["served"], wm["candidate"]["step"], wm["candidate"]["mode"]) == (3, "seeding",
                                                                                 "reseed")

    # Pass 2: the summaries carried over whole, then marked at the version served.
    state["summaries_met"] = False
    await proj.project_graph(gid)
    ps = await _ps(gid)
    built = fake.graphs[name]
    assert (ps.candidate_state["step"], ps.candidate_seq) == ("catching_up", 3), ps.candidate_state
    assert built.summaries == serving.summaries and built.markers == serving.markers
    assert built.proj_meta["seq"] == 3 and built.seed_of == ps.candidate_state["id"]

    # Passes 3 and 4: caught up, checked, switched to; the serving key never written.
    await proj.project_graph(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.projected_commit_seq, ps.served_commit_seq) == (name, 4, 4)
    assert ps.candidate_state is None and ps.retired_keys[-1]["name"] == old
    await _assert_matches_main(svc, fake, gid)
    assert copy.deepcopy((_snapshot(serving), serving.summaries, serving.markers)) == before


def test_a_large_publish_is_seeded_from_postgres_with_the_serving_keys_summaries(builds_on):
    asyncio.run(_run_a_large_publish_is_seeded_from_postgres_with_the_serving_keys_summaries(
        builds_on))


async def _run_auto_seeds_when_no_copy_fits_and_waits_when_nothing_does(state) -> None:
    state["policy"] = _policy(buildMode="auto")
    state["room"] = Admitted(False, "node1", 1024, "capacity")
    state["seed_room"] = Admitted(False, "node2", 2048, "capacity")
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")

    # No room for a copy on the serving key's node, nor for a seed on any: it waits, saying both.
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state["step"] == "queued" and ps.candidate_state["retryAt"]
    assert "no room for a copy" in ps.candidate_state["waiting"]
    assert "no room for a seed" in ps.candidate_state["waiting"]
    assert serving.copies == 0 and state["seeded_on"] == []

    # Room for a seed elsewhere: seeded, not copied, and on to the switch.
    state["seed_room"] = Admitted(True, "node2", None, None)
    await _no_backoff(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["step"], ps.candidate_state["mode"]) == ("catching_up", "reseed")
    await proj.project_graph(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 4 and serving.copies == 0
    await _assert_matches_main(svc, fake, gid)

    # A graph larger than copyMaxBytes is seeded too; copy mode never seeds, it waits.
    for room, mode, seeded in ((Admitted(False, None, None, "too_large"), "auto", True),
                               (Admitted(False, "node1", 1024, "capacity"), "copy", False)):
        state["room"], state["policy"] = room, _policy(buildMode=mode)
        state["seeded_on"].clear()
        await _edit_publish(svc, gid, "a", _create(f"X{mode}", f"Y{mode}"), "another change")
        await proj.project_graph(gid)
        ps = await _ps(gid)
        assert bool(state["seeded_on"]) is seeded, (mode, ps.candidate_state)
        if not seeded:
            assert ps.candidate_state["step"] == "queued" and "no room for a seed" not in \
                ps.candidate_state["waiting"]
        for _ in range(2):                              # caught up and switched, if seeded
            await proj.project_graph(gid)
        assert ((await _ps(gid)).candidate_state is None) is seeded


def test_auto_seeds_when_no_copy_fits_and_waits_when_nothing_does(builds_on):
    asyncio.run(_run_auto_seeds_when_no_copy_fits_and_waits_when_nothing_does(builds_on))


async def _run_a_seed_survives_restarts_a_lost_key_and_a_failed_catch_up(state,
                                                                         monkeypatch) -> None:
    """Pod restarts mid-seed: each pass, on a fresh projector, takes the seed on from its cursor in
    the build's key; a key lost before its summaries are carried over is seeded again; a catch-up
    that fails is undone by seeding the key again, never by a copy."""
    from backend.app.services.versioning import config as gv_config

    state["policy"] = _policy(buildMode="reseed")
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    _summaries_on(serving)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")

    # A reconcile a page at a time, and a pass that stops after each page.
    monkeypatch.setattr(gv_config, "PROJECTION_RECONCILE_STREAMED_ABOVE", 1)
    monkeypatch.setattr(gv_config, "PROJECTION_PAGE", 1)
    monkeypatch.setattr(gv_config, "PROJECTION_PASS_MAX_SECS", 1e-6)
    passes, seen = 0, []
    while True:
        out = await FalkorProjector(graph_client_factory=fake).project_graph(gid)
        ps = await _ps(gid)
        seen.append((ps.candidate_state["step"], ps.candidate_state.get("seedPhase"),
                     bool(out.get("partial"))))
        passes += 1
        if ps.candidate_state.get("seedPhase") == "summaries" or passes > 20:
            break
    name = ps.candidate_graph_name
    assert passes > 2 and all(step == "seeding" for step, _phase, _p in seen), seen
    assert any(partial for _s, phase, partial in seen if phase == "raw"), seen
    assert fake.graphs[name].seed_of == ps.candidate_state["id"]

    # Its node restarts without the key before the summaries are carried over: seeded again.
    fake.graphs[name].drop()
    monkeypatch.setattr(gv_config, "PROJECTION_PASS_MAX_SECS", 300.0)
    await FalkorProjector(graph_client_factory=fake).project_graph(gid)
    assert (await _ps(gid)).candidate_state["seedPhase"] == "raw"
    await FalkorProjector(graph_client_factory=fake).project_graph(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["step"], ps.candidate_seq) == ("catching_up", 3)
    assert fake.graphs[name].summaries == serving.summaries

    # The catch-up fails: seeded again in its key (summaries carried over again), not copied.
    real = FalkorProjector._build_catch_up

    async def broken(self, *a, **k):
        raise ConnectionError("the node went away mid-catch-up")

    monkeypatch.setattr(FalkorProjector, "_build_catch_up", broken)
    await FalkorProjector(graph_client_factory=fake).project_graph(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["step"], ps.candidate_state["seedPhase"]) == ("seeding", "raw")
    assert ps.candidate_state["attempts"] == 1 and "mid-catch-up" in ps.candidate_state["error"]
    monkeypatch.setattr(FalkorProjector, "_build_catch_up", real)
    await _no_backoff(gid)
    for _ in range(3):                                   # seeded again, caught up, switched
        await FalkorProjector(graph_client_factory=fake).project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and (ps.falkor_graph_name, ps.projected_commit_seq) == (
        name, 4)
    assert serving.copies == 0 and fake.graphs[name].summaries == serving.summaries
    await _assert_matches_main(svc, fake, gid)


def test_a_seed_survives_restarts_a_lost_key_and_a_failed_catch_up(builds_on, monkeypatch):
    asyncio.run(_run_a_seed_survives_restarts_a_lost_key_and_a_failed_catch_up(builds_on,
                                                                               monkeypatch))


async def _run_a_graph_that_stops_reading_beside_drops_its_build(state) -> None:
    state["policy"] = _policy(buildMode="reseed")
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    state["summaries_met"] = True                       # held at seeding for this pass
    await proj.project_graph(gid)
    ps = await _ps(gid)
    name = ps.candidate_graph_name
    assert ps.candidate_state["step"] == "seeding"
    # An administrator chooses Keep serving, update in place: the build goes, with its key, and
    # the change is written into the serving key.
    assert await svc.set_read_mode(gid, "in_place") == (True, "beside")
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.retired_keys[-1]["name"] == name
    await proj.project_graph(gid)
    assert (await _ps(gid)).projected_commit_seq == 4
    await _assert_matches_main(svc, fake, gid)


def test_a_graph_that_stops_reading_beside_drops_its_build(builds_on):
    asyncio.run(_run_a_graph_that_stops_reading_beside_drops_its_build(builds_on))


async def _owe(gid: str, **state) -> None:
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        for column, value in state.items():
            setattr(row, column, value)


async def _run_summaries_a_build_owes_are_recorded_with_its_switch(monkeypatch) -> None:
    """A build's switch hands the lineage summaries it could not keep exact to the batch job, and
    records the ask in the same transaction: should the hand-off never run (the pod stops right
    after the switch), the liveness loop asks again. What a full seed owed (``moved``) goes with
    the switch too, as no window published after it would hand it over."""
    from backend.app.services.versioning import config as gv_config

    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")
    await proj.project_graph(gid)                       # copied
    await proj.project_graph(gid)                       # caught up, a delta it could not move
    build = (await _ps(gid)).candidate_state
    await _owe(gid, candidate_state={**build, "rollupsStale": True},
               rollup_state={"moved": "2026-11-14T00:00:00+00:00"})
    real = FalkorProjector.run_publish_hooks

    async def stopped(self, graph_id, **kw):
        raise ConnectionError("the pod stopped")

    monkeypatch.setattr(FalkorProjector, "run_publish_hooks", stopped)
    await proj.project_graph(gid)                       # switched; the hand-off never ran
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 4
    assert ps.rollup_state["pending"] == "switched" and ps.rollup_state["asked"], ps.rollup_state
    assert "moved" not in ps.rollup_state, "a full seed's debt is handed over with the switch"
    monkeypatch.setattr(FalkorProjector, "run_publish_hooks", real)

    asked = []

    async def hand_off(graph_id, idempotency_key=None):  # as make_rollup_rebuild_hook records it
        asked.append(graph_id)
        await svc.note_rollup_ask(graph_id, "queued")

    monkeypatch.setattr(gv_config, "ROLLUP_REASK_SECS", 1)
    await _owe(gid, rollup_state={**ps.rollup_state, "asked": "2000-01-01T00:00:00+00:00"})
    await FalkorProjector(graph_client_factory=fake,
                          on_rollups_stale=hand_off)._ask_again_for_summaries()
    assert asked.count(gid) == 1 and (await _ps(gid)).rollup_state is None

    # A full seed's debt: handed over with the next switch, never dropped by a window publish.
    await _edit_publish(svc, gid, "a", _create("F", "G"), "another large change")
    with_hook = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    await with_hook.project_graph(gid)                  # copied
    await with_hook.project_graph(gid)                  # caught up
    await _owe(gid, rollup_state={"moved": "2026-11-14T00:00:00+00:00"})
    asked.clear()
    await with_hook.project_graph(gid)                  # switched
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 5
    assert asked == [gid] and ps.rollup_state is None
    await _assert_matches_main(svc, fake, gid)

    # Nothing owed: nothing asked for, nothing recorded.
    await _edit_publish(svc, gid, "a", _create("H", "I"), "a third")
    asked.clear()
    for _ in range(3):
        await with_hook.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 6
    assert asked == [] and ps.rollup_state is None


def test_summaries_a_build_owes_are_recorded_with_its_switch(builds_on, monkeypatch):
    asyncio.run(_run_summaries_a_build_owes_are_recorded_with_its_switch(monkeypatch))


# ── rebuilds built beside the serving key (``buildForRebuilds``) ─────────────────────────────


def _hand_offs(svc) -> tuple:
    """A summaries hand-off that records its asks, as ``make_rollup_rebuild_hook`` does once one
    is queued; and the list of graphs it was asked for."""
    asked: list = []

    async def hand_off(graph_id, idempotency_key=None):
        asked.append(graph_id)
        await svc.note_rollup_ask(graph_id, "queued")

    return hand_off, asked


def _in_place(ps) -> dict:
    """What a rebuild or a move in place leaves on a graph's row, in terms two graphs compare on:
    not its ids, its key's name or its epoch. A build's retired key is left out."""
    return {"projected": ps.projected_commit_seq, "served": ps.served_commit_seq,
            "target": ps.target_commit_seq, "status": ps.status, "last_error": ps.last_error,
            "failed_attempts": ps.failed_attempts, "next_retry_at": ps.next_retry_at,
            "pressure_failures": ps.pressure_failures, "window_rows": ps.window_rows,
            "owes_summaries": bool((ps.rollup_state or {}).get("moved")),
            "owned": ps.owns_falkor_graph, "progress": (ps.progress_done, ps.progress_total),
            "build": (ps.candidate_graph_name, ps.candidate_provider, ps.candidate_seq,
                      ps.candidate_state),
            "retired": [{k: v for k, v in e.items() if k not in ("name", "retireAfter")}
                        for e in ps.retired_keys or [] if "build" not in e]}


async def _run_an_operator_rebuild_is_built_beside_and_switched_to(state) -> None:
    """A rebuild of a graph that reads ``beside`` is built in a key of its own, seeded from
    Postgres at the head whatever ``buildMode`` says, while readers keep exactly the version the
    serving key serves; the serving key is never written. Then one switch, and the summaries,
    carried over as far as they go, are handed to the batch job once. The serving key's last error
    still describes it until then; a second ask finds the rebuild running."""
    state["policy"] = _policy(buildMode="copy")
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    old = (await _ps(gid)).falkor_graph_name
    _summaries_on(serving)
    await _owe(gid, last_error="an earlier pass failed")
    before = copy.deepcopy((_snapshot(serving), serving.summaries, serving.markers))
    hand_off, asked = _hand_offs(svc)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    was = await _ps(gid)

    assert await svc.request_projection_rebuild(gid)
    ps = await _ps(gid)
    build = ps.candidate_state
    assert (build["reason"], build["mode"], build["step"], build["rollupsStale"]) == (
        "rebuild", "reseed", "queued", True)
    assert build["rebuild"] == {"cause": "operator", "why": None}
    assert (ps.projected_commit_seq, ps.served_commit_seq, ps.status, ps.next_retry_at,
            ps.failed_attempts, ps.last_error) == (3, 3, "idle", None, 0, "an earlier pass failed")
    assert ps.epoch == was.epoch + 1 and ps.falkor_graph_name == old
    wm = await svc.projection_watermark(gid)
    assert (wm["served"], wm["candidate"]["reason"], wm["candidate"]["rebuild"]) == (
        3, "rebuild", "operator")
    assert not await svc.request_projection_rebuild(gid), "a second ask finds it running"

    # A publish meanwhile: the seed takes the head when it is admitted.
    await _edit_publish(svc, gid, "a", _create("D"), "a change")
    await proj.project_graph(gid)                       # seeded at the head, summaries carried
    ps = await _ps(gid)
    name = ps.candidate_graph_name
    assert state["seeded_on"] == [name] and serving.copies == 0, "seeded, never copied"
    assert (ps.candidate_state["seedSeq"], ps.candidate_state["step"], ps.candidate_seq) == (
        4, "catching_up", 4)
    assert fake.graphs[name].summaries == serving.summaries
    assert (await svc.projection_watermark(gid))["served"] == 3
    await proj.project_graph(gid)                       # checked and switched
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.projected_commit_seq, ps.served_commit_seq) == (name, 4, 4)
    assert ps.candidate_state is None and ps.last_error is None
    (entry,) = ps.retired_keys
    assert (entry["name"], entry["afterSeq"], entry["build"]) == (old, 4, build["id"])
    assert asked == [gid] and ps.rollup_state is None, "handed to the batch job once"
    await _assert_matches_main(svc, fake, gid)
    assert copy.deepcopy((_snapshot(serving), serving.summaries, serving.markers)) == before


def test_an_operator_rebuild_is_built_beside_and_switched_to(builds_on):
    asyncio.run(_run_an_operator_rebuild_is_built_beside_and_switched_to(builds_on))


async def _run_a_drifted_serving_key_is_rebuilt_beside(state) -> None:
    """The serving key holds what history does not (a node, and a summary cell on it): the rebuild
    seeds the new key from Postgres, leaves out the cell whose end it does not hold, and switches;
    the new key holds main."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    _summaries_on(serving)
    (sa, na) = sorted(serving.nodes.items())[0]
    serving.nodes["urn:stray"] = {"entityId": "stray", "urn": "urn:stray", "_label": "Dataset"}
    serving._id_of("urn:stray")
    serving.summaries[("Dataset", "urn:stray", na["_label"], sa)] = {"weight": 1, "gvSeq": 3}
    assert await svc.request_projection_rebuild(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    built = fake.graphs[ps.candidate_graph_name]
    assert ps.candidate_state["step"] == "catching_up"
    assert not any("urn:stray" in cell for cell in built.summaries), built.summaries
    assert len(built.summaries) == 1                    # the cell between two of main's nodes
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 3
    assert "urn:stray" not in fake.graphs[ps.falkor_graph_name].nodes
    await _assert_matches_main(svc, fake, gid)


def test_a_drifted_serving_key_is_rebuilt_beside(builds_on):
    asyncio.run(_run_a_drifted_serving_key_is_rebuilt_beside(builds_on))


def _drifting(monkeypatch):
    """Every verify finds drift a heal cannot fix, and asks for a rebuild (``escalate``). Returns
    what puts the verify back."""
    from backend.app.services.versioning import config as gv_config

    real = FalkorProjector._verify_and_heal

    async def drifted(self, client, graph_id, main_id, from_seq, to_seq, level_map=None, *,
                      heal_outcome, **k):
        heal_outcome["escalate"] = "it holds less than history"
        return "count mismatch", False

    monkeypatch.setattr(gv_config, "PROJECTION_VERIFY_INTERVAL_SECS", 0)
    monkeypatch.setattr(FalkorProjector, "_verify_and_heal", drifted)
    return lambda: monkeypatch.setattr(FalkorProjector, "_verify_and_heal", real)


async def _run_a_rebuild_the_projector_starts_on_its_own_is_built_beside(state,
                                                                         monkeypatch) -> None:
    """A window whose verify finds drift escalates: a graph that reads ``beside`` has the rebuild
    built beside its key. Readers keep the version it serves; its last error says why, so forks
    read Postgres meanwhile; the window's pressure and failures are forgotten. The switch hands
    the summaries to the batch job, once, and clears what the window owed."""
    state["policy"] = _policy(buildAboveRows=1000)       # the window itself is written in place
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    hand_off, asked = _hand_offs(svc)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    healthy = _drifting(monkeypatch)
    await _edit_publish(svc, gid, "a", _create("D"), "a change")
    await proj.project_graph(gid)                       # held back, then escalated
    ps = await _ps(gid)
    build = ps.candidate_state
    assert (build["reason"], build["rebuild"]["cause"]) == ("rebuild", "drift"), build
    assert build["rebuild"]["why"] == "it holds less than history"
    assert ps.last_error == "rebuilding beside on its own: it holds less than history"
    assert (ps.projected_commit_seq, ps.served_commit_seq, ps.status) == (3, 3, "idle")
    assert (ps.failed_attempts, ps.pressure_failures, ps.next_retry_at) == (0, 0, None)
    assert not (ps.rollup_state or {}).get("moved"), "this window moved no summaries"
    wm = await svc.projection_watermark(gid)
    assert wm["read_route"]["main"] == "falkordb" and wm["served"] == 3
    healthy()
    await proj.project_graph(gid)                       # seeded at the head
    await proj.project_graph(gid)                       # switched
    ps = await _ps(gid)
    assert ps.candidate_state is None and (ps.projected_commit_seq, ps.last_error) == (4, None)
    assert asked == [gid] and ps.rollup_state is None
    await _assert_matches_main(svc, fake, gid)

    # One whose window moved the summaries owes them, as the rebuild in place would; the switch
    # hands them over and clears the debt.
    epoch = (await _ps(gid)).epoch
    assert await proj._escalate(gid, epoch, "a window failed again", "failures",
                                summaries_moved=True)
    ps = await _ps(gid)
    assert ps.candidate_state["rebuild"]["cause"] == "failures" and ps.rollup_state["moved"]
    asked.clear()
    await proj.project_graph(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and asked == [gid] and ps.rollup_state is None


def test_a_rebuild_the_projector_starts_on_its_own_is_built_beside(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_the_projector_starts_on_its_own_is_built_beside(builds_on,
                                                                              monkeypatch))


async def _run_a_rebuild_replaces_a_windows_build(state) -> None:
    """A window's build is built beside the key a rebuild distrusts: the rebuild replaces it, its
    key retired at once, and seeds the head from Postgres, which holds the window too."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")
    await proj.project_graph(gid)                       # the window's build: copied
    window = await _ps(gid)
    assert window.candidate_state["reason"] == "window" and serving.copies == 1
    assert await svc.request_projection_rebuild(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["reason"], ps.candidate_state["id"] != window.candidate_state["id"]
            ) == ("rebuild", True)
    retired = ps.retired_keys[-1]
    assert (retired["name"], retired["afterSeq"], retired["build"]) == (
        window.candidate_graph_name, 0, window.candidate_state["id"])
    for _ in range(2):
        await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 4 and serving.copies == 1
    await _assert_matches_main(svc, fake, gid)


def test_a_rebuild_replaces_a_windows_build(builds_on):
    asyncio.run(_run_a_rebuild_replaces_a_windows_build(builds_on))


async def _run_the_poll_takes_a_rebuild_of_a_caught_up_graph_to_its_switch() -> None:
    """Nothing but the poll: a rebuild of a graph that is caught up, never nudged, is taken to its
    switch by ``project_pending``."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    assert await svc.request_projection_rebuild(gid)
    real = proj.project_graph
    taken = []

    async def only_ours(graph_id, **kw):                # other tests' graphs share the database
        if graph_id != gid:
            return {"noop": True}
        taken.append(graph_id)
        return await real(graph_id, **kw)

    proj.project_graph = only_ours
    for _ in range(3):
        await proj.project_pending(limit=100_000)
        if (await _ps(gid)).candidate_state is None:
            break
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.falkor_graph_name.endswith("#b9"), taken
    await _assert_matches_main(svc, fake, gid)


def test_the_poll_takes_a_rebuild_of_a_caught_up_graph_to_its_switch(builds_on):
    asyncio.run(_run_the_poll_takes_a_rebuild_of_a_caught_up_graph_to_its_switch())


def _rebuilt_in_place(before, head: int) -> dict:
    """The row an operator's rebuild in place leaves, from the row before it
    (``request_projection_rebuild`` without builds)."""
    return {**_in_place(before), "projected": 0, "target": head, "status": "rebuilding",
            "last_error": None, "failed_attempts": 0, "next_retry_at": None}


async def _run_a_rebuild_whose_build_is_dropped_is_made_in_place(state, monkeypatch) -> None:
    """Whatever drops a rebuild's build — its attempts used up, no room with ``noRoomPolicy``
    in_place, New-version builds turned off before it began, the graph no longer reading
    ``beside`` — the rebuild is made in place: the row is, field by field, the row a twin graph's
    rebuild in place leaves, and the next pass rebuilds the serving key as the twin's does. The
    build's key is retired at once."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    real_seed = FalkorProjector._build_seed

    async def failing_seed(self, *a, **k):
        raise ConnectionError("the node went away mid-seed")

    for case in ("attempts", "no_room", "switch_off", "left_beside"):
        state.update(policy=_policy(), switch=True, seed_room=Admitted(True, "node2", None, None))
        a, proj, _serving = await _seed(svc, fake)
        b, _proj, _twin = await _seed(svc, fake)
        for gid in (a, b):
            await _beside(svc, gid)
        state["policy"] = _policy(buildForRebuilds=False)
        assert await svc.request_projection_rebuild(b)        # the twin, rebuilt in place
        state["policy"] = _policy()
        assert await svc.request_projection_rebuild(a)
        assert (await _ps(a)).candidate_state["reason"] == "rebuild"
        if case == "attempts":
            state["policy"] = _policy(buildMaxAttempts=1)
            monkeypatch.setattr(FalkorProjector, "_build_seed", failing_seed)
        elif case == "no_room":
            state["policy"] = _policy(noRoomPolicy="in_place")
            state["seed_room"] = Admitted(False, "node2", 2048, "capacity")
        elif case == "switch_off":
            state["switch"] = False
        else:
            await svc.set_read_mode(a, "in_place")
        await proj.project_graph(a)                     # dropped, and made in place
        monkeypatch.setattr(FalkorProjector, "_build_seed", real_seed)
        ps = await _ps(a)
        assert _in_place(ps) == _in_place(await _ps(b)), case
        assert (ps.retired_keys[-1]["afterSeq"], bool(ps.retired_keys[-1]["build"])) == (0, True)
        state.update(policy=_policy(), switch=True)
        await proj.project_graph(a)
        await proj.project_graph(b)
        assert (await _ps(a)).projected_commit_seq == (await _ps(b)).projected_commit_seq == 3
        await _assert_matches_main(svc, fake, a)


def test_a_rebuild_whose_build_is_dropped_is_made_in_place(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_whose_build_is_dropped_is_made_in_place(builds_on, monkeypatch))


async def _run_an_escalations_dropped_build_is_rebuilt_as_the_escalation_would(state) -> None:
    """A rebuild the projector started on its own, built beside and dropped, is made in place
    exactly as the escalation makes it without builds — its reason in the last error, the
    pressure count started again, the summaries owed — field by field on a twin graph."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    a, proj, _serving = await _seed(svc, fake)
    b, _proj, _twin = await _seed(svc, fake)
    for gid in (a, b):
        await _beside(svc, gid)
        await _owe(gid, pressure_failures=2, failed_attempts=3, last_error="it timed out")
    state["policy"] = _policy(buildForRebuilds=False)
    assert await proj._escalate(b, (await _ps(b)).epoch, "3 passes in a row failed", "failures",
                                summaries_moved=True)
    assert (await _ps(b)).candidate_state is None
    state["policy"] = _policy()
    assert await proj._escalate(a, (await _ps(a)).epoch, "3 passes in a row failed", "failures",
                                summaries_moved=True)
    assert (await _ps(a)).candidate_state["rebuild"] == {"cause": "failures",
                                                         "why": "3 passes in a row failed"}
    state["switch"] = False                             # turned off before the build began
    await proj.project_graph(a)
    ps = await _ps(a)
    assert ps.candidate_state is None
    assert _in_place(ps) == _in_place(await _ps(b))
    assert ps.last_error == "rebuilding on its own: 3 passes in a row failed"


def test_an_escalations_dropped_build_is_rebuilt_as_the_escalation_would(builds_on):
    asyncio.run(_run_an_escalations_dropped_build_is_rebuilt_as_the_escalation_would(builds_on))


async def _run_a_rebuild_is_made_in_place_whenever_beside_does_not_apply(state,
                                                                       monkeypatch) -> None:
    """The guard on the rest: a rebuild is made in place, exactly as before builds — the row as an
    operator's rebuild in place leaves it, no build asked for — when the graph does not read
    ``beside``, New-version builds is off or can't be read, ``buildForRebuilds`` is off, the key is
    the customer's, the graph serves nothing yet (watermark 1), or a pass already has the row; one
    refused as running changes nothing, and one out of FalkorDB asks for its load. And a rebuild
    the projector starts on its own is made as its escalation always made it."""
    from backend.app.services.versioning import residency as gv_residency

    loads = []

    async def load(graph_id):
        loads.append(graph_id)

    monkeypatch.setattr(gv_residency, "request_load", load)
    svc, fake = GraphVersioningService(), BuildFalkor()
    cases = [("latest mode", {}, {}), ("in place mode", {}, {}), ("switch off", {"switch": False}, {}),
             ("switch unread", {"switch": None}, {}),
             ("rebuilds in place", {"policy": _policy(buildForRebuilds=False)}, {}),
             ("customer key", {}, {"owns_falkor_graph": False}),
             ("at genesis", {}, {"projected_commit_seq": 1, "served_commit_seq": None}),
             ("pass in flight, caught up", {}, {"status": "projecting"}),
             ("rebuilding behind", {}, {"status": "rebuilding", "target_commit_seq": 9}),
             ("evicted", {}, {"status": "evicted"})]
    for case, policy, row in cases:
        state.update({"policy": _policy(), "switch": True, **policy})
        gid, _proj, _serving = await _seed(svc, fake)
        await svc.set_read_mode(gid, {"latest mode": "latest",
                                      "in place mode": "in_place"}.get(case, "beside"))
        if row:
            await _owe(gid, **row)
        before = await _ps(gid)
        started = await svc.request_projection_rebuild(gid)
        after = await _ps(gid)
        assert after.candidate_state is None, case
        if case == "rebuilding behind":
            assert not started and _in_place(after) == _in_place(before), case
        elif case == "evicted":
            assert started and _in_place(after) == _in_place(before) and loads[-1] == gid, case
        else:
            assert started and _in_place(after) == _rebuilt_in_place(before, 3), case

    # An escalation, beside not wanted: the fenced reset it always made.
    for case, policy in (("in place mode", {}), ("rebuilds in place",
                                                {"policy": _policy(buildForRebuilds=False)})):
        state.update({"policy": _policy(), "switch": True, **policy})
        gid, proj, _serving = await _seed(svc, fake)
        await svc.set_read_mode(gid, "in_place" if case == "in place mode" else "beside")
        await _owe(gid, pressure_failures=3, failed_attempts=2)
        before = await _ps(gid)
        assert await proj._escalate(gid, before.epoch, "drift", "drift")
        after = await _ps(gid)
        assert after.candidate_state is None and _in_place(after) == {
            **_in_place(before), "projected": 0, "target": 3, "status": "rebuilding",
            "failed_attempts": 0, "pressure_failures": 0, "next_retry_at": None,
            "last_error": "rebuilding on its own: drift"}, case
        assert after.epoch == before.epoch + 1


def test_a_rebuild_is_made_in_place_whenever_beside_does_not_apply(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_is_made_in_place_whenever_beside_does_not_apply(builds_on,
                                                                              monkeypatch))


async def _run_a_rebuild_of_a_graph_that_must_keep_its_key_is_made_in_place(state,
                                                                           monkeypatch) -> None:
    """A build switches readers to another key, so a graph that must keep its own is rebuilt in
    place: its summaries live in a graph named from its key (dedicated), other data sources read
    its key, or either can't be read. The build is asked for, then dropped at its first step."""
    from backend.app.services.versioning import purge_worker
    from backend.app.services.versioning import residency as gv_residency

    real_dedicated, real_readers = gv_residency._dedicated, purge_worker.graph_key_readers
    svc, fake = GraphVersioningService(), BuildFalkor()
    for case in ("dedicated", "dedicated unread", "shared", "readers unread"):
        gid, proj, _serving = await _seed(svc, fake)
        await _beside(svc, gid)
        ds = (await svc.get_graph(gid))["data_source_id"]

        async def dedicated(ids, case=case, ds=ds):
            return None if case == "dedicated unread" else ({ds} if case == "dedicated" else set())

        async def readers(provider, name, exclude, case=case):
            if case == "readers unread":
                raise ConnectionError("the management database went away")
            return [{"kind": "dataSource"}] if case == "shared" else []

        monkeypatch.setattr(gv_residency, "_dedicated", dedicated)
        monkeypatch.setattr(purge_worker, "graph_key_readers", readers)
        before = await _ps(gid)
        assert await svc.request_projection_rebuild(gid)
        await proj.project_graph(gid)
        ps = await _ps(gid)
        assert ps.candidate_state is None and state["seeded_on"] == [], case
        assert _in_place(ps) == _rebuilt_in_place(before, 3), case
        monkeypatch.setattr(gv_residency, "_dedicated", real_dedicated)
        monkeypatch.setattr(purge_worker, "graph_key_readers", real_readers)


def test_a_rebuild_of_a_graph_that_must_keep_its_key_is_made_in_place(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_of_a_graph_that_must_keep_its_key_is_made_in_place(builds_on,
                                                                                 monkeypatch))


async def _run_a_rebuild_whose_graph_leaves_falkordb_asks_for_its_load(monkeypatch) -> None:
    """The serving key is lost while the rebuild is built (evicted, lost): its build goes, and an
    operator's rebuild asks for the graph's load, as its request would have; the graph stays
    evicted. A load in flight is a rebuild already: the build just goes."""
    from backend.app.services.versioning import residency as gv_residency

    loads = []

    async def load(graph_id):
        loads.append(graph_id)

    monkeypatch.setattr(gv_residency, "request_load", load)
    svc, fake = GraphVersioningService(), BuildFalkor()
    for status, took in (("evicted", [True]), ("rehydrating", [])):
        gid, proj, _serving = await _seed(svc, fake)
        await _beside(svc, gid)
        assert await svc.request_projection_rebuild(gid)
        await _owe(gid, status=status, projected_commit_seq=0, served_commit_seq=None)
        before = await _ps(gid)
        loads.clear()
        await proj.project_graph(gid)
        ps = await _ps(gid)
        assert ps.candidate_state is None and ps.retired_keys[-1]["afterSeq"] == 0, status
        assert [g == gid for g in loads] == took, (status, loads)
        assert _in_place(ps) == {**_in_place(before), "build": (None, None, None, None)}, status


def test_a_rebuild_whose_graph_leaves_falkordb_asks_for_its_load(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_whose_graph_leaves_falkordb_asks_for_its_load(monkeypatch))


async def _run_a_rebuild_survives_restarts_page_by_page(monkeypatch) -> None:
    """A fresh projector every pass, a seed a page at a time, a pass that stops after each page:
    the rebuild is taken up where it was each time, to its switch. The pod stops right after the
    switch: the summaries it owes are recorded, and the liveness loop asks for them again."""
    from backend.app.services.versioning import config as gv_config

    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    _summaries_on(serving)
    assert await svc.request_projection_rebuild(gid)
    monkeypatch.setattr(gv_config, "PROJECTION_RECONCILE_STREAMED_ABOVE", 1)
    monkeypatch.setattr(gv_config, "PROJECTION_PAGE", 1)
    monkeypatch.setattr(gv_config, "PROJECTION_PASS_MAX_SECS", 1e-6)
    real = FalkorProjector.run_publish_hooks

    async def stopped(self, graph_id, **kw):
        raise ConnectionError("the pod stopped")

    monkeypatch.setattr(FalkorProjector, "run_publish_hooks", stopped)
    partial = passes = 0
    while (await _ps(gid)).candidate_state is not None and passes < 30:
        out = await FalkorProjector(graph_client_factory=fake).project_graph(gid)
        partial += bool(out.get("partial"))
        passes += 1
    ps = await _ps(gid)
    assert ps.candidate_state is None and partial >= 2, (passes, partial)
    assert ps.rollup_state["pending"] == "switched", ps.rollup_state
    await _assert_matches_main(svc, fake, gid)
    assert fake.graphs[ps.falkor_graph_name].summaries == serving.summaries
    monkeypatch.setattr(FalkorProjector, "run_publish_hooks", real)
    hand_off, asked = _hand_offs(svc)
    monkeypatch.setattr(gv_config, "ROLLUP_REASK_SECS", 1)
    await _owe(gid, rollup_state={**ps.rollup_state, "asked": "2000-01-01T00:00:00+00:00"})
    await FalkorProjector(graph_client_factory=fake,
                          on_rollups_stale=hand_off)._ask_again_for_summaries()
    assert asked.count(gid) == 1 and (await _ps(gid)).rollup_state is None


def test_a_rebuild_survives_restarts_page_by_page(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_survives_restarts_page_by_page(monkeypatch))


async def _run_a_large_window_of_a_graph_that_must_keep_its_key_is_written_in_place(
        state, monkeypatch) -> None:
    """A window's build switches readers to another key too: a graph whose summaries live in a
    graph named from its key (dedicated), whose key other data sources read, or for which either
    can't be read, has a large window written in place, as before builds — no build asked for."""
    from backend.app.services.versioning import purge_worker
    from backend.app.services.versioning import residency as gv_residency

    svc, fake = GraphVersioningService(), BuildFalkor()
    for case in ("dedicated", "dedicated unread", "shared", "readers unread"):
        gid, proj, serving = await _seed(svc, fake)
        await _beside(svc, gid)
        ds = (await svc.get_graph(gid))["data_source_id"]

        async def dedicated(ids, case=case, ds=ds):
            return None if case == "dedicated unread" else ({ds} if case == "dedicated" else set())

        async def readers(provider, name, exclude, case=case):
            if case == "readers unread":
                raise ConnectionError("the management database went away")
            return [{"kind": "catalogItem"}] if case == "shared" else []

        monkeypatch.setattr(gv_residency, "_dedicated", dedicated)
        monkeypatch.setattr(purge_worker, "graph_key_readers", readers)
        await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")
        await proj.project_graph(gid)
        ps = await _ps(gid)
        assert ps.candidate_state is None and ps.projected_commit_seq == 4, case
        assert serving.copies == 0 and not ps.retired_keys, case
        await _assert_matches_main(svc, fake, gid)


def test_a_large_window_of_a_graph_that_must_keep_its_key_is_written_in_place(builds_on,
                                                                              monkeypatch):
    asyncio.run(_run_a_large_window_of_a_graph_that_must_keep_its_key_is_written_in_place(
        builds_on, monkeypatch))


# ── moves built beside the serving key (``buildForRebuilds``) ─────────────────────────────────


def _target(fake, gid: str, n: int = 1) -> str:
    """The graph's ``n``-th platform key, which this test's store answers for, not there yet."""
    key = keymigrate.owned_key(gid, n)
    fake.ours.add(key)
    fake(key).exists = False
    return key


async def _move(svc, gid: str, key: str, provider: str = "prov_b", **kw) -> dict:
    return await svc.move_projection(graph_id=gid, provider=provider, key=key, actor="usr_1",
                                     shard_map={"tag": "t", "chosenBy": "usr_1"}, **kw)


async def _run_a_move_is_built_beside_and_switched_to(state) -> None:
    """A move of a graph that reads ``beside`` seeds its new key, on its new provider, from
    Postgres at the version served, carrying the serving key's summaries over exactly, while
    readers keep that version on the old key: nothing retires, the pin and shard map stay. A
    publish meanwhile lands in the new key, never the old one. Then one switch: the new key is the
    pin on its provider with the move's shard map, and the old key retires after the grace."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    _summaries_on(serving)
    was = await _ps(gid)
    old, target = was.falkor_graph_name, _target(fake, gid)

    res = await _move(svc, gid, target)
    assert (res["changed"], res["beside"], res["retiring"], res["cancelled"]) == (
        True, True, None, None)
    assert (res["building"]["reason"], res["building"]["step"], res["building"]["target"]) == (
        "move", "queued", {"providerId": "prov_b", "key": target})
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.falkor_provider, ps.shard_map) == (old, None, was.shard_map)
    assert (ps.projected_commit_seq, ps.served_commit_seq, ps.status) == (3, 3, "idle")
    assert (ps.candidate_graph_name, ps.candidate_provider) == (target, "prov_b")
    assert ps.epoch == was.epoch + 1 and not ps.retired_keys
    before = copy.deepcopy((_snapshot(serving), serving.summaries, serving.markers))

    await proj.project_graph(gid)                       # admitted on its key, seeded, carried
    ps = await _ps(gid)
    built = fake.graphs[target]
    assert state["seeded_on"] == [target]
    assert (ps.candidate_state["step"], ps.candidate_state["seedSeq"], ps.candidate_seq) == (
        "catching_up", 3, 3)
    assert built.summaries == serving.summaries and built.markers == serving.markers
    await _edit_publish(svc, gid, "a", _create("D"), "a change while it moves")
    await proj.project_graph(gid)                       # caught up into the new key
    assert (await _ps(gid)).candidate_seq == 4
    assert copy.deepcopy((_snapshot(serving), serving.summaries, serving.markers)) == before
    assert (await svc.projection_watermark(gid))["served"] == 3
    await proj.project_graph(gid)                       # switched
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.falkor_provider, ps.projected_commit_seq,
            ps.served_commit_seq) == (target, "prov_b", 4, 4)
    assert ps.shard_map == {"tag": "t", "chosenBy": "usr_1"} and ps.candidate_state is None
    (entry,) = ps.retired_keys
    assert (entry["name"], entry["provider"], entry["afterSeq"], entry["movedBy"]) == (
        old, None, 4, "usr_1")
    assert entry["build"] == res["building"]["id"] and ps.rollup_state is None
    await _assert_matches_main(svc, fake, gid)

    async def nobody(*a):
        return []

    gone = await keymigrate.retire_moved_keys(proj, key_in_use=nobody,
                                              now="9999-01-01T00:00:00+00:00")
    assert [(g["key"], g["verdict"]) for g in gone if g["graphId"] == gid] == [(old, "dropped")]
    assert not fake.graphs[old].exists


def test_a_move_is_built_beside_and_switched_to(builds_on):
    asyncio.run(_run_a_move_is_built_beside_and_switched_to(builds_on))


async def _run_the_same_move_again_another_move_or_a_move_back_while_it_is_built() -> None:
    """While a move is built: the same move again changes nothing and answers its build; a move to
    another key replaces it, the first key retired at once; a move back to the key the graph is
    on cancels it, its key retired at once — and the graph never left its key."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    old = (await _ps(gid)).falkor_graph_name
    first, second = _target(fake, gid, 1), _target(fake, gid, 2)
    one = await _move(svc, gid, first)
    again = await _move(svc, gid, first)
    assert (again["changed"], again["beside"], again["building"]["id"]) == (
        False, True, one["building"]["id"])
    other = await _move(svc, gid, second)
    assert other["changed"] and other["building"]["id"] != one["building"]["id"]
    ps = await _ps(gid)
    assert ps.candidate_graph_name == second
    assert [(e["name"], e["afterSeq"], e["build"]) for e in ps.retired_keys] == [
        (first, 0, one["building"]["id"])]
    back = await _move(svc, gid, old, provider="default")
    assert (back["changed"], back["cancelled"], back["beside"]) == (
        False, other["building"]["id"], False)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.falkor_graph_name == old
    assert (ps.projected_commit_seq, ps.served_commit_seq, ps.status) == (3, 3, "idle")
    assert [e["name"] for e in ps.retired_keys] == [first, second]


def test_the_same_move_again_another_move_or_a_move_back_while_it_is_built(builds_on):
    asyncio.run(_run_the_same_move_again_another_move_or_a_move_back_while_it_is_built())


async def _run_a_rebuild_during_a_move_and_a_move_during_a_rebuild() -> None:
    """A rebuild asked while a move is built makes the move rebuild too (same build: it seeds the
    head, its summaries handed to the job); asked again, it is running. A move asked while a
    rebuild is built replaces it, carrying the rebuild on."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    hand_off, asked = _hand_offs(svc)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    target = _target(fake, gid)
    res = await _move(svc, gid, target)
    await _edit_publish(svc, gid, "a", _create("D"), "a change")   # head 4, served 3
    assert await svc.request_projection_rebuild(gid)
    ps = await _ps(gid)
    assert ps.candidate_state["id"] == res["building"]["id"]
    assert (ps.candidate_state["rebuild"], ps.candidate_state["rollupsStale"]) == (
        {"cause": "operator", "why": None}, True)
    assert not await svc.request_projection_rebuild(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert (ps.candidate_state["seedSeq"], ps.candidate_seq) == (4, 4), ps.candidate_state
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.falkor_graph_name == target and asked == [gid]
    await _assert_matches_main(svc, fake, gid)

    other, proj2, _s = await _seed(svc, fake)
    await _beside(svc, other)
    assert await svc.request_projection_rebuild(other)
    rebuild = await _ps(other)
    moved = await _move(svc, other, _target(fake, other))
    ps = await _ps(other)
    assert moved["changed"] and ps.candidate_state["reason"] == "move"
    assert ps.candidate_state["rebuild"] == {"cause": "operator", "why": None}
    assert (ps.retired_keys[-1]["name"], ps.retired_keys[-1]["afterSeq"]) == (
        rebuild.candidate_graph_name, 0)


def test_a_rebuild_during_a_move_and_a_move_during_a_rebuild(builds_on):
    asyncio.run(_run_a_rebuild_during_a_move_and_a_move_during_a_rebuild())


async def _run_a_move_replaces_a_windows_build() -> None:
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a large change")
    await proj.project_graph(gid)                       # the window's build: copied
    window = await _ps(gid)
    target = _target(fake, gid)
    assert (await _move(svc, gid, target))["beside"]
    ps = await _ps(gid)
    assert (ps.retired_keys[-1]["name"], ps.retired_keys[-1]["afterSeq"]) == (
        window.candidate_graph_name, 0)
    for _ in range(3):
        await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.falkor_graph_name == target
    assert ps.projected_commit_seq == 4 and serving.copies == 1
    await _assert_matches_main(svc, fake, gid)


def test_a_move_replaces_a_windows_build(builds_on):
    asyncio.run(_run_a_move_replaces_a_windows_build())


def _moved_in_place(before, head: int, *, provider) -> dict:
    """The row a move in place leaves, from the row before it (``move_projection`` without
    builds), in ``_in_place``'s terms; and the old key retired after the move's grace."""
    out = before.status in ("evicted", "waiting_capacity", "rehydrating")
    seen = _in_place(before)
    return {**seen, "projected": 0, "served": None, "target": head,
            "status": "evicted" if out else "reseeding", "last_error": None,
            "failed_attempts": 0, "next_retry_at": None, "progress": (None, None), "owned": True,
            "retired": [*seen["retired"], {"provider": before.falkor_provider, "afterSeq": head,
                                           "movedBy": "usr_1"}]}


async def _run_a_move_whose_build_is_dropped_is_made_in_place(state, monkeypatch) -> None:
    """Whatever drops a move's build, the move is made in place to its key: field by field the row
    a twin's move in place leaves, the key not retired, and the next pass reseeds it in place to
    the head. Once the build wrote into the key, its summaries are owed the job as well."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    real_seed = FalkorProjector._build_seed

    async def failing_seed(self, *a, **k):
        raise ConnectionError("the node went away mid-seed")

    for case in ("switch_off", "left_beside", "no_room", "attempts"):
        state.update(policy=_policy(), switch=True, seed_room=Admitted(True, "node2", None, None))
        a, proj, _serving = await _seed(svc, fake)
        b, _proj, _twin = await _seed(svc, fake)
        for gid in (a, b):
            await _beside(svc, gid)
        state["policy"] = _policy(buildForRebuilds=False)
        twin_before = await _ps(b)
        assert (await _move(svc, b, _target(fake, b)))["retiring"]
        state["policy"] = _policy()
        before, target = await _ps(a), _target(fake, a)
        assert (await _move(svc, a, target))["beside"]
        if case == "switch_off":
            state["switch"] = False
        elif case == "left_beside":
            await svc.set_read_mode(a, "in_place")
        elif case == "no_room":
            state["policy"] = _policy(noRoomPolicy="in_place")
            state["seed_room"] = Admitted(False, "node2", 2048, "capacity")
        else:
            state["policy"] = _policy(buildMaxAttempts=1)
            monkeypatch.setattr(FalkorProjector, "_build_seed", failing_seed)
        await proj.project_graph(a)                     # dropped, and moved in place
        monkeypatch.setattr(FalkorProjector, "_build_seed", real_seed)
        ps, twin = await _ps(a), await _ps(b)
        expect = _in_place(twin)
        if case == "attempts":                          # it was admitted: seeding
            expect["owes_summaries"] = True
        assert _in_place(ps) == expect, case
        assert _in_place(twin) == _moved_in_place(twin_before, 3, provider="prov_b"), case
        assert (ps.falkor_graph_name, ps.falkor_provider) == (target, "prov_b"), case
        assert ps.shard_map == twin.shard_map and target not in [e["name"] for e in
                                                                 ps.retired_keys], case
        state.update(policy=_policy(), switch=True)
        await proj.project_graph(a)                     # reseeded in place, to the head
        assert (await _ps(a)).projected_commit_seq == 3, case
        await _assert_matches_main(svc, fake, a)
        assert _in_place(before)["projected"] == 3


def test_a_move_whose_build_is_dropped_is_made_in_place(builds_on, monkeypatch):
    asyncio.run(_run_a_move_whose_build_is_dropped_is_made_in_place(builds_on, monkeypatch))


async def _run_a_dropped_move_whose_key_another_graph_took_stays(state) -> None:
    """Another graph projects into the move's key by the time its build is dropped: the move is not
    made. The graph stays on its key, the move's key is retired at once (the retire run leaves
    the other graph's pin), and the last error says so."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    old, target = (await _ps(gid)).falkor_graph_name, _target(fake, gid)
    await _move(svc, gid, target)
    rival, _p, _s = await _seed(svc, fake)
    await _owe(rival, falkor_graph_name=target, falkor_provider="prov_b")
    try:
        await svc.set_read_mode(gid, "in_place")
        await proj.project_graph(gid)
        ps = await _ps(gid)
        assert ps.candidate_state is None and (ps.falkor_graph_name, ps.falkor_provider) == (
            old, None)
        assert ps.last_error == f"the move to '{target}' was not made: another graph projects into it"
        assert (ps.retired_keys[-1]["name"], ps.retired_keys[-1]["afterSeq"]) == (target, 0)
        assert (ps.projected_commit_seq, ps.served_commit_seq) == (3, 3)
    finally:
        await _owe(rival, falkor_graph_name=None)


def test_a_dropped_move_whose_key_another_graph_took_stays(builds_on):
    asyncio.run(_run_a_dropped_move_whose_key_another_graph_took_stays(builds_on))


async def _run_a_move_whose_graph_leaves_falkordb_is_made_in_place_and_loaded(
        monkeypatch) -> None:
    """The serving key is lost while the move is built (evicted): the move is made in place, the
    graph still out of FalkorDB, its new key's partial content retired at once (its load writes
    the key it places), and its load asked for."""
    from backend.app.services.versioning import residency as gv_residency

    loads = []

    async def load(graph_id):
        loads.append(graph_id)

    monkeypatch.setattr(gv_residency, "request_load", load)
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    target = _target(fake, gid)
    await _move(svc, gid, target)
    await _owe(gid, status="evicted", projected_commit_seq=0, served_commit_seq=None)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and loads == [gid]
    assert (ps.falkor_graph_name, ps.falkor_provider, ps.status) == (target, "prov_b", "evicted")
    assert (ps.retired_keys[-1]["name"], ps.retired_keys[-1]["afterSeq"]) == (target, 0)


def test_a_move_whose_graph_leaves_falkordb_is_made_in_place_and_loaded(builds_on, monkeypatch):
    asyncio.run(_run_a_move_whose_graph_leaves_falkordb_is_made_in_place_and_loaded(monkeypatch))


async def _run_a_move_is_made_in_place_whenever_beside_does_not_apply(state) -> None:
    """The guard on the rest: a move is made in place exactly as before builds — field by field,
    no build asked for — when the graph does not read ``beside``, New-version builds is off or
    can't be read, ``buildForRebuilds`` is off, a pass or a rebuild has the row, the graph serves
    nothing yet (watermark 1), the key does not hold its version whole (nothing served, or a window
    part-written), or the graph is out of FalkorDB. A customer's key is refused, as before."""
    from backend.app.services.versioning.errors import ProjectionNotAdopted

    svc, fake = GraphVersioningService(), BuildFalkor()
    cases = [("latest mode", {}, {}), ("in place mode", {}, {}),
             ("switch off", {"switch": False}, {}), ("switch unread", {"switch": None}, {}),
             ("moves in place", {"policy": _policy(buildForRebuilds=False)}, {}),
             ("pass in flight", {}, {"status": "projecting"}),
             ("rebuilding", {}, {"status": "rebuilding", "projected_commit_seq": 0}),
             ("at genesis", {}, {"projected_commit_seq": 1, "served_commit_seq": None}),
             ("nothing served", {}, {"served_commit_seq": None}),
             ("window in flight", {}, {"window_rows": 900}),
             ("evicted", {}, {"status": "evicted", "projected_commit_seq": 0,
                              "served_commit_seq": None})]
    for case, policy, row in cases:
        state.update({"policy": _policy(), "switch": True, **policy})
        gid, _proj, _serving = await _seed(svc, fake)
        await svc.set_read_mode(gid, {"latest mode": "latest",
                                      "in place mode": "in_place"}.get(case, "beside"))
        if row:
            await _owe(gid, **row)
        before, target = await _ps(gid), _target(fake, gid)
        res = await _move(svc, gid, target)
        after = await _ps(gid)
        assert res["changed"] and not res["beside"] and res["retiring"]["afterSeq"] == 3, case
        assert after.candidate_state is None, case
        assert _in_place(after) == _moved_in_place(before, 3, provider="prov_b"), case
        assert (after.falkor_graph_name, after.falkor_provider) == (target, "prov_b"), case
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _owe(gid, owns_falkor_graph=False)
    try:
        await _move(svc, gid, _target(fake, gid))
        raise AssertionError("a customer's key moved")
    except ProjectionNotAdopted:
        assert (await _ps(gid)).candidate_state is None


def test_a_move_is_made_in_place_whenever_beside_does_not_apply(builds_on):
    asyncio.run(_run_a_move_is_made_in_place_whenever_beside_does_not_apply(builds_on))


async def _run_a_move_back_onto_a_key_with_a_stale_cursor_seeds_it_whole(state,
                                                                       monkeypatch) -> None:
    """A move back onto a key the graph left: the key still holds what it served then, and a cursor
    an earlier pass left, which says its nodes are done. The move's first pass clears the cursor
    before the seed writes a page, so the key is reconciled whole — not resumed past nodes it
    never wrote, whose count can match main's while their content does not. Admitted with the
    request, it starts seeding."""
    from backend.app.services.versioning import config as gv_config

    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    home = (await _ps(gid)).falkor_graph_name
    away = _target(fake, gid)
    await _move(svc, gid, away)
    for _ in range(3):
        await proj.project_graph(gid)
    assert (await _ps(gid)).falkor_graph_name == away and serving.exists
    # Main moves on: C goes, D comes; the key left behind still holds A, B, C — three nodes, as
    # main does now — and a cursor that says its nodes were done.
    c_id = next(n["entityId"] for n in serving.nodes.values() if n["displayName"] == "C")
    await _edit_publish(svc, gid, "a", [{"op": "delete", "entity_kind": "node", "entity_id": c_id}]
                        + _create("D"), "C out, D in")
    state["policy"] = _policy(buildAboveRows=1000)          # written in place
    await proj.project_graph(gid)
    state["policy"] = _policy()
    assert (await _ps(gid)).served_commit_seq == 4
    serving.cursor = {"from": 0, "to": 4, "step": "edge", "after": "", "structural": False,
                      "dropped": 0}
    monkeypatch.setattr(gv_config, "PROJECTION_RECONCILE_STREAMED_ABOVE", 1)
    res = await _move(svc, gid, home, provider="default", admitted=True)
    assert (res["beside"], res["building"]["step"]) == (True, "seeding")
    assert home not in [e["name"] for e in (await _ps(gid)).retired_keys]
    for _ in range(3):
        await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state is None and ps.falkor_graph_name == home, ps.candidate_state
    assert serving.cursor is None
    await _assert_matches_main(svc, fake, gid)


def test_a_move_back_onto_a_key_with_a_stale_cursor_seeds_it_whole(builds_on, monkeypatch):
    asyncio.run(_run_a_move_back_onto_a_key_with_a_stale_cursor_seeds_it_whole(builds_on,
                                                                               monkeypatch))


async def _run_a_moves_seed_counts_on_its_own_providers_master(monkeypatch) -> None:
    """Residency's snapshot: a move seeding its key on another provider counts on that provider's
    master (its slots, not the serving provider's), in a snapshot of that provider as a build
    alone, and in none of the serving provider's."""
    from backend.app.services.versioning.residency_plan import Master

    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    target = _target(fake, gid)
    await _move(svc, gid, target, admitted=True)

    async def client_of(provider, key):
        return provider, None

    async def masters_of(provider, client, mode):
        endpoint = {"default": "a1:6379", "prov_b": "b1:6379"}[provider]
        return [Master(endpoint=endpoint, used=1, maxmemory=10 ** 9,
                       providers=(provider,))], {endpoint: None}

    monkeypatch.setattr(residency, "_provider_client", client_of)
    monkeypatch.setattr(residency, "_read_masters", masters_of)
    every = await residency.gather(graph_ids=[gid])
    mine = [(g.endpoint, g.provider, g.build) for g in every.graphs if g.graph_id == gid]
    assert mine == [("a1:6379", "default", False), ("b1:6379", "prov_b", True)], mine
    there = await residency.gather(providers=["prov_b"])
    assert [(g.endpoint, g.build) for g in there.graphs if g.graph_id == gid] == [
        ("b1:6379", True)]
    assert {m.endpoint for m in there.masters} == {"b1:6379"} and gid not in there.rows
    here = await residency.gather(providers=["default"])
    assert [(g.endpoint, g.build) for g in here.graphs if g.graph_id == gid] == [
        ("a1:6379", False)]
    assert "b1:6379" not in {m.endpoint for m in here.masters}


def test_a_moves_seed_counts_on_its_own_providers_master(builds_on, monkeypatch):
    asyncio.run(_run_a_moves_seed_counts_on_its_own_providers_master(monkeypatch))


# ── what an independent review of rebuilds and moves built beside found ───────────────────────


def _upgrade_during(monkeypatch, svc, gid: str, owner, attr: str) -> list:
    """Have ``owner.attr`` ask for an operator's rebuild right after its first call, as an operator
    would while a pass of the graph's move is in flight (``upgrade``). Returns what the ask
    answered."""
    real = getattr(owner, attr)
    upgraded: list = []

    async def then_upgrade(*a, **k):
        out = await real(*a, **k)
        if not upgraded:
            upgraded.append(await svc.request_projection_rebuild(gid))
        return out

    monkeypatch.setattr(owner, attr, then_upgrade)
    return upgraded


async def _trash(gids) -> None:
    """``gids`` to the trash, their builds dropped: no later poll takes them."""
    from sqlalchemy import update

    from backend.app.services.versioning import models
    from backend.app.services.versioning.models import GraphORM

    async with db.graphver_session() as s, s.begin():
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id.in_(gids))
                        .values(candidate_state=None, candidate_graph_name=None,
                                candidate_provider=None, candidate_seq=None))
        await s.execute(update(GraphORM).where(GraphORM.id.in_(gids))
                        .values(deleted_at=models._now()))


async def _until_switched(proj, gid: str, passes: int = 4) -> ProjectionStateORM:
    for _ in range(passes):
        if (await _ps(gid)).candidate_state is None:
            break
        await proj.project_graph(gid)
    return await _ps(gid)


async def _run_a_rebuild_asked_while_a_moves_pass_runs_is_kept(monkeypatch, where: str) -> None:
    """A rebuild asked while a pass of a move's build is in flight, in its seed's summaries, its
    catch-up or its switch: the move rebuilds too, and the pass, holding the build's state from
    before the ask, never takes that back. The switch owes the summaries to the batch job, once."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    _summaries_on(serving)
    hand_off, asked = _hand_offs(svc)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    target = _target(fake, gid)
    assert (await _move(svc, gid, target))["beside"]
    if where == "seed":
        upgraded = _upgrade_during(monkeypatch, svc, gid, FalkorProjector, "_copy_summaries")
        await proj.project_graph(gid)                   # seeded, the rebuild asked meanwhile
    else:
        await proj.project_graph(gid)                   # seeded at 3: catching up
        if where == "catch_up":
            await _edit_publish(svc, gid, "a", _create("D"), "a change")
            upgraded = _upgrade_during(monkeypatch, svc, gid, FalkorProjector, "_apply")
        else:
            upgraded = _upgrade_during(monkeypatch, svc, gid, proj, "_falkor_counts")
        await proj.project_graph(gid)
    assert upgraded == [True]
    ps = await _until_switched(proj, gid)
    assert ps.candidate_state is None and ps.falkor_graph_name == target
    assert asked == [gid], "the rebuild's summaries go to the batch job"


@pytest.mark.parametrize("where", ["seed", "catch_up", "switch"])
def test_a_rebuild_asked_while_a_moves_pass_runs_is_kept(builds_on, monkeypatch, where):
    asyncio.run(_run_a_rebuild_asked_while_a_moves_pass_runs_is_kept(monkeypatch, where))


async def _run_a_move_back_to_its_key_keeps_the_rebuild_the_move_carries(state) -> None:
    """A move carrying a rebuild (one asked during it) is cancelled by a move back to the key the
    graph is on: the move goes, the rebuild does not. Built beside while beside applies, then
    switched to; made in place once it no longer does (``buildForRebuilds`` turned off)."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    hand_off, asked = _hand_offs(svc)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    pin = (await _ps(gid)).falkor_graph_name
    moved = await _move(svc, gid, _target(fake, gid))
    assert await svc.request_projection_rebuild(gid)    # the move rebuilds too
    back = await _move(svc, gid, pin, provider="default")
    ps = await _ps(gid)
    build = ps.candidate_state
    assert back["cancelled"] == moved["building"]["id"] and back["changed"] is False
    assert (build["reason"], build["rebuild"]["cause"]) == ("rebuild", "operator"), build
    assert back["beside"] and back["building"]["id"] == build["id"]
    assert ps.candidate_graph_name != moved["to"]["key"] and ps.falkor_graph_name == pin
    ps = await _until_switched(proj, gid)
    assert ps.candidate_state is None and ps.projected_commit_seq == 3
    assert asked == [gid]
    await _assert_matches_main(svc, fake, gid)

    pin = ps.falkor_graph_name
    await _move(svc, gid, _target(fake, gid, 2))
    assert await svc.request_projection_rebuild(gid)
    state["policy"] = _policy(buildForRebuilds=False)
    before = await _ps(gid)
    back = await _move(svc, gid, pin, provider="default")
    ps = await _ps(gid)
    assert back["cancelled"] and not back["beside"] and back["building"] is None
    assert _in_place(ps) == {**_rebuilt_in_place(before, 3), "build": (None, None, None, None)}


def test_a_move_back_to_its_key_keeps_the_rebuild_the_move_carries(builds_on):
    asyncio.run(_run_a_move_back_to_its_key_keeps_the_rebuild_the_move_carries(builds_on))


async def _run_a_move_back_keeps_the_rebuild_the_projector_started(state, monkeypatch) -> None:
    """A rebuild the projector started on its own, built beside, replaced by a move that carries
    it, then that move cancelled: the rebuild is built beside again, and its last error still
    says why."""
    state["policy"] = _policy(buildAboveRows=1000)       # the window itself is written in place
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=_hand_offs(svc)[0])
    pin = (await _ps(gid)).falkor_graph_name
    healthy = _drifting(monkeypatch)
    await _edit_publish(svc, gid, "a", _create("D"), "a change")
    await proj.project_graph(gid)                       # escalated: rebuilt beside
    healthy()
    moved = await _move(svc, gid, _target(fake, gid))
    assert (await _ps(gid)).candidate_state["rebuild"]["cause"] == "drift"
    back = await _move(svc, gid, pin, provider="default")
    ps = await _ps(gid)
    assert back["cancelled"] == moved["building"]["id"]
    assert (ps.candidate_state["reason"], ps.candidate_state["rebuild"]) == (
        "rebuild", {"cause": "drift", "why": "it holds less than history"})
    assert ps.last_error == "rebuilding beside on its own: it holds less than history"
    ps = await _until_switched(proj, gid)
    assert ps.candidate_state is None and (ps.projected_commit_seq, ps.last_error) == (4, None)
    await _assert_matches_main(svc, fake, gid)


def test_a_move_back_keeps_the_rebuild_the_projector_started(builds_on, monkeypatch):
    asyncio.run(_run_a_move_back_keeps_the_rebuild_the_projector_started(builds_on, monkeypatch))


async def _run_a_move_back_dropped_keeps_its_keys_grace() -> None:
    """Moved away and switched, then moved back beside onto the old key while it waits out its
    grace: cancelled, or replaced by a move elsewhere, the old key is retired as it was, its grace
    and its version intact, not dropped at once."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    home = (await _ps(gid)).falkor_graph_name
    away = _target(fake, gid)
    await _move(svc, gid, away)
    ps = await _until_switched(proj, gid)
    assert ps.falkor_graph_name == away
    original = [e for e in ps.retired_keys if e["name"] == home]
    assert len(original) == 1

    async def nobody(*_a):
        return []

    soon = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
    for undo in ("cancel", "replace"):
        back = await _move(svc, gid, home, provider="default")
        assert back["beside"]
        assert not [e for e in (await _ps(gid)).retired_keys or [] if e["name"] == home]
        if undo == "cancel":
            assert (await _move(svc, gid, away))["cancelled"] == back["building"]["id"]
        else:
            assert (await _move(svc, gid, _target(fake, gid, 2)))["beside"]
        ps = await _ps(gid)
        assert [e for e in ps.retired_keys if e["name"] == home] == original, undo
        gone = await keymigrate.retire_moved_keys(proj, key_in_use=nobody, now=soon)
        assert not [g for g in gone if g["graphId"] == gid and g["key"] == home], gone
        if undo == "cancel":
            assert (await _ps(gid)).candidate_state is None


def test_a_move_back_dropped_keeps_its_keys_grace(builds_on):
    asyncio.run(_run_a_move_back_dropped_keeps_its_keys_grace())


async def _run_a_rebuild_the_projector_starts_never_waits_for_room(state, monkeypatch) -> None:
    """With no room for its seed, a rebuild the projector started on its own is made in place at
    once, whatever ``noRoomPolicy`` says: waiting would keep the graph on a key it distrusts,
    projecting nothing, for as long as there is no room. An operator's rebuild waits, as
    ``noRoomPolicy`` wait says."""
    state["policy"] = _policy(buildAboveRows=1000)       # the window itself is written in place
    state["seed_room"] = Admitted(False, None, 10 ** 9, "capacity")
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=_hand_offs(svc)[0])
    healthy = _drifting(monkeypatch)
    await _edit_publish(svc, gid, "a", _create("D"), "a change")
    await proj.project_graph(gid)                       # escalated: a rebuild beside asked for
    healthy()
    assert (await _ps(gid)).candidate_state["rebuild"]["cause"] == "drift"
    await proj.project_graph(gid)                       # no room for its seed: made in place
    ps = await _ps(gid)
    assert ps.candidate_state is None and (ps.status, ps.projected_commit_seq) == ("rebuilding", 0)
    assert ps.last_error == "rebuilding on its own: it holds less than history"
    await proj.project_graph(gid)
    assert (await _ps(gid)).projected_commit_seq == 4
    await _assert_matches_main(svc, fake, gid)

    assert await svc.request_projection_rebuild(gid)
    await proj.project_graph(gid)
    ps = await _ps(gid)
    assert ps.candidate_state["step"] == "queued" and ps.candidate_state["waiting"]


def test_a_rebuild_the_projector_starts_never_waits_for_room(builds_on, monkeypatch):
    asyncio.run(_run_a_rebuild_the_projector_starts_never_waits_for_room(builds_on, monkeypatch))


async def _run_a_build_out_of_attempts_is_not_run_again_while_its_drop_waits(state,
                                                                            monkeypatch) -> None:
    """A build that used its last attempt is dropped; while the graph's lock keeps that drop
    waiting, the build is not run again: it waits out a backoff, then is dropped, its step not
    retried."""
    from backend.app.services.versioning.errors import LockBusy

    state["policy"] = _policy(buildMaxAttempts=1)
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, proj, _serving = await _seed(svc, fake)
    await _beside(svc, gid)
    await _edit_publish(svc, gid, "a", _create("D", "E"), "a change")
    copies: list = []

    async def broken(self, clone):
        copies.append(1)
        raise ConnectionError("the node went away mid-copy")

    real_drop = GraphVersioningService.drop_candidate
    busy = [True]

    async def drop(self, *a, **k):
        if busy:
            busy.pop()
            raise LockBusy()
        return await real_drop(self, *a, **k)

    monkeypatch.setattr(CopyGraph, "copy", broken)
    monkeypatch.setattr(GraphVersioningService, "drop_candidate", drop)
    await proj.project_graph(gid)                       # failed, out of attempts, drop waited
    ps = await _ps(gid)
    assert copies == [1] and ps.candidate_state["attempts"] == 1
    assert ps.candidate_state["retryAt"], "a backoff before the drop is tried again"
    await proj.project_graph(gid)                       # still backing off: nothing runs
    assert copies == [1] and (await _ps(gid)).candidate_state is not None
    async with db.graphver_session() as s:
        row = await s.get(ProjectionStateORM, gid)
        row.candidate_state = {**row.candidate_state, "retryAt": None}
    await proj.project_graph(gid)                       # dropped, the copy not tried again
    assert copies == [1] and (await _ps(gid)).candidate_state is None
    await proj.project_graph(gid)                       # and written in place
    assert (await _ps(gid)).projected_commit_seq == 4
    await _assert_matches_main(svc, fake, gid)


def test_a_build_out_of_attempts_is_not_run_again_while_its_drop_waits(builds_on, monkeypatch):
    asyncio.run(_run_a_build_out_of_attempts_is_not_run_again_while_its_drop_waits(
        builds_on, monkeypatch))


async def _run_the_poll_skips_builds_backing_off_and_never_fills_with_builds(monkeypatch) -> None:
    """The poll leaves out a build backing off (its ``retryAt``) and takes builds for at most half
    its graphs, so builds waiting for room or a slot never crowd out graphs that lag. A graph out
    of FalkorDB with a build is taken, so its build is dropped and its room given back."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    graphs = [await _seed(svc, fake) for _ in range(3)]
    (lagging, _p, _s), (waiting, _p2, _s2), (due, _p3, _s3) = graphs
    proj = graphs[0][1]
    try:
        for gid in (waiting, due):
            await _beside(svc, gid)
            assert await svc.request_projection_rebuild(gid)
        later = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        async with db.graphver_session() as s:
            row = await s.get(ProjectionStateORM, waiting)
            row.candidate_state = {**row.candidate_state, "retryAt": later}
        await _edit_publish(svc, lagging, "a", _create("D"), "a change")
        taken: list = []

        async def recorded(gid, **_k):
            taken.append(gid)
            return {"graph_id": gid}

        async def builds_among(ids) -> list:
            async with db.graphver_session() as s:
                rows = [await s.get(ProjectionStateORM, g) for g in ids]
            return [r.graph_id for r in rows if r.candidate_state is not None]

        # Other tests' graphs share this database: the poll is asked for plenty, and judged on
        # ours.
        monkeypatch.setattr(proj, "project_graph", recorded)
        await proj.project_pending(limit=1000)
        assert waiting not in taken and {lagging, due} <= set(taken), taken
        taken.clear()
        await proj.project_pending(limit=2)
        assert len(taken) == 2 and len(await builds_among(taken)) == 1, taken

        async with db.graphver_session() as s:
            row = await s.get(ProjectionStateORM, due)
            row.status = "evicted"
        taken.clear()
        await proj.project_pending(limit=1000)
        assert due in taken, taken
    finally:
        # Never projected, so they would lag and build for every later poll in this database's
        # run: trashed with their builds, as the residency suite trashes its own.
        await _trash([gid for gid, _p, _s in graphs])


def test_the_poll_skips_builds_backing_off_and_never_fills_with_builds(builds_on, monkeypatch):
    asyncio.run(_run_the_poll_skips_builds_backing_off_and_never_fills_with_builds(monkeypatch))


async def _run_an_escalation_of_a_graph_that_reads_latest_takes_no_graph_lock(monkeypatch) -> None:
    """Asking whether a rebuild the projector starts on its own is built beside reads the policy
    before taking the graph's lock: a graph that does not read ``beside`` answers no at once, so
    its rebuild in place never waits on that lock."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, _serving = await _seed(svc, fake)
    locked: list = []

    async def no_lock(self, s, graph_id, *a, **k):
        locked.append(graph_id)
        raise AssertionError("the graph's lock is not needed to say no")

    monkeypatch.setattr(GraphVersioningService, "_lock_graph", no_lock)
    epoch = (await _ps(gid)).epoch
    assert not await svc.record_rebuild(gid, epoch=epoch, policy=build_policy.current(),
                                        switch_on=True, cause="drift", why="drift")
    assert locked == []


def test_an_escalation_of_a_graph_that_reads_latest_takes_no_graph_lock(builds_on, monkeypatch):
    asyncio.run(_run_an_escalation_of_a_graph_that_reads_latest_takes_no_graph_lock(monkeypatch))


async def _run_a_move_whose_serving_key_is_gone_owes_its_summaries(monkeypatch) -> None:
    """A move whose serving key is gone when its summaries are to be carried over (its node
    restarted mid-seed): nothing is carried, the key the graph's readers are pinned to is not made
    again (empty), and the switch hands the summaries to the batch job."""
    svc, fake = GraphVersioningService(), BuildFalkor()
    gid, _proj, serving = await _seed(svc, fake)
    await _beside(svc, gid)
    _summaries_on(serving)
    hand_off, asked = _hand_offs(svc)
    proj = FalkorProjector(graph_client_factory=fake, on_rollups_stale=hand_off)
    target = _target(fake, gid)
    assert (await _move(svc, gid, target))["beside"]
    real_clear = FalkorProjector._clear_summaries

    async def clear_then_lose_the_serving_key(self, client):
        await real_clear(self, client)
        serving.exists = False                          # its node restarted without it

    monkeypatch.setattr(FalkorProjector, "_clear_summaries", clear_then_lose_the_serving_key)
    await proj.project_graph(gid)                       # seeded, nothing to carry over
    ps = await _ps(gid)
    assert ps.candidate_state["step"] == "catching_up" and ps.candidate_state["rollupsStale"]
    assert serving.exists is False, "the pinned key must not be made again, empty"
    assert not fake.graphs[target].summaries
    ps = await _until_switched(proj, gid)
    assert ps.candidate_state is None and ps.falkor_graph_name == target
    assert asked == [gid]


def test_a_move_whose_serving_key_is_gone_owes_its_summaries(builds_on, monkeypatch):
    asyncio.run(_run_a_move_whose_serving_key_is_gone_owes_its_summaries(monkeypatch))
