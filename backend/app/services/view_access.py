"""Access evaluator for Views (view-sharing rework, 2026-07-31).

The visibility tier is the primary gate; explicit grants are additive;
workspace membership matters only for the ``workspace`` tier. This
replaces the original "any of three layers" union, whose
membership-first ordering made ``private`` behave exactly like
``workspace`` for every member — the private-view leak.

  ``private``    → creator, explicit grants, workspace admins
  ``workspace``  → the above + ``workspace:view:read`` holders in the
                   view's workspace
  ``enterprise`` → any authenticated user
  anonymous      → nothing, ever
  unknown tier   → falls closed (only system:admin passes)

``system:org-admin`` reaches private views via the ``workspace:admin``
short-circuit inside ``has_permission``; ``system:org-viewer`` reaches
the ``workspace`` tier everywhere (its ``*:read`` short-circuit) but
never ``private``.

Mutations:

  * edit          → creator ∨ ``workspace:view:edit`` ∨ ``editor`` grant
  * delete        → creator ∨ ``workspace:view:delete``
  * hard delete   → ``workspace:admin``
  * restore       → ``workspace:admin``
  * visibility    → creator ∨ ``workspace:admin`` (base rule); any
                    transition to/from ``enterprise`` additionally
                    requires ``workspace:view:publish`` (``can_publish``)
  * manage grants → creator ∨ ``workspace:admin``

Implementation notes:

  * ``has_permission`` already understands the global-admin shortcuts
    and wildcard expansion, so callers don't special-case admins.
  * Grant lookups are memoized on the ``ViewerContext`` — one query per
    request no matter how many views are checked.
  * ``readable_views_clause`` renders the same read rule as SQL so list
    endpoints filter in the database (correct pagination, no
    post-filtering); ``test_view_access_matrix`` holds the two
    renderings together.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import sqlalchemy as sa
from sqlalchemy import and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

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

    Build once per request via ``ViewerContext.build(...)``. The grant
    index is fetched lazily on first use and cached on the instance,
    so checking N views costs one grants query.
    """
    user_id: str
    claims: PermissionClaims
    group_ids: tuple[str, ...]
    is_anonymous: bool = False
    # Lazily-built {view_id: (role_name, ...)} cache. Excluded from
    # eq/repr; mutated via object.__setattr__ because the dataclass is
    # frozen.
    _grant_cache: Optional[dict[str, tuple[str, ...]]] = field(
        default=None, compare=False, repr=False,
    )

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

    async def grant_index(
        self, session: AsyncSession,
    ) -> dict[str, tuple[str, ...]]:
        """``{view_id: (role_name, ...)}`` for every view grant the
        caller holds directly or via a group."""
        if self.is_anonymous or not self.user_id:
            return {}
        if self._grant_cache is None:
            grants = await grant_repo.list_grants_for_user_with_groups(
                session,
                user_id=self.user_id,
                group_ids=list(self.group_ids),
                resource_type="view",
            )
            built: dict[str, list[str]] = {}
            for g in grants:
                built.setdefault(g.resource_id, []).append(g.role_name)
            object.__setattr__(
                self,
                "_grant_cache",
                {k: tuple(v) for k, v in built.items()},
            )
        return self._grant_cache or {}


# ── Internal predicates ──────────────────────────────────────────────

def _is_workspace_member(ctx: ViewerContext, view: ViewORM) -> bool:
    """True if the user holds ``workspace:view:read`` in the view's
    workspace (direct, via wildcard, or via an org-level short-circuit)."""
    return has_permission(
        ctx.claims, "workspace:view:read", workspace_id=view.workspace_id,
    )


def _has_private_reach(ctx: ViewerContext, view: ViewORM) -> bool:
    """Creator or workspace admin — the identities that reach a view
    regardless of its tier."""
    if not ctx.is_anonymous and view.created_by == ctx.user_id:
        return True
    return has_permission(
        ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
    )


async def _grant_roles(
    session: AsyncSession, ctx: ViewerContext, view: ViewORM,
) -> tuple[str, ...]:
    index = await ctx.grant_index(session)
    return index.get(view.id, ())


# ── Public predicates (one per action) ───────────────────────────────

async def can_read_view(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
) -> bool:
    if ctx.is_anonymous:
        return False
    if has_permission(ctx.claims, "system:admin"):
        return True
    visibility = view.visibility or "private"
    if visibility == "enterprise":
        # Any authenticated user.
        return True
    if visibility not in ("private", "workspace"):
        # Unknown enum value → fall closed.
        return False
    if _has_private_reach(ctx, view):
        return True
    if visibility == "workspace" and _is_workspace_member(ctx, view):
        return True
    # Explicit grants extend access regardless of membership (any role).
    return bool(await _grant_roles(session, ctx, view))


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
    return "editor" in await _grant_roles(session, ctx, view)


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
    """Creator or workspace admin can change the visibility tier.

    This is the base rule (private ↔ workspace). Any transition to or
    from ``enterprise`` must ALSO pass ``can_publish`` — enforced at
    the endpoint, which knows both sides of the transition.
    """
    if has_permission(ctx.claims, "system:admin"):
        return True
    if not ctx.is_anonymous and view.created_by == ctx.user_id:
        return True
    return has_permission(
        ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
    )


def can_publish(ctx: ViewerContext, view: ViewORM) -> bool:
    """May the caller move this view to/from ``enterprise`` visibility?

    Publishing exposes the view — and read-only access to its data
    source — to every signed-in user, so it rides on a dedicated
    permission rather than creatorship."""
    return has_permission(
        ctx.claims, "workspace:view:publish", workspace_id=view.workspace_id,
    )


def can_publish_in_workspace(
    claims: PermissionClaims, workspace_id: str,
) -> bool:
    """``can_publish`` for creation time, before a ``ViewORM`` exists."""
    return has_permission(
        claims, "workspace:view:publish", workspace_id=workspace_id,
    )


def can_manage_grants(ctx: ViewerContext, view: ViewORM) -> bool:
    """Creator or workspace admin manage explicit shares. An ``editor``
    grant lets you edit the view, never re-share it."""
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


async def compute_access_envelope(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
) -> dict:
    """The caller's capability envelope for one view (camelCase keys,
    ready for ``ViewAccessInfo``). Call only after ``can_read_view``
    passed — ``accessVia`` assumes some path granted read.

    ``accessVia`` precedence (most to least specific): owner → admin →
    grant → workspace → enterprise. ``dataAccess`` is 'full' only when
    the data plane would accept graph mutations from this caller
    (``workspace:datasource:manage``) — everyone else, including
    ``editor`` grantees, is 'readonly'.
    """
    claims = ctx.claims
    is_creator = not ctx.is_anonymous and view.created_by == ctx.user_id
    is_admin = has_permission(claims, "system:admin") or has_permission(
        claims, "workspace:admin", workspace_id=view.workspace_id,
    )
    grant_roles = await _grant_roles(session, ctx, view)
    if is_creator:
        via = "owner"
    elif is_admin:
        via = "admin"
    elif grant_roles:
        via = "grant"
    elif view.visibility == "workspace" and _is_workspace_member(ctx, view):
        via = "workspace"
    else:
        via = "enterprise"
    return {
        "canEdit": await can_edit_view(session, ctx, view),
        "canManageGrants": can_manage_grants(ctx, view),
        "canChangeVisibility": can_change_visibility(ctx, view),
        "canPublish": can_publish(ctx, view),
        "accessVia": via,
        "dataAccess": (
            "full"
            if has_permission(
                claims, "workspace:datasource:manage",
                workspace_id=view.workspace_id,
            )
            else "readonly"
        ),
    }


# ── Read scope → SQL ─────────────────────────────────────────────────

@dataclass(frozen=True)
class ViewReadScope:
    """The caller's read reach, flattened for SQL rendering.

    Org-level roles don't enumerate workspace ids in their claims —
    their reach is expressed as flags (``unrestricted`` /
    ``org_viewer``) that relax the clause instead of expanding it.
    """
    authenticated: bool
    unrestricted: bool            # system:admin ∨ system:org-admin
    org_viewer: bool              # workspace-tier reach in every workspace
    user_id: str
    member_ws_ids: tuple[str, ...]
    admin_ws_ids: tuple[str, ...]
    granted_view_ids: tuple[str, ...]


async def build_read_scope(
    session: AsyncSession, ctx: ViewerContext,
) -> ViewReadScope:
    if ctx.is_anonymous or not ctx.user_id:
        return ViewReadScope(
            authenticated=False, unrestricted=False, org_viewer=False,
            user_id="", member_ws_ids=(), admin_ws_ids=(),
            granted_view_ids=(),
        )
    claims = ctx.claims
    unrestricted = (
        "system:admin" in claims.global_perms
        or "system:org-admin" in claims.global_perms
    )
    org_viewer = "system:org-viewer" in claims.global_perms
    member_ws = tuple(
        ws for ws in claims.ws_perms
        if has_permission(claims, "workspace:view:read", workspace_id=ws)
    )
    admin_ws = tuple(
        ws for ws in claims.ws_perms
        if has_permission(claims, "workspace:admin", workspace_id=ws)
    )
    granted = tuple((await ctx.grant_index(session)).keys())
    return ViewReadScope(
        authenticated=True,
        unrestricted=unrestricted,
        org_viewer=org_viewer,
        user_id=ctx.user_id,
        member_ws_ids=member_ws,
        admin_ws_ids=admin_ws,
        granted_view_ids=granted,
    )


def readable_views_clause(scope: ViewReadScope) -> ColumnElement[bool]:
    """SQL rendering of ``can_read_view`` for list/aggregate queries.

    Composable with any other WHERE on ``ViewORM``. Empty ``.in_(())``
    renders as a static false, so empty scopes are safe.
    """
    if not scope.authenticated:
        return sa.false()
    if scope.unrestricted:
        return sa.true()
    workspace_tier: ColumnElement[bool] = ViewORM.visibility == "workspace"
    if not scope.org_viewer:
        workspace_tier = and_(
            workspace_tier,
            ViewORM.workspace_id.in_(scope.member_ws_ids),
        )
    return or_(
        ViewORM.visibility == "enterprise",
        workspace_tier,
        ViewORM.created_by == scope.user_id,
        ViewORM.workspace_id.in_(scope.admin_ws_ids),
        ViewORM.id.in_(scope.granted_view_ids),
    )


__all__ = [
    "ViewerContext",
    "ViewReadScope",
    "build_read_scope",
    "readable_views_clause",
    "compute_access_envelope",
    "can_read_view",
    "can_edit_view",
    "can_delete_view",
    "can_hard_delete_view",
    "can_change_visibility",
    "can_publish",
    "can_publish_in_workspace",
    "can_manage_grants",
    "can_restore_view",
]
