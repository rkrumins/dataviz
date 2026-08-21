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

#: Holding any one of these is what "privileged" means for Analytics.
#: ``system:admin`` implies everything; ``system:org-admin`` is the
#: cross-workspace operator; ``system:audit:read`` is the auditor, and is the
#: same permission Admin → Telemetry uses for the same class of read.
PRIVILEGED_PERMISSIONS = (
    "system:admin", "system:org-admin", "system:audit:read",
)


@dataclass(frozen=True)
class ViewerScope:
    """What one caller is allowed to be told."""

    #: Sees the unredacted document, including per-person leaderboards.
    privileged: bool

    #: Workspace ids the caller may see the specifics of. Meaningless when
    #: ``privileged`` (they may see all of them) — read through ``can_see``.
    visible_workspaces: frozenset[str]

    #: False when no source could supply the workspace map. The empty set then
    #: says nothing about the caller, so we must not read it as "no access".
    workspaces_known: bool = True

    def can_see(self, workspace_id: Optional[str]) -> bool:
        """May this caller see the specifics of one workspace?"""
        if self.privileged:
            return True
        if not workspace_id:
            return False
        return workspace_id in self.visible_workspaces

    @property
    def shows_people(self) -> bool:
        """Per-person data — leaderboards, names, emails — is privileged only.

        Deliberately not "shows people they share a workspace with". Ranking
        colleagues by activity is a different product decision from showing
        platform growth, and it should be taken on purpose rather than inherited
        from whichever workspaces someone happens to be in.
        """
        return self.privileged

    @property
    def shows_operations(self) -> bool:
        """Access requests, invite acceptance and refresh failures are an
        operator's view of the platform, not a user's. They name who is waiting
        for access and where the data is unreliable."""
        return self.privileged


def _privileged(claims: PermissionClaims) -> bool:
    return any(p in claims.global_perms for p in PRIVILEGED_PERMISSIONS)


async def resolve_scope(
    _user: User = Depends(get_current_user),
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
        return ViewerScope(privileged=True, visible_workspaces=frozenset())

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
    )
