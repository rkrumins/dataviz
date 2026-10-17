"""
Structured JSON request logging middleware.
Replaces ad-hoc print statements with machine-parseable log records.
"""
import logging
import time

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from backend.app.services import api_key_usage

logger = logging.getLogger("synodic.access")


class StructuredLoggingMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        start = time.perf_counter()
        status_code = 500  # what a request that raised is answered with
        try:
            response = await call_next(request)
            status_code = response.status_code
        finally:
            # A key's usage counts every request it made — refused, failed
            # or raised included (``api_key_id`` is only ever a key the
            # platform knows).
            api_key_usage.record_request(request, status_code)
        duration_ms = round((time.perf_counter() - start) * 1000, 2)

        req_id = getattr(request.state, "request_id", "unknown")
        connection_id = request.query_params.get("connectionId")

        fields = {
            "requestId": req_id,
            "connectionId": connection_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": duration_ms,
        }
        if getattr(request.state, "auth_method", None) == "api_key":
            fields.update(_api_key_fields(request, response))
        logger.info("request", extra=fields)
        response.headers["X-Process-Time"] = f"{duration_ms}ms"
        return response


def _api_key_fields(request: Request, response: Response) -> dict:
    """A request made with an API key: which key, as whom — for the access
    log — and the headers a key's client reads.

    ``X-API-Key-Expires-At`` lets a client see its key's expiry coming.
    ``WWW-Authenticate`` is RFC 6750's: a refusal raised as a key refusal
    already carries one, and any other 401 or 403 a key request earns (a
    route's own permission check) gets the generic form, so a client can
    always tell a dead credential (``invalid_token``) from one that may not
    do this (``insufficient_scope``).
    """
    expires = getattr(request.state, "api_key_expires_at", None)
    if expires and response.status_code < 400:
        response.headers["X-API-Key-Expires-At"] = expires
    if response.status_code in (401, 403) and "www-authenticate" not in response.headers:
        error = "invalid_token" if response.status_code == 401 else "insufficient_scope"
        response.headers["WWW-Authenticate"] = f'Bearer realm="api", error="{error}"'
    return {
        "authMethod": "api_key",
        "apiKeyId": getattr(request.state, "api_key_id", None),
        "userId": getattr(request.state, "user_id", None),
    }


def configure_json_logging(level: int = logging.INFO) -> None:
    """
    Configure root logger.  Uses human-readable format in dev mode,
    JSON in production.  Reads LOG_LEVEL from the environment so
    .env.dev can control verbosity.
    Call once during application startup.
    """
    import os

    env_level = os.getenv("LOG_LEVEL", "").upper()
    if env_level and hasattr(logging, env_level):
        level = getattr(logging, env_level)

    is_dev = os.getenv("SYNODIC_ROLE", "") in ("dev", "")

    handler = logging.StreamHandler()

    if is_dev:
        # Human-readable logs for local development
        formatter = logging.Formatter(
            fmt="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
            datefmt="%H:%M:%S",
        )
        handler.setFormatter(formatter)
    else:
        try:
            from pythonjsonlogger import jsonlogger

            formatter = jsonlogger.JsonFormatter(
                fmt="%(asctime)s %(levelname)s %(name)s %(message)s"
            )
            handler.setFormatter(formatter)
        except ImportError:
            pass  # fall through to default formatter

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # Pin the chatty redis connection loggers to INFO so a global
    # LOG_LEVEL=DEBUG (used to debug our own code) does not flood the output
    # with per-command/connection redis DEBUG noise. INFO floor only — set
    # independently of the root level.
    for noisy in ("redis", "redis.connection"):
        logging.getLogger(noisy).setLevel(logging.INFO)
