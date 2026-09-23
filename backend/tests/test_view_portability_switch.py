"""View versions, import and export are a preview behind one switch, `viewPortabilityEnabled`.

It ships OFF, as an experimental flag must, and while it is off the server refuses every route of
both routers, whatever Export views and Import views say. The routes are read off the routers
rather than listed here, so one added later cannot slip out from under the switch.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints import view_transfer, view_versions
from backend.app.services.feature_flags import feature_flags


def _routes():
    for prefix, router in (("/api/v1/views/transfer", view_transfer.router),
                           ("/api/v1/views/view_1/versions", view_versions.router)):
        for route in router.routes:
            path = route.path.replace("{upload_id}", "up_1").replace("{version}", "1")
            for method in sorted(route.methods):
                yield method, prefix + path


ROUTES = sorted(set(_routes()))


def test_every_route_is_counted():
    # Seven transfer routes and six version routes; a router that lost its routes would make the
    # tests below pass by testing nothing.
    assert len(ROUTES) == 13


def _refused(resp) -> bool:
    detail = resp.json().get("detail") if resp.status_code == 403 else None
    return isinstance(detail, dict) and detail.get("feature") == "viewPortabilityEnabled"


@pytest.mark.parametrize(("method", "path"), ROUTES)
async def test_the_preview_ships_off_and_refuses_every_route(test_client: AsyncClient, method, path):
    resp = await test_client.request(method, path, json={})
    assert _refused(resp), f"{method} {path}: {resp.status_code} {resp.text[:200]}"


@pytest.mark.parametrize(("method", "path"), ROUTES)
async def test_turning_it_on_lets_every_route_through_to_its_own_checks(
        test_client: AsyncClient, method, path):
    feature_flags._cache = {**(feature_flags._cache or {}), "viewPortabilityEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    resp = await test_client.request(method, path, json={})
    assert not _refused(resp), f"{method} {path} is still refused"
