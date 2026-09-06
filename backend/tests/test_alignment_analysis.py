"""GET /{ws}/graph/alignment-analysis — the per-data-source Physical
Alignment & Query Performance report, assembled purely from cached data.

Seeds a data source whose cached profile drifts from its assigned ontology
(declared ``Pipeline`` vs physical ``pipeline`` — NOT ``dataset``, which is a
platform default index label) plus an unmapped ``custom_thing``, and asserts
the derived findings, index coverage, grade, and degrade paths.
"""
import json

import pytest
from httpx import AsyncClient

from backend.app.db import models as _m


async def _seed_source(db_session, *, ont_id, ds_id="ds_align", stats=None,
                       agg_status=None):
    db_session.add(_m.WorkspaceORM(id="ws_align", name="Align WS"))
    db_session.add(_m.ProviderORM(id="prov_align", name="P", provider_type="falkordb"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id=ds_id, workspace_id="ws_align", provider_id="prov_align",
        graph_name="g", ontology_id=ont_id, label="Align Source",
    ))
    if stats is not None:
        db_session.add(_m.DataSourceStatsORM(
            data_source_id=ds_id, schema_stats=json.dumps(stats),
            schema_updated_at="2026-07-17T00:00:00Z",
        ))
    if agg_status is not None:
        from backend.app.services.aggregation.models import AggregationDataSourceStateORM
        db_session.add(AggregationDataSourceStateORM(
            data_source_id=ds_id, workspace_id="ws_align",
            aggregation_status=agg_status,
        ))
    await db_session.commit()


async def _create_ontology(client: AsyncClient) -> str:
    resp = await client.post("/api/v1/admin/ontologies", json={
        "name": "Alignment Test",
        "entityTypeDefinitions": {
            "Pipeline": {"label": "Pipeline"},
            "Report": {"label": "Report"},
        },
        "relationshipTypeDefinitions": {"FEEDS": {"label": "Feeds"}},
        "containmentEdgeTypes": [],
        "lineageEdgeTypes": ["FEEDS"],
    })
    assert resp.status_code == 201
    return resp.json()["id"]


DRIFTED_STATS = {
    "totalNodes": 1_000, "totalEdges": 100,
    "entityTypeStats": [
        {"id": "Pipeline", "name": "Pipeline", "count": 100},   # exact
        {"id": "pipeline", "name": "pipeline", "count": 600},   # case drift (dominant)
        {"id": "custom_thing", "name": "custom_thing", "count": 50},  # unmapped
    ],
    "edgeTypeStats": [{"id": "FEEDS", "name": "FEEDS", "count": 100}],
}


async def test_alignment_analysis_drifted_raw_source(test_client: AsyncClient, db_session):
    ont_id = await _create_ontology(test_client)
    await _seed_source(db_session, ont_id=ont_id, stats=DRIFTED_STATS)

    resp = await test_client.get(
        "/api/v1/ws_align/graph/alignment-analysis?dataSourceId=ds_align")
    assert resp.status_code == 200
    body = resp.json()

    assert body["profiled"] is True
    assert body["ontology"]["id"] == ont_id
    agg = body["aggregation"]
    assert (agg["status"], agg["lastAggregatedAt"], agg["canonicalized"]) == (
        "none", None, False)
    # Not versioned ⇒ nothing is projected for this source, so the projection
    # evidence is UNKNOWN rather than healthy.
    assert agg["projectorCurrent"] is None

    # Index coverage: declared spellings (+ platform defaults) are indexed;
    # the drifted and unmapped physical labels are not.
    cov = body["indexCoverage"]
    assert "Pipeline" in cov["indexedLabels"]
    assert "dataset" in cov["indexedLabels"]  # platform default
    assert "urn" in cov["indexedProps"]
    by_label = {e["label"]: e for e in cov["unindexedPhysical"]}
    assert by_label["pipeline"] == {
        "label": "pipeline", "declared": "Pipeline", "instances": 600,
        "reason": "case_drift"}
    assert by_label["custom_thing"]["reason"] == "unmapped"

    codes = {f["code"]: f for f in body["findings"]}
    # 600 of 850 instances drift → >25% → critical scan warning naming both spellings.
    assert codes["CASE_DRIFT_SCAN"]["severity"] == "critical"
    assert "pipeline" in codes["CASE_DRIFT_SCAN"]["message"]
    assert "Pipeline" in codes["CASE_DRIFT_SCAN"]["message"]
    assert codes["UNMAPPED_NO_INDEX"]["severity"] == "warning"
    # Not aggregated + drifted → raw reads pay the scan on every query.
    assert codes["RAW_READS_DEGRADED"]["severity"] == "critical"
    # Report is declared but has zero instances.
    assert "Report" in codes["DECLARED_UNUSED"]["message"]

    # matchWeighted = (100 exact + 100 edges) / 850 ≈ 23.5 → grade D.
    assert body["grade"] == "D"
    assert body["adoption"]["matchWeighted"] < 70


async def test_alignment_analysis_canonicalized_suppresses_raw_degradation(
        test_client: AsyncClient, db_session):
    ont_id = await _create_ontology(test_client)
    await _seed_source(db_session, ont_id=ont_id, stats=DRIFTED_STATS, agg_status="ready")

    body = (await test_client.get(
        "/api/v1/ws_align/graph/alignment-analysis?dataSourceId=ds_align")).json()

    assert body["aggregation"]["canonicalized"] is True
    codes = {f["code"] for f in body["findings"]}
    # Reads go through the canonicalized aggregated graph — drift still
    # reported (the raw graph is what it is) but no raw-read degradation.
    assert "RAW_READS_DEGRADED" not in codes
    assert "CASE_DRIFT_SCAN" in codes


async def test_alignment_analysis_clean_source_grades_a(test_client: AsyncClient, db_session):
    ont_id = await _create_ontology(test_client)
    await _seed_source(db_session, ont_id=ont_id, stats={
        "totalNodes": 200, "totalEdges": 100,
        "entityTypeStats": [
            {"id": "Pipeline", "name": "Pipeline", "count": 100},
            {"id": "Report", "name": "Report", "count": 100},
        ],
        "edgeTypeStats": [{"id": "FEEDS", "name": "FEEDS", "count": 100}],
    })

    body = (await test_client.get(
        "/api/v1/ws_align/graph/alignment-analysis?dataSourceId=ds_align")).json()

    assert body["grade"] == "A"
    assert body["adoption"]["matchWeighted"] == 100.0
    assert body["indexCoverage"]["unindexedPhysical"] == []
    assert {f["code"] for f in body["findings"]} <= {"DECLARED_UNUSED"}


async def test_alignment_analysis_unprofiled_degrades(test_client: AsyncClient, db_session):
    ont_id = await _create_ontology(test_client)
    await _seed_source(db_session, ont_id=ont_id, stats=None)

    body = (await test_client.get(
        "/api/v1/ws_align/graph/alignment-analysis?dataSourceId=ds_align")).json()

    assert body["profiled"] is False
    assert body["grade"] is None
    assert body["adoption"] is None
    assert [f["code"] for f in body["findings"]] == ["NOT_PROFILED"]


async def test_alignment_analysis_unknown_source_404(test_client: AsyncClient):
    resp = await test_client.get(
        "/api/v1/ws_align/graph/alignment-analysis?dataSourceId=ds_ghost")
    assert resp.status_code == 404
