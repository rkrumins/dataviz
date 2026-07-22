"""Unit tests for the fleet-wide guarded refresh batch (Task G2).

Direct-handler-call style, mirroring ``test_provider_refresh_batch.py``
(F5): routes and the shared runner/query helpers are exercised directly
with fakes — no TestClient, no real Redis/Postgres.

What is under test:

  * enumeration — ``_live_ds_rows`` with no ``provider_id`` builds an
    UNSCOPED query (still ``deleted_at IS NULL``), so the fleet route's
    total spans every provider's live sources; scoped to one provider it
    adds exactly one predicate.
  * the fleet route — acquires the GLOBAL lock ``refreshbatch:lock:__fleet__``
    (never a per-provider lock), 409s when already held, and schedules the
    SAME runner (``_run_provider_batch``, reused verbatim — no parallel
    implementation) that F5 built.
  * overlap semantics — a fleet batch and a provider batch on an
    overlapping source can both proceed at once; only two concurrent fleet
    batches collide with each other.
  * the reused runner behaves identically when given the fleet scope id
    (``__fleet__``): bounded concurrency, item-error isolation, and the
    single-flight lock released on clean completion and on a crash.
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


# ── Fakes (mirrors test_provider_refresh_batch.py) ───────────────────


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
    the lock-release ``finally`` covers a runner crash under the fleet
    scope id too, not just the per-provider one F5 already tests."""

    async def expire(self, name, seconds):
        raise RuntimeError("redis unavailable")


class _FakeSessionCM:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *exc):
        return False


def _session_factory():
    return _FakeSessionCM()


def _resp(job_id="job-1"):
    return types.SimpleNamespace(job_id=job_id, actions=[], deferred=False)


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


def _req(scope="auto", force=False, max_concurrent=2, actor="user-1", origin="api"):
    return BatchRefreshRequestInternal(
        scope=scope, force=force, max_concurrent=max_concurrent,
        actor=actor, origin=origin,
    )


class _RecordingResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _RecordingSession:
    """Returns the queued rows regardless of the query, but records every
    query so tests can assert what WHERE clauses it carried."""

    def __init__(self, rows):
        self._rows = rows
        self.executed = []

    async def execute(self, query):
        self.executed.append(query)
        return _RecordingResult(self._rows)


def _compiled(query) -> str:
    return str(query.compile(compile_kwargs={"literal_binds": True}))


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


# ── Enumeration: `_live_ds_rows` ──────────────────────────────────────


def test_live_ds_rows_unscoped_has_no_provider_filter_but_excludes_tombstones():
    session = _RecordingSession([("ds-a1", "A1"), ("ds-b1", "B1"), ("ds-a2", None)])
    rows = _run(cp._live_ds_rows(session))
    assert rows == [("ds-a1", "A1"), ("ds-b1", "B1"), ("ds-a2", None)]

    sql = _compiled(session.executed[0])
    assert "deleted_at IS NULL" in sql
    assert "provider_id" not in sql  # unscoped: no provider predicate at all


def test_live_ds_rows_scoped_to_one_provider_adds_exactly_one_predicate():
    session = _RecordingSession([("ds-a1", "A1")])
    rows = _run(cp._live_ds_rows(session, provider_id="prov-a"))
    assert rows == [("ds-a1", "A1")]

    sql = _compiled(session.executed[0])
    assert "deleted_at IS NULL" in sql
    assert "provider_id = 'prov-a'" in sql


# ── Fleet route: enumeration + global lock ────────────────────────────


def test_fleet_route_enumerates_across_providers_mixed(monkeypatch):
    # ds ids spanning two different providers all come back — the fleet
    # route takes ALL of them, not scoped to any one provider.
    captured = _patch_create_task(monkeypatch)
    redis = _FakeRedis()
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    session = _RecordingSession([("ds-a1", None), ("ds-b1", None), ("ds-a2", None)])
    resp = _run(cp.start_fleet_refresh_batch(
        _fake_request(), body=_req(), svc=_AllSucceedSvc(), session=session,
    ))

    assert isinstance(resp, BatchStatus)
    assert resp.provider_id == "__fleet__"
    assert resp.total == 3
    assert resp.done == 0
    assert resp.state == "running"
    assert resp.results == []
    assert redis.strings["refreshbatch:lock:__fleet__"] == "1"
    assert len(captured) == 1
    assert "provider_id" not in _compiled(session.executed[0])


def test_fleet_route_409_when_global_lock_already_held(monkeypatch):
    captured = _patch_create_task(monkeypatch)
    redis = _FakeRedis()
    redis.strings["refreshbatch:lock:__fleet__"] = "1"  # already running
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    session = _RecordingSession([("ds-a1", None)])
    with pytest.raises(HTTPException) as ei:
        _run(cp.start_fleet_refresh_batch(
            _fake_request(), body=_req(), svc=_AllSucceedSvc(), session=session,
        ))
    assert ei.value.status_code == 409
    assert captured == []  # no task scheduled over an existing fleet run


def test_fleet_route_end_to_end_records_per_source_outcomes(monkeypatch):
    # Full round trip through the route AND the shared runner (not just the
    # route scheduling a task) — proves the fleet path actually produces
    # per-source outcomes, not just an initial "running" stub.
    redis = _FakeRedis()
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    captured_coro = {}

    def _run_inline(coro, **kwargs):
        captured_coro["coro"] = coro
        return types.SimpleNamespace()
    monkeypatch.setattr(cp.asyncio, "create_task", _run_inline)

    session = _RecordingSession([("ds-a", None), ("ds-b", None)])
    resp = _run(cp.start_fleet_refresh_batch(
        _fake_request(), body=_req(), svc=_AllSucceedSvc(), session=session,
    ))
    assert resp.total == 2

    _run(captured_coro["coro"])  # drive the scheduled runner to completion

    hash_ = redis.hashes[f"refreshbatch:{resp.batch_id}"]
    assert hash_["state"] == "done"
    assert hash_["provider_id"] == "__fleet__"
    for ds_id in ("ds-a", "ds-b"):
        assert json.loads(hash_[f"ds:{ds_id}"])["outcome"] == "done"
    assert "refreshbatch:lock:__fleet__" not in redis.strings


# ── Overlap: fleet batch + provider batch on the same source ─────────


def test_fleet_and_provider_batch_overlap_on_same_source_both_proceed(monkeypatch):
    captured = _patch_create_task(monkeypatch)
    redis = _FakeRedis()
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    async def _get_provider_orm(session, provider_id):
        return types.SimpleNamespace(id=provider_id)
    monkeypatch.setattr(provider_repo_mod, "get_provider_orm", _get_provider_orm)

    provider_session = _RecordingSession([("ds-shared", None)])
    fleet_session = _RecordingSession([("ds-shared", None), ("ds-other", None)])

    provider_resp = _run(cp.start_refresh_batch(
        "prov-1", _fake_request(), body=_req(),
        svc=_AllSucceedSvc(), session=provider_session,
    ))
    fleet_resp = _run(cp.start_fleet_refresh_batch(
        _fake_request(), body=_req(),
        svc=_AllSucceedSvc(), session=fleet_session,
    ))

    assert provider_resp.total == 1
    assert fleet_resp.total == 2
    # Both locks held at once — the fleet lock and the per-provider lock
    # are independent scopes, so neither call 409s the other.
    assert redis.strings["refreshbatch:lock:prov-1"] == "1"
    assert redis.strings["refreshbatch:lock:__fleet__"] == "1"
    assert len(captured) == 2  # both background jobs scheduled


def test_two_fleet_batches_do_collide(monkeypatch):
    # Sanity check on the other side of the overlap rule: TWO fleet batches
    # share the same global scope id and must NOT both proceed.
    captured = _patch_create_task(monkeypatch)
    redis = _FakeRedis()
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    session_1 = _RecordingSession([("ds-a", None)])
    session_2 = _RecordingSession([("ds-a", None)])

    _run(cp.start_fleet_refresh_batch(
        _fake_request(), body=_req(), svc=_AllSucceedSvc(), session=session_1,
    ))
    with pytest.raises(HTTPException) as ei:
        _run(cp.start_fleet_refresh_batch(
            _fake_request(), body=_req(), svc=_AllSucceedSvc(), session=session_2,
        ))
    assert ei.value.status_code == 409
    assert len(captured) == 1


# ── Reused runner under the fleet scope id ────────────────────────────


def test_fleet_scope_lock_released_on_clean_completion():
    redis = _FakeRedis()
    redis.strings["refreshbatch:lock:__fleet__"] = "1"  # simulate route having set it
    _run(cp._run_provider_batch(
        "batch-f1", "__fleet__", [("ds-a", None), ("ds-b", None)], _req(),
        svc=_AllSucceedSvc(), session_factory=_session_factory, redis=redis,
    ))
    assert "refreshbatch:lock:__fleet__" not in redis.strings
    hash_ = redis.hashes["refreshbatch:batch-f1"]
    assert hash_["state"] == "done"
    assert hash_["provider_id"] == "__fleet__"


def test_fleet_scope_item_failure_recorded_error_batch_still_done():
    svc = _MixedOutcomeSvc(fail_ids={"ds-b"})
    redis = _FakeRedis()
    _run(cp._run_provider_batch(
        "batch-f2", "__fleet__", [("ds-a", None), ("ds-b", None), ("ds-c", None)], _req(),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    hash_ = redis.hashes["refreshbatch:batch-f2"]
    assert hash_["state"] == "done"
    assert json.loads(hash_["ds:ds-a"])["outcome"] == "done"
    failed = json.loads(hash_["ds:ds-b"])
    assert failed["outcome"] == "error"
    assert failed["jobId"] is None
    assert json.loads(hash_["ds:ds-c"])["outcome"] == "done"


def test_fleet_scope_concurrency_bounded_by_requested_max():
    svc = _ConcurrencyCountingSvc()
    redis = _FakeRedis()
    ds_ids = [f"ds-{i}" for i in range(8)]
    _run(cp._run_provider_batch(
        "batch-f3", "__fleet__", [(d, None) for d in ds_ids], _req(max_concurrent=3),
        svc=svc, session_factory=_session_factory, redis=redis,
    ))
    assert svc.peak <= 3
    assert svc.peak > 1  # proves items actually overlapped, not serial


def test_fleet_scope_lock_released_on_runner_crash():
    redis = _CrashingExpireRedis()
    redis.strings["refreshbatch:lock:__fleet__"] = "1"
    with pytest.raises(RuntimeError):
        _run(cp._run_provider_batch(
            "batch-f4", "__fleet__", [("ds-a", None)], _req(),
            svc=_AllSucceedSvc(), session_factory=_session_factory, redis=redis,
        ))
    assert "refreshbatch:lock:__fleet__" not in redis.strings


# ── GET /aggregation/refresh-batches/{batch_id} — fleet scope reads back ──


def test_get_refresh_batch_reports_fleet_scope(monkeypatch):
    redis = _FakeRedis()
    redis.hashes["refreshbatch:batch-f5"] = {
        "provider_id": "__fleet__", "state": "running", "total": "3", "done": "1",
    }
    monkeypatch.setattr(redis_client_mod, "get_redis", lambda: redis)

    status_ = _run(cp.get_refresh_batch("batch-f5"))
    assert status_.provider_id == "__fleet__"
    assert status_.total == 3
    assert status_.done == 1
    assert status_.state == "running"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
