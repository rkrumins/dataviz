"""Attaching a data source keeps to the ``permittedWorkspaces`` of its provider and of its
catalog entry, in every workspace — not only in the Playground.

A provider (or a catalog entry) limited to named workspaces may be used only there: "*"
admits every workspace, an unset list counts as "*". Moving a source already keeps this
rule (data_source_transfer); attaching one, and creating a workspace with sources, kept
none, so any workspace's data-source manager could mount a graph meant for another team.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import CatalogItemORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

FIN, MKT = "ws_fin", "ws_mkt"


@pytest.fixture
async def estate(db_session):
    """Finance and Marketing; a provider limited to Finance and one open to all; a catalog
    entry limited to Finance on the open provider, one on the Finance-only provider, and one
    open to all."""
    db_session.add_all([
        WorkspaceORM(id=FIN, name="Finance"),
        WorkspaceORM(id=MKT, name="Marketing"),
        ProviderORM(id="prov_fin", name="Finance store", provider_type="falkordb",
                    permitted_workspaces=f'["{FIN}"]'),
        ProviderORM(id="prov_all", name="Shared store", provider_type="falkordb", permitted_workspaces='["*"]'),
    ])
    await db_session.flush()
    db_session.add_all([
        CatalogItemORM(id="cat_ledger", provider_id="prov_all", name="Ledger", source_identifier="ledger",
                       permitted_workspaces=f'["{FIN}"]'),
        CatalogItemORM(id="cat_payroll", provider_id="prov_fin", name="Payroll", source_identifier="payroll",
                       permitted_workspaces='["*"]'),
        CatalogItemORM(id="cat_calendar", provider_id="prov_all", name="Calendar", source_identifier="calendar",
                       permitted_workspaces='["*"]'),
    ])
    await db_session.commit()


async def _sources(db_session, ws_id: str) -> list[str]:
    return list((await db_session.execute(
        select(WorkspaceDataSourceORM.id).where(WorkspaceDataSourceORM.workspace_id == ws_id)
    )).scalars())


@pytest.mark.parametrize("body", [
    {"providerId": "prov_fin", "graphName": "payroll"},   # a provider limited to Finance
    {"catalogItemId": "cat_ledger"},                       # a catalog entry limited to Finance
    {"catalogItemId": "cat_payroll"},                      # an open entry on a Finance-only provider
])
async def test_a_workspace_the_allow_list_leaves_out_is_refused(test_client: AsyncClient, estate, db_session, body):
    r = await test_client.post(f"/api/v1/admin/workspaces/{MKT}/data-sources", json=body)
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["type"] == "not_permitted"
    assert "Marketing" in detail["message"]
    assert await _sources(db_session, MKT) == []


@pytest.mark.parametrize("body", [
    {"providerId": "prov_fin", "graphName": "payroll"},
    {"catalogItemId": "cat_ledger"},
    {"catalogItemId": "cat_payroll"},
])
async def test_the_workspace_it_names_may_attach(test_client: AsyncClient, estate, db_session, body):
    r = await test_client.post(f"/api/v1/admin/workspaces/{FIN}/data-sources", json=body)
    assert r.status_code == 201, r.text
    assert len(await _sources(db_session, FIN)) == 1


@pytest.mark.parametrize("body", [
    {"providerId": "prov_all", "graphName": "anything"},
    {"catalogItemId": "cat_calendar"},
])
async def test_a_wildcard_admits_every_workspace(test_client: AsyncClient, estate, body):
    r = await test_client.post(f"/api/v1/admin/workspaces/{MKT}/data-sources", json=body)
    assert r.status_code == 201, r.text


async def test_an_unset_allow_list_counts_as_everyone(test_client: AsyncClient, estate, db_session):
    prov = await db_session.get(ProviderORM, "prov_all")
    prov.permitted_workspaces = ""
    await db_session.commit()
    r = await test_client.post(f"/api/v1/admin/workspaces/{MKT}/data-sources",
                               json={"providerId": "prov_all", "graphName": "anything"})
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("source", [
    {"providerId": "prov_fin", "graphName": "payroll"},
    {"catalogItemId": "cat_ledger"},
])
async def test_creating_a_workspace_with_a_source_limited_elsewhere_is_refused(
    test_client: AsyncClient, estate, db_session, source,
):
    """A new workspace is in no named list, so only "*" admits it — and nothing is created."""
    r = await test_client.post("/api/v1/admin/workspaces", json={"name": "Sales", "dataSources": [source]})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["type"] == "not_permitted"
    assert (await db_session.execute(select(WorkspaceORM).where(WorkspaceORM.name == "Sales"))).first() is None


async def test_creating_a_workspace_with_open_sources_still_works(test_client: AsyncClient, estate):
    r = await test_client.post("/api/v1/admin/workspaces", json={"name": "Sales", "dataSources": [
        {"catalogItemId": "cat_calendar"}, {"providerId": "prov_all", "graphName": "pipeline"},
    ]})
    assert r.status_code == 201, r.text
    assert len(r.json()["dataSources"]) == 2
