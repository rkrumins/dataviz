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

    **The template has to be reassembled, and skipping that step is a
    quieter bug than the cardinality one it looks like.** FastAPI 0.141 /
    Starlette 1.6 no longer flatten ``include_router``: they nest a
    ``_IncludedRouter`` per prefix, and the innermost router is the one
    that writes ``scope["route"]``. What lands there is therefore the
    route's path *relative to its own router* — ``/config``, not
    ``/api/v1/announcements/config`` — while ``root_path`` stays empty.
    Using it raw does not inflate cardinality, it **collides**: every
    router with a ``/config`` endpoint sums into one series, and the
    reader has no way to tell. Wrong numbers that look right.

    So the prefix comes from ``scope["path"]`` (the full concrete path)
    and only the tail comes from the template. Taking the prefix from
    the concrete path is safe precisely because a prefix is all literal
    segments — no parameter values can hide in it.
    """
    route = scope.get("route")
    template = getattr(route, "path_format", None) or getattr(route, "path", None)
    if not template:
        return "<unmatched>"

    concrete = [seg for seg in (scope.get("path") or "").split("/") if seg]
    tail = [seg for seg in template.split("/") if seg]

    # A ``{param:path}`` converter eats several segments, so the segment
    # arithmetic below would mistake real parameter values for prefix and
    # put them in the label. Rather than risk that, keep the relative
    # template: less specific, still bounded.
    if any("/" in str(v) for v in (scope.get("path_params") or {}).values()):
        return template

    if len(concrete) > len(tail):
        prefix = "/" + "/".join(concrete[: len(concrete) - len(tail)])
        return prefix + template
    return template


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
