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
