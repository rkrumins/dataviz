"""Who is asking, and therefore what they may be told.

Analytics has two audiences and one document. An administrator or auditor sees
everything; with ``analyticsPublicEnabled`` on, everyone else sees the same
platform-wide shape with the parts that identify people and private workspaces
removed.

THE RULE, STATED ONCE
---------------------
Aggregates are public; identities are not.

  * **Counts and trends cover the whole platform**, including workspaces the
    viewer cannot open. "How is this platform growing" is the question the
    section exists to answer, and an answer that silently omits three quarters
    of the tenancy is worse than no answer — two people would read different
    "total views" off the same page and both would believe it.
  * **Names, membership and per-person activity are earned.** A workspace the
    viewer is not in appears as a locked row: they learn it exists and that it
    is inside the totals, not what it is called or who is in it.
  * **No individual's activity is shown to a non-privileged viewer, ever** —
    no leaderboards, no emails, not even their own row in a ranked list. The
    line is drawn at "identifies a person" rather than at "is sensitive",
    because the second one is a judgement call made fresh at every call site
    and the first one is not.

WHY THE GATE AND THE SCOPE ARE ONE OBJECT
-----------------------------------------
"May this person load Analytics at all?" and "what may they see in it?" are the
same question asked twice. Resolving them separately is how a gate and a
redactor drift apart — the gate says yes, the redactor forgets a field, and the
leak is silent because nothing failed. One resolver, one answer, and the
handlers cannot forget to apply it because they cannot get the data without it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from fastapi import Depends

from backend.app.api.v1.feature_gate import feature_disabled
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

#: The flag that decides whether non-privileged people get the redacted view.
PUBLIC_FLAG = "analyticsPublicEnabled"

#: How much those people are shown. See :class:`PrivacyMode`.
PRIVACY_FLAG = "analyticsPrivacyMode"

#: Whether Analytics REPORTS on workspaces the reader cannot open. Reporting
#: only — see the ``can_see`` / ``can_open`` split on :class:`ViewerScope`.
WORKSPACE_FLAG = "analyticsWorkspaceVisibility"

#: Holding any one of these is what "privileged" means for Analytics.
#:
#: ``system:analytics:read`` is the real one — a dedicated platform privilege,
#: the way DataHub gates its analytics behind VIEW_ANALYTICS rather than
#: reusing an audit grant. It exists because the alternative was answering
#: "who can see growth metrics?" with "whoever can read the audit log", and
#: those are different questions: business reporting is not login history.
#:
#: The other three are kept as implications rather than migrated away from.
#: ``system:admin`` implies everything by construction; the other two are
#: seeded WITH the new permission, so this list is really a safety net for a
#: deployment whose roles were customised before the permission existed.
PRIVILEGED_PERMISSIONS = (
    "system:analytics:read",
    "system:admin", "system:org-admin", "system:audit:read",
)

#: Sees every workspace read-only across the tenancy. Not "privileged" — it
#: grants no per-person data — but it does mean nothing gets locked, because
#: this permission already short-circuits every ``workspace:*:read`` in
#: ``permission_service.has_permission``. Ignoring it here made Analytics
#: STRICTER than the rest of the product, which is its own kind of bug.
ORG_VIEWER = "system:org-viewer"


class PrivacyMode(str, Enum):
    """How much a NON-privileged reader is shown.

    Governs people and operational data only. It can never widen workspace or
    view access — those follow the app's own permission model, and a settings
    dropdown that overrode them would make Analytics a disclosure channel for
    things RBAC refuses everywhere else, invisible to anyone auditing RBAC.
    """

    #: Aggregates only. No individual is ever named. The right posture where
    #: readers are not all colleagues, and where publishing per-person activity
    #: rankings to everyone is a works-council question rather than a UX one.
    STRICT = "strict"

    #: Colleagues are visible: leaderboards, names, who built what. The default
    #: for an internal deployment, where these names are already in the
    #: workspace member lists and hiding them is friction that protects nobody.
    INTERNAL = "internal"

    #: Also operational: access-request backlogs, invite acceptance, refresh
    #: failures. Held back from ``internal`` because "which sources are
    #: failing" is a map of where the gaps are.
    FULL = "full"


#: What an unreadable setting means. Strictest, matching the flag's declared
#: security posture: if we cannot tell what the operator chose, show less.
DEFAULT_PRIVACY_MODE = PrivacyMode.STRICT


@dataclass(frozen=True)
class ViewerScope:
    """What one caller is allowed to be told."""

    #: Sees the unredacted document, including per-person leaderboards.
    privileged: bool

    #: Workspace ids the caller may see the specifics of. Meaningless when
    #: ``privileged`` or ``sees_all_workspaces`` — read through ``can_see``.
    visible_workspaces: frozenset[str]

    #: False when no source could supply the workspace map. The empty set then
    #: says nothing about the caller, so we must not read it as "no access".
    workspaces_known: bool = True

    #: Holds ``system:org-viewer`` — every workspace is readable to them, here
    #: and everywhere else in the product.
    sees_all_workspaces: bool = False

    #: ``analyticsWorkspaceVisibility`` is on: Analytics REPORTS on every
    #: workspace. Deliberately separate from ``sees_all_workspaces``, because
    #: it is a weaker thing — it opens this page's figures, not the workspace.
    #: Conflating them would turn a reporting setting into an access grant.
    reports_all_workspaces: bool = False

    #: How much non-privileged readers are shown. Ignored when ``privileged``.
    privacy: PrivacyMode = DEFAULT_PRIVACY_MODE

    #: Who is asking. Used for the two ownership rules the app already has:
    #: a person may always see their own activity, and a view's creator keeps
    #: reach to it (``view_access.can_read_view`` says the same).
    user_id: Optional[str] = None

    def can_see(self, workspace_id: Optional[str]) -> bool:
        """May Analytics REPORT this workspace's name and figures?

        The looser of the two predicates. Satisfied by real access, by
        ``system:org-viewer``, or by an operator turning on
        ``analyticsWorkspaceVisibility`` for a single-company deployment.
        """
        if self.reports_all_workspaces:
            return True
        return self.can_open(workspace_id)

    def can_open(self, workspace_id: Optional[str]) -> bool:
        """May this caller actually OPEN the workspace?

        The stricter one, and the reason the two are separate. A reporting
        setting must never become an access grant: a name on a dashboard is a
        fact about the platform, a link into the workspace is a door. Only
        this predicate may decide whether a link is rendered, or whether the
        per-workspace drill-in resolves.
        """
        if self.privileged or self.sees_all_workspaces:
            return True
        if not workspace_id:
            return False
        return workspace_id in self.visible_workspaces

    def can_see_view(
        self,
        *,
        workspace_id: Optional[str],
        visibility: Optional[str],
        created_by: Optional[str] = None,
    ) -> bool:
        """May this caller see one view's name?

        Mirrors ``view_access.can_read_view`` rather than inventing a second
        rule. Three ways in, and Analytics used to honour none of them:

          * ``enterprise`` visibility means published platform-wide — ANY
            authenticated user can already open it, so hiding its name on a
            dashboard was pure inconsistency.
          * the creator keeps reach to their own work.
          * otherwise it follows the workspace.

        Explicit per-view grants are deliberately NOT resolved here: that is a
        per-row database lookup, and a leaderboard would pay it ten times per
        request. A grant-holder sees the view redacted on a dashboard and opens
        it perfectly well from anywhere else — an under-disclosure, which is
        the safe direction to be wrong in.
        """
        if self.privileged:
            return True
        if (visibility or "private") == "enterprise":
            return True
        if created_by and self.user_id and created_by == self.user_id:
            return True
        return self.can_see(workspace_id)

    def is_self(self, user_id: Optional[str]) -> bool:
        """Their own row. Never hidden from them by any privacy level —
        it is their data, and withholding it protects nobody."""
        return bool(user_id) and user_id == self.user_id

    @property
    def shows_people(self) -> bool:
        """Whether OTHER people may be named."""
        return self.privileged or self.privacy in (
            PrivacyMode.INTERNAL, PrivacyMode.FULL,
        )

    @property
    def shows_operations(self) -> bool:
        """Access requests, invite acceptance and refresh failures — an
        operator's view of the platform, and a map of where the gaps are."""
        return self.privileged or self.privacy is PrivacyMode.FULL


def _privileged(claims: PermissionClaims) -> bool:
    return any(p in claims.global_perms for p in PRIVILEGED_PERMISSIONS)


async def resolve_privacy_mode() -> PrivacyMode:
    """The operator's chosen level, or the strictest one if it cannot be read.

    A single-select, so it cannot be a boolean ``require_feature`` gate — the
    middle setting is neither on nor off. Mirrors
    ``feature_gate.resolve_enterprise_view_policy``, which solved the same
    shape, except that one fails OPEN (freezing publishing platform-wide is
    worse than allowing it) and this one fails CLOSED (over-disclosing is
    worse than under-disclosing, and cannot be undone).
    """
    value = await feature_flags.get_value_self_session(PRIVACY_FLAG, default=None)
    try:
        return PrivacyMode(value)
    except ValueError:
        if value is not None:
            logger.warning(
                "Unknown %s value %r — falling back to %s",
                PRIVACY_FLAG, value, DEFAULT_PRIVACY_MODE.value,
            )
        return DEFAULT_PRIVACY_MODE


async def resolve_scope(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> ViewerScope:
    """FastAPI dependency: the gate and the redaction scope in one pass.

    Raises the standard ``feature_disabled`` 403 for a non-privileged caller
    when the flag is off — the same shape ``require_feature`` raises, so the
    client cannot tell this gate from any other and does not need to.
    """
    if _privileged(claims):
        # Privileged callers are never gated by the flag. The switch decides
        # whether EVERYONE ELSE gets in; taking an admin's own dashboard away
        # would make it a foot-gun rather than a disclosure control.
        return ViewerScope(
            privileged=True,
            visible_workspaces=frozenset(),
            sees_all_workspaces=True,
            user_id=getattr(user, "id", None),
        )

    enabled = await feature_flags.is_enabled_self_session(
        PUBLIC_FLAG, default=fail_safe_default(PUBLIC_FLAG),
    )
    if not enabled:
        raise feature_disabled(PUBLIC_FLAG)

    # A workspace map nothing could populate is not an empty map. Treating it
    # as one would silently redact a member's own workspaces — the page would
    # load, look plausible, and be wrong. Say so instead, and let the payload
    # carry the caveat.
    return ViewerScope(
        privileged=False,
        visible_workspaces=frozenset(claims.ws_perms.keys()),
        workspaces_known=claims.ws_available,
        # Already short-circuits every workspace:*:read across the tenancy, so
        # nothing should be locked for them here either.
        sees_all_workspaces=ORG_VIEWER in claims.global_perms,
        reports_all_workspaces=await feature_flags.is_enabled_self_session(
            WORKSPACE_FLAG, default=fail_safe_default(WORKSPACE_FLAG),
        ),
        privacy=await resolve_privacy_mode(),
        user_id=getattr(user, "id", None),
    )
