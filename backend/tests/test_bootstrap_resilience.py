"""What the bootstrap worker does when the infrastructure misbehaves.

A 7.7M-entity copy runs for tens of minutes, which is long enough to SPAN ordinary
infrastructure events — a FalkorDB restart, a Postgres failover, a node rotation, a blip.
Getting this wrong is not a corruption bug (the window transaction rules that out), it is a
bug of a subtler kind: a job that is 80% done and dies of a one-second hiccup, or one that is
alive and working and gets declared dead by its own colleague.

Each test here pins a failure that was real before it was written.
"""
import asyncio
import time

import pytest
from sqlalchemy.exc import IntegrityError, OperationalError

from backend.app.services.versioning import config
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapFailure,
    BootstrapRunner,
    BootstrapSuperseded,
    _is_transient,
)


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
    # These two drive the phase machine; treating either as "infrastructure" would retry a
    # deliberate abort (superseded) or an integrity failure until the budget ran out.
    assert not _is_transient(BootstrapSuperseded("taken over"))
    assert not _is_transient(BootstrapFailure("counts disagree", "integrity"))


# ── _run_phase: wait out an outage, never wait out a bug ─────────────────────

def _runner(**kw) -> BootstrapRunner:
    return BootstrapRunner(graph_factory=lambda *a, **k: None,
                           session_factory=lambda: None, **kw)


async def test_a_blip_is_ridden_out_not_fatal(monkeypatch):
    """The headline: two dropped connections must not destroy a job that is 80% done."""
    r = _runner()
    monkeypatch.setattr(r, "_note_interruption", _noop)
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def flaky(job_id, graph_id):
        attempts.append(1)
        if len(attempts) < 3:
            raise ConnectionResetError("reset by peer")
        return True                                   # third attempt lands

    assert await r._run_phase(flaky, "job_1", "graph_1", "edges") is True
    assert len(attempts) == 3, "the worker must reconnect and carry on, not give up"


async def test_a_real_bug_fails_immediately(monkeypatch):
    r = _runner()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def broken(job_id, graph_id):
        attempts.append(1)
        raise ValueError("bad ontology rule")

    with pytest.raises(ValueError):
        await r._run_phase(broken, "job_1", "graph_1", "nodes")
    assert len(attempts) == 1, "a bug must surface at once, not be retried into the budget"


async def test_an_integrity_failure_is_never_retried(monkeypatch):
    r = _runner()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def failing(job_id, graph_id):
        attempts.append(1)
        raise BootstrapFailure("the source changed while we copied it", "integrity")

    with pytest.raises(BootstrapFailure):
        await r._run_phase(failing, "job_1", "graph_1", "validate")
    assert len(attempts) == 1


async def test_a_takeover_stops_us_at_once(monkeypatch):
    """Superseded means another worker owns this job. Retrying would double-write."""
    r = _runner()
    monkeypatch.setattr(asyncio, "sleep", _noop_sleep)
    attempts = []

    async def taken(job_id, graph_id):
        attempts.append(1)
        raise BootstrapSuperseded("another worker took over this job")

    with pytest.raises(BootstrapSuperseded):
        await r._run_phase(taken, "job_1", "graph_1", "nodes")
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

    async def down(job_id, graph_id):
        attempts.append(1)
        raise ConnectionResetError("the graph service is gone")

    with pytest.raises(ConnectionResetError):
        await r._run_phase(down, "job_1", "graph_1", "nodes")
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

    async def flaky(job_id, graph_id):
        attempts.append(1)
        if len(attempts) <= 6:
            raise ConnectionResetError("down")
        return True

    await r._run_phase(flaky, "job_1", "graph_1", "nodes")
    assert waits == [1, 2, 4, 8, 8, 8], (
        "backoff must ease off a struggling server, but never wait longer than the cap")


# ── the scan ladder must not 'fix' a broken pipe by shrinking the window ─────

async def test_the_scan_shrinks_for_an_oversized_query(monkeypatch):
    """A window too fat for the server's budget: halve it. This is what the ladder is FOR."""
    import backend.app.services.versioning.bootstrap_worker as bw
    r = _runner()
    seen = []

    async def q(client, cypher, params=None, *, timeout_ms=0):
        seen.append(params["hi"] - params["lo"])
        if seen[-1] > 25_000:
            raise _Boom("Query timed out")
        return type("R", (), {"result_set": [("urn:a", "N", {})]})()

    monkeypatch.setattr(bw, "_q", q)
    _rows, width = await r._scan(object(), "nodes", 0, 100_000)
    assert width == 25_000 and seen == [100_000, 50_000, 25_000]


async def test_the_scan_does_not_shrink_for_an_outage(monkeypatch):
    """The regression. A dropped connection used to walk the ladder down to its floor and
    then fail the job — four wasted queries and a dead copy, for a fault that shrinking
    cannot touch. It must be re-raised for `_run_phase` to wait out instead."""
    import backend.app.services.versioning.bootstrap_worker as bw
    r = _runner()
    seen = []

    async def q(client, cypher, params=None, *, timeout_ms=0):
        seen.append(params["hi"] - params["lo"])
        raise ConnectionResetError("reset by peer")

    monkeypatch.setattr(bw, "_q", q)
    with pytest.raises(ConnectionResetError):
        await r._scan(object(), "nodes", 0, 100_000)
    assert seen == [100_000], "an outage must be raised at full width, not laddered down"


# ── liveness: a working worker must never look dead to its colleagues ────────

def test_the_heartbeat_beats_well_inside_the_stale_window():
    """The livelock guard, as arithmetic.

    `claim_one` steals any `running` job whose heartbeat is older than INGEST_STALE_SECS.
    Before the timer existed, the only heartbeat was a window COMMIT — so a scan halving down
    its ladder, or a validate anti-joining a 10M-row commit, went quiet for minutes while
    working perfectly, and a second worker declared it dead. Fencing kept the data safe, but
    the loser re-claimed in turn and two healthy workers traded the same window forever.
    """
    assert config.INGEST_HEARTBEAT_SECS * 3 <= config.INGEST_STALE_SECS, (
        "a worker must be able to miss two beats and still not be presumed dead")


async def test_the_heartbeat_goes_quiet_once_the_job_is_not_ours(monkeypatch):
    """A superseded worker that kept beating would fight the new owner for the job."""
    beats = []

    class _Job:
        id, status, retry_count = "job_1", "running", 7      # epoch moved on: 7 != our 5
        updated_at = None

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, _model, _id):
            beats.append(1)
            return _Job()

    r = BootstrapRunner(graph_factory=lambda *a, **k: None, session_factory=_Session)
    r._epoch["job_1"] = 5                                    # we hold an older claim
    monkeypatch.setattr(config, "INGEST_HEARTBEAT_SECS", 0)
    await asyncio.wait_for(r._heartbeat("job_1"), timeout=2)
    assert beats == [1], "it must look once, see it is not ours, and stop"


async def _noop(*a, **k):
    return None


async def _noop_sleep(_d):
    return None
