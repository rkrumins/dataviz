"""``GET /api/v1/changes`` — the change manifest.

One request that answers, for every resource a client is showing, "has
this moved since you last looked?" Nine always-mounted surfaces used to
ask that question separately, on nine timers, and the answer was almost
always no.

The manifest is a map of topic to version counter. A client compares it
against what it holds and refetches only the endpoints whose version
differs. The endpoints themselves are unchanged and remain the source of
truth — this says *when* to call them, never *what* they return.

Beyond replacing the nine polls, this is also the backstop for the
streaming transport: on connect and on every reconnect a client reads
the manifest, so a change that happened while it was disconnected shows
up as a version mismatch. That is what lets the stream be lossy, which
in turn is what lets it be cheap.

**Topics come from the session, not the request.** See
``changes/topics.py`` — a caller cannot name a topic, only narrow the
set its identity already implies.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.changes import topics as change_topics
from backend.app.changes.registry import get_registry
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


class ChangeManifest(BaseModel):
    """Topic → version. Absent topics are 0."""

    topics: dict[str, int] = Field(default_factory=dict)


@router.get(
    "",
    response_model=ChangeManifest,
    summary="Version counters for everything this session subscribes to",
)
async def get_change_manifest(
    topics: Optional[str] = Query(
        default=None,
        description=(
            "Comma-separated subset to return. Can only narrow the set "
            "this session is entitled to; unknown or forbidden names are "
            "dropped silently."
        ),
    ),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> ChangeManifest:
    # ``ws_available=False`` means no source could answer what this
    # session may see — not that it may see nothing. Answering 200 with a
    # partial manifest would present as "realtime quietly stopped
    # working"; 503 says what is true and the client retries. This
    # matches what ``requires`` and ``GET /me/permissions`` already do.
    if not claims.ws_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session claims unavailable; retry shortly.",
            headers={"Retry-After": "5"},
        )

    allowed = change_topics.topics_for_user(str(user.id))
    requested = (
        [t.strip() for t in topics.split(",") if t.strip()]
        if topics is not None
        else None
    )
    wanted = change_topics.narrow(allowed, requested)

    try:
        versions = await get_registry().snapshot(wanted)
    except Exception:
        # The registry raises rather than reporting zeros, because zeros
        # would read as "everything changed" and every client would
        # refetch everything — the worst possible response to a backend
        # that is already unwell.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Change registry unavailable; retry shortly.",
            headers={"Retry-After": "5"},
        )

    return ChangeManifest(topics=versions)
