"""``GET /metrics`` — the scrape endpoint, off unless an operator turns it on.

OPT-IN, DELIBERATELY. This repository has been bitten by a surface that was
open because nobody chose to close it — the compose file still carries the
comment about an unauthenticated graph database and its admin console
published to the internet by default. A metrics endpoint is lower stakes than
that and it is still a read of internal state: node endpoints, hold reasons,
how loaded the fleet is. So it exists only when ``METRICS_ENABLED`` says so,
and takes an optional bearer token for deployments whose scraper can send one.

The BACKEND, by contrast, is always installed. Counting in process costs
nothing, keeps the registry warm from the first request, and means turning
the endpoint on shows real numbers immediately rather than starting from
zero at the moment you most want history.
"""
from __future__ import annotations

import logging
import os

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import PlainTextResponse

logger = logging.getLogger(__name__)

router = APIRouter()

#: Prometheus' own content type. A scraper that gets ``text/plain`` without
#: it still parses, but says so in its logs on every scrape.
_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def metrics_enabled() -> bool:
    return (os.getenv("METRICS_ENABLED") or "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _token() -> str:
    return (os.getenv("METRICS_TOKEN") or "").strip()


@router.get(
    "/metrics",
    summary="Prometheus scrape endpoint (METRICS_ENABLED)",
    response_class=PlainTextResponse,
    include_in_schema=False,
)
async def scrape(request: Request) -> PlainTextResponse:
    if not metrics_enabled():
        # 404 rather than 403: a disabled endpoint should not confirm it
        # exists, and a scraper misconfigured against the wrong deployment
        # gets the same answer as one pointed at a path that is not there.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    expected = _token()
    if expected:
        got = request.headers.get("authorization", "")
        prefix = "bearer "
        presented = got[len(prefix):] if got.lower().startswith(prefix) else ""
        # Constant-time: the token is short and a scrape endpoint is
        # unauthenticated-adjacent, so the comparison should not be the
        # thing that leaks it.
        import hmac

        if not hmac.compare_digest(presented, expected):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    from backend.app.jobs.metrics_prometheus import installed

    backend = installed()
    if backend is None:
        # Enabled but never installed — a process that skipped its startup
        # wiring. Say so rather than serving a convincing empty page.
        return PlainTextResponse(
            "# metrics backend not installed in this process\n",
            media_type=_CONTENT_TYPE,
        )
    return PlainTextResponse(backend.render(), media_type=_CONTENT_TYPE)
