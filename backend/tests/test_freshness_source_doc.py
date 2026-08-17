"""Real-session tests for the ``last_finding_*`` columns on the freshness
source doc.

``test_freshness_endpoints.py`` exercises ``_state_map`` against a
``_FakeSession`` (direct-handler-call style) and has no ``session_factory``
fixture, so it can't stand in for the thing under test here: parsing the
stored JSON evidence column against a real row. Fixture copied verbatim from
``test_reconcile_sweeper.py``.
"""
import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

from backend.app.db.engine import Base


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


@pytest.mark.asyncio
async def test_source_doc_carries_the_live_finding_evidence(session_factory):
    """The sweep stamps why a source is drifting on every evaluation; the
    doc must carry it, or the drawer has nothing to explain the verdict with."""
    import json
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import _state_map

    evidence = {
        "rawNodeCountBefore": 500500, "rawNodeCountAfter": 500340,
        "expectedAggregatedEdges": 50000, "observedAggregatedEdges": 0,
    }
    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
            drift_state="drifting",
            last_finding_at="2026-08-17T09:00:00+00:00",
            last_finding_reason="overlay_missing",
            last_finding_evidence=json.dumps(evidence),
        ))
        await s.commit()

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]

    assert state["last_finding_at"] == "2026-08-17T09:00:00+00:00"
    assert state["last_finding_reason"] == "overlay_missing"
    assert state["last_finding_evidence"] == evidence


@pytest.mark.asyncio
async def test_unparseable_finding_evidence_degrades_to_none(session_factory):
    """A malformed evidence blob must not take out the whole freshness read."""
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import _state_map

    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
            last_finding_evidence="{not json",
        ))
        await s.commit()

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]

    assert state["last_finding_evidence"] is None
