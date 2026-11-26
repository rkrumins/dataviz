"""Whether a view is meant to show everything in its source (``config.coverage``).

A view says 'complete' when it is meant to hold every top-level entity of the types it is about:
the canvas then offers each new one as it arrives. It says 'specialised' when it is a lens on part
of the source — some domains, one domain, part of one — and is never offered them. A view that
says neither (every view made before views said) is read as specialised.

It is set on its own through ``PUT /views/{id}`` (``coverage``), so a caller never sends the whole
config to change it, and a whole-config save that doesn't mention it keeps the stored one. Same
fixtures as ``test_view_layout_integrity.py``.
"""
import json

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM

CONFIG = {"layout": {"type": "reference"}, "content": {"visibleEntityTypes": ["domain"]}}


async def _view(client: AsyncClient, config: dict | None = None) -> str:
    ws = await client.post("/api/v1/admin/workspaces", json={"name": "Coverage WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Coverage View", "workspaceId": ws.json()["id"], "viewType": "reference",
        "config": CONFIG if config is None else config, "visibility": "private",
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _config(client: AsyncClient, view_id: str) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["config"]


async def _stored(db_session: AsyncSession, view_id: str) -> dict:
    """The config as the row holds it, not as a read serves it."""
    return json.loads((await db_session.execute(
        select(ViewORM.config).where(ViewORM.id == view_id))).scalar_one())


async def test_coverage_is_set_on_its_own_and_the_rest_of_the_config_stays(test_client: AsyncClient):
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={"coverage": "complete"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["config"]["coverage"] == "complete"

    config = await _config(test_client, view_id)
    assert config["coverage"] == "complete"
    assert config["content"]["visibleEntityTypes"] == ["domain"]

    resp = await test_client.put(f"/api/v1/views/{view_id}", json={"coverage": "specialised"})
    assert resp.status_code == 200, resp.text
    assert (await _config(test_client, view_id))["coverage"] == "specialised"


async def test_a_coverage_other_than_complete_or_specialised_is_refused(
    test_client: AsyncClient, db_session: AsyncSession,
):
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={"coverage": "everything"})
    assert resp.status_code == 422
    assert "coverage" not in await _stored(db_session, view_id)


async def test_a_whole_config_save_that_says_nothing_of_it_keeps_the_stored_one(test_client: AsyncClient):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}", json={"coverage": "complete"})

    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "name": "Renamed",
        "config": {"layout": {"type": "reference"}, "content": {"visibleEntityTypes": ["domain", "app"]}},
    })
    assert resp.status_code == 200, resp.text
    config = await _config(test_client, view_id)
    assert config["coverage"] == "complete"
    assert config["content"]["visibleEntityTypes"] == ["domain", "app"]


async def test_coverage_sent_beside_a_whole_config_is_the_one_kept(test_client: AsyncClient):
    # The wizard's save: the config it read (with the coverage stored then), and the one chosen.
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}", json={"coverage": "complete"})

    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "config": {**CONFIG, "coverage": "complete"}, "coverage": "specialised",
    })
    assert resp.status_code == 200, resp.text
    assert (await _config(test_client, view_id))["coverage"] == "specialised"


async def test_a_view_that_never_said_says_nothing(test_client: AsyncClient, db_session: AsyncSession):
    view_id = await _view(test_client)
    assert "coverage" not in await _config(test_client, view_id)

    # A whole-config save writes none for it either: absent stays absent.
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={"name": "Renamed", "config": CONFIG})
    assert resp.status_code == 200, resp.text
    assert "coverage" not in await _config(test_client, view_id)
    assert "coverage" not in await _stored(db_session, view_id)


async def test_create_stores_the_coverage_it_is_given(test_client: AsyncClient):
    view_id = await _view(test_client, {**CONFIG, "coverage": "complete"})
    assert (await _config(test_client, view_id))["coverage"] == "complete"
