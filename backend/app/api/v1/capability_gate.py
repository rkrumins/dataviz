"""View-capability gate for the workspace data plane.

Before this module, the graph/canvas/assets/context-models routers and
the versioning reads were reachable ONLY through
``workspace:datasource:read`` membership — the data plane had no idea
views existed. That made ``enterprise`` visibility a lie: any signed-in
user could fetch a view's metadata and config, then every canvas call
403'd. This gate is the other half of the contract:

    can_read_view(view) ⇒ read-only access to the view's data plane

A request may carry ``viewId`` as its capability context. The gate
allows it when ALL hold:

  * the view exists, is live, and belongs to the path workspace
    (mismatch → 404, existence-hiding — same convention as
    ``GET /views/{id}``);
  * the caller can read the view (``view_access.can_read_view``);
  * on graph-data surfaces (``pin_data_source=True``) the requested
    data source is the view's resolved source — its own, or the
    workspace primary when it stores NULL. A sibling source in the
    same workspace stays closed (403).

Membership callers are untouched — ``workspace:datasource:read`` short-
circuits first — with ONE tightening for everyone: when a request names
a ``dataSourceId``, it must belong to the path workspace (404
otherwise). The provider layer never verified that binding, so a valid
membership in workspace A could previously open workspace B's graph by
id. See ``providers/manager.py`` (cache key is provider+graph_name).

Read-only enforcement is deliberately NOT method-based (many reads are
POSTs: trace, search, canvas bootstrap/expand, edges/between, …).
Every state-changing route on these routers carries its own
``workspace:datasource:manage`` dependency, which a capability caller
can never satisfy — ``test_data_plane_capability`` proves it route by
route, and closed the two routes that had been missing the manage gate
(``vocab-alignment/confirm``, ``graph/changes``).

Follows the ``requires()`` doctrine: 401 via ``get_current_user``;
503 (never 403) when the workspace-claims store is unreachable; the
structured ``missing_permission`` 403 body; best-effort denial audit;
Phase-16 introspection tags on the closure.
"""
from __future__ import annotations

from typing import Callable, Optional

from fastapi import Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    _audit_access_denied,
    get_current_user,
    get_permission_claims,
)
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM
from backend.app.db.repositories import data_source_repo
from backend.app.services import view_access
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
)
from backend.auth_service.interface import User


_BASE_PERMISSION = "workspace:datasource:read"


def _not_found(kind: str, resource_id: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"{kind} '{resource_id}' not found",
    )


def datasource_read_or_view_capability(
    *,
    ws_param: str = "ws_id",
    ds_in_path: Optional[str] = None,
    pin_data_source: bool = True,
) -> Callable:
    """Build the OR-gate dependency.

    ``ws_param`` — path parameter holding the workspace id.
    ``ds_in_path`` — path parameter holding the data-source id, for
    routes that carry it in the path (cached-schema/-ontology);
    otherwise the ``dataSourceId`` query param is read.
    ``pin_data_source`` — graph-data surfaces pin the capability to the
    view's resolved source; workspace-metadata surfaces (assets,
    context-model templates) have no source dimension and skip it.
    """

    async def _dependency(
        request: Request,
        viewId: Optional[str] = Query(
            None,
            description=(
                "View-capability context: authorizes read-only access "
                "for callers who can read this view but hold no "
                "workspace membership."
            ),
        ),
        dataSourceId: Optional[str] = Query(None),
        user: User = Depends(get_current_user),
        claims: PermissionClaims = Depends(get_permission_claims),
        session: AsyncSession = Depends(get_db_session),
    ) -> User:
        ws_id = request.path_params.get(ws_param)
        if not ws_id:
            raise RuntimeError(
                f"capability gate configured with ws_param={ws_param!r} but "
                f"path param is missing on {request.url.path!r}"
            )
        requested_ds = (
            request.path_params.get(ds_in_path) if ds_in_path else dataSourceId
        )

        # Tenant binding — for EVERY caller. A named data source must
        # belong to the path workspace; a live row is required.
        ds_row = None
        if requested_ds:
            ds_row = await data_source_repo.get_data_source_orm(
                session, requested_ds,
            )
            if ds_row is None or ds_row.workspace_id != ws_id:
                raise _not_found("Data source", requested_ds)

        # Membership path — identical to the old requires() gate.
        if has_permission(claims, _BASE_PERMISSION, workspace_id=ws_id):
            return user

        # Capability path.
        if viewId:
            view = (await session.execute(
                select(ViewORM).where(
                    ViewORM.id == viewId,
                    ViewORM.deleted_at.is_(None),
                )
            )).scalar_one_or_none()
            if view is None or view.workspace_id != ws_id:
                # 404, not 403 — the view's existence (and its home
                # workspace) stays private from callers with no path
                # to it.
                raise _not_found("View", viewId)
            ctx = await view_access.ViewerContext.build(
                session, user=user, claims=claims,
            )
            if not await view_access.can_read_view(session, ctx, view):
                raise _not_found("View", viewId)
            if pin_data_source:
                resolved = view.data_source_id
                primary_id: Optional[str] = None
                if resolved is None or requested_ds is None:
                    primary = await data_source_repo.get_primary_data_source(
                        session, ws_id,
                    )
                    primary_id = primary.id if primary else None
                if resolved is None:
                    resolved = primary_id
                # A route called without dataSourceId falls back to the
                # workspace primary in the handler — hold the gate to
                # the same effective source.
                effective = requested_ds or primary_id
                if resolved is None or effective != resolved:
                    await _audit_access_denied(
                        session,
                        user_id=user.id,
                        permission=_BASE_PERMISSION,
                        scope_obj={"type": "workspace", "id": ws_id},
                    )
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail={
                            "error": "missing_permission",
                            "permission": _BASE_PERMISSION,
                            "scope": {"type": "workspace", "id": ws_id},
                            "message": (
                                "This view does not grant access to the "
                                "requested data source"
                            ),
                        },
                    )
            request.state.view_capability = view.id
            return user

        # Neither path. Store-outage denials are unanswered questions,
        # not refusals — same doctrine as requires().
        if not claims.ws_available:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authorization temporarily unavailable",
            )
        await _audit_access_denied(
            session,
            user_id=user.id,
            permission=_BASE_PERMISSION,
            scope_obj={"type": "workspace", "id": ws_id},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "missing_permission",
                "permission": _BASE_PERMISSION,
                "scope": {"type": "workspace", "id": ws_id},
                "message": f"Missing permission: {_BASE_PERMISSION}",
            },
        )

    # Phase-16 introspection tags — the route-graph drift tests read
    # these off the closure exactly as they do off requires().
    _dependency.required_permission = _BASE_PERMISSION  # type: ignore[attr-defined]
    _dependency.workspace_param = ws_param  # type: ignore[attr-defined]
    _dependency.workspace_any = False  # type: ignore[attr-defined]
    _dependency.accepts_view_capability = True  # type: ignore[attr-defined]

    return _dependency


# Graph-data surfaces: capability pinned to the view's resolved source.
require_ds_read_or_view = datasource_read_or_view_capability()

# Workspace-metadata surfaces (assets, context-model templates): no
# data-source dimension to pin.
require_ws_read_or_view = datasource_read_or_view_capability(
    pin_data_source=False,
)

# cached-schema / cached-ontology: workspace + source ids in the path.
require_ds_read_or_view_dspath = datasource_read_or_view_capability(
    ws_param="workspace_id", ds_in_path="ds_id",
)
