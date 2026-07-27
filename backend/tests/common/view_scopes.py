"""Ready-made ``ViewReadScope`` values for repo-level view tests.

``view_repo``'s listing functions require a scope — that is the point of
the design: a query is authorized unless someone works to make it
otherwise. Tests that exercise *ordering*, *pagination* or *enrichment*
rather than *access* want a scope that sees everything, and tests that
exercise access want a specific principal. Both live here so the shape
is declared once.

Building a scope directly (rather than via ``build_read_scope``) keeps
these helpers synchronous and avoids a DB round-trip for the grant
lookup; pass ``grant_view_ids`` explicitly when a test needs Layer-3.
"""
from __future__ import annotations

from typing import Iterable, Mapping, Optional, Sequence

from backend.app.services.permission_service import PermissionClaims
from backend.app.services.view_access import ViewerContext, ViewReadScope


def viewer_context(
    *,
    user_id: str = "usr_test000000",
    global_perms: Sequence[str] = (),
    ws_perms: Optional[Mapping[str, Sequence[str]]] = None,
    group_ids: Iterable[str] = (),
    is_anonymous: bool = False,
    sid: str = "sess_test",
) -> ViewerContext:
    """A ``ViewerContext`` from plain claim literals."""
    return ViewerContext(
        user_id="" if is_anonymous else user_id,
        claims=PermissionClaims(
            sid=sid,
            global_perms=tuple(global_perms),
            ws_perms={k: tuple(v) for k, v in (ws_perms or {}).items()},
        ),
        group_ids=tuple(group_ids),
        is_anonymous=is_anonymous,
    )


def scope_for(
    ctx: ViewerContext, *, grant_view_ids: Sequence[str] = (),
) -> ViewReadScope:
    return ViewReadScope(ctx=ctx, grant_view_ids=tuple(grant_view_ids))


def admin_scope(user_id: str = "usr_test000000") -> ViewReadScope:
    """Sees every view. Use in tests about ordering/paging/enrichment,
    where access filtering is not what is under test."""
    return scope_for(viewer_context(
        user_id=user_id, global_perms=("system:admin",),
    ))


def member_scope(
    workspace_id: str,
    *,
    user_id: str = "usr_member",
    perms: Sequence[str] = ("workspace:view:read",),
    grant_view_ids: Sequence[str] = (),
) -> ViewReadScope:
    """A plain member of one workspace."""
    return scope_for(
        viewer_context(user_id=user_id, ws_perms={workspace_id: perms}),
        grant_view_ids=grant_view_ids,
    )


def workspace_admin_scope(
    workspace_id: str, *, user_id: str = "usr_wsadmin",
) -> ViewReadScope:
    return scope_for(viewer_context(
        user_id=user_id, ws_perms={workspace_id: ("workspace:admin",)},
    ))


def stranger_scope(user_id: str = "usr_stranger") -> ViewReadScope:
    """Authenticated, but holds no binding anywhere — reaches only
    ``public`` views, their own, and anything explicitly granted."""
    return scope_for(viewer_context(user_id=user_id))


def anonymous_scope() -> ViewReadScope:
    """Reaches nothing."""
    return scope_for(viewer_context(is_anonymous=True))


__all__ = [
    "admin_scope",
    "anonymous_scope",
    "member_scope",
    "scope_for",
    "stranger_scope",
    "viewer_context",
    "workspace_admin_scope",
]
