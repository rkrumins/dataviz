"""What the bootstrap worker does when the infrastructure misbehaves.

A 7.7M-entity copy runs for tens of minutes, which is long enough to SPAN ordinary
infrastructure events — a FalkorDB restart, a Postgres failover, a node rotation, a blip.
Getting this wrong is not a corruption bug (the window transaction rules that out), it is a
bug of a subtler kind: a job that is 80% done and dies of a one-second hiccup, or one that is
alive and working and gets declared dead by its own colleague.

Each test here pins a failure that was real before it was written.
"""
import asyncio
import contextlib
import time
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import IntegrityError, OperationalError

from backend.app.services.versioning import config
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapFailure,
    BootstrapRunner,
    _is_transient,
)
from backend.app.services.versioning.job_lease import Draining, Lease, Superseded
from backend.app.services.versioning.purge_worker import PurgeRefused, PurgeRunner


class _Boom(Exception):
    """Stands in for a client error whose only signal is its message text."""


# ── transient vs terminal: the classification the whole design rests on ──────
#
# Backwards in one direction, a blip kills a 40-minute job. Backwards in the other, an
# impossible query is retried for ten minutes instead of being shrunk to fit.

@pytest.mark.parametrize("exc, transient, why", [
    (ConnectionResetError("reset by peer"),      True,  "the pipe broke mid-scan"),
    (asyncio.TimeoutError(),                     True,  "_q's client-side hang net tripped"),
    (OSError("broken pipe"),                     True,  "socket-level fault"),
    (_Boom("LOADING FalkorDB is loading the dataset in memory"), True,
     "FalkorDB is replaying its RDB after a restart — it WILL come back"),
    (_Boom("CLUSTERDOWN the cluster is down"),   True,  "a rotation in progress"),
    (OperationalError("conn", "p", "o"),         True,  "Postgres failed over"),
    (_Boom("Query timed out"),                   False,
     "the server killed OUR query: shrink the window, waiting changes nothing"),
    (IntegrityError("dup key", "p", "o"),        False,
     "a duplicate identifier is a data problem — retrying hits the same wall"),
    (ValueError("bad ontology rule"),            False, "a real bug must surface, not spin"),
])
def test_transient_classification(exc, transient, why):
    assert _is_transient(exc) is transient, why


def test_our_own_control_exceptions_are_never_transient():
    # These drive the phase machine; treating any as "infrastructure" would retry a deliberate
    # abort (superseded), a shutdown (draining) or an integrity failure until the budget ran out.
    assert not _is_transient(Superseded("taken over"))
    assert not _is_transient(Draining("the worker is stopping"))
    assert not _is_transient(BootstrapFailure("counts disagree", "integrity"))


# ── _run_phase: wait out an outage, never wait out a bug ─────────────────────

def _runner(**kw) -> BootstrapRunner:
    return BootstrapRunner(graph_factory=lambda *a, **k: None,
                           session_factory=lambda: None, **kw)


def _lease(epoch: int = 3) -> Lease:
    return Lease(job_id="job_1", job_type="bootstrap", epoch=epoch, workspace_id="ws1",
                 graph_id="graph_1")


async def test_a_blip_is_ridden_out_not_fatal(monkeypatch):
    """The headline: two dropped connections must not destroy a job that is 80% done."""
    r = _runner()
    monkeypatch.setattr(r, "_note_interruption", _noop)
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def flaky(lease, graph_id):
        attempts.append(1)
        if len(attempts) < 3:
            raise ConnectionResetError("reset by peer")
        return True                                   # third attempt lands

    assert await r._run_phase(_lease(), flaky, "graph_1", "edges") is True
    assert len(attempts) == 3, "the worker must reconnect and carry on, not give up"


async def test_each_interruption_is_recorded(monkeypatch):
    """Riding out an outage is something the user is TOLD (the report counts them)."""
    r = _runner()
    seen = []

    async def note(lease, phase, exc):
        seen.append((phase, type(exc).__name__))
    monkeypatch.setattr(r, "_note_interruption", note)
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def flaky(lease, graph_id):
        attempts.append(1)
        if len(attempts) < 3:
            raise ConnectionResetError("reset by peer")
        return True

    await r._run_phase(_lease(), flaky, "graph_1", "edges")
    assert seen == [("edges", "ConnectionResetError")] * 2


async def test_a_real_bug_fails_immediately(monkeypatch):
    r = _runner()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def broken(lease, graph_id):
        attempts.append(1)
        raise ValueError("bad ontology rule")

    with pytest.raises(ValueError):
        await r._run_phase(_lease(), broken, "graph_1", "nodes")
    assert len(attempts) == 1, "a bug must surface at once, not be retried into the budget"


async def test_an_integrity_failure_is_never_retried(monkeypatch):
    r = _runner()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def failing(lease, graph_id):
        attempts.append(1)
        raise BootstrapFailure("the source changed while we copied it", "integrity")

    with pytest.raises(BootstrapFailure):
        await r._run_phase(_lease(), failing, "graph_1", "validate")
    assert len(attempts) == 1


async def test_a_takeover_stops_us_at_once(monkeypatch):
    """Superseded means another worker owns this job. Retrying would double-write."""
    r = _runner()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def taken(lease, graph_id):
        attempts.append(1)
        raise Superseded("another worker took over this job")

    with pytest.raises(Superseded):
        await r._run_phase(_lease(), taken, "graph_1", "nodes")
    assert len(attempts) == 1


async def test_a_lost_lease_stops_the_wait_before_the_next_attempt(monkeypatch):
    """Mid-outage, the LeaseKeeper finds the job is no longer ours: the next attempt must not
    run — a window written now would race the new owner (and roll back at best)."""
    r = _runner()
    lease = _lease()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def note(_lease, _phase, _exc):
        lease.lost.set()                              # the renewal came back without us
    monkeypatch.setattr(r, "_note_interruption", note)

    async def down(_lease, graph_id):
        attempts.append(1)
        raise ConnectionResetError("reset by peer")

    with pytest.raises(Superseded):
        await r._run_phase(lease, down, "graph_1", "nodes")
    assert len(attempts) == 1


async def test_an_endless_outage_gives_up_honestly(monkeypatch):
    """Patience is bounded. Past the budget the job fails — and stays resumable."""
    monkeypatch.setattr(config, "BOOTSTRAP_RETRY_BUDGET_SECS", 5)
    r = _runner()
    monkeypatch.setattr(r, "_note_interruption", _noop)
    clock = {"t": 0.0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["t"])

    async def sleep(d):                               # virtual time: no real waiting
        clock["t"] += d
    monkeypatch.setattr(asyncio, "sleep", sleep)
    attempts = []

    async def down(lease, graph_id):
        attempts.append(1)
        raise ConnectionResetError("the graph service is gone")

    with pytest.raises(ConnectionResetError):
        await r._run_phase(_lease(), down, "graph_1", "nodes")
    assert 1 < len(attempts) < 10, "it must retry, and it must stop retrying"


async def test_backoff_grows_and_is_capped(monkeypatch):
    monkeypatch.setattr(config, "BOOTSTRAP_RETRY_BUDGET_SECS", 3600)
    monkeypatch.setattr(config, "BOOTSTRAP_RETRY_MAX_DELAY_SECS", 8)
    r = _runner()
    monkeypatch.setattr(r, "_note_interruption", _noop)
    waits, clock = [], {"t": 0.0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["t"])

    async def sleep(d):
        waits.append(d)
        clock["t"] += d
    monkeypatch.setattr(asyncio, "sleep", sleep)
    attempts = []

    async def flaky(lease, graph_id):
        attempts.append(1)
        if len(attempts) <= 6:
            raise ConnectionResetError("down")
        return True

    await r._run_phase(_lease(), flaky, "graph_1", "nodes")
    assert waits == [1, 2, 4, 8, 8, 8], (
        "backoff must ease off a struggling server, but never wait longer than the cap")


# ── the scan ladder must not 'fix' a broken pipe by shrinking the window ─────

async def test_the_scan_shrinks_for_an_oversized_query(monkeypatch):
    """A window too fat for the server's budget: halve it. This is what the ladder is FOR."""
    import backend.app.services.versioning.bootstrap_worker as bw
    r = _runner()
    seen = []

    async def q(client, cypher, params=None, *, timeout_ms=0, read_only=False):
        seen.append(params["hi"] - params["lo"])
        if seen[-1] > 25_000:
            raise _Boom("Query timed out")
        return type("R", (), {"result_set": [("urn:a", "N", {})]})()

    monkeypatch.setattr(bw, "_q", q)
    _rows, width = await r._scan(object(), "nodes", 0, 100_000)
    assert width == 25_000 and seen == [100_000, 50_000, 25_000]


async def test_the_scan_does_not_shrink_for_a_broken_pipe(monkeypatch):
    """The regression. A dropped connection used to walk the ladder down to its floor and
    then fail the job — four wasted queries and a dead copy, for a fault that shrinking
    cannot touch. No window is small enough to travel down a dead socket, so it must be
    re-raised at once for `_run_phase` to wait out."""
    import backend.app.services.versioning.bootstrap_worker as bw
    r = _runner()
    seen = []

    async def q(client, cypher, params=None, *, timeout_ms=0, read_only=False):
        seen.append(params["hi"] - params["lo"])
        raise ConnectionResetError("reset by peer")

    monkeypatch.setattr(bw, "_q", q)
    with pytest.raises(ConnectionResetError):
        await r._scan(object(), "nodes", 0, 100_000)
    assert seen == [100_000], "a broken pipe must be raised at full width, not laddered down"


async def test_the_scan_DOES_shrink_for_a_socket_timeout(monkeypatch):
    """A timeout is ambiguous, and the ambiguity matters.

    Observed live: a window sized for a healthy FalkorDB stopped coming back at all once that
    FalkorDB was near its memory ceiling — surfacing as a socket read timeout, not a
    server-side "query too expensive". Classified purely as "transient", the job waits out a
    condition that only shrinking fixes, and waits forever. So a timeout shrinks first; if it
    still times out at the floor, THEN it is raised and waited out. Both, cheapest first.
    """
    import backend.app.services.versioning.bootstrap_worker as bw
    r = _runner()
    seen = []

    async def q(client, cypher, params=None, *, timeout_ms=0, read_only=False):
        seen.append(params["hi"] - params["lo"])
        if seen[-1] > 25_000:
            raise TimeoutError("Timeout reading from falkordb:6379")   # a SOCKET timeout
        return type("R", (), {"result_set": []})()

    monkeypatch.setattr(bw, "_q", q)
    _rows, width = await r._scan(object(), "nodes", 0, 100_000)
    assert seen == [100_000, 50_000, 25_000] and width == 25_000, (
        "a timeout must try a smaller window before concluding the server is down")


async def test_a_timeout_at_the_floor_is_finally_waited_out(monkeypatch):
    """Shrunk as far as it can go and STILL timing out — now it really is the server."""
    import backend.app.services.versioning.bootstrap_worker as bw
    r = _runner()
    seen = []

    async def q(client, cypher, params=None, *, timeout_ms=0, read_only=False):
        seen.append(params["hi"] - params["lo"])
        raise TimeoutError("Timeout reading from falkordb:6379")

    monkeypatch.setattr(bw, "_q", q)
    with pytest.raises(TimeoutError):
        await r._scan(object(), "nodes", 0, 40_000)
    assert seen[-1] == config.BOOTSTRAP_SCAN_MIN_WIDTH, "it must reach the floor before giving up"
    assert _is_transient(TimeoutError("Timeout reading")), "and then be waited out, not fatal"


# ── liveness: a working worker must never look dead to its colleagues ────────

def test_the_heartbeat_beats_well_inside_the_stale_window():
    """The livelock guard, as arithmetic.

    `claim_one` takes over any `running` job whose heartbeat is older than INGEST_STALE_SECS.
    Before the heartbeat had a timer, the only one was a window COMMIT — so a scan halving down
    its ladder, or a validate anti-joining a 10M-row commit, went quiet for minutes while
    working perfectly, and a second worker declared it dead. Fencing kept the data safe, but
    the loser re-claimed in turn and two healthy workers traded the same window forever. The
    LeaseKeeper thread renews every INGEST_HEARTBEAT_SECS, whatever the event loop is doing.
    """
    assert config.INGEST_HEARTBEAT_SECS * 3 <= config.INGEST_STALE_SECS, (
        "a worker must be able to miss two beats and still not be presumed dead")


# ── run_job: the slot-loop protocol ──────────────────────────────────────────
#
# run_job never raises: it ends the job (finish/fail), hands it back (release), or — when the
# job is no longer its own — stops without writing anything at all.

def _job(**kw):
    return SimpleNamespace(**{
        "id": "job_1", "status": "running", "retry_count": 3, "current_phase": "nodes",
        "last_cursor": "nodes:4", "graph_id": "graph_1", "summary": {}, "batch_size": 7,
        "data_source_id": "ds1", "workspace_id": "ws1", "processed": 4, "total": 9, **kw})


def _sessions(job):
    class _S:
        async def get(self, _model, _id):
            return job

    @contextlib.asynccontextmanager
    async def factory():
        yield _S()
    return factory


def _recording_lease(*, landed: bool = True, checkpoint_raises=None) -> Lease:
    """A real lease (check(), retry_transient) whose writes are recorded, not executed."""
    lease = _lease()
    lease.calls = []

    async def fail(message, code="internal", action=None, phase=None):
        lease.calls.append(("fail", code, action))
        return landed

    async def release():
        lease.calls.append(("release",))
        return landed

    async def finish(status="completed", **values):
        lease.calls.append(("finish", status))
        return landed

    async def checkpoint(_s, **values):
        lease.calls.append(("checkpoint", values))
        if checkpoint_raises is not None:
            raise checkpoint_raises

    lease.fail, lease.release, lease.finish, lease.checkpoint = fail, release, finish, checkpoint
    return lease


def _driven(job, **phases) -> BootstrapRunner:
    r = BootstrapRunner(graph_factory=lambda *a, **k: None, session_factory=_sessions(job))
    for name, fn in phases.items():
        setattr(r, f"_phase_{name}", fn)
    return r


async def test_a_job_no_longer_ours_stops_without_writing():
    """Taken over (a newer epoch) or abandoned: not a failure, and not ours to record."""
    lease = _recording_lease()
    for job in (_job(retry_count=4), _job(status="cancelled")):
        out = await _driven(job).run_job(lease)
        assert out["status"] == "superseded"
    assert lease.calls == [], "a superseded worker must not touch the job row"


async def test_a_stopping_worker_hands_the_job_back():
    lease = _recording_lease()
    lease.drain.set()
    out = await _driven(_job()).run_job(lease)
    assert out["status"] == "released" and lease.calls == [("release",)]


async def test_a_cancelled_job_task_releases_and_still_dies():
    """Past the drain deadline the slot loop cancels the task: the job is handed back (under a
    shield) and the cancellation is NOT swallowed."""
    lease = _recording_lease()

    async def stuck(_lease, _graph_id):
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await _driven(_job(), nodes=stuck).run_job(lease)
    assert lease.calls == [("release",)]


@pytest.mark.parametrize("exc, code, action", [
    (BootstrapFailure("the source changed while we copied it", "integrity"),
     "integrity", "restart"),
    (ValueError("a bug"), "infrastructure", "resume"),
    (BootstrapFailure("the import commit is missing", "internal"), "internal", None),
])
async def test_a_failure_is_recorded_with_what_the_user_can_do(exc, code, action):
    """``summary.failure.action`` is what the UI offers: an integrity failure needs a fresh read
    (resuming would fail the same check), an infrastructure one resumes, an internal one is a
    bug no button fixes."""
    lease = _recording_lease()

    async def boom(_lease, _graph_id):
        raise exc

    out = await _driven(_job(), nodes=boom).run_job(lease)
    assert out["status"] == "failed" and lease.calls == [("fail", code, action)]


async def test_a_phase_advance_is_a_compare_and_set():
    """The advance re-checks, in its own transaction, that the job is still ours AND still at
    the cursor the finished phase ended on — then starts the next phase from scratch."""
    job = _job()
    lease = _recording_lease()

    async def done(_lease, _graph_id):
        return True

    async def stop(_lease, _graph_id):
        raise BootstrapFailure("stop here", "internal")

    await _driven(job, nodes=done, edges=stop).run_job(lease)
    assert lease.calls[0] == ("checkpoint", {"expect_cursor": "nodes:4"})
    assert (job.current_phase, job.last_cursor, job.batch_size) == (
        "edges", None, config.BOOTSTRAP_SCAN_WIDTH)


async def test_an_advance_by_a_worker_that_lost_the_job_is_not_made():
    job = _job()
    lease = _recording_lease(checkpoint_raises=Superseded("moved on"))

    async def done(_lease, _graph_id):
        return True

    out = await _driven(job, nodes=done).run_job(lease)
    assert out["status"] == "superseded"
    assert (job.current_phase, job.last_cursor) == ("nodes", "nodes:4"), "nothing may move"


async def test_finishing_a_job_that_is_no_longer_ours_is_not_a_completion():
    lease = _recording_lease(landed=False)

    async def done(_lease, _graph_id):
        return True

    out = await _driven(_job(current_phase="finalize"), finalize=done).run_job(lease)
    assert out["status"] == "superseded" and lease.calls == [("finish", "completed")]


# ── the purge shares the lane, and the same outages ──────────────────────────
#
# Nothing retries a failed purge but a person asking again, and until it finishes the data
# source can't be enabled again — so one dropped connection must not fail it either.

def _purging(job, run_phase) -> PurgeRunner:
    r = PurgeRunner(session_factory=_sessions(job))
    r._run_phase = run_phase
    return r


async def test_a_purge_rides_out_a_blip(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    lease = _recording_lease()
    attempts = []

    async def flaky(_phase, _lease, _graph_id):
        attempts.append(1)
        if len(attempts) < 3:
            raise OperationalError("DELETE", {}, ConnectionResetError("reset by peer"))
        return True                                   # the window lands on the third try

    out = await _purging(_job(current_phase="finalize"), flaky).run_job(lease)
    assert out["status"] == "completed" and len(attempts) == 3
    assert lease.calls == [("finish", "completed")]


async def test_a_purge_refusal_is_never_retried(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    lease = _recording_lease()
    attempts = []

    async def refused(_phase, _lease, _graph_id):
        attempts.append(1)
        raise PurgeRefused("this graph is still live", "graph_not_deleted")

    out = await _purging(_job(current_phase="count"), refused).run_job(lease)
    assert out["status"] == "failed" and len(attempts) == 1
    assert lease.calls == [("fail", "graph_not_deleted", None)]


async def _noop(*a, **k):
    return None


async def _noop_sleep(_d):
    return None
