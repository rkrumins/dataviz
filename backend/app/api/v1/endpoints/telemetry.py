"""Product telemetry — record usage signals, and an admin read of aggregates.

Two routers:
  * ``router`` — ``POST /api/v1/telemetry/events``: auth-required (records the
    actor), a tight event-type allowlist, small payloads. Auth-required so this
    is not an open write endpoint; anonymous /docs readers keep their
    localStorage-only vote.
  * ``admin_router`` — ``GET /api/v1/admin/telemetry/summary``: gated
    ``system:audit:read``; returns helpful-vote totals, the top zero-result
    searches (content gaps), and the tour funnel.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import product_event_repo
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()
admin_router = APIRouter()

# The only signals we accept — keeps the store meaningful and the endpoint from
# becoming a general-purpose write sink.
#
# Two families, and the split matters:
#
#   * The ``docs.`` / ``tour.`` / ``onboarding.`` types are ABOUT the product —
#     did the documentation help, did the tour land. They measure whether we
#     explained ourselves.
#   * The ``lineage.`` / ``graph.`` / ``version.`` / ``ontology.`` types are the
#     product itself — someone traced lineage, searched the graph, published a
#     revision. They measure whether anyone got VALUE.
#
# Only the first family existed. That meant Analytics could prove people opened
# views and could not prove anyone ever traced lineage, which is the entire
# point of the platform: we were counting attention, not value.
#
# The ``*_empty`` / ``*_miss`` variants are separate event TYPES rather than a
# payload flag on purpose. The analytics repo aggregates with a GROUP BY on
# ``event_type`` (served by ``idx_product_events_type_created``); a flag inside
# the JSON payload would force a scan to answer "how often did a trace come back
# with nothing?" — which is precisely the question worth asking, since a trace
# that returns no lineage is a value moment that FAILED. ``docs.search_miss``
# already set this precedent.
ALLOWED_EVENT_TYPES = frozenset(
    {
        # Did we explain ourselves?
        "docs.feedback",
        "docs.search_miss",
        "tour.completed",
        "tour.skipped",
        "onboarding.step",
        # Did anyone get value?
        "lineage.trace",
        "lineage.trace_empty",
        "graph.search",
        "graph.search_miss",
        "graph.export",
        "version.published",
        "ontology.published",
    }
)

# Guard against oversized payloads (this is a lightweight signal, not a document).
_MAX_PAYLOAD_CHARS = 2000


class TelemetryEventIn(BaseModel):
    type: str = Field(..., description="One of the allowed telemetry event types.")
    payload: dict[str, Any] | None = None


@router.post("/events", status_code=204)
async def record_event(
    body: TelemetryEventIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    if body.type not in ALLOWED_EVENT_TYPES:
        raise HTTPException(status_code=422, detail=f"unknown event type: {body.type!r}")
    if body.payload is not None and len(str(body.payload)) > _MAX_PAYLOAD_CHARS:
        raise HTTPException(status_code=422, detail="payload too large")

    await product_event_repo.record(
        session,
        event_type=body.type,
        actor_id=getattr(user, "id", None),
        payload=body.payload,
    )
    await session.commit()
    return Response(status_code=204)


@admin_router.get("/summary")
async def telemetry_summary(
    days: int = Query(30, ge=1, le=365, description="Look-back window in days."),
    _admin: User = Depends(requires("system:audit:read")),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    data = await product_event_repo.summary(session, since_iso=since_iso)
    data["windowDays"] = days
    return data
