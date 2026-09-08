"""An outage must read as an outage, not as silence.

A failed collection wrote nothing at all. That was deliberate — a scan that
errored must never enter the series as a zero, because a phantom wipe is far
worse than a gap. But it left the page unable to answer the question an
operator opens it with: was this source even checked? A flat line and a dead
collector looked identical.

``capture_reason='unavailable'`` closes that WITHOUT giving up the original
constraint: the row carries the last known counts forward, is never written
when there is nothing to carry, and is heartbeat-gated so a retry storm cannot
flood the ledger.
"""
import json

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DataSourceCountSnapshotORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    profiling_repo,
    stats_history_repo,
    stats_repo,
)

DS_ID = "ds_unavail1"


@pytest.fixture(autouse=True)
def _clear_policy_cache():
    """The policy memo is process-global; a value cached by one test would
    otherwise leak into the next."""
    stats_history_repo.invalidate_history_policy_cache()
    yield
    stats_history_repo.invalidate_history_policy_cache()


async def _seed(session: AsyncSession) -> str:
    session.add(ProviderORM(id="prov_u1", name="U", provider_type="falkordb"))
    session.add(WorkspaceORM(id="ws_u1", name="U"))
    await session.flush()
    session.add(WorkspaceDataSourceORM(
        id=DS_ID, workspace_id="ws_u1", provider_id="prov_u1", graph_name="g",
    ))
    await session.flush()
    return DS_ID


async def _observe(session: AsyncSession, entities: dict, edges: dict) -> None:
    await stats_repo.upsert_data_source_stats_counts(
        session=session, ds_id=DS_ID,
        node_count=sum(entities.values()), edge_count=sum(edges.values()),
        entity_type_counts=json.dumps(entities),
        edge_type_counts=json.dumps(edges),
        lane="poll",
    )


async def _fail(session: AsyncSession, error: str = "breaker open") -> None:
    policy = await stats_history_repo.resolve_history_policy(session)
    await stats_history_repo.record_unavailable(
        session, ds_id=DS_ID, lane="poll", error=error, policy=policy,
    )


async def _snapshots(session: AsyncSession) -> list:
    return list((await session.execute(
        select(DataSourceCountSnapshotORM)
        .where(DataSourceCountSnapshotORM.data_source_id == DS_ID)
        .order_by(DataSourceCountSnapshotORM.captured_at)
    )).scalars().all())


async def test_a_failure_with_nothing_observed_yet_writes_nothing(
    db_session: AsyncSession,
):
    """The original constraint, kept: with no prior counts there is nothing to
    carry forward, and inventing a zero is exactly what must never happen."""
    await _seed(db_session)
    await _fail(db_session)
    assert await _snapshots(db_session) == []


async def test_a_failure_carries_the_last_known_counts_forward(
    db_session: AsyncSession, monkeypatch,
):
    await _seed(db_session)
    await _observe(db_session, {"Table": 10}, {"OWNS": 4})
    monkeypatch.setattr(
        stats_history_repo.resilience, "PROFILING_HEARTBEAT_SECS", 0,
    )
    stats_history_repo.invalidate_history_policy_cache()

    await _fail(db_session, "tcp_refused: falkor:6379")

    rows = await _snapshots(db_session)
    assert [r.capture_reason for r in rows] == ["first", "unavailable"]
    outage = rows[1]
    # The drawn series is unchanged — only the reason says what happened.
    assert outage.node_count == 10 and outage.edge_count == 4
    assert json.loads(outage.entity_type_counts) == {"Table": 10}
    assert outage.node_delta == 0 and outage.edge_delta == 0
    assert outage.type_deltas is None
    assert outage.check_error == "tcp_refused: falkor:6379"
    assert outage.prev_captured_at == rows[0].captured_at


async def test_a_retry_storm_writes_one_row_per_heartbeat_window(
    db_session: AsyncSession,
):
    """The probe lane retries every 60s. An hour of downtime must not become
    sixty rows saying the same thing."""
    await _seed(db_session)
    await _observe(db_session, {"Table": 10}, {"OWNS": 4})
    for _ in range(10):
        await _fail(db_session)
    rows = await _snapshots(db_session)
    assert [r.capture_reason for r in rows] == ["first"], (
        "the default 900s heartbeat gate should suppress every one of them"
    )


async def test_the_marker_advances_the_snapshot_clock(
    db_session: AsyncSession, monkeypatch,
):
    """Otherwise the next check would call itself due all over again."""
    await _seed(db_session)
    await _observe(db_session, {"Table": 10}, {"OWNS": 4})
    monkeypatch.setattr(
        stats_history_repo.resilience, "PROFILING_HEARTBEAT_SECS", 0,
    )
    stats_history_repo.invalidate_history_policy_cache()

    await _fail(db_session)
    stats = await stats_repo.get_data_source_stats(db_session, DS_ID)
    rows = await _snapshots(db_session)
    assert stats.last_snapshot_at == rows[-1].captured_at


async def test_history_disabled_writes_nothing(db_session: AsyncSession, monkeypatch):
    await _seed(db_session)
    await _observe(db_session, {"Table": 10}, {"OWNS": 4})
    before = len(await _snapshots(db_session))

    policy = await stats_history_repo.resolve_history_policy(db_session)
    disabled = type(policy)(**{**policy.__dict__, "enabled": False})
    await stats_history_repo.record_unavailable(
        db_session, ds_id=DS_ID, lane="poll", error="x", policy=disabled,
    )
    assert len(await _snapshots(db_session)) == before


async def test_an_outage_is_neither_movement_nor_a_checkpoint(
    db_session: AsyncSession, monkeypatch,
):
    """``moved`` used to be ``observations - checkpoints``, which would have
    reported every outage as a change the source never made."""
    await _seed(db_session)
    await _observe(db_session, {"Table": 10}, {"OWNS": 4})
    monkeypatch.setattr(
        stats_history_repo.resilience, "PROFILING_HEARTBEAT_SECS", 0,
    )
    stats_history_repo.invalidate_history_policy_cache()
    await _observe(db_session, {"Table": 12}, {"OWNS": 4})   # a real change
    await _fail(db_session)
    await _observe(db_session, {"Table": 12}, {"OWNS": 4})   # unchanged → heartbeat

    counts = await profiling_repo.window_counts(
        db_session, ds_id=DS_ID, frm="0000", to="9999",
    )
    assert counts["observations"] == 4
    assert counts["moved"] == 2          # first + changed
    assert counts["checkpoints"] == 1
    assert counts["unavailable"] == 1
    assert (
        counts["moved"] + counts["checkpoints"] + counts["unavailable"]
        == counts["observations"]
    )
