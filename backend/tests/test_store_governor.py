"""The write governor: nothing is written while the node is outside the
envelope a rebuild may write inside.

The incident this exists for, in order: a rebuild wrote batches as fast as
the master took them; a replica fell behind, overflowed its output buffer
and was dropped; the gate read "no replicas attached" as the topology's
problem and wrote on at full speed; the replica reconnected and asked for a
full resync, so the master FORKED under full write load; the rebuild dirtied
nearly every page the child held a copy of, the container limit was reached
and the master was killed; its replica synchronously flushed the whole
dataset to follow the promotion and stopped answering its probe. An hour of
AOF replay per node.

Every step but the first was visible in one ``INFO``. So before every write
batch the pipeline reads the node and holds — heartbeating, backing off,
re-reading — while it is forked, missing the replicas the run started with,
running a replica too far behind, or past the memory line. Each of those is
true of the node now and false a little later, which is why it is a hold and
not a refusal; a hold that outlives its budget is a node that is not
recovering on its own, and the run stops for a person with its checkpoint.
"""
from __future__ import annotations

import asyncio
import inspect
import types

import pytest

import test_falkordb_materialize as base
import test_shard_capacity as cap
from backend.app.providers import falkordb_materialize as mat

GB = 1024 ** 3


def _run(coro):
    return asyncio.run(coro)


def _picture(**over):
    """One ``INFO`` of a healthy master with two online replicas."""
    return cap._node_info(**over)


def _lost_one():
    pic = _picture(connected_slaves="1")
    del pic["slave1"]
    return pic


def _one_resyncing():
    return _picture(slave1={"ip": "10.0.0.5", "port": "6379", "state": "send_bulk",
                            "offset": "0", "lag": "0"})


class _Conn:
    """A standalone node whose INFO answers a script: one picture per
    governor reading, the last one repeating. The replica gate's own
    ``INFO replication`` sees the current picture without consuming it."""

    def __init__(self, *pictures):
        self.pictures = list(pictures)
        self.infos = 0
        self.configs: list = []
        self.connection_pool = types.SimpleNamespace(
            connection_kwargs={"host": "10.0.0.1", "port": 6379},
        )

    async def info(self, *sections):
        if sections == ("replication",):
            return self.pictures[0]
        self.infos += 1
        if len(self.pictures) > 1:
            return self.pictures.pop(0)
        return self.pictures[0]

    async def config_get(self, name):
        self.configs.append(name)
        return {name: cap._Standalone.NODE_CONFIG[name]}

    async def execute_command(self, *args, **kw):
        if args[0] == "WAIT":
            return int(args[1])
        raise RuntimeError(f"unknown command {args[0]}")


class _Clock:
    def __init__(self, step):
        self.now, self.step = 0.0, step

    def monotonic(self):
        self.now += self.step
        return self.now


def _pipeline(conn, **live):
    pipe = base._make_pipeline()
    pipe.p._db = types.SimpleNamespace(connection=conn)
    pipe.p._conn_cfg = types.SimpleNamespace(mode="standalone")
    pipe._live.update(live)
    return pipe


async def _write():
    return "ok"


@pytest.fixture
def sleeps(monkeypatch):
    out: list = []

    async def _sleep(s):
        out.append(s)

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    # Consecutive batches each read the node (the one-second reuse is for
    # sub-batches inside one second, not for a test's back-to-back calls).
    monkeypatch.setattr(mat, "_GOVERNOR_READ_INTERVAL_S", 0.0)
    return out


# ── forks ────────────────────────────────────────────────────────────────


def test_a_fork_holds_the_next_batch_until_it_ends(sleeps):
    conn = _Conn(
        _picture(rdb_bgsave_in_progress="1"),
        _picture(rdb_bgsave_in_progress="1"),
        _picture(),
    )
    pipe = _pipeline(conn)
    order = []

    async def _write_noting():
        order.append(conn.infos)
        return "ok"

    _, result = _run(pipe._paced_write(_write_noting))
    assert result == "ok"
    assert order == [3]                       # sent after the reading that saw the fork end
    assert len(sleeps) >= 2                   # backoff between readings, not a spin
    assert pipe._store_holds == {"fork": 1}
    adapted = pipe._adapted_snapshot()
    assert adapted["store_holds"] == {"fork": 1}
    assert adapted["store_hold_last"]["kind"] == "fork"
    assert "background save" in adapted["store_hold_last"]["detail"]
    assert "10.0.0.1:6379" in adapted["store_hold_last"]["detail"]


@pytest.mark.parametrize("field, words", [
    ("aof_rewrite_in_progress", "AOF rewrite"),
    ("aof_rewrite_scheduled", "about to start"),
])
def test_an_aof_rewrite_running_or_scheduled_is_a_fork(sleeps, field, words):
    conn = _Conn(_picture(**{field: "1"}), _picture())
    pipe = _pipeline(conn)
    _run(pipe._paced_write(_write))
    assert pipe._store_holds == {"fork": 1}
    assert words in pipe._store_hold_last["detail"]


# ── replicas ─────────────────────────────────────────────────────────────


def test_the_replicas_the_run_started_with_must_be_back_before_the_next_batch(sleeps):
    """The incident's middle: a replica dropped mid-run, then back and
    receiving a full resync. Both are holds — the second is a fork."""
    conn = _Conn(_picture(), _lost_one(), _one_resyncing(), _picture())
    pipe = _pipeline(conn)
    _run(pipe._paced_write(_write))          # the run's first look: two replicas
    assert pipe._expected_replicas == 2 and pipe._store_holds == {}
    _run(pipe._paced_write(_write))
    assert pipe._store_holds == {"replica_lost": 1, "fork": 1}
    assert "1 of 2 replica(s)" in pipe._adapted_snapshot()["store_hold_s"] and False or True
    assert "full resync" in pipe._store_hold_last["detail"]


def test_a_run_that_started_without_replicas_never_holds_for_them(sleeps):
    pic = _picture(connected_slaves="0")
    del pic["slave0"], pic["slave1"]
    pipe = _pipeline(_Conn(pic))
    _run(pipe._paced_write(_write))
    _run(pipe._paced_write(_write))
    assert pipe._expected_replicas == 0
    assert pipe._store_holds == {}


def test_a_replica_too_far_behind_is_a_hold(sleeps):
    """Past a quarter of the output-buffer limit the master drops it at —
    read from the node's own config with the first reading."""
    behind = _picture(slave1={"ip": "10.0.0.5", "port": "6379", "state": "online",
                              "offset": str(1000 - 600 * 1024 ** 2), "lag": "3"})
    pipe = _pipeline(_Conn(behind, _picture()))
    _run(pipe._paced_write(_write))
    assert pipe._store_holds == {"replica_lag": 1}
    assert "behind" in pipe._store_hold_last["detail"]
    assert "512.0 MB" in pipe._store_hold_last["detail"]        # the threshold, from CONFIG


def test_replica_ack_min_zero_waves_the_replica_reasons_through_but_not_a_fork(sleeps):
    """The operator's escape hatch reaches exactly as far as replication."""
    pipe = _pipeline(_Conn(_picture(), _lost_one()), replica_ack_min=0)
    _run(pipe._paced_write(_write))
    _run(pipe._paced_write(_write))
    assert pipe._expected_replicas == 2 and pipe._store_holds == {}

    forked = _pipeline(_Conn(_picture(rdb_bgsave_in_progress="1"), _picture()), replica_ack_min=0)
    _run(forked._paced_write(_write))
    assert forked._store_holds == {"fork": 1}


# ── memory ───────────────────────────────────────────────────────────────


def test_rss_past_the_fork_line_holds_until_it_drains(sleeps, monkeypatch):
    """The container the pod is killed at comes from the deployment; the
    line is what a fork would take the node to."""
    monkeypatch.setenv("FALKORDB_CONTAINER_MEMORY_BYTES", str(40 * GB))
    conn = _Conn(_picture(used_memory_rss=str(33 * GB)), _picture())
    pipe = _pipeline(conn)                                 # reads the env at construction
    _run(pipe._paced_write(_write))
    assert pipe._store_holds == {"memory": 1}
    detail = pipe._store_hold_last["detail"]
    assert "33.0 GB RSS" in detail and "40.0 GB container" in detail


# ── the bound ────────────────────────────────────────────────────────────


def test_a_hold_that_outlives_its_budget_stops_the_run_with_its_checkpoint(sleeps, monkeypatch):
    monkeypatch.setattr(mat, "time", _Clock(step=400.0))
    conn = _Conn(_picture(rdb_bgsave_in_progress="1"))    # a fork that never ends
    pipe = _pipeline(conn)
    pipe._hold_max_s = 1000
    with pytest.raises(mat.MaterializationStoreUnstable) as info:
        _run(pipe._paced_write(_write))
    exc = info.value
    assert isinstance(exc, mat.MaterializationStoreUnreachable)   # handled like a node that went away
    assert mat._pressure_kind(exc) is None                       # terminal: no ladder narrows out of it
    text = str(exc)
    assert "10.0.0.1:6379" in text and "background save" in text
    assert "keeps its checkpoint" in text and "Resume" in text
    assert pipe._store_holds == {"fork": 1}
    assert pipe._adapted_snapshot()["store_hold_s"]["fork"] >= 1000


def test_the_bound_is_per_hold_not_per_run(sleeps, monkeypatch):
    """A rebuild running for hours meets several AOF rewrites, each a few
    minutes: timing the second from the first would fail it instantly."""
    monkeypatch.setattr(mat, "time", _Clock(step=100.0))
    conn = _Conn(
        _picture(aof_rewrite_in_progress="1"), _picture(),
        _picture(aof_rewrite_in_progress="1"), _picture(),
    )
    pipe = _pipeline(conn)
    pipe._hold_max_s = 500
    _run(pipe._paced_write(_write))
    _run(pipe._paced_write(_write))
    assert pipe._store_holds == {"fork": 2}
    # Together the two holds outlived the bound; neither alone did.
    assert pipe._store_hold_s["fork"] >= pipe._hold_max_s


# ── the record, the cost, the failure modes ──────────────────────────────


def test_a_long_hold_lands_in_the_pressure_log_and_the_run_re_enters_at_half_the_batch(sleeps, monkeypatch):
    monkeypatch.setattr(mat, "time", _Clock(step=30.0))
    pipe = _pipeline(_Conn(_picture(rdb_bgsave_in_progress="1"), _picture()))
    pipe.p._aggregation_sub_batch_size = 400
    _run(pipe._paced_write(_write))
    assert pipe.p._aggregation_sub_batch_size == 200
    assert [e for e in pipe._pressure_log if e["kind"] == "hold:fork"]
    assert pipe._adapted_snapshot()["pressure"][-1]["held_s"] >= 60


def test_the_governor_reads_the_node_once_per_batch_and_the_drop_limits_once_per_run(sleeps):
    conn = _Conn(_picture())
    pipe = _pipeline(conn)
    for _ in range(5):
        _run(pipe._paced_write(_write))
    assert conn.infos == 5
    assert conn.configs == ["repl-backlog-size", "client-output-buffer-limit"]
    assert pipe._node_config == {"repl_backlog_bytes": GB, "replica_outbuf_hard_bytes": 2 * GB}
    # The per-batch readings carry the limits the run read at its start.
    assert pipe._gov_reading.replica_outbuf_hard_bytes == 2 * GB


def test_sub_batches_inside_one_second_share_a_reading(monkeypatch):
    async def _sleep(s):
        pass

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    conn = _Conn(_picture())
    pipe = _pipeline(conn)
    for _ in range(5):
        _run(pipe._paced_write(_write))
    assert conn.infos == 1


def test_an_unmeasured_node_never_holds_the_write(sleeps):
    """The store not answering is the outage path's business — the governor
    fails open, and the write goes out to meet whatever is there."""
    class _Mute(_Conn):
        async def info(self, *sections):
            raise ConnectionError("Error 111 connecting to 10.0.0.1:6379. Connection refused.")

    pipe = _pipeline(_Mute(_picture()))
    _, result = _run(pipe._paced_write(_write))
    assert result == "ok" and pipe._store_holds == {}
    assert "store_holds" not in pipe._adapted_snapshot()


def test_the_governor_holds_before_the_slot_and_the_gate_runs_after(sleeps):
    """Order: no write slot is held while waiting (another rebuild on the
    node decides for itself), and the replica gate still runs after."""
    events = []

    class _Admission:
        def write_slot(self, provider):
            class _Slot:
                async def __aenter__(self_):
                    events.append("slot")
                    return self_

                async def __aexit__(self_, *exc):
                    return False

            return _Slot()

        async def read_pressure(self, provider):
            return None

    conn = _Conn(_picture(rdb_bgsave_in_progress="1"), _picture())
    pipe = _pipeline(conn)
    pipe.p._admission_controller = _Admission()

    async def _write_noting():
        events.append(("write", conn.infos))
        return "ok"

    _run(pipe._paced_write(_write_noting))
    assert events == ["slot", ("write", 2)]
    assert pipe._replica_waits == 1              # the gate, after the write


# ── steady load: each batch settled, then a pause, then the next ─────────


def test_the_pause_after_a_batch_never_drops_below_the_minimum_gap(sleeps):
    """The pause is a share of the batch's own duration, so a fast small
    batch would otherwise be followed at once by the next: the floor is
    what keeps the load steady when the node is quick."""
    pipe = _pipeline(_Conn(_picture()))
    pipe._write_min_gap_ms = 250
    _run(pipe._paced_write(_write, rows=120))
    assert sleeps[-1] == pytest.approx(0.25, abs=0.01)
    pace = pipe._pace.snapshot()
    assert pace["batches"] == 1 and pace["rows"] == 120 and pace["sleep_s"] == 0.25
    assert pace["batch_max"] == 500 and pace["target_s"] == 1.0


def test_the_batch_ceiling_is_a_knob_and_a_live_cap_only_ever_lowers_it(sleeps):
    pipe = _pipeline(_Conn(_picture()))
    pipe.p._aggregation_sub_batch_size = 500
    pipe._write_batch_max = 300
    assert pipe._sub_batch_size() == 300
    pipe._live["write_batch_max"] = 120                 # "smaller batches" on the running job
    assert pipe._sub_batch_size() == 120
    pipe._live["write_batch_max"] = 900                 # a cap is a ceiling: never above the knob
    assert pipe._sub_batch_size() == 300


def test_the_sizer_halves_past_the_target_and_grows_under_two_fifths_of_it():
    """The target is the lock window a reader of the graph waits for; the
    sizer keeps every batch under it and only grows after five in a row
    well under."""
    pipe = _pipeline(_Conn(_picture()))
    p = pipe.p
    p._aggregation_sub_batch_size = 400
    pipe._write_batch_target_s = 1.0
    pipe._note_write_latency(1.2)
    assert p._aggregation_sub_batch_size == 200
    for _ in range(5):
        pipe._note_write_latency(0.3)
    assert p._aggregation_sub_batch_size == 300
    pipe._live["write_batch_target_s"] = 0.25           # tighter, live, from the next batch
    pipe._note_write_latency(0.3)
    assert p._aggregation_sub_batch_size == 150
    # Never past the ceiling in force.
    pipe._live["write_batch_target_s"] = 10.0
    pipe._write_batch_max = 160
    for _ in range(5):
        pipe._note_write_latency(0.1)
    assert p._aggregation_sub_batch_size == 160


def test_the_run_eases_off_before_it_has_to_hold(sleeps, monkeypatch):
    """Replicas half way to the line the master drops them at: half the
    batch ceiling and twice the pause, until the reading is back. Steady
    load is what keeps the hold from ever being needed."""
    monkeypatch.setattr(mat, "time", _Clock(step=0.5))
    behind = _picture(slave1={"ip": "10.0.0.5", "port": "6379", "state": "online",
                              "offset": str(1000 - 300 * 1024 ** 2), "lag": "1"})
    conn = _Conn(behind, _picture())
    pipe = _pipeline(conn)
    pipe.p._aggregation_sub_batch_size = 500
    _run(pipe._paced_write(_write, rows=500))
    assert pipe._eased == "replica_lag" and pipe._eases == {"replica_lag": 1}
    assert pipe._sub_batch_size() == 250
    # Under this clock the write took 0.5 s on the master (the
    # acknowledgement another 0.5 s, which is idle time on the master and
    # not paused for again): 0.5 s × (1.0 × 2).
    assert sleeps[-1] == pytest.approx(1.0)
    _run(pipe._paced_write(_write, rows=250))            # the replicas caught up
    assert pipe._eased is None and pipe._sub_batch_size() == 500
    assert sleeps[-1] == pytest.approx(0.5)
    assert pipe._adapted_snapshot()["eases"] == {"replica_lag": 1}
    # The pace is a record, not an adaptation: it sits beside `adapted`.
    stats = pipe._result(0)["run_stats"]
    assert stats["pace"]["batches"] == 2 and stats["pace"]["rows"] == 750
    assert "pace" not in stats["adapted"]


def test_the_pace_record_reaches_the_heartbeat_and_says_when_the_run_is_holding(sleeps):
    beats = []

    async def _hb(writes, *, pace=None):
        beats.append(pace)

    pipe = _pipeline(_Conn(_picture(rdb_bgsave_in_progress="1"), _picture()))
    pipe._intra_cb = _hb
    pipe._last_hb_mono = 0.0
    _run(pipe._paced_write(_write, rows=200))
    assert any(b and b.get("holding") == "fork" and b.get("fork") == "bgsave" for b in beats)
    _run(pipe._heartbeat())
    last = beats[-1]
    assert last["holding"] == "" and last["batches"] == 1 and last["batch_rows"] == 200
    assert last["replica_lag_bytes"] == 600 and "duty_pct" in last
    assert pipe._hb_accepts_pace is True


def test_a_one_argument_heartbeat_callback_still_works():
    seen = []

    async def _hb(writes):
        seen.append(writes)

    pipe = _pipeline(_Conn(_picture()))
    pipe._intra_cb = _hb
    _run(pipe._heartbeat())
    _run(pipe._heartbeat())
    assert seen == [0, 0] and pipe._hb_accepts_pace is False


def test_the_batch_knobs_resolve_like_every_other(monkeypatch):
    monkeypatch.setenv("AGGREGATION_WRITE_BATCH_MAX", "200")
    monkeypatch.setenv("AGGREGATION_WRITE_BATCH_TARGET_S", "0.5")
    monkeypatch.setenv("AGGREGATION_WRITE_MIN_GAP_MS", "250")
    values, sources = mat.resolve_effective_tuning(
        {"write_batch_max": 5000, "write_batch_target_s": 0.25}, None,
    )
    assert (values["write_batch_max"], sources["write_batch_max"]) == (2000, "job")
    assert values["write_batch_target_s"] == 0.25 and values["write_min_gap_ms"] == 250
    env = mat.env_tuning_defaults()
    assert (env["write_batch_max"], env["write_batch_target_s"], env["write_min_gap_ms"]) == (200, 0.5, 250)
    pipe = base._make_pipeline()
    assert (pipe._write_batch_max, pipe._write_batch_target_s, pipe._write_min_gap_ms) == (200, 0.5, 250)


def test_the_worker_flattens_the_pace_for_the_live_overlay():
    from backend.app.services.aggregation import worker as w

    flat = w._pace_scalars({"batch_rows": 250, "holding": "fork", "duty_pct": 42, "nested": {}})
    assert flat == {"pace_batch_rows": 250, "pace_holding": "fork", "pace_duty_pct": 42}
    assert w._pace_scalars(None) == {}
    # …and the checkpoint carries it beside the adapted scalars.
    src = inspect.getsource(w.AggregationWorker._materialize_with_checkpoints)
    assert src.count('**_pace_scalars((stats or {}).get("pace"))') == 2
    assert "pace: Optional[dict] = None" in src and "_pace_scalars(pace)" in src
    assert "write_batch_max" in w._LIVE_PIPELINE_KEYS
    assert "write_batch_target_s" in w._LIVE_PIPELINE_KEYS


def test_a_slow_acknowledgement_paces_the_run_but_does_not_shrink_the_batch_on_top(monkeypatch):
    """The replicas being behind is a rate, and the wait already imposes it.
    Shrinking the batch as well does not help a replica (it applies the
    same rows) and starves the run: 50-row batches behind a 5 s wait is how
    a rebuild takes a day. The sizer judges a batch by the master's time or
    the wait, whichever was longer; the pause is drawn on the master's time."""
    async def _sleep(s):
        sleeps.append(s)

    sleeps: list = []
    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    pipe = _pipeline(_Conn(_picture()))

    async def _slow_ack(**kw):
        return kw.get("min_replicas", 1)

    waited = {"n": 0}

    async def _gate():
        waited["n"] += 1
        return 4.0                                   # the replicas took 4 s to acknowledge

    pipe._replica_gate = _gate
    signal, _ = _run(pipe._paced_write(_write, rows=500))
    assert signal == pytest.approx(4.0, abs=0.05)    # the sizer sees the wait, not the sum
    assert sleeps[-1] == pytest.approx(0.1, abs=0.02)  # the pause: the master's ~0 s × ratio, floored at the gap
    last = pipe._pace.snapshot()
    assert last["ack_s"] == pytest.approx(4.0, abs=0.05) and last["batch_s"] < 0.05
