"""
Global exception handlers — every error reaches the client as JSON.

Why this exists: the app registers targeted handlers (OperationalError→503,
provider errors, rate-limit) but historically had NO catch-all. Any exception
whose type wasn't in that list fell through to Starlette's default
``PlainTextResponse("Internal Server Error", 500)`` — a non-JSON body that the
admin Features page's fetch client could not parse, surfacing as a confusing
"response body" toast on every failed toggle. The handlers in ``main.py`` close
that gap: SQLAlchemyError→503 JSON (covering the pool-timeout / DBAPIError /
IntegrityError subclasses the OperationalError handler misses) and a final
Exception→500 JSON safety net.

The contract tests replicate that exact handler wiring in isolation (no DB /
full-app import needed, so a failure pinpoints the contract rather than the
framework around it — same philosophy as test_timeout_middleware.py). The
last test additionally asserts the REAL main.py handlers are registered, and
skips cleanly when the full app can't be imported.
"""
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.testclient import TestClient
from sqlalchemy.exc import (
    OperationalError as SAOperationalError,
    SQLAlchemyError,
    TimeoutError as SATimeoutError,
    IntegrityError,
)


class _Noop(BaseHTTPMiddleware):
    """Mirrors the real app's BaseHTTPMiddleware layers (CSRF/Timeout) that sit
    OUTSIDE the exception middleware, to prove the typed handlers still fire."""

    async def dispatch(self, request, call_next):
        return await call_next(request)


def _app_with_handlers() -> FastAPI:
    app = FastAPI()
    app.add_middleware(_Noop)

    # --- the exact handler block from app/main.py ---
    @app.exception_handler(SAOperationalError)
    async def _op(_request, _exc):
        return JSONResponse(status_code=503, content={"detail": "Management database is temporarily unavailable. Please try again."})

    @app.exception_handler(SQLAlchemyError)
    async def _db(_request, _exc):
        return JSONResponse(status_code=503, content={"detail": "Database is temporarily unavailable. Please try again."})

    @app.exception_handler(Exception)
    async def _unhandled(_request, _exc):
        return JSONResponse(status_code=500, content={"detail": "Internal server error. Please try again."})

    @app.patch("/runtime")
    async def _r_runtime():
        raise RuntimeError("boom")

    @app.patch("/pool")
    async def _r_pool():
        raise SATimeoutError("QueuePool limit reached")

    @app.patch("/integrity")
    async def _r_integrity():
        raise IntegrityError("INSERT ...", {}, Exception("dup key"))

    @app.patch("/operational")
    async def _r_op():
        raise SAOperationalError("SELECT 1", {}, Exception("conn lost"))

    @app.patch("/http400")
    async def _r_http():
        raise HTTPException(status_code=400, detail="bad input")

    return app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(_app_with_handlers(), raise_server_exceptions=False)


def _assert_json(resp, status: int):
    assert resp.status_code == status
    assert resp.headers.get("content-type", "").startswith("application/json")
    return resp.json()


def test_unhandled_exception_becomes_json_500(client):
    body = _assert_json(client.patch("/runtime"), 500)
    assert "detail" in body  # never a bare text/plain "Internal Server Error"


def test_pool_timeout_becomes_json_503(client):
    # sqlalchemy.exc.TimeoutError subclasses SQLAlchemyError, NOT OperationalError.
    body = _assert_json(client.patch("/pool"), 503)
    assert "temporarily unavailable" in body["detail"].lower()


def test_integrity_error_becomes_json_503(client):
    body = _assert_json(client.patch("/integrity"), 503)
    assert "temporarily unavailable" in body["detail"].lower()


def test_operational_error_keeps_its_specific_handler(client):
    # More-specific handler must win over the broader SQLAlchemyError one.
    body = _assert_json(client.patch("/operational"), 503)
    assert "management database" in body["detail"].lower()


def test_http_exception_is_untouched(client):
    body = _assert_json(client.patch("/http400"), 400)
    assert body["detail"] == "bad input"


async def test_real_main_app_registers_the_handlers():
    """Regression guard against the handlers being removed from main.py.
    Skips when the full app (heavy system deps) can't be imported."""
    main = pytest.importorskip("backend.app.main")
    assert Exception in main.app.exception_handlers
    assert SQLAlchemyError in main.app.exception_handlers

    # The real catch-all returns structured JSON, not text/plain.
    resp = await main._unhandled_exception_handler(None, RuntimeError("boom"))
    assert resp.status_code == 500
    assert "detail" in json.loads(bytes(resp.body))

    resp = await main._db_error_handler(None, IntegrityError("x", {}, Exception("d")))
    assert resp.status_code == 503
    assert "detail" in json.loads(bytes(resp.body))
