"""Unit tests for the guarded provider refresh batch (Task F5).

Direct-handler-call style (like ``test_freshness_endpoints.py``): the CP
runner and routes are exercised directly with fakes — no TestClient, no
real Redis/Postgres.

What is under test:

  * the runner (``_run_provider_batch``) — enumerates outcomes for every
    ds it's given, bounds concurrency at ``min(max_concurrent, 4)``, never
    lets one item's exception abort the batch (recorded as ``error``), and
    ALWAYS releases the single-flight lock in ``finally`` — on a clean
    finish, on an item failure, on an unexpected crash outside any single
    item, and on external cancellation.
  * the CP routes — unknown provider 404s before any side effect; a held
    lock 409s and never schedules a task; a successful call acquires the
    lock, returns the initial ``running`` status, and schedules exactly
    one background task with the enumerated ds ids; the batch-status route
    assembles a ``BatchStatus`` from the hash (or 404s when absent).
"""
from __future__ import annotations

import asyncio
import json
import types

import pytest
from fastapi import HTTPException

from backend.app.db.repositories import provider_repo as provider_repo_mod
from backend.app.services.aggregation import controlplane as cp
from backend.app.services.aggregation import redis_client as redis_client_mod
from backend.app.services.aggregation.schemas import (
    BatchRefreshRequestInternal,
    BatchStatus,
)


def _run(coro):
    return asyncio.run(coro)


# ── Fakes ─────────────────────────────────────────────────────────────


class _FakeRedis:
    """In-memory stand-in for the aggregation Redis client — just enough
    of the SET NX / hash API the runner and routes use."""

    def __init__(self):
        self.strings: dict[str, str] = {}
        self.hashes: dict[str, dict[str, str]] = {}

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.strings:
            return None
        self.strings[key] = value
        return True

    async def hset(self, name, key=None, value=None, mapping=None):
        h = self.hashes.setdefault(name, {})
        if mapping:
            for k, v in mapping.items():
                h[k] = str(v)
        if key is not None:
            h[key] = str(value)
        return 1

    async def expire(self, name, seconds):
        return True

    async def hincrby(self, name, key, amount=1):
        h = self.hashes.setdefault(name, {})
        h[key] = str(int(h.get(key, 0)) + amount)
        return int(h[key])

    async def hgetall(self, name):
        return dict(self.hashes.get(name, {}))

    async def delete(self, *keys):
        count = 0
        for k in keys:
            if k in self.strings:
                del self.strings[k]
                count += 1
            if k in self.hashes:
                del self.hashes[k]
                count += 1
        return count


class _CrashingExpireRedis(_FakeRedis):
    """Crashes AFTER the lock is held but BEFORE any per-item work — proves
    the lock-release `finally` covers a runner crash, not just item errors."""

    async def expire(self, name, seconds):
        raise RuntimeError("redis unavailable")


class _FakeSessionCM:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *exc):
        return False


def _session_factory():
    return _FakeSessionCM()


class _CommitFailCM:
    """Mimics ``_session_scope``: only commits (and can only fail to commit)
    on a CLEAN exit — an already-raising body rolls back instead."""

    def __init__(self, fail: bool):
        self._fail = fail

    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, tb):
        if self._fail and exc_type is None:
            raise RuntimeError("commit failed")
        return False


class _FailNthCommitSessionFactory:
    """A fresh session per call, matching the real per-item session_factory
    contract; the Nth call's session raises on commit (__aexit__), the rest
    behave normally."""

    def __init__(self, fail_at_call: int):
        self._fail_at_call = fail_at_call
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return _CommitFailCM(fail=(self.calls == self._fail_at_call))


def _resp(job_id="job-1", actions=None, deferred=False):
    return types.SimpleNamespace(job_id=job_id, actions=list(actions or []), deferred=deferred)


class _AllSucceedSvc:
    def __init__(self):
        self.calls: list[str] = []

    async def refresh_source(self, ds_id, session, *, scope, force, actor, origin):
        self.calls.append(ds_id)
        return _resp(job_id=f"job-{ds_id}")


class _MixedOutcomeSvc:
    def __init__(self, fail_ids: set[str]):
        self._fail_ids = fail_ids

    async def refresh_source(self, ds_id, session, *, scope, force, actor, origin):
        if ds_id in self._fail_ids:
            raise RuntimeError(f"boom: {ds_id}")
        return _resp(job_id=f"job-{ds_id}")


class _ActionsAndDeferredSvc:
    """Varies actions/deferred PER SOURCE rather than returning the same
    constant for every ds — proves the runner threads each item's OWN
    ``RefreshResponse.actions``/``.deferred`` through, not a value hardcoded
    once in the runner and reused for every item regardless of what
    refresh_source actually returned for it."""

    async def refresh_source(self, ds_id, session, *, scope, force, actor, origin):
        return _resp(
            job_id=f"job-{ds_id}",
            actions=(["content_cleared", "rebuild_queued"]
                     if ds_id == "ds-labelled" else ["read_caches_refreshed"]),
            deferred=(ds_id == "ds-cooldown"),
        )


class _ScopeCapturingSvc:
    """Records the scope forwarded to ``refresh_source`` for every ds —
    proves the batch passes whatever scope it's given (e.g. ``clear``,
    H1/spec §9a) through per source, unmodified. The per-source marker-clear
    mechanics themselves are covered in ``test_refresh_verb.py``."""
    def __init__(self):
        self.scopes: dict[str, str] = {}

    async def refresh_source(self, ds_id, session, *, scope, force, actor, origin):
        self.scopes[ds_id] = scope
        return _resp(job_id=f"job-{ds_id}")


class _ConcurrencyCountingSvc:
    """Sleeps briefly on every call so overlapping calls are observable,
    tracking the peak number in flight at once."""

    def __init__(self, sleep=0.02):
        self._sleep = sleep
        self.current = 0
        self.peak = 0

    async def refresh_source(self, ds_id, session, *, scope, force, actor, origin):
        self.current += 1
        self.peak = max(self.peak, self.current)
        await asyncio.sleep(self._sleep)
        self.current -= 1
        return _resp(job_id=f"job-{ds_id}")


class _SlowSvc:
    """Never returns on its own — used to cancel a batch mid-flight."""

    async def refresh_source(self, ds_id, session, *, scope, force, actor, origin):
        await asyncio.sleep(10)
        return _resp()


def _req(scope="auto", force=False, max_concurrent=2, actor="user-1", origin="api"):
    return BatchRefreshRequestInternal(
        scope=scope, force=force, max_concurrent=max_concurrent,
        actor=actor, origin=origin,
    )


# ── Runner: enumeration + outcomes ───────────────────────────────────


def test_batch_records_outcome_for_every_ds_and_completes():
    svc = _AllSucceedSvc()
    redis = _FakeRedis()
    ds_ids = [f"ds-{i}" for i in range(5)]
    _run(cp._run_provider_batch(
        "batch-1", "prov-1", [(d, None) for d in ds_ids], _req(),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    hash_ = redis.hashes["refreshbatch:batch-1"]
    assert hash_["state"] == "done"
    assert hash_["total"] == "5"
    assert hash_["done"] == "5"
    for ds_id in ds_ids:
        item = json.loads(hash_[f"ds:{ds_id}"])
        assert item["outcome"] == "done"
        assert item["jobId"] == f"job-{ds_id}"
    assert sorted(svc.calls) == sorted(ds_ids)


def test_batch_item_failure_recorded_as_error_batch_still_completes():
    svc = _MixedOutcomeSvc(fail_ids={"ds-b"})
    redis = _FakeRedis()
    _run(cp._run_provider_batch(
        "batch-2", "prov-1", [("ds-a", None), ("ds-b", None), ("ds-c", None)], _req(),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    hash_ = redis.hashes["refreshbatch:batch-2"]
    assert hash_["state"] == "done"
    assert hash_["done"] == "3"
    assert json.loads(hash_["ds:ds-a"])["outcome"] == "done"
    failed = json.loads(hash_["ds:ds-b"])
    assert failed["outcome"] == "error"
    assert failed["jobId"] is None
    assert json.loads(hash_["ds:ds-c"])["outcome"] == "done"


def test_session_commit_failure_recorded_as_error_batch_still_completes():
    # refresh_source itself is designed to never raise, but the session's
    # commit — which happens at the `async with` __aexit__, AFTER
    # refresh_source returns cleanly — can still fail (deadlock, dropped
    # connection). That must be caught too, not just the refresh_source
    # call, or the batch never reaches "done".
    redis = _FakeRedis()
    ds_ids = ["ds-a", "ds-b", "ds-c"]
    session_factory = _FailNthCommitSessionFactory(fail_at_call=2)
    _run(cp._run_provider_batch(
        "batch-commit-fail", "prov-1", [(d, None) for d in ds_ids], _req(),
        svc=_AllSucceedSvc(), session_factory=session_factory, redis=redis,
    ))
    hash_ = redis.hashes["refreshbatch:batch-commit-fail"]
    assert hash_["state"] == "done"
    assert hash_["done"] == "3"
    outcomes = [json.loads(hash_[f"ds:{d}"])["outcome"] for d in ds_ids]
    assert outcomes.count("error") == 1  # exactly the one whose commit failed
    assert outcomes.count("done") == 2   # siblings recorded normally
    assert session_factory.calls == 3    # one fresh session per item


def test_batch_forwards_clear_scope_to_every_source():
    svc = _ScopeCapturingSvc()
    redis = _FakeRedis()
    ds_ids = ["ds-a", "ds-b", "ds-c"]
    _run(cp._run_provider_batch(
        "batch-clear", "prov-1", [(d, None) for d in ds_ids], _req(scope="clear"),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    assert svc.scopes == {d: "clear" for d in ds_ids}
    hash_ = redis.hashes["refreshbatch:batch-clear"]
    assert hash_["state"] == "done"


def test_batch_item_threads_name_actions_and_deferred_from_response():
    """Pins the runner's own item-building, not just BatchItemResult in
    isolation (see the two model-only tests near the bottom of this file):
    the source's label, RefreshResponse.actions, and RefreshResponse.deferred
    must all reach the batch hash. Two rows — one labelled, one not — also
    pin the nullable-label path."""
    redis = _FakeRedis()
    _run(cp._run_provider_batch(
        "batch-named", "prov-1",
        [("ds-labelled", "Solidatus Perf Xlarge"), ("ds-cooldown", None)],
        _req(),
        svc=_ActionsAndDeferredSvc(), session_factory=_session_factory, redis=redis,
    ))
    hash_ = redis.hashes["refreshbatch:batch-named"]
    labelled = json.loads(hash_["ds:ds-labelled"])
    assert labelled["name"] == "Solidatus Perf Xlarge"
    assert labelled["actions"] == ["content_cleared", "rebuild_queued"]
    assert labelled["deferred"] is False
    cooldown = json.loads(hash_["ds:ds-cooldown"])
    assert cooldown["name"] is None
    assert cooldown["deferred"] is True
    assert cooldown["actions"] == ["read_caches_refreshed"]


# ── Concurrency bound ─────────────────────────────────────────────────


def test_concurrency_bounded_by_requested_max():
    svc = _ConcurrencyCountingSvc()
    redis = _FakeRedis()
    ds_ids = [f"ds-{i}" for i in range(8)]
    _run(cp._run_provider_batch(
        "batch-3", "prov-1", [(d, None) for d in ds_ids], _req(max_concurrent=3),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    assert svc.peak <= 3
    assert svc.peak > 1  # proves items actually overlapped, not serial


def test_concurrency_capped_at_four_even_if_more_requested():
    svc = _ConcurrencyCountingSvc()
    redis = _FakeRedis()
    ds_ids = [f"ds-{i}" for i in range(10)]
    _run(cp._run_provider_batch(
        "batch-4", "prov-1", [(d, None) for d in ds_ids], _req(max_concurrent=10),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    assert svc.peak <= 4


# ── Single-flight lock release ────────────────────────────────────────


def test_lock_released_on_clean_completion():
    redis = _FakeRedis()
    redis.strings["refreshbatch:lock:prov-1"] = "1"  # simulate route having set it
    _run(cp._run_provider_batch(
        "batch-5", "prov-1", [("ds-a", None)], _req(),
        svc=_AllSucceedSvc(), session_factory=_session_factory, redis=redis,
    ))
    assert "refreshbatch:lock:prov-1" not in redis.strings


def test_lock_released_when_an_item_fails():
    redis = _FakeRedis()
    redis.strings["refreshbatch:lock:prov-1"] = "1"
    _run(cp._run_provider_batch(
        "batch-6", "prov-1", [("ds-a", None), ("ds-b", None)], _req(),
        svc=_MixedOutcomeSvc(fail_ids={"ds-a"}),
        session_factory=_session_factory, redis=redis,
    ))
    assert "refreshbatch:lock:prov-1" not in redis.strings


def test_lock_released_on_runner_crash_outside_any_single_item():
    redis = _CrashingExpireRedis()
    redis.strings["refreshbatch:lock:prov-1"] = "1"
    with pytest.raises(RuntimeError):
        _run(cp._run_provider_batch(
            "batch-7", "prov-1", [("ds-a", None)], _req(),
            svc=_AllSucceedSvc(), session_factory=_session_factory, redis=redis,
        ))
    assert "refreshbatch:lock:prov-1" not in redis.strings


def test_lock_released_on_external_cancellation():
    redis = _FakeRedis()
    redis.strings["refreshbatch:lock:prov-1"] = "1"

    async def _scenario():
        task = asyncio.create_task(cp._run_provider_batch(
            "batch-8", "prov-1", [("ds-a", None)], _req(),
            svc=_SlowSvc(), session_factory=_session_factory, redis=redis,
        ))
        await asyncio.sleep(0.01)  # let it start and acquire the "lock"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    _run(_scenario())
    assert "refreshbatch:lock:prov-1" not in redis.strings


# ── Route: POST /aggregation/providers/{provider_id}/refresh-batch ──


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeSession:
    def __init__(self, rows):
        self._rows = rows

    async def execute(self, query):
        return _FakeResult(self._rows)


def _fake_request(session_factory=_session_factory):
    return types.SimpleNamespace(
        app=types.SimpleNamespace(
            state=types.SimpleNamespace(session_factory=session_factory),
        ),
    )


def _patch_create_task(monkeypatch):
    """Intercepts asyncio.create_task so route tests never actually run the
    background job; closes the coroutine to avoid a "never awaited"
    warning. Returns the list of captured coroutines."""
    captured = []

    def _fake(coro, **kwargs):
        captured.append(coro)
        coro.close()
        return types.SimpleNamespace()

    monkeypatch.setattr(cp.asyncio, "create_task", _fake)
    return captured


def test_route_404_unknown_provider(monkeypatch):
    async def _get_provider_orm(session, provider_id):
        return None
    monkeypatch.setattr(provider_repo_mod, "get_provider_orm", _get_provider_orm)
    captured = _patch_create_task(monkeypatch)

    with pytest.raises(HTTPException) as ei:
        _run(cp.start_refresh_batch(
            "prov-x", _fake_request(), body=_req(),
            svc=_AllSucceedSvc(), session=_FakeSession([]),
        ))
    assert ei.value.status_code == 404
    assert captured == []  # no task scheduled


def test_route_409_when_lock_already_held(monkeypatch):
    async def _get_provider_orm(session, provider_id):
        return types.SimpleNamespace(id=provider_id)
    monkeypatch.setattr(provider_repo_mod, "get_provider_orm", _get_provider_orm)
    captured = _patch_create_task(monkeypatch)

    redis = _FakeRedis()
    redis.strings["refreshbatch:lock:prov-1"] = "1"  # already running
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    with pytest.raises(HTTPException) as ei:
        _run(cp.start_refresh_batch(
            "prov-1", _fake_request(), body=_req(),
            svc=_AllSucceedSvc(), session=_FakeSession([("ds-a", None)]),
        ))
    assert ei.value.status_code == 409
    assert captured == []  # no task scheduled over an existing run


def test_route_success_enumerates_acquires_lock_and_schedules_task(monkeypatch):
    async def _get_provider_orm(session, provider_id):
        return types.SimpleNamespace(id=provider_id)
    monkeypatch.setattr(provider_repo_mod, "get_provider_orm", _get_provider_orm)
    captured = _patch_create_task(monkeypatch)

    redis = _FakeRedis()
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    svc = _AllSucceedSvc()
    resp = _run(cp.start_refresh_batch(
        "prov-1", _fake_request(), body=_req(),
        svc=svc, session=_FakeSession([("ds-a", None), ("ds-b", None)]),
    ))

    assert isinstance(resp, BatchStatus)
    assert resp.provider_id == "prov-1"
    assert resp.total == 2
    assert resp.done == 0
    assert resp.state == "running"
    assert resp.results == []
    assert redis.strings["refreshbatch:lock:prov-1"] == "1"
    assert len(captured) == 1  # exactly one background job scheduled


# ── Route: GET /aggregation/refresh-batches/{batch_id} ───────────────


def test_get_refresh_batch_assembles_status_from_hash(monkeypatch):
    redis = _FakeRedis()
    redis.hashes["refreshbatch:batch-9"] = {
        "provider_id": "prov-1", "state": "done", "total": "2", "done": "2",
        "ds:ds-a": json.dumps({"dataSourceId": "ds-a", "outcome": "done", "jobId": "job-a"}),
        "ds:ds-b": json.dumps({"dataSourceId": "ds-b", "outcome": "error", "jobId": None}),
    }
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    status_ = _run(cp.get_refresh_batch("batch-9"))
    assert status_.provider_id == "prov-1"
    assert status_.state == "done"
    assert status_.total == 2
    assert status_.done == 2
    outcomes = {r.data_source_id: r.outcome for r in status_.results}
    assert outcomes == {"ds-a": "done", "ds-b": "error"}


def test_get_refresh_batch_404_when_unknown(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    with pytest.raises(HTTPException) as ei:
        _run(cp.get_refresh_batch("nope"))
    assert ei.value.status_code == 404


def test_batch_item_reports_name_actions_and_deferral():
    """"Refresh complete" listing opaque ds_ ids tells an operator nothing.
    RefreshResponse already knows what ran and whether the rebuild was
    deferred by cooldown — the batch item must carry both, plus the label,
    or the dialog cannot say what it did."""
    from backend.app.services.aggregation.schemas import BatchItemResult

    item = BatchItemResult(
        dataSourceId="ds_1",
        name="Solidatus Perf Xlarge",
        outcome="done",
        jobId="job_9",
        actions=["content_cleared", "hierarchy_invalidated", "rebuild_queued"],
        deferred=False,
    )
    assert item.name == "Solidatus Perf Xlarge"
    assert "rebuild_queued" in item.actions
    assert item.deferred is False


def test_batch_item_defaults_stay_well_formed_for_the_error_branch():
    """The error path has no RefreshResponse to read, so the new fields must
    default rather than being required — otherwise a failing item raises
    inside the runner and strands the batch at state 'running'."""
    from backend.app.services.aggregation.schemas import BatchItemResult

    item = BatchItemResult(dataSourceId="ds_2", outcome="error")
    assert item.actions == []
    assert item.deferred is False
    assert item.name is None


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))


# ── operator holds: a batch SKIPS a held source and REPORTS it ───────────


class _HoldingSvc(_AllSucceedSvc):
    """One source is held; the rest refresh. ``hold_for_source`` is the
    capability the batch checks for — the real AggregationService exposes
    it, and a service without it (the other doubles here) holds nothing."""

    def __init__(self, held_id: str):
        super().__init__()
        self._held_id = held_id

    async def hold_for_source(self, ds_id, session):
        from backend.app.services.aggregation.holds import Hold
        if ds_id == self._held_id:
            return Hold("provider", "paused", until="2999-01-01T00:00:00+00:00", scope_id="prov-1")
        return None


def test_batch_skips_a_held_source_and_reports_it_without_shrinking_total():
    """A provider-wide refresh over N sources is not a deliberate per-source
    override of the ones somebody paused (that is the single-source Rebuild,
    which warns and proceeds). The held source is skipped and reported —
    per ITEM, so ``total`` stays honest rather than the enumerator quietly
    reporting 5 sources as 4."""
    svc = _HoldingSvc(held_id="ds-2")
    redis = _FakeRedis()
    ds_ids = [f"ds-{i}" for i in range(5)]
    _run(cp._run_provider_batch(
        "batch-h", "prov-1", [(d, None) for d in ds_ids], _req(),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    hash_ = redis.hashes["refreshbatch:batch-h"]
    assert hash_["state"] == "done"
    assert hash_["total"] == "5"
    assert hash_["done"] == "5"
    held = json.loads(hash_["ds:ds-2"])
    assert held["outcome"] == "held"
    assert held["jobId"] is None
    assert held["heldBy"] == "provider" and held["heldKind"] == "paused"
    assert held["heldUntil"] == "2999-01-01T00:00:00+00:00"
    for ds_id in ds_ids:
        if ds_id != "ds-2":
            assert json.loads(hash_[f"ds:{ds_id}"])["outcome"] == "done"
    assert sorted(svc.calls) == sorted(d for d in ds_ids if d != "ds-2")
