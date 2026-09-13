"""``GET /metrics`` — the scrape endpoint, off unless an operator turns it on.

OPT-IN, DELIBERATELY. This repository has been bitten by a surface that was
open because nobody chose to close it — the compose file still carries the
comment about an unauthenticated graph database and its admin console
published to the internet by default. A metrics endpoint is lower stakes than
that and it is still a read of internal state: node endpoints, hold reasons,
how loaded the fleet is. So it exists only when ``METRICS_ENABLED`` says so,
and only when ``METRICS_TOKEN`` is set.

THE TOKEN IS NOT OPTIONAL. It was, and "enabled with no token" is the
setting that publishes ``host:port`` for every FalkorDB node, the governor's
hold counts and the fleet's load to anyone who can reach the port — with the
constant-time compare skipped entirely because there was nothing to compare
against. The aggregation worker publishes this same app on ``0.0.0.0`` with
no other HTTP server in front of it, so there is no ingress rule standing
between that combination and the network. Enabled without a token now
answers 404, exactly as if it had never been turned on.

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


def metrics_authorized(request) -> bool:
    """Whether ``request`` may read internal state through the metrics gate.

    False whenever the endpoint is off, whenever no token is configured
    (fail closed — see the module docstring), and whenever the presented
    bearer token does not match. Exported so other unauthenticated surfaces
    that grew internal detail can stand behind the same door: ``/health/deps``
    reports the graph store cluster's shape through it.
    """
    if not metrics_enabled():
        return False
    expected = _token()
    if not expected:
        return False
    got = request.headers.get("authorization", "")
    prefix = "bearer "
    presented = got[len(prefix):] if got.lower().startswith(prefix) else ""
    # Constant-time: the token is short and a scrape endpoint is
    # unauthenticated-adjacent, so the comparison should not be the
    # thing that leaks it.
    import hmac

    return hmac.compare_digest(presented, expected)


@router.get(
    "/metrics",
    summary="Prometheus scrape endpoint (METRICS_ENABLED + METRICS_TOKEN)",
    response_class=PlainTextResponse,
    include_in_schema=False,
)
async def scrape(request: Request) -> PlainTextResponse:
    if not metrics_enabled() or not _token():
        # 404 rather than 403: a disabled endpoint should not confirm it
        # exists, and a scraper misconfigured against the wrong deployment
        # gets the same answer as one pointed at a path that is not there.
        # A missing token lands here too — an operator who set the flag and
        # not the secret gets "off", not "open".
        if metrics_enabled():
            logger.warning(
                "metrics: METRICS_ENABLED is set but METRICS_TOKEN is not — "
                "serving 404. Set METRICS_TOKEN to turn the scrape endpoint on.",
            )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    if not metrics_authorized(request):
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
