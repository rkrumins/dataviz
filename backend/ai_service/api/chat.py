"""The person-facing routes: chat, query drafting, conversations, status, concepts."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select

from .. import connections, settings_store
from ..agent import brief
from ..agent import concepts as C
from ..agent import grounding as G
from ..agent import loop
from ..agent.events import KEEPALIVE
from ..agent.policy import DataPolicy
from ..config import get_config
from ..db import get_session, session_scope
from ..internal_auth import Caller, caller
from ..llm.types import LlmError
from ..models import AiConceptMappingORM, AiConversationORM, AiLlmConnectionORM, AiMessageORM
from ..platform_client import PlatformClient, PlatformError
from .. import query_drafting

logger = logging.getLogger(__name__)
router = APIRouter()


def _bad(message: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": "invalid_request", "message": message})


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError):
        raise _bad("The body is not JSON.")
    if not isinstance(body, dict):
        raise _bad("The body must be an object.")
    return body


@router.post("/chat/stream")
async def chat_stream(request: Request, who: Caller = Depends(caller)):
    try:
        chat = loop.ChatRequest.parse(await _body(request))
    except ValueError as exc:
        raise _bad(str(exc))
    config = get_config()
    turn = loop.new_turn(chat.conversation_id, chat.persona)
    knowledge = getattr(request.app.state, "knowledge", None)
    task = asyncio.create_task(loop.run_turn(
        request=chat, caller=who, config=config, turn=turn, knowledge=knowledge,
        platform_transport=getattr(request.app.state, "platform_transport", None),
        correlation_id=request.headers.get("x-request-id"),
    ))

    async def events():
        try:
            while True:
                try:
                    item = await asyncio.wait_for(turn.queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    yield KEEPALIVE
                    continue
                if item is None:
                    break
                yield item
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/query/draft")
async def query_draft(request: Request, who: Caller = Depends(caller)):
    body = await _body(request)
    question = str(body.get("question") or "").strip()
    if not question or len(question) > 2000:
        raise _bad("Ask a question of at most 2,000 characters.")
    mode = "cypher" if body.get("mode") == "cypher" else "search"
    context = body.get("context") if isinstance(body.get("context"), dict) else {}
    if not context.get("viewId"):
        raise _bad("Drafting a query needs the view it is for (context.viewId).")
    config = get_config()
    async with session_scope() as session:
        settings = await settings_store.load(session)
        row = await session.get(AiLlmConnectionORM, settings.chat_connection_id) \
            if settings.chat_connection_id else None
    if row is None or not row.enabled:
        raise HTTPException(status_code=409, detail={
            "code": "not_configured", "message": "No AI model is connected yet."})
    provider = connections.registry.get(row, allow_hosts=config.egress_allowed_hosts,
                                        timeout=config.llm_timeout_seconds)
    policy = DataPolicy.from_settings(settings.data_policy)
    client = PlatformClient(config.platform_api_url, who.delegation,
                            timeout=config.platform_timeout_seconds,
                            transport=getattr(request.app.state, "platform_transport", None))
    try:
        grounding = await G.build(client, user_id=who.user_id, context=context,
                                  include_values=policy.send_sample_values, view_only=who.view_only)
        async with session_scope() as session:
            grounding.type_property = await C.load_type_property(
                session, None, data_source_id=grounding.target.data_source_id, user_id=who.user_id)
        return await query_drafting.draft(
            provider=provider, client=client, grounding=grounding, policy=policy,
            question=question, mode=mode,
            current_predicate=body.get("currentPredicate") if isinstance(body.get("currentPredicate"), dict) else None,
            choices=body.get("choices") if isinstance(body.get("choices"), dict) else {},
            session_scope=session_scope, user_id=who.user_id,
        )
    except LlmError as exc:
        raise HTTPException(status_code=502, detail={"code": "llm_error", "message": loop._llm_message(exc)})
    except PlatformError as exc:
        raise HTTPException(status_code=exc.status if 400 <= exc.status < 600 else 502,
                            detail={"code": exc.code, "message": exc.message})
    finally:
        await client.aclose()


@router.get("/context")
async def context_preview(request: Request, viewId: str = "", workspaceId: str = "", dataSourceId: str = "",
                          pageKind: str = "", pageId: str = "", pageTitle: str = "",
                          who: Caller = Depends(caller)):
    """What the assistant knows about where the person is — the card the
    panel shows before anything is asked. No model is called, and nothing is
    cut by the data-sharing policy: the person could read all of it."""
    context: dict = {k: v for k, v in {"viewId": viewId, "workspaceId": workspaceId,
                                       "dataSourceId": dataSourceId}.items() if v}
    if pageKind:
        context["page"] = {"kind": pageKind[:32], "id": pageId[:512] or None, "title": pageTitle[:200] or None}
    config = get_config()
    client = PlatformClient(config.platform_api_url, who.delegation,
                            timeout=config.platform_timeout_seconds,
                            transport=getattr(request.app.state, "platform_transport", None))
    try:
        grounding = await G.build(client, user_id=who.user_id, context=context, include_values=True,
                                  view_only=who.view_only)
        if viewId and not grounding.view and not grounding.schema:
            raise HTTPException(status_code=404, detail={"code": "not_found",
                                                         "message": "That view could not be read."})
        async with session_scope() as session:
            grounding.type_property = await C.load_type_property(
                session, None, data_source_id=grounding.target.data_source_id, user_id=who.user_id)
        if pageKind == "doc":
            knowledge = getattr(request.app.state, "knowledge", None)
            found = await knowledge.page(pageId) if knowledge is not None else None
            grounding.page = {"kind": "doc", "id": pageId, "title": pageTitle or (found or {}).get("title"),
                              "headings": (found or {}).get("headings") or []}
        return brief.for_ui(grounding)
    except PlatformError as exc:
        raise HTTPException(status_code=exc.status if 400 <= exc.status < 600 else 502,
                            detail={"code": exc.code, "message": exc.message})
    finally:
        await client.aclose()


@router.get("/status")
async def status(request: Request, who: Caller = Depends(caller), session=Depends(get_session)):
    settings = await settings_store.load(session)
    row = await session.get(AiLlmConnectionORM, settings.chat_connection_id) \
        if settings.chat_connection_id else None
    knowledge = getattr(request.app.state, "knowledge", None)
    summary = {"docs": "unavailable", "views": "disabled"}
    if knowledge is not None:
        try:
            state = await knowledge.status()
            summary = {c["name"]: c.get("status") for c in state["collections"]}
        except Exception:  # noqa: BLE001
            pass
    return {
        "configured": bool(row and row.enabled),
        "connectionName": row.name if row else None,
        "personas": dict(settings.personas),
        "knowledge": summary,
        "dataPolicy": {k: bool(settings.data_policy.get(k, True))
                       for k in ("sendDescriptions", "sendPropertyValues", "sendSampleValues")},
        "limits": {"maxStepsPerTurn": settings.limits["maxStepsPerTurn"]},
    }


def _message_json(row: AiMessageORM) -> dict:
    return {
        "id": row.id, "role": row.role, "content": row.content,
        "blocks": json.loads(row.blocks or "[]"), "steps": json.loads(row.steps or "[]"),
        "followups": json.loads(row.followups or "[]"), "status": row.status,
        "feedback": row.feedback, "createdAt": row.created_at,
    }


@router.get("/conversations")
async def list_conversations(limit: int = 30, who: Caller = Depends(caller), session=Depends(get_session)):
    rows = (await session.execute(
        select(AiConversationORM).where(AiConversationORM.user_id == who.user_id,
                                        AiConversationORM.deleted_at.is_(None))
        .order_by(AiConversationORM.updated_at.desc()).limit(max(1, min(100, limit)))
    )).scalars().all()
    return {"items": [{"id": r.id, "title": r.title, "persona": r.persona,
                       "workspaceId": r.workspace_id, "viewId": r.view_id,
                       "updatedAt": r.updated_at, "messageCount": r.message_count} for r in rows]}


async def _own(session, conversation_id: str, who: Caller) -> AiConversationORM:
    row = await session.get(AiConversationORM, conversation_id)
    if row is None or row.user_id != who.user_id or row.deleted_at:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "No such conversation."})
    return row


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, who: Caller = Depends(caller), session=Depends(get_session)):
    row = await _own(session, conversation_id, who)
    messages = (await session.execute(
        select(AiMessageORM).where(AiMessageORM.conversation_id == row.id)
        .order_by(AiMessageORM.created_at)
    )).scalars().all()
    return {"id": row.id, "title": row.title, "persona": row.persona,
            "workspaceId": row.workspace_id, "viewId": row.view_id,
            "messages": [_message_json(m) for m in messages]}


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: str, who: Caller = Depends(caller), session=Depends(get_session)):
    row = await _own(session, conversation_id, who)
    await session.execute(delete(AiMessageORM).where(AiMessageORM.conversation_id == row.id))
    await session.delete(row)
    return Response(status_code=204)


@router.post("/messages/{message_id}/feedback", status_code=204)
async def feedback(message_id: str, request: Request, who: Caller = Depends(caller),
                   session=Depends(get_session)):
    body = await _body(request)
    rating = body.get("rating")
    if rating not in (1, -1):
        raise _bad("rating is 1 or -1.")
    row = await session.get(AiMessageORM, message_id)
    if row is None or row.user_id != who.user_id or row.role != "assistant":
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "No such answer."})
    row.feedback = rating
    row.feedback_comment = str(body.get("comment") or "")[:1000] or None
    return Response(status_code=204)


@router.get("/concepts")
async def my_concepts(dataSourceId: str, who: Caller = Depends(caller), session=Depends(get_session)):
    rows = (await session.execute(
        select(AiConceptMappingORM).where(AiConceptMappingORM.data_source_id == dataSourceId)
    )).scalars().all()
    visible = [r for r in rows if r.scope == "workspace" or r.user_id == who.user_id]
    return {"items": [concept_json(r) for r in visible]}


def concept_json(r: AiConceptMappingORM) -> dict:
    return {"id": r.id, "concept": r.concept, "label": r.label, "scope": r.scope,
            "workspaceId": r.workspace_id, "dataSourceId": r.data_source_id,
            "predicate": json.loads(r.predicate or "{}"), "uses": r.uses, "updatedAt": r.updated_at,
            "createdBy": r.created_by}


@router.delete("/concepts/{concept_id}", status_code=204)
async def delete_my_concept(concept_id: str, who: Caller = Depends(caller), session=Depends(get_session)):
    row = await session.get(AiConceptMappingORM, concept_id)
    if row is None or row.scope != "personal" or row.user_id != who.user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "No such mapping."})
    await session.delete(row)
    return Response(status_code=204)


async def purge_expired() -> int:
    """Conversations past the retention period, and their messages."""
    async with session_scope() as session:
        settings = await settings_store.load(session)
        cutoff = datetime.now(timezone.utc).timestamp() - settings.retention_days * 86400
        cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
        ids = [r for (r,) in (await session.execute(
            select(AiConversationORM.id).where(AiConversationORM.updated_at < cutoff_iso).limit(500)
        )).all()]
        if ids:
            await session.execute(delete(AiMessageORM).where(AiMessageORM.conversation_id.in_(ids)))
            await session.execute(delete(AiConversationORM).where(AiConversationORM.id.in_(ids)))
        return len(ids)
