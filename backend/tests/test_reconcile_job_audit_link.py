"""The two halves of the reconciliation audit trail must meet.

``refresh_events`` knows WHY a rebuild was decided on. ``aggregation.jobs``
knows WHAT the rebuild did. Before this they were disconnected in both
directions:

  * every rebuild the sweep queued went through ``signal_source_changed``,
    which hardcoded ``trigger_source='api'`` — so an hourly automatic
    reconciliation was indistinguishable in Job History from a person clicking
    Rebuild, which is the one question the audit trail exists to answer;
  * ``refresh_events`` never recorded which job it produced, so neither
    surface could link to the other.

These tests pin the join in both directions.
"""
import json

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

from backend.app.db.engine import Base
from backend.app.db.models import RefreshEventORM
from backend.app.services.aggregation.models import (
    TRIGGER_SOURCES,
    AggregationJobORM,
)
from backend.app.services.aggregation.service import _reconcile_reason_map


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
    yield async_sessionmaker(
        bind=engine, class_=AsyncSession, expire_on_commit=False,
    )
    await engine.dispose()


_EVIDENCE = {
    "expectedAggregatedEdges": 1_204_318,
    "observedAggregatedEdges": 0,
    "statsAsOf": "2026-08-14T09:12:00+00:00",
}


def _job(job_id, trigger_source):
    return AggregationJobORM(
        id=job_id, data_source_id="ds_1", workspace_id="ws_1",
        status="completed", trigger_source=trigger_source,
        created_at="2026-08-14T10:00:00+00:00",
        updated_at="2026-08-14T10:05:00+00:00",
    )


def test_reconcile_is_a_real_trigger_source():
    """Job History filters on this value, and the CHECK constraint mirrors the
    tuple — so a missing entry is a 500 at insert time, not a UI nicety."""
    assert "reconcile" in TRIGGER_SOURCES


def test_the_migration_and_the_orm_agree_on_trigger_sources():
    """``ck_agg_jobs_trigger_source`` is built from ``TRIGGER_SOURCES`` in the
    ORM and spelled out literally in the migration. If the two ever drift, the
    schema CI gate fails in a way that is hard to read from the diff — so
    compare the actual expressions, not the intent."""
    import pathlib
    import re

    orm = "trigger_source IN ({})".format(
        ", ".join(f"'{s}'" for s in TRIGGER_SOURCES)
    )
    migration = (
        pathlib.Path(__file__).parent.parent
        / "alembic" / "versions" / "20260814_1600_recon_audit_link.py"
    ).read_text()
    block = re.search(r"_TRIGGERS_AFTER = \(\n(.*?)\n\)", migration, re.S)
    assert block, "the migration no longer declares _TRIGGERS_AFTER"
    assert "".join(re.findall(r'"([^"]*)"', block.group(1))) == orm


@pytest.mark.asyncio
async def test_the_reason_reaches_job_history(session_factory):
    async with session_factory() as s:
        s.add(_job("agg_1", "reconcile"))
        s.add(RefreshEventORM(
            id="ev_1", ts="2026-08-14T10:00:00+00:00",
            workspace_id="ws_1", data_source_id="ds_1",
            origin="reconcile-sweep", actor="internal", scope="auto",
            gate="changed", outcome="accepted",
            reason="overlay_missing", evidence=json.dumps(_EVIDENCE),
            job_id="agg_1",
        ))
        await s.commit()

    async with session_factory() as s:
        jobs = (await s.execute(select(AggregationJobORM))).scalars().all()
        why = await _reconcile_reason_map(s, jobs)

    assert why["agg_1"]["reason"] == "overlay_missing"
    # Parsed, not a JSON string — the response model declares a dict.
    assert why["agg_1"]["evidence"]["expectedAggregatedEdges"] == 1_204_318


@pytest.mark.asyncio
async def test_a_page_with_no_automatic_rebuilds_costs_no_query(session_factory):
    """Filtered on trigger_source BEFORE querying, so the ordinary Job History
    page — which is almost entirely manual and onboarding jobs — pays nothing
    for this feature."""
    async with session_factory() as s:
        s.add(_job("agg_2", "manual"))
        s.add(_job("agg_3", "onboarding"))
        await s.commit()

    async with session_factory() as s:
        jobs = (await s.execute(select(AggregationJobORM))).scalars().all()
        # A session that would raise if used proves the early return.
        assert await _reconcile_reason_map(None, jobs) == {}
        assert await _reconcile_reason_map(s, jobs) == {}


@pytest.mark.asyncio
async def test_only_reconciliation_jobs_are_looked_up(session_factory):
    """A manual job that happens to have an audit event must not borrow its
    reason — 'a person did this' and 'automation did this' are exactly the
    distinction being drawn."""
    async with session_factory() as s:
        s.add(_job("agg_4", "manual"))
        s.add(RefreshEventORM(
            id="ev_2", ts="2026-08-14T10:00:00+00:00",
            workspace_id="ws_1", data_source_id="ds_1",
            origin="api", actor="someone@example.com", scope="auto",
            gate="changed", outcome="accepted", job_id="agg_4",
        ))
        await s.commit()

    async with session_factory() as s:
        jobs = (await s.execute(select(AggregationJobORM))).scalars().all()
        assert await _reconcile_reason_map(s, jobs) == {}


@pytest.mark.asyncio
async def test_a_retried_job_keeps_its_newest_reason(session_factory):
    async with session_factory() as s:
        s.add(_job("agg_5", "reconcile"))
        for ts, reason in (
            ("2026-08-14T09:00:00+00:00", "raw_drift"),
            ("2026-08-14T11:00:00+00:00", "overlay_missing"),
        ):
            s.add(RefreshEventORM(
                id=f"ev_{ts}", ts=ts, workspace_id="ws_1",
                data_source_id="ds_1", origin="reconcile-sweep",
                actor="internal", scope="auto", gate="changed",
                outcome="accepted", reason=reason, job_id="agg_5",
            ))
        await s.commit()

    async with session_factory() as s:
        jobs = (await s.execute(select(AggregationJobORM))).scalars().all()
        why = await _reconcile_reason_map(s, jobs)

    assert why["agg_5"]["reason"] == "overlay_missing"


@pytest.mark.asyncio
async def test_unparseable_evidence_degrades_to_none(session_factory):
    """The audit trail must never be able to break the page that renders it."""
    async with session_factory() as s:
        s.add(_job("agg_6", "reconcile"))
        s.add(RefreshEventORM(
            id="ev_3", ts="2026-08-14T10:00:00+00:00", workspace_id="ws_1",
            data_source_id="ds_1", origin="reconcile-sweep", actor="internal",
            scope="auto", gate="changed", outcome="accepted",
            reason="raw_drift", evidence="{not json", job_id="agg_6",
        ))
        await s.commit()

    async with session_factory() as s:
        jobs = (await s.execute(select(AggregationJobORM))).scalars().all()
        why = await _reconcile_reason_map(s, jobs)

    assert why["agg_6"] == {"reason": "raw_drift", "evidence": None}
