"""Counts-history capture — the gate, the deltas, and what must NOT be written.

The gate is the load-bearing part. Capture runs on every counts write, and the
drift probe writes every 60s; an ungated capture would be ~43k rows per source
per month describing a graph that mostly did not change. These tests pin the
three outcomes: a first snapshot, a snapshot when the digest moves, and
silence when it does not.
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
from backend.app.db.repositories import stats_history_repo, stats_repo


DS_ID = "ds_hist1"


async def _seed(session: AsyncSession, ds_id: str = DS_ID) -> str:
    session.add(ProviderORM(id="prov_h1", name="H", provider_type="falkordb"))
    session.add(WorkspaceORM(id="ws_h1", name="H"))
    await session.flush()
    session.add(WorkspaceDataSourceORM(
        id=ds_id, workspace_id="ws_h1", provider_id="prov_h1", graph_name="hist-graph",
    ))
    await session.flush()
    return ds_id


async def _write(session: AsyncSession, ds_id: str, entities: dict, edges: dict,
                 *, lane: str = "probe") -> None:
    await stats_repo.upsert_data_source_stats_counts(
        session=session,
        ds_id=ds_id,
        node_count=sum(entities.values()),
        edge_count=sum(edges.values()),
        entity_type_counts=json.dumps(entities),
        edge_type_counts=json.dumps(edges),
        lane=lane,
    )


async def _snapshots(session: AsyncSession, ds_id: str = DS_ID) -> list:
    return list((await session.execute(
        select(DataSourceCountSnapshotORM)
        .where(DataSourceCountSnapshotORM.data_source_id == ds_id)
        .order_by(DataSourceCountSnapshotORM.captured_at)
    )).scalars().all())


@pytest.fixture(autouse=True)
def _clear_policy_cache():
    """The policy memo is process-global; a value cached by one test would
    otherwise leak into the next."""
    stats_history_repo.invalidate_history_policy_cache()
    yield
    stats_history_repo.invalidate_history_policy_cache()


# ── the gate ─────────────────────────────────────────────────────────

async def test_first_counts_write_captures_a_first_snapshot(db_session: AsyncSession):
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})

    rows = await _snapshots(db_session)
    assert len(rows) == 1
    assert rows[0].capture_reason == "first"
    assert rows[0].node_count == 10
    assert rows[0].edge_count == 4
    # No predecessor a reader could open, so no delta is claimed.
    assert rows[0].node_delta is None
    assert rows[0].type_deltas is None


async def test_changed_counts_capture_a_second_snapshot(db_session: AsyncSession):
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})
    await _write(db_session, ds_id, {"Table": 15}, {"OWNS": 4})

    rows = await _snapshots(db_session)
    assert [r.capture_reason for r in rows] == ["first", "changed"]
    assert rows[1].node_delta == 5
    assert rows[1].prev_captured_at == rows[0].captured_at


async def test_unchanged_counts_inside_the_heartbeat_write_nothing(
    db_session: AsyncSession,
):
    """The whole point of the gate: a 60s probe observing an idle graph must
    not produce a row."""
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})
    for _ in range(5):
        await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})

    rows = await _snapshots(db_session)
    assert len(rows) == 1, "an unchanged observation must not be recorded"


async def test_unchanged_counts_past_the_heartbeat_capture_a_continuity_row(
    db_session: AsyncSession, monkeypatch,
):
    """A flat line has to be provably flat — otherwise an idle month is
    indistinguishable from a month of lost data."""
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})

    # Heartbeat of 0s: every unchanged observation is now past due.
    monkeypatch.setattr(
        stats_history_repo.resilience, "INSIGHTS_HISTORY_HEARTBEAT_SECS", 0,
    )
    stats_history_repo.invalidate_history_policy_cache()
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})

    rows = await _snapshots(db_session)
    assert [r.capture_reason for r in rows] == ["first", "heartbeat"]
    assert rows[1].node_delta == 0


async def test_capture_can_be_switched_off(db_session: AsyncSession, monkeypatch):
    ds_id = await _seed(db_session)
    monkeypatch.setattr(
        stats_history_repo.resilience, "INSIGHTS_HISTORY_ENABLED", False,
    )
    stats_history_repo.invalidate_history_policy_cache()
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})
    assert await _snapshots(db_session) == []


# ── deltas ───────────────────────────────────────────────────────────

async def test_label_added_removed_and_changed_all_land_in_type_deltas(
    db_session: AsyncSession,
):
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10, "Column": 50}, {"OWNS": 4})
    await _write(db_session, ds_id, {"Table": 12, "Dashboard": 3}, {"OWNS": 4})

    rows = await _snapshots(db_session)
    deltas = json.loads(rows[1].type_deltas)["nodes"]
    assert deltas["added"] == {"Dashboard": 3}
    # Column vanished from the counts entirely — which is how the probe lane
    # reports a wiped label, since it drops zero-count buckets.
    assert deltas["removed"] == {"Column": 50}
    assert deltas["changed"] == {"Table": [10, 12]}


async def test_a_label_falling_to_explicit_zero_reads_as_removed(
    db_session: AsyncSession,
):
    """The two lanes spell a wiped label differently — the probe drops the
    bucket, the full scan can report 0. Both must mean the same thing."""
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10, "Column": 50}, {"OWNS": 4})
    await _write(db_session, ds_id, {"Table": 10, "Column": 0}, {"OWNS": 4})

    rows = await _snapshots(db_session)
    deltas = json.loads(rows[1].type_deltas)["nodes"]
    assert deltas["removed"] == {"Column": 50}
    assert "Column" not in deltas["changed"]


async def test_edge_type_deltas_are_tracked_separately(db_session: AsyncSession):
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4})
    await _write(db_session, ds_id, {"Table": 10}, {"OWNS": 4, "READS": 7})

    rows = await _snapshots(db_session)
    payload = json.loads(rows[1].type_deltas)
    assert payload["edges"]["added"] == {"READS": 7}
    assert payload["nodes"]["added"] == {}
    assert rows[1].edge_delta == 7


# ── provenance ───────────────────────────────────────────────────────

async def test_lane_is_recorded_per_observation(db_session: AsyncSession):
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 1}, {}, lane="probe")
    await _write(db_session, ds_id, {"Table": 2}, {}, lane="sweep")
    await _write(db_session, ds_id, {"Table": 3}, {}, lane="write")

    assert [r.lane for r in await _snapshots(db_session)] == ["probe", "sweep", "write"]


async def test_rollup_keys_are_denormalised_onto_the_snapshot(
    db_session: AsyncSession,
):
    """The per-provider rollup reads these instead of JOINing out of the stats
    domain, and they keep the row readable after the source is deleted."""
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {})

    row = (await _snapshots(db_session))[0]
    assert row.workspace_id == "ws_h1"
    assert row.provider_id == "prov_h1"
    assert row.graph_name == "hist-graph"


async def test_an_unknown_lane_is_coerced_rather_than_violating_the_check(
    db_session: AsyncSession,
):
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 1}, {}, lane="nonsense")
    assert (await _snapshots(db_session))[0].lane == "poll"


async def test_last_snapshot_at_is_stamped_on_the_stats_row(
    db_session: AsyncSession,
):
    """This marker is what makes the heartbeat check free — it is read off the
    row the upsert has already loaded."""
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {})
    await _write(db_session, ds_id, {"Table": 11}, {})

    stats = await stats_repo.get_data_source_stats(db_session, ds_id)
    rows = await _snapshots(db_session)
    assert stats.last_snapshot_at == rows[-1].captured_at


async def test_the_deep_facet_captures_too(db_session: AsyncSession):
    """All five writers feed one series — capturing in a single collector
    would make the history mean different things on different lanes."""
    ds_id = await _seed(db_session)
    await stats_repo.upsert_data_source_stats(
        session=db_session, ds_id=ds_id, node_count=7, edge_count=2,
        entity_type_counts=json.dumps({"Table": 7}),
        edge_type_counts=json.dumps({"OWNS": 2}),
        schema_stats="{}", ontology_metadata="{}", graph_schema="{}",
    )
    rows = await _snapshots(db_session)
    assert len(rows) == 1
    assert rows[0].lane == "deep"


async def test_a_stamp_only_touch_captures_nothing(db_session: AsyncSession):
    """``touch_probe_stamp`` writes no counts, so it has nothing to observe.
    Recording it would put a duplicate point in the series."""
    ds_id = await _seed(db_session)
    await _write(db_session, ds_id, {"Table": 10}, {})
    await stats_repo.touch_probe_stamp(db_session, ds_id)
    await stats_repo.touch_schema_freshness(db_session, ds_id)

    assert len(await _snapshots(db_session)) == 1


# ── policy resolution ────────────────────────────────────────────────

async def test_policy_falls_back_to_env_when_nothing_is_persisted(
    db_session: AsyncSession,
):
    policy = await stats_history_repo.resolve_history_policy(db_session)
    env = stats_history_repo.env_history_policy()
    assert policy.retention_days == env.env_retention_days
    assert policy.persisted_retention_days is None


async def test_persisted_overrides_win_and_are_floored(db_session: AsyncSession):
    """A retention of 0 days is not a supported way to turn history off — the
    master switch is. Clamping keeps a fat-fingered 0 from becoming a purge."""
    from backend.app.db.models import PlatformSettingsORM

    db_session.add(PlatformSettingsORM(
        id=1, history_retention_days=0, history_max_rows_per_source=42,
    ))
    await db_session.flush()
    stats_history_repo.invalidate_history_policy_cache()

    policy = await stats_history_repo.resolve_history_policy(db_session)
    assert policy.retention_days == 1
    assert policy.max_rows_per_source == 42
    assert policy.persisted_max_rows_per_source == 42
