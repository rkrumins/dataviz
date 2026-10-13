"""
Request ID middleware — generates and propagates X-Request-ID per request.

It also binds the request's activity context (``common/activity_context``):
the same id doubles as the correlation id the activity ledger records, and a
person's ``X-Activity-Reason`` is read here once instead of by every handler
that might emit an event.
"""
import uuid
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from backend.app.common import activity_context

REQUEST_ID_HEADER = "X-Request-ID"


class RequestIdMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        # Use a well-formed client-provided ID or generate a new one. The id
        # is stored in audit records now, so an arbitrary client string must
        # not pass through verbatim.
        req_id = (
            activity_context.valid_correlation_id(request.headers.get(REQUEST_ID_HEADER))
            or f"req_{uuid.uuid4().hex[:16]}"
        )
        request.state.request_id = req_id

        # Bound before ``call_next`` so the endpoint (which runs in a task
        # that copies this context) sees it, and reset after so nothing
        # outlives the request on this task.
        token = activity_context.bind(activity_context.ActivityContext(
            correlation_id=req_id,
            stated_reason=activity_context.parse_stated_reason(
                request.headers.get(activity_context.REASON_HEADER),
            ),
        ))
        try:
            response = await call_next(request)
        finally:
            activity_context.reset(token)
        response.headers[REQUEST_ID_HEADER] = req_id
        return response


def get_request_id(request: Request) -> str:
    """FastAPI dependency — returns the request ID for the current request."""
    return getattr(request.state, "request_id", "unknown")
