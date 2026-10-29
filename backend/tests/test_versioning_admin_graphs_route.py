"""``GET /api/v1/admin/versioning/graphs`` — the fleet inventory of versioned graphs.

* It is a platform administrator's read (``system:admin``) and is not open to API keys.
* It hands its filters and cursor to the inventory query as given, and refuses a status or kind
  the inventory does not know rather than ignoring it.

Paging, the filters and the fork and orphan rows run against Postgres in
``integration/test_versioning_admin_graphs_live.py``.
"""
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.main import app

_PATH = "/api/v1/admin/versioning/graphs"


def _route():
    found = [(m, r, d) for m, p, r, d in api_key_surface.routes(app) if p == _PATH]
    assert [m for m, _, _ in found] == ["GET"], found
    return found[0][1], found[0][2]


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_the_route_is_mounted_for_platform_admins_only():
    _, dependant = _route()
    assert "system:admin" in _gate_perms(dependant)


def test_an_api_key_cannot_reach_it():
    """Keys reach only the routes on the surface; this one is deliberately not there."""
    route, _ = _route()
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def _client():
    """The router alone, its admin gate satisfied: what is left is the route's own validation."""
    route, _ = _route()
    gate = next(d.call for d in route.dependant.dependencies
                if getattr(d.call, "required_permission", None) == "system:admin")
    bare = FastAPI()
    bare.include_router(va.router, prefix="/api/v1/admin/versioning")
    bare.dependency_overrides[gate] = lambda: None
    return TestClient(bare)


def test_the_filters_and_cursor_reach_the_inventory():
    asked = []

    async def inventory(**kw):
        asked.append(kw)
        return {"graphs": [], "nextCursor": None}

    with patch.object(va.probes, "list_versioned_graphs", inventory):
        client = _client()
        r = client.get(_PATH, params={
            "provider": "falkor-eu", "status": "failed", "workspaceId": "ws1",
            "kind": "orphan", "q": "customer", "cursor": "graph_a", "limit": 2})
        assert r.status_code == 200, r.text
        assert r.json() == {"graphs": [], "nextCursor": None}
        assert client.get(_PATH).status_code == 200

    assert asked == [
        {"provider": "falkor-eu", "status": "failed", "workspace_id": "ws1", "kind": "orphan",
         "q": "customer", "cursor": "graph_a", "limit": 2},
        {"provider": None, "status": None, "workspace_id": None, "kind": None,
         "q": None, "cursor": None, "limit": 50},
    ]


def test_an_unknown_status_or_kind_is_refused():
    async def inventory(**kw):
        raise AssertionError("the inventory ran for a filter it does not know")

    with patch.object(va.probes, "list_versioned_graphs", inventory):
        client = _client()
        assert client.get(_PATH, params={"status": "stale"}).status_code == 422
        assert client.get(_PATH, params={"kind": "draft"}).status_code == 422
        assert client.get(_PATH, params={"limit": 0}).status_code == 422

