"""The port every model adapter implements, and the factory that builds one.

A *connection* (``ai_llm_connections``) is data: a kind, a base URL, how to
sign in, which model serves which role. :func:`build_provider` turns one into
an adapter. Adding a provider (Anthropic, Bedrock, Vertex, a custom HTTP
template — Phase 2) is a new ``kind`` here and a module beside
``openai_compatible``; nothing that calls a model changes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Mapping, Optional, Protocol

import httpx

from backend.common import credential_crypto

from .auth import build_auth
from .egress import GuardedClient
from .json_tools import JsonToolProtocol
from .openai_compatible import OpenAICompatibleProvider
from .types import Capabilities, CompletionRequest, CompletionResult, LlmError, StreamEvent

#: The kinds of connection this release can build.
KINDS = ("openai_compatible",)


class CompletionProvider(Protocol):
    name: str
    kind: str
    capabilities: Capabilities

    def model_for(self, role: str) -> str: ...

    def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]: ...

    async def complete(self, request: CompletionRequest) -> CompletionResult: ...

    async def embed(self, texts: list[str], **kwargs) -> list[list[float]]: ...

    async def aclose(self) -> None: ...


@dataclass(frozen=True)
class ConnectionSpec:
    """A connection as the factory needs it — secrets decrypted, in memory only."""

    id: str
    name: str
    kind: str
    base_url: str
    auth_type: str = "none"
    auth_config: Mapping[str, Any] = field(default_factory=dict)
    secrets: Mapping[str, Any] = field(default_factory=dict, repr=False)
    extra_headers: Mapping[str, str] = field(default_factory=dict)
    options: Mapping[str, Any] = field(default_factory=dict)
    models: Mapping[str, Any] = field(default_factory=dict)


def _loads(raw: Optional[str], default):
    if not raw:
        return default
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


def spec_from_row(row) -> ConnectionSpec:
    """A connection row (``AiLlmConnectionORM``) as a spec, secrets decrypted."""
    return ConnectionSpec(
        id=row.id, name=row.name, kind=row.kind or "openai_compatible",
        base_url=row.base_url or "",
        auth_type=row.auth_type or "none",
        auth_config=_loads(row.auth_config, {}),
        secrets=credential_crypto.decrypt(row.secrets_encrypted),
        extra_headers=_loads(row.extra_headers, {}),
        options=_loads(row.options, {}),
        models=_loads(row.models, {}),
    )


def build_provider(
    spec: ConnectionSpec, *, allow_hosts: frozenset[str], timeout: float,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> CompletionProvider:
    if spec.kind not in KINDS:
        raise LlmError("not_configured", f"Connections of kind {spec.kind!r} are not supported.")
    http = GuardedClient(allow_hosts=allow_hosts, timeout=timeout, transport=transport)
    auth = build_auth(spec.auth_type, spec.auth_config, spec.secrets, http)
    provider = OpenAICompatibleProvider(
        base_url=spec.base_url, auth=auth, http=http, models=spec.models,
        options=spec.options, extra_headers=spec.extra_headers, name=spec.name,
    )
    if not provider.capabilities.tools:
        return JsonToolProtocol(provider)
    return provider
