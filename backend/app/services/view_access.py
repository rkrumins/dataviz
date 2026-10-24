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
                    passes the publish ladder — see
                    ``resolve_publish_gate``: platform ceiling, then
                    workspace policy, then source restriction, with
                    ``workspace:view:publish`` satisfying the last two
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
  * Under an API key (``claims.key_scope``) every rule above still has to
    pass, AND the key must admit the view at the matching level: the
    identity paths — creator, explicit grant, enterprise tier — would
    otherwise reach views outside the key's selection or exercise a level
    the key was never given. Keys never manage grants.
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
from backend.common.service_accounts import is_service_account


# ── Caller context ───────────────────────────────────────────────────

def _is_creator(ctx: "ViewerContext", view) -> bool:
    """Whoever made a view keeps it — but a service account only while it still
    holds a role in the view's workspace: its roles are all it has, and a view
    it once made is no way back in."""
    if ctx.is_anonymous or view.created_by != ctx.user_id:
        return False
    return not is_service_account(ctx.user_id) or bool(ctx.claims.ws_perms.get(view.workspace_id))


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

def _key_admits_view(ctx: ViewerContext, view: ViewORM, permission: str) -> bool:
    """Whether the request's API key, if any, reaches this view at this level.

    True for a browser session. For a key, the profile must include
    ``permission`` and the selection must cover the view (all resources,
    its workspace, or the view itself). Checked BEFORE every other rule,
    because the identity paths below grant without consulting permissions.
    """
    scope = ctx.claims.key_scope
    if scope is None:
        return True
    return scope.admits_view(view.id, view.workspace_id, permission)


def _is_workspace_member(ctx: ViewerContext, view: ViewORM) -> bool:
    """True if the user holds ``workspace:view:read`` in the view's
    workspace (direct, via wildcard, or via an org-level short-circuit)."""
    return has_permission(
        ctx.claims, "workspace:view:read", workspace_id=view.workspace_id,
    )


def _has_private_reach(ctx: ViewerContext, view: ViewORM) -> bool:
    """Creator or workspace admin — the identities that reach a view
    regardless of its tier."""
    if _is_creator(ctx, view):
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
    if not _key_admits_view(ctx, view, "workspace:view:read"):
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
    if not _key_admits_view(ctx, view, "workspace:view:edit"):
        return False
    if has_permission(ctx.claims, "system:admin"):
        return True
    if _is_creator(ctx, view):
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
    if not _key_admits_view(ctx, view, "workspace:view:delete"):
        return False
    if has_permission(ctx.claims, "system:admin"):
        return True
    if _is_creator(ctx, view):
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


def can_change_visibility(
    ctx: ViewerContext, view: ViewORM, to: Optional[str] = None,
) -> bool:
    """Creator or workspace admin can change the visibility tier.

    This is the base rule (private ↔ workspace). Any transition to or
    from ``enterprise`` must ALSO pass ``can_publish`` — enforced at
    the endpoint, which knows both sides of the transition.

    Through an API key, the workspace tier takes the key's view write, as
    creating a view there does (``authorize_view_create``); anything to do
    with ``enterprise`` takes its own ``publish``: under an open workspace
    policy this predicate is what lets a creator publish, and a key minted
    to edit views was not minted to share them with everyone. ``to``
    unknown is read as the enterprise tier.
    """
    platform_wide = to in (None, "enterprise") or view.visibility == "enterprise"
    needed = "workspace:view:publish" if platform_wide else "workspace:view:edit"
    if not _key_admits_view(ctx, view, needed):
        return False
    if has_permission(ctx.claims, "system:admin"):
        return True
    if _is_creator(ctx, view):
        return True
    return has_permission(
        ctx.claims, "workspace:admin", workspace_id=view.workspace_id,
    )


def can_publish(ctx: ViewerContext, view: ViewORM) -> bool:
    """May the caller move this view to/from ``enterprise`` visibility?

    Publishing exposes the view — and read-only access to its data
    source — to every signed-in user, so it rides on a dedicated
    permission rather than creatorship."""
    if not _key_admits_view(ctx, view, "workspace:view:publish"):
        return False
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


#: What the deployment allows at most. ``workspaces`` = each workspace
#: decides for itself (the default); ``request`` = every publish goes
#: through an approval, whatever a workspace has set; ``off`` = the tier
#: is withdrawn from new work entirely.
PlatformPolicy = str
PLATFORM_POLICIES: tuple[str, ...] = ("workspaces", "request", "off")

#: Why publishing is not available to this caller right now. Ordered
#: most-general to most-specific — the UI says something different for
#: each, because "an admin has to approve this" and "your organisation
#: does not allow this at all" are not the same sentence.
BlockedBy = Optional[str]  # 'platform' | 'workspace' | 'source' | None


@dataclass(frozen=True)
class PublishGate:
    """The whole publish decision, with its reason.

    One resolver, because this question is asked in four places (the
    visibility endpoint, the create path, the approve path, and the
    capability envelope the UI renders from) and every place that
    answers it separately is a place that can answer it differently.
    Its exact twin lives at ``frontend/src/lib/publishGate.ts`` — a UI
    that resolves this differently tells people the wrong thing about
    the button they are looking at.
    """

    #: Choosing enterprise publishes the view now.
    can_publish: bool
    #: Choosing enterprise files a request for someone else to answer.
    can_request: bool
    #: What is holding publication back, for the sentence shown to the user.
    blocked_by: BlockedBy
    #: The tier exists on this deployment at all. False hides it rather
    #: than disabling it — an option nobody here can ever pick is noise.
    enterprise_available: bool


def resolve_publish_gate(
    ctx: ViewerContext,
    view: ViewORM,
    *,
    policy: Optional[str],
    source_restricted: bool = False,
    platform_policy: Optional[str] = None,
) -> PublishGate:
    """Resolve publishing for one caller on one view.

    The ladder, widest constraint first:

    1. **Platform ceiling** (``enterpriseViewPolicy``). ``off`` withdraws
       the tier from everyone including admins — a deployment that has
       decided lineage never leaves its workspace should not have a
       button that does it. ``request`` forces an approval even in
       workspaces that opened publishing to their members; it is the
       control a workspace admin cannot opt out of.
    2. **Workspace policy**. ``open`` (the default) means anyone who may
       change the view's visibility may take it platform-wide, because
       the graph holds metadata and the product exists to share it.
    3. **Source restriction**. Publishing exposes read-only access to the
       whole source, so the few sources worth a human in the loop carry
       the requirement themselves — the HR warehouse is gated without
       gating the workspace that contains it.
    4. **The permission**. ``workspace:view:publish`` satisfies 2 and 3
       outright: holding it IS the approval. It does not satisfy 1,
       because a ceiling only a non-admin obeys is not a ceiling.

    Unpublishing is deliberately NOT resolved here — see
    ``can_unpublish``. Closing something down must always be possible.
    """
    platform = platform_policy or "workspaces"
    owns_sharing = can_change_visibility(ctx, view)

    if platform == "off":
        # Nothing to route around: there is no one on this deployment who
        # could approve it, so offering the ask would be a dead end.
        return PublishGate(
            can_publish=False, can_request=False,
            blocked_by="platform", enterprise_available=False,
        )

    holds_permission = can_publish(ctx, view)
    if holds_permission:
        return PublishGate(
            can_publish=True, can_request=False,
            blocked_by=None, enterprise_available=True,
        )

    if platform == "request":
        blocked: BlockedBy = "platform"
    elif source_restricted:
        blocked = "source"
    elif (policy or "open") != "open":
        blocked = "workspace"
    else:
        return PublishGate(
            can_publish=owns_sharing, can_request=False,
            blocked_by=None if owns_sharing else "workspace",
            enterprise_available=True,
        )

    # Blocked, but not stuck: whoever owns the view's sharing settings
    # may ask the people who hold the permission.
    return PublishGate(
        can_publish=False, can_request=owns_sharing,
        blocked_by=blocked, enterprise_available=True,
    )


def can_publish_under_policy(
    ctx: ViewerContext,
    view: ViewORM,
    *,
    policy: Optional[str],
    source_restricted: bool = False,
    platform_policy: Optional[str] = None,
) -> bool:
    """May this caller publish right now? Thin read of
    :func:`resolve_publish_gate` for call sites that only need the bit."""
    return resolve_publish_gate(
        ctx, view, policy=policy, source_restricted=source_restricted,
        platform_policy=platform_policy,
    ).can_publish


def can_unpublish(
    ctx: ViewerContext,
    view: ViewORM,
    *,
    policy: Optional[str] = None,
    source_restricted: bool = False,
) -> bool:
    """May this caller take a published view back out of circulation?

    Whoever could have published it can un-publish it: the same standing
    as :func:`resolve_publish_gate`, **minus the platform ceiling**.

    The two halves of that are deliberate. Keeping the workspace policy
    and the source restriction means the rule stays symmetric — a
    workspace that made publishing an admin act made retracting one an
    admin act too, because a view others have come to depend on is not
    something any one member should be able to pull out from under them.

    Dropping the ceiling is the asymmetry that matters. That setting
    exists to reduce exposure; applying it in reverse would mean a
    deployment switching to ``off`` strands every view it had already
    published, with nobody able to close them — the exact opposite of
    what an administrator reaching for it wants.
    """
    return resolve_publish_gate(
        ctx, view, policy=policy, source_restricted=source_restricted,
        platform_policy="workspaces",
    ).can_publish


def can_request_publish(ctx: ViewerContext, view: ViewORM) -> bool:
    """May this caller ASK for the view to be published?

    Same bar as changing visibility (creator or workspace admin): if you
    own the view's sharing settings you may ask for the one setting you
    cannot set yourself. Asking grants nothing on its own.
    """
    return can_change_visibility(ctx, view)


def can_answer_publish_request(ctx: ViewerContext, view: ViewORM) -> bool:
    """May this caller approve or deny a pending request? Approving
    performs the publish, so it takes exactly the publish permission."""
    return can_publish(ctx, view)


def can_withdraw_publish_request(ctx: ViewerContext, view: ViewORM) -> bool:
    """May this caller take a pending request back? Whoever made it, or
    anyone who could have answered it. Through an API key, only one that
    could have made it: withdrawing is the same sharing decision."""
    if not _key_admits_view(ctx, view, "workspace:view:publish"):
        return False
    return view.publish_requested_by == ctx.user_id or can_answer_publish_request(ctx, view)


def can_manage_grants(ctx: ViewerContext, view: ViewORM) -> bool:
    """Creator or workspace admin manage explicit shares. An ``editor``
    grant lets you edit the view, never re-share it. Never through an API
    key: sharing hands access to other people, which no key is for."""
    if ctx.claims.key_scope is not None:
        return False
    if has_permission(ctx.claims, "system:admin"):
        return True
    if _is_creator(ctx, view):
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
    *,
    workspace_policy: Optional[str] = None,
    source_restricted: bool = False,
    platform_policy: Optional[str] = None,
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
    is_creator = _is_creator(ctx, view)
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
    gate = resolve_publish_gate(
        ctx, view, policy=workspace_policy, source_restricted=source_restricted,
        platform_policy=platform_policy,
    )
    # A published view can always be taken back out of circulation, even
    # where the deployment has since withdrawn the tier — otherwise
    # switching the platform to 'off' strands everything already out
    # there with nobody able to close it.
    already_published = view.visibility == "enterprise"
    return {
        "canEdit": await can_edit_view(session, ctx, view),
        "canManageGrants": can_manage_grants(ctx, view),
        "canChangeVisibility": can_change_visibility(ctx, view),
        "canPublish": gate.can_publish or (
            already_published
            and can_unpublish(
                ctx, view, policy=workspace_policy,
                source_restricted=source_restricted,
            )
        ),
        # Can't publish, but may ask someone who can — this is what turns
        # the greyed-out Enterprise tile into a route rather than a wall.
        "canRequestPublish": gate.can_request,
        # WHY it's blocked, so the UI can say whether the organisation,
        # the workspace, or the data source is the one asking. Without
        # this the same grey tile means three different things.
        "publishBlockedBy": gate.blocked_by,
        "enterpriseAvailable": gate.enterprise_available or already_published,
        "canAnswerPublishRequest": can_answer_publish_request(ctx, view),
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
    #: Under an API key limited to particular resources, the views it may
    #: list are those in ``key_workspace_ids`` or named in ``key_view_ids``,
    #: on top of everything above. ``None`` = no such limit.
    key_workspace_ids: Optional[tuple[str, ...]] = None
    key_view_ids: Optional[tuple[str, ...]] = None
    #: An API key whose profile reads no views at all.
    key_blind: bool = False
    #: Where the caller holds any role: a service account's own views count
    #: only there (``_is_creator``).
    role_ws_ids: tuple[str, ...] = ()


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
    key = claims.key_scope
    if key is not None and not key.allows("workspace:view:read"):
        return ViewReadScope(
            authenticated=True, unrestricted=False, org_viewer=False,
            user_id=ctx.user_id, member_ws_ids=(), admin_ws_ids=(),
            granted_view_ids=(), key_blind=True,
        )
    unrestricted = (
        "system:admin" in claims.global_perms
        or "system:org-admin" in claims.global_perms
    )
    # A key over everything, owned by an organisation-wide operator, reads the
    # workspace tier everywhere — the org-viewer reach, never more: its
    # claims carry no global permission, so private views stay private.
    org_viewer = "system:org-viewer" in claims.global_perms or bool(
        key is not None and key.org_wide
    )
    member_ws = tuple(
        ws for ws in claims.ws_perms
        if has_permission(claims, "workspace:view:read", workspace_id=ws)
    )
    admin_ws = tuple(
        ws for ws in claims.ws_perms
        if has_permission(claims, "workspace:admin", workspace_id=ws)
    )
    granted = tuple((await ctx.grant_index(session)).keys())
    key_ws: Optional[tuple[str, ...]] = None
    key_views: Optional[tuple[str, ...]] = None
    if key is not None and not key.all_resources:
        key_ws = tuple(sorted(key.workspaces))
        key_views = tuple(sorted(
            v for v in key.view_ids if v in key.view_workspaces
        ))
    return ViewReadScope(
        authenticated=True,
        unrestricted=unrestricted,
        org_viewer=org_viewer,
        user_id=ctx.user_id,
        member_ws_ids=member_ws,
        admin_ws_ids=admin_ws,
        granted_view_ids=granted,
        key_workspace_ids=key_ws,
        key_view_ids=key_views,
        role_ws_ids=tuple(ws for ws, perms in claims.ws_perms.items() if perms),
    )


def readable_views_clause(scope: ViewReadScope) -> ColumnElement[bool]:
    """SQL rendering of ``can_read_view`` for list/aggregate queries.

    Composable with any other WHERE on ``ViewORM``. Empty ``.in_(())``
    renders as a static false, so empty scopes are safe.
    """
    if not scope.authenticated or scope.key_blind:
        return sa.false()
    if scope.unrestricted:
        clause: ColumnElement[bool] = sa.true()
    else:
        workspace_tier: ColumnElement[bool] = ViewORM.visibility == "workspace"
        if not scope.org_viewer:
            workspace_tier = and_(
                workspace_tier,
                ViewORM.workspace_id.in_(scope.member_ws_ids),
            )
        mine: ColumnElement[bool] = ViewORM.created_by == scope.user_id
        if is_service_account(scope.user_id):
            mine = and_(mine, ViewORM.workspace_id.in_(scope.role_ws_ids))
        clause = or_(
            ViewORM.visibility == "enterprise",
            workspace_tier,
            mine,
            ViewORM.workspace_id.in_(scope.admin_ws_ids),
            ViewORM.id.in_(scope.granted_view_ids),
        )
    if scope.key_workspace_ids is not None:
        clause = and_(clause, or_(
            ViewORM.workspace_id.in_(scope.key_workspace_ids),
            ViewORM.id.in_(scope.key_view_ids or ()),
        ))
    return clause


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
    "can_publish_under_policy",
    "can_request_publish",
    "can_answer_publish_request",
    "can_manage_grants",
    "can_restore_view",
]
