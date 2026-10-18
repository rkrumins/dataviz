"""Layout templates live behind one switch, `layoutTemplatesEnabled` (Admin → Features).

It ships ON, as a working capability must. Off, the server refuses every template route before
anything else, and the view route that records which template version a view matches — while
views built from a template keep working. The routes are read off the router rather than listed
here, so one added later cannot slip out from under the switch.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints import layout_templates
from backend.app.services.feature_flags import feature_flags
from backend.tests.test_layout_templates import URL, WS, _as, library  # noqa: F401


def _routes():
    for route in layout_templates.router.routes:
        path = (route.path.replace("{template_id}", "t_org").replace("{version}", "1")
                .replace("{grant_id}", "grant_1"))
        for method in sorted(route.methods):
            yield method, URL + path
    yield "PUT", "/api/v1/views/view_1/template-version"


ROUTES = sorted(set(_routes()))


def _off():
    feature_flags._cache = {**(feature_flags._cache or {}), "layoutTemplatesEnabled": False}
    feature_flags._cache_ts = time.monotonic()


def _refused(resp) -> bool:
    detail = resp.json().get("detail") if resp.status_code == 403 else None
    return isinstance(detail, dict) and detail.get("feature") == "layoutTemplatesEnabled"


def test_every_route_is_counted():
    # Twenty-two template routes and the view's template version; a router that lost its routes
    # would make the tests below pass by testing nothing.
    assert len(ROUTES) == 23


@pytest.mark.parametrize(("method", "path"), ROUTES)
async def test_off_refuses_every_route(test_client: AsyncClient, method, path):
    _off()
    with _as("alice"):
        resp = await test_client.request(method, path, json={})
    assert _refused(resp), f"{method} {path}: {resp.status_code} {resp.text[:200]}"


async def test_it_ships_on(test_client: AsyncClient, library):
    with _as("alice"):
        listed = await test_client.get(URL)
    assert listed.status_code == 200 and listed.json()["total"] > 0


async def test_views_built_from_a_template_keep_working_while_it_is_off(test_client: AsyncClient, library):
    with _as("dave"):
        view = (await test_client.post("/api/v1/views/", json={
            "name": "From it", "workspaceId": WS, "viewType": "graph",
            "visibility": "workspace", "contextModelId": "t_ws",
        })).json()
    _off()
    with _as("dave"):
        read = await test_client.get(f"/api/v1/views/{view['id']}")
        renamed = await test_client.put(f"/api/v1/views/{view['id']}", json={"name": "Still mine"})
    assert read.status_code == 200 and read.json()["contextModelId"] == "t_ws"
    assert renamed.status_code == 200 and renamed.json()["name"] == "Still mine"
