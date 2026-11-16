"""Where each signal is counted (``services/settings/signals.py``): the code path that decides it,
driven on its own with what it reads stood in for, counts its id, for the graph it names, once per
event (a waiting build or load once each time it asks for room and is told to wait), and the paths
beside it count nothing. Every id is counted somewhere, by its literal id, and nowhere is an id
counted that isn't one.

What the counts become in Redis: ``test_settings_signals.py``.
"""
from __future__ import annotations

import ast
import contextlib
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from redis.exceptions import TimeoutError as RedisTimeoutError

from backend.app.providers.manager import ProviderBusy, ProviderManager
from backend.app.services import context_engine as ce
from backend.app.services.settings import signals
from backend.app.services.versioning import (build_policy, cache_manager, projection, purge_worker,
                                             residency, route_cache)
from backend.app.services.versioning import db as gvdb
from backend.app.services.versioning import service as gvs
from backend.app.services.versioning.errors import LockBusy
from backend.app.services.versioning.import_export import import_worker as iw
from backend.app.services.versioning.import_export.import_worker import (
    IdentifierMatchedNothing, ImportWorker, ReplaceBlocked)
from backend.app.services.versioning.residency_plan import (Eviction, Master, MasterPlan, Plan,
                                                            Wait)

_APP = Path(__file__).resolve().parents[1] / "app"


@pytest.fixture(autouse=True)
def _fresh():
    signals.reset()
    yield
    signals.reset()


def counted(signal_id: str) -> dict:
    """What ``signal_id`` has counted in this process so far, by the graph it named."""
    out: dict = {}
    for (sid, graph_id, _hour), n in signals._pending.items():
        if sid == signal_id:
            out[graph_id] = out.get(graph_id, 0) + n
    return out


async def _async(value=None):
    return value


def _returns(value=None):
    async def stand_in(*_args, **_kw):
        return value
    return stand_in


@contextlib.asynccontextmanager
async def _session_of(results):
    """A session whose statements answer ``results`` in turn."""
    async def execute(*_args, **_kw):
        return results.pop(0)
    yield SimpleNamespace(execute=execute)


def _result(first=None, rows=(), rowcount=0):
    return SimpleNamespace(first=lambda: first, all=lambda: list(rows), rowcount=rowcount)


# ── Builds (FalkorProjector) ──────────────────────────────────────────────────────────────────────
_POLICY = {"buildMode": "copy", "copyMarginPct": 30, "copyMaxBytes": 0, "noRoomPolicy": "wait",
           "noRoomAlertSecs": 3600}


def _projector(client=None):
    return projection.FalkorProjector(graph_client_factory=lambda *_a, **_kw: client)


async def test_a_build_counts_each_time_it_asks_for_room_and_is_told_to_wait(monkeypatch):
    proj = _projector()
    room = {"fits": False}

    async def admit(graph_id, provider, name, build_id, *, margin_pct, max_bytes):
        return SimpleNamespace(fits=room["fits"], why="capacity"), None

    monkeypatch.setattr(build_policy, "switch_state", _returns(True))
    monkeypatch.setattr(projection, "read_projection_marker", _returns((False, None)))
    monkeypatch.setattr(residency, "admit_build_copy", admit)
    monkeypatch.setattr(cache_manager, "_rollups_running", _returns(True))
    monkeypatch.setattr(proj._svc, "update_candidate", _returns(True))
    ps = SimpleNamespace(candidate_graph_name="gvp_g1{a.1}", candidate_provider=None,
                         falkor_provider=None)
    state = {"id": "build_1", "reason": "window", "step": "queued",
             "since": datetime.now(timezone.utc).isoformat()}
    graph = SimpleNamespace(data_source_id="ds_1")
    for _pass in range(2):
        got = await proj._build_queued("g1", ps, graph, state, _POLICY, {"noop": True})
        assert got["skipped"] == "build_waiting"
    assert counted("builds.waited_for_room") == {"g1": 2}
    # Room, but a lineage-summaries job is writing the serving key: it waits, not for room.
    room["fits"] = True
    await proj._build_queued("g1", ps, graph, state, _POLICY, {"noop": True})
    # No room and the policy writes it in place: dropped, never waiting.
    room["fits"] = False
    with pytest.raises(projection._BuildRefused):
        await proj._build_queued("g1", ps, graph, state, {**_POLICY, "noRoomPolicy": "in_place"},
                                 {"noop": True})
    assert counted("builds.waited_for_room") == {"g1": 2}


async def test_a_copy_that_outlives_its_socket_counts_and_fails_the_attempt(monkeypatch):
    raised = {"error": RedisTimeoutError("Timeout reading from socket")}

    class Source:
        async def copy(self, name):
            raise raised["error"]

    proj = _projector(Source())
    monkeypatch.setattr(proj, "_serving_whole", _returns(5))
    monkeypatch.setattr(projection, "read_projection_marker", _returns((False, None)))
    ps = SimpleNamespace(candidate_graph_name="gvp_g1{a.1}", falkor_provider=None,
                         falkor_graph_name="gvp_g1{a}")
    with pytest.raises(RedisTimeoutError):
        await proj._build_copy("g1", ps, None, {"id": "build_1"}, _POLICY, {})
    raised["error"] = TimeoutError()
    with pytest.raises(TimeoutError):
        await proj._build_copy("g1", ps, None, {"id": "build_1"}, _POLICY, {})
    assert counted("builds.copy_timed_out") == {"g1": 2}
    raised["error"] = RuntimeError("OOM command not allowed")      # failed, not timed out
    with pytest.raises(RuntimeError):
        await proj._build_copy("g1", ps, None, {"id": "build_1"}, _POLICY, {})
    assert counted("builds.copy_timed_out") == {"g1": 2}


async def test_a_build_dropped_after_its_attempts_counts_once_when_it_is_dropped(monkeypatch):
    proj = _projector()
    took = {"value": "window"}

    async def drop(graph_id, *, build_id, grace_secs):
        if took["value"] is LockBusy:
            raise LockBusy("the graph is busy")
        return took["value"]

    monkeypatch.setattr(build_policy, "resolve", _returns({"retireGraceSecs": 0}))
    monkeypatch.setattr(proj._svc, "drop_candidate", drop)
    monkeypatch.setattr(projection, "nudge_projection", _returns())
    # Its lock busy: the drop is left to a later pass, which counts it then.
    took["value"] = LockBusy
    await proj._drop_build("g1", "build_1", "gave up after 3 attempt(s): the copy timed out")
    assert counted("builds.dropped") == {}
    took["value"] = "window"
    await proj._drop_build("g1", "build_1", "gave up after 3 attempt(s): the copy timed out")
    await proj._drop_build("g1", "build_2", "the graph now reads in_place")     # not its attempts
    took["value"] = None                                   # no longer the graph's build
    await proj._drop_build("g1", "build_3", "gave up after 3 attempt(s): boom")
    assert counted("builds.dropped") == {"g1": 1}


# ── Reads ─────────────────────────────────────────────────────────────────────────────────────────
async def test_a_read_shed_from_a_full_database_slot_counts_for_its_graph(monkeypatch):
    manager = ProviderManager()
    full = {"slot": "*"}
    released = []

    async def acquire(provider_id, graph_name="", *, size=None):
        if graph_name == full["slot"]:
            raise ProviderBusy(provider_name=provider_id, reason="full", retry_after_seconds=1)
        return SimpleNamespace(release=lambda: released.append(graph_name))

    monkeypatch.setattr(manager, "acquire_provider_slot", acquire)
    for scope in ("*", "g1"):                    # the process's places, then the graph's
        full["slot"] = scope
        with pytest.raises(ProviderBusy):
            async with manager.pg_read_slot("g1", per_process=1, per_graph=1):
                pass
    assert counted("reads.asked_to_retry") == {"g1": 2}
    assert released == ["*"]
    full["slot"] = None
    async with manager.pg_read_slot("g1", per_process=1, per_graph=1):
        pass
    assert counted("reads.asked_to_retry") == {"g1": 2}


def _snap(**kw) -> route_cache.RouteSnapshot:
    fields = dict(graph_id="g1", data_source_id="ds_1", workspace_id="ws_1",
                  fork_parent_graph_id=None, root_id=None, deleted=False, main_branch_id="br_main",
                  committed=9, projected=5, served_commit_seq=5, status="idle",
                  read_mode="latest", falkor_graph_name="g_ds_1", falkor_provider=None,
                  platform_copy=True, window_rows=None, last_error=None, residency="standard",
                  size_bytes=None)
    return route_cache.RouteSnapshot(**{**fields, **kw})


class _Registry:
    async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
        return SimpleNamespace(manager_cache_key=None)


@pytest.mark.parametrize("route, behind", [
    # Its key holds version 5, four behind the head: past what its read mode lets it serve.
    ({"projected": 5, "status": "idle"}, True),
    ({"projected": 5, "status": "projecting"}, True),
    # Out of FalkorDB, or never written: Postgres serves it, but not because a copy is behind.
    ({"projected": 5, "status": "evicted"}, False),
    ({"projected": 0, "served_commit_seq": None, "status": "idle"}, False),
    # The key serves it.
    ({"projected": 5, "status": "idle", "served": 5}, False),
])
async def test_a_main_read_postgres_serves_while_its_key_is_behind_counts(monkeypatch, route,
                                                                          behind):
    snap = _snap(**{k: v for k, v in route.items() if k != "served"})

    async def state(self):
        return {"served": route.get("served"), "fresh": False, "committed": self.committed,
                "projected": self.projected, "status": self.status,
                "falkor_graph_name": self.falkor_graph_name, "falkor_provider": None}

    monkeypatch.setattr(route_cache, "route_of_source", _returns(snap))
    monkeypatch.setattr(route_cache.RouteSnapshot, "state", state)
    monkeypatch.setattr(ce.ContextEngine, "_resolve_ontology", _returns())   # its own IO
    await ce.ContextEngine.for_workspace("ws_1", _Registry(), SimpleNamespace(),
                                         data_source_id="ds_1")
    assert counted("reads.from_database_while_behind") == ({"g1": 1} if behind else {})


async def test_a_route_state_that_says_less_counts_nothing_and_never_fails_the_read(monkeypatch):
    """A state with no status (as a stand-in gives it) can't say why Postgres serves the read:
    nothing is counted, and the read goes on as before."""
    async def state(self):
        return {"fresh": False, "committed": 2, "projected": 0, "served": None}

    monkeypatch.setattr(route_cache, "route_of_source", _returns(_snap()))
    monkeypatch.setattr(route_cache.RouteSnapshot, "state", state)
    monkeypatch.setattr(ce.ContextEngine, "_resolve_ontology", _returns())
    engine = await ce.ContextEngine.for_workspace("ws_1", _Registry(), SimpleNamespace(),
                                                  data_source_id="ds_1")
    assert engine._branch_id == "br_main"                  # main, read from Postgres
    assert counted("reads.from_database_while_behind") == {}


@pytest.mark.parametrize("root, behind", [
    ({"serving": None, "projected": 5, "status": "idle"}, True),        # past its read mode
    ({"serving": 5, "projected": 5, "status": "projecting"}, True),     # writing past it
    ({"serving": 9, "projected": 9, "status": "idle", "fresh": True}, False),
    ({"serving": None, "projected": 0, "status": "evicted"}, False),
])
async def test_a_fork_read_postgres_serves_while_its_roots_key_is_behind_counts_for_the_root(
        monkeypatch, root, behind):
    plan = {"reads_from": "overlay", "root_id": "g_root", "root_main": "br_root",
            "root_data_source_id": "ds_root", "root_trashed": False, "committed": 9,
            "fresh": False, "window_rows": None, "last_error": None, "falkor_provider": None,
            "falkor_graph_name": "g_ds_root", "version": ("c_1", (1,), 9, "open"), **root}
    monkeypatch.setattr(gvs.GraphVersioningService, "fork_read_plan", _returns(plan))
    monkeypatch.setattr(residency, "on_read", _returns(None))
    await ce.ContextEngine._fork_main_reader(_Registry(), SimpleNamespace(), "ws_1",
                                             gvs.GraphVersioningService(), "g_fork", "br_fork",
                                             None)
    assert counted("reads.from_database_while_behind") == ({"g_root": 1} if behind else {})


# ── Residency (CapacityLoop) ──────────────────────────────────────────────────────────────────────
async def test_a_copy_unloaded_under_pressure_counts_and_an_idle_one_does_not(monkeypatch):
    loop = residency.CapacityLoop(SimpleNamespace(drop_graph=None))
    evictor = SimpleNamespace(evict=_returns(True))
    monkeypatch.setattr(residency, "_emit_event", _returns())
    assert await loop._evict(evictor, Eviction("g1", "m1", 10, "pressure"), {})
    assert await loop._evict(evictor, Eviction("g2", "m1", 10, "idle_standard"), {})
    refused = SimpleNamespace(evict=_returns(False))       # another data source reads its key
    assert not await loop._evict(refused, Eviction("g3", "m1", 10, "pressure"), {})
    assert counted("residency.unloaded_under_pressure") == {"g1": 1}


async def test_a_load_counts_each_pass_it_asks_for_room_and_is_told_to_wait(monkeypatch):
    def session():
        return _session_of([_result(), _result()])

    monkeypatch.setattr(gvdb, "graphver_session", session)
    master = Master(endpoint="m1", used=90, maxmemory=100)
    decided = Plan(masters=[MasterPlan(master=master, reserved=0, used_after=None, waits=[
        Wait("g1", "m1", 50, "capacity", 40), Wait("g2", "m1", 5, "queued")])])
    snap = residency.Snapshot(masters=[master], rows={
        "g1": {"status": "waiting_capacity"}, "g2": {"status": "evicted"}})
    loop = residency.CapacityLoop(SimpleNamespace(drop_graph=None))
    for _pass in range(3):
        await loop._act(decided, snap)
    assert counted("residency.load_waited_for_room") == {"g1": 3}


# ── Imports (ImportWorker) ────────────────────────────────────────────────────────────────────────
def _worker(monkeypatch, *, summary, live=100):
    worker = ImportWorker(versioning=None, store=None)
    worker._limits = {"minLive": 10, "deleteFraction": 0.5, "createFraction": 0.5,
                      "minMatchFraction": 0.5, "sources": {}}
    worker._reconcile_mode, worker._guard, worker._identifier = "replace", True, "urn"
    worker._position = _returns(SimpleNamespace(summary=summary))
    monkeypatch.setattr(iw, "_live_count", _returns(live))
    return worker


async def test_a_replace_the_guard_refuses_counts_and_one_it_passes_does_not(monkeypatch):
    absent = {"rows": list(range(100))}

    async def pages(snap, kind, keep):
        if kind == "node":
            yield list(range(100))

    worker = _worker(monkeypatch, summary={"new": 100})
    worker._keyed = lambda: False
    worker._scope_pages = pages
    worker._unmatched = lambda job_id, page: _async(absent["rows"])
    worker._refused_unmatched = _returns(0)
    worker._lease = SimpleNamespace(checkpoint=_returns())
    monkeypatch.setattr(iw.db, "graphver_session", lambda: _session_of([]))
    snap = SimpleNamespace(graph_id="g1", main_at_base=lambda: "main")
    with pytest.raises(ReplaceBlocked):
        await worker._guard_replace("job_1", snap)
    absent["rows"] = []                                     # deletes nothing: it passes
    await worker._guard_replace("job_2", snap)
    assert counted("imports.replace_refused_by_guard") == {"g1": 1}


async def test_a_replace_stopped_for_too_few_matches_counts(monkeypatch):
    snap = SimpleNamespace(graph_id="g1", main_at_base=lambda: "main")
    worker = _worker(monkeypatch, summary={"updated": 1, "new": 9})
    with pytest.raises(IdentifierMatchedNothing):
        await worker._fail_fast("job_1", snap)
    await _worker(monkeypatch, summary={"updated": 6, "new": 4})._fail_fast("job_2", snap)
    await _worker(monkeypatch, summary={"updated": 1, "new": 9}, live=5)._fail_fast("job_3", snap)
    assert counted("imports.replace_stopped_low_match") == {"g1": 1}


# ── Drafts (GraphVersioningService) ───────────────────────────────────────────────────────────────
async def test_the_idle_drafts_a_sweep_closes_count_for_their_graphs():
    swept = [("br_1", "g1"), ("br_2", "g1"), ("br_3", "g2")]
    svc = gvs.GraphVersioningService(lambda: _session_of([_result(rows=swept)]))
    assert await svc.sweep_idle_drafts(ttl_days=30) == ["br_1", "br_2", "br_3"]
    svc = gvs.GraphVersioningService(lambda: _session_of([_result(rows=[])]))
    assert await svc.sweep_idle_drafts(ttl_days=30) == []
    assert counted("drafts.idle_closed") == {"g1": 2, "g2": 1}


@pytest.mark.parametrize("marked, removed", [(1, {"g1": 1}), (0, {})])
async def test_a_closed_draft_whose_changes_are_removed_counts_once(monkeypatch, marked, removed):
    """Its last rows gone, the draft is marked finished: by this pass (counted), or by another
    worker's at the same moment (0 rows marked here: counted there)."""
    results = ([_result(first=("br_1", "g1"))]                       # a removal under way
               + [_result()] * len(gvs._DRAFT_ROWS)                    # none of its rows left
               + [_result(rowcount=marked)]                            # marked finished
               + [_result(), _result()])                               # nothing more is due
    monkeypatch.setattr(purge_worker, "delete_window", _returns(0))
    svc = gvs.GraphVersioningService(lambda: _session_of(results))
    assert await svc.prune_closed_drafts(older_than_days=7, budget_secs=60) == ["br_1"]
    assert counted("drafts.changes_removed") == removed


# ── Every id, somewhere ───────────────────────────────────────────────────────────────────────────
def test_every_signal_is_counted_somewhere_by_its_literal_id_and_no_other_is():
    found: dict = {}
    for path in _APP.rglob("*.py"):
        text = path.read_text()
        if "signals.bump(" not in text:
            continue
        for node in ast.walk(ast.parse(text)):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "bump" and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "signals"):
                arg = node.args[0] if node.args else None
                where = f"{path.relative_to(_APP)}:{node.lineno}"
                assert isinstance(arg, ast.Constant) and isinstance(arg.value, str), where
                found.setdefault(arg.value, []).append(where)
    assert set(found) == set(signals.IDS), {
        "never counted": sorted(set(signals.IDS) - set(found)),
        "not a signal": sorted(set(found) - set(signals.IDS))}
