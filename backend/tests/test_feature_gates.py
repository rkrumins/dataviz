"""The admin toggles that, until now, toggled nothing.

`traceEnabled`, `editModeEnabled` and `signupEnabled` were seeded, rendered on the Admin page,
persisted to the database, served by the API — and enforced NOWHERE. An admin could switch a
feature off and it stayed on. A flag that only hides a button is a lie: the endpoint is still
there, and anyone who knows the URL still has the feature.

`signupEnabled` was the one that mattered. With it OFF, an anonymous POST to /auth/signup still
returned 201 and still wrote a `pending` user row — verified live against the running app before
this was written. The admin's security control was decorative.

Three properties are pinned here, and the third is the interesting one:
  1. OFF really means off — server-side, not just hidden.
  2. Turning a feature off does not make the product BLANK: reads keep working.
  3. Capability flags fail OPEN; the SECURITY flag fails CLOSED. The costs are not symmetric.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.services.feature_flags import feature_flags

WS = "ws_gate_test"


def _prime(**values):
    """Prime the singleton cache so gates resolve without a DB round-trip."""
    feature_flags._cache = dict(values)
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture(autouse=True)
def _fresh():
    feature_flags.invalidate()
    yield
    feature_flags.invalidate()


@pytest.fixture(autouse=True, scope="module")
def _dispose_graphver_engine():
    """Hand the next test file a clean graphver engine (see test_versioning_feature_gate)."""
    yield
    import asyncio

    from backend.app.services.versioning import db as gvdb
    asyncio.run(gvdb.dispose_engine())


def _blocked(resp, feature: str) -> bool:
    if resp.status_code != 403:
        return False
    d = resp.json().get("detail")
    return isinstance(d, dict) and d.get("type") == "feature_disabled" and d.get("feature") == feature


# ── traceEnabled ─────────────────────────────────────────────────────────────

TRACE_ROUTES = ("/trace", "/trace/v2", "/trace/expand", "/trace/expand-batch")


@pytest.mark.parametrize("route", TRACE_ROUTES)
async def test_trace_is_refused_when_disabled(test_client: AsyncClient, route):
    _prime(traceEnabled=False)
    resp = await test_client.post(f"/api/v1/{WS}/graph{route}?dataSourceId=ds_x", json={})
    assert _blocked(resp, "traceEnabled"), f"{route} must be refused, got {resp.status_code}"


@pytest.mark.parametrize("route", TRACE_ROUTES)
async def test_trace_passes_when_enabled(test_client: AsyncClient, route):
    _prime(traceEnabled=True)
    resp = await test_client.post(f"/api/v1/{WS}/graph{route}?dataSourceId=ds_x", json={})
    assert not _blocked(resp, "traceEnabled")


# ── editModeEnabled ──────────────────────────────────────────────────────────

EDIT_ROUTES = [
    ("POST", "/nodes/create"),
    ("POST", "/edges"),
    ("PATCH", "/edges/e1"),
    ("DELETE", "/edges/e1"),
    ("POST", "/changes"),
]


@pytest.mark.parametrize("method, route", EDIT_ROUTES)
async def test_graph_writes_refused_when_edit_mode_disabled(test_client: AsyncClient, method, route):
    _prime(editModeEnabled=False)
    resp = await test_client.request(method, f"/api/v1/{WS}/graph{route}?dataSourceId=ds_x", json={})
    assert _blocked(resp, "editModeEnabled"), f"{method} {route} must be refused, got {resp.status_code}"


@pytest.mark.parametrize("method, route", EDIT_ROUTES)
async def test_graph_writes_pass_when_edit_mode_enabled(test_client: AsyncClient, method, route):
    _prime(editModeEnabled=True)
    resp = await test_client.request(method, f"/api/v1/{WS}/graph{route}?dataSourceId=ds_x", json={})
    assert not _blocked(resp, "editModeEnabled")


# ── turning a feature OFF must not make the product BLANK ────────────────────

@pytest.mark.parametrize("route", ("/nodes/query", "/edges/query", "/edges/between"))
async def test_reads_are_never_feature_blocked(test_client: AsyncClient, route):
    """These are POSTs, but they are QUERIES. An admin switching editing off wants a read-only
    product, not an empty screen — the canvas must still render, exports must still run, and an
    admin must still be able to look. Gating these would have blanked the app."""
    _prime(editModeEnabled=False, traceEnabled=False, versioningEnabled=False)
    resp = await test_client.post(f"/api/v1/{WS}/graph{route}?dataSourceId=ds_x", json={})
    assert not _blocked(resp, "editModeEnabled")
    assert not _blocked(resp, "traceEnabled")


# ── signupEnabled: the security one ──────────────────────────────────────────

def _signup_body(**over):
    return {
        "email": "stranger@example.com", "password": "Sup3rStr0ng!Passw0rd#2026",
        "firstName": "A", "lastName": "Stranger", **over,
    }


async def test_a_stranger_cannot_self_register_when_signup_is_off(test_client: AsyncClient):
    """The bug, exactly as it shipped: 201 Created, and a `pending` user row, with the admin's
    self-registration switch turned OFF."""
    _prime(signupEnabled=False)
    resp = await test_client.post("/api/v1/auth/signup", json=_signup_body())
    assert _blocked(resp, "signupEnabled"), f"expected 403, got {resp.status_code}"


async def test_a_stranger_can_self_register_when_signup_is_on(test_client: AsyncClient):
    _prime(signupEnabled=True)
    resp = await test_client.post("/api/v1/auth/signup", json=_signup_body())
    assert not _blocked(resp, "signupEnabled")


async def test_signup_fails_CLOSED_when_the_flag_cannot_be_read(test_client: AsyncClient):
    """The posture that separates this flag from every other one.

    Every capability flag defaults to ENABLED, so a database hiccup cannot black out a product
    area. This one is a security control and the costs are NOT symmetric: failing open lets
    strangers in; failing closed inconveniences an invite. With the key absent we must assume
    the admin meant to keep the door SHUT."""
    _prime()  # cache primed, key absent
    resp = await test_client.post("/api/v1/auth/signup", json=_signup_body())
    assert _blocked(resp, "signupEnabled"), "an unreadable security flag must fail CLOSED"


async def test_capability_flags_fail_OPEN_when_absent(test_client: AsyncClient):
    """...and the mirror image: a missing capability flag must not lock users out of the app."""
    _prime()  # key absent
    resp = await test_client.post(f"/api/v1/{WS}/graph/trace/v2?dataSourceId=ds_x", json={})
    assert not _blocked(resp, "traceEnabled")
    resp = await test_client.post(f"/api/v1/{WS}/graph/changes?dataSourceId=ds_x", json={})
    assert not _blocked(resp, "editModeEnabled")
