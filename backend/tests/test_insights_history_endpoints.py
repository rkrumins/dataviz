"""Counts-history read endpoints.

Calls the handlers directly with a real ``db_session`` rather than going
through HTTP: the router mounts behind ``system:admin`` and the interesting
behaviour here is entirely in the payload assembly — the window defaults, the
grain choice, the downsample, and the two things a downsample must not lose.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import insights
from backend.app.db.models import (
    CatalogItemORM,
    DataSourceCountSnapshotORM,
    ProviderORM,
)
from backend.app.db.repositories import stats_history_repo


DS_ID = "ds_ep1"


def _iso(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


async def _snap(
    session: AsyncSession,
    *,
    at: str,
    entities: dict,
    ds_id: str = DS_ID,
    delta: int | None = None,
    reason: str = "changed",
    provider_id: str = "prov_ep1",
    graph_name: str = "ep-graph",
    edges: dict | None = None,
):
    edges = edges or {}
    session.add(DataSourceCountSnapshotORM(
        id=f"snp_{ds_id}_{at}",
        data_source_id=ds_id,
        captured_at=at,
        provider_id=provider_id,
        graph_name=graph_name,
        workspace_id="ws_ep1",
        node_count=sum(entities.values()),
        edge_count=sum(edges.values()),
        entity_type_counts=json.dumps(entities),
        edge_type_counts=json.dumps(edges),
        counts_digest="d",
        lane="probe",
        capture_reason=reason,
        node_delta=delta,
        type_deltas=json.dumps({
            "nodes": {"added": {}, "removed": {}, "changed": {}},
            "edges": {"added": {}, "removed": {}, "changed": {}},
        }) if delta is not None else None,
    ))
    await session.flush()


@pytest.fixture(autouse=True)
def _clear_policy_cache():
    stats_history_repo.invalidate_history_policy_cache()
    yield
    stats_history_repo.invalidate_history_policy_cache()


# ── envelope ─────────────────────────────────────────────────────────

async def test_no_history_reports_computing_rather_than_404(
    db_session: AsyncSession,
):
    """A source whose first snapshot has not landed is a normal, self-resolving
    state. A 404 would read as "this source does not exist"."""
    result = await insights.get_data_source_history(
        ds_id="ds_never_seen", session=db_session,
    )
    assert result["meta"]["status"] == "computing"
    assert result["meta"]["source"] == "none"
    assert result["data"]["points"] == []


async def test_history_reports_fresh_when_points_exist(db_session: AsyncSession):
    await _snap(db_session, at=_iso(3), entities={"Table": 10})
    await _snap(db_session, at=_iso(1), entities={"Table": 12}, delta=2)

    result = await insights.get_data_source_history(ds_id=DS_ID, session=db_session)
    assert result["meta"]["status"] == "fresh"
    assert len(result["data"]["points"]) == 2


# ── window + grain ───────────────────────────────────────────────────

async def test_the_default_window_is_thirty_days(db_session: AsyncSession):
    await _snap(db_session, at=_iso(1), entities={"Table": 1})
    result = await insights.get_data_source_history(ds_id=DS_ID, session=db_session)

    frm = datetime.fromisoformat(result["data"]["from"])
    span_days = (datetime.now(timezone.utc) - frm).days
    assert 29 <= span_days <= 30


async def test_a_short_window_stays_raw(db_session: AsyncSession):
    """Erring toward raw is deliberate: the value of this view is seeing the
    exact moment something changed."""
    for hours in (5, 4, 3):
        await _snap(db_session, at=_iso(hours), entities={"Table": hours})

    # grain=None is what FastAPI passes for an absent query param; calling the
    # handler directly would otherwise hand it the unresolved Query default and
    # never exercise the auto path at all.
    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), to=None, grain=None, session=db_session,
    )
    assert result["data"]["grain"] == "raw"
    assert len(result["data"]["points"]) == 3


async def test_a_long_window_downsamples_to_days(db_session: AsyncSession):
    for hours in (24 * 40, 24 * 20, 24 * 5, 1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 1})

    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24 * 60), to=None, grain=None, session=db_session,
    )
    assert result["data"]["grain"] == "day"


async def test_a_mid_length_window_downsamples_to_hours(db_session: AsyncSession):
    for hours in (24 * 6, 24 * 3, 2):
        await _snap(db_session, at=_iso(hours), entities={"Table": 1})

    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24 * 7), to=None, grain=None, session=db_session,
    )
    assert result["data"]["grain"] == "hour"


async def test_an_explicit_grain_is_honoured(db_session: AsyncSession):
    for hours in (5, 4, 3):
        await _snap(db_session, at=_iso(hours), entities={"Table": hours})

    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), grain="day", session=db_session,
    )
    assert result["data"]["grain"] == "day"
    # One bucket for one day — the closing observation of it.
    assert len(result["data"]["points"]) == 1


async def test_a_bucket_keeps_its_closing_observation(db_session: AsyncSession):
    await _snap(db_session, at=_iso(6), entities={"Table": 10})
    await _snap(db_session, at=_iso(5), entities={"Table": 40})
    await _snap(db_session, at=_iso(4), entities={"Table": 25})

    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), grain="day", session=db_session,
    )
    assert result["data"]["points"][-1]["node_count"] == 25


async def test_a_downsampled_bucket_still_reports_its_extremes(
    db_session: AsyncSession,
):
    """Without the band, a drop that happened and recovered inside a bucket
    would vanish at day grain — exactly the event this feature exists for."""
    await _snap(db_session, at=_iso(6), entities={"Table": 100})
    await _snap(db_session, at=_iso(5), entities={"Table": 4})
    await _snap(db_session, at=_iso(4), entities={"Table": 100})

    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), grain="day", session=db_session,
    )
    point = result["data"]["points"][-1]
    assert point["node_min"] == 4
    assert point["node_max"] == 100


async def test_raw_grain_carries_no_band(db_session: AsyncSession):
    await _snap(db_session, at=_iso(3), entities={"Table": 10})
    await _snap(db_session, at=_iso(2), entities={"Table": 12})

    result = await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), grain="raw", session=db_session,
    )
    assert result["data"]["points"][0]["node_min"] is None


# ── summary ──────────────────────────────────────────────────────────

async def test_label_states_name_what_appeared_and_disappeared(
    db_session: AsyncSession,
):
    await _snap(db_session, at=_iso(3), entities={"Table": 10, "Column": 50})
    await _snap(db_session, at=_iso(1), entities={"Table": 12, "Dashboard": 3})

    summary = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    ))["data"]["summary"]
    assert summary["labels_added"] == ["Dashboard"]
    assert summary["labels_removed"] == ["Column"]


async def test_the_largest_drop_is_found_from_the_raw_rows(
    db_session: AsyncSession,
):
    """Computed from raw even when the view is downsampled — a drop is exactly
    what a downsample can average away, and the marker must point at the moment
    it actually happened."""
    await _snap(db_session, at=_iso(30), entities={"Table": 1000})
    await _snap(db_session, at=_iso(29), entities={"Table": 100}, delta=-900)
    await _snap(db_session, at=_iso(28), entities={"Table": 1000}, delta=900)

    summary = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="day", session=db_session,
    ))["data"]["summary"]
    assert summary["largest_drop"] is not None
    assert summary["largest_drop"]["delta"] == -900
    assert summary["largest_drop"]["before"] == 1000


async def test_no_drop_reports_none(db_session: AsyncSession):
    await _snap(db_session, at=_iso(3), entities={"Table": 10})
    await _snap(db_session, at=_iso(1), entities={"Table": 20}, delta=10)

    summary = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    ))["data"]["summary"]
    assert summary["largest_drop"] is None


async def test_coverage_from_reports_the_oldest_row_at_any_age(
    db_session: AsyncSession,
):
    """So a series that simply started last Tuesday does not read as one that
    lost everything before Tuesday."""
    await _snap(db_session, at=_iso(24 * 200), entities={"Table": 1})
    await _snap(db_session, at=_iso(1), entities={"Table": 5})

    summary = (await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), session=db_session,
    ))["data"]["summary"]
    assert summary["coverage_from"] is not None
    assert "200" not in summary["coverage_from"]  # sanity: it is a timestamp
    oldest = datetime.fromisoformat(summary["coverage_from"])
    assert (datetime.now(timezone.utc) - oldest).days >= 199


async def test_pct_change_is_none_from_a_zero_baseline(db_session: AsyncSession):
    """A graph that went from 0 to 40,000 did not grow by a percentage."""
    await _snap(db_session, at=_iso(3), entities={})
    await _snap(db_session, at=_iso(1), entities={"Table": 40000}, delta=40000)

    summary = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    ))["data"]["summary"]
    assert summary["node_pct_change"] is None
    assert summary["node_delta"] == 40000


async def test_heartbeat_rows_are_not_counted_as_changes(
    db_session: AsyncSession,
):
    await _snap(db_session, at=_iso(4), entities={"Table": 10}, reason="first")
    await _snap(db_session, at=_iso(3), entities={"Table": 10}, reason="heartbeat")
    await _snap(db_session, at=_iso(2), entities={"Table": 11}, reason="changed", delta=1)

    summary = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    ))["data"]["summary"]
    assert summary["snapshots"] == 3
    assert summary["changed_snapshots"] == 2  # first + changed, not heartbeat


# ── catalog resolution ───────────────────────────────────────────────

async def test_a_catalog_id_resolves_to_the_data_source_that_observed_it(
    db_session: AsyncSession,
):
    """Keeps a bare /datasources/<id>/history link working when shared — the
    route carries a catalog id, history is keyed on the data source."""
    db_session.add(ProviderORM(id="prov_ep1", name="P", provider_type="falkordb"))
    db_session.add(CatalogItemORM(
        id="cat_ep1", provider_id="prov_ep1", source_identifier="ep-graph", name="EP",
    ))
    await db_session.flush()
    await _snap(db_session, at=_iso(2), entities={"Table": 10})

    result = await insights.get_data_source_history(
        ds_id="cat_ep1", grain="raw", session=db_session,
    )
    assert result["meta"]["status"] == "fresh"
    assert result["data"]["data_source_id"] == DS_ID


async def test_an_unresolvable_catalog_id_reports_no_history(
    db_session: AsyncSession,
):
    result = await insights.get_data_source_history(
        ds_id="cat_missing", session=db_session,
    )
    assert result["meta"]["status"] == "computing"


# ── provider rollup ──────────────────────────────────────────────────

async def test_the_provider_rollup_sums_across_sources(db_session: AsyncSession):
    await _snap(db_session, at=_iso(3), entities={"Table": 10}, ds_id="ds_x",
                graph_name="gx")
    await _snap(db_session, at=_iso(3), entities={"Table": 40}, ds_id="ds_y",
                graph_name="gy")

    result = await insights.get_provider_history(
        provider_id="prov_ep1", frm=_iso(24), grain="hour", session=db_session,
    )
    assert result["meta"]["status"] == "fresh"
    assert result["data"]["totals"][-1]["node_count"] == 50
    assert result["data"]["totals"][-1]["sources"] == 2


async def test_a_source_not_observed_in_a_bucket_carries_forward(
    db_session: AsyncSession,
):
    """It did not drop to zero, and a stacked chart implying it did would
    invent an outage."""
    await _snap(db_session, at=_iso(5), entities={"Table": 10}, ds_id="ds_x",
                graph_name="gx")
    await _snap(db_session, at=_iso(5), entities={"Table": 40}, ds_id="ds_y",
                graph_name="gy")
    # Only ds_x reports in the later bucket.
    await _snap(db_session, at=_iso(1), entities={"Table": 11}, ds_id="ds_x",
                graph_name="gx")

    result = await insights.get_provider_history(
        provider_id="prov_ep1", frm=_iso(24), grain="hour", session=db_session,
    )
    assert result["data"]["totals"][-1]["node_count"] == 51


async def test_the_provider_rollup_never_serves_raw_grain(
    db_session: AsyncSession,
):
    """Raw across N sources is N interleaved time axes, which no stacked chart
    can render honestly."""
    await _snap(db_session, at=_iso(2), entities={"Table": 1}, ds_id="ds_x")

    result = await insights.get_provider_history(
        provider_id="prov_ep1", frm=_iso(24), grain="raw", session=db_session,
    )
    assert result["data"]["grain"] == "hour"


async def test_an_empty_provider_reports_computing(db_session: AsyncSession):
    result = await insights.get_provider_history(
        provider_id="prov_nothing", session=db_session,
    )
    assert result["meta"]["status"] == "computing"
    assert result["data"]["totals"] == []


# ── significance ─────────────────────────────────────────────────────

async def test_significance_is_relative_to_the_source_s_own_baseline(
    db_session: AsyncSession,
):
    """900 lost rows is catastrophic for a source that never moves and a
    Tuesday for one that rebuilds nightly. A fixed threshold cannot tell them
    apart; this is the whole reason the baseline exists."""
    # A source that routinely moves by ~1000.
    for i, hours in enumerate(range(20, 10, -1)):
        await _snap(
            db_session, at=_iso(hours), entities={"Table": 10_000 + i * 1000},
            delta=1000,
        )
    # ...then moves by 1000 again. Ordinary for this source.
    await _snap(db_session, at=_iso(2), entities={"Table": 30_000}, delta=1000)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "normal"
    assert result["data"]["summary"]["change_baseline"] == 1000


async def test_a_movement_far_outside_the_baseline_is_severe(
    db_session: AsyncSession,
):
    # A tenth of the graph, on a source that normally moves by ten. Far
    # outside its own range, and deliberately NOT proportionally catastrophic
    # — that is the next test.
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 10_000}, delta=10)
    await _snap(db_session, at=_iso(2), entities={"Table": 9_000}, delta=-1_000)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "severe"
    assert result["data"]["summary"]["severe_changes"] == 1


async def test_a_near_total_loss_is_critical(db_session: AsyncSession):
    """Measured against the GRAPH, not against the source's churn — a wipe is
    not a statistical outlier, it is an outage."""
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 10_000}, delta=10)
    await _snap(db_session, at=_iso(2), entities={"Table": 100}, delta=-9_900)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "critical"
    # Critical counts into the severe tally on purpose: the tile asks "how
    # much needs attention", and splitting the worst tier out under-reports it.
    assert result["data"]["summary"]["severe_changes"] == 1


async def test_a_big_rise_is_never_critical(db_session: AsyncSession):
    """The proportional tier is asymmetric. A graph doubling is dramatic and
    recoverable; one that is nearly gone may have nothing left to recover
    from."""
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 10_000}, delta=10)
    await _snap(db_session, at=_iso(2), entities={"Table": 500_000}, delta=490_000)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "severe"


async def test_a_tiny_graph_losing_almost_everything_is_not_critical(
    db_session: AsyncSession,
):
    """Below the floor the proportion carries no signal — an 11-node fixture
    losing 10 of them is 91% and not an incident."""
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 11}, delta=1)
    await _snap(db_session, at=_iso(2), entities={"Table": 1}, delta=-10)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "normal"


async def test_significance_is_symmetric(db_session: AsyncSession):
    """A graph that tripled overnight is as worth looking at as one that lost
    two thirds — a runaway loader duplicating every node is a real failure."""
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 10_000}, delta=10)
    await _snap(db_session, at=_iso(2), entities={"Table": 40_000}, delta=30_000)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "severe"


async def test_a_perfectly_still_source_does_not_call_one_node_severe(
    db_session: AsyncSession,
):
    """Without the floor the baseline is 0, every multiple of it is 0, and the
    first movement of any size reads as severe."""
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), entities={"Table": 10},
                    reason="heartbeat", delta=0)
    await _snap(db_session, at=_iso(2), entities={"Table": 11}, delta=1)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    )
    assert result["data"]["points"][-1]["significance"] == "normal"


async def test_significance_is_computed_from_raw_even_at_day_grain(
    db_session: AsyncSession,
):
    for hours in range(200, 100, -10):
        await _snap(db_session, at=_iso(hours), entities={"Table": 10_000}, delta=10)
    await _snap(db_session, at=_iso(50), entities={"Table": 100}, delta=-9_900)

    result = await insights.get_data_source_history(
        ds_id=DS_ID, grain="day", session=db_session,
    )
    assert result["data"]["summary"]["severe_changes"] == 1


# ── correlated events ────────────────────────────────────────────────

async def _event(session: AsyncSession, *, ts: str, origin: str = "reconcile-sweep",
                 outcome: str = "accepted", reason: str | None = None,
                 ds_id: str = DS_ID):
    from backend.app.db.models import RefreshEventORM

    session.add(RefreshEventORM(
        id=f"evt_{ts}", ts=ts, data_source_id=ds_id, origin=origin,
        actor="internal", scope="auto", gate="changed", outcome=outcome,
        reason=reason,
    ))
    await session.flush()


async def test_events_in_the_window_are_returned_with_the_history(
    db_session: AsyncSession,
):
    """The snapshot says what the numbers did; the event says what the platform
    was doing. Correlating them is how "an external process broke something"
    stops being a guess."""
    await _snap(db_session, at=_iso(3), entities={"Table": 1000})
    await _event(db_session, ts=_iso(2), reason="overlay_shrunk")
    await _snap(db_session, at=_iso(1), entities={"Table": 40}, delta=-960)

    events = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    ))["data"]["events"]
    assert len(events) == 1
    assert events[0]["origin"] == "reconcile-sweep"
    assert events[0]["reason"] == "overlay_shrunk"


async def test_events_outside_the_window_are_excluded(db_session: AsyncSession):
    await _snap(db_session, at=_iso(2), entities={"Table": 10})
    await _event(db_session, ts=_iso(24 * 90))

    events = (await insights.get_data_source_history(
        ds_id=DS_ID, frm=_iso(24), grain="raw", session=db_session,
    ))["data"]["events"]
    assert events == []


async def test_another_source_s_events_are_not_correlated(
    db_session: AsyncSession,
):
    await _snap(db_session, at=_iso(2), entities={"Table": 10})
    await _event(db_session, ts=_iso(2), ds_id="ds_someone_else")

    events = (await insights.get_data_source_history(
        ds_id=DS_ID, grain="raw", session=db_session,
    ))["data"]["events"]
    assert events == []


# ── fleet rollup ─────────────────────────────────────────────────────

async def test_the_fleet_rollup_sums_across_providers(db_session: AsyncSession):
    await _snap(db_session, at=_iso(3), entities={"Table": 10}, ds_id="ds_a",
                provider_id="prov_1", graph_name="ga")
    await _snap(db_session, at=_iso(3), entities={"Table": 40}, ds_id="ds_b",
                provider_id="prov_2", graph_name="gb")

    result = await insights.get_fleet_history(
        frm=_iso(24), grain="hour", session=db_session,
    )
    assert result["data"]["totals"][-1]["node_count"] == 50
    assert {s["data_source_id"] for s in result["data"]["sources"]} == {
        "prov_1", "prov_2",
    }


async def test_a_provider_s_sources_are_summed_into_one_fleet_series(
    db_session: AsyncSession,
):
    await _snap(db_session, at=_iso(3), entities={"Table": 10}, ds_id="ds_a",
                provider_id="prov_1", graph_name="ga")
    await _snap(db_session, at=_iso(3), entities={"Table": 25}, ds_id="ds_b",
                provider_id="prov_1", graph_name="gb")

    result = await insights.get_fleet_history(
        frm=_iso(24), grain="hour", session=db_session,
    )
    assert len(result["data"]["sources"]) == 1
    assert result["data"]["sources"][0]["points"][-1]["node_count"] == 35
    # Two data sources behind that one provider series.
    assert result["data"]["totals"][-1]["sources"] == 2


async def test_the_fleet_rollup_resolves_provider_names(db_session: AsyncSession):
    db_session.add(ProviderORM(id="prov_1", name="Falkor Prod",
                               provider_type="falkordb"))
    await db_session.flush()
    await _snap(db_session, at=_iso(3), entities={"Table": 10}, ds_id="ds_a",
                provider_id="prov_1", graph_name="ga")

    result = await insights.get_fleet_history(
        frm=_iso(24), grain="hour", session=db_session,
    )
    assert result["data"]["sources"][0]["name"] == "Falkor Prod"


async def test_an_empty_fleet_reports_computing(db_session: AsyncSession):
    result = await insights.get_fleet_history(session=db_session)
    assert result["meta"]["status"] == "computing"


# ── CSV export ───────────────────────────────────────────────────────

async def test_the_csv_export_is_always_raw(db_session: AsyncSession):
    """Downsampling is a rendering concession; an export is evidence."""
    await _snap(db_session, at=_iso(6), entities={"Table": 100})
    await _snap(db_session, at=_iso(5), entities={"Table": 4}, delta=-96)
    await _snap(db_session, at=_iso(4), entities={"Table": 100}, delta=96)

    response = await insights.export_data_source_history_csv(
        ds_id=DS_ID, frm=_iso(24), session=db_session,
    )
    body = response.body.decode()
    lines = [l for l in body.splitlines() if l.strip()]
    assert len(lines) == 4  # header + 3 raw rows, no bucketing
    assert response.media_type == "text/csv"
    assert "attachment" in response.headers["Content-Disposition"]


async def test_the_csv_has_one_column_per_label_across_the_window(
    db_session: AsyncSession,
):
    """A label that disappeared still gets a column, so its zeroes are visible
    rather than the rows being ragged."""
    await _snap(db_session, at=_iso(5), entities={"Table": 10, "Column": 50})
    await _snap(db_session, at=_iso(4), entities={"Table": 12}, delta=-48)

    import csv as _csv
    import io as _io

    body = (await insights.export_data_source_history_csv(
        ds_id=DS_ID, frm=_iso(24), session=db_session,
    )).body.decode()
    rows = list(_csv.DictReader(_io.StringIO(body)))
    assert rows[0]["node:Column"] == "50"
    assert rows[0]["node:Table"] == "10"
    # Column is gone by the second observation — reported as 0, not blank, so
    # the disappearance is visible in the data rather than a ragged row.
    assert rows[1]["node:Column"] == "0"
    assert rows[1]["node:Table"] == "12"


async def test_the_csv_export_accepts_a_catalog_id(db_session: AsyncSession):
    db_session.add(ProviderORM(id="prov_ep1", name="P", provider_type="falkordb"))
    db_session.add(CatalogItemORM(
        id="cat_ep1", provider_id="prov_ep1", source_identifier="ep-graph", name="EP",
    ))
    await db_session.flush()
    await _snap(db_session, at=_iso(2), entities={"Table": 10})

    body = (await insights.export_data_source_history_csv(
        ds_id="cat_ep1", session=db_session,
    )).body.decode()
    assert len([l for l in body.splitlines() if l.strip()]) == 2


# ── rollup correctness at scale ──────────────────────────────────────

async def test_a_rollup_bucket_keeps_each_source_s_closing_value(
    db_session: AsyncSession,
):
    """Reduction happens in SQL, so the handler never sees a source's earlier
    observations in a bucket — only its last."""
    for hours, count in ((6, 10), (5, 20), (4, 35)):
        await _snap(db_session, at=_iso(hours), entities={"Table": count},
                    ds_id="ds_x", provider_id="prov_ep1", graph_name="gx")

    result = await insights.get_provider_history(
        provider_id="prov_ep1", frm=_iso(24), grain="day", session=db_session,
    )
    assert result["data"]["totals"][-1]["node_count"] == 35


async def test_a_rollup_total_is_not_truncated_by_a_busy_fleet(
    db_session: AsyncSession,
):
    """The reason bucketing moved into SQL. Reading raw rows under a cap made
    the total a function of how busy the fleet had been, and a truncated read
    reported a number that was simply wrong with nothing to say so."""
    # Two sources, each observed many times in the same day.
    for i in range(60):
        await _snap(db_session, at=_iso(20 - i * 0.25), entities={"Table": i},
                    ds_id="ds_x", provider_id="prov_ep1", graph_name="gx")
    for i in range(60):
        await _snap(db_session, at=_iso(20 - i * 0.25), entities={"Table": 100 + i},
                    ds_id="ds_y", provider_id="prov_ep1", graph_name="gy")

    result = await insights.get_provider_history(
        provider_id="prov_ep1", frm=_iso(48), grain="day", session=db_session,
    )
    # Closing values only: 59 + 159, regardless of the 120 observations behind
    # them.
    assert result["data"]["totals"][-1]["node_count"] == 59 + 159
    assert result["data"]["totals"][-1]["sources"] == 2


async def test_rollup_timestamps_are_parseable_instants(
    db_session: AsyncSession,
):
    """An hour bucket is `2026-08-20T14`, which is not a timestamp in Python or
    JavaScript — emitting the raw key left the rollup charts unable to label
    their own axis."""
    from datetime import datetime as _dt

    await _snap(db_session, at=_iso(3), entities={"Table": 10}, ds_id="ds_x",
                provider_id="prov_ep1", graph_name="gx")

    for grain in ("hour", "day"):
        result = await insights.get_provider_history(
            provider_id="prov_ep1", frm=_iso(24), grain=grain, session=db_session,
        )
        for point in result["data"]["totals"]:
            _dt.fromisoformat(point["at"])  # raises if it is only a prefix
        for source in result["data"]["sources"]:
            for point in source["points"]:
                _dt.fromisoformat(point["at"])


# ── alerts on the insights router ────────────────────────────────────

async def _alert(session: AsyncSession, *, alert_id: str, ds_id: str = DS_ID,
                 severity: str = "severe", acked: str | None = None,
                 detected: str | None = None):
    from backend.app.db.models import DataSourceCountAlertORM

    at = detected or _iso(2)
    session.add(DataSourceCountAlertORM(
        id=alert_id, data_source_id=ds_id, detected_at=at, observed_at=at,
        provider_id="prov_ep1", graph_name="ep-graph", catalog_item_id="cat_ep1",
        severity=severity, direction="drop", node_delta=-900, node_count=100,
        baseline=25, acknowledged_at=acked,
        evidence=json.dumps({"nodes": {"removed": {"Column": 900}}}),
    ))
    await session.flush()


async def test_alerts_list_newest_first_with_their_evidence(
    db_session: AsyncSession,
):
    await _alert(db_session, alert_id="alr_old", detected=_iso(10))
    await _alert(db_session, alert_id="alr_new", detected=_iso(1))

    result = await insights.list_count_alerts(
        ds_id=None, open_only=False, limit=100, session=db_session,
    )
    assert [a["id"] for a in result.alerts] == ["alr_new", "alr_old"]
    assert result.alerts[0]["evidence"]["nodes"]["removed"] == {"Column": 900}
    assert result.alerts[0]["baseline"] == 25


async def test_the_open_count_spans_the_fleet_not_the_page(
    db_session: AsyncSession,
):
    """It drives a badge. A badge that only counted what fits on screen would
    under-report exactly when there is most to report."""
    await _alert(db_session, alert_id="alr_1", ds_id="ds_a")
    await _alert(db_session, alert_id="alr_2", ds_id="ds_b")
    await _alert(db_session, alert_id="alr_3", ds_id="ds_c", acked=_iso(1))

    scoped = await insights.list_count_alerts(
        ds_id="ds_a", open_only=False, limit=100, session=db_session,
    )
    assert len(scoped.alerts) == 1
    assert scoped.open_count == 2  # fleet-wide unacknowledged


async def test_alerts_can_be_filtered_to_open_ones(db_session: AsyncSession):
    await _alert(db_session, alert_id="alr_open")
    await _alert(db_session, alert_id="alr_done", acked=_iso(1))

    result = await insights.list_count_alerts(
        ds_id=None, open_only=True, limit=100, session=db_session,
    )
    assert [a["id"] for a in result.alerts] == ["alr_open"]


async def test_alerts_accept_a_catalog_id_like_the_history_does(
    db_session: AsyncSession,
):
    db_session.add(ProviderORM(id="prov_ep1", name="P", provider_type="falkordb"))
    db_session.add(CatalogItemORM(
        id="cat_ep1", provider_id="prov_ep1", source_identifier="ep-graph", name="EP",
    ))
    await db_session.flush()
    await _snap(db_session, at=_iso(2), entities={"Table": 10})
    await _alert(db_session, alert_id="alr_1")

    result = await insights.list_count_alerts(
        ds_id="cat_ep1", open_only=False, limit=100, session=db_session,
    )
    assert [a["id"] for a in result.alerts] == ["alr_1"]


async def test_acknowledging_stamps_the_actor(db_session: AsyncSession):
    from types import SimpleNamespace

    await _alert(db_session, alert_id="alr_1")
    row = await insights.acknowledge_count_alert(
        alert_id="alr_1", user=SimpleNamespace(id="u1"), session=db_session,
    )
    assert row["acknowledged_by"] == "u1"
    assert row["acknowledged_at"] is not None


async def test_acknowledging_a_missing_alert_is_a_404(db_session: AsyncSession):
    from types import SimpleNamespace

    import fastapi

    with pytest.raises(fastapi.HTTPException) as exc:
        await insights.acknowledge_count_alert(
            alert_id="alr_nope", user=SimpleNamespace(id="u1"), session=db_session,
        )
    assert exc.value.status_code == 404


async def test_the_alert_policy_round_trips(db_session: AsyncSession):
    before = await insights.get_alert_policy(session=db_session)
    assert before.enabled is None                       # nothing persisted
    assert before.effective_enabled == before.env_enabled

    after = await insights.put_alert_policy(
        req=insights.AlertPolicyRequest(
            enabled=False, minSeverity="notable", cooldownSecs=1800,
        ),
        session=db_session,
    )
    assert after.enabled is False
    assert after.effective_min_severity == "notable"
    assert after.effective_cooldown_secs == 1800


async def test_the_policy_clears_a_cooldown_override_with_the_sentinel(
    db_session: AsyncSession,
):
    await insights.put_alert_policy(
        req=insights.AlertPolicyRequest(cooldownSecs=1800), session=db_session,
    )
    cleared = await insights.put_alert_policy(
        req=insights.AlertPolicyRequest(cooldownSecs=-1), session=db_session,
    )
    assert cleared.cooldown_secs is None
    assert cleared.effective_cooldown_secs == cleared.env_cooldown_secs


async def test_an_unknown_severity_is_refused_rather_than_stored(
    db_session: AsyncSession,
):
    import fastapi

    with pytest.raises(fastapi.HTTPException) as exc:
        await insights.put_alert_policy(
            req=insights.AlertPolicyRequest(minSeverity="catastrophic"),
            session=db_session,
        )
    assert exc.value.status_code == 422
