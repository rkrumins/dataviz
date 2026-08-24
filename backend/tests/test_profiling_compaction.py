"""Tiered profiling retention: compaction, and the floor it guarantees.

The point of compacting is not disk. It is that the previous scheme bounded
ROWS, and rows are not days: a source changing on every 60s probe hits a
5,000-row cap in under a week, so the per-source cap silently evicted exactly
the source whose 30-day history someone would come looking for. A day bucket
is one row however violently the source moved inside it, so coverage stops
being a function of volatility. These tests pin that.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DataSourceCountRollupORM,
    DataSourceCountSnapshotORM,
)
from backend.app.db.repositories import profiling_repo


NOW = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)


def _at(**delta) -> str:
    return (NOW - timedelta(**delta)).isoformat()


async def _snap(
    session: AsyncSession, ds_id: str, captured_at: str, *,
    nodes: int = 100, edges: int = 50, reason: str = "changed",
    types: str = '{"object": 100}', edge_types: str = '{"LINKS": 50}',
    workspace: str = "ws_1", provider: str = "prov_1",
):
    session.add(DataSourceCountSnapshotORM(
        id=f"snp_{ds_id}_{captured_at}",
        data_source_id=ds_id,
        captured_at=captured_at,
        workspace_id=workspace,
        provider_id=provider,
        graph_name="g",
        node_count=nodes,
        edge_count=edges,
        entity_type_counts=types,
        edge_type_counts=edge_types,
        counts_digest=f"d{nodes}:{edges}",
        lane="probe",
        capture_reason=reason,
    ))
    await session.flush()


async def _rollups(session: AsyncSession, grain: str) -> list:
    """Read rollups as plain rows, deliberately not as ORM instances.

    Compaction writes through Core DML (an upsert), which does not synchronize
    the ORM identity map — a mapped instance loaded here would answer with its
    pre-compaction values, and once expired would try to refresh itself
    lazily from inside an assertion, which in async SQLAlchemy is a
    MissingGreenlet rather than a wrong number. Selecting the table gives
    attribute access with none of that machinery attached.
    """
    return (await session.execute(
        select(DataSourceCountRollupORM.__table__)
        .where(DataSourceCountRollupORM.grain == grain)
        .order_by(DataSourceCountRollupORM.bucket_start)
    )).all()


async def _compact_all(session: AsyncSession, grain: str, *, now=NOW, passes: int = 40):
    """Run compaction to exhaustion, the way the scheduler does over ticks."""
    total = 0
    for _ in range(passes):
        written = await profiling_repo.compact(session, grain=grain, now=now)
        total += written
        if not written:
            break
    return total


# ── hour buckets from raw ────────────────────────────────────────────


async def test_an_hour_bucket_closes_on_its_last_observation(
    db_session: AsyncSession,
):
    """The closing value is what "how big was it at the end" means."""
    await _snap(db_session, "ds_a", _at(hours=3, minutes=50), nodes=100)
    await _snap(db_session, "ds_a", _at(hours=3, minutes=20), nodes=140)
    await _snap(db_session, "ds_a", _at(hours=3, minutes=1), nodes=120)

    await _compact_all(db_session, "hour")

    rows = await _rollups(db_session, "hour")
    assert len(rows) == 1
    # Latest captured_at in the bucket is the one nearest NOW.
    assert rows[0].node_count == 120
    assert rows[0].observations == 3


async def test_a_dip_that_recovered_inside_a_bucket_survives_the_downsample(
    db_session: AsyncSession,
):
    """A closing value alone would hide the very event this feature exists
    to surface — a drop that happened and came back."""
    await _snap(db_session, "ds_a", _at(hours=3, minutes=50), nodes=1000)
    await _snap(db_session, "ds_a", _at(hours=3, minutes=30), nodes=4)
    await _snap(db_session, "ds_a", _at(hours=3, minutes=10), nodes=1000)

    await _compact_all(db_session, "hour")

    row = (await _rollups(db_session, "hour"))[0]
    assert row.node_count == 1000, "closes where it ended"
    assert row.node_min == 4, "but the dip is still on the record"
    assert row.node_max == 1000


async def test_heartbeats_count_as_observations_but_not_as_changes(
    db_session: AsyncSession,
):
    """"One observation all day" and "1,440 identical observations" draw the
    same line and are very different facts."""
    await _snap(db_session, "ds_a", _at(hours=3, minutes=50), reason="changed")
    await _snap(db_session, "ds_a", _at(hours=3, minutes=30), reason="heartbeat")
    await _snap(db_session, "ds_a", _at(hours=3, minutes=10), reason="heartbeat")

    await _compact_all(db_session, "hour")

    row = (await _rollups(db_session, "hour"))[0]
    assert row.observations == 3
    assert row.changed_observations == 1


async def test_a_run_capture_counts_as_a_change(db_session: AsyncSession):
    """A run that moved nothing is still something that happened."""
    await _snap(db_session, "ds_a", _at(hours=3, minutes=50), reason="heartbeat")
    await _snap(db_session, "ds_a", _at(hours=3, minutes=10), reason="run")

    await _compact_all(db_session, "hour")

    assert (await _rollups(db_session, "hour"))[0].changed_observations == 1


async def test_the_midnight_bucket_is_not_lost(db_session: AsyncSession):
    """Regression: comparing a 13-char bucket key against a padded
    ``...T00:00:00+00:00`` bound sorts the key BEFORE the bound (equal
    prefix, shorter string first), which dropped every midnight bucket out
    of its own day."""
    midnight = datetime(2026, 8, 23, 0, 30, tzinfo=timezone.utc).isoformat()
    await _snap(db_session, "ds_a", midnight, nodes=77)

    await _compact_all(db_session, "hour")
    await _compact_all(db_session, "day")

    days = await _rollups(db_session, "day")
    assert [d.bucket_start for d in days] == ["2026-08-23"]
    assert days[0].node_count == 77


async def test_buckets_are_per_source(db_session: AsyncSession):
    await _snap(db_session, "ds_a", _at(hours=3), nodes=10)
    await _snap(db_session, "ds_b", _at(hours=3), nodes=20)

    await _compact_all(db_session, "hour")

    rows = await _rollups(db_session, "hour")
    assert sorted(r.node_count for r in rows) == [10, 20]


async def test_scope_keys_are_carried_onto_the_bucket(db_session: AsyncSession):
    """Workspace and provider series are sums of these rows, so a bucket that
    forgot its scope keys cannot be summed into anything."""
    await _snap(
        db_session, "ds_a", _at(hours=3), workspace="ws_9", provider="prov_9",
    )
    await _compact_all(db_session, "hour")

    row = (await _rollups(db_session, "hour"))[0]
    assert (row.workspace_id, row.provider_id) == ("ws_9", "prov_9")


# ── deltas ───────────────────────────────────────────────────────────


async def test_delta_is_against_the_previous_bucket_not_the_previous_row(
    db_session: AsyncSession,
):
    """A day's movement means "how much did this change over the day"."""
    await _snap(db_session, "ds_a", _at(hours=5, minutes=10), nodes=100)
    await _snap(db_session, "ds_a", _at(hours=4, minutes=50), nodes=250)
    await _snap(db_session, "ds_a", _at(hours=4, minutes=10), nodes=300)

    await _compact_all(db_session, "hour")

    rows = await _rollups(db_session, "hour")
    assert len(rows) == 2
    assert rows[0].node_delta is None, "nothing to be a delta from"
    assert rows[1].node_count == 300
    assert rows[1].node_delta == 200, "300 closing minus 100 closing"


async def test_edge_deltas_are_carried_too(db_session: AsyncSession):
    """Nodes and edges fail independently; an edge-blind rollup cannot show a
    loader that dropped every relationship."""
    await _snap(db_session, "ds_a", _at(hours=5), nodes=100, edges=900)
    await _snap(db_session, "ds_a", _at(hours=4), nodes=100, edges=3)

    await _compact_all(db_session, "hour")

    rows = await _rollups(db_session, "hour")
    assert rows[1].node_delta == 0
    assert rows[1].edge_delta == -897


# ── idempotency and resumability ─────────────────────────────────────


async def test_recompacting_refines_rather_than_duplicates(
    db_session: AsyncSession,
):
    """A pass killed halfway is simply re-run, so the write must converge."""
    await _snap(db_session, "ds_a", _at(hours=3, minutes=50), nodes=100)
    await _compact_all(db_session, "hour")
    first = await _rollups(db_session, "hour")
    assert len(first) == 1 and first[0].node_count == 100

    # More raw lands in the SAME bucket, as it does at the trailing edge.
    await _snap(db_session, "ds_a", _at(hours=3, minutes=5), nodes=175)
    await _compact_all(db_session, "hour")

    rows = await _rollups(db_session, "hour")
    assert len(rows) == 1, "refined in place, not duplicated"
    assert rows[0].node_count == 175
    assert rows[0].observations == 2


async def test_a_second_pass_over_unchanged_data_writes_the_same_values(
    db_session: AsyncSession,
):
    await _snap(db_session, "ds_a", _at(hours=3), nodes=100)
    await _compact_all(db_session, "hour")
    before = [(r.bucket_start, r.node_count) for r in await _rollups(db_session, "hour")]

    await _compact_all(db_session, "hour")
    after = [(r.bucket_start, r.node_count) for r in await _rollups(db_session, "hour")]

    assert before == after


async def test_compaction_is_bounded_per_pass(db_session: AsyncSession):
    """A first-run backfill over months of raw must not be one long pass."""
    for h in range(10):
        await _snap(db_session, "ds_a", _at(hours=20 - h), nodes=100 + h)

    written = await profiling_repo.compact(
        db_session, grain="hour", now=NOW, max_buckets=3,
    )
    assert written == 3, "one pass builds at most max_buckets"

    total = await _compact_all(db_session, "hour")
    assert len(await _rollups(db_session, "hour")) == 10, "later ticks finish it"


# ── day tier is built from hour, not raw ─────────────────────────────


async def test_day_buckets_are_built_from_hour_buckets(
    db_session: AsyncSession,
):
    """Built from hourly rather than raw so a day bucket survives the raw
    purge — which is the whole reason the tier exists."""
    await _snap(db_session, "ds_a", _at(hours=30), nodes=100)
    await _snap(db_session, "ds_a", _at(hours=29), nodes=200)
    await _snap(db_session, "ds_a", _at(hours=3), nodes=500)

    await _compact_all(db_session, "hour")
    await _compact_all(db_session, "day")

    # Delete every raw row: the day tier must be unaffected.
    await db_session.execute(
        DataSourceCountSnapshotORM.__table__.delete()
    )
    await db_session.flush()

    days = await _rollups(db_session, "day")
    assert len(days) == 2
    assert days[-1].node_count == 500


async def test_day_extremes_span_the_whole_day(db_session: AsyncSession):
    await _snap(db_session, "ds_a", _at(hours=30), nodes=1000)
    await _snap(db_session, "ds_a", _at(hours=29), nodes=2)
    await _snap(db_session, "ds_a", _at(hours=28), nodes=1000)

    await _compact_all(db_session, "hour")
    await _compact_all(db_session, "day")

    day = (await _rollups(db_session, "day"))[0]
    assert day.node_min == 2, "the dip is visible at day grain too"
    assert day.node_max == 1000


# ── purge never outruns compaction ───────────────────────────────────


async def test_raw_is_not_purged_before_it_has_been_compacted(
    db_session: AsyncSession,
):
    """The failure mode of a stalled compactor must be a table that grows —
    visible and recoverable — not observations that silently never landed."""
    await _snap(db_session, "ds_a", _at(days=40), nodes=100)
    await _snap(db_session, "ds_a", _at(days=39), nodes=200)

    policy = profiling_repo.RetentionPolicy(
        raw_days=7, hourly_days=45, daily_days=400, max_rows_per_source=5000,
    )
    # Nothing compacted yet.
    removed = await profiling_repo.purge_raw(
        db_session,
        cutoff=await profiling_repo.raw_purge_cutoff(db_session, policy, now=NOW),
    )
    assert removed == 0

    remaining = (await db_session.execute(
        select(func.count(DataSourceCountSnapshotORM.id))
    )).scalar_one()
    assert remaining == 2


async def test_raw_is_purged_once_it_has_been_compacted(
    db_session: AsyncSession,
):
    await _snap(db_session, "ds_a", _at(days=40), nodes=100)
    await _snap(db_session, "ds_a", _at(days=1), nodes=200)

    await _compact_all(db_session, "hour")

    policy = profiling_repo.RetentionPolicy(
        raw_days=7, hourly_days=45, daily_days=400, max_rows_per_source=5000,
    )
    removed = await profiling_repo.purge_raw(
        db_session,
        cutoff=await profiling_repo.raw_purge_cutoff(db_session, policy, now=NOW),
    )
    assert removed == 1, "the 40-day-old raw row is past the raw cutoff"

    # ...and its history is not lost: the bucket it fed is still there.
    hours = await _rollups(db_session, "hour")
    assert any(h.node_count == 100 for h in hours)


async def test_thirty_days_survives_a_source_thrashing_past_its_row_cap(
    db_session: AsyncSession,
):
    """The requirement this whole tier exists for.

    A source changing on every probe blows through any row cap in days. Under
    the old flat scheme that evicted its own history; here the cap only ever
    touches raw, and the day tier still spans the full window.
    """
    # 40 days of history, several observations per day.
    for day in range(40):
        for hour in (2, 10, 18):
            await _snap(
                db_session, "ds_a",
                _at(days=day, hours=hour),
                nodes=1000 + day * 7 + hour,
            )

    await _compact_all(db_session, "hour", passes=400)
    await _compact_all(db_session, "day", passes=400)

    policy = profiling_repo.RetentionPolicy(
        raw_days=7, hourly_days=45, daily_days=400, max_rows_per_source=10,
    )
    # Retention runs, including the aggressive raw cap.
    for _ in range(20):
        result = await profiling_repo.run_retention(db_session, policy, now=NOW)
        if not any(result.values()):
            break

    days = await _rollups(db_session, "day")
    assert len(days) >= 30, (
        f"the 30-day floor must survive the raw cap; got {len(days)} day buckets"
    )


async def test_rollup_tiers_are_purged_on_their_own_cutoffs(
    db_session: AsyncSession,
):
    await _snap(db_session, "ds_a", _at(days=100), nodes=100)
    await _snap(db_session, "ds_a", _at(days=1), nodes=200)

    await _compact_all(db_session, "hour", passes=3000)
    await _compact_all(db_session, "day", passes=3000)

    policy = profiling_repo.RetentionPolicy(
        raw_days=7, hourly_days=45, daily_days=400, max_rows_per_source=5000,
    )
    for _ in range(20):
        result = await profiling_repo.run_retention(db_session, policy, now=NOW)
        if not any(result.values()):
            break

    hours = await _rollups(db_session, "hour")
    days = await _rollups(db_session, "day")
    assert all(h.bucket_start >= "2026-07" for h in hours), "hourly trimmed at 45d"
    assert any(d.bucket_start.startswith("2026-05") for d in days), "daily kept"
