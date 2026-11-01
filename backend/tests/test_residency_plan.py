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
from backend.app.services.versioning import config, keymigrate, residency, residency_policy
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


def test_a_graph_with_no_read_on_record_is_never_idle_nor_first_under_pressure():
    """Its idle clock has not started (the capacity loop starts it): it is no candidate for idle
    eviction, and under pressure it goes after every graph whose last read is known."""
    graphs = [_graph("unread", "coldline", read=None, size=200 * MB),
              _graph("read", "coldline", read=_ago(minutes=30), size=200 * MB)]
    p = plan(POLICY, [_master(used_pct=82)], graphs, NOW)      # 120 MB to free: one is enough
    assert _evicted(p) == [("read", "pressure")]
    assert plan(POLICY, [_master(used_pct=50)], graphs[:1], NOW).evictions == []


@pytest.mark.parametrize("master", [
    Master(endpoint="m1", used=None, maxmemory=1000 * MB),     # cannot be read
    _master(used_pct=90, hold="loading"),                       # replaying its dataset
])
def test_a_master_that_cannot_be_read_or_is_loading_plans_no_eviction(master):
    """Its drop would fail, leaving the key in memory while the graph reads evicted."""
    graphs = [_graph("idle", "coldline", read=_ago(hours=3)),
              _graph("pressed", read=_ago(days=1), size=300 * MB)]
    assert plan(POLICY, [master], graphs, NOW).evictions == []


def test_the_plan_keeps_the_next_pressure_candidates_and_what_must_be_freed():
    """So the pass can make up for an eviction the evictor refuses, in the same order."""
    graphs = [_graph(g, "coldline", read=_ago(minutes=50 - i), size=100 * MB)
              for i, g in enumerate(("a", "b", "c", "d"))]
    (m,) = plan(POLICY, [_master(used_pct=85)], graphs, NOW).masters    # 150 MB to free
    assert [e.graph_id for e in m.evictions] == ["a", "b"]
    assert [e.graph_id for e in m.spare] == ["c", "d"] and m.to_free == 150 * MB


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


def test_loads_start_in_the_order_asked_one_per_master_each_on_the_roomiest_free_one():
    """A load seeds a fresh key wherever there is most room, so the order the loads were asked
    for is the provider's, not a master's: the first goes to the roomiest master, the next to the
    roomiest of the rest, and once every master has its load the others wait their turn."""
    graphs = [_graph("second", status="evicted", requested_at=20.0),
              _graph("first", status="waiting_capacity", requested_at=10.0),
              _graph("third", status="evicted", requested_at=30.0, endpoint="m2")]
    p = plan(POLICY, [_master(used_pct=40), _master(endpoint="m2", used_pct=50)], graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("first", "m1"), ("second", "m2")]
    assert [(w.graph_id, w.reason) for w in p.waits] == [("third", "queued")]


# ── placement: where a load goes ─────────────────────────────────────────────────────────────────
def test_a_load_goes_to_the_master_with_the_most_room_not_where_its_key_was():
    """Its key went with its eviction: the load seeds a fresh key on the master with the most
    room under its start mark, after what is held there — often one that holds no graph."""
    graphs = [_graph("g", status="evicted", requested_at=1.0, endpoint="m1")]
    masters = [_master(used_pct=70), _master(endpoint="m2", used_pct=60, reserved=150 * MB),
               _master(endpoint="m3", used_pct=30)]
    p = plan(POLICY, masters, graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("g", "m3")]
    assert [m.loads for m in p.masters[:2]] == [[], []]


def test_placement_counts_what_is_held_on_each_master():
    graphs = [_graph("g", status="evicted", requested_at=1.0)]
    masters = [_master(used_pct=50), _master(endpoint="m2", used_pct=20, reserved=400 * MB)]
    assert plan(POLICY, masters, graphs, NOW).loads[0].endpoint == "m1"     # 300 MB beats 200 MB


def test_a_busy_or_held_master_is_passed_over_for_another():
    graphs = [_graph("g", status="evicted", requested_at=1.0),
              _graph("loading", status="rehydrating", seeding=True, endpoint="m3")]
    masters = [_master(used_pct=10, hold="fork"), _master(endpoint="m2", used_pct=60),
               _master(endpoint="m3", used_pct=0)]
    assert plan(POLICY, masters, graphs, NOW).loads[0].endpoint == "m2"


def test_when_the_first_load_fits_on_no_master_later_ones_that_fit_go_ahead():
    """The first waits for room on the master where it falls shortest. With nothing there to make
    room with it keeps nothing, and later loads go where they fit, that master included."""
    graphs = [_graph("big", status="evicted", requested_at=1.0, size=500 * MB),
              _graph("small", status="evicted", requested_at=2.0, size=1 * MB),
              _graph("next", status="evicted", requested_at=3.0, size=1 * MB)]
    p = plan(POLICY, [_master(used_pct=60), _master(endpoint="m2", used_pct=70)], graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("small", "m1"), ("next", "m2")]
    assert [(w.graph_id, w.reason, w.endpoint) for w in p.waits] == [("big", "capacity", "m1")]
    assert p.waits[0].shortfall == 650 * MB - 200 * MB


GB = 1024 ** 3


def _at_72_pct(n=3) -> list:
    """Masters of 32 GB at 72 %: where pressure eviction leaves them, between the stop and the
    start marks, so pressure never runs there."""
    return [Master(endpoint=f"m{i}", used=32 * GB * 72 // 100, maxmemory=32 * GB)
            for i in range(1, n + 1)]


def test_a_load_that_fits_on_no_master_holds_up_no_later_load():
    """Review finding 1, scenario A: a 2 GB graph needs 2.6 GB, and each master has 2.56 GB under
    its start mark; a 50 MB graph asked after it, and an Always graph queued behind it, go ahead
    (with nothing to make room with on m1, it keeps no master)."""
    graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=100.0),
              _graph("small", status="evicted", size=50 * MB, requested_at=200.0, endpoint="m2"),
              _graph("always", "always", status="evicted", size=10 * MB, requested_at=300.0,
                     endpoint="m3")]
    p = plan(POLICY, _at_72_pct(), graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("small", "m1"), ("always", "m2")]
    assert [(w.graph_id, w.endpoint, w.reason) for w in p.waits] == [("big", "m1", "capacity")]


def test_a_graph_held_to_its_own_full_master_holds_up_no_load_elsewhere():
    """Scenario B: a graph whose rollup graph is named from its key loads only onto its own master,
    at 79 %; a 10 MB load goes ahead onto a master at 10 %."""
    masters = [Master(endpoint="m1", used=32 * GB * 79 // 100, maxmemory=32 * GB),
               Master(endpoint="m2", used=32 * GB * 10 // 100, maxmemory=32 * GB)]
    graphs = [_graph("dedicated", status="evicted", size=1 * GB, requested_at=1.0, placed=False),
              _graph("tiny", status="evicted", size=10 * MB, requested_at=2.0)]
    p = plan(POLICY, masters, graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("tiny", "m2")]
    assert [(w.graph_id, w.endpoint, w.reason) for w in p.waits] == [("dedicated", "m1",
                                                                      "capacity")]


def test_room_is_made_for_the_first_load_that_fits_nowhere_and_it_keeps_its_place():
    """On the master where it falls shortest (here 41 MB), as pressure would pick them — Coldline
    first, then Standard by oldest read — and only as many as make the room it lacks. Never an
    Always graph, one a read holds, or one read within the Coldline idle time (it would come
    straight back). The next pass, with the room made, it loads first."""
    on_m1 = [_graph("always_old", "always", read=_ago(days=30), size=1 * GB),
             _graph("leased_old", read=_ago(days=20), size=1 * GB, leased=True),
             _graph("recent", read=_ago(minutes=30), size=1 * GB),
             _graph("std_5d", read=_ago(days=5), size=30 * MB),
             _graph("std_3d", read=_ago(days=3), size=100 * MB),
             _graph("std_2d", read=_ago(days=2), size=200 * MB)]
    graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=100.0), *on_m1]
    p = plan(POLICY, _at_72_pct(), graphs, NOW)
    assert _evicted(p) == [("std_5d", "pressure"), ("std_3d", "pressure")]
    assert [(w.graph_id, w.endpoint, w.reason) for w in p.waits] == [("big", "m1", "capacity")]
    assert p.masters[0].used_after == 32 * GB * 72 // 100 - 130 * MB

    later = _graph("later", status="evicted", size=10 * MB, requested_at=200.0)
    freed = [Master(endpoint="m1", used=32 * GB * 72 // 100 - 130 * MB, maxmemory=32 * GB),
             *_at_72_pct()[1:]]
    p = plan(POLICY, freed, [graphs[0], later, *on_m1[:3], on_m1[5]], NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("big", "m1"), ("later", "m2")]
    assert p.evictions == []


def test_a_load_no_room_can_be_made_for_holds_neither_its_master_nor_the_room_making():
    """Review 3, finding 1: the first load that fits nowhere took its master and its provider's
    room-making whether or not room could be made for it — every pass, for good when none can.
    It takes them only when room is made: (a) a one-master provider where nothing can go, (b) a
    load too big for any master, (c) Coldline idle equal to Standard idle, where everything past
    the quiet time is already idle-evicted."""
    # (a) one master at 72 %, everything on it read within the hour.
    one = [Master(endpoint="m1", used=32 * GB * 72 // 100, maxmemory=32 * GB)]
    graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=1.0),
              _graph("small", status="evicted", size=50 * MB, requested_at=2.0),
              _graph("always", "always", status="evicted", size=10 * MB, requested_at=3.0),
              _graph("hot", read=_ago(minutes=20), size=4 * GB)]
    p = plan(POLICY, one, graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("small", "m1")]
    assert [(w.graph_id, w.reason) for w in p.waits] == [("big", "capacity"), ("always", "queued")]
    assert p.evictions == [] and not p.masters[0].claimed

    # (b) a 30 GB graph needs 39 GB, over every master's 25.6 GB start mark: it holds nothing, so
    # the 2 GB load behind it gets room made (a 4 GB graph idle for 3 days), and 50 MB loads.
    three = [Master(endpoint="m1", used=32 * GB * 72 // 100, maxmemory=32 * GB),
             Master(endpoint="m2", used=32 * GB * 74 // 100, maxmemory=32 * GB),
             Master(endpoint="m3", used=32 * GB * 74 // 100, maxmemory=32 * GB)]
    graphs = [_graph("huge", status="waiting_capacity", size=30 * GB, requested_at=1.0),
              _graph("two", status="evicted", size=2 * GB, requested_at=2.0),
              _graph("small", status="evicted", size=50 * MB, requested_at=3.0),
              _graph("old", read=_ago(days=3), size=4 * GB)]
    p = plan(POLICY, three, graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("small", "m2")]
    assert _evicted(p) == [("old", "pressure")]
    assert [(w.graph_id, w.endpoint, w.reason) for w in p.waits] == [
        ("huge", "m1", "capacity"), ("two", "m1", "capacity")]
    assert [m.claimed for m in p.masters] == [True, False, False]

    # (c) Coldline idle = Standard idle: nothing past the quiet time is left to evict.
    same = residency_policy.effective({"standardIdleSecs": 86400, "coldlineIdleSecs": 86400})
    graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=1.0),
              _graph("small", status="evicted", size=50 * MB, requested_at=2.0),
              _graph("std_20h", read=_ago(hours=20), size=3 * GB)]
    p = plan(same, one, graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("small", "m1")]
    assert p.evictions == []


def test_room_is_made_only_for_a_load_that_fits_on_no_master_by_room_alone():
    """Review 3, finding 5: with the roomiest master busy for a pass (or forking), room was made
    on a fuller one — and the next pass the load went to the roomiest anyway. A load that fits on
    some master by room alone waits for it."""
    for held in ({"hold": "fork"}, {}):
        masters = [Master(endpoint="m1", used=32 * GB * 10 // 100, maxmemory=32 * GB, **held),
                   Master(endpoint="m2", used=32 * GB * 75 // 100, maxmemory=32 * GB)]
        graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=1.0),
                  _graph("old1", read=_ago(days=3), size=1 * GB, endpoint="m2"),
                  _graph("old2", read=_ago(days=2), size=1 * GB, endpoint="m2")]
        if not held:
            graphs.append(_graph("inflight", status="rehydrating", size=10 * MB, seeding=True))
        p = plan(POLICY, masters, graphs, NOW)
        assert p.evictions == [] and p.loads == [], held
        (wait,) = p.waits
        assert (wait.graph_id, wait.endpoint, wait.reason) == ("big", "m1", held.get("hold",
                                                                                    "queued"))


def test_no_room_is_made_in_a_pass_that_could_not_read_sizes():
    """Review 3, finding 13: such a pass plans no pressure eviction, room-making's included."""
    graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=1.0),
              _graph("s1", read=_ago(days=3), size=1 * GB)]
    p = plan(POLICY, _at_72_pct(1), graphs, NOW, sized=False)
    assert p.evictions == [] and not p.masters[0].claimed


async def test_a_master_claimed_for_a_waiting_load_takes_no_other_key_or_load(monkeypatch):
    """Review 3, finding 11: a route's new key, or a pass's load moved off a master no key lands
    on, could go onto the master whose room is being made for a waiting load."""
    from backend.app.services.versioning.residency_plan import Load, MasterPlan, Plan

    masters = [_master(used_pct=60), _master(endpoint="m2", used_pct=70)]
    claimed = [_graph("big", status="waiting_capacity", size=300 * MB, requested_at=1.0),
               _graph("old", read=_ago(days=3), size=200 * MB)]
    snap = residency.Snapshot(masters=masters, graphs=claimed,
                              slots={"m1": [(0, 8191)], "m2": [(8192, 16383)]})

    async def gather(**kw):
        return snap

    monkeypatch.setattr(residency, "gather", gather)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    try:
        assert plan(POLICY, masters, claimed, NOW).masters[0].claimed
        assert (await residency.place_key("graph_01JA2B3C4D5E6F7G8H9JKMNPQR", "default",
                                          taken=set()))[1] == "m2"
        on_m1 = keymigrate.placed_key("graph_01JA2B3C4D5E6F7G8H9JKMNPQR", [(0, 8191)], set())
        assert (await residency.admission_on("big", "default", on_m1))[3] == "busy"

        async def key(load, snap):
            return None if load.endpoint == "m3" else (f"k_{load.endpoint}", {"master": load.endpoint})

        started = []

        async def start(graph_id, *, key=None, shard_map=None):
            started.append((graph_id, shard_map["master"]))
            return True

        monkeypatch.setattr(residency, "_load_key", key)
        monkeypatch.setattr(residency, "_start_load", start)
        decided = Plan(masters=[
            MasterPlan(master=_master(used_pct=10), reserved=0, used_after=None, claimed=True),
            MasterPlan(master=_master(endpoint="m2", used_pct=50), reserved=0, used_after=None),
            MasterPlan(master=_master(endpoint="m3", used_pct=5), reserved=0, used_after=None,
                       loads=[Load("g", "m3", 10 * MB)])])
        loop = residency.CapacityLoop(SimpleNamespace(drop_graph=None))
        await loop._act(decided, residency.Snapshot(
            masters=[m.master for m in decided.masters],
            rows={"g": {"placed": True, "provider": "default", "key": "old"}}))
        assert started == [("g", "m2")]
    finally:
        residency_policy.invalidate()


def test_no_room_is_made_that_would_not_let_the_load_in():
    """What the master could free without thrash is less than the load lacks: nothing is evicted
    for it, and it waits; nor with eviction off."""
    graphs = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=100.0),
              _graph("std_5d", read=_ago(days=5), size=10 * MB)]
    assert plan(POLICY, _at_72_pct(), graphs, NOW).evictions == []
    room = [_graph("big", status="waiting_capacity", size=2 * GB, requested_at=100.0),
            _graph("std_5d", read=_ago(days=5), size=100 * MB)]
    off = residency_policy.effective({"evictionEnabled": False})
    assert plan(off, _at_72_pct(), room, NOW).evictions == []
    assert _evicted(plan(POLICY, _at_72_pct(), room, NOW)) == [("std_5d", "pressure")]


def test_a_master_with_no_memory_limit_is_no_roomier_than_one_with_room():
    """Review finding 12: a master that sets no maxmemory counted as having more room than any,
    so with one master misconfigured every placed load, Adopt and move went there. Its room is
    unknown: masters whose room is known come first, and of masters with no limit, the least
    used."""
    graphs = [_graph("g", status="evicted", requested_at=1.0)]
    mixed = [Master(endpoint="no_limit", used=900 * MB, maxmemory=0), _master(endpoint="m2",
                                                                             used_pct=60)]
    assert plan(POLICY, mixed, graphs, NOW).loads[0].endpoint == "m2"
    unlimited = [Master(endpoint="a", used=900 * MB, maxmemory=0),
                 Master(endpoint="b", used=100 * MB, maxmemory=0)]
    assert plan(POLICY, unlimited, graphs, NOW).loads[0].endpoint == "b"


def test_a_graph_whose_rollup_graph_is_named_from_its_key_loads_back_onto_its_own_master():
    """A dedicated rollup graph is named from the graph's key, so that key never changes: its
    load goes back onto it, on its own master."""
    graphs = [_graph("dedicated", status="evicted", requested_at=1.0, placed=False)]
    p = plan(POLICY, [_master(used_pct=70), _master(endpoint="m2", used_pct=10)], graphs, NOW)
    assert [(x.graph_id, x.endpoint) for x in p.loads] == [("dedicated", "m1")]


def test_a_load_goes_only_to_a_master_of_its_own_provider():
    graphs = [_graph("g", status="evicted", requested_at=1.0, provider="p1")]
    masters = [_master(used_pct=70, providers=("p1",)),
               _master(endpoint="m9", used_pct=0, providers=("p2",))]
    assert plan(POLICY, masters, graphs, NOW).loads[0].endpoint == "m1"
    # A master two providers reach (the same server) serves both.
    shared = [_master(used_pct=70, providers=("p1",)),
              _master(endpoint="m2", used_pct=0, providers=("p2", "p1"))]
    assert plan(POLICY, shared, graphs, NOW).loads[0].endpoint == "m2"


async def test_admission_answers_for_the_master_the_load_would_go_to(monkeypatch):
    snap = residency.Snapshot(masters=[_master(used_pct=70), _master(endpoint="m2", used_pct=10)],
                              graphs=[_graph("g", status="evicted", size=100 * MB)])

    async def gather(**kw):
        return snap

    monkeypatch.setattr(residency, "gather", gather)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    try:
        assert await residency.admission("g") == (True, "m2", 0, None)
        snap.graphs[0] = _graph("g", status="evicted", size=600 * MB)        # 780 MB > 700 MB
        assert await residency.admission("g") == (False, "m2", 80 * MB, "capacity")
    finally:
        residency_policy.invalidate()


async def test_a_new_key_is_placed_on_the_roomiest_master_of_its_provider(monkeypatch):
    from backend.app.services.graph_store.topology import key_slot

    snap = residency.Snapshot(
        masters=[_master(used_pct=70), _master(endpoint="m2", used_pct=10)],
        slots={"m1": [(0, 8191)], "m2": [(8192, 16383)]})
    asked = []

    async def gather(**kw):
        asked.append(kw)
        return snap

    monkeypatch.setattr(residency, "gather", gather)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    gid = "graph_01JA2B3C4D5E6F7G8H9JKMNPQR"
    try:
        key, master = await residency.place_key(gid, "default", taken=set())
        assert master == "m2" and key_slot(key) >= 8192 and key.startswith(f"gvp_{gid}")
        assert asked == [{"providers": ["default"]}]
    finally:
        residency_policy.invalidate()


async def test_placement_and_admission_pass_over_held_and_busy_masters(monkeypatch):
    """Review finding 2: a master replaying its dataset reads near empty, and one taking a load
    already has its one; neither has a new key placed on it nor a full write admitted onto it, as
    the planner's own loads never do. (Setting a class, which writes nothing, counts room alone:
    review 3, finding 8.)"""
    from backend.app.services.versioning import keymigrate

    snap = residency.Snapshot(
        masters=[_master(used_pct=60), _master(endpoint="m2", used_pct=5, hold="loading"),
                 _master(endpoint="m3", used_pct=0)],
        graphs=[_graph("g", owned=False, size=100 * MB),
                _graph("seeding", status="rehydrating", seeding=True, size=10 * MB,
                       endpoint="m3")],
        rows={"g": {"data_source_id": "ds1", "main_head_commit_seq": 9}},
        slots={"m1": [(0, 5000)], "m2": [(5001, 10000)], "m3": [(10001, 16383)]})

    async def gather(**kw):
        return snap

    monkeypatch.setattr(residency, "gather", gather)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    gid = "graph_01JA2B3C4D5E6F7G8H9JKMNPQR"
    try:
        assert (await residency.place_key(gid, "default", taken=set()))[1] == "m1"
        assert await residency.admission("g") == (True, "m3", 0, None)
        on = {m: keymigrate.placed_key(gid, snap.slots[m], set()) for m in ("m1", "m2", "m3")}
        assert await residency.admission_on("g", "default", on["m1"]) == (True, "m1", 0, None)
        assert await residency.admission_on("g", "default", on["m2"]) == (
            False, "m2", None, "loading")
        assert await residency.admission_on("g", "default", on["m3"]) == (
            False, "m3", None, "busy")
    finally:
        residency_policy.invalidate()


async def test_setting_always_checks_room_only(monkeypatch):
    """Review 3, finding 8: setting a class writes nothing — the load it asks for waits its turn —
    so a master that holds or takes a load now does not refuse it; only room does."""
    snap = residency.Snapshot(
        masters=[_master(used_pct=10, hold="fork"), _master(endpoint="m2", used_pct=20)],
        graphs=[_graph("g", status="evicted", size=100 * MB),
                _graph("loading", status="rehydrating", seeding=True, size=10 * MB,
                       endpoint="m2")])

    async def gather(**kw):
        return snap

    monkeypatch.setattr(residency, "gather", gather)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    try:
        assert await residency.admission("g") == (True, "m1", 0, None)
        snap.graphs[0] = _graph("g", status="evicted", size=700 * MB)       # 910 MB > 700 MB
        assert await residency.admission("g") == (False, "m1", 210 * MB, "capacity")
    finally:
        residency_policy.invalidate()


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


# ── a graph of unknown size ──────────────────────────────────────────────────────────────────────
def test_a_graph_of_unknown_size_is_never_evicted_for_pressure():
    """Counted as freeing nothing, every such graph would go and the stop mark still not be
    reached: one is never a pressure candidate. Idle eviction needs no size."""
    graphs = [_graph(f"u{i}", "coldline", read=_ago(minutes=30), size=None) for i in range(5)]
    assert plan(POLICY, [_master(used_pct=85)], graphs, NOW).evictions == []
    sized = graphs + [_graph("s", "coldline", read=_ago(minutes=40), size=200 * MB)]
    assert _evicted(plan(POLICY, [_master(used_pct=85)], sized, NOW)) == [("s", "pressure")]
    idle = [_graph("u", "coldline", read=_ago(hours=2), size=None)]
    assert _evicted(plan(POLICY, [_master(used_pct=40)], idle, NOW)) == [("u", "idle_coldline")]


def test_a_pass_that_could_not_read_sizes_plans_no_pressure_eviction():
    graphs = [_graph("s", "coldline", read=_ago(minutes=40), size=200 * MB),
              _graph("i", "coldline", read=_ago(hours=2), size=10 * MB)]
    p = plan(POLICY, [_master(used_pct=85)], graphs, NOW, sized=False)
    assert _evicted(p) == [("i", "idle_coldline")]


def test_a_load_of_unknown_size_waits_until_it_has_one():
    graphs = [_graph("g", status="evicted", requested_at=1.0, size=None)]
    p = plan(POLICY, [_master(used_pct=0)], graphs, NOW)
    assert p.loads == [] and [(w.graph_id, w.reason) for w in p.waits] == [("g", "unsized")]


async def test_a_load_s_size_is_not_taken_from_a_master_that_evicted_in_the_same_pass(
        monkeypatch):
    """The used-memory delta that sizes a load where GRAPH.MEMORY USAGE cannot is meaningless
    across the same pass's evictions on that master: no baseline is kept there."""
    from backend.app.services.versioning import cache_manager
    from backend.app.services.versioning.residency_plan import Eviction, Load, MasterPlan, Plan

    async def evicted(self, graph_id, *, drop_graph, reason=None):
        return True

    async def key(load, snap):
        return "k", None

    async def started(graph_id, *, key=None, shard_map=None):
        return True

    monkeypatch.setattr(cache_manager.CacheManager, "evict", evicted)
    monkeypatch.setattr(residency, "_load_key", key)
    monkeypatch.setattr(residency, "_start_load", started)
    decided = Plan(masters=[
        MasterPlan(master=_master(), reserved=0, used_after=None,
                   evictions=[Eviction("e", "m1", 10 * MB, "pressure")],
                   loads=[Load("l1", "m1", MB)]),
        MasterPlan(master=_master(endpoint="m2"), reserved=0, used_after=None,
                   loads=[Load("l2", "m2", MB)])])
    snap = residency.Snapshot(masters=[_master(), _master(endpoint="m2")])
    loop = residency.CapacityLoop(SimpleNamespace(drop_graph=None))
    await loop._act(decided, snap)
    assert set(loop._started) == {"l2"}


def _no_key_on_one_slot() -> str:
    """A graph none of whose first 4096 platform keys hashes to slot 0."""
    from backend.app.services.versioning import keymigrate

    return next(gid for gid in (f"graph_01JA2B3C4D5E6F7G8H9JKMN{n:03d}" for n in range(200))
                if keymigrate.placed_key(gid, [(0, 0)], set()) is None)


async def test_a_new_key_goes_to_the_next_master_when_none_hashes_to_the_roomiest(monkeypatch):
    """Review finding 5: after a reshard onto a new, empty master that owns a few slots, that
    master is the roomiest, and most graphs have no key that hashes there (4096 tries reach one
    slot for 21 % of graphs). The key goes to the next master with the most room instead."""
    gid = _no_key_on_one_slot()
    snap = residency.Snapshot(masters=[_master(used_pct=10), _master(endpoint="m2", used_pct=50)],
                              slots={"m1": [(0, 0)], "m2": [(1, 16383)]})

    async def gather(**kw):
        return snap

    monkeypatch.setattr(residency, "gather", gather)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    try:
        key, master = await residency.place_key(gid, "default", taken=set())
        assert master == "m2" and key.startswith(f"gvp_{gid}")
    finally:
        residency_policy.invalidate()


async def test_a_load_no_key_lands_on_goes_to_the_next_master_in_the_same_pass(monkeypatch):
    """The loop's load, likewise: onto the next master of its provider free to take it with room
    for it, rather than waiting pass after pass for a key that never lands."""
    from backend.app.services.versioning.residency_plan import Load, MasterPlan, Plan

    async def key(load, snap):
        return None if load.endpoint == "m1" else (f"k_{load.endpoint}", {"master": load.endpoint})

    started = []

    async def start(graph_id, *, key=None, shard_map=None):
        started.append((graph_id, key, shard_map["master"]))
        return True

    monkeypatch.setattr(residency, "_load_key", key)
    monkeypatch.setattr(residency, "_start_load", start)
    residency_policy._MEMO.update(policy=POLICY, at=residency_policy._clock())
    decided = Plan(masters=[
        MasterPlan(master=_master(used_pct=10), reserved=0, used_after=None,
                   loads=[Load("g", "m1", 10 * MB)]),
        MasterPlan(master=_master(endpoint="m2", used_pct=79), reserved=0, used_after=None),
        MasterPlan(master=_master(endpoint="m3", used_pct=50), reserved=0, used_after=None)])
    snap = residency.Snapshot(masters=[m.master for m in decided.masters],
                              rows={"g": {"placed": True, "provider": "default", "key": "old"}})
    loop = residency.CapacityLoop(SimpleNamespace(drop_graph=None))
    try:
        await loop._act(decided, snap)
    finally:
        residency_policy.invalidate()
    assert started == [("g", "k_m3", "m3")]              # m2 has no room for it: 79 % + 13 MB
    assert loop._started["g"][0] == "m3"


async def test_a_refused_eviction_is_made_up_from_the_next_candidates(monkeypatch):
    """An eviction the evictor refuses frees nothing: the pass carries on down that master's
    candidates until the stop mark is actually reached."""
    from backend.app.services.versioning import cache_manager

    tried = []

    async def evict(self, graph_id, *, drop_graph, reason=None):
        tried.append(graph_id)
        return graph_id != "a"                  # another data source reads a's key

    monkeypatch.setattr(cache_manager.CacheManager, "evict", evict)
    graphs = [_graph(g, "coldline", read=_ago(minutes=50 - i), size=100 * MB)
              for i, g in enumerate(("a", "b", "c", "d"))]
    decided = plan(POLICY, [_master(used_pct=85)], graphs, NOW)
    await residency.CapacityLoop(SimpleNamespace(drop_graph=None))._act(
        decided, residency.Snapshot(masters=[_master(used_pct=85)]))
    assert tried == ["a", "b", "c"]


async def test_a_load_waits_for_its_summaries_while_its_edge_types_cannot_be_read():
    """Review finding 4: the summaries gate let a load's key serve reads when the ontology's edge
    types could not be resolved (a management-database blip): "no lineage" (no summaries to wait
    for) and "could not tell" (not yet) answered alike. Now only the first passes."""
    from backend.app.services import projection_target
    from backend.app.services.versioning.projection import FalkorProjector

    asked = []

    async def build(gid, idempotency_key=None):
        asked.append(gid)

    class _Blip:
        async def get_graph(self, gid):
            raise ConnectionError("management database unreachable")

    proj = FalkorProjector(graph_client_factory=lambda *a, **kw: None, on_rollups_stale=build,
                           edge_types_resolver=projection_target.resolve_aggregation_edge_types)
    proj._svc = _Blip()
    assert await proj.summaries_built("graph_x", "gvp_graph_x{abc.1}", None, 42,
                                      ask="load7.0") is None       # cannot tell: not served
    assert asked == []                         # nothing to ask a build for, either

    async def no_lineage(svc, gid):
        return None

    proj._edge_types_resolver = no_lineage
    assert await proj.summaries_built("graph_x", "gvp_graph_x{abc.1}", None, 42,
                                      ask="load7.0") is True


async def test_a_package_seed_writes_its_key_only_when_admitted(monkeypatch):
    """Review finding 12: a new data source seeded from a view package writes its whole graph into
    a new key, and was never admitted. With residency on its copy is admitted on the key's master
    first: when it would not fit, the job stops before writing anything, saying so, and resumes
    from there; with residency off nothing is asked."""
    from backend.app.services.versioning import package_seed
    from backend.app.services.versioning.bootstrap_worker import BootstrapFailure

    asked = []

    async def admission_on(graph_id, provider, key):
        asked.append((graph_id, provider, key))
        return residency.Admitted(False, "10.0.0.2:6379", 3 * 1024 ** 3, "capacity")

    monkeypatch.setattr(residency, "admission_on", admission_on)
    ctx = SimpleNamespace(falkor_graph_name="gvp_new{abc.1}", falkor_provider="prov_A")
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    with pytest.raises(BootstrapFailure) as caught:
        await package_seed._admit_seed("graph_x", ctx)
    assert (caught.value.code, caught.value.action) == ("capacity", "resume")
    assert "10.0.0.2:6379" in caught.value.reason and "3.0 GiB" in caught.value.reason
    assert asked == [("graph_x", "prov_A", "gvp_new{abc.1}")]
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", False)
    await package_seed._admit_seed("graph_x", ctx)
    assert len(asked) == 1


async def test_a_failed_ontology_read_is_unresolved_not_no_lineage(monkeypatch):
    """Review 3, finding 3: LocalOntologyService.resolve swallows a failed read of the assigned
    ontology and resolves with none — "no lineage" — so with the management database down the
    summaries gate let a load through, the original case. The resolver reads the assigned ontology
    itself now, and a failed read is UNRESOLVED."""
    import contextlib

    from backend.app.services import projection_target
    from backend.app.services.versioning.projection import UNRESOLVED

    class _Svc:
        async def get_graph(self, gid):
            return {"graph_id": gid, "data_source_id": "ds_1", "workspace_id": "ws_1"}

    class _Down:
        async def execute(self, *a, **kw):
            raise ConnectionRefusedError("management database unreachable")

    @contextlib.asynccontextmanager
    async def down():
        yield _Down()

    async def in_source(ds_id):
        return "in_source"

    monkeypatch.setattr(projection_target, "get_async_session", down)
    monkeypatch.setattr(projection_target, "_projection_mode", in_source)
    assert await projection_target.resolve_aggregation_edge_types(_Svc(), "graph_x") is UNRESOLVED


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
    graphs = [
        _graph("cold", "coldline", read=NOW - timedelta(minutes=20), size=150 * MB),
        _graph("std", read=NOW - timedelta(days=2), size=150 * MB),
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
    with patch.object(residency, "gather", gather), patch.object(residency, "_clock", lambda: NOW):
        out = await va.preview_residency_policy(body, _user=SimpleNamespace(id="usr_admin"),
                                                session=session)
    assert session.commits == 0                               # it acts on nothing
    return out, snap


async def test_the_preview_is_the_planner_on_the_proposed_values():
    out, snap = await _preview({"highWaterPct": 70, "lowWaterPct": 60},
                               PlatformSettingsORM(id=1, gv_load_margin_pct=150))
    policy = residency_policy.effective({"highWaterPct": 70, "lowWaterPct": 60,
                                         "loadMarginPct": 150})
    expected = plan(policy, snap.masters, snap.graphs, NOW)
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
