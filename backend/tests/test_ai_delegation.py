"""The AI service's delegation, and the edge that mints it — held as tightly as an API key.

Each control here has a test that fails if the control is removed
(``docs/TECHNICAL_DEBT.md`` §4): a delegation reads as its person and no
further, never writes, never runs native queries, dies with its session, its
switch and its clock, and never widens the API key a request came with. The
edge refuses without the switch or the permission, gates administration on
``system:admin``, and forwards a delegation scoped to the request.
"""
from __future__ import annotations

import json
import time

import httpx
import pytest

from backend.ai_service.internal_auth import ADMIN_HEADER, DELEGATION_HEADER, USER_ID_HEADER
from backend.app.api.v1.endpoints import ai as ai_endpoints
from backend.app.auth import delegation
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.services.permission_service import KeyScope, PermissionClaims
from backend.app.services.revocation_service import get_revocation_service
from backend.auth_service.interface import User
from tests.common.api_key_world import OWNER, api_key_app, error, mint, prime


@pytest.fixture()
async def client(db_session, monkeypatch):
    async with api_key_app(db_session, monkeypatch) as http:
        prime(aiAssistantEnabled=True)
        yield http


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── The delegation, on the platform's own routes ────────────────────────


async def test_a_delegation_reads_as_its_person(client):
    token = delegation.mint(user_id=OWNER)
    response = await client.get("/api/v1/views/v_a_mine", headers=bearer(token))
    assert response.status_code == 200, response.text
    assert response.json()["id"] == "v_a_mine"


async def test_a_delegation_never_writes(client):
    token = delegation.mint(user_id=OWNER)
    response = await client.put("/api/v1/views/v_a_mine", json={"name": "renamed"}, headers=bearer(token))
    assert response.status_code == 403
    assert error(response) in ("delegation_read_only", "api_key_read_only")


async def test_a_delegation_never_runs_native_queries(client):
    token = delegation.mint(user_id=OWNER)
    response = await client.post("/api/v1/ws_a/graph/search/native?dataSourceId=ds_a",
                                 json={"query": "MATCH (n) RETURN n"}, headers=bearer(token))
    assert response.status_code == 403
    assert error(response) == "delegation_not_allowed"


async def test_a_delegation_narrowed_to_a_workspace_stays_there(client):
    token = delegation.mint(user_id=OWNER, scope=delegation.DelegationScope(
        all_resources=False, workspaces=frozenset({"ws_a"})))
    assert (await client.get("/api/v1/views/v_a_mine", headers=bearer(token))).status_code == 200
    assert (await client.get("/api/v1/views/v_b_granted", headers=bearer(token))).status_code in (403, 404)


async def test_expired_forged_and_foreign_tokens_are_refused(client):
    expired = delegation.mint(user_id=OWNER, ttl_seconds=5, now=time.time() - 60)
    assert (await client.get("/api/v1/views/v_a_mine", headers=bearer(expired))).status_code == 401
    good = delegation.mint(user_id=OWNER)
    forged = good[:-3] + ("aaa" if not good.endswith("aaa") else "bbb")
    assert (await client.get("/api/v1/views/v_a_mine", headers=bearer(forged))).status_code == 401
    from backend.auth_service.core.tokens import create_access_token

    session_token = create_access_token(OWNER, f"{OWNER}@example.com", "user")
    smuggled = delegation.PREFIX + session_token
    assert (await client.get("/api/v1/views/v_a_mine", headers=bearer(smuggled))).status_code == 401


async def test_switching_the_assistant_off_stops_delegations_in_flight(client):
    token = delegation.mint(user_id=OWNER)
    prime(aiAssistantEnabled=False)
    response = await client.get("/api/v1/views/v_a_mine", headers=bearer(token))
    assert response.status_code == 401
    assert error(response) == "ai_assistant_disabled"


async def test_a_revoked_session_stops_its_delegations(client, monkeypatch):
    async def revoked(sid):
        return sid == "sid_gone"

    monkeypatch.setattr(get_revocation_service(), "is_revoked", revoked)
    token = delegation.mint(user_id=OWNER, session_id="sid_gone")
    response = await client.get("/api/v1/views/v_a_mine", headers=bearer(token))
    assert response.status_code == 401
    assert error(response) == "delegation_revoked"


def test_a_delegation_never_widens_the_key_it_came_with():
    key = KeyScope(key_id="apk_1", views="read", data="none", workspaces=frozenset({"ws_a"}))
    narrowed = delegation.narrow_to_key(delegation.DelegationScope(), key)
    assert (narrowed.views, narrowed.data) == ("read", "none")
    assert not narrowed.all_resources and narrowed.workspaces == {"ws_a"}
    writer = KeyScope(key_id="apk_2", views="write", data="write", all_resources=True)
    assert delegation.narrow_to_key(delegation.DelegationScope(), writer).views == "read"


def test_a_scope_claim_that_does_not_parse_reaches_nothing():
    scope = delegation.DelegationScope.from_claim({"views": "write", "data": "admin", "resources": 7})
    assert (scope.views, scope.data, scope.all_resources) == ("none", "none", False)


# ── The edge ────────────────────────────────────────────────────────────


class Upstream:
    def __init__(self):
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/chat/stream":
            return httpx.Response(200, content=b"event: done\ndata: {\"status\":\"ok\"}\n\n",
                                  headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True, "name": "Gateway"})


@pytest.fixture()
async def edge(client, monkeypatch):
    from backend.app.main import app

    upstream = Upstream()
    ai_endpoints.set_client_for_tests(httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), base_url="http://ai-service"))
    state = {"claims": PermissionClaims(sid="", global_perms=(), ws_perms={"ws_a": ("workspace:ai:use",)})}
    user = User(id=OWNER, email="owner@example.com", firstName="Key", lastName="Owner",
                role="user", status="active")
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_permission_claims] = lambda: state["claims"]

    class Edge:
        pass

    e = Edge()
    e.client, e.upstream, e.state = client, upstream, state
    yield e
    ai_endpoints.set_client_for_tests(None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_permission_claims, None)


CSRF = {"X-CSRF-Token": "t", "Cookie": "nx_csrf=t"}


async def test_the_edge_forwards_a_scoped_delegation(edge):
    response = await edge.client.post("/api/v1/ai/chat/stream", headers=CSRF, json={
        "message": "what breaks?", "context": {"workspaceId": "ws_a", "viewId": "v_a_ws"}})
    assert response.status_code == 200, response.text
    assert "event: done" in response.text
    sent = edge.upstream.requests[-1]
    assert sent.headers[USER_ID_HEADER] == OWNER
    grant = delegation.verify(sent.headers[DELEGATION_HEADER])
    assert grant.user_id == OWNER and grant.scope.workspaces == {"ws_a"}
    assert (grant.scope.views, grant.scope.data) == ("read", "read")
    assert ADMIN_HEADER not in sent.headers
    assert json.loads(sent.content)["message"] == "what breaks?"


async def test_the_edge_needs_the_permission_in_the_named_workspace(edge):
    response = await edge.client.post("/api/v1/ai/chat/stream", headers=CSRF, json={
        "message": "hi", "context": {"workspaceId": "ws_b"}})
    assert response.status_code == 403
    assert response.json()["detail"]["permission"] == "workspace:ai:use"
    assert edge.upstream.requests == []


async def test_the_edge_is_off_with_the_switch(edge):
    prime(aiAssistantEnabled=False)
    response = await edge.client.post("/api/v1/ai/chat/stream", headers=CSRF, json={"message": "hi"})
    assert response.status_code == 403
    assert response.json()["detail"]["type"] == "feature_disabled"


async def test_administration_needs_system_admin(edge):
    denied = await edge.client.get("/api/v1/ai/admin/connections")
    assert denied.status_code == 403
    edge.state["claims"] = PermissionClaims(sid="", global_perms=("system:admin",), ws_perms={})
    allowed = await edge.client.get("/api/v1/ai/admin/connections")
    assert allowed.status_code == 200, allowed.text
    assert edge.upstream.requests[-1].headers[ADMIN_HEADER] == "1"


async def test_the_assistant_never_calls_itself(client, db_session):
    token = delegation.mint(user_id=OWNER)
    response = await client.post("/api/v1/ai/mcp/knowledge", headers=bearer(token),
                                 json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code in (401, 403)


async def test_an_api_key_reaches_only_the_knowledge_mcp(client, db_session):
    key = await mint(db_session, views="read", data="read")
    chat = await client.post("/api/v1/ai/chat/stream", headers=key.headers, json={"message": "hi"})
    assert chat.status_code == 403
    assert error(chat) == "api_key_not_allowed"


# ── Infrastructure status ───────────────────────────────────────────────


async def test_the_status_tile_appears_only_while_the_assistant_is_on(monkeypatch):
    from backend.app.services.feature_flags import feature_flags
    from backend.app.services.system_status import probes

    state = {"on": False}

    async def switch(key, default=False):
        return state["on"] if key == "aiAssistantEnabled" else default

    monkeypatch.setattr(feature_flags, "is_enabled_self_session", switch)
    assert await probes.probe_ai_service() is None

    state["on"] = True
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"status": "healthy", "knowledge": "ready",
                                            "vectorStore": "pgvector"})))
    monkeypatch.setattr(probes, "_http", lambda: client)
    tile = await probes.probe_ai_service()
    assert (tile["key"], tile["status"], tile["detail"]["vectorStore"]) == ("aiService", "healthy", "pgvector")
