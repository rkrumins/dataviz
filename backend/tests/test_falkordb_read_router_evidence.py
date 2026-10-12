"""What the read router is allowed to treat as evidence.

The router sends a read to a replica only when it can point at a reason: the
provider allows it, the replica is inside the lag threshold, nobody has just
written the graph, the replica has not just failed. Each of those was being
decided on evidence that did not hold up under the deployed load:

* **read-your-own-writes was per process.** The settle window lives in a
  dict on one worker, and the fleet is a dozen of them — so eleven read-backs
  in twelve carried no pin at all, went to a replica, and had whatever they
  found written into the response cache for an hour under the generation the
  write had just bumped.
* **a busy master was called silent.** One ``INFO replication`` over a 1.0 s
  deadline meant "this node is gone", which bypassed the settle window for
  the very process that had written and froze the shard's lag verdict — the
  stale set was re-stamped on every miss, so it had no maximum age at all.
  A process that had never sampled admitted every replica the client listed.
* **the master was never a read candidate.** On one replica per shard that
  put 100% of reads on the single node also applying the write stream, with
  the master's query threads idle.
* **a client meeting a failover was told to come back before the cluster
  could have promoted anything**, and before the memo that exists to absorb
  that retry had expired.
"""
from __future__ import annotations

import asyncio
import time
import types

import pytest

from backend.app.providers import falkordb_provider as fp
from backend.app.providers.falkordb_provider import FalkorDBProvider
from test_falkordb_replica_reads import (            # noqa: E402 — shared doubles
    MASTER as fp_MASTER, R1, R2, _Conn, _deaf_master, _provider,
)


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _clean_process_state():
    """Both of these are deliberately process-wide — clear them so one test's
    evidence is never another's."""
    fp.set_fleet_write_stamps(None, None)
    fp._deadline_streaks.clear()
    yield
    fp.set_fleet_write_stamps(None, None)
    fp._deadline_streaks.clear()


# ── read-your-own-writes, fleet-wide ─────────────────────────────────────


def _fleet(stamped=()):
    """The counterpart the coordination layer injects, as a dict."""
    keys = set(stamped)

    async def note(graph_key):
        keys.add(graph_key)

    async def recent(graph_key):
        return graph_key in keys

    return keys, note, recent


def test_a_write_on_another_pod_pins_this_pods_reads_too():
    keys, note, recent = _fleet(stamped={"g1"})
    fp.set_fleet_write_stamps(note, recent)
    p = _provider(_Conn())
    assert _run(p._replica_for("g1")) is None          # not this process's write
    assert not p._in_settle_window("g1")               # …and it has no local pin

    keys.discard("g1")
    fp._fleet_stamp_cache.clear()
    assert _run(p._replica_for("g1")) is not None      # window over, fleet-wide


def test_a_write_here_is_stamped_for_the_whole_fleet():
    keys, note, recent = _fleet()
    fp.set_fleet_write_stamps(note, recent)
    p = _provider(_Conn())

    async def _write_then_read():
        p._note_local_write("g1")
        await asyncio.sleep(0)                         # let the stamp task run
        return keys

    assert "g1" in _run(_write_then_read())


def test_only_the_graph_that_was_written_is_pinned():
    _keys, note, recent = _fleet(stamped={"g1_proj"})
    fp.set_fleet_write_stamps(note, recent)
    p = _provider(_Conn())
    assert _run(p._replica_for("g1_proj")) is None
    assert _run(p._replica_for("g1")) is not None


def test_no_bus_and_a_broken_bus_both_leave_todays_behaviour():
    """Fail-open, in the same direction as the per-process window it
    extends: a coordination bus that is missing or unwell must never be the
    reason a canvas stops routing."""
    p = _provider(_Conn())
    assert _run(p._replica_for("g1")) is not None      # hooks unset

    async def _broken(_graph_key):
        raise RuntimeError("no bus")

    fp.set_fleet_write_stamps(None, _broken)
    assert _run(p._replica_for("g1")) is not None


def test_the_stamp_is_read_at_most_once_in_a_while_not_once_per_query():
    reads = []

    async def recent(graph_key):
        reads.append(graph_key)
        return False

    fp.set_fleet_write_stamps(None, recent)
    p = _provider(_Conn())
    for _ in range(20):
        _run(p._replica_for("g1"))
    assert len(reads) == 1
    assert fp._FLEET_WRITE_SAMPLE_S < fp._REPLICA_READ_SETTLE_S


# ── a busy master is not a dead one ──────────────────────────────────────


def _slow_master(conn):
    """A master that takes the connection and answers nothing inside the
    sample deadline — the routine shape under load, not a death."""
    async def _hang(command, *args, target_nodes=None):
        conn.calls.append((command, args, target_nodes))
        if command == "INFO":
            raise asyncio.TimeoutError()
        return "OK"

    conn.execute_command = _hang
    return conn


def test_a_missed_sample_deadline_does_not_make_the_master_silent():
    conn = _slow_master(_Conn())
    p = _provider(conn)
    assert _run(p._replica_for("g1")) is None          # master-only, no evidence
    assert not p._master_is_silent("g1")


def test_a_process_that_has_never_had_an_answer_reads_from_the_master():
    """``set(endpoints)`` admitted every replica the client happened to list
    on no freshness evidence whatsoever."""
    p = _provider(_slow_master(_Conn()))
    for _ in range(3):
        assert _run(p._replica_for("g1")) is None
        p._repl_sample.clear()


def test_a_slow_master_still_keeps_its_own_writes_visible():
    """``_master_is_silent`` bypasses the settle window, so calling a busy
    master silent cost read-your-own-writes to the process that wrote."""
    p = _provider(_slow_master(_Conn()))
    p._note_local_write("g1")
    assert _run(p._replica_for("g1")) is None


def test_a_refused_master_is_still_silent_and_its_replicas_still_answer():
    """The narrowing: a node that is not there is exactly when the replicas
    are the only copies of the graph left standing."""
    p = _provider(_deaf_master(_Conn()))
    assert _run(p._replica_for("g1")) in (R1, R2)
    assert p._master_is_silent("g1")


def test_the_sample_deadline_is_above_a_busy_masters_realistic_p99():
    assert fp._REPLICA_SAMPLE_TIMEOUT_S >= 2.0


# ── the vouched set has a maximum age ────────────────────────────────────


def test_a_stale_vouched_set_expires_instead_of_being_re_stamped():
    """Every failed sample used to re-stamp it with ``now``, so one master
    that stayed unreachable froze its shard's lag verdict indefinitely."""
    conn = _Conn()
    p = _provider(conn)
    assert _run(p._replica_for("g1")) in (R1, R2)       # a real reading, vouched

    _deaf_master(conn)
    # The reading is now older than the router will trust.
    p._repl_vouched_at["g1"] = time.monotonic() - fp._REPLICA_VOUCH_MAX_AGE_S - 1
    p._repl_sample["g1"] = (time.monotonic() - fp._REPLICA_SAMPLE_S - 1,
                            p._repl_sample["g1"][1])
    assert _run(p._replica_for("g1")) is None           # back to the master

    # …and it stays there: a re-stamp would have kept the replicas alive.
    p._repl_sample["g1"] = (time.monotonic() - fp._REPLICA_SAMPLE_S - 1,
                            p._repl_sample["g1"][1])
    assert _run(p._replica_for("g1")) is None


def test_a_reading_inside_the_maximum_age_still_stands():
    conn = _Conn()
    p = _provider(conn)
    assert _run(p._replica_for("g1")) in (R1, R2)
    _deaf_master(conn)
    p._repl_sample["g1"] = (time.monotonic() - fp._REPLICA_SAMPLE_S - 1,
                            p._repl_sample["g1"][1])
    assert _run(p._replica_for("g1")) in (R1, R2)


def test_the_maximum_age_is_a_few_sample_windows_not_forever():
    assert fp._REPLICA_VOUCH_MAX_AGE_S == 3 * fp._REPLICA_SAMPLE_S


def test_a_sample_the_master_missed_does_not_renew_the_vouch():
    """The re-stamp IS the defect. A master that stops answering has to let
    its last real reading age out, not refresh it by failing to answer."""
    conn = _Conn()
    p = _provider(conn)
    assert _run(p._replica_for("g1")) in (R1, R2)
    first = p._repl_vouched_at["g1"]

    _slow_master(conn)
    p._repl_sample["g1"] = (time.monotonic() - fp._REPLICA_SAMPLE_S - 1,
                            p._repl_sample["g1"][1])
    _run(p._replica_for("g1"))
    assert p._repl_vouched_at["g1"] == first


def test_a_redis_socket_timeout_is_a_busy_master_too():
    """``asyncio.TimeoutError`` is OUR deadline; redis raises its own class
    of the same name when the socket stalls. Both mean the node TOOK the
    connection, so matching only the first would have gone on calling half
    the busy masters dead."""
    from redis.exceptions import TimeoutError as _RedisTimeout

    conn = _Conn()

    async def _stall(command, *args, target_nodes=None):
        conn.calls.append((command, args, target_nodes))
        if command == "INFO":
            raise _RedisTimeout("Timeout reading from socket")
        return "OK"

    conn.execute_command = _stall
    p = _provider(conn)
    assert _run(p._replica_for("g1")) is None
    assert not p._master_is_silent("g1")


def test_a_master_that_is_replaying_is_still_not_a_node_to_read_from():
    """LOADING is the one non-answer that IS silence: the node is there and
    talking, and every data command it takes comes back ``-LOADING``."""
    conn = _Conn()

    async def _loading(command, *args, target_nodes=None):
        conn.calls.append((command, args, target_nodes))
        if command != "INFO":
            return "OK"
        if target_nodes is not None and target_nodes is not fp_MASTER:
            report = conn._self_report(target_nodes)
            if report.get("role") == "slave":
                report["master_link_status"] = "down"
            return report
        return {"role": "master", "loading": 1, "master_repl_offset": 100}

    conn.execute_command = _loading
    p = _provider(conn)
    assert _run(p._replica_for("g1")) in (R1, R2)
    assert p._master_is_silent("g1")


def test_one_node_that_ignores_its_deadline_cannot_stall_a_read(monkeypatch):
    """Every probe carries its own deadline, but a client that does not
    honour cancellation would still hold the gather — and the router runs in
    FRONT of the read's budget, not inside it. The sample is bounded as a
    WHOLE so routing can never cost a read more than one window."""
    monkeypatch.setattr(fp, "_REPLICA_ASK_TIMEOUT_S", 30.0)
    monkeypatch.setattr(fp, "_REPLICA_SAMPLE_TIMEOUT_S", 0.2)

    conn = _Conn()

    async def _never(command, *args, target_nodes=None):
        if command == "INFO":
            await asyncio.sleep(30)
        return "OK"

    conn.execute_command = _never
    p = _provider(conn)

    async def _timed():
        loop = asyncio.get_running_loop()
        start = loop.time()
        node = await p._replica_for("g1")
        return node, loop.time() - start

    node, elapsed = _run(_timed())
    assert node is None                                   # no evidence, master serves
    assert elapsed < 2.0                                  # bounded by the window
    assert not p._master_is_silent("g1")                  # stalled is not gone


# ── the master takes its share of the reads ──────────────────────────────


def test_the_master_joins_the_rotation_for_a_read():
    """On one replica per shard this is a straight doubling of read capacity
    per source, and the only one available on the mandated node pool."""
    conn = _Conn(replicas=(R1,))
    p = _provider(conn)
    served = [_run(p._replica_for("g1", include_master=True)) for _ in range(4)]
    assert served.count(R1) == 2
    assert served.count(None) == 2          # None = the master takes this one


def test_the_share_is_a_knob_and_zero_keeps_every_read_off_the_master(monkeypatch):
    monkeypatch.setattr(fp, "_MASTER_READ_SHARE", 0)
    p = _provider(_Conn(replicas=(R1,)))
    assert [_run(p._replica_for("g1", include_master=True)) for _ in range(4)] == [R1] * 4


def test_asking_only_whether_a_replica_qualifies_never_returns_the_master():
    """The default is off so ``_replica_for`` keeps answering exactly one
    question — is there a usable replica — for the callers that ask it."""
    p = _provider(_Conn(replicas=(R1,)))
    assert [_run(p._replica_for("g1")) for _ in range(4)] == [R1] * 4


def test_a_shard_with_nothing_in_step_does_not_rotate_at_all():
    """The master answers everything; there is no rotation to join."""
    p = _provider(_Conn(replicas=()))
    assert _run(p._replica_for("g1", include_master=True)) is None


def test_the_read_path_asks_for_the_master_to_be_included():
    import inspect

    src = inspect.getsource(FalkorDBProvider._read_query)
    assert "include_master=True" in src


# ── what a client failing over is told ───────────────────────────────────


def test_the_memo_outlasts_the_retry_after_it_advertises():
    """At a 2 s memo and a 3 s Retry-After the compliant client came back
    after the memo had expired and dialled the dead node itself — the memo's
    hit rate against well-behaved clients was exactly zero."""
    assert fp._FAILING_OVER_MEMO_S > fp._FAILOVER_RETRY_AFTER_S


def test_both_are_derived_from_the_deployed_cluster_node_timeout():
    """A cluster cannot begin an election until ``cluster-node-timeout`` has
    passed, so a flat 3 s against the deployed 15 s spends the client's retry
    before there is anything to answer it.

    Read in a fresh interpreter: these are module constants, and reloading
    the provider in-process would hand every other test a second copy of its
    classes."""
    import os
    import subprocess
    import sys

    env = {**os.environ, "FALKORDB_CLUSTER_NODE_TIMEOUT_MS": "15000"}
    out = subprocess.run(
        [sys.executable, "-c",
         "from backend.app.providers import falkordb_provider as fp;"
         "print(fp._FAILOVER_RETRY_AFTER_S, fp._FAILING_OVER_MEMO_S)"],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(fp.__file__)) ) + "/../..",
        env=env, capture_output=True, text=True, check=True,
    ).stdout.split()
    assert (int(out[0]), float(out[1])) == (15, 16.0)
    # …and unset keeps the historical answer rather than inventing one.
    assert fp._FAILOVER_RETRY_AFTER_S == 3 and fp._FAILING_OVER_MEMO_S == 4.0


# ── one wall clock for a call and its retries ────────────────────────────


def _clock_bound(budget, *, read_only):
    async def _measure():
        loop = asyncio.get_running_loop()
        cm = fp._retry_wall_clock(budget, read_only=read_only)
        async with cm:
            return cm.when() - loop.time()

    return _run(_measure())


def test_a_retry_gets_the_backoff_not_a_second_full_budget():
    """``asyncio.wait_for`` is inside the retried callable, so each retry
    drew a fresh full budget: a nominal 5 s read could run 21.75 s holding a
    query-semaphore permit long after the client had gone."""
    read = _clock_bound(5.0, read_only=True)
    assert read == pytest.approx(5.0 + sum(fp._TRANSIENT_RETRY_BACKOFFS), abs=0.2)
    assert read < 4 * 5.0

    # A write keeps the failover window it deliberately waits out…
    write = _clock_bound(15.0, read_only=False)
    assert write == pytest.approx(15.0 + sum(fp._REFUSED_RETRY_BACKOFFS), abs=0.2)
    # …and is still less than half of the 77.5 s it used to be able to run.
    assert write < 35.0


def test_every_query_path_is_under_it():
    import inspect

    for method in (FalkorDBProvider._guarded_timed, FalkorDBProvider._proj_query):
        assert "_retry_wall_clock(" in inspect.getsource(method)


# ── a node that only ever times out ──────────────────────────────────────


def test_a_streak_of_deadline_misses_is_treated_as_a_wedged_node():
    """The graph pools' socket timeout is floored above the longest query the
    app may send, so a black-holed but established socket never raises —
    every call ends in the caller's own deadline, and a deadline is never
    counted. Between the two, nothing could ever declare the node unwell."""
    p = _provider(_Conn())
    p._host, p._port = "10.0.0.1", 6379
    p._conn_cfg = types.SimpleNamespace(mode="cluster", read_from_replicas="auto",
                                        host="10.0.0.1", port=6379)

    verdicts = [p._deadline_streak_verdict(asyncio.TimeoutError())
                for _ in range(fp._DEADLINE_STREAK_LIMIT)]
    assert verdicts[:-1] == [None] * (fp._DEADLINE_STREAK_LIMIT - 1)

    from backend.common.adapters import ProviderFailingOver

    assert isinstance(verdicts[-1], ProviderFailingOver)
    assert verdicts[-1].endpoint == "10.0.0.1:6379"
    assert verdicts[-1].retry_after_seconds == fp._FAILOVER_RETRY_AFTER_S


def test_a_node_that_answers_starts_the_streak_over():
    """Otherwise slow queries spread over an hour would eventually add up to
    a verdict about a node that has been answering all along."""
    p = _provider(_Conn())
    p._host, p._port = "10.0.0.2", 6379
    p._conn_cfg = types.SimpleNamespace(mode="cluster", read_from_replicas="auto",
                                        host="10.0.0.2", port=6379)
    for _ in range(fp._DEADLINE_STREAK_LIMIT - 1):
        assert p._deadline_streak_verdict(asyncio.TimeoutError()) is None
    p._note_endpoint_answered()
    assert p._deadline_streak_verdict(asyncio.TimeoutError()) is None


# ── delete is idempotent under the retry that made it so ─────────────────


def _delete_provider(*, present, deleted_rows):
    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g1"

    async def _connected():
        return None

    async def _ro(cypher, params=None, **kw):
        return types.SimpleNamespace(result_set=[[1 if present else 0]])

    async def _write(cypher, params=None, **kw):
        return types.SimpleNamespace(result_set=[[deleted_rows]])

    p._ensure_connected = _connected
    p._ro_query = _ro
    p._query = _write
    return p


def test_a_delete_its_own_retry_already_applied_is_not_a_404():
    """``_run_guarded`` re-issues a write whose connection dropped. A reset
    arriving after the DELETE applied leaves the retry matching nothing, and
    ``count(r) = 0`` was reported as "no such edge"."""
    assert _run(_delete_provider(present=True, deleted_rows=0).delete_edge("e1")) is True


def test_an_edge_that_never_existed_is_still_a_404():
    assert _run(_delete_provider(present=False, deleted_rows=0).delete_edge("e1")) is False


def test_the_ordinary_delete_is_unchanged():
    assert _run(_delete_provider(present=True, deleted_rows=1).delete_edge("e1")) is True


def test_the_probe_reads_the_master():
    """A replica a moment behind would answer the same 0 the retry did."""
    import inspect

    src = inspect.getsource(FalkorDBProvider.delete_edge)
    assert "read_from_master_only()" in src
