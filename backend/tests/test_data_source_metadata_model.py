"""A data source's details as stored: what the database itself refuses, and who made it.

The columns behind "About this data source" (description, links, tags, classification,
status and its note) are checked by the service, but the closed vocabularies and the
length limits are also CHECKs, so nothing that bypasses the service can store a status
the UI has no badge for. And a source made together with its workspace records who
made it, like every other source does — the onboarding line reads it.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import workspace_repo
from backend.common.models.management import DataSourceCreateRequest, WorkspaceCreateRequest

T0 = "2026-11-24T00:00:00+00:00"


async def _seed(session) -> None:
    session.add_all([
        ProviderORM(id="prov_m", name="Metadata provider", provider_type="falkordb", host="localhost", port=6379),
        WorkspaceORM(id="ws_m", name="Metadata"),
    ])
    await session.flush()


def _source(i: int, **columns) -> WorkspaceDataSourceORM:
    return WorkspaceDataSourceORM(id=f"ds_m{i}", workspace_id="ws_m", provider_id="prov_m", graph_name=f"g{i}",
                                  created_at=T0, updated_at=T0, **columns)


@pytest.mark.asyncio
async def test_every_detail_is_stored_when_it_is_within_bounds(db_session):
    await _seed(db_session)
    db_session.add(_source(
        1, description="x" * 4000, links='[{"label": "Runbook", "url": "https://wiki/runbook"}]',
        tags='["finance", "gl"]', classification="confidential", trust_status="deprecated",
        trust_note="y" * 500, trust_status_by="usr_a", trust_status_at=T0, metadata_updated_by="usr_a",
        metadata_updated_at=T0,
    ))
    await db_session.flush()
    row = await db_session.get(WorkspaceDataSourceORM, "ds_m1")
    assert (row.classification, row.trust_status, len(row.description)) == ("confidential", "deprecated", 4000)


@pytest.mark.asyncio
@pytest.mark.parametrize("columns", [
    {"classification": "secret"},
    {"trust_status": "gold"},
    {"description": "x" * 4001},
    {"trust_note": "y" * 501},
])
async def test_the_database_refuses_what_the_badges_cannot_show(db_session, columns):
    await _seed(db_session)
    db_session.add(_source(2, **columns))
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["public", "internal", "confidential", "restricted"])
async def test_each_classification_is_allowed(db_session, value):
    await _seed(db_session)
    db_session.add(_source(3, classification=value))
    await db_session.flush()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["certified", "in_review", "deprecated"])
async def test_each_status_is_allowed(db_session, value):
    await _seed(db_session)
    db_session.add(_source(4, trust_status=value))
    await db_session.flush()


@pytest.mark.asyncio
async def test_sources_made_with_their_workspace_record_who_made_them(db_session):
    await _seed(db_session)
    created = await workspace_repo.create_workspace(
        db_session,
        WorkspaceCreateRequest(name="With sources", dataSources=[
            DataSourceCreateRequest(provider_id="prov_m", graph_name="a"),
            DataSourceCreateRequest(provider_id="prov_m", graph_name="b"),
        ]),
        created_by="usr_maker",
    )
    assert [d.created_by for d in created.data_sources] == ["usr_maker", "usr_maker"]


@pytest.mark.asyncio
async def test_creating_a_workspace_through_the_api_records_its_sources_maker(test_client: AsyncClient, db_session):
    db_session.add(ProviderORM(id="prov_api", name="API provider", provider_type="falkordb", host="localhost",
                               port=6379))
    await db_session.commit()
    r = await test_client.post("/api/v1/admin/workspaces", json={
        "name": "Made by API", "dataSources": [{"providerId": "prov_api", "graphName": "ledger"}],
    })
    assert r.status_code == 201, r.text
    rows = (await db_session.execute(
        select(WorkspaceDataSourceORM).where(WorkspaceDataSourceORM.workspace_id == r.json()["id"])
    )).scalars().all()
    assert [row.created_by for row in rows] == ["usr_test000000"]
    assert r.json()["dataSources"][0]["createdBy"] == "usr_test000000"
