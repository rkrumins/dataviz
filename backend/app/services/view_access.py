"""Access evaluator for Views.

**Visibility is authoritative.** A view's tier decides who can reach it;
explicit ``resource_grants`` extend that set for named subjects. Nothing
else grants read.

  ``private``    creator + workspace admins of the view's workspace
  ``workspace``  + anyone holding ``workspace:view:read`` there
  ``enterprise`` + anyone holding a binding in *any* workspace
  ``public``     + any authenticated account, binding or not

The tiers form a strictly widening ladder — see
``backend/common/view_visibility.py`` for why ``enterprise`` is defined as
"has a binding somewhere" rather than "is authenticated", and why
``public`` stops at authenticated rather than anonymous.

What changed and why
--------------------
This module used to evaluate three *independent* layers and grant read if
ANY passed, where Layer 1 was "the caller holds ``workspace:view:read`` in
the view's workspace" — checked without reference to the tier. The effect
was that workspace membership alone opened every view in that workspace,
so ``private`` was indistinguishable from ``workspace`` for anyone inside
it. That is the "private views are visible to others" report, and it was
codified as intended behaviour in ``test_api_rbac_phase2.py``.

Workspace membership is now the *implementation of the ``workspace``
tier* rather than a parallel path around it.

Reasons, not booleans
---------------------
``read_decision`` returns **why** access was granted. Nothing in the
product could previously answer "why can I see this view?", which is why
diagnosing the leak needed a code audit rather than a glance at the UI.
The reason rides out on ``ViewResponse.grantedBy``.

Two evaluation surfaces
-----------------------
* ``read_decision`` / ``can_read_view`` — one view, already loaded.
* ``build_read_scope`` + ``readable_views_predicate`` — the same rules as
  a SQL predicate, so list queries filter in the database. Filtering in
  Python after the query (the previous design) made ``total``/``hasMore``
  over-report, broke pagination, and left every repo function that
  *wasn't* the list endpoint unfiltered by default.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Sequence

from sqlalchemy import ColumnElement, and_, false, or_, true
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import grant_repo, user_repo
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
)
from backend.auth_service.interface import User
from backend.common.view_visibility import DEFAULT_VISIBILITY, ViewVisibility


#: Why a caller can read a view. Surfaced to the FE as ``grantedBy``.
ReadReason = Literal[
    "system-admin",
    "creator",
    "workspace-admin",
    "grant",
    "tier:workspace",
    "tier:enterprise",
    "tier:public",
]


@dataclass(frozen=True)
class ReadDecision:
    """Outcome of a read check, with the branch that allowed it."""
    allowed: bool
    reason: Optional[ReadReason] = None
    #: A denial reached by consulting workspace grants that no source
    #: could supply — an unanswered question, not a refusal. Callers that
    #: turn this into HTTP must answer 503; see ``_denied`` below.
    indeterminate: bool = False

    def __bool__(self) -> bool:  # lets callers keep using it as a predicate
        return self.allowed


DENIED = ReadDecision(allowed=False)


def _denied(ctx: ViewerContext) -> ReadDecision:
    """A refusal — or an admission that we could not tell.

    Per-workspace grants live in the session store rather than the access
    token, so ``PermissionClaims.ws_available`` is ``False`` when neither
    Redis nor the database could answer. An empty ``ws_perms`` then says
    nothing about the caller, and every tier below ``public`` is decided
    against it. Reporting that as a plain denial states as fact something
    the server never established.

    Deliberately blunt: any denial for a signed-in caller with unreadable
    grants is indeterminate, rather than tracking which branch of the
    ladder happened to consult the map. It over-reports only during a real
    store *and* database outage, where "ask again" is the honest answer
    anyway, and it cannot be wrong in the direction that leaks a view.
    """
    if ctx.is_anonymous or ctx.claims.ws_available:
        return DENIED
    return ReadDecision(allowed=False, indeterminate=True)


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


# ── Claim introspection ──────────────────────────────────────────────

class _AllWorkspaces:
    """Sentinel: the caller holds the permission in *every* workspace via
    a global shortcut, so there is no finite id set to enumerate."""
    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<all workspaces>"


ALL_WORKSPACES = _AllWorkspaces()


def _workspaces_with(
    claims: PermissionClaims, permission: str,
) -> _AllWorkspaces | frozenset[str]:
    """Workspaces where ``claims`` grant ``permission``.

    Mirrors the short-circuit ladder in ``has_permission`` — ``system:admin``
    and ``system:org-admin`` reach every workspace, and ``system:org-viewer``
    reaches every workspace for ``:read`` permissions only. Those cases
    return the sentinel because the id set is unbounded; everything else
    enumerates the claim's own buckets.
    """
    global_perms = claims.global_perms
    if "system:admin" in global_perms or "system:org-admin" in global_perms:
        return ALL_WORKSPACES
    if permission.endswith(":read") and "system:org-viewer" in global_perms:
        return ALL_WORKSPACES
    return frozenset(
        ws_id for ws_id in claims.ws_perms
        if has_permission(claims, permission, workspace_id=ws_id)
    )


def _can_read_in_workspace(claims: PermissionClaims, workspace_id: str) -> bool:
    """Whether the caller can read views in ``workspace_id``.

    ``workspace:admin`` counts, explicitly, rather than only via the
    resolver's auto-implication of every ``workspace:*`` leaf at login.
    Depending on that expansion would make this module correct only for
    claims that came through ``resolve()`` — and would break the ladder
    for any that didn't, since ``workspace:admin`` reaches the *narrower*
    ``private`` tier directly. An admin who could read private views but
    not workspace-tier ones is not a policy anyone would choose.
    """
    return (
        has_permission(claims, "workspace:view:read", workspace_id=workspace_id)
        or has_permission(claims, "workspace:admin", workspace_id=workspace_id)
    )


def _workspaces_readable(
    claims: PermissionClaims,
) -> _AllWorkspaces | frozenset[str]:
    """SQL-side counterpart of ``_can_read_in_workspace``."""
    by_read = _workspaces_with(claims, "workspace:view:read")
    by_admin = _workspaces_with(claims, "workspace:admin")
    if by_read is ALL_WORKSPACES or by_admin is ALL_WORKSPACES:
        return ALL_WORKSPACES
    return by_read | by_admin


def _has_any_workspace_binding(ctx: ViewerContext) -> bool:
    """True when the caller belongs to the organisation — i.e. holds at
    least one workspace binding, or a global shortcut that stands in for
    one. This is what the ``enterprise`` tier means here; see
    ``common/view_visibility.py`` for why there is no organisations table
    to consult instead.

    An empty bucket doesn't count: a binding whose permissions were all
    dropped by the resolver's category filter grants nothing.
    """
    if ctx.is_anonymous:
        return False
    global_perms = ctx.claims.global_perms
    if any(
        p in global_perms
        for p in ("system:admin", "system:org-admin", "system:org-viewer")
    ):
        return True
    return any(perms for perms in ctx.claims.ws_perms.values())


# ── Single-view evaluation ───────────────────────────────────────────

def _visibility_reach(ctx: ViewerContext, view: ViewORM) -> Optional[ReadReason]:
    """The tier's own verdict, and which branch of it applied.

    Returns ``None`` when the tier does not reach this caller — an
    explicit grant may still let them in, which the caller checks next.
    """
    visibility = view.visibility or DEFAULT_VISIBILITY

    # Creator always reaches their own view, at every tier.
    if not ctx.is_anonymous and ctx.user_id and view.created_by == ctx.user_id:
        return "creator"

    if visibility == ViewVisibility.PRIVATE:
        if has_permission(
            ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
        ):
            return "workspace-admin"
        return None

    if visibility == ViewVisibility.WORKSPACE:
        if _can_read_in_workspace(ctx.claims, view.workspace_id):
            return "tier:workspace"
        return None

    if visibility == ViewVisibility.ENTERPRISE:
        return "tier:enterprise" if _has_any_workspace_binding(ctx) else None

    if visibility == ViewVisibility.PUBLIC:
        return "tier:public" if not ctx.is_anonymous else None

    # Unknown enum value → fall closed.
    return None


async def _has_explicit_grant(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
    *,
    require_role: Optional[str] = None,
) -> bool:
    """``resource_grants`` lookup: does the user have an explicit grant on
    this view, directly or via a group? When ``require_role`` is set the
    grant must be at least that role (``editor`` implies ``viewer``).
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


async def read_decision(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
) -> ReadDecision:
    """Can this caller read this view, and why?

    Order is "cheapest and most explanatory first": the tier check is pure
    claim arithmetic, so the ``resource_grants`` query only runs for
    callers the tier doesn't already reach.
    """
    if has_permission(ctx.claims, "system:admin"):
        return ReadDecision(True, "system-admin")
    reason = _visibility_reach(ctx, view)
    if reason is not None:
        return ReadDecision(True, reason)
    if await _has_explicit_grant(session, ctx, view):
        return ReadDecision(True, "grant")
    return _denied(ctx)


async def can_read_view(
    session: AsyncSession,
    ctx: ViewerContext,
    view: ViewORM,
) -> bool:
    """Boolean form of ``read_decision`` — the shape most call sites want."""
    return (await read_decision(session, ctx, view)).allowed


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
    return await _has_explicit_grant(
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


# ── SQL-side evaluation ──────────────────────────────────────────────

@dataclass(frozen=True)
class ViewReadScope:
    """A caller's read reach, resolved once so it can be turned into SQL.

    ``grant_view_ids`` is the one part that needs a query; everything else
    is claim arithmetic. Build it per request and reuse it across the list
    query, its COUNT, the facets aggregation and the stats aggregation, so
    all four describe exactly the same population.
    """
    ctx: ViewerContext
    grant_view_ids: tuple[str, ...] = ()
    #: The workspace half of this scope could not be established, so the
    #: predicate below would silently narrow the list rather than filter
    #: it. See ``_denied`` — the same distinction, on the SQL surface.
    #:
    #: This one matters more than the single-view case. A denial at least
    #: tells the caller something happened; a list quietly missing rows
    #: renders as an ordinary, successful, wrong page. Endpoints must
    #: answer 503 rather than serve it.
    indeterminate: bool = False


async def build_read_scope(
    session: AsyncSession, ctx: ViewerContext,
) -> ViewReadScope:
    """Resolve ``ctx`` into a scope, loading explicit grants once."""
    if ctx.is_anonymous or not ctx.user_id:
        # No workspace reach to lose, so nothing unknown was needed.
        return ViewReadScope(ctx=ctx)
    if has_permission(ctx.claims, "system:admin"):
        # The predicate short-circuits to TRUE; skip the query entirely.
        # Decided by the token's global claims alone, so an unreachable
        # session store cannot make this answer wrong.
        return ViewReadScope(ctx=ctx)
    grants = await grant_repo.list_grants_for_user_with_groups(
        session,
        user_id=ctx.user_id,
        group_ids=list(ctx.group_ids),
        resource_type="view",
    )
    return ViewReadScope(
        ctx=ctx,
        grant_view_ids=tuple({g.resource_id for g in grants}),
        indeterminate=not ctx.claims.ws_available,
    )


def readable_views_predicate(scope: ViewReadScope) -> ColumnElement[bool]:
    """The read rules as a SQL predicate over ``ViewORM``.

    Mirrors ``read_decision`` exactly. Any divergence between the two is a
    bug: the single-view check would allow something the list hides, or
    worse, the list would surface something the detail route refuses.
    ``tests/test_view_visibility_matrix.py`` asserts they agree across the
    full tier × caller matrix.
    """
    ctx = scope.ctx
    if has_permission(ctx.claims, "system:admin"):
        return true()

    clauses: list[ColumnElement[bool]] = []

    # Creator — reaches their own views at every tier.
    if not ctx.is_anonymous and ctx.user_id:
        clauses.append(ViewORM.created_by == ctx.user_id)

    # Explicit grants — additive, independent of tier and workspace.
    if scope.grant_view_ids:
        clauses.append(ViewORM.id.in_(sorted(scope.grant_view_ids)))

    if not ctx.is_anonymous:
        clauses.append(ViewORM.visibility == ViewVisibility.PUBLIC.value)
        if _has_any_workspace_binding(ctx):
            clauses.append(ViewORM.visibility == ViewVisibility.ENTERPRISE.value)

    read_ws = _workspaces_readable(ctx.claims)
    if read_ws is ALL_WORKSPACES:
        clauses.append(ViewORM.visibility == ViewVisibility.WORKSPACE.value)
    elif read_ws:
        clauses.append(and_(
            ViewORM.visibility == ViewVisibility.WORKSPACE.value,
            ViewORM.workspace_id.in_(sorted(read_ws)),
        ))

    admin_ws = _workspaces_with(ctx.claims, "workspace:admin")
    if admin_ws is ALL_WORKSPACES:
        clauses.append(ViewORM.visibility == ViewVisibility.PRIVATE.value)
    elif admin_ws:
        clauses.append(and_(
            ViewORM.visibility == ViewVisibility.PRIVATE.value,
            ViewORM.workspace_id.in_(sorted(admin_ws)),
        ))

    if not clauses:
        # Anonymous, or an account with no bindings and no grants. Reaches
        # nothing — fall closed rather than degrade to "no filter".
        return false()
    return or_(*clauses)


async def annotate_read_reasons(
    session: AsyncSession,
    ctx: ViewerContext,
    views: Sequence[ViewORM],
) -> dict[str, ReadReason]:
    """Map view id → why the caller can read it, for a batch of views.

    Used to stamp ``grantedBy`` on list responses. The grant lookup runs
    once for the whole batch rather than once per view.
    """
    if has_permission(ctx.claims, "system:admin"):
        return {v.id: "system-admin" for v in views}

    out: dict[str, ReadReason] = {}
    needs_grant_check: list[ViewORM] = []
    for view in views:
        reason = _visibility_reach(ctx, view)
        if reason is not None:
            out[view.id] = reason
        else:
            needs_grant_check.append(view)

    if needs_grant_check and not ctx.is_anonymous and ctx.user_id:
        grants = await grant_repo.list_grants_for_user_with_groups(
            session,
            user_id=ctx.user_id,
            group_ids=list(ctx.group_ids),
            resource_type="view",
        )
        granted = {g.resource_id for g in grants}
        for view in needs_grant_check:
            if view.id in granted:
                out[view.id] = "grant"
    return out


__all__ = [
    "ALL_WORKSPACES",
    "ReadDecision",
    "ReadReason",
    "ViewReadScope",
    "ViewerContext",
    "annotate_read_reasons",
    "build_read_scope",
    "can_change_visibility",
    "can_delete_view",
    "can_edit_view",
    "can_hard_delete_view",
    "can_read_view",
    "can_restore_view",
    "read_decision",
    "readable_views_predicate",
]
