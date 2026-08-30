"""
GET /api/v1/admin/providers/types — the provider catalog surfaced outside
the backend (Admin UI, the view-wizard's scope step).

Also generates frontend/src/services/__fixtures__/providerTypes.backend.json
(gated by UPDATE_PROVIDER_TYPES_FIXTURE=1) -- the *serialised response* of
this endpoint, not a hand-written approximation, so the frontend's offline
snapshot (STATIC_PROVIDER_TYPES) can be checked against what the server
actually sends. Regenerate whenever a descriptor's public shape changes:

    UPDATE_PROVIDER_TYPES_FIXTURE=1 python -m pytest \\
        tests/test_api_provider_types.py -k generates_the_frontend_fixture -q
"""
import contextlib
import json
import os
from pathlib import Path

import pytest
from fastapi import HTTPException, status
from httpx import AsyncClient

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

# backend/tests/test_api_provider_types.py -> parents[2] is the repo root
# (parents[0]=tests, parents[1]=backend), sibling of frontend/.
_FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "services" / "__fixtures__" / "providerTypes.backend.json"
)


def _user(uid: str = "usr_types") -> User:
    return User(
        id=uid,
        email=f"{uid}@example.com",
        first_name="Test",
        last_name="User",
        role="user",
        status="active",
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )


@contextlib.contextmanager
def _auth(*, user, claims):
    """Same pattern as test_workspace_scoped_reads.py: override auth deps so
    a request runs as a workspace-bound, non-admin caller."""
    from backend.app.main import app

    async def _ovr_user():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        return user

    def _ovr_claims():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        return claims

    app.dependency_overrides[get_current_user] = _ovr_user
    app.dependency_overrides[get_permission_claims] = _ovr_claims
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_permission_claims, None)


VIEWER_CLAIMS = PermissionClaims(
    sid="sess_viewer_types",
    ws_perms={"ws_A": ("workspace:provider:read",)},
)


# ── The route-ordering trap ─────────────────────────────────────────────

async def test_route_ordering_types_is_not_swallowed_by_provider_id(test_client: AsyncClient):
    """GET /types declared after GET /{provider_id} is never reached --
    FastAPI matches routes in declaration order and the path parameter
    swallows it, returning a 404 for provider_id="types". This must be a
    real 200 with a real body -- a test that only checks the route is
    registered would pass in the broken arrangement too."""
    resp = await test_client.get("/api/v1/admin/providers/types")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) > 0


# ── Shape ────────────────────────────────────────────────────────────────

async def test_list_provider_types_shape(test_client: AsyncClient):
    resp = await test_client.get("/api/v1/admin/providers/types")
    assert resp.status_code == 200
    body = resp.json()

    ids = {row["id"] for row in body}
    assert ids == {"falkordb", "neo4j", "datahub", "spanner"}
    assert "mock" not in ids

    by_id = {row["id"]: row for row in body}

    falkordb = by_id["falkordb"]
    assert falkordb["family"] == "cypher"
    assert falkordb["connectionShape"]["kind"] == "falkordb"
    assert "blank_models" in falkordb["capabilities"]["features"]
    # camelCase aliases on the wire.
    assert "fullCrud" in falkordb["capabilities"]
    assert "usesHostPort" in falkordb["connectionShape"]
    assert "secretCredentialKeys" in falkordb["connectionShape"]

    assert by_id["spanner"]["family"] == "gql"
    assert by_id["datahub"]["connectionShape"]["auth"] == "token"
    assert by_id["neo4j"]["family"] == "cypher"


async def test_provider_types_response_is_order_deterministic(test_client: AsyncClient):
    """Frozenset feature sets and dict-insertion catalog order must not
    leak into the wire format -- the fixture has to regenerate
    byte-identically across separate process runs."""
    first = (await test_client.get("/api/v1/admin/providers/types")).json()
    second = (await test_client.get("/api/v1/admin/providers/types")).json()
    assert first == second
    assert [row["id"] for row in first] == sorted(row["id"] for row in first)
    for row in first:
        assert row["capabilities"]["features"] == sorted(row["capabilities"]["features"])


# ── Gate: read permission, not system:admin ─────────────────────────────

async def test_list_provider_types_readable_by_workspace_provider_read(
    test_client: AsyncClient,
):
    """Non-secret metadata: a workspace-bound user holding only
    workspace:provider:read (no system:admin) can read it -- the
    view-wizard's scope step is not an admin surface."""
    with _auth(user=_user(), claims=VIEWER_CLAIMS):
        resp = await test_client.get("/api/v1/admin/providers/types")
    assert resp.status_code == 200
    assert len(resp.json()) == 4


async def test_list_provider_types_rejects_unauthenticated(test_client: AsyncClient):
    with _auth(user=None, claims=None):
        resp = await test_client.get("/api/v1/admin/providers/types")
    assert resp.status_code == 401


# ── Fixture generation ───────────────────────────────────────────────────

async def test_list_provider_types_generates_the_frontend_fixture(test_client: AsyncClient):
    """Regenerates providerTypes.backend.json from the LIVE endpoint
    response when UPDATE_PROVIDER_TYPES_FIXTURE=1 -- the frontend's
    offline snapshot is checked against this, not a hand-maintained copy
    that can silently drift."""
    if os.environ.get("UPDATE_PROVIDER_TYPES_FIXTURE") != "1":
        pytest.skip("set UPDATE_PROVIDER_TYPES_FIXTURE=1 to (re)write the fixture")
    resp = await test_client.get("/api/v1/admin/providers/types")
    assert resp.status_code == 200
    _FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _FIXTURE_PATH.write_text(json.dumps(resp.json(), indent=2, sort_keys=True) + "\n")
