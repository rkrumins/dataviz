"""
Request ID middleware — generates and propagates X-Request-ID per request.
"""
import uuid
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

REQUEST_ID_HEADER = "X-Request-ID"


class RequestIdMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        # Use client-provided ID or generate a new one
        req_id = request.headers.get(REQUEST_ID_HEADER) or f"req_{uuid.uuid4().hex[:16]}"
        request.state.request_id = req_id

        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = req_id
        return response


def get_request_id(request: Request) -> str:
    """FastAPI dependency — returns the request ID for the current request."""
    return getattr(request.state, "request_id", "unknown")
