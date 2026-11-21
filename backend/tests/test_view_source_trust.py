"""A view carries its data source's trust: how sensitive the data is, and whether the source
is certified, in review or deprecated — so "Built on" can badge it wherever a view is shown.

Every way a view is read says the same: one view, a list, the legacy per-row path, and the
workspace's primary source for a view that names none. A deleted source says nothing.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import ViewFavouriteORM, ViewORM, WorkspaceDataSourceORM
from backend.app.db.repositories import view_repo
from tests.common import discussions_world as w


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)
    ds = await db_session.get(WorkspaceDataSourceORM, w.DS)
    ds.classification, ds.trust_status = "confidential", "certified"
    db_session.add(ViewFavouriteORM(view_id=w.V_WS, user_id=w.ADA))
    await db_session.commit()


def _trust(view) -> tuple:
    return view.data_source_classification, view.data_source_trust_status


@pytest.mark.asyncio
async def test_every_read_of_a_view_carries_its_sources_trust(world, db_session, monkeypatch):
    one = await view_repo.get_view_enriched(db_session, w.V_WS, user_id=w.ADA)
    assert _trust(one) == ("confidential", "certified")
    assert one.model_dump(by_alias=True)["dataSourceTrustStatus"] == "certified"
    assert one.model_dump(by_alias=True)["dataSourceClassification"] == "confidential"

    listed = await view_repo.list_views_filtered(db_session, workspace_id=w.WS)
    assert {v.id: _trust(v) for v in listed.items} == {
        v: ("confidential", "certified") for v in (w.V_PRIV, w.V_WS, w.V_ENT)
    }

    batched = await view_repo.list_popular_views(db_session, user_id=w.ADA)
    monkeypatch.setenv("VIEWS_BATCH_ENRICH", "false")
    legacy = await view_repo.list_popular_views(db_session, user_id=w.ADA)
    assert [(v.id, _trust(v)) for v in batched] == [(v.id, _trust(v)) for v in legacy] == [
        (w.V_WS, ("confidential", "certified")),
    ]


@pytest.mark.asyncio
async def test_a_deleted_source_says_nothing(world, db_session):
    (await db_session.get(WorkspaceDataSourceORM, w.DS)).deleted_at = w.T0
    await db_session.commit()
    one = await view_repo.get_view_enriched(db_session, w.V_WS, user_id=w.ADA)
    assert _trust(one) == (None, None) and one.data_source_name is None
    listed = await view_repo.list_views_filtered(db_session, workspace_id=w.WS)
    assert {_trust(v) for v in listed.items} == {(None, None)}


@pytest.mark.asyncio
async def test_a_view_naming_no_source_carries_the_primary_sources(world, db_session, test_client: AsyncClient):
    db_session.add(ViewORM(id="view_nosrc", name="On the default source", workspace_id=w.WS, data_source_id=None,
                           visibility="workspace", created_by=w.BEN))
    await db_session.commit()
    r = await test_client.get("/api/v1/views/view_nosrc")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dataSourceId"] == w.DS
    assert (body["dataSourceClassification"], body["dataSourceTrustStatus"]) == ("confidential", "certified")
