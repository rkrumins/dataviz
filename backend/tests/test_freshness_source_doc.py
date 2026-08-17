"""Real-session tests for freshness-doc columns that need a real DB row:
the ``last_finding_*`` columns (Task 1) and the per-source probe override
(Task 2).

``test_freshness_endpoints.py`` exercises ``_state_map`` against a
``_FakeSession`` (direct-handler-call style) and has no ``session_factory``
fixture, so it can't stand in for the thing under test here: parsing the
stored columns against a real row. Fixture copied verbatim from
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


@pytest.mark.asyncio
async def test_probe_settings_round_trip_and_report_their_source(session_factory):
    """A per-source detect override must be settable, readable, and must say
    where the effective value came from — otherwise the drawer cannot show
    "Using default" versus "Overridden"."""
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import (
        AggregationService, _state_map, resolve_probe_interval,
    )

    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
        ))
        await s.commit()

    svc = AggregationService.__new__(AggregationService)
    async with session_factory() as s:
        stored = await svc.set_source_probe_settings(
            "ds_1", s, enabled=False, interval_secs=30,
        )
    assert stored == {"probe_enabled": False, "probe_interval_secs": 30}

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]
    assert state["probe_enabled"] is False
    assert state["probe_interval_secs"] == 30

    # Resolution: override wins, then global, then env.
    assert resolve_probe_interval(30, 120) == 30
    assert resolve_probe_interval(None, 120) == 120


@pytest.mark.asyncio
async def test_clearing_a_probe_override_falls_back(session_factory):
    """Explicit None clears the override; False must NOT be read as unset."""
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import (
        AggregationService, _state_map,
    )

    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
            probe_enabled=False, probe_interval_secs=30,
        ))
        await s.commit()

    svc = AggregationService.__new__(AggregationService)
    async with session_factory() as s:
        await svc.set_source_probe_settings("ds_1", s, interval_secs=None)

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]
    assert state["probe_interval_secs"] is None
    # Untouched key keeps its value — partial update, not a wipe.
    assert state["probe_enabled"] is False


def test_freshness_row_kwargs_leaks_doc_only_keys_but_row_ignores_them():
    """``_freshness_row_kwargs``'s dict is spread into BOTH
    ``FreshnessRow(**kwargs)`` and ``FreshnessDoc(**kwargs)`` (see
    ``assemble_fleet_freshness`` / ``assemble_source_freshness``). It already
    carries ``last_finding_*`` keys that only ``FreshnessDoc`` declares --
    this works only because pydantic defaults to ``extra="ignore"``. Locking
    it down because three tasks now depend on this reuse holding, and no
    real DB row is needed to prove it (the function is pure)."""
    import types
    from backend.app.services.aggregation.schemas import FreshnessRow
    from backend.app.services.aggregation.service import _freshness_row_kwargs

    ds = types.SimpleNamespace(
        id="ds_1", workspace_id="ws_1", provider_id="prov_1", label="Orders",
        aggregation_status="ready", last_aggregated_at=None,
        graph_fingerprint="fp",
    )
    kwargs = _freshness_row_kwargs(
        ds, provider_name=None, signals=(None, None, None),
        running_job_id=None, last_event=None,
    )
    assert "last_finding_reason" in kwargs  # Doc-only key, present regardless

    row = FreshnessRow(**kwargs)
    assert not hasattr(row, "last_finding_reason")
