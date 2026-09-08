"""The record that a check RAN, not just that a value moved.

``data_source_count_snapshots`` is change-gated, and a failed collection
deliberately writes nothing, so a source that has been steady all day and one
nobody has been able to reach all day produce the same picture there: no rows.
Reading liveness out of the absence of movement is the inference that hides an
outage.

These tests pin the other half — the pulse — and the sampling that keeps a 60s
lane from writing 1,440 rows a day about a source that neither changed nor
failed.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataSourceCheckEventORM
from backend.app.db.repositories import profiling_repo, stats_repo
from backend.app.db.repositories import stats_history_repo as hist


def _at(minutes_ago: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)


async def _events(session: AsyncSession, ds_id: str = "ds_a") -> list:
    rows = await session.execute(
        select(DataSourceCheckEventORM)
        .where(DataSourceCheckEventORM.data_source_id == ds_id)
        .order_by(DataSourceCheckEventORM.checked_at.asc())
    )
    return list(rows.scalars().all())


# ── the sampling rule ────────────────────────────────────────────────


async def test_the_first_check_of_a_lane_is_always_recorded(db_session: AsyncSession):
    row = await hist.record_check(db_session, ds_id="ds_a", lane="probe")
    assert row is not None
    assert len(await _events(db_session)) == 1


async def test_an_unchanged_check_inside_the_sample_window_is_coalesced(
    db_session: AsyncSession,
):
    """The whole reason this is affordable: the probe lane runs every 60s."""
    await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(2), sample_secs=300,
    )
    coalesced = await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(1), sample_secs=300,
    )
    assert coalesced is None
    assert len(await _events(db_session)) == 1


async def test_the_pulse_resumes_once_the_sample_window_passes(
    db_session: AsyncSession,
):
    """A healthy source must be a visible steady pulse, not one ancient row."""
    await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(20), sample_secs=300,
    )
    again = await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(1), sample_secs=300,
    )
    assert again is not None
    assert len(await _events(db_session)) == 2


async def test_a_failure_is_recorded_the_instant_it_happens(
    db_session: AsyncSession,
):
    """Sampling must never delay the transition into failure."""
    await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", now=_at(2), sample_secs=3600,
    )
    broke = await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", outcome="error",
        detail="connect timeout", now=_at(1), sample_secs=3600,
    )
    assert broke is not None
    assert [e.outcome for e in await _events(db_session)] == ["ok", "error"]


async def test_recovery_is_recorded_the_instant_it_happens(
    db_session: AsyncSession,
):
    await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", outcome="error",
        detail="boom", now=_at(2), sample_secs=3600,
    )
    healed = await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", now=_at(1), sample_secs=3600,
    )
    assert healed is not None


async def test_a_different_error_is_never_coalesced_behind_an_earlier_one(
    db_session: AsyncSession,
):
    """"Still failing" and "failing differently now" are different facts, and
    the second is the one that tells an operator what changed."""
    await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", outcome="error",
        detail="connect timeout", now=_at(2), sample_secs=3600,
    )
    different = await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", outcome="error",
        detail="WRONGPASS", now=_at(1), sample_secs=3600,
    )
    assert different is not None
    assert [e.detail for e in await _events(db_session)] == [
        "connect timeout", "WRONGPASS",
    ]


async def test_the_same_sustained_error_is_still_coalesced(
    db_session: AsyncSession,
):
    """A source stuck on one error for a day must not write a row a minute."""
    for minutes in (5, 4, 3):
        await hist.record_check(
            db_session, ds_id="ds_a", lane="poll", outcome="error",
            detail="connect timeout", now=_at(minutes), sample_secs=3600,
        )
    assert len(await _events(db_session)) == 1


async def test_lanes_are_sampled_independently(db_session: AsyncSession):
    """A 60s probe must not coalesce away the 15-minute deep lane's evidence."""
    await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(1), sample_secs=3600,
    )
    deep = await hist.record_check(
        db_session, ds_id="ds_a", lane="deep", now=_at(1), sample_secs=3600,
    )
    assert deep is not None
    assert {e.lane for e in await _events(db_session)} == {"probe", "deep"}


async def test_sample_secs_zero_records_every_check(db_session: AsyncSession):
    for minutes in (3, 2, 1):
        await hist.record_check(
            db_session, ds_id="ds_a", lane="probe", now=_at(minutes),
            sample_secs=0,
        )
    assert len(await _events(db_session)) == 3


async def test_an_unknown_lane_or_outcome_is_coerced_not_rejected(
    db_session: AsyncSession,
):
    """The CHECK constraints would abort the transaction the pulse rides on —
    for an observability row that is a wildly disproportionate failure."""
    row = await hist.record_check(
        db_session, ds_id="ds_a", lane="nonsense", outcome="whatever",
    )
    assert row.lane == "poll" and row.outcome == "ok"


# ── the write paths that feed it ─────────────────────────────────────


async def test_a_counts_write_pulses_even_when_the_snapshot_is_gated_away(
    db_session: AsyncSession,
):
    """The point of the whole table. Two identical polls capture ONE snapshot
    (nothing moved), and the second would otherwise leave no trace at all."""
    for _ in range(2):
        await stats_repo.upsert_data_source_stats_counts(
            session=db_session, ds_id="ds_a", node_count=7, edge_count=3,
            entity_type_counts='{"Table": 7}', edge_type_counts='{"FLOWS_TO": 3}',
            lane="probe",
        )
    events = await _events(db_session)
    assert len(events) >= 1
    assert events[0].lane == "probe" and events[0].outcome == "ok"
    assert events[0].changed is True          # first observation of this source


async def test_a_steady_reobservation_is_marked_unchanged(
    db_session: AsyncSession,
):
    await stats_repo.upsert_data_source_stats_counts(
        session=db_session, ds_id="ds_a", node_count=7, edge_count=3,
        entity_type_counts='{"Table": 7}', edge_type_counts='{"FLOWS_TO": 3}',
        lane="poll",
    )
    await hist.record_check(db_session, ds_id="ds_a", lane="poll", sample_secs=0,
                            changed=False)
    assert (await _events(db_session))[-1].changed is False


async def test_the_deep_lanes_unchanged_path_still_pulses(
    db_session: AsyncSession,
):
    """It writes no counts by design — the expensive scans are skipped — so
    without this a source the deep lane verified every 15 minutes for a day is
    indistinguishable from one it never reached."""
    # Seeded through the POLL lane so the deep lane has no prior pulse to be
    # coalesced against — lanes are sampled independently.
    await stats_repo.upsert_data_source_stats_counts(
        session=db_session, ds_id="ds_a", node_count=1, edge_count=0,
        entity_type_counts="{}", edge_type_counts="{}", lane="poll",
    )
    before = len(await _events(db_session))
    await stats_repo.touch_schema_freshness(db_session, "ds_a")
    after = await _events(db_session)
    assert len(after) == before + 1
    assert after[-1].lane == "deep" and after[-1].changed is False


async def test_a_probe_that_cannot_answer_records_skipped_not_ok(
    db_session: AsyncSession,
):
    """Recording it as ok would claim a validation that did not happen;
    recording nothing would leave the flat value series unexplained."""
    await stats_repo.upsert_data_source_stats_counts(
        session=db_session, ds_id="ds_a", node_count=1, edge_count=0,
        entity_type_counts="{}", edge_type_counts="{}", lane="poll",
    )
    await stats_repo.touch_probe_stamp(db_session, "ds_a")
    last = (await _events(db_session))[-1]
    assert last.lane == "probe" and last.outcome == "skipped"
    assert last.detail


# ── reads ────────────────────────────────────────────────────────────


async def test_the_summary_counts_the_window_not_the_page(
    db_session: AsyncSession,
):
    """"96 checks, all healthy" is a claim about the period — it cannot be read
    off whichever rows fit in a limit."""
    for minutes in range(10):
        await hist.record_check(
            db_session, ds_id="ds_a", lane="probe", now=_at(minutes),
            sample_secs=0,
        )
    await hist.record_check(
        db_session, ds_id="ds_a", lane="poll", outcome="error",
        detail="boom", now=_at(1), sample_secs=0,
    )

    frm, to = _at(600).isoformat(), _at(-1).isoformat()
    summary = await hist.check_summary(db_session, "ds_a", frm=frm, to=to)
    assert summary["total"] == 11
    assert summary["ok"] == 10 and summary["error"] == 1
    assert summary["lanes"]["probe"]["total"] == 10
    assert summary["lanes"]["poll"]["error"] == 1
    assert summary["first_at"] and summary["last_at"]

    listed = await hist.list_check_events(db_session, "ds_a", frm=frm, to=to)
    assert [r.checked_at for r in listed] == sorted(r.checked_at for r in listed)


async def test_the_window_bounds_are_honoured(db_session: AsyncSession):
    await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(600), sample_secs=0,
    )
    await hist.record_check(
        db_session, ds_id="ds_a", lane="probe", now=_at(1), sample_secs=0,
    )
    frm, to = _at(60).isoformat(), _at(-1).isoformat()
    assert len(await hist.list_check_events(db_session, "ds_a", frm=frm, to=to)) == 1
    assert (await hist.check_summary(db_session, "ds_a", frm=frm, to=to))["total"] == 1


# ── retention ────────────────────────────────────────────────────────


async def test_check_events_are_purged_by_age(db_session: AsyncSession):
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    db_session.add(DataSourceCheckEventORM(
        id="chk_old", data_source_id="ds_a", checked_at=old,
        lane="probe", outcome="ok",
    ))
    await hist.record_check(db_session, ds_id="ds_a", lane="probe", sample_secs=0)
    await db_session.flush()

    removed = await profiling_repo.purge_check_events(
        db_session, cutoff=profiling_repo.check_event_cutoff(),
    )
    assert removed == 1
    remaining = (await db_session.execute(
        select(func.count(DataSourceCheckEventORM.id))
    )).scalar_one()
    assert remaining == 1


async def test_an_empty_cutoff_purges_nothing(db_session: AsyncSession):
    """Same guard the raw tier carries: no cutoff means no deletion, never
    "delete everything"."""
    await hist.record_check(db_session, ds_id="ds_a", lane="probe", sample_secs=0)
    assert await profiling_repo.purge_check_events(db_session, cutoff="") == 0


# ── the graph-keyed lane ─────────────────────────────────────────────


async def test_a_graph_check_reaches_every_source_bound_to_that_graph(
    db_session: AsyncSession, monkeypatch,
):
    """Discovery is keyed on a PHYSICAL GRAPH. Several workspaces can bind the
    same one, they are all watching the same asset, and a check of it is a
    check of each of them."""
    from contextlib import asynccontextmanager

    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.db.repositories import stats_history_repo

    async def _seed(ds_id: str, ws: str, *, graph="g1", deleted=None, active=True):
        db_session.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id=ws, provider_id="prov_1", graph_name=graph,
            label=ds_id, is_primary=False, is_active=active,
            aggregation_status="none", aggregation_edge_count=0,
            is_restricted=False, deleted_at=deleted,
        ))

    await _seed("ds_one", "ws_1")
    await _seed("ds_two", "ws_2")
    await _seed("ds_gone", "ws_3", deleted="2026-01-01T00:00:00+00:00")
    await _seed("ds_other_graph", "ws_4", graph="g2")
    await db_session.flush()

    @asynccontextmanager
    async def _session():
        yield db_session

    monkeypatch.setattr(
        "backend.app.db.engine.get_jobs_session", _session, raising=False,
    )
    await stats_history_repo.record_graph_check_safe(
        provider_id="prov_1", graph_name="g1", lane="discovery",
    )

    reached = {e.data_source_id for e in await _events(db_session, "ds_one")}
    assert reached == {"ds_one"}
    assert len(await _events(db_session, "ds_two")) == 1
    # A soft-deleted source is not watching anything, and a different graph
    # was not checked.
    assert await _events(db_session, "ds_gone") == []
    assert await _events(db_session, "ds_other_graph") == []
