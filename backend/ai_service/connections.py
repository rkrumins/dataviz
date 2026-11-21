"""Model connections: stored, validated, tested, and built once per change.

The shape an administrator edits (``public`` out, ``ConnectionInput`` in)
follows the platform's credential conventions (``provider_repo``): secrets are
write-only — the answer says which are *configured*, never what they are —
an update merges into what is stored (a secret omitted keeps its value, one
named in ``secretsClear`` is removed), and a secret sent back as the redaction
marker is refused rather than stored.

:class:`ProviderRegistry` keeps one built provider per connection, rebuilt
when the connection changes, so a minted token is reused across turns
instead of minted per question.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common import credential_crypto
from backend.common.credential_crypto import REDACTION_MARKER

from .llm.auth import AUTH_TYPES, describe_auth_fields
from .llm.provider import KINDS, CompletionProvider, build_provider, spec_from_row
from .llm.types import ChatMessage, CompletionRequest, LlmError, ToolSpec
from .models import AiLlmConnectionORM


class ConnectionInvalid(ValueError):
    pass


class ConnectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(None, max_length=120)
    kind: Optional[str] = None
    baseUrl: Optional[str] = Field(None, max_length=2048)
    authType: Optional[str] = None
    authConfig: Optional[dict[str, Any]] = None
    secrets: Optional[dict[str, Optional[str]]] = None
    secretsClear: Optional[list[str]] = None
    extraHeaders: Optional[dict[str, str]] = None
    options: Optional[dict[str, Any]] = None
    models: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None


#: Headers a connection may not set for itself: they are the sign-in's, or
#: the transport's.
_RESERVED_HEADERS = frozenset({"authorization", "host", "content-length", "cookie"})
_SECRET_NAMES = frozenset({"apiKey", "token", "password", "clientSecret"})


def _loads(raw: Optional[str], default):
    try:
        value = json.loads(raw) if raw else default
    except (TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


def public(row: AiLlmConnectionORM) -> dict[str, Any]:
    secrets = credential_crypto.decrypt(row.secrets_encrypted)
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "baseUrl": row.base_url,
        "authType": row.auth_type,
        "authConfig": _loads(row.auth_config, {}),
        # Which secrets are set — never their values.
        "secrets": {name: {"configured": bool(secrets.get(name))} for name in sorted(_SECRET_NAMES)
                    if name in secrets},
        "extraHeaders": _loads(row.extra_headers, {}),
        "options": _loads(row.options, {}),
        "models": _loads(row.models, {}),
        "capabilities": _loads(row.capabilities, {}),
        "enabled": bool(row.enabled),
        "lastTest": {
            "at": row.last_test_at, "status": row.last_test_status, "detail": row.last_test_detail,
        } if row.last_test_at else None,
        "createdBy": row.created_by, "createdAt": row.created_at,
        "updatedBy": row.updated_by, "updatedAt": row.updated_at,
    }


def _check_url(url: str, what: str) -> str:
    parts = urlsplit(url or "")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConnectionInvalid(f"{what} must be an http(s) URL with a host.")
    if parts.username or parts.password:
        raise ConnectionInvalid(f"{what} may not carry credentials; use the sign-in settings.")
    return url.rstrip("/")


def _validate(merged: dict[str, Any]) -> None:
    if not merged.get("name"):
        raise ConnectionInvalid("A connection needs a name.")
    if merged["kind"] not in KINDS:
        raise ConnectionInvalid(f"kind must be one of {list(KINDS)}.")
    _check_url(merged["baseUrl"], "baseUrl")
    auth_type = merged["authType"]
    if auth_type not in AUTH_TYPES:
        raise ConnectionInvalid(f"authType must be one of {list(AUTH_TYPES)}.")
    fields = describe_auth_fields()[auth_type]
    unknown = set(merged["authConfig"]) - set(fields["config"])
    if unknown:
        raise ConnectionInvalid(f"authConfig for {auth_type} does not take {sorted(unknown)}.")
    secret_keys = set(merged["secrets"]) - set(fields["secrets"])
    if secret_keys:
        raise ConnectionInvalid(f"{auth_type} does not use the secrets {sorted(secret_keys)}.")
    if merged["authConfig"].get("tokenUrl"):
        _check_url(str(merged["authConfig"]["tokenUrl"]), "tokenUrl")
    bad_headers = {h for h in merged["extraHeaders"] if h.lower() in _RESERVED_HEADERS}
    if bad_headers:
        raise ConnectionInvalid(f"extraHeaders may not set {sorted(bad_headers)}.")
    if not merged["models"].get("chat"):
        raise ConnectionInvalid("Name the chat model (models.chat).")
    dims = merged["models"].get("embeddingDimensions")
    if dims is not None and (not isinstance(dims, int) or not 8 <= dims <= 8192):
        raise ConnectionInvalid("models.embeddingDimensions must be a whole number from 8 to 8192.")


def _merge(row: Optional[AiLlmConnectionORM], body: ConnectionInput) -> dict[str, Any]:
    stored_secrets = credential_crypto.decrypt(row.secrets_encrypted) if row else {}
    merged = {
        "name": row.name if row else None,
        "kind": row.kind if row else "openai_compatible",
        "baseUrl": row.base_url if row else "",
        "authType": row.auth_type if row else "none",
        "authConfig": _loads(row.auth_config, {}) if row else {},
        "secrets": dict(stored_secrets),
        "extraHeaders": _loads(row.extra_headers, {}) if row else {},
        "options": _loads(row.options, {}) if row else {},
        "models": _loads(row.models, {}) if row else {},
        "enabled": bool(row.enabled) if row else True,
    }
    for key in ("name", "kind", "baseUrl", "authType", "authConfig", "extraHeaders",
                "options", "models", "enabled"):
        value = getattr(body, key)
        if value is not None:
            merged[key] = value.strip() if isinstance(value, str) else value
    if body.authType is not None and row is not None and body.authType != row.auth_type:
        merged["secrets"] = {}  # a new sign-in method starts from no secrets
    for name, value in (body.secrets or {}).items():
        if value == REDACTION_MARKER:
            raise ConnectionInvalid(
                f"The secret {name!r} still holds the redaction marker. Omit it to keep the "
                "stored value, or send a new value.",
            )
        if value:
            merged["secrets"][name] = value
    for name in body.secretsClear or []:
        merged["secrets"].pop(name, None)
    return merged


def _apply(row: AiLlmConnectionORM, merged: dict[str, Any], user_id: str) -> None:
    row.name = merged["name"]
    row.kind = merged["kind"]
    row.base_url = merged["baseUrl"].rstrip("/")
    row.auth_type = merged["authType"]
    row.auth_config = json.dumps(merged["authConfig"])
    row.secrets_encrypted = credential_crypto.encrypt(merged["secrets"]) if merged["secrets"] else None
    row.extra_headers = json.dumps(merged["extraHeaders"])
    row.options = json.dumps(merged["options"])
    row.models = json.dumps(merged["models"])
    row.enabled = bool(merged["enabled"])
    row.updated_by = user_id
    row.updated_at = datetime.now(timezone.utc).isoformat()


async def list_rows(session: AsyncSession) -> list[AiLlmConnectionORM]:
    return list((await session.execute(
        select(AiLlmConnectionORM).order_by(AiLlmConnectionORM.name)
    )).scalars())


async def get_row(session: AsyncSession, connection_id: str) -> Optional[AiLlmConnectionORM]:
    return await session.get(AiLlmConnectionORM, connection_id)


async def create(session: AsyncSession, body: ConnectionInput, *, user_id: str) -> AiLlmConnectionORM:
    merged = _merge(None, body)
    _validate(merged)
    clash = (await session.execute(
        select(AiLlmConnectionORM.id).where(AiLlmConnectionORM.name == merged["name"])
    )).first()
    if clash:
        raise ConnectionInvalid(f"A connection named {merged['name']!r} already exists.")
    row = AiLlmConnectionORM(created_by=user_id)
    _apply(row, merged, user_id)
    session.add(row)
    await session.flush()
    return row


async def update(session: AsyncSession, row: AiLlmConnectionORM, body: ConnectionInput, *,
                 user_id: str) -> AiLlmConnectionORM:
    merged = _merge(row, body)
    _validate(merged)
    _apply(row, merged, user_id)
    await session.flush()
    registry.forget(row.id)
    return row


async def delete(session: AsyncSession, row: AiLlmConnectionORM) -> None:
    registry.forget(row.id)
    await session.delete(row)
    await session.flush()


# ── Built providers ─────────────────────────────────────────────────────


class ProviderRegistry:
    """One provider per connection, rebuilt when the row changes."""

    def __init__(self) -> None:
        self._built: dict[str, tuple[str, CompletionProvider]] = {}
        self.transport = None  # tests route every connection through a mock

    def get(self, row: AiLlmConnectionORM, *, allow_hosts: frozenset[str], timeout: float) -> CompletionProvider:
        if not row.enabled:
            raise LlmError("not_configured", f"The connection {row.name!r} is switched off.")
        stamp = row.updated_at or ""
        held = self._built.get(row.id)
        if held is not None and held[0] == stamp:
            return held[1]
        provider = build_provider(spec_from_row(row), allow_hosts=allow_hosts, timeout=timeout,
                                  transport=self.transport)
        if held is not None:
            asyncio.ensure_future(_quietly_close(held[1]))
        self._built[row.id] = (stamp, provider)
        return provider

    def forget(self, connection_id: str) -> None:
        held = self._built.pop(connection_id, None)
        if held is not None:
            asyncio.ensure_future(_quietly_close(held[1]))

    async def close_all(self) -> None:
        for _, provider in list(self._built.values()):
            await _quietly_close(provider)
        self._built.clear()


async def _quietly_close(provider) -> None:
    try:
        await provider.aclose()
    except Exception:  # noqa: BLE001
        pass


registry = ProviderRegistry()


# ── Testing a connection ────────────────────────────────────────────────

_PING = ToolSpec(
    name="report_status",
    description="Report that you can call tools. Always call it when asked to.",
    parameters={"type": "object", "properties": {"status": {"type": "string"}},
                "required": ["status"]},
)


async def probe(provider: CompletionProvider) -> dict[str, Any]:
    """Ask the endpoint three small things: can it answer, can it call a
    tool, can it embed. Each is reported separately — a gateway that answers
    but cannot call tools is usable, through the JSON protocol."""
    report: dict[str, Any] = {"ok": False, "checks": []}

    async def _check(name: str, coro):
        started = time.monotonic()
        try:
            detail = await coro
            report["checks"].append({
                "name": name, "ok": True, "latencyMs": int((time.monotonic() - started) * 1000),
                "detail": detail,
            })
            return True
        except LlmError as exc:
            report["checks"].append({
                "name": name, "ok": False, "code": exc.code, "detail": str(exc),
                "latencyMs": int((time.monotonic() - started) * 1000),
            })
            return False

    async def _answer():
        result = await provider.complete(CompletionRequest(
            [ChatMessage("user", "Reply with the single word: ok")], max_tokens=8, temperature=0,
        ))
        return {"model": result.model, "reply": result.text[:40]}

    async def _tools():
        result = await provider.complete(CompletionRequest(
            [ChatMessage("user", "Call the report_status tool with status 'ready'.")],
            tools=[_PING], max_tokens=64, temperature=0,
        ))
        if not result.tool_calls:
            raise LlmError("protocol", "The model answered without calling the tool.")
        return {"called": result.tool_calls[0].name}

    async def _embed():
        vectors = await provider.embed(["connection test"])
        return {"dimensions": len(vectors[0])}

    answered = await _check("answer", _answer())
    tools_ok = await _check("tools", _tools()) if answered else False
    embeds = None
    if provider.capabilities.embeddings:
        embeds = await _check("embeddings", _embed())
    report["ok"] = answered
    report["capabilities"] = {
        "tools": tools_ok,
        "nativeTools": tools_ok and provider.capabilities.tools,
        "streaming": provider.capabilities.streaming,
        "embeddings": bool(embeds),
        "embeddingDimensions": next(
            (c["detail"]["dimensions"] for c in report["checks"]
             if c["name"] == "embeddings" and c["ok"]), None,
        ),
    }
    return report


async def record_probe(session: AsyncSession, row: AiLlmConnectionORM, report: Mapping[str, Any]) -> None:
    row.last_test_at = datetime.now(timezone.utc).isoformat()
    row.last_test_status = "ok" if report.get("ok") else "failed"
    failed = [c for c in report.get("checks", []) if not c.get("ok")]
    row.last_test_detail = (failed[0].get("detail") if failed else "All checks passed")[:500]
    row.capabilities = json.dumps(report.get("capabilities") or {})
    await session.flush()
