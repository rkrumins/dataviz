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

    async def seed_room(graph_id, provider, taken, record):
        """A seed placed on the node with most room: a key of the graph's own beside the serving
        one (``#b9``, which this test's store answers for), recorded while admitted."""
        if not state["seed_room"].fits:
            return state["seed_room"], None
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
