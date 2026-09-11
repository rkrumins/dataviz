"""Raising a RUNNING job's time limits without cancelling it.

The stall window (``timeout_secs``), the wall clock and the two per-query
budgets can be raised on a pending or running job. The service records who
raised what, from what, to what, on the row; the worker's watchdog re-reads
the row every few ticks through a fresh session; the pipeline reads the
per-query budgets per query. A terminal job takes Resume overrides instead.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import types

import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

from backend.app.db.engine import Base
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.aggregation.schemas import JobLimitsPatch
from backend.app.services.aggregation.service import AggregationService, NotFoundError
from backend.app.services.aggregation.worker import (
    AggregationWorker, _LIVE_PIPELINE_KEYS, _merge_live_limits,
)


@pytest_asyncio.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _attach(dbapi_conn, _rec):
        dbapi_conn.execute("ATTACH DATABASE ':memory:' AS aggregation")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(
        bind=engine, class_=AsyncSession, expire_on_commit=False,
    )
    yield factory
    await engine.dispose()


def _service() -> AggregationService:
    return AggregationService(dispatcher=None, registry=None, session_factory=None, ontology_service=None)


def _job(status: str = "running", **over) -> AggregationJobORM:
    fields = dict(
        id="agg_lim1", data_source_id="ds_1", workspace_id="ws_1", status=status,
        trigger_source="manual", progress=40, total_edges=100, processed_edges=40,
        created_edges=0, batch_size=1000, timeout_secs=10_800, max_retries=3,
        created_at="2026-09-09T10:00:00+00:00",
    )
    fields.update(over)
    return AggregationJobORM(**fields)


# ── the service ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_raising_limits_on_a_running_job_records_who_changed_what(session_factory):
    async with session_factory() as s:
        s.add(_job())
        await s.commit()

    async with session_factory() as s:
        out = await _service().set_job_limits(
            "ds_1", "agg_lim1", s,
            JobLimitsPatch(timeoutSecs=21_600, maxWallSecs=172_800, scanTimeoutS=120, actor="ops@example.com"),
        )
    assert out.timeout_secs == 21_600
    assert out.live_overrides["max_wall_secs"] == 172_800 and out.live_overrides["scan_timeout_s"] == 120
    history = out.live_overrides["history"]
    assert [h["field"] for h in history] == ["timeout_secs", "max_wall_secs", "scan_timeout_s"]
    assert history[0] == {**history[0], "by": "ops@example.com", "from": 10_800, "to": 21_600}
    assert all(h["at"] for h in history)

    # Durable, and a second raise appends (the row is the audit trail).
    async with session_factory() as s:
        row = await s.get(AggregationJobORM, "agg_lim1")
        assert row.timeout_secs == 21_600
        out = await _service().set_job_limits("ds_1", "agg_lim1", s, JobLimitsPatch(writeTimeoutS=90))
    assert len(out.live_overrides["history"]) == 4
    assert out.live_overrides["scan_timeout_s"] == 120       # earlier raises survive


@pytest.mark.asyncio
async def test_the_scan_shape_can_be_changed_and_cleared_on_a_running_job(session_factory):
    """Pacing, a read-concurrency cap and a scan-width cap are live too, and
    ``reset`` clears them back to the job's settings — each change and each
    clearing on the history."""
    async with session_factory() as s:
        s.add(_job())
        await s.commit()
    svc = _service()
    async with session_factory() as s:
        out = await svc.set_job_limits(
            "ds_1", "agg_lim1", s,
            JobLimitsPatch(writePacingRatio=2.0, extractConcurrency=1, scanWidth=5_000, actor="ops@example.com"),
        )
    live = out.live_overrides
    assert (live["write_pacing_ratio"], live["extract_concurrency"], live["scan_width"]) == (2.0, 1, 5_000)
    assert [h["field"] for h in live["history"]] == ["write_pacing_ratio", "extract_concurrency", "scan_width"]

    async with session_factory() as s:
        out = await svc.set_job_limits(
            "ds_1", "agg_lim1", s, JobLimitsPatch(reset=["writePacingRatio", "scanWidth"], actor="ops@example.com"),
        )
    live = out.live_overrides
    assert "write_pacing_ratio" not in live and "scan_width" not in live and live["extract_concurrency"] == 1
    cleared = [(h["field"], h["from"], h["to"]) for h in live["history"] if h["to"] is None]
    assert cleared == [("write_pacing_ratio", 2.0, None), ("scan_width", 5_000, None)]

    # Clearing what is not set changes nothing.
    async with session_factory() as s:
        with pytest.raises(ValueError, match="No limit changed"):
            await svc.set_job_limits("ds_1", "agg_lim1", s, JobLimitsPatch(reset=["scanWidth"]))
    for bad in ({"writePacingRatio": 11}, {"extractConcurrency": 0}, {"scanWidth": 0}, {"reset": ["nope"]}):
        with pytest.raises(ValidationError):
            JobLimitsPatch(**bad)


@pytest.mark.asyncio
async def test_limits_cannot_be_raised_on_a_terminal_or_foreign_job(session_factory):
    async with session_factory() as s:
        s.add(_job(status="completed"))
        await s.commit()
    async with session_factory() as s:
        with pytest.raises(ValueError, match="completed"):
            await _service().set_job_limits("ds_1", "agg_lim1", s, JobLimitsPatch(timeoutSecs=21_600))
        with pytest.raises(NotFoundError):
            await _service().set_job_limits("ds_other", "agg_lim1", s, JobLimitsPatch(timeoutSecs=21_600))


@pytest.mark.asyncio
async def test_an_empty_patch_is_refused_and_bounds_are_enforced(session_factory):
    async with session_factory() as s:
        s.add(_job(status="pending"))
        await s.commit()
    async with session_factory() as s:
        with pytest.raises(ValueError, match="No limit changed"):
            await _service().set_job_limits("ds_1", "agg_lim1", s, JobLimitsPatch())
    with pytest.raises(ValidationError):
        JobLimitsPatch(timeoutSecs=30)                 # below 60 s
    with pytest.raises(ValidationError):
        JobLimitsPatch(maxWallSecs=604_801)            # above 7 days
    with pytest.raises(ValidationError):
        JobLimitsPatch(scanTimeoutS=601)


# ── the worker re-reads the row ──────────────────────────────────────


def test_merge_live_limits_never_puts_the_wall_clock_below_the_stall_window():
    assert _merge_live_limits(10_800, 86_400, {"timeout_secs": 21_600}) == (21_600, 86_400)
    assert _merge_live_limits(10_800, 86_400, {"timeout_secs": 172_800}) == (172_800, 172_800)
    assert _merge_live_limits(10_800, 86_400, {"max_wall_secs": 259_200}) == (10_800, 259_200)
    assert _merge_live_limits(10_800, 86_400, {}) == (10_800, 86_400)


@pytest.mark.asyncio
async def test_live_limits_are_read_through_a_fresh_session(session_factory):
    """Time limits and the live scan shape alike; pacing may be 0 (no
    pacing), the two caps must be positive, and junk is left out."""
    async with session_factory() as s:
        s.add(_job(timeout_secs=7_200, live_overrides=json.dumps({
            "max_wall_secs": 172_800, "scan_timeout_s": 120.0, "history": [],
            "write_pacing_ratio": 0, "extract_concurrency": 1, "scan_width": 5_000,
        })))
        s.add(_job(id="agg_lim2", live_overrides=json.dumps({
            "write_pacing_ratio": -1, "extract_concurrency": "two", "scan_width": 0,
        })))
        await s.commit()
    worker = AggregationWorker(session_factory=session_factory, registry=None, event_publisher=None)
    assert await worker._live_limits("agg_lim1") == {
        "timeout_secs": 7_200, "max_wall_secs": 172_800, "scan_timeout_s": 120.0,
        "write_pacing_ratio": 0.0, "extract_concurrency": 1, "scan_width": 5_000,
    }
    assert await worker._live_limits("agg_lim2") == {"timeout_secs": 10_800}
    # A missing row is "could not read", never "everything cleared".
    assert await worker._live_limits("agg_missing") is None


def test_a_failing_read_never_touches_the_watchdog():
    """None, not an empty dict: an empty dict would clear every live value
    on the next tick, so a database hiccup must read as "no answer"."""
    def broken_factory():
        raise RuntimeError("db down")
    worker = AggregationWorker(session_factory=broken_factory, registry=None, event_publisher=None)
    assert asyncio.run(worker._live_limits("agg_lim1")) is None
    assert asyncio.run(AggregationWorker(session_factory=None, registry=None, event_publisher=None)._live_limits("x")) is None


def test_the_watchdog_tick_re_reads_the_limits_and_hands_the_live_dict_to_the_pipeline():
    src = inspect.getsource(AggregationWorker.run)
    assert "await self._live_limits(job.id)" in src
    assert "_merge_live_limits(" in src
    # A failed read changes nothing; a present key is set, an absent one popped.
    assert "if fresh is not None:" in src
    assert "for key in _LIVE_PIPELINE_KEYS:" in src and "live.pop(key, None)" in src
    assert set(_LIVE_PIPELINE_KEYS) == {
        "scan_timeout_s", "write_timeout_s", "write_pacing_ratio", "extract_concurrency", "scan_width",
        # Replication backpressure is live too: lowering the acknowledgement
        # bar to 0 is what releases a run held behind a lagging replica.
        "replica_ack_min", "replica_ack_timeout_ms",
        # Steady load: the batch ceiling and the batch target are live too —
        # "smaller batches" on a running job is the one control that does
        # less per batch rather than waiting longer between them.
        "write_batch_max", "write_batch_target_s",
    }
    src = inspect.getsource(AggregationWorker._materialize_with_checkpoints)
    assert 'live_limits=(limits or {}).get("live")' in src


# ── the routes ───────────────────────────────────────────────────────


def test_the_web_route_carries_the_manage_gate_and_forwards_the_actor(monkeypatch):
    from backend.app.api.v1.endpoints import aggregation as agg_mod

    def _dep_calls(dependant):
        out = [dependant.call]
        for d in dependant.dependencies:
            out += _dep_calls(d)
        return out

    route = next(
        r for r in agg_mod.router.routes
        if r.path == "/data-sources/{ds_id}/aggregation-jobs/{job_id}/limits" and "PATCH" in r.methods
    )
    assert agg_mod._REQUIRE_DS_MANAGE in _dep_calls(route.dependant)

    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured.update(method=method, path=path, body=body)
        return "proxied"

    monkeypatch.setattr(agg_mod, "_proxy", _fake_proxy)
    monkeypatch.setattr(agg_mod, "_PROXY_ENABLED", True)
    out = asyncio.run(agg_mod.set_job_limits(
        "ds_1", "agg_1", JobLimitsPatch(timeoutSecs=21_600, actor="spoofed"),
        types.SimpleNamespace(query_params={}), user=types.SimpleNamespace(id="user-42"),
        svc=None, session=None,
    ))
    assert out == "proxied" and captured["method"] == "PATCH"
    assert captured["path"] == "/aggregation/data-sources/ds_1/jobs/agg_1/limits"
    body = json.loads(captured["body"])
    assert body == {"timeoutSecs": 21_600, "actor": "user-42"}   # the client's actor never wins


def test_the_control_plane_route_takes_the_patch_body():
    from backend.app.services.aggregation import controlplane as cp
    assert "patch" in inspect.signature(cp.set_job_limits).parameters
