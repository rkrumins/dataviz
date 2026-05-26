"""Tests for ``GET /search/schema``.

These tests verify the JSON-DSL-as-source-of-truth contract from the
FE/agent side: the served schema must list every predicate discriminator
the model defines, carry the current ``X-Schema-Version`` header, and
support conditional GET via ETag so clients can cache it across a
release.

The endpoint handler is tested directly (no TestClient) to match the
project's existing test style (see ``test_http_caching.py``,
``test_timeout_middleware.py``).
"""
from __future__ import annotations

import json

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from backend.app.api.v1.endpoints.graph import (
    _get_search_schema,
    search_schema,
)
from backend.common.models.search import SCHEMA_VERSION


# Every predicate ``kind`` the model defines today. The FE, the JSON
# editor, AI agents — anything binding to the schema — must see all of
# these. If a new predicate is added, this list updates and the test
# enforces that the new kind made it into the served schema.
EXPECTED_DISCRIMINATORS: set[str] = {
    "text", "property", "tag", "hasProperty",
    "entityType", "layer", "descendantOf", "withinHops",
    "degree", "isOrphan", "isLeaf", "isRoot",
    "hasIncoming", "hasOutgoing", "path", "group",
    "edgeProperty", "edgeHasProperty", "edgeGroup",
}


def _collect_discriminators(schema: dict) -> set[str]:
    """Walk ``$defs`` and collect every ``properties.kind.const`` value."""
    found = set()
    defs = schema.get("$defs", {}) or schema.get("definitions", {}) or {}
    for body in defs.values():
        kind = (body.get("properties", {}) or {}).get("kind", {}) or {}
        const = kind.get("const")
        if const:
            found.add(const)
    return found


def _make_request(headers: dict[str, str] | None = None) -> Request:
    """Build a minimal Starlette Request for the handler.

    The handler reads exactly one header (``if-none-match``); everything
    else on the scope is irrelevant. Keep this helper here rather than a
    conftest fixture because no other test currently needs it.
    """
    raw_headers: list[tuple[bytes, bytes]] = []
    if headers:
        for k, v in headers.items():
            raw_headers.append((k.lower().encode(), v.encode()))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/search/schema",
        "headers": raw_headers,
        "query_string": b"",
    }
    return Request(scope)


def test_schema_lists_every_discriminator() -> None:
    """The served schema must include every predicate ``kind`` the model
    declares. Anything binding to the schema (FE codegen, AI agents,
    Ajv validation) depends on this list being complete."""
    schema, _ = _get_search_schema()
    found = _collect_discriminators(schema)
    missing = EXPECTED_DISCRIMINATORS - found
    extra = found - EXPECTED_DISCRIMINATORS
    assert not missing, f"discriminators missing from schema: {missing}"
    # ``extra`` is informational rather than a failure — if a new
    # predicate kind is added, this test should be updated.
    if extra:
        pytest.fail(
            f"schema has discriminators not in EXPECTED_DISCRIMINATORS — "
            f"add them to the test: {extra}",
        )


def test_schema_carries_version_field() -> None:
    """``$schemaVersion`` must appear on SearchQuery so clients can fail
    loud on a mismatch instead of silently sending the wrong shape."""
    schema, _ = _get_search_schema()
    props = schema.get("properties", {})
    assert "$schemaVersion" in props, (
        "SearchQuery JSON Schema is missing $schemaVersion — clients "
        "won't be able to detect version mismatches"
    )
    # ``Literal["1"]`` serialises as a const, an enum, or both.
    version_prop = props["$schemaVersion"]
    serialised = version_prop.get("const") or version_prop.get("enum") or []
    if isinstance(serialised, list):
        assert SCHEMA_VERSION in serialised
    else:
        assert serialised == SCHEMA_VERSION


def test_schema_cache_is_stable() -> None:
    """``_get_search_schema`` must return the same ETag across calls.
    The schema is static within a release; recomputing it on every
    request would be wasted CPU."""
    _, etag1 = _get_search_schema()
    _, etag2 = _get_search_schema()
    assert etag1 == etag2
    assert etag1.startswith('W/"') and etag1.endswith('"')


def test_schema_is_valid_json_schema_shape() -> None:
    """Sanity: the served schema must be JSON-serialisable (no Pydantic
    objects leaking through) and shaped like a JSON Schema document."""
    schema, _ = _get_search_schema()
    # Round-trip through json to catch any non-serialisable values.
    serialised = json.dumps(schema)
    reloaded = json.loads(serialised)
    assert reloaded == schema
    # Top-level shape.
    assert reloaded.get("type") == "object"
    assert "properties" in reloaded
    assert "predicate" in reloaded["properties"]


@pytest.mark.asyncio
async def test_handler_returns_schema_with_correct_headers() -> None:
    """Calling the handler with no ``If-None-Match`` returns the full
    schema body, the current ``X-Schema-Version`` header, and a
    ``Cache-Control`` permitting client-side caching."""
    resp = await search_schema(_make_request())
    assert isinstance(resp, JSONResponse)
    assert resp.status_code == 200
    assert resp.headers["X-Schema-Version"] == SCHEMA_VERSION
    assert "ETag" in resp.headers
    assert resp.headers["ETag"].startswith('W/"')
    assert "max-age" in resp.headers.get("Cache-Control", "")
    body = json.loads(resp.body.decode())
    assert _collect_discriminators(body) >= EXPECTED_DISCRIMINATORS


@pytest.mark.asyncio
async def test_handler_returns_304_on_matching_etag() -> None:
    """Conditional-GET round-trip: a client that sends the served ETag
    back as ``If-None-Match`` gets a 304 with the same version header
    and an empty body. This is what lets the schema be effectively free
    to fetch on every FE boot."""
    _, etag = _get_search_schema()
    resp = await search_schema(_make_request({"if-none-match": etag}))
    assert isinstance(resp, Response)
    assert resp.status_code == 304
    assert resp.headers["X-Schema-Version"] == SCHEMA_VERSION
    assert resp.headers["ETag"] == etag
    # 304 responses must not carry a body (RFC 9110 §15.4.5).
    assert resp.body in (b"", None)
