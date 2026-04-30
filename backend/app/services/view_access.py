"""Three-layer access evaluator for Views (RBAC Phase 2C).

The view access matrix from the design plan:

  Layer 1 — Workspace binding
    The user holds ``workspace:view:read`` (or higher) in the view's
    workspace via a direct or group binding.

  Layer 2 — Visibility tier
    ``private``    → creator + workspace admins of the view's workspace
    ``workspace``  → anyone with any binding into the view's workspace
    ``enterprise`` → any authenticated user

  Layer 3 — Explicit ``resource_grants``
    Additive: a grant on (view_id, subject) extends access regardless
    of workspace membership. Editor implies read; viewer implies read
    only.

A view is **readable** when ANY of the three layers grants access.
Mutating actions (edit / delete / change-visibility) check stronger
predicates that combine creator-of and workspace permissions, plus the
explicit ``editor`` grant for the edit case.

Implementation notes:

  * ``has_permission`` (from ``permission_service``) already understands
    the global-admin shortcut and wildcard expansion, so callers don't
    need to special-case admins.
  * Layer 3 lookups go through ``grant_repo``. They run only when
    Layers 1 and 2 fail — keeps the hot path fast.
  * Group memberships needed for Layer 3 are fetched once per request
    and reused across multiple view checks (callers pre-load).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import grant_repo, user_repo
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
)
from backend.auth_service.interface import User


# ── Caller context ───────────────────────────────────────────────────

@dataclass(frozen=True)
class ViewerContext:
    """Everything the evaluator needs to decide on one or many views.

    Build once per request via ``ViewerContext.build(...)`` so the
    caller doesn't pay the group-membership lookup more than once
    when filtering a list of views.
    """
    user_id: str
    claims: PermissionClaims
    group_ids: tuple[str, ...]
    is_anonymous: bool = False

    @classmethod
    async def build(
        cls,
        session: AsyncSession,
        *,
        user: Optional[User],
        claims: PermissionClaims,
    ) -> "ViewerContext":
        if user is None:
            return cls(
                user_id="",
                claims=claims,
                group_ids=(),
                is_anonymous=True,
            )
        groups = await user_repo.get_groups_for_user(session, user.id)
        return cls(
            user_id=user.id,
            claims=claims,
            group_ids=tuple(groups),
        )


# ── Layer predicates ─────────────────────────────────────────────────

def _layer1_workspace_member(ctx: ViewerContext, view: ViewORM) -> bool:
    """True if the user has at least ``workspace:view:read`` in the
    view's workspace."""
    return has_permission(
        ctx.claims, "workspace:view:read", workspace_id=view.workspace_id,
    )


def _layer2_visibility(ctx: ViewerContext, view: ViewORM) -> bool:
    """Visibility-tier reach for the user.

    Implements the redefined enum semantics from the design plan.
    """
    visibility = view.visibility or "private"
    if visibility == "private":
        # Creator can always read their private view.
        if not ctx.is_anonymous and view.created_by == ctx.user_id:
            return True
        # Workspace admins of the same workspace see private views too.
        return has_permission(
            ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
        )
    if visibility == "workspace":
        return _layer1_workspace_member(ctx, view)
    if visibility == "enterprise":
        # Any authenticated user.
        return not ctx.is_anonymous
    # Unknown enum value → fall closed.
    return False


async def _layer3_explicit_grant(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
    *,
    require_role: Optional[str] = None,
) -> bool:
    """``resource_grants`` lookup: does the user have any explicit grant
    on this view? When ``require_role`` is set, the grant must be at
    least that role (only ``editor`` qualifies for an editor check;
    ``viewer`` always qualifies for read).
    """
    if ctx.is_anonymous or not ctx.user_id:
        return False
    grants = await grant_repo.list_grants_for_user_with_groups(
        session,
        user_id=ctx.user_id,
        group_ids=list(ctx.group_ids),
        resource_type="view",
    )
    relevant = [g for g in grants if g.resource_id == view.id]
    if not relevant:
        return False
    if require_role is None:
        return True
    if require_role == "viewer":
        return any(g.role_name in ("viewer", "editor") for g in relevant)
    if require_role == "editor":
        return any(g.role_name == "editor" for g in relevant)
    return False


# ── Public predicates (one per action) ───────────────────────────────

async def can_read_view(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
) -> bool:
    """The union of Layers 1, 2, and 3."""
    if has_permission(ctx.claims, "system:admin"):
        return True
    if _layer1_workspace_member(ctx, view):
        return True
    if _layer2_visibility(ctx, view):
        return True
    return await _layer3_explicit_grant(session, ctx, view)


async def can_edit_view(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
) -> bool:
    """Creator, workspace editor, or explicit ``editor`` grant."""
    if has_permission(ctx.claims, "system:admin"):
        return True
    if not ctx.is_anonymous and view.created_by == ctx.user_id:
        return True
    if has_permission(
        ctx.claims, "workspace:view:edit", workspace_id=view.workspace_id,
    ):
        return True
    return await _layer3_explicit_grant(
        session, ctx, view, require_role="editor",
    )


def can_delete_view(ctx: ViewerContext, view: ViewORM) -> bool:
    """Soft-delete: creator or workspace ``view:delete`` permission.

    Resource grants do NOT confer delete — see the design plan's
    action matrix. Hard-delete (``permanent=true``) requires
    ``workspace:admin`` and is gated by ``can_hard_delete_view``.
    """
    if has_permission(ctx.claims, "system:admin"):
        return True
    if not ctx.is_anonymous and view.created_by == ctx.user_id:
        return True
    return has_permission(
        ctx.claims, "workspace:view:delete", workspace_id=view.workspace_id,
    )


def can_hard_delete_view(ctx: ViewerContext, view: ViewORM) -> bool:
    """``permanent=true`` deletion is a destructive operation; require
    ``workspace:admin`` (or system admin) regardless of creator."""
    if has_permission(ctx.claims, "system:admin"):
        return True
    return has_permission(
        ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
    )


def can_change_visibility(ctx: ViewerContext, view: ViewORM) -> bool:
    """Creator or workspace admin can change the visibility tier."""
    if has_permission(ctx.claims, "system:admin"):
        return True
    if not ctx.is_anonymous and view.created_by == ctx.user_id:
        return True
    return has_permission(
        ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
    )


def can_restore_view(ctx: ViewerContext, view: ViewORM) -> bool:
    """Restoring a soft-deleted view is a workspace-admin operation —
    matches the action matrix."""
    if has_permission(ctx.claims, "system:admin"):
        return True
    return has_permission(
        ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
    )


# ── Bulk filter helper ───────────────────────────────────────────────

async def filter_readable_views(
    session: AsyncSession,
    ctx: ViewerContext,
    views: Sequence[ViewORM],
) -> list[ViewORM]:
    """Apply ``can_read_view`` to every view; preserve order.

    Pre-fetches Layer-3 grants once when the caller has any group
    memberships so we don't issue one query per view.
    """
    if has_permission(ctx.claims, "system:admin"):
        return list(views)

    # Bulk-load grants once for the user; lookup by view id is O(1).
    grant_index: dict[str, list[str]] = {}
    if not ctx.is_anonymous and ctx.user_id:
        grants = await grant_repo.list_grants_for_user_with_groups(
            session,
            user_id=ctx.user_id,
            group_ids=list(ctx.group_ids),
            resource_type="view",
        )
        for g in grants:
            grant_index.setdefault(g.resource_id, []).append(g.role_name)

    out: list[ViewORM] = []
    for view in views:
        if _layer1_workspace_member(ctx, view):
            out.append(view)
            continue
        if _layer2_visibility(ctx, view):
            out.append(view)
            continue
        if grant_index.get(view.id):
            out.append(view)
            continue
        # No layer granted access → filter out.
    return out


__all__ = [
    "ViewerContext",
    "can_read_view",
    "can_edit_view",
    "can_delete_view",
    "can_hard_delete_view",
    "can_change_visibility",
    "can_restore_view",
    "filter_readable_views",
]


# Help static analysers — Iterable is exported via the type only.
_ = Iterable
