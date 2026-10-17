"""A config save (PUT /views/{id}) never writes a view's layout or scope (VIEWS-1).

The wizard builds that save from the copy it read, which on a draft is the published view with
the draft's overlay laid over it: writing its layout and scope made the draft's edits Published,
with no review. The layout and scope are written only by PUT /layout (the overlay on a draft),
promote, restore and the library; a config save keeps the stored ones. The two layout writers
read the row their lock holds, not the copy the endpoint loaded before it. Same fixtures as
``test_view_layout_endpoint.py``.
"""
import json

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.db.repositories import view_repo
from backend.common.models.management import (
    ViewCreateRequest,
    ViewLayoutUpdateRequest,
    ViewUpdateRequest,
)


def _layout(layer: str, urn: str) -> dict:
    return {
        "layers": [{"id": layer, "name": layer, "entityTypes": [], "order": 0}],
        "assignments": {urn: {"layerId": layer, "inheritsChildren": True, "assignedBy": "user"}},
    }


LAYOUT_A = _layout("la", "urn:a")
LAYOUT_B = _layout("lb", "urn:b")
LAYOUT_C = _layout("lc", "urn:c")


async def _view(client: AsyncClient, view_type: str = "reference", config: dict | None = None) -> str:
    ws = await client.post("/api/v1/admin/workspaces", json={"name": "Integrity WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Integrity View", "workspaceId": ws.json()["id"], "viewType": view_type,
        "config": {"layout": {"type": view_type}, "content": {"visibleEntityTypes": ["domain"]}}
        if config is None else config,
        "visibility": "private",
    })
    assert resp.status_code == 201
    return resp.json()["id"]


async def _config(client: AsyncClient, view_id: str, branch: str | None = None) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}", params={"branchId": branch} if branch else None)
    assert resp.status_code == 200, resp.text
    return resp.json()["config"]


def _placed(config: dict) -> tuple:
    layout = config["layout"]["referenceLayout"]
    return [l["id"] for l in layout["layers"]], sorted(layout["assignments"])


async def test_a_config_save_keeps_the_published_layout_and_scope(test_client: AsyncClient):
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                 json={"referenceLayout": LAYOUT_A, "entityScope": "curated"})
    assert resp.status_code == 200

    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "name": "Renamed",
        "config": {"layout": {"type": "reference", "referenceLayout": LAYOUT_B},
                   "content": {"visibleEntityTypes": ["domain"], "entityScope": "all"}},
    })
    assert resp.status_code == 200
    body = (await test_client.get(f"/api/v1/views/{view_id}")).json()
    assert body["name"] == "Renamed"
    assert _placed(body["config"]) == (["la"], ["urn:a"])
    assert body["config"]["content"]["entityScope"] == "curated"


async def test_a_wizard_save_during_a_draft_leaves_published_untouched(test_client: AsyncClient, any_open_draft):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}/layout",
                          json={"referenceLayout": LAYOUT_A, "entityScope": "curated"})
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", params={"branchId": "br_1"},
                                 json={"referenceLayout": LAYOUT_B, "entityScope": "all"})
    assert resp.status_code == 200

    # The wizard saves the config it read on the draft: base ⊕ the draft's overlay.
    cfg = await _config(test_client, view_id, "br_1")
    assert (await test_client.put(f"/api/v1/views/{view_id}", json={"name": "R", "config": cfg})).status_code == 200

    published = await _config(test_client, view_id)
    assert _placed(published) == (["la"], ["urn:a"])
    assert published["content"]["entityScope"] == "curated"
    assert _placed(await _config(test_client, view_id, "br_1")) == (["lb"], ["urn:b"])


async def test_a_config_save_cannot_add_a_layout_or_scope_the_view_lacks(
    test_client: AsyncClient, db_session: AsyncSession,
):
    # Created with no config, so none is stored: not even the scope a creation stamps.
    view_id = await _view(test_client, view_type="graph", config={})
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "config": {"layout": {"type": "graph", "referenceLayout": LAYOUT_B},
                   "referenceLayout": LAYOUT_C,
                   "content": {"visibleEntityTypes": ["domain"], "entityScope": "curated"}},
    })
    assert resp.status_code == 200
    # Stored, not read: a read derives a scope for a view that stores none.
    config = json.loads((await db_session.execute(
        select(ViewORM.config).where(ViewORM.id == view_id))).scalar_one())
    assert "referenceLayout" not in config["layout"]
    assert "referenceLayout" not in config
    assert "entityScope" not in config["content"]
    assert config["content"]["visibleEntityTypes"] == ["domain"]


async def _seeded(db_session: AsyncSession, config: dict) -> ViewORM:
    """The view's row, loaded into the session (and held) as the endpoints load it before
    they call the writer."""
    ws = WorkspaceORM(name="Repo WS")
    db_session.add(ws)
    await db_session.flush()
    created = await view_repo.create_view(db_session, ViewCreateRequest(
        name="Repo View", workspace_id=ws.id, view_type="reference", visibility="private", config=config,
    ))
    return await db_session.get(ViewORM, created.id)


async def _write_behind(db_session: AsyncSession, view_id: str, config: dict) -> None:
    """Change the stored config without the session's copy knowing (another request's commit)."""
    await db_session.execute(
        update(ViewORM).where(ViewORM.id == view_id).values(config=json.dumps(config))
        .execution_options(synchronize_session=False)
    )


async def test_update_view_reads_the_row_the_lock_holds(db_session: AsyncSession):
    row = await _seeded(db_session, {"layout": {"type": "reference", "referenceLayout": LAYOUT_A}})
    await _write_behind(db_session, row.id, {"layout": {"type": "reference", "referenceLayout": LAYOUT_B}})

    await view_repo.update_view(db_session, row.id, ViewUpdateRequest(
        name="x", config={"layout": {"type": "reference", "referenceLayout": LAYOUT_C}},
    ))
    assert json.loads(row.config)["layout"]["referenceLayout"]["layers"][0]["id"] == "lb"


async def test_update_view_layout_reads_the_row_the_lock_holds(db_session: AsyncSession):
    row = await _seeded(db_session, {"layout": {"type": "reference", "referenceLayout": LAYOUT_A}})
    await _write_behind(db_session, row.id, {"layout": {"type": "reference", "referenceLayout": LAYOUT_A},
                                             "filters": {"fieldFilters": ["saved meanwhile"]}})

    await view_repo.update_view_layout(db_session, row.id, ViewLayoutUpdateRequest(referenceLayout=LAYOUT_C))
    stored = json.loads(row.config)
    assert stored["layout"]["referenceLayout"]["layers"][0]["id"] == "lc"
    assert stored["filters"] == {"fieldFilters": ["saved meanwhile"]}
