"""Who may see whose activity in People analytics, and through which lens.

Three ways in, and nothing else:

* **Privileged** — the analytics privilege, or one of the grants that imply it
  (``analytics_scope.PRIVILEGED_PERMISSIONS``): everyone, platform-wide or in any workspace,
  sign-ins included. The ``full`` lens.
* **A workspace admin** — the people of THEIR workspace, through the ``workspace`` lens: what
  happened in the workspace, and no sign-ins. Always with a workspace named; a workspace admin
  has no platform-wide view of anybody.
* **Yourself** — your own activity, everywhere, sign-ins included. It is your data, and the
  ``full`` lens on it protects nobody from anybody.

Not the analytics public tier. ``analyticsPublicEnabled`` opens aggregates to everyone, and an
individual's day-by-day timeline is the opposite of an aggregate.

The lens decides what a DOCUMENT may contain, so documents are cached per lens. The
``ViewerScope`` carried alongside decides what one READER may be shown of it — names of views
and workspaces — on the way out, as everywhere else in Analytics.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, HTTPException

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.repositories.people_activity_repo import FULL, WORKSPACE
from backend.app.services.analytics_scope import (
    ORG_VIEWER,
    PRIVILEGED_PERMISSIONS,
    ViewerScope,
)
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User

#: The id a person's own page asks with, so a link to "my activity" needs no id.
ME = "me"


@dataclass(frozen=True)
class PeopleReader:
    user_id: Optional[str]
    privileged: bool
    claims: PermissionClaims
    viewer: ViewerScope

    def admin_of(self, workspace_id: Optional[str]) -> bool:
        return bool(workspace_id) and has_permission(
            self.claims, "workspace:admin", workspace_id=workspace_id)


@dataclass(frozen=True)
class PeopleAccess:
    lens: str
    workspace_id: Optional[str]
    target: Optional[str] = None
    is_self: bool = False

    @property
    def needs_reach_check(self) -> bool:
        """A workspace admin reading one person must find them in their workspace — a member,
        or someone who did something there. Otherwise any user id would resolve to a name."""
        return self.lens == WORKSPACE and self.target is not None and not self.is_self


async def resolve_people_reader(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> PeopleReader:
    """FastAPI dependency. Resolves nothing it would need a query for: the decision is made
    from the claims this request already carries."""
    user_id = getattr(user, "id", None)
    privileged = any(p in claims.global_perms for p in PRIVILEGED_PERMISSIONS)
    if privileged:
        viewer = ViewerScope(
            privileged=True, visible_workspaces=frozenset(),
            sees_all_workspaces=True, user_id=user_id,
        )
    else:
        viewer = ViewerScope(
            privileged=False,
            visible_workspaces=frozenset(claims.ws_perms.keys()),
            workspaces_known=claims.ws_available,
            sees_all_workspaces=ORG_VIEWER in claims.global_perms,
            user_id=user_id,
        )
    return PeopleReader(user_id=user_id, privileged=privileged, claims=claims, viewer=viewer)


def _refuse() -> HTTPException:
    return HTTPException(
        status_code=403,
        detail="People analytics is for analytics administrators, and for workspace "
               "administrators about their own workspace.",
    )


def roster_access(reader: PeopleReader, workspace_id: Optional[str]) -> PeopleAccess:
    """May this reader see everyone's activity in this scope?"""
    if reader.privileged:
        return PeopleAccess(lens=FULL, workspace_id=workspace_id)
    if workspace_id and reader.admin_of(workspace_id):
        return PeopleAccess(lens=WORKSPACE, workspace_id=workspace_id)
    raise _refuse()


def person_access(
    reader: PeopleReader, user_id: str, workspace_id: Optional[str],
) -> PeopleAccess:
    """May this reader see this one person's activity, and through which lens?"""
    target = reader.user_id if user_id == ME else user_id
    if not target:
        raise _refuse()
    is_self = target == reader.user_id
    if reader.privileged or is_self:
        return PeopleAccess(lens=FULL, workspace_id=workspace_id, target=target, is_self=is_self)
    if workspace_id and reader.admin_of(workspace_id):
        return PeopleAccess(lens=WORKSPACE, workspace_id=workspace_id, target=target)
    raise _refuse()
