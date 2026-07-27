"""Delegated, view-scoped access to the data plane.

The problem this solves
-----------------------
A view's visibility tier decides who can *find and open* it, but every
route that actually renders one — ``/{ws_id}/graph/*``,
``/{ws_id}/graph/canvas/*``, ``/{ws_id}/assets/*`` — is gated on
``workspace:datasource:read`` in that workspace. A caller reaching a view
through ``enterprise`` or ``public`` does not hold that permission, by
definition: those tiers exist precisely for people who are not in the
workspace. So the view listed, opened, returned 200 from
``GET /views/{id}`` … and then painted an empty canvas, because every
data call behind it 403'd.

Visibility carried no data access. This module is the bridge.

How it works
------------
``requires_ws_read_or_view_delegate`` replaces the router-level
``requires("workspace:datasource:read", workspace="ws_id")`` on a small
allow-list of read routes:

1. **Fast path** — the caller holds the permission. Allowed unchanged, no
   extra query. Members are entirely unaffected.
2. **Delegated path** — the request names a ``viewId`` the caller is
   allowed to read, in this workspace. They get access to *that view's
   scope* and nothing else: the resolved ``EffectiveViewScope`` is
   attached to ``request.state`` and handlers confine their reads to it.
3. Otherwise the usual typed 403.

The confinement machinery is not new. ``services/view_scope.py`` already
resolves a view's authoritative scope server-side and guarantees that
client-supplied hints can only *narrow* it — built for advanced search,
where the same "don't let the client ask for things outside the view"
problem had to be solved. This reuses it.

Deliberately narrow
-------------------
* Only read routes are delegable, and only the ones needed to paint a
  saved view. Mutation, resync, bootstrap and metadata-catalogue routes
  keep the plain permission check. A delegate cannot change anything.
* ``dataSourceId`` is pinned to the view's own. Asking for a different
  source through a view that happens to live in the right workspace is a
  403, not a widening.
* ``scope_mode='data_source'`` — advanced search's power-user override
  that deliberately escapes view containment — is refused for delegates.
  It is the one documented way to ask a view-bound route for data outside
  the view.
* The view is re-read and re-authorized on every request. Delegation is
  not a token and does not outlive a change to the view's tier or grants.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_optional_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.view_scope import (
    EffectiveViewScope,
    ViewNotFound,
    ViewScopeError,
    ViewScopeResolver,
)
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

#: Attribute on ``request.state`` carrying the delegation, when one applies.
STATE_ATTR = "delegated_view_scope"


@dataclass(frozen=True)
class ViewDelegation:
    """A caller's confined reach into one workspace, via one view."""
    view_id: str
    workspace_id: str
    data_source_id: Optional[str]
    scope: EffectiveViewScope
    #: Why the caller can read the view — for logging and telemetry.
    reason: Optional[str] = None


def get_delegation(request: Optional[Request]) -> Optional[ViewDelegation]:
    """The active delegation, or ``None`` when the caller is a real member.

    Handlers call this to decide whether they must confine their reads.
    ``None`` means "no confinement" — the caller holds
    ``workspace:datasource:read`` outright, or there is no HTTP request at
    all (a handler invoked directly from a test), which likewise cannot be
    a delegated call.
    """
    if request is None:
        return None
    return getattr(request.state, STATE_ATTR, None)


def require_within_scope(request: Request, urns: list[str]) -> None:
    """Assert every URN is inside the caller's delegated scope.

    A no-op for non-delegates. For delegates, an out-of-scope URN is a 403
    rather than a silent drop: the caller asked for something they are not
    entitled to, and quietly returning fewer rows would make that look
    like an empty result.
    """
    delegation = get_delegation(request)
    if delegation is None:
        return
    allowed = set(delegation.scope.root_urns)
    if not allowed:
        # The view declares no explicit roots (its scope is derived at
        # query time from rootEntityTypes). Nothing to check here; the
        # handler's own containment clamp applies.
        return
    outside = [u for u in urns if u not in allowed]
    if outside:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "outside_view_scope",
                "view_id": delegation.view_id,
                "message": (
                    "Requested nodes lie outside the view you have access to"
                ),
            },
        )


def _denied(permission: str, workspace_id: Optional[str]) -> HTTPException:
    """The same typed 403 body ``requires(...)`` produces."""
    scope_obj = (
        {"type": "workspace", "id": workspace_id}
        if workspace_id is not None
        else {"type": "global", "id": None}
    )
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "missing_permission",
            "permission": permission,
            "scope": scope_obj,
            "message": f"Missing permission: {permission}",
        },
    )


def requires_ws_read_or_view_delegate(
    permission: str = "workspace:datasource:read",
    *,
    workspace: str = "ws_id",
) -> Callable:
    """Router dependency: workspace read, or a view the caller can open.

    Drop-in replacement for
    ``requires(permission, workspace=workspace)`` on read routes that a
    non-member should be able to reach *through a view*.
    """

    async def _dependency(
        request: Request,
        view_id: Optional[str] = Query(
            None,
            alias="viewId",
            description=(
                "Open this route in the context of a saved view. Callers who "
                "lack workspace:datasource:read may still read the parts of "
                "the graph that view covers, provided they can read the view."
            ),
        ),
        data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
        branch_id: Optional[str] = Query(None, alias="branchId"),
        user: Optional[User] = Depends(get_optional_user),
        claims: PermissionClaims = Depends(get_permission_claims),
        session: AsyncSession = Depends(get_db_session),
    ) -> Optional[User]:
        workspace_id = request.path_params.get(workspace)
        if not workspace_id:
            raise RuntimeError(
                f"requires_ws_read_or_view_delegate(workspace={workspace!r}) "
                f"but path param is missing on {request.url.path!r}"
            )

        # 1. Members take the fast path, unchanged and unconfined.
        if has_permission(claims, permission, workspace_id=workspace_id):
            return user

        # 2. Delegation requires an explicit view context. Without one
        #    there is nothing to scope the request to.
        if not view_id:
            raise _denied(permission, workspace_id)
        if user is None:
            raise _denied(permission, workspace_id)

        view = await session.get(ViewORM, view_id)
        # Cross-workspace and non-existent are the same answer: a caller
        # must not learn that a view exists somewhere they can't reach.
        if (
            view is None
            or view.workspace_id != workspace_id
            or view.deleted_at is not None
        ):
            raise _denied(permission, workspace_id)

        ctx = await view_access.ViewerContext.build(
            session, user=user, claims=claims,
        )
        decision = await view_access.read_decision(session, ctx, view)
        if not decision.allowed:
            raise _denied(permission, workspace_id)

        # 3. Pin the data source. A view grants reach into ITS source, not
        #    into whatever the caller names alongside it.
        if data_source_id and view.data_source_id and data_source_id != view.data_source_id:
            raise _denied(permission, workspace_id)

        scope = await _resolve_scope(
            session,
            view=view,
            workspace_id=workspace_id,
            branch_id=branch_id,
        )
        setattr(request.state, STATE_ATTR, ViewDelegation(
            view_id=view.id,
            workspace_id=workspace_id,
            data_source_id=view.data_source_id,
            scope=scope,
            reason=decision.reason,
        ))
        logger.info(
            "view_delegation.granted view=%s ws=%s user=%s reason=%s",
            view.id, workspace_id, user.id, decision.reason,
        )
        return user

    _dependency.required_permission = permission  # type: ignore[attr-defined]
    _dependency.workspace_param = workspace  # type: ignore[attr-defined]
    _dependency.workspace_any = False  # type: ignore[attr-defined]
    _dependency.view_delegable = True  # type: ignore[attr-defined]
    return _dependency


async def _resolve_scope(
    session: AsyncSession,
    *,
    view: ViewORM,
    workspace_id: str,
    branch_id: Optional[str],
) -> EffectiveViewScope:
    """Resolve the view's authoritative scope, or refuse the request.

    A view whose scope cannot be resolved must not fall back to
    "unrestricted" — that would turn a resolver bug into a data leak.
    """
    from backend.common.models.search import SearchScope

    resolver = ViewScopeResolver(session)
    try:
        return await resolver.resolve(
            workspace_id=workspace_id,
            requested=SearchScope(view_id=view.id),
            data_source_id=view.data_source_id,
            branch_id=branch_id,
        )
    except (ViewNotFound, ViewScopeError) as exc:
        logger.warning(
            "view_delegation.scope_unresolvable view=%s ws=%s: %s",
            view.id, workspace_id, exc,
        )
        raise _denied("workspace:datasource:read", workspace_id)


__all__ = [
    "STATE_ATTR",
    "ViewDelegation",
    "get_delegation",
    "require_within_scope",
    "requires_ws_read_or_view_delegate",
]
