"""A new version built beside the serving key (read mode ``beside``), without a database server:
what a build is and when one is wanted (``candidates``), the key it is built in
(``keymigrate.build_key``: the serving key's hash tag, so ``GRAPH.COPY`` can copy into its cluster
slot), its columns declared and migrated, and a pass that finds a build taking its next step
instead of claiming the serving row. The build end to end is
``tests/integration/test_projection_builds_e2e.py``.
"""
from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.services.graph_store.topology import key_slot
from backend.app.services.versioning import candidates, keymigrate, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import _CURSOR_CLEAR
from backend.tests.test_projection_fencing_unit import _PS, _projector

_REVISION = (Path(__file__).resolve().parents[1] / "alembic" / "versions"
             / "20261113_1400_gv_ps_candidate.py")


def test_a_window_is_built_beside_only_for_a_beside_graph_with_builds_on_over_the_threshold():
    base = dict(read_mode="beside", switch_on=True, owned=True, rows=10, above=5)
    assert candidates.wanted(**base)
    for change in ({"read_mode": "in_place"}, {"read_mode": "latest"}, {"switch_on": False},
                   {"switch_on": None}, {"owned": False}, {"rows": 5}):
        assert not candidates.wanted(**{**base, **change}), change


def test_a_build_is_asked_for_queued_and_reads_as_its_block():
    state = candidates.new_state("window", now="2026-11-13T12:00:00+00:00", rows=250_001)
    assert state["id"].startswith("build_") and state["step"] == "queued"
    assert (state["attempts"], state["mode"], state["rows"]) == (0, "copy", 250_001)
    ps = SimpleNamespace(candidate_state=state, candidate_seq=None)
    assert candidates.block(ps) == {
        "id": state["id"], "step": "queued", "reason": "window", "mode": "copy", "seq": None,
        "attempts": 0, "error": None, "waiting": None,
        "since": "2026-11-13T12:00:00+00:00", "rows": 250_001, "progress": None,
        "target": None, "rebuild": None}
    assert candidates.block(SimpleNamespace(candidate_state=None)) is None


def test_a_window_build_is_asked_for_exactly_as_before():
    """A window's build keeps its shape: copied by default, no rebuild, no target."""
    state = candidates.new_state("window", now="t0", rows=7)
    assert {k: v for k, v in state.items() if k != "id"} == {
        "reason": "window", "mode": "copy", "step": "queued", "attempts": 0, "error": None,
        "retryAt": None, "since": "t0", "waiting": None, "rows": 7}


def test_a_rebuild_or_a_move_is_seeded_from_postgres_and_says_what_it_makes():
    rebuild = candidates.new_state("rebuild", now="t0",
                                   rebuild={"cause": "drift", "why": "it holds less"})
    assert (rebuild["mode"], rebuild["step"], rebuild["rollupsStale"]) == ("reseed", "queued", True)
    assert rebuild["rebuild"] == {"cause": "drift", "why": "it holds less"}
    assert "target" not in rebuild and "seedSeq" not in rebuild
    target = {"providerId": "prov_b", "key": "gvp_g{ab.2}", "shardMap": {"slot": 7},
              "movedBy": "usr_1"}
    move = candidates.new_state("move", now="t0", target=target)
    assert (move["mode"], move["step"], move["target"]) == (
        "reseed", "queued", {**target, "retired": None})
    assert "rebuild" not in move and "rollupsStale" not in move
    # A move back onto a key waiting out its grace keeps that key's entry, to give it back.
    was = [{"name": "gvp_g{ab.2}", "provider": "prov_b", "retireAfter": "t9", "afterSeq": 3}]
    back = candidates.new_state("move", now="t0", target={**target, "retired": was})
    assert back["target"]["retired"] == was
    # A move whose seed the route admitted with it: its version and cursor are taken on its first
    # pass; one asked during a rebuild carries the rebuild on.
    admitted = candidates.new_state("move", now="t0", target=target, step="seeding",
                                    rebuild={"cause": "operator"})
    assert (admitted["step"], admitted["seedSeq"], admitted["seedPhase"],
            admitted["summariesAt"]) == ("seeding", None, None, 0)
    assert admitted["rebuild"] == {"cause": "operator", "why": None} and admitted["rollupsStale"]
    seen = candidates.block(SimpleNamespace(candidate_state=admitted, candidate_seq=None))
    assert {**seen, "id": None} == {
        "id": None, "step": "seeding", "reason": "move", "mode": "reseed", "seq": None,
        "attempts": 0, "error": None, "waiting": None, "since": "t0", "rows": None,
        "progress": None, "target": {"providerId": "prov_b", "key": "gvp_g{ab.2}"},
        "rebuild": "operator"}
    with pytest.raises(ValueError):
        candidates.new_state("load", now="t0")
    with pytest.raises(ValueError):
        candidates.new_state("rebuild", now="t0", rebuild={"cause": "bored"})


def test_a_rebuild_or_a_move_is_built_beside_only_for_a_beside_graph_with_builds_and_rebuilds_on():
    base = dict(read_mode="beside", switch_on=True, for_rebuilds=True)
    assert candidates.beside_wanted(**base)
    for change in ({"read_mode": "in_place"}, {"read_mode": "latest"}, {"switch_on": False},
                   {"switch_on": None}, {"for_rebuilds": False}, {"for_rebuilds": None}):
        assert not candidates.beside_wanted(**{**base, **change}), change


def test_what_a_rebuild_or_a_move_does_to_the_build_in_flight():
    pin, b, c = ({"providerId": "a", "key": "k"}, {"providerId": "b", "key": "k2"},
                 {"providerId": "c", "key": "k3"})
    window = {"reason": "window"}
    rebuild = {"reason": "rebuild", "rebuild": {"cause": "operator"}}
    move = {"reason": "move", "target": {**b, "shardMap": None, "movedBy": "u"}}
    moving_rebuild = {**move, "rebuild": {"cause": "operator"}}
    table = [
        (None, "rebuild", None, "none"), (None, "move", b, "none"),
        (window, "rebuild", None, "replace"), (window, "move", b, "replace"),
        (window, "move", pin, "keep"),
        (rebuild, "rebuild", None, "keep"), (rebuild, "move", b, "replace"),
        (rebuild, "move", pin, "keep"),
        (move, "rebuild", None, "upgrade"), (moving_rebuild, "rebuild", None, "keep"),
        (move, "move", b, "keep"), (move, "move", c, "replace"), (move, "move", pin, "cancel"),
    ]
    for build, reason, target, expect in table:
        got = candidates.on_request(build, reason=reason, target=target, pin=pin)
        assert got == expect, (build, reason, target, got)


def test_a_build_key_keeps_the_serving_keys_slot_and_never_grows():
    serving = keymigrate.owned_key("graph_01HZZZZZZZZZZZZZZZZZZZZZZZ", 3)
    first = keymigrate.build_key(serving, {serving})
    assert first == f"{serving}#b1" and key_slot(first) == key_slot(serving)
    assert keymigrate.build_key(serving, {serving, first}) == f"{serving}#b2"
    # Built beside a build's key (once switched to it): the suffix is replaced, not added.
    assert keymigrate.build_key(first, {first}) == f"{serving}#b2"
    assert keymigrate.build_key(first, {first, serving}) == f"{serving}#b2"


def test_a_build_key_is_one_of_the_graphs_own_keys():
    gid = "graph_01HZZZZZZZZZZZZZZZZZZZZZZZ"
    serving = keymigrate.owned_key(gid, 1)
    assert keymigrate.is_owned_key(gid, serving)
    assert keymigrate.is_owned_key(gid, f"{serving}#b12")
    assert not keymigrate.is_owned_key(gid, f"{serving}#x1")
    assert not keymigrate.is_owned_key(gid, f"{serving}#b")
    assert not keymigrate.is_owned_key("graph_other", f"{serving}#b1")


def test_the_build_columns_are_declared_and_migrated():
    columns = ProjectionStateORM.__table__.c
    for name in ("candidate_graph_name", "candidate_provider", "candidate_seq",
                 "candidate_state"):
        assert columns[name].nullable and columns[name].server_default is None, name
    spec = importlib.util.spec_from_file_location(_REVISION.stem, _REVISION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == _REVISION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261113_1300_gv_ps_read_mode"
    assert module.ensure_ps_candidate_columns is models.ensure_ps_candidate_columns


def test_a_pass_that_finds_a_build_takes_its_step_and_never_claims_the_serving_row(monkeypatch):
    ps = _PS(projected=3, target=5)
    ps.candidate_state = {"id": "build_1", "step": "catching_up"}
    proj, _ps, client, seen = _projector(monkeypatch, ps=ps)
    stepped = []

    async def advance(graph_id):
        stepped.append(graph_id)
        return {"projected": 3, "applied": 0, "noop": False, "build": "catching_up"}

    monkeypatch.setattr(proj, "_advance_candidate", advance)
    out = asyncio.run(proj.project_graph("g1"))
    assert stepped == ["g1"] and out["build"] == "catching_up"
    assert seen["claim"] == [] and seen["finish"] == [] and not client.touched


def test_a_pass_with_no_build_and_a_small_window_never_asks_for_one(monkeypatch):
    ps = _PS(projected=3, target=5)
    proj, _ps, _client, seen = _projector(monkeypatch, ps=ps)
    asked = []

    async def queue(*a):
        asked.append(a)
        return False

    monkeypatch.setattr(proj, "_queue_build", queue)
    asyncio.run(proj.project_graph("g1"))
    assert len(asked) == 1 and seen["claim"] == [("g1", 4, 3)]     # asked, then in place


def test_a_copys_room_is_checked_and_reserved_in_one_step_under_the_capacity_lock(monkeypatch):
    """Two builds never take the room one copy needs: the check and the reservation, in the
    governor's ledger every admission counts, happen under the capacity lock; refused, nothing
    is reserved."""
    from contextlib import asynccontextmanager

    from backend.app.services.aggregation import admission, redis_client
    from backend.app.services.versioning import residency
    from backend.app.services.versioning.residency import Admitted

    events = []
    answers = [(Admitted(True, "node1"), 1300), (Admitted(False, "node1", 5, "capacity"), 1300)]

    @asynccontextmanager
    async def admitting(wait_s=15.0):
        events.append("lock")
        yield
        events.append("unlock")

    async def copy_room(graph_id, provider, key, *, margin_pct, max_bytes):
        events.append(("check", key, margin_pct, max_bytes))
        return answers.pop(0)

    class _Admission:
        def __init__(self, redis):
            pass

        async def reserve(self, endpoint, holder, nbytes):
            events.append(("reserve", endpoint, holder, nbytes))
            return ("held", holder)

    monkeypatch.setattr(residency, "admitting", admitting)
    monkeypatch.setattr(residency, "_copy_room", copy_room)
    monkeypatch.setattr(admission, "AggregationAdmission", _Admission)
    monkeypatch.setattr(redis_client, "get_redis", lambda: None)

    def admit():
        return asyncio.run(residency.admit_build_copy("g1", None, "k#b1", "build_1",
                                                      margin_pct=130, max_bytes=0))

    assert admit() == (Admitted(True, "node1"), ("held", "build_1"))
    assert events == ["lock", ("check", "k#b1", 130, 0), ("reserve", "node1", "build_1", 1300),
                      "unlock"]
    events.clear()
    assert admit() == (Admitted(False, "node1", 5, "capacity"), None)
    assert events == ["lock", ("check", "k#b1", 130, 0), "unlock"]


def test_a_seed_is_placed_admitted_and_recorded_in_one_step_under_the_capacity_lock(monkeypatch):
    """A build seeded from Postgres takes a key on the master with most room, its full write
    admitted there as a load's is, and records it before the lock is let go, so the next admission
    counts it; refused, or with no master free, nothing is recorded."""
    from contextlib import asynccontextmanager

    from backend.app.services.versioning import residency
    from backend.app.services.versioning.residency import Admitted

    events = []
    placed = [("gvp_g1{ab.2}", "node2"), ("gvp_g1{ab.3}", "node2"), None]
    answers = [Admitted(True, "node2"), Admitted(False, "node2", 9, "capacity")]

    @asynccontextmanager
    async def admitting(wait_s=15.0):
        events.append("lock")
        yield
        events.append("unlock")

    async def place_key(graph_id, provider, taken):
        events.append(("place", provider, sorted(taken)))
        return placed.pop(0)

    async def admission_on(graph_id, provider, key):
        events.append(("admit", key))
        return answers.pop(0)

    async def record(key, master):
        events.append(("record", key, master))
        return True

    monkeypatch.setattr(residency, "admitting", admitting)
    monkeypatch.setattr(residency, "place_key", place_key)
    monkeypatch.setattr(residency, "admission_on", admission_on)

    def seed():
        return asyncio.run(residency.admit_build_seed("g1", "p1", {"k"}, record))

    assert seed() == (Admitted(True, "node2"), "gvp_g1{ab.2}")
    assert events == ["lock", ("place", "p1", ["k"]), ("admit", "gvp_g1{ab.2}"),
                      ("record", "gvp_g1{ab.2}", "node2"), "unlock"]
    events.clear()
    assert seed() == (Admitted(False, "node2", 9, "capacity"), None)
    assert ("record", "gvp_g1{ab.3}", "node2") not in events and events[-1] == "unlock"
    events.clear()
    assert seed() == (Admitted(False, None, None, "queued"), None)
    assert [e for e in events if isinstance(e, tuple) and e[0] != "place"] == []


def test_a_moves_seed_is_admitted_on_its_own_key_under_the_capacity_lock(monkeypatch):
    """A move's build has its key, on the provider it moves to: no key is placed, its full write is
    admitted on the master that key hashes to and recorded there before the lock is let go."""
    from contextlib import asynccontextmanager

    from backend.app.services.versioning import residency
    from backend.app.services.versioning.residency import Admitted

    events = []

    @asynccontextmanager
    async def admitting(wait_s=15.0):
        events.append("lock")
        yield
        events.append("unlock")

    async def place_key(graph_id, provider, taken):
        raise AssertionError("a move's key is never placed")

    async def admission_on(graph_id, provider, key):
        events.append(("admit", provider, key))
        return Admitted(True, "node7")

    async def record(key, master):
        events.append(("record", key, master))
        return True

    monkeypatch.setattr(residency, "admitting", admitting)
    monkeypatch.setattr(residency, "place_key", place_key)
    monkeypatch.setattr(residency, "admission_on", admission_on)
    assert asyncio.run(residency.admit_build_seed("g1", "prov_b", (), record,
                                                  key="gvp_g1{ab.2}")) == (
        Admitted(True, "node7"), "gvp_g1{ab.2}")
    assert events == ["lock", ("admit", "prov_b", "gvp_g1{ab.2}"),
                      ("record", "gvp_g1{ab.2}", "node7"), "unlock"]


def test_a_seeding_build_reserves_its_room_on_its_keys_master_and_is_no_graph_of_its_own():
    """While a build seeds, its full write counts on the master its key hashes to, as a load's
    does: that master takes no load meanwhile, never evicts the build, and the graphs gauges do not
    count it."""
    from datetime import datetime, timezone

    from backend.app.services.versioning import residency_policy
    from backend.app.services.versioning.residency import _build_seeding
    from backend.app.services.versioning.residency_plan import Graph, Master, plan

    seeding = SimpleNamespace(candidate_state={"step": "seeding"}, candidate_graph_name="k#b9")
    assert _build_seeding(seeding)
    for state, name in (({"step": "catching_up"}, "k#b9"), ({"step": "seeding"}, None),
                        (None, "k#b9")):
        assert not _build_seeding(SimpleNamespace(candidate_state=state,
                                                  candidate_graph_name=name))
    policy = residency_policy.defaults()
    masters = [Master(endpoint=e, used=1_000, maxmemory=1_000_000, providers=("default",))
               for e in ("node1", "node2")]
    build = Graph(graph_id="g1", endpoint="node2", residency="standard", status="building",
                  evictable=False, size_bytes=200_000, seeding=True, placed=False, build=True)
    serving = Graph(graph_id="g1", endpoint="node1", residency="standard", status="idle",
                    size_bytes=200_000)
    decided = plan(policy, masters, [serving, build], datetime.now(timezone.utc))
    by = {p.master.endpoint: p for p in decided.masters}
    assert by["node2"].seeding and by["node2"].reserved >= 200_000
    assert not by["node1"].seeding and not by["node2"].evictions


def test_a_rebuild_or_a_move_is_built_beside_only_a_key_that_serves(settings_world):
    """The row's half (``service._beside_ok``): a live graph that is no fork, on a key the platform
    owns and pinned, idle, serving a version it published past genesis within the graph's
    ``reads.maxVersionsBehind``. A move also needs the version whole, no window part-written."""
    from backend.app.services.versioning import build_policy
    from backend.app.services.versioning.service import _beside_ok

    graph = SimpleNamespace(deleted_at=None, fork_parent_graph_id=None, main_head_commit_seq=5,
                            workspace_id="ws1", data_source_id="ds1")

    def ps(**over):
        return SimpleNamespace(**{"graph_id": "g1", "owns_falkor_graph": True,
                                  "falkor_graph_name": "gvp_g1{ab.1}", "status": "idle",
                                  "projected_commit_seq": 4, "served_commit_seq": 4,
                                  "window_rows": None, "read_mode": None, **over})

    for reason in ("rebuild", "move"):
        assert _beside_ok(ps(), graph, reason=reason), reason
    refused = [({}, {"deleted_at": "t"}), ({}, {"fork_parent_graph_id": "g0"}),
               ({"owns_falkor_graph": False}, {}), ({"falkor_graph_name": None}, {}),
               ({"falkor_graph_name": "gv_g1"}, {}), ({"projected_commit_seq": 1}, {}),
               ({"projected_commit_seq": 0, "served_commit_seq": 4}, {})]
    refused += [({"status": s}, {}) for s in ("projecting", "rebuilding", "reseeding", "evicted",
                                               "waiting_capacity", "rehydrating")]
    for row, of_graph in refused:
        for reason in ("rebuild", "move"):
            assert not _beside_ok(ps(**row), SimpleNamespace(**{**vars(graph), **of_graph}),
                                  reason=reason), (row, of_graph, reason)
    # Only a move needs the key to hold its version whole, with no window in flight.
    for row in ({"served_commit_seq": 3}, {"served_commit_seq": None}, {"window_rows": 900}):
        assert _beside_ok(ps(**row), graph, reason="rebuild"), row
        assert not _beside_ok(ps(**row), graph, reason="move"), row
    # Further behind its head than its workspace's most versions behind, the key serves nothing.
    settings_world.set("reads.maxVersionsBehind", "workspace", "ws1", 0)
    asyncio.run(build_policy.resolve())
    assert not _beside_ok(ps(), graph, reason="rebuild")
    assert _beside_ok(ps(projected_commit_seq=5, served_commit_seq=5), graph, reason="rebuild")


def test_a_rebuild_built_beside_leaves_the_serving_key_alone_and_nudges_the_worker(monkeypatch):
    """The rebuild route: a rebuild built beside (or a move that rebuilds too) clears no cursor in
    the serving key and runs nothing in this process — the worker builds it, nudged — and says so
    (``beside``). One in place clears the cursor and runs the catch-up, as before."""
    from backend.app.api.v1.endpoints import versioning as ep

    for building, beside in (({"reason": "rebuild", "rebuild": "operator"}, True),
                             ({"reason": "move", "rebuild": "operator"}, True),
                             ({"reason": "move", "rebuild": None}, False), (None, False)):
        proj, _ps, client, _seen = _projector(monkeypatch)
        tasks = []

        async def repaired(graph_id):
            return None

        async def watermark(graph_id, building=building):
            return {"falkor_graph_name": "real_pinned_graph", "candidate": building}

        async def request(graph_id):
            return True

        async def model(session, wm):
            return ep.WatermarkModel.model_construct()

        svc = SimpleNamespace(projection_watermark=watermark, request_projection_rebuild=request)
        monkeypatch.setattr(ep, "_repair_projection_target", repaired)
        monkeypatch.setattr(ep, "_get_projector", lambda: proj)
        monkeypatch.setattr(ep, "_watermark_model", model)
        r = asyncio.run(ep.rebuild_projection(
            "ws1", "g1", background=SimpleNamespace(add_task=lambda fn, *a: tasks.append((fn, a))),
            _user=None, _meta={}, svc=svc, session=None))
        assert (r.started, r.beside) == (True, beside), building
        assert [c for c, _p in client.queries] == ([] if beside else [_CURSOR_CLEAR]), building
        assert tasks == [(ep.nudge_projection if beside else ep.rebuild_now, ("g1",))], building


def test_an_escalation_that_cannot_ask_for_a_build_is_rebuilt_in_place(monkeypatch):
    """The projector's own rebuild goes beside the key when it can be asked for there
    (``record_rebuild``), and is otherwise the fenced reset it always was — also when asking
    fails, which leaves nothing half done."""
    from contextlib import asynccontextmanager

    from backend.app.services.versioning import build_policy, projection
    from backend.app.services.versioning.projection import FalkorProjector

    statements, nudged = [], []

    class _Session:
        async def execute(self, stmt):
            statements.append(str(stmt))
            return SimpleNamespace(first=lambda: ("g1",))

    @asynccontextmanager
    async def session():
        yield _Session()

    async def resolve(session=None):
        return build_policy.defaults()

    async def switch(session=None):
        return True

    async def nudge(graph_id):
        nudged.append(graph_id)

    monkeypatch.setattr(build_policy, "resolve", resolve)
    monkeypatch.setattr(build_policy, "switch_state", switch)
    monkeypatch.setattr(projection, "nudge_projection", nudge)
    for asked, reset in ((True, False), (False, True), (ConnectionError("gone"), True)):
        proj = FalkorProjector(graph_client_factory=lambda *a: None, session_factory=session)
        seen = []

        async def record(graph_id, *, asked=asked, **kw):
            seen.append(kw)
            if isinstance(asked, Exception):
                raise asked
            return asked

        monkeypatch.setattr(proj._svc, "record_rebuild", record)
        statements.clear()
        nudged.clear()
        assert asyncio.run(proj._escalate("g1", 7, "it drifted", "drift", summaries_moved=True))
        (kw,) = seen
        assert (kw["epoch"], kw["cause"], kw["why"], kw["summaries_moved"]) == (
            7, "drift", "it drifted", True)
        assert bool(statements) is reset and nudged == ["g1"], asked
        if reset:
            assert "UPDATE graphver.projection_state" in statements[0]


def test_the_poll_takes_builds_that_are_due_for_at_most_half_its_graphs_then_graphs_that_lag(
        monkeypatch):
    """A rebuild or a move of a graph that is caught up is no lag: the poll selects a graph with a
    build whatever its watermark (a nudge is never the only thing that moves one) — out of
    FalkorDB too, so its build is dropped — once its build's backoff (``retryAt``) has passed,
    oldest first, for at most half of its limit. Then graphs that lag, without a build, stalest
    first, for the rest: builds waiting for room or a slot never crowd out graphs that lag."""
    from contextlib import asynccontextmanager

    from sqlalchemy.dialects import postgresql

    from backend.app.services.versioning.projection import FalkorProjector

    asked = []

    class _Rows:
        def __init__(self, ids):
            self.ids = ids

        def scalars(self):
            return self

        def all(self):
            return self.ids

    class _Session:
        async def execute(self, stmt):
            compiled = stmt.compile(dialect=postgresql.dialect())
            asked.append((str(compiled), compiled.params))
            return _Rows(["g_build"] if len(asked) == 1 else [])

    @asynccontextmanager
    async def session():
        yield _Session()

    async def no_lag():
        return None

    proj = FalkorProjector(graph_client_factory=lambda *a: None, session_factory=session)
    monkeypatch.setattr(proj, "_report_lag", no_lag)
    taken = []

    async def project_graph(gid, **_k):
        taken.append(gid)
        return {"graph_id": gid}

    monkeypatch.setattr(proj, "project_graph", project_graph)
    asyncio.run(proj.project_pending(limit=10))
    assert taken == ["g_build"]
    (builds, builds_params), (lagging, lagging_params) = asked
    where, order = builds.split("WHERE", 1)[1].split(" ORDER BY ")
    assert "projection_state.candidate_state IS NOT NULL" in where
    assert "->> " in where and "retryAt" in builds_params.values()
    assert "projection_state.status" not in where           # out of FalkorDB too
    assert order.startswith("graphver.projection_state.candidate_state ->> ")
    assert "since" in builds_params.values() and 5 in builds_params.values()
    where, order = lagging.split("WHERE", 1)[1].split(" ORDER BY ")
    assert "projection_state.candidate_state IS NULL" in where
    assert "projection_state.status NOT IN" in where
    assert order.startswith("greatest(") and 9 in lagging_params.values()
