"""
Structured JSON request logging middleware.
Replaces ad-hoc print statements with machine-parseable log records.
"""
import logging
import time

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger("synodic.access")


class StructuredLoggingMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 2)

        req_id = getattr(request.state, "request_id", "unknown")
        connection_id = request.query_params.get("connectionId")

        logger.info(
            "request",
            extra={
                "requestId": req_id,
                "connectionId": connection_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "durationMs": duration_ms,
            },
        )
        response.headers["X-Process-Time"] = f"{duration_ms}ms"
        return response


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
