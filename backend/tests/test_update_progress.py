"""Update progress and time left (``update_progress``), without a Redis server: what the projector
publishes for each phase and how often, the last update it records, the time left derived at read
time, and the projector's passes and builds reporting each phase's rows done and to do.

* A snapshot goes ``EVERY_SECS`` after an update starts and at most every ``EVERY_SECS`` per graph
  after that (never a write per row), kept ``TTL_SECS``; a pass that ends sooner writes only its end.
* The rate is an exponentially weighted average, published only once measured over
  ``TRUST_SECS``; the time left is ``(total - done) / rate`` less the snapshot's age, and null
  without a total or a trusted rate, from a stale snapshot, or under a second.
* A Redis that fails or hangs never fails or slows a pass, and is logged once.
* An update that publishes records itself as the last update; one that is held back, fails or is
  superseded leaves none, and its snapshot goes; one that stops part-way keeps its snapshot for
  the pass that resumes it, which carries its rows, start and rate on.
* The last update shown is never an older record than the graph's last publish.

The projector over Postgres and a real Redis: ``integration/test_update_progress_live.py``.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import projection, update_progress
from backend.tests.test_projection_fencing_unit import _PS, _projector

T0 = 1_795_000_000.0          # 2026-11-17T…Z, as an epoch


class FakeRedis:
    """Hashes with TTLs and pipelines (each run kept in ``ran``: ``(transaction, commands)``);
    ``down`` refuses every command, ``hang`` never answers one."""

    def __init__(self):
        self.hashes, self.ttl, self.ran, self.down, self.hang = {}, {}, [], False, False

    def pipeline(self, transaction=True):
        return _Pipe(self, transaction)

    async def hgetall(self, key):
        await self.gate()
        return dict(self.hashes.get(key, {}))

    async def gate(self):
        if self.down:
            raise ConnectionError("Redis is out of reach")
        if self.hang:
            await asyncio.Event().wait()


class _Pipe:
    def __init__(self, redis, transaction):
        self.redis, self.transaction, self.commands = redis, transaction, []

    def delete(self, *keys):
        self.commands.append(("delete",) + keys)
        return self

    def hset(self, key, mapping):
        self.commands.append(("hset", key, dict(mapping)))
        return self

    def expire(self, key, secs):
        self.commands.append(("expire", key, secs))
        return self

    def hgetall(self, key):
        self.commands.append(("hgetall", key))
        return self

    async def execute(self):
        await self.redis.gate()
        self.redis.ran.append((self.transaction, list(self.commands)))
        out = []
        for name, *args in self.commands:
            if name == "delete":
                for key in args:
                    self.redis.hashes.pop(key, None)
                    self.redis.ttl.pop(key, None)
                out.append(len(args))
            elif name == "hset":
                self.redis.hashes.setdefault(args[0], {}).update(args[1])
                out.append(len(args[1]))
            elif name == "expire":
                self.redis.ttl[args[0]] = args[1]
                out.append(True)
            elif name == "hgetall":
                out.append(dict(self.redis.hashes.get(args[0], {})))
        return out


class Clock:
    """The wall clock and the monotonic one, moved together by ``tick``."""

    def __init__(self):
        self.wall, self.mono = T0, 1_000.0

    def tick(self, secs: float) -> None:
        self.wall += secs
        self.mono += secs


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(update_progress, "_redis", lambda: fake)
    update_progress.reset()
    yield fake
    update_progress.reset()


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(update_progress, "_clock", lambda: c.wall)
    monkeypatch.setattr(update_progress, "_mono", lambda: c.mono)
    return c


async def settled() -> None:
    """Every write queued so far sent (they run in the background)."""
    for _ in range(100):
        if all(t.done() for t in list(update_progress._writers.values())):
            return
        await asyncio.sleep(0)
    raise AssertionError("writes still running")


def snapshots(redis, graph_id="g1"):
    """The snapshots written for the graph, in order."""
    return [cmd[2] for _tx, cmds in redis.ran for cmd in cmds
            if cmd[0] == "hset" and cmd[1] == update_progress.KEY + graph_id]


def iso(epoch: float) -> str:
    return update_progress._iso(epoch)


# ── publishing ──────────────────────────────────────────────────────────────────────────────────

async def test_the_first_snapshot_goes_two_seconds_in_then_at_most_every_two_seconds(redis, clock):
    update = update_progress.Update("g1", "updating", 42)
    update.count(1_000)
    for _ in range(50):                               # rows land: nothing is written per row
        await update.add(2)
    await settled()
    assert redis.ran == [] and update._timer is not None

    clock.tick(2.0)
    update._due()                                     # the timer fires: the latest state goes
    await settled()
    (first,) = snapshots(redis)
    assert first == {"phase": "updating", "unit": "rows", "targetSeq": "42",
                     "targetVersion": "42", "startedAt": iso(T0), "updatedAt": iso(T0 + 2),
                     "total": "1000", "done": "100"}  # no rate: too young to trust
    tx, cmds = redis.ran[0]
    assert tx is True and [c[0] for c in cmds] == ["delete", "hset", "expire"]
    assert redis.ttl[update_progress.KEY + "g1"] == update_progress.TTL_SECS == 600

    for _ in range(3):                                # a second's worth, twice: one write, at 4 s
        clock.tick(1.0)
        await update.add(50)
        assert update._timer is not None
    update._due()
    await settled()
    assert [s["done"] for s in snapshots(redis)] == ["100", "250"]
    assert len(redis.ran) == 2, "at most one write every two seconds"


async def test_a_pass_that_ends_within_two_seconds_writes_only_its_end(redis, clock):
    update = update_progress.Update("g1", "updating", 7)
    update.count(3)
    await update.add(3)
    clock.tick(0.4)
    update.finish(published=False)
    await settled()
    assert redis.ran == [(True, [("delete", update_progress.KEY + "g1")])]
    assert update._timer is None and not update.open


async def test_the_rate_is_smoothed_and_published_once_trusted(redis, clock):
    update = update_progress.Update("g1", "updating", 9)
    update.count(100_000)
    published = []
    for step in range(1, 29):                         # 200 rows a second, 100 every half second
        clock.tick(0.5)
        await update.add(100)
        if step % 4 == 0:                             # its timer fires every two seconds
            update._due()
            await settled()
            published.append(snapshots(redis)[-1].get("ratePerSec"))
    # Measured from the first rows landed (at 0.5 s): at 2, 4, 6, 8 and 10 s it has been measured
    # over less than ten seconds, too young to trust, so none is published; then 200 a second.
    assert published[:5] == [None] * 5
    assert [float(r) for r in published[5:]] == [pytest.approx(200.0)] * 2
    for _step in range(4):                            # it halves: the average follows, smoothed
        clock.tick(0.5)
        await update.add(50)
    update._due()
    await settled()
    weight = 1 - math.exp(-2.0 / update_progress.TAU_SECS)
    assert float(snapshots(redis)[-1]["ratePerSec"]) == pytest.approx(200 + weight * (100 - 200),
                                                                      abs=0.01)


async def test_a_new_phase_starts_its_rows_and_rate_afresh(redis, clock):
    update = update_progress.Update("g1", "building", 12)
    update.count(10)
    await update.add(4)
    update.enter("building")                          # the summaries a build carries: no rows
    clock.tick(2.0)
    update._due()
    await settled()
    (snap,) = snapshots(redis)
    assert snap["phase"] == "building" and not {"total", "done", "ratePerSec"} & set(snap)
    with pytest.raises(ValueError):
        update.enter("napping")


async def test_finishing_records_the_last_update_and_clears_the_snapshot(redis, clock):
    update = update_progress.Update("g1", "updating", 42)
    update.count(500)
    await update.add(500)
    clock.tick(25.0)
    update.finish(published=True)
    await settled()
    assert update_progress.KEY + "g1" not in redis.hashes
    assert redis.hashes[update_progress.LAST_KEY + "g1"] == {
        "finishedAt": iso(T0 + 25), "durationSecs": "25", "seq": "42", "phase": "updating",
        "rows": "500", "ratePerSec": "20.000"}
    assert redis.ttl[update_progress.LAST_KEY + "g1"] == 30 * 24 * 3600
    update.finish(published=True)                     # once only
    await settled()
    assert len(redis.ran) == 1

    # A build counts no rows of its own: its time only.
    build = update_progress.Update("g2", "switching", 43, started=iso(T0 - 600))
    build.finish(published=True, counted=False)
    await settled()
    assert redis.hashes[update_progress.LAST_KEY + "g2"] == {
        "finishedAt": iso(T0 + 25), "durationSecs": "625", "seq": "43", "phase": "switching"}

    # Under ten seconds, to a tenth.
    quick = update_progress.Update("g3", "updating", 44)
    quick.count(12)
    await quick.add(12)
    clock.tick(2.34)
    quick.finish(published=True)
    await settled()
    assert (redis.hashes[update_progress.LAST_KEY + "g3"]["durationSecs"],
            redis.hashes[update_progress.LAST_KEY + "g3"]["ratePerSec"]) == ("2.3", "5.128")


async def test_holding_keeps_the_snapshot_for_the_pass_that_resumes_it(redis, clock):
    first = update_progress.Update("g1", "seeding", 30)
    first.count(1_000)
    await first.add(400)
    clock.tick(1.0)
    first.hold()                                      # stopped at a page: written now, kept
    await settled()
    assert redis.hashes[update_progress.KEY + "g1"]["done"] == "400"
    assert not first.open

    clock.tick(0.5)
    second = update_progress.Update("g1", "seeding", 30)
    second.resume(started=T0, rate=150.0)             # what the cursor carried: trusted at once
    second.count(1_000, 400)
    await second.add(100)                             # its rows flow from here
    clock.tick(2.0)
    await second.add(300)                             # 150 a second, as before
    second._due()
    await settled()
    snap = snapshots(redis)[-1]
    assert (snap["done"], snap["startedAt"], snap["ratePerSec"]) == ("800", iso(T0), "150.000")


async def test_a_newer_update_of_a_graph_silences_the_older(redis, clock):
    old = update_progress.Update("g1", "updating", 5)
    new = update_progress.Update("g1", "updating", 6)
    clock.tick(2.0)
    old._due()
    old.finish(published=True)
    await settled()
    assert redis.ran == [], "an update another has replaced writes nothing"
    new._due()
    await settled()
    assert snapshots(redis)[-1]["targetSeq"] == "6"


async def test_a_redis_that_fails_or_hangs_never_fails_or_slows_a_pass(redis, clock, monkeypatch,
                                                                       caplog):
    caplog.set_level(logging.WARNING, logger=update_progress.__name__)
    redis.down = True
    for gid in ("g1", "g2"):
        update = update_progress.Update(gid, "updating", 1)
        update.count(5)
        await update.add(5)
        update.finish(published=True)
    await settled()
    assert len([r for r in caplog.records if "took no write" in r.getMessage()]) == 1

    redis.down, redis.hang = False, True
    monkeypatch.setattr(update_progress, "_WRITE_WAIT_S", 0.05)
    update = update_progress.Update("g3", "updating", 1)
    began = time.perf_counter()
    update.count(5)
    await update.add(5)
    update.finish(published=True)                     # queued; nothing here waits on Redis
    assert time.perf_counter() - began < 0.01
    await asyncio.sleep(0.1)
    assert update_progress._writers == {}, "the hung write gave up in its time"


def test_with_no_event_loop_nothing_is_written_and_nothing_raises(redis, clock):
    update = update_progress.Update("g1", "updating", 1)   # no loop runs in this test
    update.count(1)
    update.hold()
    assert redis.ran == [] and update_progress._queued == {}
    update_progress.NOTHING.target_seq = 9            # outside a pass: kept nowhere
    assert update_progress.NOTHING.target_seq == 0 and update_progress.NOTHING.open is False


# ── reading ─────────────────────────────────────────────────────────────────────────────────────

def _snap(**kw) -> dict:
    return {"phase": "updating", "unit": "rows", "targetSeq": "42", "targetVersion": "42",
            "startedAt": iso(T0 - 100), "updatedAt": iso(T0 - 2), "total": "1000", "done": "600",
            "ratePerSec": "100.000", **kw}


def test_time_left_is_the_rows_left_at_the_smoothed_rate_less_the_snapshots_age():
    got = update_progress.view(_snap(), now=T0)
    assert got == {"phase": "updating", "done": 600, "total": 1000, "unit": "rows",
                   "ratePerSec": 100.0, "etaSecs": 2, "startedAt": iso(T0 - 100),
                   "updatedAt": iso(T0 - 2), "targetSeq": 42, "targetVersion": 42}
    assert update_progress.view(_snap(done="100"), now=T0)["etaSecs"] == 7   # 900/100 - 2
    raw = {k.encode(): v.encode() for k, v in _snap().items()}               # as Redis answers
    assert update_progress.view(raw, now=T0)["etaSecs"] == 2


@pytest.mark.parametrize("change, why", [
    ({"ratePerSec": None}, "no trusted rate yet"),
    ({"updatedAt": iso(T0 - update_progress.STALE_SECS - 1)}, "rows stopped landing: stale"),
    ({"done": "1000"}, "every row written"),
    ({"done": "999"}, "under a second left"),
    ({"total": None, "done": None}, "a phase that counts no rows"),
])
def test_no_time_left_without_the_data_for_it(change, why):
    snap = {k: v for k, v in {**_snap(), **change}.items() if v is not None}
    got = update_progress.view(snap, now=T0)
    assert got["etaSecs"] is None, why
    if "updatedAt" in change:
        assert got["ratePerSec"] is None and got["done"] == 600, "a stale rate is not shown"
    if "total" in change:
        assert (got["done"], got["total"]) == (None, None)


def test_no_snapshot_or_an_unknown_phase_is_no_progress():
    assert update_progress.view({}, now=T0) is None
    assert update_progress.view(None, now=T0) is None
    assert update_progress.view(_snap(phase="napping"), now=T0) is None


@pytest.mark.parametrize("status, behind, building, expect", [
    ("projecting", False, False, True), ("rebuilding", False, False, True),
    ("rehydrating", True, False, True), ("idle", True, False, True),
    ("idle", False, True, True), ("idle", False, False, False),
    ("evicted", True, False, False), ("waiting_capacity", True, False, False),
])
def test_progress_is_read_only_while_an_update_may_be_in_flight(status, behind, building, expect):
    assert update_progress.in_flight(status=status, behind=behind, building=building) is expect


async def test_progress_for_a_watermark_asks_redis_only_when_an_update_may_be_in_flight(redis):
    redis.hashes[update_progress.KEY + "g1"] = _snap(updatedAt=iso(time.time()))
    idle = {"status": "idle", "fresh": True, "candidate": None}
    assert await update_progress.for_watermark("g1", idle) is None
    assert redis.ran == [] and redis.hashes, "nothing asked of Redis"
    got = await update_progress.for_watermark("g1", {**idle, "status": "projecting"})
    assert (got["phase"], got["done"], got["total"]) == ("updating", 600, 1000)
    # A fork's is its root's.
    redis.hashes[update_progress.KEY + "g_root"] = _snap(phase="loading")
    fork = {"status": "projecting", "fresh": False, "reads_through": "g_root"}
    assert (await update_progress.for_watermark("g_fork", fork))["phase"] == "loading"
    redis.down = True
    assert await update_progress.for_watermark("g1", {**idle, "fresh": False}) is None


async def test_many_graphs_progress_is_one_pipelined_read(redis):
    redis.hashes[update_progress.KEY + "g1"] = _snap(updatedAt=iso(time.time()))
    got = await update_progress.read_many(["g1", "g2", "g1"])
    assert set(got) == {"g1", "g2"} and got["g2"] is None and got["g1"]["phase"] == "updating"
    (only,) = redis.ran
    assert only == (False, [("hgetall", "gvprog:g1"), ("hgetall", "gvprog:g2")])
    assert await update_progress.read_many([]) == {} and len(redis.ran) == 1


def _record(**kw) -> dict:
    return {"finishedAt": iso(T0), "durationSecs": "25.0", "rows": "500", "ratePerSec": "20.000",
            "seq": "42", "phase": "updating", **kw}


def test_the_last_update_is_the_record_of_the_graphs_last_publish_never_an_older_one():
    wm = {"projected": 42, "last_projected_at": iso(T0 - 0.05)}
    assert update_progress.last_update(_record(), wm) == (
        {"finishedAt": iso(T0), "durationSecs": 25.0, "rows": 500, "ratePerSec": 20.0}, None)
    # A build's: no rows of its own.
    assert update_progress.last_update(_record(rows=None, ratePerSec=None) | {}, wm)[0] is not None
    assert update_progress.last_update(
        {k: v for k, v in _record().items() if k not in ("rows", "ratePerSec")}, wm)[0] == {
        "finishedAt": iso(T0), "durationSecs": 25.0, "rows": None, "ratePerSec": None}
    # Nothing recorded (expired, Redis emptied, nothing finished since): said so.
    assert update_progress.last_update({}, wm) == (None, update_progress.NOT_RECORDED)
    # A later update published but its record was lost: the one kept is older.
    later = {"projected": 43, "last_projected_at": iso(T0 + 30)}
    assert update_progress.last_update(_record(), later) == (None, update_progress.OLDER_RECORD)
    assert update_progress.last_update(_record(), {**wm, "projected": 43})[1] == \
        update_progress.OLDER_RECORD
    assert update_progress.last_update(_record(), {**wm, "last_projected_at": iso(T0 + 1)})[1] \
        == update_progress.OLDER_RECORD
    # Unloaded since (no version held): told by the time of its last publish alone.
    assert update_progress.last_update(_record(), {"projected": 0,
                                                   "last_projected_at": iso(T0 - 1)})[0]
    # The version it is at can't be read: nothing to check the record against.
    assert update_progress.last_update(_record(), None) == (None, update_progress.UNCHECKED)


async def test_a_graphs_health_reads_its_update_and_last_update_in_one_round_trip(redis):
    redis.hashes[update_progress.LAST_KEY + "g1"] = _record()
    progress, last, why = await update_progress.read_health(
        "g1", {"projected": 42, "last_projected_at": iso(T0 - 1)})
    assert progress is None and last["rows"] == 500 and why is None
    assert redis.ran == [(False, [("hgetall", "gvprog:g1"), ("hgetall", "gvlast:g1")])]
    redis.down = True
    with pytest.raises(ConnectionError):
        await update_progress.read_health("g1", {})


# ── the projector's passes ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("from_seq, status, served, published, phase", [
    (3, "projecting", 3, True, "updating"),          # a window into the copy readers read
    (0, "rehydrating", None, True, "loading"),       # an unloaded graph loaded back
    (0, "rehydrating", None, False, "seeding"),      # a first seed, admitted as a load is
    (0, "rebuilding", None, False, "seeding"),       # a first seed, residency off
    (0, "rebuilding", 5, True, "updating"),          # a rebuild in place of a copy that serves
    (0, "rebuilding", None, True, "seeding"),        # a lost copy written from nothing
])
def test_each_pass_names_its_phase(from_seq, status, served, published, phase):
    assert projection._phase_of(from_seq, status, served, published) == phase


def _run(proj, redis):
    async def go():
        result = await proj.project_graph("g1")
        await settled()
        return result
    return asyncio.run(go())


def test_a_window_counts_its_changes_as_they_land_and_publishes_as_the_last_update(monkeypatch,
                                                                                   redis):
    proj, _ps, _client, _seen = _projector(monkeypatch, ps=_PS(projected=3, target=3))
    applied = []

    async def compute(s, graph, main_id, from_seq, to_seq):
        return ([("n1", "u1", {}), ("n2", "u2", {}), ("n3", "u3", {})],
                [("e1", "u1", "u2", {}, "A", "B")], [("u9", "A")], [])

    async def apply(client, nu, eu, nd, ed, progress=None, **_kw):
        for part in (nu, eu, nd, ed):
            if part:
                await progress(len(part))
        applied.append(projection._PASS_UPDATE.get().total)

    monkeypatch.setattr(proj, "_compute_changes", compute)
    monkeypatch.setattr(proj, "_apply", apply)
    assert _run(proj, redis)["projected"] == 5
    assert applied == [5], "the window's five changes are its total"
    last = redis.hashes[update_progress.LAST_KEY + "g1"]
    assert (last["seq"], last["phase"], last["rows"]) == ("5", "updating", "5")
    assert update_progress.KEY + "g1" not in redis.hashes


@pytest.mark.parametrize("ending", ["held_back", "failed", "superseded"])
def test_a_pass_that_does_not_publish_leaves_no_last_update_and_no_snapshot(monkeypatch, redis,
                                                                            ending):
    proj, _ps, _client, _seen = _projector(
        monkeypatch, ps=_PS(projected=3, target=3),
        verify_error="count mismatch" if ending == "held_back" else None,
        finish=ending != "superseded")
    redis.hashes[update_progress.KEY + "g1"] = {"phase": "updating"}      # an earlier pass's
    if ending == "failed":
        async def boom(*a, **k):
            raise RuntimeError("the graph store went away")
        monkeypatch.setattr(proj, "_apply", boom)
        with pytest.raises(RuntimeError):
            _run(proj, redis)
    else:
        _run(proj, redis)
    assert update_progress.LAST_KEY + "g1" not in redis.hashes
    assert update_progress.KEY + "g1" not in redis.hashes


def test_a_pass_that_stops_at_a_page_keeps_its_snapshot_for_the_next(monkeypatch, redis):
    ps = _PS(projected=0, target=5)
    ps.status = "rebuilding"
    proj, _ps, _client, _seen = _projector(monkeypatch, ps=ps)

    async def reconcile(client, graph_id, main_id, to_seq, level_map, **kw):
        progress = proj._progress_writer(graph_id, 10)
        await progress(4)
        raise projection._PassPartial(4)

    monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
    assert _run(proj, redis)["partial"] is True
    snap = redis.hashes[update_progress.KEY + "g1"]
    assert (snap["phase"], snap["done"], snap["total"], snap["targetSeq"]) == (
        "seeding", "4", "10", "5")
    assert update_progress.LAST_KEY + "g1" not in redis.hashes


def test_a_resumed_pass_carries_on_the_rows_start_and_rate_its_cursor_kept(monkeypatch, redis):
    """A paged window's progress is its version rows (each page says how many it held), and a
    pass that resumes it from its cursor counts on from what the passes before it counted, with
    their start and rate; every page's cursor carries them on."""
    proj, _ps, client, _seen = _projector(monkeypatch)

    async def window_rows(*a):
        return 300

    async def window_pages(s, graph, main_id, from_seq, to_seq, kind, after=""):
        yield ([("n1", "u1", {})], [], [], []), f"{kind}_v1", 50     # 50 version rows a page

    async def go():
        update = update_progress.Update("g1", "updating", 5)
        projection._PASS_UPDATE.set(update)
        cursor = projection._Cursor(client, 3, 5, ("node", "v0"), None,
                                    carried=(100, T0 - 600, 80.0))
        await proj._apply_paged(client, "g1", "main1", 3, 5, level_map={}, provider_id=None,
                                owned=True, cursor=cursor)
        return update

    monkeypatch.setattr(proj, "_window_rows", window_rows)
    monkeypatch.setattr(proj, "_window_pages", window_pages)
    update = asyncio.run(go())
    # Its two pages' version rows on top of the 100 earlier passes wrote, of the window's 300.
    assert (update.done, update.total, update.started_at, update.rate) == (200, 300, T0 - 600, 80.0)
    writes = [p for c, p in client.queries if c == projection._CURSOR_WRITE]
    assert [(p["done"], p["startedAt"], p["rate"]) for p in writes] == [
        (150, T0 - 600, 80.0), (200, T0 - 600, 80.0)]


def test_a_cursor_reads_back_what_it_carried():
    found = [[3, 5, "edge", "v9", True, 2, 150, T0, 80.5]]

    async def query(cypher, params=None, **k):
        return SimpleNamespace(result_set=found)

    client = SimpleNamespace(ro_query=query, query=query)
    assert asyncio.run(projection._read_cursor(client)) == (3, 5, "edge", "v9", True, 2, 150,
                                                            T0, 80.5)
    found = [[3, 5, "edge", "v9", True, 2, None, None, None]]   # one an older release wrote
    assert asyncio.run(projection._read_cursor(client))[6:] == (0, None, None)


def test_a_build_reports_building_switching_and_its_switch_as_the_last_update(monkeypatch, redis,
                                                                             clock):
    """A build step's update: building (a copy or a seed), switching (the catch-up and the
    switch); one that goes on in the next pass holds its snapshot; the switch records the last
    update, timed from when the build was asked for, with no rows; one that waits leaves none."""
    proj, ps, _client, _seen = _projector(monkeypatch, ps=_PS(projected=5, target=5))
    ps.candidate_state = {"id": "build_1", "step": "copying", "reason": "window",
                          "since": iso(T0 - 300), "attempts": 0}
    ps.candidate_seq, ps.read_mode = None, "beside"

    async def policy():
        return {"buildMaxAttempts": 3, "buildConcurrency": 2}

    monkeypatch.setattr(projection.build_policy, "resolve", policy)
    monkeypatch.setattr(projection.build_policy, "read_mode_for",
                        lambda **k: SimpleNamespace(effective="beside", declared="beside"))
    steps = {}

    async def copying(graph_id, ps_, graph, state, policy_, noop):
        update = projection._PASS_UPDATE.get()
        steps["copying"] = (update.phase, update.total, update.target_seq)
        update.hold()                                  # as _build_copy does once copied
        return {**noop, "noop": False}

    async def catching_up(graph_id, ps_, graph, state, policy_, noop):
        update = projection._PASS_UPDATE.get()
        update.count(40)
        await update.add(40)
        steps["catching_up"] = (update.phase, update.done, update.total)
        update.target_seq = 5
        update.finish(published=True, counted=False)   # as _build_switch does once switched
        return {"projected": 5, "applied": 0, "noop": False, "switched": True}

    async def waiting(*a):
        return {"projected": 5, "applied": 0, "noop": True, "skipped": "build_waiting"}

    monkeypatch.setattr(proj, "_build_queued", copying)
    monkeypatch.setattr(proj, "_build_catch_up", catching_up)
    _run(proj, redis)
    assert steps["copying"] == ("building", None, 5)
    assert redis.hashes[update_progress.KEY + "g1"]["phase"] == "building"   # held for the next

    ps.candidate_state = {**ps.candidate_state, "step": "catching_up"}
    _run(proj, redis)
    assert steps["catching_up"] == ("switching", 40, 40)
    assert update_progress.KEY + "g1" not in redis.hashes
    last = redis.hashes[update_progress.LAST_KEY + "g1"]
    assert (last["seq"], last["phase"], last["durationSecs"]) == ("5", "switching", "300")
    assert "rows" not in last and "ratePerSec" not in last

    redis.hashes[update_progress.KEY + "g1"] = {"phase": "building"}
    ps.candidate_state = {**ps.candidate_state, "step": "queued"}
    monkeypatch.setattr(proj, "_build_queued", waiting)
    _run(proj, redis)
    assert update_progress.KEY + "g1" not in redis.hashes, "a build that waits shows no progress"
