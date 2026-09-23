"""A request body has an upper bound before anything parses it.

There was no application-level limit. The only bound was nginx's
``client_max_body_size 100m`` — an edge setting, which (a) a caller
reaching the container directly never meets, and (b) is deliberately
generous because bulk import needs it. Every JSON endpoint therefore
accepted 100 MB and handed it to Pydantic, which parses into memory
before a handler runs. The unbounded-array bodies are the sharp edge:
``graph/save`` takes ``nodes`` and ``edges`` lists with no
``max_length``.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient


async def test_an_oversized_body_is_refused_with_413(
    test_client: AsyncClient, monkeypatch,
):
    from backend.app.main import app, _BodySizeLimitMiddleware

    # Find the installed instance rather than re-registering one: the
    # stack is built at import time and adding another would test a
    # different object than production runs.
    caps = [
        mw for mw in app.user_middleware
        if mw.cls is _BodySizeLimitMiddleware
    ]
    assert caps, "the body-size middleware is not installed"

    huge = "x" * 1000
    resp = await test_client.post(
        "/api/v1/admin/providers",
        content=huge,
        headers={
            "Content-Type": "application/json",
            # Lie about the size — the check is on the declared length,
            # which is the cheap shape to refuse.
            "Content-Length": str(64 * 1024 * 1024),
        },
    )
    assert resp.status_code == 413, resp.text
    assert "limit" in resp.json()["detail"]


async def test_an_ordinary_body_passes(test_client: AsyncClient):
    resp = await test_client.post("/api/v1/admin/providers", json={})
    assert resp.status_code != 413


async def test_a_malformed_content_length_is_refused(
    test_client: AsyncClient,
):
    resp = await test_client.post(
        "/api/v1/admin/providers",
        content=b"{}",
        headers={"Content-Type": "application/json",
                 "Content-Length": "not-a-number"},
    )
    # httpx may normalise the header; either the middleware rejects it
    # or the transport does, but it must not reach a handler as valid.
    assert resp.status_code in (400, 413, 422), resp.text


def test_import_routes_get_the_larger_cap():
    """Raising the global cap to suit bulk import would give every
    endpoint a 100 MB budget it never asked for."""
    from backend.app.main import _BodySizeLimitMiddleware

    mw = _BodySizeLimitMiddleware(
        app=None, default_bytes=1_000, large_bytes=100_000,
    )
    assert mw._cap_for("/api/v1/admin/providers") == 1_000
    assert mw._cap_for("/api/v1/ws_1/graph/save") == 100_000
    assert mw._cap_for("/api/v1/versioning/graphs/g1/commit") == 100_000
    # The versioning router is mounted per workspace, so the real bulk
    # import path carries a workspace segment the prefix has to see past.
    assert mw._cap_for("/api/v1/ws_1/versioning/graphs/g1/imports") == 100_000
    assert mw._cap_for("/api/v1/views/transfer/packages/inspect") == 100_000
    assert mw._cap_for("/api/v1/views/transfer/inspect") == 1_000


@pytest.mark.parametrize("path", [
    "/api/v1/ws_1/versioning/graphs/g1/imports",
    "/api/v1/views/transfer/packages/inspect",
])
async def test_upload_routes_take_up_to_100_mib(csrf_client: AsyncClient, path):
    """The installed stack lets a 100 MiB upload through to the route and
    still refuses a byte more. Sent without a CSRF token, so what answers
    a body under the cap is the CSRF check behind the size check, before
    anything reads the body or opens a database."""
    headers = {"Content-Type": "application/octet-stream"}
    cap = 100 * 1024 * 1024

    under = await csrf_client.post(
        path, content=b"x", headers={**headers, "Content-Length": str(cap)},
    )
    assert under.status_code != 413, under.text
    over = await csrf_client.post(
        path, content=b"x", headers={**headers, "Content-Length": str(cap + 1)},
    )
    assert over.status_code == 413, over.text
