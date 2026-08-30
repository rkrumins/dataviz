"""``http_json_preflight`` — pure unit tests against ``httpx.MockTransport``,
no real network. Vocabulary for PR 3's ArcadeDB provider (``GET
/api/v1/ready``); nothing in this PR calls it yet, so this file is its only
proof it behaves as documented before a real consumer arrives.
"""
from __future__ import annotations

import sys

import httpx
import pytest

from backend.common.interfaces.preflight import http_json_preflight

_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock_client(handler):
    """Swap the helper's client for one wired to a MockTransport, preserving
    the kwargs the helper passes (timeout, redirects off)."""
    def _make(**kwargs):
        return _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kwargs)
    return _make


@pytest.mark.asyncio
async def test_matching_status_is_success(monkeypatch):
    def handler(request):
        assert request.method == "GET"
        return httpx.Response(200, json={"ready": True})

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    res = await http_json_preflight("http://arcadedb.local/api/v1/ready", deadline_s=1.0)
    assert res.ok is True
    assert res.reason == "ok"


@pytest.mark.asyncio
async def test_custom_expect_status(monkeypatch):
    def handler(request):
        return httpx.Response(204)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    res = await http_json_preflight(
        "http://arcadedb.local/api/v1/ready", deadline_s=1.0, expect_status=204,
    )
    assert res.ok is True


@pytest.mark.asyncio
async def test_401_without_credentials_is_auth_required(monkeypatch):
    def handler(request):
        assert "authorization" not in request.headers
        return httpx.Response(401)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    res = await http_json_preflight("http://arcadedb.local/api/v1/ready", deadline_s=1.0)
    assert res.ok is False
    assert res.reason == "auth_required"


@pytest.mark.asyncio
async def test_401_with_credentials_is_auth_failed(monkeypatch):
    def handler(request):
        assert request.headers["authorization"] == "Bearer wrong-token"
        return httpx.Response(401)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    res = await http_json_preflight(
        "http://arcadedb.local/api/v1/ready", deadline_s=1.0,
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert res.ok is False
    assert res.reason == "auth_failed"


@pytest.mark.asyncio
async def test_unexpected_status_is_http_status_nnn(monkeypatch):
    def handler(request):
        return httpx.Response(503)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    res = await http_json_preflight("http://arcadedb.local/api/v1/ready", deadline_s=1.0)
    assert res.ok is False
    assert res.reason == "http_status_503"


@pytest.mark.asyncio
async def test_without_httpx_installed(monkeypatch):
    monkeypatch.setitem(sys.modules, "httpx", None)
    res = await http_json_preflight("http://arcadedb.local/api/v1/ready", deadline_s=1.0)
    assert res.ok is False
    assert res.reason == "httpx_not_installed"
