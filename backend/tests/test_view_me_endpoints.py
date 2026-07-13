"""HTTP tests for the collision-prone ``/views/me/*`` routes.

These exist because ``test_view_activity.py`` and ``test_view_recents.py`` test
the REPOSITORY functions only. They passed while ``GET /api/v1/views/me/feed``
returned 404 on every call in the running app — the repo layer was perfect and
the route was simply never exercised.

The routes are the fragile part, not the queries. ``/views/me/<x>`` sits in the
same router as ``/views/{view_id}/<x>``, so a path added below the parameterised
route binds ``view_id="me"`` and the endpoint quietly disappears. Asserting the
STATUS CODE of a real request through the app's router is the only thing that
catches that class of break.
"""
from httpx import AsyncClient


async def _create_workspace(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Me Endpoints WS", "dataSources": []},
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


async def test_me_feed_route_is_reachable(test_client: AsyncClient):
    """The regression that shipped: this route 404'd in the running app.

    A 404 here means the path was shadowed by ``/{view_id}/...`` or never
    registered — exactly the failure the repo-level tests could not see.
    """
    resp = await test_client.get("/api/v1/views/me/feed")
    assert resp.status_code == 200, f"/views/me/feed is unreachable: {resp.status_code}"
    assert isinstance(resp.json(), list)


async def test_me_recent_route_is_reachable(test_client: AsyncClient):
    resp = await test_client.get("/api/v1/views/me/recent")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


async def test_me_feed_returns_activity_for_a_created_view(test_client: AsyncClient):
    """Creating a view records activity, and the feed serves it over HTTP."""
    ws_id = await _create_workspace(test_client)
    view = await _create_view(test_client, ws_id, "Feed Fixture View")

    resp = await test_client.get("/api/v1/views/me/feed")
    assert resp.status_code == 200

    entries = resp.json()
    mine = [e for e in entries if e["viewId"] == view["id"]]
    assert mine, "the created view produced no feed entry"
    assert mine[0]["action"] == "created"
    assert mine[0]["viewName"] == "Feed Fixture View"


async def test_me_feed_honours_limit(test_client: AsyncClient):
    ws_id = await _create_workspace(test_client)
    for i in range(3):
        await _create_view(test_client, ws_id, f"Limit View {i}")

    resp = await test_client.get("/api/v1/views/me/feed", params={"limit": 2})
    assert resp.status_code == 200
    assert len(resp.json()) <= 2


async def test_me_is_not_swallowed_as_a_view_id(test_client: AsyncClient):
    """Guard the collision directly.

    ``/views/me/activity`` WOULD bind ``view_id="me"`` on the parameterised
    activity route — which is why the feed lives at ``/me/feed``. If someone
    later renames it to ``/me/activity``, this test documents why that breaks.
    """
    resp = await test_client.get("/api/v1/views/me/activity")
    # Resolves to the {view_id} route with view_id="me" → no such view.
    assert resp.status_code == 404


async def test_most_viewed_route_is_not_swallowed_by_view_id(test_client: AsyncClient):
    """The collision this file exists for.

    ``/views/most-viewed`` is a SINGLE segment, so unlike the /me/* routes it
    competes directly with ``/views/{view_id}``. Declared below it, FastAPI binds
    view_id="most-viewed" and the endpoint becomes a silent 404. A 200 here proves
    it is still declared above.
    """
    resp = await test_client.get("/api/v1/views/most-viewed")
    assert resp.status_code == 200, (
        "most-viewed is being swallowed by /{view_id} — move it above that route"
    )
    assert isinstance(resp.json(), list)
