"""Integration tests for the reconciliation sweep.

Runs against a real in-memory SQLite database (the ``aggregation`` schema is
attached, matching conftest) with a fake aggregation service, so the batched
reads, the two-phase structure, the caps and the persistence are all
genuinely exercised rather than mocked away.

The regressions locked down here are the expensive ones:

  * the FIRST sweep over a fleet with no baseline must SEED and dispatch
    nothing — otherwise turning this on rebuilds every source at once,
  * a source whose stats row predates its last rebuild must not be acted on,
    or it re-fires the same finding forever,
  * the sweeper must never be able to reach a graph provider,
  * a preview must write no dispatches.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

from backend.app.db.engine import Base
from backend.app.db.models import (
    DataSourcePollingConfigORM,
    DataSourceStatsORM,
    ProviderORM,
    RefreshEventORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.aggregation.fingerprint import (
    raw_fingerprint_from_counts,
)
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
    AggregationJobORM,
    ReconcileRunORM,
)
from backend.app.services.aggregation.reconcile_sweeper import (
    ReconciliationSweeper,
)
from backend.app.services.aggregation.schemas import SourceChangedResponse


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _ago(**kw) -> str:
    return _iso(datetime.now(timezone.utc) - timedelta(**kw))


# ── Fixtures ────────────────────────────────────────────────────────────


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


@pytest.fixture(autouse=True)
def _no_redis(monkeypatch):
    """Stub the fleet-wide stale-marker SCAN.

    There is no Redis here, so the real call spends its full timeout failing
    to connect on every sweep. That timeout is correct production behaviour
    (see ``_STALE_SCAN_TIMEOUT_S``) and is not what these tests are about, so
    they return an explicit marker set instead. ``_marked`` lets a test opt
    into the marked case.
    """
    marked: list = []

    async def _fake_list_stale_sources():
        return [("ws_1", ds) for ds in marked]

    monkeypatch.setattr(
        "backend.app.services.graph_cache.list_stale_sources",
        _fake_list_stale_sources,
    )
    return marked


@pytest.fixture(autouse=True)
def _versioned(monkeypatch):
    """Stub the versioned-data-source lookup.

    It reads the ``graphver`` store through its own engine, which does not
    exist here — and a cold failure correctly DEFERS the whole sweep, so
    without this every test below would assert against a sweep that never ran.
    Returns a mutable set a test can add to in order to make a source
    platform-mastered.
    """
    versioned: set = set()

    async def _fake_versioned_ids(**_kw):
        return frozenset(versioned)

    monkeypatch.setattr(
        "backend.app.services.versioned_sources.versioned_data_source_ids",
        _fake_versioned_ids,
    )
    return versioned


class _FakeJob:
    id = "agg_fake"


class _FakeService:
    """Records dispatches instead of performing them."""

    def __init__(self):
        self.signals = []
        self.triggers = []

    async def signal_source_changed(self, ds_id, session, **kw):
        self.signals.append((ds_id, kw))
        return None

    async def trigger(self, ds_id, request, trigger_source, session):
        self.triggers.append((ds_id, trigger_source, request.idempotency_key))
        return _FakeJob()


async def _seed(
    factory,
    *,
    ds_id="ds_1",
    entity_counts=None,
    edge_counts=None,
    stats_age_secs=60,
    agg_status="ready",
    expected_edges=500,
    raw_fingerprint="__match__",
    last_aggregated_ago_secs=86_400,
    ontology_id="bp_1",
    projection_mode=None,
    checked_at=None,
    consecutive=0,
    reconcile_enabled=None,
    job_rows=(("completed", 86_400),),
    polling_enabled=True,
    polling_status="success",
):
    """Create one data source with everything the sweep reads.

    ``raw_fingerprint="__match__"`` stores the fingerprint the observed counts
    will produce, i.e. "no drift". Pass ``None`` for a never-seen source, or a
    literal for a mismatch.
    """
    entity_counts = entity_counts if entity_counts is not None else {"Table": 100}
    edge_counts = (
        edge_counts if edge_counts is not None
        else {"FLOWS_TO": 200, "AGGREGATED": 500}
    )
    observed_fp, _, raw_edges = raw_fingerprint_from_counts(
        entity_counts, edge_counts,
    )
    if raw_fingerprint == "__match__":
        raw_fingerprint = observed_fp

    async with factory() as s:
        # Shared parents — _seed is called repeatedly to build a fleet.
        if await s.get(WorkspaceORM, "ws_1") is None:
            s.add(WorkspaceORM(id="ws_1", name="ws"))
            s.add(ProviderORM(
                id="prov_1", name="p", provider_type="falkordb",
                host="h", port=1, credentials="{}",
            ))
            await s.flush()
        s.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id="ws_1", provider_id="prov_1",
            graph_name=f"g_{ds_id}", ontology_id=ontology_id,
            projection_mode=projection_mode,
            label=f"Label for {ds_id}",
        ))
        s.add(DataSourceStatsORM(
            data_source_id=ds_id,
            node_count=sum(entity_counts.values()),
            edge_count=sum(edge_counts.values()),
            entity_type_counts=json.dumps(entity_counts),
            edge_type_counts=json.dumps(edge_counts),
            updated_at=_ago(seconds=stats_age_secs),
        ))
        s.add(DataSourcePollingConfigORM(
            data_source_id=ds_id, is_enabled=polling_enabled,
            last_status=polling_status,
        ))
        s.add(AggregationDataSourceStateORM(
            data_source_id=ds_id, workspace_id="ws_1",
            aggregation_status=agg_status,
            aggregation_edge_count=expected_edges,
            last_aggregated_at=(
                _ago(seconds=last_aggregated_ago_secs)
                if last_aggregated_ago_secs is not None else None
            ),
            raw_fingerprint=raw_fingerprint,
            raw_node_count=sum(entity_counts.values()),
            raw_edge_count=raw_edges,
            last_reconcile_checked_at=checked_at,
            reconcile_consecutive_actions=consecutive,
            reconcile_enabled=reconcile_enabled,
        ))
        for i, (status, age) in enumerate(job_rows):
            s.add(AggregationJobORM(
                id=f"agg_{ds_id}_{i}", data_source_id=ds_id,
                workspace_id="ws_1", status=status,
                updated_at=_ago(seconds=age), created_at=_ago(seconds=age),
            ))
        await s.commit()


async def _state(factory, ds_id="ds_1"):
    async with factory() as s:
        return await s.get(AggregationDataSourceStateORM, ds_id)


# ── Structural guarantee ────────────────────────────────────────────────


def test_sweeper_auto_path_has_no_provider_registry():
    """Auto ticks must stay SQL-only. Live observe goes through the
    aggregation service's registry when present — not a constructor arg."""
    import inspect

    params = inspect.signature(ReconciliationSweeper.__init__).parameters
    assert set(params) == {"self", "session_factory", "service_getter"}
    assert not hasattr(ReconciliationSweeper(lambda: None), "_registry")


@pytest.mark.asyncio
async def test_manual_live_observe_finds_raw_drift(session_factory, monkeypatch):
    """Check now refreshes counts before evaluate — a delete shows up."""
    await _seed(session_factory, checked_at=_ago(seconds=30))

    async def _fake_live(self, ctx, targets):
        for ds_id, _ws in targets:
            # One fewer node than the seeded baseline fingerprint.
            from backend.app.services.aggregation.fingerprint import (
                raw_fingerprint_from_counts,
            )
            entity = {"Table": 99}
            edges = {"FLOWS_TO": 200, "AGGREGATED": 500}
            fp, observed_agg, raw_edges = raw_fingerprint_from_counts(entity, edges)
            ctx.setdefault(ds_id, {}).update(
                has_stats=True, stats_age_secs=0,
                stats_as_of=_ago(seconds=0),
                stats_updated=datetime.now(timezone.utc),
                node_count=99, observed_aggregated=observed_agg,
                observed_raw_fingerprint=fp, observed_raw_edge_total=raw_edges,
                live_observed=True,
            )

    monkeypatch.setattr(
        ReconciliationSweeper, "_live_observe_counts", _fake_live,
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep(
        mode="manual",
    )
    assert result is not None
    assert result.scanned == 1
    assert result.findings == 1
    assert result.by_reason.get("raw_drift") == 1
    st = await _state(session_factory)
    assert st.drift_state == "drifting"


@pytest.mark.asyncio
async def test_stats_stale_does_not_stamp_in_sync(session_factory):
    """An unevaluated skip must not claim the overlay is healthy."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        stats_age_secs=3_600,
        last_aggregated_ago_secs=60,
    )
    # Prior finding stamp — must survive a stats_stale skip.
    async with session_factory() as s:
        st = await s.get(AggregationDataSourceStateORM, "ds_1")
        st.drift_state = "overlayMissing"
        await s.commit()

    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result.by_skip == {"stats_stale": 1}
    assert (await _state(session_factory)).drift_state == "overlayMissing"


# ── The first-sweep storm regression ────────────────────────────────────


@pytest.mark.asyncio
async def test_first_sweep_seeds_and_dispatches_nothing(session_factory):
    """No baseline means no drift verdict is possible. Acting here would
    rebuild the entire fleet the moment this feature is switched on."""
    for i in range(5):
        await _seed(
            session_factory, ds_id=f"ds_{i}", raw_fingerprint=None,
        )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.scanned == 5
    assert result.seeded == 5
    assert result.actions == 0
    assert svc.signals == [] and svc.triggers == []

    st = await _state(session_factory, "ds_0")
    assert st.raw_fingerprint is not None  # baseline adopted
    assert st.last_reconcile_checked_at is not None


# ── Detection end to end ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wiped_overlay_is_detected_and_signalled(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},  # AGGREGATED absent entirely
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.findings == 1
    assert result.actions == 1
    assert result.by_reason == {"overlay_missing": 1}

    ds_id, kw = svc.signals[0]
    assert ds_id == "ds_1"
    assert kw["origin"] == "reconcile-sweep"
    # The job this queues must be identifiable as automatic in Job History.
    # signal_source_changed hardcoded "api", so without this an hourly
    # automatic rebuild looked exactly like a person clicking Rebuild.
    assert kw["trigger_source"] == "reconcile"
    assert kw["audit_reason"] == "overlay_missing"
    assert kw["evidence"]["expectedAggregatedEdges"] == 500
    assert kw["evidence"]["observedAggregatedEdges"] == 0

    st = await _state(session_factory)
    assert st.drift_state == "overlayMissing"
    assert st.last_reconcile_reason == "overlay_missing"
    assert st.last_reconciled_at is not None
    assert st.reconcile_consecutive_actions == 1


@pytest.mark.asyncio
async def test_raw_drift_is_detected_with_before_and_after_counts(session_factory):
    await _seed(session_factory, raw_fingerprint="fp_old")
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_reason == {"raw_drift": 1}
    _, kw = svc.signals[0]
    assert kw["evidence"]["rawFingerprintBefore"] == "fp_old"
    assert kw["evidence"]["rawFingerprintAfter"] != "fp_old"
    st = await _state(session_factory)
    assert st.drift_state == "drifting"


@pytest.mark.asyncio
async def test_never_built_source_gets_a_first_build_via_trigger(session_factory):
    """It must NOT go through signal_source_changed — that path treats a
    'none' status as not-applicable by design and would be a no-op."""
    await _seed(
        session_factory,
        agg_status="none", expected_edges=0, raw_fingerprint=None,
        edge_counts={"FLOWS_TO": 200}, job_rows=(),
        last_aggregated_ago_secs=None,
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_reason == {"never_aggregated": 1}
    assert svc.signals == []
    ds_id, trigger_source, idem = svc.triggers[0]
    # 'reconcile', NOT 'schedule': the latter means the cron-driven
    # AggregationScheduler, and Job History filters on this value — a first
    # build queued here belongs with the other three detectors.
    assert (ds_id, trigger_source) == ("ds_1", "reconcile")
    assert idem.startswith("reconcile:first:ds_1:")

    async with session_factory() as s:
        events = (await s.execute(select(RefreshEventORM))).scalars().all()
    assert len(events) == 1
    assert events[0].origin == "reconcile-sweep"
    assert events[0].reason == "never_aggregated"
    # The audit event names the job it produced, so a reader can cross from
    # "why we rebuilt" to "what the rebuild did".
    assert events[0].job_id == "agg_fake"
    assert events[0].run_id == result.run_id


@pytest.mark.asyncio
async def test_healthy_source_is_left_alone(session_factory):
    await _seed(session_factory)
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.findings == 0
    assert result.by_skip == {"in_sync": 1}
    assert svc.signals == []
    assert (await _state(session_factory)).drift_state == "inSync"


# ── Guards that matter most ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stats_predating_the_last_rebuild_are_not_evidence(session_factory):
    """A source rebuilt two minutes ago still reports its PRE-rebuild
    AGGREGATED count. Acting on that re-fires the same finding forever."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},   # looks wiped…
        stats_age_secs=3_600,            # …but the stats predate the rebuild
        last_aggregated_ago_secs=60,
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.actions == 0
    assert result.by_skip == {"stats_stale": 1}
    assert svc.signals == []


@pytest.mark.asyncio
async def test_dedicated_projection_is_never_read_as_a_wiped_overlay(session_factory):
    """Its AGGREGATED edges live in another graph that get_stats() never
    scans, so the observed count is permanently 0 — and dedicated projection
    is used for the LARGEST graphs."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        projection_mode="dedicated",
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.actions == 0
    assert svc.signals == []
    assert (await _state(session_factory)).drift_state == "unobservable"


@pytest.mark.asyncio
async def test_versioned_source_is_evaluated_but_never_dispatched(
    session_factory, _versioned,
):
    """A versioned source is mastered in Postgres with FalkorDB as a
    rebuildable read cache. When the projection is not fresh the stats scan
    runs against Postgres, which has no :AGGREGATED rows at all — so a healthy
    source reports zero rollups. Acting on that queues a full rebuild of a
    graph that may not currently exist, and the job stamps ``_AggMeta``, which
    stalls the next projection and reproduces the same reading next sweep.
    """
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    _versioned.add("ds_1")

    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.scanned == 1
    assert result.findings == 0
    assert result.actions == 0
    # The structural assertion: nothing was handed to the service at all.
    assert svc.signals == [] and svc.triggers == []
    assert result.by_skip.get("platform_mastered") == 1

    state = await _state(session_factory)
    assert state.drift_state == "managed"
    assert state.last_reconcile_checked_at is not None
    assert state.last_reconciled_at is None


@pytest.mark.asyncio
async def test_versioned_source_still_advances_its_baseline(
    session_factory, _versioned,
):
    """Never acted on, but the baseline keeps moving — otherwise a source
    later taken back out of versioning reads as drifted on its first sweep
    afterwards, from counts that changed while nobody was watching."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 900, "AGGREGATED": 500},
        raw_fingerprint="fp_stale",
    )
    _versioned.add("ds_1")

    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()

    state = await _state(session_factory)
    assert state.raw_fingerprint != "fp_stale"
    assert state.raw_edge_count == 900


@pytest.mark.asyncio
async def test_a_cold_versioned_lookup_defers_the_whole_sweep(
    session_factory, monkeypatch,
):
    """Both fail-open answers are wrong — assuming nothing is versioned loses
    the guard, assuming everything is stops reconciling the fleet — so the
    sweep defers instead, and must not stamp a verdict on the way out."""
    from backend.app.services.versioned_sources import (
        VersionedLookupUnavailable,
    )

    async def _unavailable(**_kw):
        raise VersionedLookupUnavailable("graphver unreachable")

    monkeypatch.setattr(
        "backend.app.services.versioned_sources.versioned_data_source_ids",
        _unavailable,
    )
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})

    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result is None
    assert svc.signals == [] and svc.triggers == []
    state = await _state(session_factory)
    assert state.drift_state is None
    assert state.last_reconcile_checked_at is None


@pytest.mark.asyncio
async def test_a_paused_source_records_its_finding_but_queues_nothing(
    session_factory,
):
    """The whole point of a hold: the cockpit still knows what is wrong."""
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    async with session_factory() as s:
        state = await s.get(AggregationDataSourceStateORM, "ds_1")
        state.paused_until = "2999-01-01T00:00:00+00:00"
        await s.commit()

    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_skip.get("paused") == 1
    assert svc.signals == [], "a paused source must not be dispatched"
    state = await _state(session_factory)
    assert state.last_finding_reason == "overlay_missing"


@pytest.mark.asyncio
async def test_a_source_in_rebuild_cooldown_is_deferred(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        last_aggregated_ago_secs=60,     # inside the 900s default window
        stats_age_secs=30,               # and the stats are newer than that
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_skip == {"cooldown": 1}
    assert svc.signals == []


@pytest.mark.asyncio
async def test_cooldown_hold_does_not_advance_last_checked(session_factory):
    """A hold must leave the source due — otherwise rebuild waits an hour."""
    checked = _ago(seconds=300)
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        last_aggregated_ago_secs=60,
        stats_age_secs=30,
        checked_at=checked,
        raw_fingerprint="aaa",
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result.by_skip == {"cooldown": 1}
    st = await _state(session_factory)
    assert st.drift_state == "overlayMissing"
    assert st.last_reconcile_checked_at == checked  # unchanged

    # Still due on the next tick (unresolved finding newer than last act).
    result2 = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result2.scanned == 1
    assert result2.by_skip == {"cooldown": 1}


@pytest.mark.asyncio
async def test_action_cap_deferred_source_retries_next_tick(session_factory):
    """Sources past the action cap must not wait for the check interval."""
    for i in range(12):
        await _seed(
            session_factory, ds_id=f"ds_{i}",
            edge_counts={"FLOWS_TO": 200},
            checked_at=_ago(seconds=30),
            stats_age_secs=10,
            raw_fingerprint="old",
        )
    svc = _FakeService()
    first = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert first.findings == 12
    assert first.actions == 10
    assert len(svc.signals) == 10

    # The two deferred sources still have the old last_checked and an open
    # finding — the next auto tick must pick them up.
    second = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert second.actions == 2
    assert len(svc.signals) == 12


@pytest.mark.asyncio
async def test_in_sync_still_advances_last_checked(session_factory):
    await _seed(session_factory, checked_at=_ago(hours=2))
    before = (await _state(session_factory)).last_reconcile_checked_at
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result.by_skip.get("in_sync") == 1
    after = (await _state(session_factory)).last_reconcile_checked_at
    assert after is not None and after != before


@pytest.mark.asyncio
async def test_phase_a_without_phase_b_does_not_set_last_reconciled(
    session_factory, monkeypatch,
):
    """CP crash between evaluate and dispatch must not enter cooldown."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        raw_fingerprint="old",
    )
    svc = _FakeService()

    async def _boom_phase_b(self, actions, result, mode, actor):
        raise RuntimeError("cp died")

    monkeypatch.setattr(ReconciliationSweeper, "_phase_b", _boom_phase_b)
    with pytest.raises(RuntimeError, match="cp died"):
        await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    st = await _state(session_factory)
    assert st.drift_state == "overlayMissing"
    assert st.last_reconciled_at is None
    assert st.last_reconcile_checked_at is None  # not terminal, not finalized
    assert st.raw_fingerprint == "old"  # not adopted


@pytest.mark.asyncio
async def test_a_recently_failed_rebuild_backs_off(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        job_rows=(("failed", 60),),
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_skip == {"failed_backoff": 1}
    assert svc.signals == []


@pytest.mark.asyncio
async def test_a_marked_source_is_left_to_the_marker_reconciler(
    session_factory, _no_redis,
):
    """A stale marker means the source already had its invalidation and
    belongs to ``scheduler._reconcile_stale_markers``. Two mechanisms must
    never both retry one rebuild."""
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    _no_redis.append("ds_1")

    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_skip == {"already_marked": 1}
    assert svc.signals == []


@pytest.mark.asyncio
async def test_an_in_flight_rebuild_is_left_alone(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        job_rows=(("running", 30),),
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result.by_skip == {"in_flight": 1}


@pytest.mark.asyncio
async def test_per_source_opt_out_detects_but_never_acts(session_factory):
    """The cockpit must stay honest about drift even where automation is
    off — that is the whole point of surfacing the finding anyway."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        reconcile_enabled=False,
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.actions == 0
    assert result.findings == 1
    assert result.by_skip == {"disabled": 1}
    assert svc.signals == []
    st = await _state(session_factory)
    assert st.drift_state == "overlayMissing"
    assert st.last_finding_reason == "overlay_missing"
    assert st.last_finding_at is not None
    evidence = json.loads(st.last_finding_evidence)
    assert evidence["expectedAggregatedEdges"] == 500
    assert evidence["observedAggregatedEdges"] == 0


@pytest.mark.asyncio
async def test_breaker_suspends_a_source_that_keeps_re_firing(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        consecutive=3,
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_skip == {"suspended": 1}
    assert svc.signals == []
    assert (await _state(session_factory)).drift_state == "suspended"


@pytest.mark.asyncio
async def test_a_clean_pass_resets_the_breaker(session_factory):
    await _seed(session_factory, consecutive=2)
    svc = _FakeService()
    await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert (await _state(session_factory)).reconcile_consecutive_actions == 0


# ── Caps and pacing ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_action_cap_bounds_one_sweep(session_factory):
    for i in range(15):
        await _seed(
            session_factory, ds_id=f"ds_{i}",
            edge_counts={"FLOWS_TO": 200},
        )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.findings == 15
    assert result.actions == 10          # AGGREGATION_RECONCILE_MAX_ACTIONS
    assert len(svc.signals) == 10


@pytest.mark.asyncio
async def test_first_builds_are_capped_separately(session_factory):
    """A fresh install with many unbuilt sources drains one per sweep rather
    than queueing every full build at once."""
    for i in range(5):
        await _seed(
            session_factory, ds_id=f"ds_{i}",
            agg_status="none", expected_edges=0, raw_fingerprint=None,
            edge_counts={"FLOWS_TO": 200}, job_rows=(),
            last_aggregated_ago_secs=None,
        )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.findings == 5
    assert len(svc.triggers) == 1


@pytest.mark.asyncio
async def test_a_source_checked_recently_is_not_re_evaluated(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        checked_at=_ago(seconds=30),
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result.scanned == 0


@pytest.mark.asyncio
async def test_auto_due_when_stats_newer_than_last_check_queues_raw_drift(
    session_factory,
):
    """Closed loop: a counts write after the last verdict makes auto due —
    no Probe / Check now required."""
    await _seed(
        session_factory,
        checked_at=_ago(seconds=300),
        stats_age_secs=60,
        raw_fingerprint="aaa",
        entity_counts={"Table": 100},
        edge_counts={"FLOWS_TO": 200, "AGGREGATED": 500},
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.scanned == 1
    assert result.findings == 1
    assert result.by_reason == {"raw_drift": 1}
    assert result.actions == 1
    assert (await _state(session_factory)).drift_state == "drifting"
    assert len(svc.signals) == 1


@pytest.mark.asyncio
async def test_recent_check_with_unchanged_stats_is_not_due(session_factory):
    """Stats older than the last check must not wake a source early."""
    await _seed(
        session_factory,
        checked_at=_ago(seconds=60),
        stats_age_secs=300,
        raw_fingerprint="aaa",
        entity_counts={"Table": 100},
        edge_counts={"FLOWS_TO": 200, "AGGREGATED": 500},
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert result.scanned == 0
    assert svc.signals == []


@pytest.mark.asyncio
async def test_manual_live_observe_persists_counts(session_factory, monkeypatch):
    """Operator live observe writes the counts facet for other consumers."""
    await _seed(session_factory, checked_at=_ago(seconds=30))

    class _Prov:
        async def get_stats(self, bypass_cache=True):
            return {
                "nodeCount": 99,
                "edgeCount": 700,
                "entityTypeCounts": {"Table": 99},
                "edgeTypeCounts": {"FLOWS_TO": 200, "AGGREGATED": 500},
            }

    class _Reg:
        async def get_provider_for_workspace(self, *a, **k):
            return _Prov()

    class _Svc(_FakeService):
        _registry = _Reg()

    svc = _Svc()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep(
        mode="manual",
    )
    assert result is not None
    async with session_factory() as s:
        row = await s.get(DataSourceStatsORM, "ds_1")
        assert row is not None
        assert row.node_count == 99
        assert json.loads(row.entity_type_counts) == {"Table": 99}
        # …with the digest describing THESE counts. Persisting fresh counts
        # beside the previously stored digest made the tripwire report
        # "nothing moved" for the one source an operator just looked at.
        from backend.app.services.aggregation.fingerprint import (
            counts_digest_from_counts,
        )
        assert row.counts_digest == counts_digest_from_counts(
            {"Table": 99}, {"FLOWS_TO": 200, "AGGREGATED": 500},
        )

@pytest.mark.asyncio
async def test_manual_sweep_re_evaluates_a_recently_checked_source(session_factory):
    """Check now is a full-fleet pass, not an early hourly tick."""
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        checked_at=_ago(seconds=30),
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep(
        mode="manual",
    )
    assert result is not None
    assert result.scanned == 1
    assert result.findings == 1
    assert result.finding_rows[0]["dataSourceId"] == "ds_1"


@pytest.mark.asyncio
async def test_preview_re_evaluates_a_recently_checked_source(session_factory):
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        checked_at=_ago(seconds=30),
    )
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep(
        dry_run=True, mode="preview",
    )
    assert result is not None
    assert result.scanned == 1
    assert result.findings == 1
    assert result.actions == 0
    assert [p.data_source_id for p in result.pending] == ["ds_1"]


# ── Preview ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_preview_finds_without_acting(session_factory):
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep(
        dry_run=True, mode="preview",
    )

    assert result.findings == 1
    assert result.actions == 0
    assert svc.signals == [] and svc.triggers == []
    assert [p.reason for p in result.pending] == ["overlay_missing"]
    # The preview is what someone reads before switching automation on across
    # a fleet. A list of raw ds_ ids does not answer "should I do this".
    assert [p.name for p in result.pending] == ["Label for ds_1"]


# ── Run records ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_each_sweep_records_a_run_with_its_tallies(session_factory):
    await _seed(session_factory, ds_id="ds_a", edge_counts={"FLOWS_TO": 200})
    await _seed(session_factory, ds_id="ds_b")
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    async with session_factory() as s:
        runs = (await s.execute(select(ReconcileRunORM))).scalars().all()
    assert len(runs) == 1
    run = runs[0]
    assert run.id == result.run_id
    assert run.mode == "auto"
    assert run.scanned == 2 and run.findings == 1 and run.actions == 1
    detail = json.loads(run.detail)
    assert detail["byReason"] == {"overlay_missing": 1}
    assert detail["bySkip"] == {"in_sync": 1}
    findings = detail["findings"]
    assert len(findings) == 1
    assert findings[0]["dataSourceId"] == "ds_a"
    assert findings[0]["name"] == "Label for ds_a"
    assert findings[0]["providerName"] == "p"
    assert findings[0]["reason"] == "overlay_missing"
    assert findings[0]["acted"] is True


@pytest.mark.asyncio
async def test_a_clean_pass_clears_a_stale_finding(session_factory):
    """Once the overlay is back, the live finding on the state row must
    not keep reporting the previous wipe."""
    await _seed(
        session_factory, edge_counts={"FLOWS_TO": 200},
        reconcile_enabled=False,
    )
    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()
    st = await _state(session_factory)
    assert st.last_finding_reason == "overlay_missing"

    async with session_factory() as s:
        row = await s.get(AggregationDataSourceStateORM, "ds_1")
        row.reconcile_enabled = True
        # Pretend the overlay came back (and the last check is due).
        from backend.app.db.models import DataSourceStatsORM
        stats = await s.get(DataSourceStatsORM, "ds_1")
        stats.edge_type_counts = json.dumps({"FLOWS_TO": 200, "AGGREGATED": 500})
        row.last_reconcile_checked_at = None
        await s.commit()

    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()
    st = await _state(session_factory)
    assert st.drift_state == "inSync"
    assert st.last_finding_reason is None
    assert st.last_finding_evidence is None


@pytest.mark.asyncio
async def test_a_queued_rebuild_names_the_sweep_on_the_audit_event(
    session_factory,
):
    """The overnight ledger joins refresh_events to reconcile_runs by
    run_id. Without it the only join is trigger + calendar day."""
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    _, kw = svc.signals[0]
    assert kw["run_id"] == result.run_id


@pytest.mark.asyncio
async def test_a_first_build_audit_event_carries_the_run_id(session_factory):
    await _seed(
        session_factory,
        agg_status="none", expected_edges=0, raw_fingerprint=None,
        edge_counts={"FLOWS_TO": 200}, job_rows=(),
        last_aggregated_ago_secs=None,
    )
    result = await ReconciliationSweeper(
        session_factory, lambda: _FakeService(),
    ).sweep()
    async with session_factory() as s:
        events = (await s.execute(select(RefreshEventORM))).scalars().all()
    assert events[0].run_id == result.run_id


@pytest.mark.asyncio
async def test_preview_findings_carry_the_provider_name(session_factory):
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    result = await ReconciliationSweeper(
        session_factory, lambda: _FakeService(),
    ).sweep(dry_run=True, mode="preview")
    pending = result.pending[0]
    assert pending.name == "Label for ds_1"
    assert pending.provider_id == "prov_1"
    assert pending.provider_name == "p"


@pytest.mark.asyncio
async def test_a_dispatch_failure_is_counted_not_raised(session_factory):
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})

    class _Boom(_FakeService):
        async def signal_source_changed(self, ds_id, session, **kw):
            raise RuntimeError("provider down")

    result = await ReconciliationSweeper(
        session_factory, lambda: _Boom(),
    ).sweep()
    assert result.errors == 1
    assert result.actions == 0


@pytest.mark.asyncio
async def test_activity_returns_acted_and_held(session_factory):
    """The overnight ledger joins run findings to refresh_events by run_id,
    so a held finding (automation off) is visible next to a rebuilt one."""
    from backend.app.services.aggregation.service import assemble_reconcile_activity

    await _seed(
        session_factory, ds_id="ds_act",
        agg_status="none", expected_edges=0, raw_fingerprint=None,
        edge_counts={"FLOWS_TO": 200}, job_rows=(),
        last_aggregated_ago_secs=None,
    )
    await _seed(
        session_factory, ds_id="ds_hold",
        edge_counts={"FLOWS_TO": 200},
        reconcile_enabled=False,
    )
    result = await ReconciliationSweeper(
        session_factory, lambda: _FakeService(),
    ).sweep()

    async with session_factory() as s:
        resp = await assemble_reconcile_activity(s)

    by_id = {row.data_source_id: row for row in resp.items}
    assert set(by_id) == {"ds_act", "ds_hold"}
    rebuilt = by_id["ds_act"]
    held = by_id["ds_hold"]
    assert rebuilt.outcome == "rebuilt"
    assert rebuilt.job_id == "agg_fake"
    assert rebuilt.run_id == result.run_id
    assert rebuilt.reason == "never_aggregated"
    assert rebuilt.mode == "auto"
    assert rebuilt.provider_name == "p"
    assert held.outcome == "held"
    assert held.job_id is None
    assert held.skip == "disabled"


@pytest.mark.asyncio
async def test_preview_runs_do_not_appear_on_the_ledger(session_factory):
    from backend.app.services.aggregation.service import assemble_reconcile_activity

    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep(
        dry_run=True, mode="preview",
    )
    async with session_factory() as s:
        resp = await assemble_reconcile_activity(s)
    assert resp.items == []


@pytest.mark.asyncio
async def test_transition_into_suspended_notifies_once(
    session_factory, monkeypatch,
):
    calls = []

    async def _fake_notify(session, **kw):
        calls.append(kw)
        return 1

    monkeypatch.setattr(
        "backend.app.db.repositories.notification_repo.notify_reconcile_suspended",
        _fake_notify,
    )
    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        consecutive=3,
    )
    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()
    assert len(calls) == 1
    assert calls[0]["data_source_id"] == "ds_1"
    assert calls[0]["workspace_id"] == "ws_1"

    async with session_factory() as s:
        st = await s.get(AggregationDataSourceStateORM, "ds_1")
        st.last_reconcile_checked_at = None
        await s.commit()

    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_notify_dedupes_unread_same_kind_and_resource(session_factory):
    from backend.app.db.models import NotificationORM
    from backend.app.db.repositories.notification_repo import notify

    async with session_factory() as s:
        s.add(NotificationORM(
            user_id="u1", kind="reconcile.suspended", title="first",
            resource_id="ds_1",
        ))
        await s.flush()
        n = await notify(
            s,
            user_ids=["u1", "u2"],
            kind="reconcile.suspended",
            title="again",
            resource_id="ds_1",
            dedupe_unread=True,
        )
        await s.commit()
        assert n == 1
        rows = (await s.execute(select(NotificationORM))).scalars().all()
        users = {r.user_id for r in rows}
        assert users == {"u1", "u2"}


@pytest.mark.asyncio
async def test_probe_reconciliation_stopped_and_suspended(
    session_factory, monkeypatch,
):
    from backend.app.services.system_status import probes

    await _seed(
        session_factory,
        edge_counts={"FLOWS_TO": 200},
        consecutive=3,
    )
    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()

    async with session_factory() as s:
        run = (await s.execute(select(ReconcileRunORM))).scalars().one()
        run.started_at = _ago(hours=10)
        await s.commit()

    monkeypatch.setattr(
        "backend.app.db.engine.get_session_factory",
        lambda role=None: session_factory,
    )
    snap = await probes.probe_reconciliation()
    assert snap is not None
    assert snap["stopped"] is True
    assert snap["suspendedCount"] == 1
    assert snap["notYetRun"] is False


@pytest.mark.asyncio
async def test_no_active_service_defers_rather_than_crashing(session_factory):
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    result = await ReconciliationSweeper(session_factory, lambda: None).sweep()
    assert result.findings == 1
    assert result.actions == 0
    assert result.errors == 1


# ── Counts-digest tripwire ──────────────────────────────────────────────
#
# The probe lane writes fresh counts far more often than the sweep acts, so
# due-ness has to key on whether anything actually MOVED rather than on how
# recently the stats row was written. These lock down that property in both
# directions: a source that moved is picked up immediately even inside its
# check interval, and a source that was re-probed to the same numbers is not
# picked up at all.


async def _set_digests(factory, ds_id, *, stats_digest, seen_digest):
    async with factory() as s:
        stats = await s.get(DataSourceStatsORM, ds_id)
        stats.counts_digest = stats_digest
        state = await s.get(AggregationDataSourceStateORM, ds_id)
        state.last_seen_counts_digest = seen_digest
        await s.commit()


@pytest.mark.asyncio
async def test_moved_counts_are_due_inside_the_check_interval(session_factory):
    """A drifted source must not wait out its check interval."""
    await _seed(session_factory, checked_at=_ago(seconds=5))
    await _set_digests(
        session_factory, "ds_1", stats_digest="new", seen_digest="old",
    )

    sweeper = ReconciliationSweeper(session_factory, lambda: _FakeService())
    async with session_factory() as s:
        candidates = await sweeper._candidates(s, None, 3600)

    assert [c.data_source_id for c in candidates] == ["ds_1"]


@pytest.mark.asyncio
async def test_unchanged_counts_do_not_re_open_a_checked_source(session_factory):
    """The scalability property: re-probing a quiet source costs nothing.

    Without this, every probe would make every source due on the next tick
    and the sweep would churn the whole fleet continuously.
    """
    await _seed(session_factory, checked_at=_ago(seconds=5))
    await _set_digests(
        session_factory, "ds_1", stats_digest="same", seen_digest="same",
    )

    sweeper = ReconciliationSweeper(session_factory, lambda: _FakeService())
    async with session_factory() as s:
        candidates = await sweeper._candidates(s, None, 3600)

    assert candidates == []


@pytest.mark.asyncio
async def test_never_probed_source_is_not_permanently_due(session_factory):
    """A NULL stats digest must not read as "distinct from" forever."""
    await _seed(session_factory, checked_at=_ago(seconds=5))
    await _set_digests(
        session_factory, "ds_1", stats_digest=None, seen_digest="whatever",
    )

    sweeper = ReconciliationSweeper(session_factory, lambda: _FakeService())
    async with session_factory() as s:
        candidates = await sweeper._candidates(s, None, 3600)

    assert candidates == []


@pytest.mark.asyncio
async def test_sweep_stamps_the_digest_it_evaluated(session_factory):
    """Closing the loop: an evaluation records what it saw, so the same
    numbers do not re-open the source on the next tick."""
    await _seed(session_factory)
    async with session_factory() as s:
        stats = await s.get(DataSourceStatsORM, "ds_1")
        stats.counts_digest = "digest-under-test"
        await s.commit()

    await ReconciliationSweeper(session_factory, lambda: _FakeService()).sweep()

    state = await _state(session_factory)
    assert state.last_seen_counts_digest == "digest-under-test"


@pytest.mark.asyncio
async def test_wiped_overlay_moves_the_digest(session_factory):
    """The tripwire must see an overlay wipe, which leaves raw counts alone.

    This is why the digest includes AGGREGATED and the drift BASELINE
    excludes it — swapping the two would make this case invisible.
    """
    from backend.app.services.aggregation.fingerprint import (
        counts_digest_from_counts, raw_fingerprint_from_counts,
    )
    entity = {"Table": 100}
    healthy = {"FLOWS_TO": 200, "AGGREGATED": 500}
    wiped = {"FLOWS_TO": 200}

    assert (
        counts_digest_from_counts(entity, healthy)
        != counts_digest_from_counts(entity, wiped)
    ), "digest must move when the overlay is wiped"
    assert (
        raw_fingerprint_from_counts(entity, healthy)[0]
        == raw_fingerprint_from_counts(entity, wiped)[0]
    ), "raw baseline must NOT move when only the overlay changes"


@pytest.mark.asyncio
async def test_stale_counts_are_refreshed_by_a_priority_probe(
    session_factory, monkeypatch,
):
    """The fix for "its only move is to ask the stats service and wait".

    A source whose counts are too old to act on must get a probe on the
    priority lane, not merely a stats poll — the poll is two full scans and is
    throttled to one enqueue per source per minute, which is how a stale source
    used to sit unresolved for most of an hour.
    """
    probes: list = []
    polls: list = []

    async def _probe(ds_id, workspace_id, *, priority=False):
        probes.append((ds_id, priority))
        return "msg", "enqueued"

    async def _poll(ds_id, workspace_id):
        polls.append(ds_id)

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_probe_job_safe", _probe,
    )
    monkeypatch.setattr(
        "backend.insights_service.enqueue.mark_stats_changed", _poll,
    )

    # Older than AGGREGATION_RECONCILE_STATS_MAX_AGE_SECS (2700).
    await _seed(session_factory, stats_age_secs=4000)
    result = await ReconciliationSweeper(
        session_factory, lambda: _FakeService(),
    ).sweep()

    assert result.by_skip.get("stats_stale") == 1
    assert probes == [("ds_1", True)], "expected one PRIORITY probe"
    # The poll still follows — it owns the deep facet — it is just no longer
    # what the next sweep has to wait on.
    assert polls == ["ds_1"]


# ── Dispatch outcomes and the sweep lock ────────────────────────────────


class _NoJobService(_FakeService):
    """signal_source_changed runs but queues nothing — the shape the real
    service returns on the unchanged gate, a trigger conflict, a resolution
    failure, or a not-applicable source (job_id=None, deferred=False)."""

    async def signal_source_changed(self, ds_id, session, **kw):
        await super().signal_source_changed(ds_id, session, **kw)
        return SourceChangedResponse(
            changed=True,
            job_id=None,
            reason=kw.get("reason", "raw_drift"),
            current_fingerprint="fp_new",
            stored_fingerprint="fp_old",
        )


@pytest.mark.asyncio
async def test_a_signal_that_queues_no_job_is_not_an_action(session_factory):
    """Counting a no-job signal as an action adopted the drifted fingerprint
    as the new baseline with no rebuild behind it — that drift could never
    fire again — and walked the breaker toward suspended on nothing."""
    await _seed(session_factory, raw_fingerprint="fp_old")
    svc = _NoJobService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert len(svc.signals) == 1
    assert result.actions == 0
    assert result.errors == 0

    st = await _state(session_factory)
    assert st.raw_fingerprint == "fp_old"        # baseline NOT adopted
    assert st.last_reconciled_at is None         # no action stamped
    assert (st.reconcile_consecutive_actions or 0) == 0

    # Still due: the next sweep re-evaluates and signals again.
    await ReconciliationSweeper(session_factory, lambda: svc).sweep()
    assert len(svc.signals) == 2


@pytest.mark.asyncio
async def test_claim_lock_fails_closed_on_postgres_error():
    """A Postgres hiccup must cost one tick, not the mutual exclusion."""

    class _Dialect:
        name = "postgresql"

    class _Bind:
        dialect = _Dialect()

    class _Session:
        bind = _Bind()

        async def execute(self, *_a, **_k):
            raise RuntimeError("connection lost")

    sweeper = ReconciliationSweeper(lambda: None, lambda: None)
    assert await sweeper._claim_lock(_Session()) is False
