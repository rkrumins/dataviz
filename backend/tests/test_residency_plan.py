"""The capacity planner (``residency_plan.plan``): what one pass of the capacity loop evicts, loads
and holds, decided from what it read — pure, so the loop and the policy preview decide alike.

Per master, pressure eviction starts at the start mark and stops at the stop mark; idle eviction
takes Standard unread past the Standard idle time and Coldline past the Coldline idle time. Never
Always, never a key the platform did not mint, never a graph with a read lease or a pass in
flight. A load starts only when the master has room for its estimate times the headroom under the
start mark, after what others hold; one at a time per master, none while it forks for
persistence, in the order the loads were asked for.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.db.models import PlatformSettingsORM
from backend.app.main import app
from backend.app.services.versioning import config, residency, residency_policy
from backend.app.services.versioning.residency_plan import Graph, Master, admit, plan
from backend.app.services.versioning.worker import ProjectionWorker

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
MB = 1024 ** 2
POLICY = residency_policy.defaults()          # Standard 7 d, Coldline 1 h, 80 / 70, x1.3, 550 B


def _ago(**delta) -> datetime:
    return NOW - timedelta(**delta)


def _graph(gid, residency="standard", *, read=None, size=10 * MB, endpoint="m1", **kw) -> Graph:
    return Graph(graph_id=gid, endpoint=endpoint, residency=residency,
                 status=kw.pop("status", "idle"), last_read=read, size_bytes=size, **kw)


def _master(used_pct=50, *, endpoint="m1", maxmemory=1000 * MB, **kw) -> Master:
    return Master(endpoint=endpoint, used=maxmemory * used_pct // 100, maxmemory=maxmemory, **kw)


def _evicted(p) -> list:
    return [(e.graph_id, e.reason) for e in p.evictions]


# ── idle eviction ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("residency, read, reason", [
    ("standard", _ago(days=8), "idle_standard"),
    ("standard", _ago(days=6), None),
    ("coldline", _ago(hours=2), "idle_coldline"),
    ("coldline", _ago(minutes=30), None),
    ("always", _ago(days=400), None),
    ("standard", None, None),                    # never read nor projected: no age to judge
])
def test_idle_graphs_go_by_their_class(residency, read, reason):
    p = plan(POLICY, [_master()], [_graph("g", residency, read=read)], NOW)
    assert _evicted(p) == ([("g", reason)] if reason else [])


@pytest.mark.parametrize("excluded", [
    {"owned": False},                            # the customer's key: Always until adopted
    {"leased": True},                            # a read holds it
    {"status": "projecting"},                    # a pass in flight
    {"status": "rehydrating"},
    {"evictable": False},                        # at genesis, still being enabled, or trashed
])
def test_what_is_never_evicted_however_idle_or_full(excluded):
    graphs = [_graph("g", "coldline", read=_ago(days=30), **excluded)]
    assert plan(POLICY, [_master(used_pct=95)], graphs, NOW).evictions == []


# ── pressure eviction ────────────────────────────────────────────────────────────────────────────
def test_pressure_takes_coldline_idle_longest_first_then_standard_by_oldest_read():
    """At 85 % of 1000 MB the master must come down to 700 MB: 150 MB, taken from the coldest."""
    graphs = [
        _graph("std_old", read=_ago(days=3), size=60 * MB),
        _graph("std_new", read=_ago(minutes=1), size=60 * MB),
        _graph("cold_new", "coldline", read=_ago(minutes=5), size=50 * MB),
        _graph("cold_old", "coldline", read=_ago(minutes=50), size=50 * MB),
        _graph("always", "always", read=_ago(days=9), size=500 * MB),
    ]
    p = plan(POLICY, [_master(used_pct=85)], graphs, NOW)
    assert _evicted(p) == [("cold_old", "pressure"), ("cold_new", "pressure"),
                           ("std_old", "pressure")]
    assert p.masters[0].used_after == 850 * MB - 160 * MB


def test_pressure_starts_at_the_start_mark_and_idle_eviction_counts_toward_the_stop_mark():
    below = plan(POLICY, [_master(used_pct=79)], [_graph("g", read=_ago(minutes=1))], NOW)
    assert below.evictions == []
    graphs = [_graph("idle", "coldline", read=_ago(hours=3), size=200 * MB),
              _graph("busy", "coldline", read=_ago(minutes=1), size=200 * MB)]
    p = plan(POLICY, [_master(used_pct=85)], graphs, NOW)
    assert _evicted(p) == [("idle", "idle_coldline")]           # 650 MB ≤ 700: nothing more


def test_pressure_stops_when_nothing_evictable_is_left():
    graphs = [_graph("a", "always", size=900 * MB), _graph("b", leased=True, size=10 * MB)]
    p = plan(POLICY, [_master(used_pct=95)], graphs, NOW)
    assert p.evictions == [] and p.masters[0].used_after == 950 * MB


def test_each_master_is_relieved_on_its_own():
    graphs = [_graph("hot", read=_ago(minutes=1), endpoint="m1"),
              _graph("calm", read=_ago(minutes=1), endpoint="m2")]
    p = plan(POLICY, [_master(used_pct=90, endpoint="m1"), _master(used_pct=40, endpoint="m2")],
             graphs, NOW)
    assert _evicted(p) == [("hot", "pressure")]


def test_with_eviction_off_nothing_is_evicted_and_loads_go_on():
    off = residency_policy.effective({"evictionEnabled": False})
    graphs = [_graph("idle", "coldline", read=_ago(days=2)),
              _graph("asked", status="evicted", requested_at=1.0)]
    p = plan(off, [_master(used_pct=60)], graphs, NOW)
    assert p.evictions == [] and [l.graph_id for l in p.loads] == ["asked"]


def test_a_lower_start_mark_evicts_what_the_default_kept():
    graphs = [_graph("g", read=_ago(minutes=1), size=100 * MB)]
    assert plan(POLICY, [_master(used_pct=60)], graphs, NOW).evictions == []
    lower = residency_policy.effective({"highWaterPct": 55, "lowWaterPct": 50})
    assert _evicted(plan(lower, [_master(used_pct=60)], graphs, NOW)) == [("g", "pressure")]


# ── admission and loads ──────────────────────────────────────────────────────────────────────────
def test_a_load_needs_room_for_its_estimate_and_headroom_under_the_start_mark():
    """1000 MB master, start mark 800 MB: at 600 MB used a 100 MB graph needs 130 MB."""
    assert admit(_master(used_pct=60), 130 * MB, POLICY, 0) == (True, 0)
    assert admit(_master(used_pct=60), 130 * MB, POLICY, 80 * MB) == (False, 10 * MB)
    assert admit(_master(used_pct=60), 210 * MB, POLICY, 0) == (False, 10 * MB)
    no_limit = Master(endpoint="m1", used=5000 * MB, maxmemory=0)
    assert admit(no_limit, 10_000 * MB, POLICY, 0) == (True, 0)       # nothing to measure against
    unread = Master(endpoint="m1", used=None, maxmemory=1000 * MB)
    assert admit(unread, 1, POLICY, 0) == (False, None)


@pytest.mark.parametrize("size, used_pct, reserved, started", [
    (100 * MB, 60, 0, True),
    (100 * MB, 60, 80 * MB, False),             # the aggregation governor holds the room
    (170 * MB, 60, 0, False),                   # 221 MB > 200 MB of room
])
def test_a_load_that_does_not_fit_waits_with_its_shortfall(size, used_pct, reserved, started):
    graphs = [_graph("g", status="waiting_capacity", size=size, requested_at=1.0)]
    p = plan(POLICY, [_master(used_pct=used_pct, reserved=reserved)], graphs, NOW)
    if started:
        assert [(l.graph_id, l.bytes) for l in p.loads] == [("g", size)]
        assert p.waits == []
    else:
        assert p.loads == [] and [(w.graph_id, w.reason) for w in p.waits] == [("g", "capacity")]
        assert p.waits[0].shortfall > 0


def test_loads_start_one_per_master_in_the_order_they_were_asked_for():
    graphs = [_graph("second", status="evicted", requested_at=20.0),
              _graph("first", status="waiting_capacity", requested_at=10.0),
              _graph("other_master", status="evicted", requested_at=30.0, endpoint="m2")]
    p = plan(POLICY, [_master(), _master(endpoint="m2")], graphs, NOW)
    assert sorted(l.graph_id for l in p.loads) == ["first", "other_master"]
    assert [(w.graph_id, w.reason) for w in p.waits] == [("second", "queued")]


def test_a_load_in_flight_on_the_master_holds_the_next_and_reserves_its_room():
    graphs = [_graph("loading", status="rehydrating", seeding=True, size=100 * MB),
              _graph("next", status="evicted", requested_at=1.0, size=10 * MB)]
    p = plan(POLICY, [_master(used_pct=50)], graphs, NOW)
    assert p.loads == [] and [(w.graph_id, w.reason) for w in p.waits] == [("next", "queued")]
    assert p.masters[0].reserved == 130 * MB
    # A full projection (a rebuild, a move's reseed) is counted the same way.
    rebuild = [_graph("rebuild", status="rebuilding", seeding=True, size=200 * MB),
               _graph("next", status="evicted", requested_at=1.0, size=10 * MB)]
    p = plan(POLICY, [_master(used_pct=50)], rebuild, NOW)
    assert p.masters[0].reserved == 260 * MB and p.waits[0].reason == "queued"


def test_no_load_starts_while_the_master_forks_for_persistence_or_cannot_be_read():
    graphs = [_graph("g", status="evicted", requested_at=1.0)]
    forked = plan(POLICY, [_master(hold="fork")], graphs, NOW)
    assert forked.loads == [] and forked.waits[0].reason == "fork"
    unread = plan(POLICY, [Master(endpoint="m1", used=None, maxmemory=0)], graphs, NOW)
    assert unread.loads == [] and unread.waits[0].reason == "unmeasured"


def test_a_graph_never_measured_is_estimated_from_its_entities():
    graphs = [_graph("g", status="evicted", requested_at=1.0, size=None, entities=200_000)]
    p = plan(POLICY, [_master(used_pct=0)], graphs, NOW)
    assert p.loads[0].bytes == 200_000 * 550
    pricier = residency_policy.effective({"bytesPerEntity": 5_000})       # 1 GB: x1.3 won't fit
    assert plan(pricier, [_master(used_pct=0)], graphs, NOW).waits[0].reason == "capacity"


def test_a_resident_graph_asks_for_no_load():
    graphs = [_graph("g", requested_at=1.0)]
    assert plan(POLICY, [_master()], graphs, NOW).loads == []


# ── the preview: the planner on proposed values, acting on nothing ───────────────────────────────
class _Session:
    """The management session the preview reads the saved values and the labels through."""

    def __init__(self, row=None):
        self.row, self.commits = row, 0

    async def get(self, cls, pk):
        return self.row

    async def execute(self, stmt):
        return SimpleNamespace(all=lambda: [("ds_cold", "Cold lake"), ("ds_std", "Warehouse")])

    async def commit(self):
        self.commits += 1


def _snapshot() -> residency.Snapshot:
    now = datetime.now(timezone.utc)                          # the preview plans at the real now
    graphs = [
        _graph("cold", "coldline", read=now - timedelta(minutes=20), size=150 * MB),
        _graph("std", read=now - timedelta(days=2), size=150 * MB),
        _graph("asked", status="waiting_capacity", requested_at=1.0, size=10 * MB),
    ]
    rows = {"cold": {"data_source_id": "ds_cold"}, "std": {"data_source_id": "ds_std"},
            "asked": {"data_source_id": "ds_asked"}}
    return residency.Snapshot(masters=[_master(used_pct=72)], graphs=graphs, rows=rows)


async def _preview(body, row=None):
    snap = _snapshot()

    async def gather(**kw):
        return snap

    session = _Session(row)
    with patch.object(residency, "gather", gather):
        out = await va.preview_residency_policy(body, _user=SimpleNamespace(id="usr_admin"),
                                                session=session)
    assert session.commits == 0                               # it acts on nothing
    return out, snap


async def test_the_preview_is_the_planner_on_the_proposed_values():
    out, snap = await _preview({"highWaterPct": 70, "lowWaterPct": 60},
                               PlatformSettingsORM(id=1, gv_load_margin_pct=150))
    policy = residency_policy.effective({"highWaterPct": 70, "lowWaterPct": 60,
                                         "loadMarginPct": 150})
    expected = plan(policy, snap.masters, snap.graphs, datetime.now(timezone.utc))
    assert out["values"]["highWaterPct"] == 70 and out["values"]["loadMarginPct"] == 150
    (master,) = out["masters"]
    assert [(e["graphId"], e["reason"], e["bytes"]) for e in master["evictions"]] == [
        (e.graph_id, e.reason, e.bytes) for e in expected.evictions] == [
        ("cold", "pressure", 150 * MB)]
    assert master["evictions"][0]["label"] == "Cold lake"
    assert master["usedAfterBytes"] == expected.masters[0].used_after == 570 * MB
    assert [w["graphId"] for w in master["waits"]] == [w.graph_id for w in expected.waits]
    assert master["waits"][0]["reason"] == "capacity" and master["waits"][0]["shortfallBytes"] > 0
    assert (out["evictions"], out["evictedBytes"], out["loads"]) == (1, 150 * MB, 0)


async def test_the_preview_of_nothing_new_is_the_next_pass_as_it_stands():
    out, _snap = await _preview({})
    (master,) = out["masters"]
    assert master["evictions"] == []                          # 72 % is under the 80 % start mark
    assert [x["graphId"] for x in master["loads"]] == ["asked"]


async def test_the_preview_refuses_what_a_save_would():
    with pytest.raises(HTTPException) as caught:
        await _preview({"lowWaterPct": 79})
    assert caught.value.status_code == 422 and caught.value.detail["field"] == "lowWaterPct"


def test_the_preview_is_for_platform_admins_only():
    routes = {m: (r, d) for m, p, r, d in api_key_surface.routes(app)
              if p == "/api/v1/admin/versioning/residency-policy/preview"}
    assert set(routes) == {"POST"}
    route, dependant = routes["POST"]
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perms.add(getattr(getattr(dep, "call", None), "required_permission", None))
        stack.extend(dep.dependencies)
    assert "system:admin" in perms
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


# ── the loop's place in the projection lane ──────────────────────────────────────────────────────
async def _lane_loops(monkeypatch, *, residency_on: bool) -> set:
    """Which of the eviction loops the projection lane runs (each stubbed to note it ran)."""
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", residency_on)
    ran = set()
    worker = ProjectionWorker(SimpleNamespace(), evict_budget=lambda provider: 1,
                              lanes={"projection"})

    async def noted(name):
        ran.add(name)

    async def nothing(*a, **kw):
        return None

    import backend.app.services.versioning.worker as worker_module
    monkeypatch.setattr(worker_module, "ensure_consumer_group", nothing)
    for name in ("_reclaim_pending", "_poll_loop", "_stream_loop", "_sweep_loop",
                 "_liveness_loop", "_retire_loop"):
        monkeypatch.setattr(worker, name, nothing)
    monkeypatch.setattr(worker, "_evict_loop", lambda: noted("count budget"))
    monkeypatch.setattr(worker, "_capacity_loop", lambda: noted("capacity"))
    await worker.run()
    return ran


async def test_with_residency_on_the_capacity_loop_runs_and_the_count_budget_does_not(monkeypatch):
    assert await _lane_loops(monkeypatch, residency_on=True) == {"capacity"}


async def test_with_residency_off_the_count_budget_runs_as_before(monkeypatch):
    assert await _lane_loops(monkeypatch, residency_on=False) == {"count budget"}


# ── what a pass reports ──────────────────────────────────────────────────────────────────────────
class _Metrics:
    def __init__(self):
        self.gauges, self.counters = {}, {}

    def gauge_set(self, name, labels, value):
        self.gauges[(name, tuple(sorted(labels.items())))] = value

    def increment(self, name, labels, value=1.0):
        key = (name, tuple(sorted(labels.items())))
        self.counters[key] = self.counters.get(key, 0) + value


def test_a_pass_reports_each_master_s_memory_and_the_graphs_by_class_and_state(monkeypatch):
    from backend.app.jobs import metrics

    sink = _Metrics()
    monkeypatch.setattr(metrics, "_backend", sink)
    snap = residency.Snapshot(
        masters=[_master(used_pct=40), Master(endpoint="m2", used=None, maxmemory=0)],
        graphs=[_graph("a"), _graph("b", status="evicted"), _graph("c", "coldline"),
                _graph("d", "always", status="rehydrating", endpoint="m2"),
                _graph("e", status="waiting_capacity")])
    residency._report(snap)
    g = sink.gauges
    assert g[("versioning_residency_master_used_bytes", (("master", "m1"),))] == 400 * MB
    assert g[("versioning_residency_master_max_bytes", (("master", "m1"),))] == 1000 * MB
    assert ("versioning_residency_master_used_bytes", (("master", "m2"),)) not in g

    def graphs(cls, state):
        return g[("versioning_residency_graphs", (("residency", cls), ("state", state)))]

    assert (graphs("standard", "resident"), graphs("standard", "evicted"),
            graphs("standard", "waiting_capacity"), graphs("coldline", "resident"),
            graphs("always", "rehydrating"), graphs("always", "resident")) == (1, 1, 1, 1, 1, 0)
    assert g[("versioning_residency_oldest_rehydrating_seconds", ())] == 0     # none has a start


def test_a_pass_reports_how_long_the_oldest_load_has_been_under_way(monkeypatch):
    """A load has no timeout (its reads stay on Postgres meanwhile), so one that does not finish
    must be visible: the age of the oldest load in flight; 0 when there is none."""
    from backend.app.jobs import metrics

    sink = _Metrics()
    monkeypatch.setattr(metrics, "_backend", sink)
    now = datetime.now(timezone.utc)
    snap = residency.Snapshot(rows={
        "a": {"status": "rehydrating", "rehydrating_since": now - timedelta(minutes=50)},
        "b": {"status": "rehydrating", "rehydrating_since": now - timedelta(minutes=5)},
        "c": {"status": "idle", "rehydrating_since": now - timedelta(days=3)},   # long done
    })
    residency._report(snap)
    age = sink.gauges[("versioning_residency_oldest_rehydrating_seconds", ())]
    assert 50 * 60 <= age < 50 * 60 + 30
    residency._report(residency.Snapshot())
    assert sink.gauges[("versioning_residency_oldest_rehydrating_seconds", ())] == 0
