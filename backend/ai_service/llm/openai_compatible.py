"""The OpenAI-compatible adapter: Chat Completions and Embeddings.

One adapter covers OpenAI, Azure OpenAI, vLLM, Ollama, LiteLLM, most hosted
gateways and most in-house ones, because they speak the same two endpoints.
What differs between them is configuration (``options``):

``chatPath`` / ``embeddingsPath``
    Relative to the base URL. ``{model}`` is filled in, so Azure's
    ``/openai/deployments/{model}/chat/completions`` is a path, not code.
``queryParams``
    Added to every call — Azure's ``{"api-version": "2024-10-21"}``.
``stream``
    ``false`` for a gateway that cannot stream; the answer then arrives whole.
``streamUsage``
    Send ``stream_options.include_usage`` (default on); turn off for an
    endpoint that rejects it.
``tools``
    ``false`` for an endpoint without function calling: the strict-JSON
    protocol (``json_tools``) is used instead.
``jsonMode``
    Whether ``response_format: json_object`` may be sent.
``maxRetries``
    Retries of a 429 or 5xx before any of the answer arrived (default 2),
    honouring ``Retry-After``.

A 401 or 403 drops a minted token and retries once with a fresh one.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, AsyncIterator, Mapping, Optional

from .auth import AuthStrategy
from .egress import GuardedClient
from .types import (
    Capabilities,
    ChatMessage,
    CompletionRequest,
    CompletionResult,
    Finished,
    LlmError,
    StreamEvent,
    TextDelta,
    ToolCall,
    ToolCallsReady,
    Usage,
    UsageReport,
)

logger = logging.getLogger(__name__)

_RETRY_STATUSES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


def _encode_message(message: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": message.role}
    if message.role == "tool":
        out["tool_call_id"] = message.tool_call_id or ""
        out["content"] = message.content or ""
        return out
    out["content"] = message.content if message.content is not None else ""
    if message.tool_calls:
        out["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": call.raw_arguments or json.dumps(call.arguments),
                },
            }
            for call in message.tool_calls
        ]
        if not message.content:
            out["content"] = None
    if message.name:
        out["name"] = message.name
    return out


def _parse_arguments(raw: str) -> tuple[dict[str, Any], Optional[str]]:
    if not raw or not raw.strip():
        return {}, None
    try:
        value = json.loads(raw)
    except ValueError as exc:
        return {}, f"not JSON: {exc}"
    if not isinstance(value, dict):
        return {}, "the arguments must be a JSON object"
    return value, None


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # content parts
        return "".join(
            part.get("text", "") for part in content
            if isinstance(part, Mapping) and part.get("type") in (None, "text", "output_text")
        )
    return ""


def _status_error(status: int, retry_after: Optional[float]) -> LlmError:
    if status in (401, 403):
        return LlmError("auth", "The endpoint refused the credentials.", status=status)
    if status == 429:
        return LlmError("rate_limited", "The endpoint is rate-limiting this connection.",
                        status=status, retry_after=retry_after)
    if status in (408, 504):
        return LlmError("timeout", f"The endpoint timed out (HTTP {status}).", status=status)
    if status >= 500:
        return LlmError("unavailable", f"The endpoint failed (HTTP {status}).", status=status,
                        retry_after=retry_after)
    if status == 404:
        return LlmError("bad_request", "The endpoint does not know this path or model (HTTP 404).",
                        status=status)
    return LlmError("bad_request", f"The endpoint rejected the request (HTTP {status}).",
                    status=status)


def _retry_after(headers: Mapping[str, str]) -> Optional[float]:
    raw = headers.get("retry-after")
    if not raw:
        return None
    try:
        return max(0.0, min(30.0, float(raw)))
    except ValueError:
        return None


class OpenAICompatibleProvider:
    """A connection to one OpenAI-compatible endpoint."""

    kind = "openai_compatible"

    def __init__(
        self,
        *,
        base_url: str,
        auth: AuthStrategy,
        http: GuardedClient,
        models: Mapping[str, Any],
        options: Optional[Mapping[str, Any]] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        name: str = "",
    ) -> None:
        if not base_url:
            raise LlmError("not_configured", "The connection has no base URL.")
        self.name = name
        self._base = base_url.rstrip("/")
        self._auth = auth
        self._http = http
        self._models = {k: v for k, v in (models or {}).items() if v}
        opts = dict(options or {})
        self._chat_path = str(opts.get("chatPath") or "/chat/completions")
        self._embeddings_path = str(opts.get("embeddingsPath") or "/embeddings")
        self._query = {str(k): str(v) for k, v in (opts.get("queryParams") or {}).items()}
        self._stream = opts.get("stream", True) is not False
        self._stream_usage = opts.get("streamUsage", True) is not False
        self._tools = opts.get("tools", True) is not False
        self._json_mode = opts.get("jsonMode", True) is not False
        self._max_retries = max(0, min(5, int(opts.get("maxRetries", 2))))
        self._headers = {str(k): str(v) for k, v in (extra_headers or {}).items()}
        dims = self._models.get("embeddingDimensions")
        self.capabilities = Capabilities(
            streaming=self._stream,
            tools=self._tools,
            json_mode=self._json_mode,
            embeddings=bool(self._models.get("embedding")),
            embedding_dimensions=int(dims) if dims else None,
        )

    # ── plumbing ────────────────────────────────────────────────────

    def model_for(self, role: str) -> str:
        model = self._models.get(role) or (self._models.get("chat") if role == "fast" else None)
        if not model:
            raise LlmError("not_configured", f"The connection names no {role} model.")
        return str(model)

    def _url(self, path: str, model: str) -> str:
        return self._base + path.replace("{model}", model)

    async def _prepare(self) -> tuple[dict[str, str], dict[str, str]]:
        headers = {"Content-Type": "application/json", **self._headers}
        params = dict(self._query)
        await self._auth.apply(headers, params)
        return headers, params

    async def _post_json(self, url: str, payload: dict) -> dict:
        reauthed = False
        attempt = 0
        while True:
            headers, params = await self._prepare()
            response = await self._http.request("POST", url, json=payload, headers=headers,
                                                params=params)
            if response.status_code in (401, 403) and not reauthed:
                reauthed = True
                await self._auth.invalidate()
                continue
            if response.status_code in _RETRY_STATUSES and attempt < self._max_retries:
                attempt += 1
                await asyncio.sleep(_backoff(attempt, _retry_after(response.headers)))
                continue
            if response.status_code >= 400:
                raise _status_error(response.status_code, _retry_after(response.headers))
            try:
                body = response.json()
            except ValueError as exc:
                raise LlmError("protocol", "The endpoint did not answer with JSON.") from exc
            if not isinstance(body, dict):
                raise LlmError("protocol", "The endpoint's answer is not an object.")
            return body

    def _payload(self, request: CompletionRequest, *, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model_for(request.role),
            "messages": [_encode_message(m) for m in request.messages],
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_tokens:
            payload["max_tokens"] = request.max_tokens
        if request.tools and request.tool_choice != "none":
            payload["tools"] = [
                {"type": "function", "function": {
                    "name": t.name, "description": t.description, "parameters": t.parameters,
                }}
                for t in request.tools
            ]
            payload["tool_choice"] = "auto"
        if request.json_mode and self._json_mode:
            payload["response_format"] = {"type": "json_object"}
        if stream:
            payload["stream"] = True
            if self._stream_usage:
                payload["stream_options"] = {"include_usage": True}
        return payload

    # ── the port ────────────────────────────────────────────────────

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        payload = self._payload(request, stream=False)
        body = await self._post_json(self._url(self._chat_path, payload["model"]), payload)
        choices = body.get("choices") or []
        if not choices:
            raise LlmError("protocol", "The endpoint answered with no choices.")
        message = choices[0].get("message") or {}
        calls = []
        for index, raw in enumerate(message.get("tool_calls") or []):
            fn = raw.get("function") or {}
            arguments, error = _parse_arguments(fn.get("arguments") or "")
            calls.append(ToolCall(
                id=str(raw.get("id") or f"call_{index}"), name=str(fn.get("name") or ""),
                arguments=arguments, raw_arguments=fn.get("arguments") or "", parse_error=error,
            ))
        usage = body.get("usage") or {}
        return CompletionResult(
            text=_text_of(message.get("content")),
            tool_calls=calls,
            usage=Usage(int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)),
            finish_reason=str(choices[0].get("finish_reason") or "stop"),
            model=str(body.get("model") or payload["model"]),
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        if not self._stream:
            result = await self.complete(request)
            if result.text:
                yield TextDelta(result.text)
            if result.tool_calls:
                yield ToolCallsReady(tuple(result.tool_calls))
            yield UsageReport(result.usage, result.model)
            yield Finished(result.finish_reason)
            return
        payload = self._payload(request, stream=True)
        url = self._url(self._chat_path, payload["model"])
        reauthed = False
        attempt = 0
        while True:
            headers, params = await self._prepare()
            headers["Accept"] = "text/event-stream"
            async with self._http.stream("POST", url, json=payload, headers=headers,
                                         params=params) as response:
                status = response.status_code
                if status >= 400:
                    await response.aread()
                    if status in (401, 403) and not reauthed:
                        reauthed = True
                        await self._auth.invalidate()
                        continue
                    if status in _RETRY_STATUSES and attempt < self._max_retries:
                        attempt += 1
                        delay = _backoff(attempt, _retry_after(response.headers))
                    else:
                        raise _status_error(status, _retry_after(response.headers))
                else:
                    async for event in self._read_stream(response, payload["model"]):
                        yield event
                    return
            await asyncio.sleep(delay)

    async def _read_stream(self, response, model: str) -> AsyncIterator[StreamEvent]:
        pending: dict[int, dict[str, str]] = {}
        finish = "stop"
        usage = Usage()
        served_model = model
        saw_any = False
        async for line in response.aiter_lines():
            line = line.strip()
            if not line or line.startswith(":") or not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                continue
            saw_any = True
            if chunk.get("model"):
                served_model = str(chunk["model"])
            if isinstance(chunk.get("usage"), dict):
                u = chunk["usage"]
                usage = Usage(int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0))
            if isinstance(chunk.get("error"), dict):
                raise LlmError("unavailable", "The endpoint reported an error mid-answer.")
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                text = _text_of(delta.get("content"))
                if text:
                    yield TextDelta(text)
                for raw in delta.get("tool_calls") or []:
                    index = int(raw.get("index") or 0)
                    slot = pending.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    if raw.get("id"):
                        slot["id"] = str(raw["id"])
                    fn = raw.get("function") or {}
                    if fn.get("name"):
                        slot["name"] += str(fn["name"])
                    if fn.get("arguments"):
                        slot["arguments"] += str(fn["arguments"])
                if choice.get("finish_reason"):
                    finish = str(choice["finish_reason"])
        if not saw_any:
            raise LlmError("protocol", "The endpoint's stream held no answer.")
        if pending:
            calls = []
            for index in sorted(pending):
                slot = pending[index]
                arguments, error = _parse_arguments(slot["arguments"])
                calls.append(ToolCall(
                    id=slot["id"] or f"call_{index}", name=slot["name"], arguments=arguments,
                    raw_arguments=slot["arguments"], parse_error=error,
                ))
            yield ToolCallsReady(tuple(calls))
        yield UsageReport(usage, served_model)
        yield Finished(finish)

    async def embed(self, texts: list[str], *, dimensions: Optional[int] = None) -> list[list[float]]:
        if not texts:
            return []
        model = self.model_for("embedding")
        payload: dict[str, Any] = {"model": model, "input": texts}
        dims = dimensions or self.capabilities.embedding_dimensions
        if dims:
            payload["dimensions"] = int(dims)
        body = await self._post_json(self._url(self._embeddings_path, model), payload)
        data = body.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise LlmError("protocol", "The embeddings answer does not match what was sent.")
        ordered = sorted(data, key=lambda item: int(item.get("index") or 0))
        vectors = []
        for item in ordered:
            vector = item.get("embedding")
            if not isinstance(vector, list) or not vector:
                raise LlmError("protocol", "An embedding in the answer is empty.")
            vectors.append([float(x) for x in vector])
        return vectors

    async def aclose(self) -> None:
        await self._http.aclose()


def _backoff(attempt: int, retry_after: Optional[float]) -> float:
    if retry_after is not None:
        return retry_after
    return min(8.0, 0.5 * (2 ** (attempt - 1))) * (0.75 + random.random() * 0.5)
