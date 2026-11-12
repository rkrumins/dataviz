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
    from backend.app.services.versioning.import_export import uploads

    mw = _BodySizeLimitMiddleware(
        app=None, default_bytes=1_000, large_bytes=100_000,
    )
    assert mw._cap_for("/api/v1/admin/providers") == 1_000
    assert mw._cap_for("/api/v1/ws_1/graph/save") == 100_000
    assert mw._cap_for("/api/v1/versioning/graphs/g1/commit") == 100_000
    # An import's file, whole or as a run of an upload's parts, may be as
    # large as one import can be — but a JSON or Excel file sent whole is
    # read whole, and stays at its own cap. The versioning router is
    # mounted per workspace, so the real paths carry a workspace segment.
    assert mw._cap_for("/api/v1/ws_1/versioning/graphs/g1/imports") == uploads.MAX_BYTES
    assert mw._cap_for("/api/v1/ws_1/versioning/graphs/g1/imports", "csv") == uploads.MAX_BYTES
    for fmt in ("json", "xlsx"):
        assert mw._cap_for("/api/v1/ws_1/versioning/graphs/g1/imports", fmt) == uploads.WHOLE_FILE_MAX_BYTES
    assert mw._cap_for("/api/v1/ws_1/versioning/graphs/g1/imports/uploads/iu_1/parts/0") == uploads.MAX_BYTES
    # So may the file itself, sent as the body that starts an upload. Its JSON description is a few
    # hundred bytes, and completing an upload is an ordinary request.
    start = "/api/v1/ws_1/versioning/graphs/g1/imports/uploads"
    assert mw._cap_for(start, "ndjson", "application/octet-stream") == uploads.MAX_BYTES
    assert mw._cap_for(start, "csv", "text/csv") == uploads.MAX_BYTES
    for described in ("application/json", "application/json; charset=utf-8", None):
        assert mw._cap_for(start, "ndjson", described) == uploads.DESCRIPTION_MAX_BYTES
    assert mw._cap_for("/api/v1/ws_1/versioning/graphs/g1/imports/uploads/iu_1/complete") == 100_000
    assert mw._cap_for("/api/v1/views/transfer/packages/inspect") == 100_000
    # A view file is up to 64 MB, and its designs travel on to reconcile and import.
    for route in ("inspect", "reconcile", "import"):
        assert mw._cap_for(f"/api/v1/views/transfer/{route}") == 100_000
    assert mw._cap_for("/api/v1/views/transfer/export") == 1_000, "a list of view ids is small"


@pytest.mark.parametrize("path", [
    "/api/v1/views/transfer/inspect",
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


@pytest.mark.parametrize("path, cap", [
    ("/api/v1/ws_1/versioning/graphs/g1/imports", "MAX_BYTES"),
    ("/api/v1/ws_1/versioning/graphs/g1/imports/uploads/iu_1/parts/0", "MAX_BYTES"),
])
async def test_an_imports_file_may_come_in_one_request(csrf_client: AsyncClient, path, cap):
    """A client that sends one large file — to ``…/imports``, or whole to
    an upload's part 0 — gets it through, up to the most one import can
    be (10 GiB), and not a byte more. The route itself holds it to its own
    exact bound as it streams it."""
    from backend.app.services.versioning.import_export import uploads

    headers = {"Content-Type": "application/octet-stream"}
    limit = getattr(uploads, cap)
    send = csrf_client.put if "/parts/" in path else csrf_client.post
    for size in (4 * 1024 ** 3, limit):
        under = await send(path, content=b"x", headers={**headers, "Content-Length": str(size)})
        assert under.status_code != 413, under.text
    over = await send(path, content=b"x", headers={**headers, "Content-Length": str(limit + 1)})
    assert over.status_code == 413, over.text


@pytest.mark.parametrize("fmt, size, says", [
    ("json", 100 * 1024 * 1024 + 1, "A JSON file is read whole"),
    ("json", 100 * 1024 * 1024 + 1, "NDJSON or CSV"),
    ("xlsx", 100 * 1024 * 1024 + 1, "An Excel file is read whole"),
    ("xlsx", 100 * 1024 * 1024 + 1, "NDJSON or CSV"),
    ("ndjson", 10 * 1024 ** 3 + 1, "at most 10 GB"),
])
async def test_an_import_sent_whole_past_the_cap_is_told_how_to_send_it(
    csrf_client: AsyncClient, fmt, size, says,
):
    """A script that posts a whole file to ``…/imports`` past the cap was
    told only the byte limit. A file read whole (JSON, Excel) has to become
    NDJSON or CSV to be any larger; any other is split into several."""
    resp = await csrf_client.post(
        "/api/v1/ws_1/versioning/graphs/g1/imports", params={"format": fmt}, content=b"x",
        headers={"Content-Type": "application/octet-stream",
                 "Content-Length": str(size)},
    )
    assert resp.status_code == 413, resp.text
    assert says in resp.json()["detail"], resp.json()["detail"]



_UPLOAD_START = "/api/v1/ws_1/versioning/graphs/g1/imports/uploads"


async def test_a_file_may_be_the_body_that_starts_an_upload(csrf_client: AsyncClient):
    """A client that puts the file itself in the body that starts an upload gets it through, up to
    the most one import can be, and not a byte more."""
    from backend.app.services.versioning.import_export import uploads

    for size in (4 * 1024 ** 3, uploads.MAX_BYTES):
        under = await csrf_client.post(_UPLOAD_START, content=b"x",
                                       headers={"Content-Type": "application/octet-stream",
                                                "Content-Length": str(size)})
        assert under.status_code != 413, under.text
    over = await csrf_client.post(_UPLOAD_START, content=b"x",
                                  headers={"Content-Type": "application/octet-stream",
                                           "Content-Length": str(uploads.MAX_BYTES + 1)})
    assert over.status_code == 413 and "at most 10 GB" in over.json()["detail"], over.text


async def test_a_large_body_sent_as_json_to_start_an_upload_is_told_how_to_send_the_file(
    csrf_client: AsyncClient,
):
    """A JSON body there is the upload's description: one larger than a description can be is a
    file sent as JSON, and is told, before any of it is read, how to send the file itself."""
    from backend.app.services.versioning.import_export import uploads

    resp = await csrf_client.post(_UPLOAD_START, content=b"x",
                                  headers={"Content-Type": "application/json",
                                           "Content-Length": str(uploads.DESCRIPTION_MAX_BYTES + 1)})
    assert resp.status_code == 413, resp.text
    assert "application/octet-stream" in resp.json()["detail"]


@pytest.mark.parametrize("headers", [
    {"Content-Type": "application/json"},
    {"Content-Type": "application/json; charset=utf-8"},
    {},  # read as JSON, as FastAPI reads a body with no type
])
async def test_an_uploads_description_passes(csrf_client: AsyncClient, headers):
    """The description itself goes on: what answers it here is the CSRF check behind this one."""
    resp = await csrf_client.post(_UPLOAD_START, content=b'{"fileName": "a.ndjson", "size": 10}',
                                  headers=headers)
    assert resp.status_code != 413, resp.text
