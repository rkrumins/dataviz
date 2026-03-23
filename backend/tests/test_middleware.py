"""
Unit tests for backend.app.middleware (request_id, security_headers, logging).

Tests use a minimal FastAPI app with middleware applied directly,
avoiding the full application stack.
"""
import logging
from typing import Optional

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient
from starlette.responses import PlainTextResponse

from backend.app.middleware.request_id import RequestIdMiddleware, get_request_id, REQUEST_ID_HEADER
from backend.app.middleware.security_headers import SecurityHeadersMiddleware
from backend.app.middleware.logging import StructuredLoggingMiddleware


# ---------------------------------------------------------------------------
# Minimal test app factory
# ---------------------------------------------------------------------------


def _create_test_app(
    include_request_id: bool = True,
    include_security_headers: bool = True,
    include_logging: bool = True,
) -> FastAPI:
    """Create a minimal FastAPI app with selected middleware for isolated tests."""
    app = FastAPI()

    # Middleware is applied in reverse order — last added runs first
    if include_logging:
        app.add_middleware(StructuredLoggingMiddleware)
    if include_security_headers:
        app.add_middleware(SecurityHeadersMiddleware)
    if include_request_id:
        app.add_middleware(RequestIdMiddleware)

    @app.get("/test")
    async def test_endpoint():
        return PlainTextResponse("ok")

    @app.get("/test/request-id")
    async def test_request_id_endpoint(request: Request):
        req_id = get_request_id(request)
        return PlainTextResponse(req_id)

    @app.get("/docs")
    async def docs_endpoint():
        return PlainTextResponse("swagger ui")

    return app


async def _make_client(app: FastAPI) -> AsyncClient:
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    return AsyncClient(transport=transport, base_url="http://testserver")


# ---------------------------------------------------------------------------
# Tests — RequestIdMiddleware
# ---------------------------------------------------------------------------


class TestRequestIdMiddleware:

    async def test_generates_request_id_when_not_provided(self):
        """If no X-Request-ID header sent, one is generated."""
        app = _create_test_app(include_security_headers=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        assert response.status_code == 200
        req_id = response.headers.get(REQUEST_ID_HEADER)
        assert req_id is not None
        assert req_id.startswith("req_")

    async def test_propagates_client_provided_id(self):
        """If client sends X-Request-ID, it is echoed back."""
        app = _create_test_app(include_security_headers=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get(
                "/test",
                headers={REQUEST_ID_HEADER: "my-custom-id-123"},
            )

        assert response.headers[REQUEST_ID_HEADER] == "my-custom-id-123"

    async def test_request_id_accessible_via_dependency(self):
        """get_request_id dependency returns the correct ID."""
        app = _create_test_app(include_security_headers=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get(
                "/test/request-id",
                headers={REQUEST_ID_HEADER: "dep-test-id"},
            )

        assert response.text == "dep-test-id"

    async def test_generated_ids_are_unique(self):
        """Each request gets a unique generated ID."""
        app = _create_test_app(include_security_headers=False, include_logging=False)
        ids = []
        async with await _make_client(app) as client:
            for _ in range(5):
                response = await client.get("/test")
                ids.append(response.headers[REQUEST_ID_HEADER])

        assert len(set(ids)) == 5  # all unique


# ---------------------------------------------------------------------------
# Tests — SecurityHeadersMiddleware
# ---------------------------------------------------------------------------


class TestSecurityHeadersMiddleware:

    async def test_standard_security_headers_present(self):
        """Standard security headers are set on non-docs endpoints."""
        app = _create_test_app(include_request_id=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["X-XSS-Protection"] == "0"
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "camera=()" in response.headers["Permissions-Policy"]
        assert "Content-Security-Policy" in response.headers

    async def test_csp_for_non_docs_path(self):
        """Non-docs paths get a restrictive CSP."""
        app = _create_test_app(include_request_id=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        csp = response.headers["Content-Security-Policy"]
        assert "cdn.jsdelivr.net" not in csp
        assert "default-src 'self'" in csp

    async def test_csp_for_docs_path_allows_cdn(self):
        """Docs paths get a CSP that allows cdn.jsdelivr.net for Swagger UI."""
        app = _create_test_app(include_request_id=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get("/docs")

        csp = response.headers["Content-Security-Policy"]
        assert "cdn.jsdelivr.net" in csp

    async def test_hsts_not_set_for_http(self):
        """HSTS is NOT set when request is plain HTTP."""
        app = _create_test_app(include_request_id=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        assert "Strict-Transport-Security" not in response.headers

    async def test_hsts_set_for_https_via_forwarded_proto(self):
        """HSTS IS set when X-Forwarded-Proto: https."""
        app = _create_test_app(include_request_id=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get(
                "/test",
                headers={"X-Forwarded-Proto": "https"},
            )

        assert "Strict-Transport-Security" in response.headers
        assert "max-age=31536000" in response.headers["Strict-Transport-Security"]

    async def test_frame_ancestors_none(self):
        """frame-ancestors 'none' prevents clickjacking."""
        app = _create_test_app(include_request_id=False, include_logging=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]


# ---------------------------------------------------------------------------
# Tests — StructuredLoggingMiddleware
# ---------------------------------------------------------------------------


class TestStructuredLoggingMiddleware:

    async def test_process_time_header_set(self):
        """X-Process-Time header is set on every response."""
        app = _create_test_app(include_request_id=False, include_security_headers=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        assert "X-Process-Time" in response.headers
        assert response.headers["X-Process-Time"].endswith("ms")

    async def test_process_time_is_numeric(self):
        """X-Process-Time value is a valid number followed by 'ms'."""
        app = _create_test_app(include_request_id=False, include_security_headers=False)
        async with await _make_client(app) as client:
            response = await client.get("/test")

        time_str = response.headers["X-Process-Time"].replace("ms", "")
        assert float(time_str) >= 0

    async def test_logging_emits_access_log(self, caplog):
        """Structured logging middleware emits a log record."""
        app = _create_test_app(include_security_headers=False)
        with caplog.at_level(logging.INFO, logger="synodic.access"):
            async with await _make_client(app) as client:
                response = await client.get("/test")

        # Find the access log record
        access_records = [r for r in caplog.records if r.name == "synodic.access"]
        assert len(access_records) >= 1

        record = access_records[0]
        assert record.method == "GET"
        assert record.path == "/test"
        assert record.status == 200

    async def test_logging_captures_request_id(self, caplog):
        """When request_id middleware is active, log records include requestId."""
        app = _create_test_app(include_security_headers=False)
        with caplog.at_level(logging.INFO, logger="synodic.access"):
            async with await _make_client(app) as client:
                response = await client.get(
                    "/test",
                    headers={REQUEST_ID_HEADER: "log-test-id"},
                )

        access_records = [r for r in caplog.records if r.name == "synodic.access"]
        assert len(access_records) >= 1
        assert access_records[0].requestId == "log-test-id"

    async def test_logging_captures_connection_id_query_param(self, caplog):
        """connectionId query param is captured in log context."""
        app = _create_test_app(include_security_headers=False)
        with caplog.at_level(logging.INFO, logger="synodic.access"):
            async with await _make_client(app) as client:
                response = await client.get("/test?connectionId=conn_123")

        access_records = [r for r in caplog.records if r.name == "synodic.access"]
        assert len(access_records) >= 1
        assert access_records[0].connectionId == "conn_123"

    async def test_logging_without_connection_id(self, caplog):
        """connectionId is None when not in query params."""
        app = _create_test_app(include_security_headers=False)
        with caplog.at_level(logging.INFO, logger="synodic.access"):
            async with await _make_client(app) as client:
                response = await client.get("/test")

        access_records = [r for r in caplog.records if r.name == "synodic.access"]
        assert len(access_records) >= 1
        assert access_records[0].connectionId is None


# ---------------------------------------------------------------------------
# Tests — All middleware combined
# ---------------------------------------------------------------------------


class TestMiddlewareCombined:

    async def test_all_middleware_work_together(self):
        """All three middlewares cooperate without conflict."""
        app = _create_test_app()
        async with await _make_client(app) as client:
            response = await client.get("/test")

        assert response.status_code == 200
        # Request ID
        assert REQUEST_ID_HEADER in response.headers
        # Security headers
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        # Logging
        assert "X-Process-Time" in response.headers

    async def test_combined_with_client_request_id(self, caplog):
        """Client-provided request ID flows through all middleware layers."""
        app = _create_test_app()
        with caplog.at_level(logging.INFO, logger="synodic.access"):
            async with await _make_client(app) as client:
                response = await client.get(
                    "/test",
                    headers={REQUEST_ID_HEADER: "combined-test"},
                )

        assert response.headers[REQUEST_ID_HEADER] == "combined-test"
