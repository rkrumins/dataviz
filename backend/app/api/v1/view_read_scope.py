"""The caller's read reach over views, for every endpoint that lists or counts them.

One definition, so a count shown anywhere — the Explorer's stats bar, the
dashboard's cards, a template's "used in n views" — describes the same
population the Explorer would list. These lived privately in
``endpoints/views.py`` (which still imports them under their old names) until
the workspace summary and the layout-template library began counting views too.
"""
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import rbac_flag
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


async def viewer_context(
    session: AsyncSession,
    user: Optional[User],
    claims: PermissionClaims,
) -> view_access.ViewerContext:
    """Build the per-request ViewerContext used by every guarded route."""
    return await view_access.ViewerContext.build(session, user=user, claims=claims)


async def read_scope(
    session: AsyncSession,
    user: User,
    claims: PermissionClaims,
) -> view_access.ViewReadScope:
    """The caller's read reach for SQL scoping.

    Mirrors the ``requires()`` doctrine on session-store outages: when
    workspace grants are unavailable we refuse (503) rather than render
    an empty catalog that looks like revoked access.
    """
    if not claims.ws_available and "system:admin" not in claims.global_perms:
        raise HTTPException(
            status_code=503, detail="Authorization temporarily unavailable",
        )
    ctx = await viewer_context(session, user, claims)
    return await view_access.build_read_scope(session, ctx)


async def readable_clause(
    session: AsyncSession,
    user: User,
    claims: PermissionClaims,
):
    """(clause, scope) under RBAC enforcement; (None, None) when the
    kill-switch is off — repo functions treat None as unscoped."""
    if not rbac_flag("RBAC_ENFORCE_VIEWS"):
        return None, None
    scope = await read_scope(session, user, claims)
    return view_access.readable_views_clause(scope), scope
