"""Tool calling for endpoints that have none: a strict JSON protocol.

Some enterprise gateways strip ``tools`` from requests, or front models that
never learned function calling. For those, the tools are described in the
system prompt and the model answers with exactly one JSON object:

    {"tool": "<name>", "arguments": {...}}     to call a tool
    {"answer": "<markdown>"}                    to answer

The reply is parsed and validated; a malformed one is sent back with the
error, at most twice, before the turn fails with ``protocol``. The agent never
knows the difference: this wraps a provider and speaks the same events.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import AsyncIterator

from .types import (
    ChatMessage,
    CompletionRequest,
    CompletionResult,
    Finished,
    LlmError,
    StreamEvent,
    TextDelta,
    ToolCall,
    ToolCallsReady,
    UsageReport,
    Usage,
)

_MAX_REPAIRS = 2
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _protocol_prompt(request: CompletionRequest) -> str:
    lines = [
        "You can call tools. Reply with exactly ONE JSON object and nothing else.",
        'To call a tool: {"tool": "<name>", "arguments": { ... }}',
        'To answer the person: {"answer": "<your answer, in Markdown>"}',
        "Available tools:",
    ]
    for tool in request.tools:
        lines.append(f"- {tool.name}: {tool.description}")
        lines.append(f"  arguments schema: {json.dumps(tool.parameters, separators=(',', ':'))}")
    return "\n".join(lines)


def _flatten(messages: list[ChatMessage]) -> list[ChatMessage]:
    """Tool calls and results as plain text, for an endpoint that knows neither."""
    out: list[ChatMessage] = []
    for m in messages:
        if m.role == "assistant" and m.tool_calls:
            call = m.tool_calls[0]
            out.append(ChatMessage("assistant", json.dumps({"tool": call.name, "arguments": call.arguments})))
        elif m.role == "tool":
            out.append(ChatMessage("user", f"Result of tool {m.name or ''}:\n{m.content or ''}"))
        else:
            out.append(ChatMessage(m.role, m.content))
    return out


def parse_reply(text: str, tool_names: set[str]) -> tuple[str, object]:
    """``("tool", ToolCall)`` or ``("answer", str)``; raises ``ValueError``."""
    body = _FENCE.sub("", (text or "").strip())
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("the reply holds no JSON object")
    value = json.loads(body[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("the reply is not a JSON object")
    if "answer" in value:
        return "answer", str(value["answer"])
    name = value.get("tool")
    if not isinstance(name, str) or name not in tool_names:
        raise ValueError(f"unknown tool {name!r}")
    arguments = value.get("arguments") or {}
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    return "tool", ToolCall(id=f"call_{uuid.uuid4().hex[:8]}", name=name, arguments=arguments,
                            raw_arguments=json.dumps(arguments))


class JsonToolProtocol:
    """Wraps a provider without tool calling so it behaves as one with it."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self.name = getattr(inner, "name", "")
        self.capabilities = inner.capabilities
        self.kind = getattr(inner, "kind", "")

    def model_for(self, role: str) -> str:
        return self._inner.model_for(role)

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        if not request.tools or request.tool_choice == "none":
            return await self._inner.complete(request)
        messages = [ChatMessage("system", _protocol_prompt(request)), *_flatten(request.messages)]
        names = {t.name for t in request.tools}
        usage = Usage()
        model = ""
        for _attempt in range(_MAX_REPAIRS + 1):
            result = await self._inner.complete(CompletionRequest(
                messages=messages, temperature=request.temperature,
                max_tokens=request.max_tokens, json_mode=True, role=request.role,
            ))
            usage = usage + result.usage
            model = result.model
            try:
                kind, value = parse_reply(result.text, names)
            except ValueError as exc:
                messages = [*messages, ChatMessage("assistant", result.text),
                            ChatMessage("user", f"That reply was not valid ({exc}). "
                                                "Reply again with exactly one JSON object.")]
                continue
            if kind == "answer":
                return CompletionResult(text=str(value), usage=usage, model=model)
            return CompletionResult(tool_calls=[value], usage=usage, model=model,
                                    finish_reason="tool_calls")
        raise LlmError("protocol", "The model did not follow the tool protocol.")

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        if not request.tools or request.tool_choice == "none":
            async for event in self._inner.stream(request):
                yield event
            return
        result = await self.complete(request)
        if result.text:
            yield TextDelta(result.text)
        if result.tool_calls:
            yield ToolCallsReady(tuple(result.tool_calls))
        yield UsageReport(result.usage, result.model)
        yield Finished(result.finish_reason)

    async def embed(self, texts, **kwargs):
        return await self._inner.embed(texts, **kwargs)

    async def aclose(self) -> None:
        await self._inner.aclose()
