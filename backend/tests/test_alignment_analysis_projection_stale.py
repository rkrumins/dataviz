"""Data health must SAY a data source's projection has fallen behind.

THE ONE THAT WOULD HAVE CAUGHT THE OUTAGE FASTEST. For 14 hours a data source's
``projected_commit_seq`` sat below its graph's ``main_head_commit_seq``, which routes
EVERY main read through the Postgres branch provider — and that provider holds no
rollups, so the aggregated-lineage layer vanished from the canvas. Nothing said so:
``workspace_data_sources.aggregation_status`` still read ``ready`` from a cache written
before the projection fell behind, and every surface claimed to be healthy.

``/alignment-analysis`` now raises ``PROJECTION_STALE``. These tests pin the three
things that make it useful: it fires when the projection lags, it names BOTH sequence
numbers so an operator can see the size of the gap, and it stays quiet when the
projection is caught up (a finding that is always on is a finding nobody reads).

The versioning store is a decoupled schema; the endpoint reads it through the
management session, so the SQLite test DB needs it attached — mirroring the
``aggregation`` schema the session-wide conftest engine already attaches.
"""
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from backend.app.db import models as _m

CLEAN_STATS = {
    "totalNodes": 100, "totalEdges": 50,
    "entityTypeStats": [{"id": "Pipeline", "name": "Pipeline", "count": 100}],
    "edgeTypeStats": [{"id": "FEEDS", "name": "FEEDS", "count": 50}],
}


@pytest.fixture()
async def graphver_schema(db_session):
    """Attach + create the two versioning tables the finding's query joins."""
    await db_session.execute(text("ATTACH DATABASE ':memory:' AS graphver"))
    await db_session.execute(text(
        "CREATE TABLE graphver.graphs (id TEXT PRIMARY KEY, data_source_id TEXT, "
        "main_head_commit_seq BIGINT)"))
    await db_session.execute(text(
        "CREATE TABLE graphver.projection_state (graph_id TEXT PRIMARY KEY, "
        "projected_commit_seq BIGINT, falkor_graph_name TEXT, last_error TEXT)"))
    yield
    await db_session.execute(text("DROP TABLE graphver.projection_state"))
    await db_session.execute(text("DROP TABLE graphver.graphs"))
    await db_session.execute(text("DETACH DATABASE graphver"))


async def _seed(db_session, *, projected, head, falkor_name="gv_real", last_error=None,
                agg_ready=False):
    db_session.add(_m.WorkspaceORM(id="ws_stale", name="Stale WS"))
    db_session.add(_m.ProviderORM(id="prov_stale", name="P", provider_type="falkordb"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id="ds_stale", workspace_id="ws_stale", provider_id="prov_stale",
        graph_name="g", label="Stale Source"))
    if agg_ready:
        # A source whose batch aggregation job genuinely succeeded — the only
        # state in which ``canonicalized`` was ever true, and therefore the
        # only state in which its claim can be wrong.
        from backend.app.services.aggregation.models import (
            AggregationDataSourceStateORM,
        )
        db_session.add(AggregationDataSourceStateORM(
            data_source_id="ds_stale", workspace_id="ws_stale",
            aggregation_status="ready", aggregation_edge_count=500))
    db_session.add(_m.DataSourceStatsORM(
        data_source_id="ds_stale", schema_stats=json.dumps(CLEAN_STATS),
        schema_updated_at="2026-08-30T00:00:00Z"))
    await db_session.commit()
    await db_session.execute(text(
        "INSERT INTO graphver.graphs VALUES ('g_stale', 'ds_stale', :head)"), {"head": head})
    await db_session.execute(text(
        "INSERT INTO graphver.projection_state VALUES ('g_stale', :p, :name, :err)"),
        {"p": projected, "name": falkor_name, "err": last_error})
    await db_session.commit()


async def _findings(client: AsyncClient) -> dict:
    resp = await client.get("/api/v1/ws_stale/graph/alignment-analysis?dataSourceId=ds_stale")
    assert resp.status_code == 200, resp.text
    return {f["code"]: f for f in resp.json()["findings"]}


async def test_a_lagging_projection_is_reported_with_both_sequence_numbers(
        test_client: AsyncClient, db_session, graphver_schema):
    await _seed(db_session, projected=4, head=9, last_error="verify mismatch at seq 9")

    finding = (await _findings(test_client)).get("PROJECTION_STALE")
    assert finding is not None, (
        "a data source whose graph is 5 commits behind reads as perfectly healthy — "
        "this silence is what hid a wedged projection for 14 hours"
    )
    assert finding["severity"] == "critical", finding
    # An operator has to be able to see the gap, not just be told one exists.
    assert "4" in finding["message"] and "9" in finding["message"], finding["message"]
    assert "verify mismatch at seq 9" in finding["message"], finding["message"]


async def test_a_caught_up_projection_raises_nothing(
        test_client: AsyncClient, db_session, graphver_schema):
    await _seed(db_session, projected=9, head=9)

    assert "PROJECTION_STALE" not in await _findings(test_client), (
        "a fresh projection was reported stale — a finding that is always on is a "
        "finding nobody reads"
    )


async def test_an_unpinned_graph_is_not_reported(
        test_client: AsyncClient, db_session, graphver_schema):
    """No real FalkorDB target means nothing is projected by design — reads come from
    Postgres because that is the whole plan, not because anything is wedged."""
    await _seed(db_session, projected=0, head=9, falkor_name=None)

    assert "PROJECTION_STALE" not in await _findings(test_client)


# ── The ``aggregation`` block itself ─────────────────────────────────────
# The finding above is loud, but the same response also carries an
# ``aggregation`` block, and ``canonicalized`` claimed the declared-spelling,
# index-aligned graph was serving reads. Under a wedge it is not: reads come
# from the version log. A page that raises a critical finding and, two keys
# away, reports the read path as canonicalized is still lying.


async def _aggregation_block(client: AsyncClient) -> dict:
    resp = await client.get(
        "/api/v1/ws_stale/graph/alignment-analysis?dataSourceId=ds_stale")
    assert resp.status_code == 200, resp.text
    return resp.json()["aggregation"]


async def test_a_lagging_projection_is_not_reported_as_canonicalized(
        test_client: AsyncClient, db_session, graphver_schema):
    await _seed(db_session, projected=4, head=9, last_error="verify mismatch",
                agg_ready=True)

    agg = await _aggregation_block(test_client)
    assert agg["status"] == "ready"
    assert agg["canonicalized"] is False, (
        "the block claimed reads were being served through the canonicalized "
        "graph while they were coming from the version log instead"
    )
    assert agg["projectorCurrent"] is False
    assert agg["projectionCommitsBehind"] == 5
    assert agg["projectionLastError"] == "verify mismatch"
    assert agg["projectionCheckedAt"] is not None


async def test_a_caught_up_projection_reports_a_current_projector(
        test_client: AsyncClient, db_session, graphver_schema):
    await _seed(db_session, projected=9, head=9, agg_ready=True)

    agg = await _aggregation_block(test_client)
    assert agg["canonicalized"] is True
    assert agg["projectorCurrent"] is True
    assert agg["projectionCommitsBehind"] == 0


async def test_an_unpinned_graph_reports_projection_health_as_unknown(
        test_client: AsyncClient, db_session, graphver_schema):
    """Nothing is projected there by design, so there is no projector to be
    current or behind. Null means unknown — never "up to date"."""
    await _seed(db_session, projected=0, head=9, falkor_name=None)

    agg = await _aggregation_block(test_client)
    assert agg["projectorCurrent"] is None
    assert agg["projectionCommitsBehind"] is None
