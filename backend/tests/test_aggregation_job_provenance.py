"""Who started a run, and why — attributed on the job, recorded once.

Pinned here:

* a person's trigger stamps the job row with who and why and records ONE
  ``aggregation.job.triggered`` event in the job's own transaction — when
  the record cannot be written, the job is not created either;
* automation stamps nothing and records nothing; attribution with recording
  off (the rebuild a refresh queues) stamps the row and records nothing;
* every other manual operation records one event, filed under the source and
  its workspace and named as the source is named now;
* a refresh is ONE event whatever it queued, and a provider batch is one
  event however many sources it touched — their rebuilds carry the person;
* the person crosses the hop to the control plane from the web tier's
  session, never from a header its client sent, and the control plane takes
  it only behind its token;
* the public trigger route refuses the sources only automation may mint, and
  Job History filters by who started a run.
"""
from __future__ import annotations

import json
import types
from urllib.parse import quote

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.api.v1.endpoints import aggregation as agg_endpoints
from backend.app.common import activity_context
from backend.app.common.activity_context import ActivityContext, Provenance
from backend.app.db.engine import Base
from backend.app.db.models import OutboxEventORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services import graph_cache
from backend.app.services.activity import catalogue
from backend.app.services.aggregation import controlplane as cp
from backend.app.services.aggregation import internal_auth
from backend.app.services.aggregation import redis_client
from backend.app.services.aggregation import service as svc_mod
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
    AggregationJobORM,
    AggregationSettingsORM,
)
from backend.app.services.aggregation.schemas import (
    AggregationSkipRequest,
    AggregationTriggerRequest,
    AggregationTuning,
    BatchRefreshRequestInternal,
    JobLimitsPatch,
)
from backend.app.services.aggregation.service import AggregationService

ANA = Provenance(
    actor_id="usr_ana", stated_reason="Reload after the upstream fix",
    correlation_id="req-ana-1",
)


# ── Fixtures and fakes ────────────────────────────────────────────────


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
    yield async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


class _Dispatcher:
    def __init__(self):
        self.dispatched: list[str] = []

    async def dispatch(self, job_id):
        self.dispatched.append(job_id)


class _Redis:
    async def delete(self, *keys):
        return 0


@pytest.fixture(autouse=True)
def _no_redis(monkeypatch):
    monkeypatch.setattr(redis_client, "get_redis", lambda: _Redis())


def _service() -> AggregationService:
    return AggregationService(
        dispatcher=_Dispatcher(), registry=None, session_factory=None,
    )


def _resolving(monkeypatch, svc: AggregationService) -> None:
    """``trigger`` past the parts that need Postgres and a real ontology."""
    async def _claim(session, ds_id):
        return True

    async def _resolve(ds_id, session):
        return {
            "graph_name": "g_fin", "workspace_id": "ws_1", "provider_id": "prov_1",
            "data_source_label": "Ledger (at trigger)",
            "containment_edge_types": ["HAS"], "lineage_edge_types": ["FLOWS"],
        }

    monkeypatch.setattr(svc_mod, "claim_exclusive", _claim)
    monkeypatch.setattr(svc, "_resolve_ontology", _resolve)


def _job(status: str, **over) -> AggregationJobORM:
    fields = dict(
        id="agg_1", data_source_id="ds_1", workspace_id="ws_1", status=status,
        trigger_source="schedule", data_source_label="Ledger (old name)",
        progress=0, total_edges=0, processed_edges=0, created_edges=0,
        batch_size=1000, timeout_secs=3600, max_retries=3,
        created_at="2026-10-09T10:00:00+00:00",
    )
    fields.update(over)
    return AggregationJobORM(**fields)


def _source_rows() -> list:
    return [
        WorkspaceORM(id="ws_1", name="Finance"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(
            id="ds_1", workspace_id="ws_1", provider_id="prov_1",
            graph_name="g_fin", label="Ledger",
        ),
        AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1", aggregation_status="ready",
        ),
    ]


async def _seed(factory, *extra) -> None:
    async with factory() as s:
        s.add_all([*_source_rows(), *extra])
        await s.commit()


async def _events(session) -> list[tuple[str, dict]]:
    rows = (await session.execute(
        select(OutboxEventORM).order_by(OutboxEventORM.created_at)
    )).scalars().all()
    assert all(r.event_version == 2 for r in rows), "recorder envelope expected"
    return [(r.event_type, json.loads(r.payload)) for r in rows]


def _assert_filed_under_the_source(payload: dict) -> None:
    assert payload["actor_id"] == "usr_ana"
    assert payload["stated_reason"] == "Reload after the upstream fix"
    assert payload["correlation_id"] == "req-ana-1"
    assert (payload["workspace_id"], payload["data_source_id"]) == ("ws_1", "ds_1")
    assert (payload["target_type"], payload["target_id"]) == ("data_source", "ds_1")
    # Named as the source is named NOW, not as a job row froze it.
    assert payload["target_label"] == "Ledger"


# ── The trigger ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_persons_trigger_stamps_the_job_and_records_it_once(session_factory, monkeypatch):
    await _seed(session_factory)
    svc = _service()
    _resolving(monkeypatch, svc)

    async with session_factory() as s:
        job = await svc.trigger(
            "ds_1", AggregationTriggerRequest(), "manual", s, provenance=ANA,
        )
    assert (job.triggered_by, job.stated_reason) == ("usr_ana", "Reload after the upstream fix")

    async with session_factory() as s:
        row = await s.get(AggregationJobORM, job.id)
        assert (row.triggered_by, row.stated_reason) == ("usr_ana", "Reload after the upstream fix")
        [(event_type, payload)] = await _events(s)
    assert event_type == "aggregation.job.triggered"
    _assert_filed_under_the_source(payload)
    assert payload["details"] == {"jobId": job.id, "triggerSource": "manual"}

    # And the ledger reads it as a workspace's operation, by that person.
    projected = catalogue.project(
        event_type=event_type, payload=payload, event_version=2,
        aggregate_type="data_source", aggregate_id="ds_1",
    )
    assert (projected["category"], projected["audience"]) == ("operations", "workspace")
    assert (projected["actor_id"], projected["actor_kind"]) == ("usr_ana", "user")
    assert projected["stated_reason"] == "Reload after the upstream fix"


@pytest.mark.asyncio
async def test_a_trigger_whose_record_cannot_be_written_creates_no_job(session_factory, monkeypatch):
    """The record rides the job's transaction: no run without its record."""
    await _seed(session_factory)
    svc = _service()
    _resolving(monkeypatch, svc)

    async def _refuse(*a, **k):
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(svc_mod.recorder, "record_activity", _refuse)
    async with session_factory() as s:
        with pytest.raises(RuntimeError, match="outbox unavailable"):
            await svc.trigger("ds_1", AggregationTriggerRequest(), "manual", s, provenance=ANA)

    async with session_factory() as s:
        assert (await s.execute(select(AggregationJobORM))).scalars().all() == []
        assert await _events(s) == []
    assert svc._dispatcher.dispatched == []


@pytest.mark.asyncio
async def test_automation_stamps_nothing_and_records_nothing(session_factory, monkeypatch):
    await _seed(session_factory)
    svc = _service()
    _resolving(monkeypatch, svc)

    async with session_factory() as s:
        job = await svc.trigger("ds_1", AggregationTriggerRequest(), "schedule", s)
    async with session_factory() as s:
        row = await s.get(AggregationJobORM, job.id)
        assert (row.triggered_by, row.stated_reason) == (None, None)
        assert await _events(s) == []


@pytest.mark.asyncio
async def test_attribution_with_recording_off_stamps_the_job_only(session_factory, monkeypatch):
    await _seed(session_factory)
    svc = _service()
    _resolving(monkeypatch, svc)

    async with session_factory() as s:
        job = await svc.trigger(
            "ds_1", AggregationTriggerRequest(), "api", s,
            provenance=ANA.without_recording(),
        )
    async with session_factory() as s:
        assert (await s.get(AggregationJobORM, job.id)).triggered_by == "usr_ana"
        assert await _events(s) == []


@pytest.mark.asyncio
async def test_an_idempotent_replay_records_nothing_new(session_factory, monkeypatch):
    await _seed(session_factory)
    svc = _service()
    _resolving(monkeypatch, svc)

    async def _same_ontology(job, ds_id, session):
        return True

    monkeypatch.setattr(svc, "_replay_fingerprint_matches", _same_ontology)
    request = AggregationTriggerRequest(idempotencyKey="k-1")
    async with session_factory() as s:
        first = await svc.trigger("ds_1", request, "manual", s, provenance=ANA)
    async with session_factory() as s:
        again = await svc.trigger("ds_1", request, "manual", s, provenance=ANA)
    assert again.id == first.id
    async with session_factory() as s:
        assert [t for t, _ in await _events(s)] == ["aggregation.job.triggered"]


# ── Every other manual operation: one event each ──────────────────────


async def _resume(svc, s):
    await svc.resume("ds_1", "agg_1", s, provenance=ANA)


async def _cancel(svc, s):
    await svc.cancel("ds_1", "agg_1", s, provenance=ANA)


async def _delete(svc, s):
    await svc.delete_job("agg_1", s, provenance=ANA)


async def _limits(svc, s):
    await svc.set_job_limits(
        "ds_1", "agg_1", s, JobLimitsPatch(timeoutSecs=21_600, actor="usr_ana"),
        provenance=ANA,
    )


async def _purge(svc, s):
    await svc.claim_purge_job("ds_1", s, provenance=ANA)


async def _skip(svc, s):
    await svc.skip("ds_1", AggregationSkipRequest(confirmed=True), s, provenance=ANA)


async def _schedule(svc, s):
    await svc.set_schedule("ds_1", "0 */6 * * *", s, provenance=ANA)


@pytest.mark.asyncio
@pytest.mark.parametrize("event_type, job_status, operation, details", [
    ("aggregation.job.resumed", "failed", _resume, {"jobId": "agg_1"}),
    ("aggregation.job.cancelled", "pending", _cancel, {"jobId": "agg_1", "status": "pending"}),
    ("aggregation.job.deleted", "completed", _delete, {
        "jobId": "agg_1", "status": "completed", "triggerSource": "schedule",
        "createdAt": "2026-10-09T10:00:00+00:00",
    }),
    ("aggregation.job.limits_changed", "running", _limits, {
        "jobId": "agg_1", "changes": [{"field": "timeout_secs", "from": 3600, "to": 21_600}],
    }),
    ("aggregation.source.purged", None, _purge, None),
    ("aggregation.source.skipped", None, _skip, None),
    ("aggregation.source.schedule_changed", None, _schedule, {"from": None, "to": "0 */6 * * *"}),
])
async def test_each_manual_operation_records_one_event(
    session_factory, event_type, job_status, operation, details,
):
    await _seed(session_factory, *([_job(job_status)] if job_status else []))
    async with session_factory() as s:
        await operation(_service(), s)

    async with session_factory() as s:
        [(recorded, payload)] = await _events(s)
    assert recorded == event_type
    _assert_filed_under_the_source(payload)
    if details is not None:
        assert payload["details"] == details


@pytest.mark.asyncio
async def test_a_purge_job_carries_who_asked_for_it(session_factory):
    await _seed(session_factory)
    async with session_factory() as s:
        purge = await _service().claim_purge_job("ds_1", s, provenance=ANA)
    async with session_factory() as s:
        row = await s.get(AggregationJobORM, purge.id)
        [(_, payload)] = await _events(s)
    assert (row.trigger_source, row.triggered_by) == ("purge", "usr_ana")
    assert payload["details"] == {"jobId": purge.id, "reaggregate": True}


@pytest.mark.asyncio
async def test_a_fleet_default_change_records_who_and_what_and_fills_updated_by(session_factory):
    async with session_factory() as s:
        await _service().put_settings(
            s, AggregationTuning(scanRangeWidth=200_000), provenance=ANA,
        )
    async with session_factory() as s:
        assert (await s.get(AggregationSettingsORM, "global")).updated_by == "usr_ana"
        [(event_type, payload)] = await _events(s)
    assert event_type == "aggregation.settings.updated"
    assert payload["details"] == {"tuning": {"scanRangeWidth": 200_000}}
    assert "workspace_id" not in payload   # the fleet's, not a workspace's


# ── Refresh: one event per request, whatever it queued ────────────────


def _refreshing(monkeypatch, svc: AggregationService) -> list[dict]:
    calls: list[dict] = []

    async def _trigger(ds_id, request, trigger_source, session, **kw):
        calls.append(kw)
        return types.SimpleNamespace(id="agg_rebuild")

    async def _signal(ds_id, session, **kw):
        calls.append(kw)
        return types.SimpleNamespace(
            changed=True, job_id="agg_signal", deferred=False, event_id="evt_s",
        )

    async def _stale(*args):
        return None

    async def _scope_event(**kw):
        return "evt_scope"

    monkeypatch.setattr(svc, "trigger", _trigger)
    monkeypatch.setattr(svc, "signal_source_changed", _signal)
    monkeypatch.setattr(svc, "_emit_scope_event", _scope_event)
    monkeypatch.setattr(graph_cache, "mark_source_stale", _stale)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("scope, job_id, outcome", [
    ("rollups", "agg_rebuild", "accepted"),
    ("auto", "agg_signal", "changed"),
])
async def test_a_refresh_is_one_event_and_its_rebuild_is_the_persons(
    session_factory, monkeypatch, scope, job_id, outcome,
):
    await _seed(session_factory)
    svc = _service()
    calls = _refreshing(monkeypatch, svc)

    async with session_factory() as s:
        resp = await svc.refresh_source("ds_1", s, scope=scope, actor="usr_ana", provenance=ANA)
    assert resp.job_id == job_id

    # The rebuild is attributed to the person, with recording off.
    [passed] = calls
    assert passed["provenance"].actor_id == "usr_ana"
    assert passed["provenance"].record is False

    async with session_factory() as s:
        [(event_type, payload)] = await _events(s)
    assert event_type == "aggregation.source.refresh_requested"
    _assert_filed_under_the_source(payload)
    assert payload["details"] == {"scope": scope, "outcome": outcome, "jobId": job_id}


@pytest.mark.asyncio
async def test_a_refresh_whose_record_fails_still_succeeds(session_factory, monkeypatch):
    """The refresh has already happened in the caches and the graph by the
    time it is recorded: a failed record is logged, not raised."""
    from backend.app.db.repositories import outbox_event_repo

    await _seed(session_factory)
    svc = _service()
    _refreshing(monkeypatch, svc)

    async def _refuse(*a, **k):
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(outbox_event_repo, "emit", _refuse)
    async with session_factory() as s:
        resp = await svc.refresh_source("ds_1", s, scope="rollups", provenance=ANA)
    assert resp.job_id == "agg_rebuild"
    async with session_factory() as s:
        assert await _events(s) == []


@pytest.mark.asyncio
async def test_a_scripted_refresh_records_nothing_and_passes_no_one_on(session_factory, monkeypatch):
    await _seed(session_factory)
    svc = _service()
    calls = _refreshing(monkeypatch, svc)

    async with session_factory() as s:
        await svc.refresh_source("ds_1", s, scope="rollups", origin="script")
    assert calls == [{}]
    async with session_factory() as s:
        assert await _events(s) == []


# ── Provider batch: one event for the batch ───────────────────────────


@pytest.mark.asyncio
async def test_a_provider_batch_is_one_event_and_every_rebuild_is_the_persons(
    session_factory, monkeypatch,
):
    await _seed(session_factory)
    scheduled = []

    def _create_task(coro, **kw):
        scheduled.append(coro)
        coro.close()
        return types.SimpleNamespace()

    class _LockRedis:
        async def set(self, *a, **k):
            return True

    monkeypatch.setattr(redis_client, "get_redis", lambda: _LockRedis())
    request = types.SimpleNamespace(
        app=types.SimpleNamespace(state=types.SimpleNamespace(session_factory=None)),
    )
    token = activity_context.bind(ActivityContext(
        actor_id="usr_ana", stated_reason="Reload after the upstream fix",
        correlation_id="req-ana-1",
    ))
    try:
        async with session_factory() as s:
            # ``cp.asyncio`` is THE asyncio: unpatched before the session closes.
            with monkeypatch.context() as patched:
                patched.setattr(cp.asyncio, "create_task", _create_task)
                started = await cp.start_refresh_batch(
                    "prov_1", request, body=BatchRefreshRequestInternal(scope="rollups"),
                    svc=_service(), session=s,
                )
    finally:
        activity_context.reset(token)
    assert len(scheduled) == 1

    async with session_factory() as s:
        [(event_type, payload)] = await _events(s)
    assert event_type == "aggregation.provider.refresh_requested"
    assert (payload["target_type"], payload["target_id"], payload["target_label"]) == (
        "provider", "prov_1", "Prod graph",
    )
    assert payload["details"] == {
        "batchId": started.batch_id, "scope": "rollups", "dataSources": 1,
    }

    # The runner hands every item the person, with recording off.
    seen = []

    class _Svc:
        async def refresh_source(self, ds_id, session, **kw):
            seen.append(kw["provenance"])
            return types.SimpleNamespace(job_id=f"job-{ds_id}", actions=[], deferred=False)

    class _HashRedis:
        async def hset(self, *a, **k):
            return 1

        async def expire(self, *a):
            return True

        async def hincrby(self, *a):
            return 1

        async def delete(self, *a):
            return 1

    class _Session:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *exc):
            return False

    await cp._run_provider_batch(
        "b-1", "prov_1", [("ds_1", "Ledger"), ("ds_2", "Budget")],
        BatchRefreshRequestInternal(scope="rollups"),
        svc=_Svc(), session_factory=_Session, redis=_HashRedis(), provenance=ANA,
    )
    assert [(p.actor_id, p.record) for p in seen] == [("usr_ana", False)] * 2


# ── Across the hop to the control plane ───────────────────────────────


def _cp_client(monkeypatch, svc) -> httpx.AsyncClient:
    """The real control-plane app, in process, behind its token."""
    async def _no_session():
        yield None

    monkeypatch.setenv(internal_auth.INTERNAL_TOKEN_ENV, "s3cret")
    monkeypatch.setitem(cp.app.dependency_overrides, cp._get_svc, lambda: svc)
    monkeypatch.setitem(cp.app.dependency_overrides, cp._get_session, _no_session)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=cp.app), base_url="http://cp",
        headers={"Authorization": "Bearer s3cret"},
    )


class _DeletingSvc:
    def __init__(self):
        self.provenance = "never called"

    async def delete_job(self, job_id, session, provenance=None):
        self.provenance = provenance


@pytest.mark.asyncio
async def test_attribution_survives_the_hop_from_the_session_not_the_client(
    test_client, monkeypatch,
):
    svc = _DeletingSvc()
    monkeypatch.setattr(agg_endpoints, "_PROXY_ENABLED", True)
    async with _cp_client(monkeypatch, svc) as control_plane:
        monkeypatch.setattr(agg_endpoints, "_get_proxy_client", lambda: control_plane)
        resp = await test_client.delete(
            "/api/v1/admin/aggregation-jobs/agg_1",
            headers={
                "X-Activity-Reason": quote("Stale run from a test, clearing"),
                "X-Request-ID": "req-hop-1",
                # A client cannot name someone else as the actor.
                activity_context.ACTOR_HEADER: "usr_mallory",
            },
        )
    assert resp.status_code == 204
    assert svc.provenance == Provenance(
        actor_id="usr_test000000",
        stated_reason="Stale run from a test, clearing",
        correlation_id="req-hop-1",
    )


@pytest.mark.asyncio
async def test_the_control_plane_takes_the_person_only_behind_its_token(monkeypatch):
    svc = _DeletingSvc()
    async with _cp_client(monkeypatch, svc) as client:
        refused = await client.delete(
            "/aggregation/jobs/agg_1",
            headers={"Authorization": "Bearer wrong", activity_context.ACTOR_HEADER: "usr_ana"},
        )
        assert refused.status_code == 401
        assert svc.provenance == "never called"

        # A malformed actor is dropped, not trusted: no person, no record.
        await client.delete(
            "/aggregation/jobs/agg_1",
            headers={activity_context.ACTOR_HEADER: "usr ana; drop table"},
        )
        assert svc.provenance is None

        await client.delete(
            "/aggregation/jobs/agg_1",
            headers={activity_context.ACTOR_HEADER: "usr_ana", "X-Request-ID": "req-2"},
        )
        assert svc.provenance == Provenance(actor_id="usr_ana", correlation_id="req-2")


# ── The public routes (direct mode) ───────────────────────────────────


@pytest.fixture
def web_service():
    from backend.app.main import app

    previous = getattr(app.state, "aggregation_service", None)
    app.state.aggregation_service = _service()
    yield app.state.aggregation_service
    app.state.aggregation_service = previous


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["schedule", "drift", "reconcile", "auto", "post_purge", "purge"])
async def test_the_public_trigger_refuses_what_only_automation_may_mint(
    test_client, db_session, web_service, source,
):
    db_session.add_all(_source_rows())
    await db_session.commit()
    resp = await test_client.post(
        f"/api/v1/admin/data-sources/ds_1/aggregation-jobs?triggerSource={source}", json={},
    )
    assert resp.status_code == 422
    assert (await db_session.execute(select(AggregationJobORM))).scalars().all() == []


@pytest.mark.asyncio
async def test_a_direct_mode_change_is_recorded_as_the_signed_in_person(
    test_client, db_session, web_service,
):
    db_session.add_all(_source_rows())
    await db_session.commit()
    resp = await test_client.put(
        "/api/v1/admin/data-sources/ds_1/aggregation-schedule",
        json={"cronExpression": "0 3 * * *"},
        headers={"X-Activity-Reason": quote("Nightly, after the ETL"), "X-Request-ID": "req-web-1"},
    )
    assert resp.status_code == 204

    [(event_type, payload)] = await _events(db_session)
    assert event_type == "aggregation.source.schedule_changed"
    assert payload["actor_id"] == "usr_test000000"
    assert payload["stated_reason"] == "Nightly, after the ETL"
    assert payload["correlation_id"] == "req-web-1"


@pytest.mark.asyncio
async def test_job_history_filters_by_who_started_a_run(session_factory):
    await _seed(
        session_factory,
        _job("completed", id="agg_ana", triggered_by="usr_ana", created_at="2026-10-09T10:00:00+00:00"),
        _job("completed", id="agg_bo", triggered_by="usr_bo", created_at="2026-10-09T11:00:00+00:00"),
        _job("completed", id="agg_cron", created_at="2026-10-09T12:00:00+00:00"),
    )
    async with session_factory() as s:
        page = await _service().list_jobs_global(s, triggered_by="usr_ana")
    assert [j.id for j in page.items] == ["agg_ana"] and page.total == 1
    assert page.items[0].triggered_by == "usr_ana"
