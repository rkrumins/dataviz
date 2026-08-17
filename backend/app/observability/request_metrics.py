"""Per-request counters.

Written as raw ASGI rather than ``BaseHTTPMiddleware`` on purpose. That
base class wraps every request in an anyio task group and a pair of
memory object streams; there are already four layers paying that cost,
and a middleware whose entire job is to measure overhead has no business
adding a measurable amount of it. Raw ASGI is a closure and a counter
increment.
"""
from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .metrics import http_requests_total

__all__ = ["RequestMetricsMiddleware"]


# Not counted: the scrape would otherwise show up as traffic in its own
# numbers, and a scrape every 15s is a meaningful share of an idle
# fleet's request rate — precisely the thing being measured.
_EXCLUDED_PREFIXES = ("/internal/metrics",)


def _route_label(scope: Scope) -> str:
    """The route TEMPLATE, never the concrete path.

    ``/api/v1/{ws_id}/graph/nodes`` is one time series;
    ``/api/v1/ws_7f3a/graph/nodes`` would be one per workspace, and a
    label whose cardinality grows with customer data is how a metrics
    backend gets taken down by its own instrumentation.

    A request that matched no route (404, or one rejected by middleware
    before routing) has no template, and its raw path is attacker- or
    crawler-controlled — so it collapses to a single ``<unmatched>``
    bucket rather than minting a series per URL probed.
    """
    route = scope.get("route")
    path_format = getattr(route, "path_format", None) or getattr(route, "path", None)
    return path_format or "<unmatched>"


class RequestMetricsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path.startswith(_EXCLUDED_PREFIXES):
            await self.app(scope, receive, send)
            return

        status_holder: dict[str, int] = {}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            # In ``finally`` so a stream cancelled by a disconnecting
            # client, or a handler that raised, still lands in the
            # numbers. A request that only counts when it succeeds makes
            # an unhealthy fleet look quiet.
            http_requests_total.labels(
                method=scope.get("method", "?"),
                route=_route_label(scope),
                # 0 rather than a guess: the response never started, so
                # there is no status, and inventing 500 would conflate a
                # client hang-up with a server error.
                status=str(status_holder.get("status", 0)),
            ).inc()
