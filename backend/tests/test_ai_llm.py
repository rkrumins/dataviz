"""The AI service's model layer: the OpenAI-compatible adapter, sign-in
strategies, the strict-JSON tool fallback, and the egress guard.

Everything runs against ``httpx.MockTransport`` — nothing leaves the process —
except the egress tests, which resolve real address literals.
"""
from __future__ import annotations

import json
import logging

import httpx
import pytest

from backend.ai_service.llm import egress
from backend.ai_service.llm.auth import build_auth, json_path, render_template
from backend.ai_service.llm.auth.strategies import TokenCache
from backend.ai_service.llm.egress import GuardedClient, check_destination
from backend.ai_service.llm.json_tools import JsonToolProtocol, parse_reply
from backend.ai_service.llm.provider import ConnectionSpec, build_provider
from backend.ai_service.llm.types import (
    ChatMessage, CompletionRequest, Finished, LlmError, TextDelta, ToolCallsReady,
    ToolSpec, UsageReport,
)

PING = ToolSpec("ping", "Answer pong.", {"type": "object", "properties": {"x": {"type": "string"}}})


def _sse(*chunks: dict) -> bytes:
    lines = [f"data: {json.dumps(c)}\n\n" for c in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def _provider(handler, *, auth_type="api_key", auth_config=None, secrets=None, options=None,
              models=None):
    spec = ConnectionSpec(
        id="llm_1", name="test", kind="openai_compatible", base_url="https://llm.example/v1",
        auth_type=auth_type, auth_config=auth_config or {},
        secrets=secrets if secrets is not None else {"apiKey": "sk-test-secret"},
        options=options or {}, models=models or {"chat": "gpt-x", "embedding": "emb-x"},
    )
    return build_provider(spec, allow_hosts=frozenset(), timeout=5,
                          transport=httpx.MockTransport(handler))


async def _collect(provider, request):
    return [event async for event in provider.stream(request)]


# ── The adapter ─────────────────────────────────────────────────────────


async def test_stream_yields_text_then_usage_and_sends_the_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=_sse(
            {"model": "gpt-x-2", "choices": [{"delta": {"content": "Hel"}}]},
            {"choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 2}},
        ), headers={"content-type": "text/event-stream"})

    events = await _collect(_provider(handler), CompletionRequest([ChatMessage("user", "hi")]))
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["Hel", "lo"]
    usage = next(e for e in events if isinstance(e, UsageReport))
    assert (usage.usage.input_tokens, usage.usage.output_tokens, usage.model) == (7, 2, "gpt-x-2")
    assert isinstance(events[-1], Finished)
    assert seen["auth"] == "Bearer sk-test-secret"
    assert seen["body"]["stream"] is True and seen["body"]["model"] == "gpt-x"
    assert seen["body"]["stream_options"] == {"include_usage": True}


async def test_stream_assembles_tool_calls_from_deltas():
    def handler(request):
        return httpx.Response(200, content=_sse(
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "pi", "arguments": "{\"x\""}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "ng", "arguments": ": \"a\"}"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "c2", "function": {"name": "ping", "arguments": "not json"}}]}, "finish_reason": "tool_calls"}]},
        ))

    events = await _collect(_provider(handler), CompletionRequest([ChatMessage("user", "x")], tools=[PING]))
    ready = next(e for e in events if isinstance(e, ToolCallsReady))
    first, second = ready.calls
    assert (first.id, first.name, first.arguments) == ("c1", "ping", {"x": "a"})
    assert second.parse_error and second.arguments == {}


async def test_complete_parses_tool_calls_and_usage():
    def handler(request):
        body = json.loads(request.content)
        assert body["tools"][0]["function"]["name"] == "ping"
        return httpx.Response(200, json={
            "model": "gpt-x",
            "choices": [{"message": {"content": None, "tool_calls": [
                {"id": "c9", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]},
                "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4},
        })

    result = await _provider(handler).complete(CompletionRequest([ChatMessage("user", "x")], tools=[PING]))
    assert result.tool_calls[0].arguments == {"x": "1"}
    assert result.usage.output_tokens == 4


async def test_retries_a_429_honouring_retry_after_then_succeeds(monkeypatch):
    calls = []
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr("backend.ai_service.llm.openai_compatible.asyncio.sleep", fake_sleep)

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "2"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    result = await _provider(handler).complete(CompletionRequest([ChatMessage("user", "x")]))
    assert result.text == "ok" and len(calls) == 2 and sleeps == [2.0]


async def test_a_persistent_401_is_an_auth_error_after_one_reauth():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401, json={"error": "secret-echo sk-test-secret"})

    with pytest.raises(LlmError) as info:
        await _provider(handler).complete(CompletionRequest([ChatMessage("user", "x")]))
    assert info.value.code == "auth"
    assert "sk-test-secret" not in str(info.value)
    assert len(calls) == 2  # the original, and one retry after invalidating


async def test_embeddings_are_returned_in_input_order_with_dimensions():
    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "emb-x" and body["dimensions"] == 3
        return httpx.Response(200, json={"data": [
            {"index": 1, "embedding": [0, 1, 0]}, {"index": 0, "embedding": [1, 0, 0]},
        ]})

    provider = _provider(handler, models={"chat": "c", "embedding": "emb-x", "embeddingDimensions": 3})
    assert await provider.embed(["a", "b"]) == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]


async def test_azure_style_path_template_and_query_params():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("api-key")
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provider = _provider(
        handler, auth_config={"header": "api-key", "prefix": ""},
        options={"chatPath": "/openai/deployments/{model}/chat/completions",
                 "queryParams": {"api-version": "2024-10-21"}},
    )
    await provider.complete(CompletionRequest([ChatMessage("user", "x")]))
    assert seen["url"] == ("https://llm.example/v1/openai/deployments/gpt-x/chat/completions"
                           "?api-version=2024-10-21")
    assert seen["key"] == "sk-test-secret"


async def test_non_streaming_gateway_still_streams_events():
    def handler(request):
        assert "stream" not in json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "whole"}}]})

    events = await _collect(_provider(handler, options={"stream": False}),
                            CompletionRequest([ChatMessage("user", "x")]))
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["whole"]


# ── The strict-JSON tool fallback ───────────────────────────────────────


async def test_json_protocol_turns_a_reply_into_a_tool_call():
    def handler(request):
        body = json.loads(request.content)
        assert "tools" not in body and body["response_format"] == {"type": "json_object"}
        assert "Available tools" in body["messages"][0]["content"]
        return httpx.Response(200, json={"choices": [{"message": {
            "content": "```json\n{\"tool\": \"ping\", \"arguments\": {\"x\": \"y\"}}\n```"}}]})

    provider = _provider(handler, options={"tools": False})
    assert isinstance(provider, JsonToolProtocol)
    result = await provider.complete(CompletionRequest([ChatMessage("user", "x")], tools=[PING]))
    assert result.tool_calls[0].name == "ping" and result.tool_calls[0].arguments == {"x": "y"}


async def test_json_protocol_repairs_then_fails():
    replies = iter(["not json", '{"tool": "nope"}', "still not"])

    def handler(request):
        return httpx.Response(200, json={"choices": [{"message": {"content": next(replies)}}]})

    provider = _provider(handler, options={"tools": False})
    with pytest.raises(LlmError) as info:
        await provider.complete(CompletionRequest([ChatMessage("user", "x")], tools=[PING]))
    assert info.value.code == "protocol"


def test_parse_reply_reads_an_answer():
    assert parse_reply('{"answer": "**hi**"}', {"ping"}) == ("answer", "**hi**")


# ── Sign-in strategies ──────────────────────────────────────────────────


async def test_api_key_in_query_and_basic():
    headers, params = {}, {}
    await build_auth("api_key", {"in": "query", "param": "key"}, {"apiKey": "abc"}, None).apply(headers, params)
    assert params == {"key": "abc"} and headers == {}
    headers = {}
    await build_auth("basic", {"username": "u"}, {"password": "p"}, None).apply(headers, {})
    assert headers["Authorization"] == "Basic dTpw"


async def test_missing_secret_is_not_configured():
    with pytest.raises(LlmError) as info:
        build_auth("bearer", {}, {}, None)
    assert info.value.code == "not_configured"


async def test_token_mint_posts_the_template_caches_and_refreshes_after_401(caplog):
    minted = []

    def handler(request):
        if request.url.path == "/token":
            body = json.loads(request.content)
            minted.append(body)
            return httpx.Response(200, json={"data": {"jwt": f"tok{len(minted)}"}, "ttl": 600})
        if request.headers["x-gw-token"] == "Token tok1":
            return httpx.Response(401)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    caplog.set_level(logging.DEBUG)
    provider = _provider(
        handler, auth_type="token_mint",
        auth_config={
            "tokenUrl": "https://llm.example/token", "bodyFormat": "json",
            "body": {"user": "{{username}}", "pass": "{{password}}", "app": "dataviz"},
            "username": "svc-ai", "tokenPath": "data.jwt", "expiresPath": "ttl",
            "tokenHeader": "x-gw-token", "tokenPrefix": "Token",
        },
        secrets={"password": "hunter2-very-secret"},
    )
    result = await provider.complete(CompletionRequest([ChatMessage("user", "x")]))
    assert result.text == "ok"
    assert minted == [{"user": "svc-ai", "pass": "hunter2-very-secret", "app": "dataviz"}] * 2
    assert "hunter2-very-secret" not in caplog.text


async def test_oauth_client_credentials_uses_basic_client_auth():
    seen = {}

    def handler(request):
        if request.url.path == "/oauth/token":
            seen["auth"] = request.headers.get("authorization")
            seen["form"] = request.content.decode()
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        seen["bearer"] = request.headers.get("authorization")
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provider = _provider(
        handler, auth_type="oauth2_client_credentials",
        auth_config={"tokenUrl": "https://llm.example/oauth/token", "clientId": "cid", "scope": "llm"},
        secrets={"clientSecret": "cs"},
    )
    await provider.complete(CompletionRequest([ChatMessage("user", "x")]))
    assert seen["auth"].startswith("Basic ")
    assert "grant_type=client_credentials" in seen["form"] and "scope=llm" in seen["form"]
    assert seen["bearer"] == "Bearer at"


async def test_token_cache_single_flight_and_refresh_window():
    clock = [0.0]
    mints = []

    async def mint():
        mints.append(1)
        return f"t{len(mints)}", 100.0

    cache = TokenCache(mint, now=lambda: clock[0])
    assert await cache.get() == "t1"
    clock[0] = 79
    assert await cache.get() == "t1"
    clock[0] = 81  # past 80% of its life
    assert await cache.get() == "t2"
    cache.invalidate()
    assert await cache.get() == "t3"


def test_json_path_and_templates():
    doc = {"a": {"b": [{"c": "x"}]}}
    assert json_path(doc, "a.b[0].c") == "x"
    assert json_path(doc, "a.missing") is None
    assert render_template({"k": "{{n}}", "s": "id={{n}}"}, {"n": 5}) == {"k": 5, "s": "id=5"}


# ── Egress ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("url,reason", [
    ("http://169.254.169.254/latest/meta-data/", "non-routable"),
    ("http://[::ffff:169.254.169.254]/", "non-routable"),
    ("http://127.0.0.1:6379/", "non-routable"),
    ("http://10.1.2.3/v1", "AI_EGRESS_ALLOWED_HOSTS"),
    ("ftp://example.com/", "cannot be called"),
])
def test_egress_refuses(url, reason):
    with pytest.raises(LlmError) as info:
        check_destination(url, frozenset())
    assert info.value.code == "refused_destination"
    assert reason in str(info.value)


def test_egress_allowlist_unlocks_a_private_host_but_never_metadata():
    check_destination("https://10.1.2.3/v1", frozenset({"10.1.2.3:443"}))
    with pytest.raises(LlmError):
        check_destination("http://169.254.169.254/", frozenset({"169.254.169.254:80"}))


def test_egress_refuses_plain_http_in_production(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    with pytest.raises(LlmError):
        check_destination("http://93.184.216.34/v1", frozenset())


async def test_guarded_client_never_follows_redirects():
    def handler(request):
        return httpx.Response(302, headers={"location": "http://169.254.169.254/"})

    client = GuardedClient(transport=httpx.MockTransport(handler))
    response = await client.request("GET", "https://llm.example/v1")
    assert response.status_code == 302
    await client.aclose()


def test_egress_module_names_its_ca_env():
    assert egress.CA_BUNDLE_ENV == "AI_OUTBOUND_TLS_CA_CERTS"
