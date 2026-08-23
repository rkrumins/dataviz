"""Usage figures for the content a reader is already looking at.

WHY THIS IS NOT PART OF THE ANALYTICS SECTION
The dashboard answers "is anyone using this?" only for someone who navigates to
it, and it is gated on the permissions an operator holds. The people best
placed to act on the answer are the person who built a view and the team that
owns it — who have no reason to visit an analytics page, and often no
permission to. So the same question is answered here, from the content itself.

THE ACCESS RULE, STATED ONCE
Counts follow the content. If you may open a view, you may know how much it is
opened; if you may not, the endpoint does not admit it exists. That is enforced
by filtering through ``readable_views_clause`` — the identical predicate the
catalogue lists with — so usage can never disagree with visibility.

WHY NO PRIVACY MODE APPLIES
This returns counts and dates. No actor ids, no names, not even "who opens it
most". There is nothing here to redact, which is what makes it answerable for
every reader rather than only for privileged ones. Anything that would name a
person stays on the Analytics section, behind its gate.

BATCHED ON PURPOSE
One request carries many ids and costs three queries regardless. A gallery
asking per card would be three queries per tile, which is the difference
between a page that loads and one that hammers the database once per thing it
draws.

ON THE READONLY POOL
This fires on every view page, for every reader, and it is pure aggregate
reads. That is what ``get_readonly_db_session`` exists for: a decoration on
someone else's page must not contend for the WEB pool that serves the page
itself.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
    rbac_flag,
)
from backend.app.db.engine import get_readonly_db_session
from backend.app.db.repositories import analytics_repo
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()

_DAYS = Query(30, ge=1, le=365, description="Trailing window, in days.")
_WS_IDS = Query(
    ...,
    description=(
        "Comma-separated workspace ids. Rollups cover only the views the "
        "caller may read, so two readers can see different totals for one "
        "workspace — which is the access rule showing through, not a bug."
    ),
)
_IDS = Query(
    ...,
    description=(
        "Comma-separated view ids. Ids the caller may not read are omitted "
        f"from the response; at most {analytics_repo.MAX_USAGE_IDS} are read."
    ),
)


@router.get("/views")
async def views_usage(
    ids: str = _IDS,
    days: int = _DAYS,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Opens, distinct viewers and a trend for each view the caller can read.

    Ids the caller cannot read are absent from the response rather than
    refused: a batch is a mixed bag by nature, and 403-ing the whole request
    because one tile in a gallery is out of reach would make the endpoint
    unusable for its main caller. Absence is also the same answer a
    non-existent id gets, so this cannot be used to probe for what exists.
    """
    requested = [i.strip() for i in ids.split(",") if i.strip()]
    if not requested:
        return {"views": {}, "windowDays": days}

    readable = None
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        # Same doctrine as the views catalogue: when workspace grants are
        # unavailable we refuse rather than render an empty result that looks
        # like revoked access.
        if not claims.ws_available and "system:admin" not in claims.global_perms:
            raise HTTPException(
                status_code=503, detail="Authorization temporarily unavailable",
            )
        ctx = await view_access.ViewerContext.build(
            session, user=user, claims=claims)
        scope = await view_access.build_read_scope(session, ctx)
        readable = view_access.readable_views_clause(scope)

    usage = await analytics_repo.view_usage(
        session, requested, days=days, readable=readable,
        # The reader's own usage is about the reader, so it discloses nothing
        # — and it is what lets a card say "new to you" rather than reciting a
        # number at somebody who has never seen the view before.
        viewer_id=user.id,
    )
    return {"views": usage, "windowDays": days}


@router.get("/workspaces")
async def workspaces_usage(
    ids: str = _WS_IDS,
    days: int = _DAYS,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """Is each workspace alive, and what do people come to it for?

    Same shape and same access rule as `/views`: unreadable content is simply
    not counted, and the top view named back is always one the caller could
    open — a usage endpoint must not become the way to learn that a view
    exists.
    """
    requested = [i.strip() for i in ids.split(",") if i.strip()]
    if not requested:
        return {"workspaces": {}, "windowDays": days}

    readable = None
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        if not claims.ws_available and "system:admin" not in claims.global_perms:
            raise HTTPException(
                status_code=503, detail="Authorization temporarily unavailable",
            )
        ctx = await view_access.ViewerContext.build(
            session, user=user, claims=claims)
        scope = await view_access.build_read_scope(session, ctx)
        readable = view_access.readable_views_clause(scope)

    usage = await analytics_repo.workspace_usage(
        session, requested, days=days, readable=readable,
    )
    return {"workspaces": usage, "windowDays": days}
