"""ProbeScheduler — which sources get their counts re-read, and when.

The probe is what makes drift detection fast, so the properties that matter
here are the ones that keep it both timely and bounded: a source is due on its
own resolved interval, a fleet larger than one batch drains oldest-first
instead of starving its tail, and nothing is ever probed twice concurrently.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

from backend.app.db.engine import Base
from backend.app.db.models import (
    DataSourceStatsORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
)
from backend.app.services.aggregation.probe_scheduler import (
    ProbeScheduler, _is_due,
)


def _ago(**kw) -> str:
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


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


@pytest.fixture(autouse=True)
def _enqueued(monkeypatch):
    """Capture enqueues instead of reaching Redis."""
    calls: list = []

    async def _fake(ds_id, workspace_id, *, priority=False):
        calls.append(ds_id)
        return "msg-1", "enqueued"

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_probe_job_safe", _fake,
    )
    return calls


async def _seed(factory, ds_id, *, last_probed_at=None,
                probe_enabled=None, probe_interval_secs=None, deleted=False):
    async with factory() as s:
        if await s.get(WorkspaceORM, "ws_1") is None:
            s.add(WorkspaceORM(id="ws_1", name="ws"))
            s.add(ProviderORM(
                id="prov_1", name="p", provider_type="falkordb",
                host="h", port=1, credentials="{}",
            ))
            await s.flush()
        s.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id="ws_1", provider_id="prov_1",
            graph_name=f"g_{ds_id}",
            deleted_at=_ago(hours=1) if deleted else None,
        ))
        s.add(DataSourceStatsORM(
            data_source_id=ds_id, updated_at=_ago(seconds=30),
            last_probed_at=last_probed_at,
        ))
        s.add(AggregationDataSourceStateORM(
            data_source_id=ds_id, workspace_id="ws_1",
            probe_enabled=probe_enabled,
            probe_interval_secs=probe_interval_secs,
        ))
        await s.commit()


# ── due-ness ────────────────────────────────────────────────────────────

def test_never_probed_is_due():
    assert _is_due(None, 60, datetime.now(timezone.utc)) is True


def test_unparseable_stamp_is_due_rather_than_stuck():
    """A corrupt timestamp must not make a source un-probeable forever."""
    assert _is_due("not-a-date", 60, datetime.now(timezone.utc)) is True


def test_zero_interval_means_every_tick():
    """0 is a real value, not "unset" — same convention as the other knobs."""
    assert _is_due(_ago(seconds=1), 0, datetime.now(timezone.utc)) is True


def test_naive_timestamp_is_treated_as_utc():
    """SQLite hands back naive strings; comparing them to an aware now()
    would raise and take the whole tick down."""
    naive = (datetime.now(timezone.utc) - timedelta(seconds=120)).replace(
        tzinfo=None
    ).isoformat()
    assert _is_due(naive, 60, datetime.now(timezone.utc)) is True


def test_recently_probed_is_not_due():
    assert _is_due(_ago(seconds=5), 60, datetime.now(timezone.utc)) is False


# ── selection ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_enqueues_a_due_source(session_factory, _enqueued):
    await _seed(session_factory, "ds_1", last_probed_at=_ago(seconds=300))
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 1
    assert _enqueued == ["ds_1"]


@pytest.mark.asyncio
async def test_skips_a_recently_probed_source(session_factory, _enqueued):
    await _seed(session_factory, "ds_1", last_probed_at=_ago(seconds=5))
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 0
    assert _enqueued == []


@pytest.mark.asyncio
async def test_per_source_opt_out_is_honoured(session_factory, _enqueued):
    await _seed(
        session_factory, "ds_1",
        last_probed_at=_ago(seconds=300), probe_enabled=False,
    )
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 0
    assert _enqueued == []


@pytest.mark.asyncio
async def test_per_source_interval_overrides_the_global(session_factory, _enqueued):
    """A slow source must not be dragged onto the fleet cadence. Probed 300s
    ago with a 1h override: inside the global window, outside its own."""
    await _seed(
        session_factory, "ds_1",
        last_probed_at=_ago(seconds=300), probe_interval_secs=3600,
    )
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 0


@pytest.mark.asyncio
async def test_a_faster_override_beats_a_slow_global(
    session_factory, _enqueued, monkeypatch,
):
    """The mirror of the test above, and the one that actually bites: the SQL
    pre-filter's cutoff must be the narrowest interval any source could resolve
    to. Derived from the GLOBAL, a source overridden faster than the fleet is
    never even loaded, so the Python check that honours its override never runs
    — the drawer reports the override while nothing acts on it."""
    monkeypatch.setattr(
        "backend.app.services.aggregation.service"
        ".AGGREGATION_PROBE_INTERVAL_SECS", 3600,
    )
    await _seed(
        session_factory, "ds_1",
        last_probed_at=_ago(seconds=300), probe_interval_secs=30,
    )
    summary = await ProbeScheduler(session_factory).tick()
    assert (summary.seen, summary.due, summary.enqueued) == (1, 1, 1)
    assert _enqueued == ["ds_1"]


@pytest.mark.asyncio
async def test_a_disabled_override_does_not_drag_the_cutoff(
    session_factory, _enqueued, monkeypatch,
):
    """A probe-disabled source can never be due, so its narrow override must
    not widen the SQL window for the whole fleet."""
    monkeypatch.setattr(
        "backend.app.services.aggregation.service"
        ".AGGREGATION_PROBE_INTERVAL_SECS", 900,
    )
    await _seed(
        session_factory, "ds_off",
        last_probed_at=_ago(seconds=5),
        probe_enabled=False, probe_interval_secs=15,
    )
    await _seed(session_factory, "ds_on", last_probed_at=_ago(seconds=100))
    summary = await ProbeScheduler(session_factory).tick()
    assert (summary.seen, summary.enqueued) == (0, 0)
    assert _enqueued == []


@pytest.mark.asyncio
async def test_deleted_source_is_never_probed(session_factory, _enqueued):
    """Liveness is deleted_at, not is_active — a tombstone that kept its
    active flag would otherwise be probed forever."""
    await _seed(
        session_factory, "ds_1", last_probed_at=_ago(seconds=300), deleted=True,
    )
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 0


@pytest.mark.asyncio
async def test_batch_cap_defers_the_remainder(session_factory, _enqueued, monkeypatch):
    monkeypatch.setattr(
        "backend.app.services.aggregation.service"
        ".AGGREGATION_PROBE_BATCH_CAP", 2,
    )
    for i in range(5):
        await _seed(session_factory, f"ds_{i}", last_probed_at=_ago(seconds=300))
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 2
    assert len(_enqueued) == 2


@pytest.mark.asyncio
async def test_oldest_probed_first(session_factory, _enqueued, monkeypatch):
    """Ordering is what stops a large fleet's tail from starving."""
    monkeypatch.setattr(
        "backend.app.services.aggregation.service"
        ".AGGREGATION_PROBE_BATCH_CAP", 1,
    )
    await _seed(session_factory, "ds_recent", last_probed_at=_ago(seconds=120))
    await _seed(session_factory, "ds_ancient", last_probed_at=_ago(hours=5))
    await ProbeScheduler(session_factory).tick()
    assert _enqueued == ["ds_ancient"]


@pytest.mark.asyncio
async def test_coalesced_enqueue_is_not_counted_as_progress(
    session_factory, monkeypatch,
):
    """A source already queued reports as coalesced, not enqueued — the
    distinction is what makes the health probe readable."""
    async def _dedup(ds_id, workspace_id, *, priority=False):
        return None, "dedup"

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_probe_job_safe", _dedup,
    )
    await _seed(session_factory, "ds_1", last_probed_at=_ago(seconds=300))
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.enqueued == 0
    assert summary.coalesced == 1


@pytest.mark.asyncio
async def test_enqueue_failure_does_not_raise(session_factory, monkeypatch):
    """Redis down must degrade to "fewer probes", never take out the loop."""
    async def _boom(ds_id, workspace_id, *, priority=False):
        raise ConnectionError("redis down")

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_probe_job_safe", _boom,
    )
    await _seed(session_factory, "ds_1", last_probed_at=_ago(seconds=300))
    summary = await ProbeScheduler(session_factory).tick()
    assert summary.errors == 1


@pytest.mark.asyncio
async def test_the_last_tick_reaches_the_health_probe(session_factory, _enqueued):
    """"Nothing found" and "nothing is looking" must not look the same from
    outside the process."""
    from backend.app.services.aggregation import probe_scheduler as mod

    # Module state, so start from a known one rather than from whatever an
    # earlier test in this file left behind.
    mod._last_tick = mod._last_tick_at = None
    assert mod.get_probe_scheduler_status() == {"last_tick_at": None}

    await _seed(session_factory, "ds_1", last_probed_at=_ago(seconds=300))
    shutdown = asyncio.Event()
    task = asyncio.create_task(ProbeScheduler(session_factory).start(shutdown))
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.wait_for(task, timeout=5)

    status = mod.get_probe_scheduler_status()
    assert status["last_tick_at"] is not None
    assert status["enqueued"] == 1


@pytest.mark.asyncio
async def test_tick_failure_does_not_kill_the_loop(session_factory, monkeypatch):
    async def _boom(self):
        raise RuntimeError("boom")

    monkeypatch.setattr(ProbeScheduler, "tick", _boom)
    shutdown = asyncio.Event()
    task = asyncio.create_task(ProbeScheduler(session_factory).start(shutdown))
    await asyncio.sleep(0.05)
    assert not task.done()
    shutdown.set()
    await asyncio.wait_for(task, timeout=5)
