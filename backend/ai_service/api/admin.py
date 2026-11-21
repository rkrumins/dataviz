"""Administration → AI: connections, settings, knowledge, vocabulary, usage.

Every route needs ``X-AI-Admin: 1``, which the web tier sets only after
``requires("system:admin")`` (``admin_caller``). Changes are recorded in the
activity log by the web tier, which sees each one go by.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, select

from .. import connections, settings_store
from ..config import get_config
from ..db import get_session
from ..internal_auth import Caller, admin_caller
from ..knowledge.sources import ExternalMcpSource
from ..llm.auth import AUTH_TYPES, describe_auth_fields
from ..llm.types import LlmError
from ..models import (
    AiConceptMappingORM, AiKnowledgeSourceORM, AiLlmConnectionORM, AiMessageORM, AiUsageDailyORM,
)
from backend.common import credential_crypto
from backend.common.credential_crypto import REDACTION_MARKER
from .chat import concept_json

router = APIRouter(prefix="/admin")


def _invalid(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": "invalid", "message": message})


def _missing(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found", "message": f"No such {what}."})


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise _invalid("The body is not JSON.")
    if not isinstance(body, dict):
        raise _invalid("The body must be an object.")
    return body


# ── Connections ─────────────────────────────────────────────────────────


@router.get("/auth-types")
async def auth_types(_: Caller = Depends(admin_caller)):
    return describe_auth_fields()


@router.get("/connections")
async def list_connections(_: Caller = Depends(admin_caller), session=Depends(get_session)):
    return {"items": [connections.public(r) for r in await connections.list_rows(session)]}


def _input(body: dict) -> connections.ConnectionInput:
    try:
        return connections.ConnectionInput.model_validate(body)
    except ValidationError as exc:
        first = exc.errors()[0]
        raise _invalid(f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}")


@router.post("/connections", status_code=201)
async def create_connection(request: Request, who: Caller = Depends(admin_caller), session=Depends(get_session)):
    try:
        row = await connections.create(session, _input(await _json(request)), user_id=who.user_id)
    except (connections.ConnectionInvalid, credential_crypto.CredentialEncryptionError) as exc:
        raise _invalid(str(exc))
    return connections.public(row)


@router.get("/connections/{connection_id}")
async def get_connection(connection_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await connections.get_row(session, connection_id)
    if row is None:
        raise _missing("connection")
    return connections.public(row)


@router.patch("/connections/{connection_id}")
async def update_connection(connection_id: str, request: Request, who: Caller = Depends(admin_caller),
                            session=Depends(get_session)):
    row = await connections.get_row(session, connection_id)
    if row is None:
        raise _missing("connection")
    try:
        row = await connections.update(session, row, _input(await _json(request)), user_id=who.user_id)
    except (connections.ConnectionInvalid, credential_crypto.CredentialEncryptionError) as exc:
        raise _invalid(str(exc))
    return connections.public(row)


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_connection(connection_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await connections.get_row(session, connection_id)
    if row is None:
        raise _missing("connection")
    settings = await settings_store.load(session)
    if connection_id in (settings.chat_connection_id, settings.fast_connection_id,
                         settings.embedding_connection_id):
        raise HTTPException(status_code=409, detail={
            "code": "in_use", "message": "The assistant uses this connection. Choose another under "
                                         "Assistant first."})
    await connections.delete(session, row)
    return Response(status_code=204)


@router.post("/connections/{connection_id}/test")
async def test_connection(connection_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await connections.get_row(session, connection_id)
    if row is None:
        raise _missing("connection")
    config = get_config()
    try:
        provider = connections.registry.get(row, allow_hosts=config.egress_allowed_hosts,
                                            timeout=config.llm_timeout_seconds)
    except LlmError as exc:
        return {"ok": False, "checks": [{"name": "answer", "ok": False, "code": exc.code,
                                          "detail": str(exc)}], "capabilities": {}}
    report = await connections.probe(provider)
    await connections.record_probe(session, row, report)
    return {**report, "name": row.name}


# ── Settings ────────────────────────────────────────────────────────────


@router.get("/settings")
async def get_settings(_: Caller = Depends(admin_caller), session=Depends(get_session)):
    return (await settings_store.load(session)).public()


@router.patch("/settings")
async def patch_settings(request: Request, who: Caller = Depends(admin_caller), session=Depends(get_session)):
    body = await _json(request)
    for key in ("chatConnectionId", "fastConnectionId", "embeddingConnectionId"):
        if body.get(key) and await session.get(AiLlmConnectionORM, body[key]) is None:
            raise _invalid(f"{key} names no connection.")
    try:
        saved = await settings_store.save(session, body, user_id=who.user_id)
    except (settings_store.SettingsInvalid, ValueError, TypeError) as exc:
        raise _invalid(str(exc))
    return saved.public()


# ── Knowledge ───────────────────────────────────────────────────────────


@router.get("/knowledge")
async def knowledge_status(request: Request, _: Caller = Depends(admin_caller)):
    knowledge = getattr(request.app.state, "knowledge", None)
    if knowledge is None:
        return {"store": "none", "collections": []}
    return await knowledge.status()


@router.post("/knowledge/{name}/reindex", status_code=202)
async def reindex(name: str, request: Request, _: Caller = Depends(admin_caller)):
    knowledge = getattr(request.app.state, "knowledge", None)
    if knowledge is None or not knowledge.reindex(name):
        raise HTTPException(status_code=409, detail={
            "code": "unavailable", "message": "There is no vector store to rebuild, or no such collection."})
    return {"accepted": True, "collection": name}


class SourceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(None, max_length=120)
    url: Optional[str] = Field(None, max_length=2048)
    authType: Optional[str] = None
    authConfig: Optional[dict[str, Any]] = None
    secrets: Optional[dict[str, Optional[str]]] = None
    secretsClear: Optional[list[str]] = None
    toolName: Optional[str] = Field(None, max_length=120)
    argumentMap: Optional[dict[str, str]] = None
    resultMap: Optional[dict[str, str]] = None
    personas: Optional[list[str]] = None
    timeoutMs: Optional[int] = Field(None, ge=500, le=20000)
    trustLabel: Optional[str] = Field(None, max_length=60)
    enabled: Optional[bool] = None


def _source_json(row: AiKnowledgeSourceORM) -> dict:
    secrets = credential_crypto.decrypt(row.secrets_encrypted)
    return {
        "id": row.id, "name": row.name, "url": row.url, "authType": row.auth_type,
        "authConfig": json.loads(row.auth_config or "{}"),
        "secrets": {k: {"configured": bool(v)} for k, v in secrets.items()},
        "toolName": row.tool_name, "argumentMap": json.loads(row.argument_map or "{}"),
        "resultMap": json.loads(row.result_map or "{}"), "personas": json.loads(row.personas or "[]"),
        "timeoutMs": row.timeout_ms, "trustLabel": row.trust_label, "enabled": bool(row.enabled),
        "createdAt": row.created_at, "updatedAt": row.updated_at,
    }


def _apply_source(row: AiKnowledgeSourceORM, body: SourceInput, who: Caller) -> None:
    for attr, key in (("name", "name"), ("url", "url"), ("tool_name", "toolName"),
                      ("trust_label", "trustLabel"), ("timeout_ms", "timeoutMs"), ("enabled", "enabled")):
        value = getattr(body, key)
        if value is not None:
            setattr(row, attr, value.strip() if isinstance(value, str) else value)
    if body.authType is not None:
        if body.authType not in AUTH_TYPES:
            raise _invalid(f"authType must be one of {list(AUTH_TYPES)}.")
        if body.authType != row.auth_type:
            row.secrets_encrypted = None
        row.auth_type = body.authType
    for attr, key in (("auth_config", "authConfig"), ("argument_map", "argumentMap"),
                      ("result_map", "resultMap"), ("personas", "personas")):
        value = getattr(body, key)
        if value is not None:
            setattr(row, attr, json.dumps(value))
    secrets = credential_crypto.decrypt(row.secrets_encrypted)
    for name, value in (body.secrets or {}).items():
        if value == REDACTION_MARKER:
            raise _invalid(f"The secret {name!r} still holds the redaction marker.")
        if value:
            secrets[name] = value
    for name in body.secretsClear or []:
        secrets.pop(name, None)
    row.secrets_encrypted = credential_crypto.encrypt(secrets) if secrets else None
    parts = urlsplit(row.url or "")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise _invalid("url must be an http(s) URL with a host.")
    if not row.name or not row.tool_name:
        raise _invalid("A knowledge source needs a name and a toolName.")
    if not set(json.loads(row.personas or "[]")) <= {"help", "data"}:
        raise _invalid("personas are help and/or data.")
    row.updated_by = who.user_id
    row.updated_at = datetime.now(timezone.utc).isoformat()


@router.get("/knowledge-sources")
async def list_sources(_: Caller = Depends(admin_caller), session=Depends(get_session)):
    rows = (await session.execute(select(AiKnowledgeSourceORM).order_by(AiKnowledgeSourceORM.name))).scalars().all()
    return {"items": [_source_json(r) for r in rows]}


def _source_input(body: dict) -> SourceInput:
    try:
        return SourceInput.model_validate(body)
    except ValidationError as exc:
        first = exc.errors()[0]
        raise _invalid(f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}")


@router.post("/knowledge-sources", status_code=201)
async def create_source(request: Request, who: Caller = Depends(admin_caller), session=Depends(get_session)):
    body = _source_input(await _json(request))
    row = AiKnowledgeSourceORM(created_by=who.user_id, auth_type="none", url="", name="", tool_name="")
    _apply_source(row, body, who)
    if (await session.execute(select(AiKnowledgeSourceORM.id).where(AiKnowledgeSourceORM.name == row.name))).first():
        raise _invalid(f"A knowledge source named {row.name!r} already exists.")
    session.add(row)
    await session.flush()
    return _source_json(row)


@router.get("/knowledge-sources/{source_id}")
async def get_source(source_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await session.get(AiKnowledgeSourceORM, source_id)
    if row is None:
        raise _missing("knowledge source")
    return _source_json(row)


@router.patch("/knowledge-sources/{source_id}")
async def update_source(source_id: str, request: Request, who: Caller = Depends(admin_caller),
                        session=Depends(get_session)):
    row = await session.get(AiKnowledgeSourceORM, source_id)
    if row is None:
        raise _missing("knowledge source")
    _apply_source(row, _source_input(await _json(request)), who)
    await session.flush()
    return _source_json(row)


@router.delete("/knowledge-sources/{source_id}", status_code=204)
async def delete_source(source_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await session.get(AiKnowledgeSourceORM, source_id)
    if row is None:
        raise _missing("knowledge source")
    await session.delete(row)
    return Response(status_code=204)


@router.post("/knowledge-sources/{source_id}/test")
async def test_source(source_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await session.get(AiKnowledgeSourceORM, source_id)
    if row is None:
        raise _missing("knowledge source")
    try:
        source = ExternalMcpSource(row, allow_hosts=get_config().egress_allowed_hosts)
    except LlmError as exc:
        return {"ok": False, "code": exc.code, "detail": str(exc), "name": row.name}
    try:
        return {**await source.test(), "name": row.name}
    finally:
        await source.aclose()


# ── Business vocabulary ─────────────────────────────────────────────────


@router.get("/concepts")
async def list_concepts(dataSourceId: Optional[str] = None, _: Caller = Depends(admin_caller),
                        session=Depends(get_session)):
    query = select(AiConceptMappingORM).order_by(AiConceptMappingORM.concept)
    if dataSourceId:
        query = query.where(AiConceptMappingORM.data_source_id == dataSourceId)
    rows = (await session.execute(query.limit(500))).scalars().all()
    return {"items": [concept_json(r) for r in rows]}


@router.delete("/concepts/{concept_id}", status_code=204)
async def delete_concept(concept_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await session.get(AiConceptMappingORM, concept_id)
    if row is None:
        raise _missing("mapping")
    await session.delete(row)
    return Response(status_code=204)


@router.post("/concepts/{concept_id}/promote")
async def promote_concept(concept_id: str, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    row = await session.get(AiConceptMappingORM, concept_id)
    if row is None:
        raise _missing("mapping")
    clash = (await session.execute(select(AiConceptMappingORM).where(
        AiConceptMappingORM.data_source_id == row.data_source_id,
        AiConceptMappingORM.scope == "workspace", AiConceptMappingORM.concept == row.concept,
    ))).scalar_one_or_none()
    if clash is not None and clash.id != row.id:
        await session.delete(clash)
        await session.flush()
    row.scope = "workspace"
    row.user_id = ""
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return concept_json(row)


# ── Usage ───────────────────────────────────────────────────────────────


@router.get("/usage")
async def usage(days: int = 30, _: Caller = Depends(admin_caller), session=Depends(get_session)):
    days = max(1, min(180, days))
    since = (datetime.now(timezone.utc) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    rows = (await session.execute(
        select(AiUsageDailyORM.day, func.sum(AiUsageDailyORM.requests),
               func.sum(AiUsageDailyORM.input_tokens), func.sum(AiUsageDailyORM.output_tokens))
        .where(AiUsageDailyORM.day >= since).group_by(AiUsageDailyORM.day).order_by(AiUsageDailyORM.day)
    )).all()
    up = (await session.execute(select(func.count()).where(AiMessageORM.feedback == 1))).scalar() or 0
    down = (await session.execute(select(func.count()).where(AiMessageORM.feedback == -1))).scalar() or 0
    recent = (await session.execute(
        select(AiMessageORM).where(AiMessageORM.feedback == -1)
        .order_by(AiMessageORM.created_at.desc()).limit(20)
    )).scalars().all()
    questions = {}
    for message in recent:
        question = (await session.execute(
            select(AiMessageORM.content).where(
                AiMessageORM.conversation_id == message.conversation_id, AiMessageORM.role == "user",
                AiMessageORM.created_at <= message.created_at,
            ).order_by(AiMessageORM.created_at.desc()).limit(1)
        )).scalar()
        questions[message.id] = question
    return {
        "days": [{"day": d, "requests": int(r or 0), "inputTokens": int(i or 0), "outputTokens": int(o or 0)}
                 for d, r, i, o in rows],
        "feedback": {"up": int(up), "down": int(down)},
        "recentDown": [{"messageId": m.id, "question": questions.get(m.id), "comment": m.feedback_comment,
                        "createdAt": m.created_at} for m in recent],
    }
