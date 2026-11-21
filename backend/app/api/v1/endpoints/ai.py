"""The edge of the AI service: ``/api/v1/ai/*``.

The web tier is the only edge (ADR-031), as it is for the aggregation control
plane (ADR-019). Every request here is authenticated as usual — a browser
session, or an API key on the knowledge MCP route — then:

1. the **switch** is on (``aiAssistantEnabled``, fail closed);
2. the person holds **``workspace:ai:use``** — in the workspace the request
   names, or in any workspace when it names none; the administration routes
   need ``system:admin`` instead;
3. a per-person **rate limit** holds, for the routes that call a model;
4. a **read-only delegation** is minted for this request (``auth.delegation``):
   narrowed to the request's workspace when it names one, and to the API
   key's own scope when it came with a key;
5. the request goes to the AI service with the internal token, the delegation,
   who the person is and the activity headers — and its answer, a stream or
   not, comes back as it is.

A request that is itself delegated (the AI service calling back) is refused
here: the assistant never asks itself.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

from backend.ai_service.internal_auth import (
    ADMIN_HEADER,
    DELEGATION_HEADER,
    ORIGIN_HEADER,
    USER_EMAIL_HEADER,
    USER_ID_HEADER,
    USER_NAME_HEADER,
    internal_auth_headers,
)
from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth import api_key_auth, delegation
from backend.app.auth.dependencies import (
    _payload,
    get_current_user,
    get_permission_claims,
    requires,
)
from backend.app.common import activity_context
from backend.app.db.engine import get_db_session
from backend.app.services.activity.recorder import record_for_request
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
    has_permission_any_workspace,
)
from backend.auth_service.cookies import read_access_cookie
from backend.auth_service.interface import User
from backend.auth_service.ratelimit import get_account_limiter
from backend.common.display_name import resolve_display_name

logger = logging.getLogger(__name__)

FEATURE = "aiAssistantEnabled"
PERMISSION = "workspace:ai:use"

_SERVICE_URL = os.getenv("AI_SERVICE_URL", "http://ai-service:8093").rstrip("/")
_PROXY_TIMEOUT = float(os.getenv("AI_PROXY_TIMEOUT_SECONDS", "170"))
_DELEGATION_TTL = int(os.getenv("AI_DELEGATION_TTL_SECONDS", "240"))
#: Turns (a chat message, a query draft) per person. Reads of conversations
#: and settings are not counted.
_RATE = os.getenv("AI_RATE_LIMIT", "30/minute")
_RATE_SCOPE = "ai-turn"

router = APIRouter(dependencies=[Depends(require_feature(FEATURE))])

_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=_SERVICE_URL,
            timeout=httpx.Timeout(_PROXY_TIMEOUT, connect=5.0),
            headers=internal_auth_headers(),
        )
    return _client


def set_client_for_tests(client: Optional[httpx.AsyncClient]) -> None:
    global _client
    _client = client


# ── Who may, and as whom ────────────────────────────────────────────────


def _refuse_delegated(request: Request) -> None:
    context = getattr(request.state, "api_key", None)
    if isinstance(context, api_key_auth.ApiKeyContext) and context.delegated:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "delegation_not_allowed",
                    "message": "The assistant cannot call itself."},
        )


def _require_use(claims: PermissionClaims, workspace_id: Optional[str]) -> None:
    allowed = (
        has_permission(claims, PERMISSION, workspace_id=workspace_id)
        if workspace_id else has_permission_any_workspace(claims, PERMISSION)
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "missing_permission",
                "permission": PERMISSION,
                "scope": ({"type": "workspace", "id": workspace_id}
                          if workspace_id else {"type": "global", "id": None}),
                "message": f"Missing permission: {PERMISSION}",
            },
        )


async def _rate_limit(user: User) -> None:
    limiter = get_account_limiter()
    if await limiter.consume(_RATE_SCOPE, user.id, _RATE):
        return
    retry = await limiter.retry_after_seconds(_RATE_SCOPE, user.id, _RATE, consumed=True)
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"error": "rate_limited",
                "message": "You are asking the assistant very quickly. Wait a moment."},
        headers={"Retry-After": str(retry)},
    )


def _scope_for(request: Request, workspace_id: Optional[str]) -> tuple[delegation.DelegationScope, Optional[str]]:
    scope = (
        delegation.DelegationScope(all_resources=False, workspaces=frozenset({workspace_id}))
        if workspace_id else delegation.DelegationScope()
    )
    context = getattr(request.state, "api_key", None)
    if isinstance(context, api_key_auth.ApiKeyContext) and context.claims is not None:
        key_scope = getattr(context.claims, "key_scope", None)
        if key_scope is not None:
            return delegation.narrow_to_key(scope, key_scope), context.key_id
    return scope, None


def _forward_headers(
    request: Request, user: User, *, workspace_id: Optional[str],
    conversation_id: str = "", admin: bool = False,
) -> dict[str, str]:
    scope, parent_key = _scope_for(request, workspace_id)
    session_id = "" if parent_key else str(_payload(read_access_cookie(request)).get("sid") or "")
    try:
        token = delegation.mint(
            user_id=user.id, session_id=session_id, conversation_id=conversation_id,
            scope=scope, parent_key_id=parent_key, ttl_seconds=_DELEGATION_TTL,
        )
    except delegation.DelegationInvalid as exc:
        logger.error("Cannot mint an AI delegation: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "ai_unavailable", "message": "The assistant is not set up correctly."},
        )
    name = resolve_display_name(user.chosen_display_name, user.first_name, user.last_name)
    headers = {
        **activity_context.forward_headers(),
        DELEGATION_HEADER: token,
        USER_ID_HEADER: user.id,
        USER_NAME_HEADER: quote(name or "", safe=""),
        USER_EMAIL_HEADER: quote(user.email or "", safe=""),
        ORIGIN_HEADER: "api_key" if parent_key else "browser",
    }
    if admin:
        headers[ADMIN_HEADER] = "1"
    return headers


def _ws_from_body(body: bytes) -> tuple[Optional[str], dict]:
    try:
        parsed = json.loads(body or b"{}")
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail={"error": "invalid_json",
                                                     "message": "The body is not JSON."})
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail={"error": "invalid_body",
                                                     "message": "The body must be an object."})
    context = parsed.get("context") if isinstance(parsed.get("context"), dict) else {}
    ws = context.get("workspaceId") or parsed.get("workspaceId")
    return (str(ws) if isinstance(ws, str) and ws else None), parsed


# ── Forwarding ──────────────────────────────────────────────────────────


def _unreachable(exc: Exception) -> HTTPException:
    if isinstance(exc, httpx.TimeoutException):
        return HTTPException(status_code=504, detail={
            "error": "ai_timeout", "message": "The assistant took too long to answer."})
    return HTTPException(status_code=503, detail={
        "error": "ai_unreachable",
        "message": "The AI service is unreachable. It may still be starting up."},
        headers={"Retry-After": "5"})


_PASS_HEADERS = ("content-type", "cache-control", "mcp-session-id", "retry-after")


async def _forward(
    request: Request, path: str, headers: dict[str, str], *, body: Optional[bytes] = None,
    stream: bool = False,
) -> Response:
    client = _get_client()
    url = httpx.URL(path, params=list(request.query_params.multi_items()))
    send_headers = dict(headers)
    if body is not None:
        send_headers["content-type"] = request.headers.get("content-type") or "application/json"
    for name in ("accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"):
        if request.headers.get(name):
            send_headers[name] = request.headers[name]
    try:
        upstream = await client.send(
            client.build_request(request.method, url, content=body, headers=send_headers),
            stream=True,
        )
    except httpx.HTTPError as exc:
        raise _unreachable(exc)
    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() in _PASS_HEADERS}
    streaming = stream or "text/event-stream" in upstream.headers.get("content-type", "")
    if streaming:
        out_headers["X-Accel-Buffering"] = "no"
        out_headers.setdefault("cache-control", "no-cache")

        async def _relay():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            except httpx.HTTPError as exc:  # the AI service went away mid-answer
                logger.warning("AI stream interrupted: %s", exc)

        return StreamingResponse(
            _relay(), status_code=upstream.status_code, headers=out_headers,
            media_type=upstream.headers.get("content-type", "text/event-stream"),
            background=BackgroundTask(upstream.aclose),
        )
    try:
        content = await upstream.aread()
    finally:
        await upstream.aclose()
    return Response(
        content=content, status_code=upstream.status_code, headers=out_headers,
        media_type=upstream.headers.get("content-type", "application/json"),
    )


async def _record_question(db, persona: str, parsed: dict) -> None:
    context = parsed.get("context") if isinstance(parsed.get("context"), dict) else {}
    try:
        await record_for_request(
            db, "workspace.ai.question_asked",
            workspace_id=context.get("workspaceId") or None,
            data_source_id=context.get("dataSourceId") or None,
            target_type="view" if context.get("viewId") else None,
            target_id=context.get("viewId") or None,
            details={
                "persona": persona,
                "conversationId": parsed.get("conversationId") or None,
                # Never the question itself: the conversation keeps it, under
                # its own retention, for the person who asked.
                "questionLength": len(str(parsed.get("message") or "")),
            },
        )
        await db.commit()
    except Exception as exc:  # noqa: BLE001 — never lose an answer to the ledger
        logger.warning("Could not record an AI question: %s", exc)
        await db.rollback()


# ── Routes ──────────────────────────────────────────────────────────────


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    db=Depends(get_db_session),
):
    """Ask the assistant; the answer streams back as server-sent events."""
    _refuse_delegated(request)
    body = await request.body()
    workspace_id, parsed = _ws_from_body(body)
    _require_use(claims, workspace_id)
    await _rate_limit(user)
    persona = str(parsed.get("persona") or "data")[:16]
    await _record_question(db, persona, parsed)
    headers = _forward_headers(
        request, user, workspace_id=workspace_id,
        conversation_id=str(parsed.get("conversationId") or ""),
    )
    return await _forward(request, "/chat/stream", headers, body=body, stream=True)


@router.post("/query/draft")
async def query_draft(
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
):
    """Write a search (or Cypher) for a question, for the person to review."""
    _refuse_delegated(request)
    body = await request.body()
    workspace_id, _ = _ws_from_body(body)
    _require_use(claims, workspace_id)
    await _rate_limit(user)
    headers = _forward_headers(request, user, workspace_id=workspace_id)
    return await _forward(request, "/query/draft", headers, body=body)


@router.post("/mcp/knowledge")
async def mcp_knowledge(
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
):
    """The knowledge MCP endpoint, for people's own agents and other teams' —
    with an API key, or a session. Stateless streamable HTTP: every call is
    one POST, answered in full, so there is no session to hold open (GET and
    DELETE answer 405, as the protocol allows)."""
    _refuse_delegated(request)
    _require_use(claims, None)
    body = await request.body()
    headers = _forward_headers(request, user, workspace_id=None)
    return await _forward(request, "/mcp/knowledge", headers, body=body)


@router.api_route(
    "/admin/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def admin_proxy(
    path: str,
    request: Request,
    user: User = Depends(requires("system:admin")),
    db=Depends(get_db_session),
):
    """AI administration — connections, settings, knowledge, vocabulary,
    usage. ``system:admin``, declared on the route so the navigation
    catalogue and its drift test see the same gate."""
    _refuse_delegated(request)
    body = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
    if path.endswith("/test"):  # a connection test calls a model
        await _rate_limit(user)
    headers = _forward_headers(request, user, workspace_id=None, admin=True)
    response = await _forward(request, f"/admin/{path}", headers, body=body)
    if request.method != "GET" and response.status_code < 400:
        await _record_admin_change(db, f"admin/{path}", request.method, response)
    return response


@router.api_route(
    "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def proxy(
    path: str,
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
):
    """Everything else: the person's status, conversations, feedback and
    concept mappings — ``workspace:ai:use`` in the workspace named by
    ``?workspaceId=``, or in any workspace."""
    _refuse_delegated(request)
    workspace_id = request.query_params.get("workspaceId") or None
    _require_use(claims, workspace_id)
    body = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
    headers = _forward_headers(request, user, workspace_id=workspace_id)
    return await _forward(request, f"/{path}", headers, body=body)


_ADMIN_EVENTS = (
    ("admin/connections", "platform.ai.connection_changed"),
    ("admin/knowledge-sources", "platform.ai.knowledge_source_changed"),
    ("admin/settings", "platform.ai.settings_changed"),
)


async def _record_admin_change(db, path: str, method: str, response: Response) -> None:
    event = next((e for prefix, e in _ADMIN_EVENTS if path.startswith(prefix)), None)
    if event is None:
        return
    action = {"POST": "created", "PUT": "updated", "PATCH": "updated",
              "DELETE": "deleted"}.get(method, "updated")
    if path.endswith("/test"):
        action = "tested"
    name = None
    try:
        payload = json.loads(response.body or b"{}")
        if isinstance(payload, dict):
            name = payload.get("name")
    except (TypeError, ValueError, AttributeError):
        pass
    try:
        await record_for_request(
            db, event, target_type="ai", target_id=path.split("/")[2] if path.count("/") >= 2 else None,
            target_label=name, details={"action": action, "name": name},
        )
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not record an AI administration change: %s", exc)
        await db.rollback()
