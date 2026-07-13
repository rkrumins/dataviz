"""GET /api/v1/views/me/drafts — the caller's unfinished work.

The graphver branch read is stubbed (`_open_drafts_for`), because the SQLite test
harness never creates the graphver schema. Everything AROUND it is real: the
route, the view stitch, the deleted-view filter and the RBAC predicate all run
against the app DB, which is where the bugs would be.
"""
from types import SimpleNamespace

import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints import views as views_module


def _branch(view_id: str, *, branch_id: str = "br_1", name=None, updated_at="2026-07-13T00:00:00Z"):
    """Duck-typed stand-in for a BranchORM row — the endpoint only reads fields."""
    return SimpleNamespace(
        id=branch_id,
        graph_id="gv_1",
        originating_view_id=view_id,
        name=name,
        created_at="2026-07-10T00:00:00Z",
        updated_at=updated_at,
    )


async def _create_workspace(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/admin/workspaces", json={"name": "Drafts WS", "dataSources": []},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_view(client: AsyncClient, workspace_id: str, name: str) -> dict:
    resp = await client.post("/api/v1/views/", json={
        "name": name,
        "workspaceId": workspace_id,
        "viewType": "reference",
        "config": {
            "content": {
                "visibleEntityTypes": ["domain"],
                "visibleRelationshipTypes": [],
                "defaultDepth": 5,
                "maxDepth": 10,
                "rootEntityTypes": ["domain"],
            },
            "filters": {
                "entityTypeFilters": [],
                "fieldFilters": [],
                "searchableFields": [],
                "quickFilters": [],
            },
            "layout": {"type": "reference", "lod": {"enabled": False, "levels": []}},
        },
        "visibility": "private",
    })
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
def stub_drafts(monkeypatch):
    """Install a fake graphver branch list for the request."""
    def _install(branches):
        async def _fake(owner: str, limit: int):
            return list(branches)
        monkeypatch.setattr(views_module, "_open_drafts_for", _fake)
    return _install


async def test_route_is_reachable(test_client: AsyncClient, stub_drafts):
    stub_drafts([])
    resp = await test_client.get("/api/v1/views/me/drafts")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_draft_is_joined_to_its_live_view(test_client: AsyncClient, stub_drafts):
    ws_id = await _create_workspace(test_client)
    view = await _create_view(test_client, ws_id, "Q3 Hierarchy")
    stub_drafts([_branch(view["id"], branch_id="br_abc")])

    resp = await test_client.get("/api/v1/views/me/drafts")
    assert resp.status_code == 200

    body = resp.json()
    assert len(body) == 1
    assert body[0]["draftId"] == "br_abc"
    assert body[0]["viewId"] == view["id"]
    # The name comes from the LIVE view, not a stamped copy — a renamed view
    # must not leave its drafts advertising the old title.
    assert body[0]["viewName"] == "Q3 Hierarchy"
    assert body[0]["workspaceId"] == ws_id


async def test_draft_whose_view_was_deleted_drops_out(test_client: AsyncClient, stub_drafts):
    """Otherwise the dashboard renders a card that navigates to a 404."""
    ws_id = await _create_workspace(test_client)
    view = await _create_view(test_client, ws_id, "Doomed View")

    assert (await test_client.delete(f"/api/v1/views/{view['id']}")).status_code in (200, 204)

    stub_drafts([_branch(view["id"])])

    resp = await test_client.get("/api/v1/views/me/drafts")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_draft_for_an_unknown_view_is_skipped_not_fatal(test_client: AsyncClient, stub_drafts):
    """graphver holds a LOGICAL reference to views — no FK enforces it, so a
    dangling originating_view_id is possible and must not 500 the dashboard."""
    stub_drafts([_branch("view_does_not_exist")])

    resp = await test_client.get("/api/v1/views/me/drafts")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_limit_is_honoured_after_filtering(test_client: AsyncClient, stub_drafts):
    ws_id = await _create_workspace(test_client)
    views = [await _create_view(test_client, ws_id, f"View {i}") for i in range(4)]
    stub_drafts([
        _branch(v["id"], branch_id=f"br_{i}", updated_at=f"2026-07-1{i}T00:00:00Z")
        for i, v in enumerate(views)
    ])

    resp = await test_client.get("/api/v1/views/me/drafts", params={"limit": 2})
    assert resp.status_code == 200
    assert len(resp.json()) == 2
