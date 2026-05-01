"""v2 API router — gated by the TRACE_V2_ENABLED feature flag.

Mount point in main.py: ``app.include_router(api_v2_router, prefix="/api/v2")``.
The mount is conditional on ``TRACE_V2_ENABLED=true``; with the flag off the
v2 endpoints return 404 (router not registered).

This is the kill-switch contract from plan §2.6 step 9.
"""
import os

from fastapi import APIRouter

from .endpoints import graph as graph_v2

api_v2_router = APIRouter()


def trace_v2_enabled() -> bool:
    """Single source of truth for the feature flag.

    Read from env. Defaults to false — the migration prerequisites
    (label backfill, materialization invalidation hooks, auth) must
    complete and ops must explicitly flip the flag before v2 is live.
    """
    return os.environ.get("TRACE_V2_ENABLED", "false").strip().lower() == "true"


# Always register the route definitions so the OpenAPI document reflects
# them in environments with the flag on; gating happens at the mount in
# main.py — that way disabled environments serve 404 cleanly without a
# half-registered v2 surface.
api_v2_router.include_router(
    graph_v2.router,
    prefix="/{ws_id}/graph",
    tags=["graph:v2"],
)
