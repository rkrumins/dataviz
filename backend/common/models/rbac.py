"""Pydantic DTOs for RBAC endpoints (Phase 2).

Covers groups, group members, workspace role bindings, view grants, and
the role-binding audit query.

Naming convention follows the rest of the codebase: ``Field(alias="camelCase")``
with ``model_config = ConfigDict(populate_by_name=True)`` so JSON bodies
arrive in either case and serialization defaults to camelCase.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# Phase 7: ``expires_in`` shortcut → ISO ``expires_at`` normalisation.
# Operators express contractor / temp access durations naturally; the
# DTO converts them once at the API boundary so the persistence layer
# only ever sees timestamps. Accepts ``Nh`` (hours), ``Nd`` (days),
# and ``Nw`` (weeks). Capped at ``365d`` to avoid surprise.
_DURATION_RE = re.compile(r"^(\d+)([hdw])$")
_DURATION_CAP_DAYS = 365


def _parse_duration_to_expires_at(expr: str) -> str:
    """Turn ``"24h"`` / ``"7d"`` / ``"2w"`` into a UTC ISO timestamp.

    Raises ``ValueError`` for malformed expressions or durations over
    the 365-day cap (a permanent binding should omit the field
    altogether, not abuse the duration shortcut).
    """
    m = _DURATION_RE.match(expr.strip().lower())
    if not m:
        raise ValueError(
            f"expires_in must look like '24h', '7d', or '2w'; got {expr!r}"
        )
    n, unit = int(m.group(1)), m.group(2)
    if n <= 0:
        raise ValueError("expires_in must be a positive duration")
    days = {"h": n / 24, "d": n, "w": n * 7}[unit]
    if days > _DURATION_CAP_DAYS:
        raise ValueError(
            f"expires_in capped at {_DURATION_CAP_DAYS} days; "
            f"got {n}{unit}"
        )
    delta = {"h": timedelta(hours=n), "d": timedelta(days=n),
             "w": timedelta(weeks=n)}[unit]
    return (datetime.now(timezone.utc) + delta).isoformat()


# ── Groups ───────────────────────────────────────────────────────────

class GroupCreateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None


class GroupUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None


class GroupResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    name: str
    description: Optional[str] = None
    source: str  # "local" | "scim"
    external_id: Optional[str] = Field(default=None, alias="externalId")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    member_count: int = Field(alias="memberCount")


class GroupMemberResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    user_id: str = Field(alias="userId")
    group_id: str = Field(alias="groupId")
    added_at: str = Field(alias="addedAt")
    added_by: Optional[str] = Field(default=None, alias="addedBy")


class GroupMemberAddRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    user_id: str = Field(alias="userId")


# ── Workspace members (role bindings scoped to a workspace) ─────────

class WorkspaceMemberSubject(BaseModel):
    """Inline expansion of the bound subject so the FE doesn't need a
    second round-trip to render the member list."""
    model_config = ConfigDict(populate_by_name=True)
    type: str  # "user" | "group"
    id: str
    # Display fields are best-effort. They may be ``None`` if the subject
    # row was deleted (orphaned binding) — endpoints that emit this DTO
    # should still surface the binding so the admin can revoke it.
    display_name: Optional[str] = Field(default=None, alias="displayName")
    secondary: Optional[str] = None  # email for users, member count for groups


class WorkspaceMemberResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    binding_id: str = Field(alias="bindingId")
    # Phase 5+ taxonomy: workspace_admin | workspace_member |
    # workspace_viewer, or any custom workspace-scoped role. See
    # docs/RBAC.md.
    role: str
    granted_at: str = Field(alias="grantedAt")
    granted_by: Optional[str] = Field(default=None, alias="grantedBy")
    # Phase 7: time-bound bindings. ``None`` for permanent;
    # ISO-8601 UTC for an expiry. The FE renders a countdown badge.
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    subject: WorkspaceMemberSubject


class WorkspaceMemberCreateRequest(BaseModel):
    """Bind a user or group to a workspace at a specific role.

    Phase 7: ``expires_at`` (ISO timestamp) and ``expires_in``
    (duration shortcut like ``"24h"`` / ``"7d"`` / ``"2w"``) are
    both accepted. Setting both is a 422 — pick one. Setting neither
    creates a permanent binding (the prior behaviour).
    """
    model_config = ConfigDict(populate_by_name=True)
    subject_type: str = Field(alias="subjectType")  # "user" | "group"
    subject_id: str = Field(alias="subjectId")
    # See ``WorkspaceMemberResponse.role`` for the accepted set.
    role: str
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    expires_in: Optional[str] = Field(default=None, alias="expiresIn")

    @model_validator(mode="after")
    def _normalise_expiry(self) -> "WorkspaceMemberCreateRequest":
        if self.expires_at and self.expires_in:
            raise ValueError(
                "Pass either expiresAt OR expiresIn, not both",
            )
        if self.expires_in:
            self.expires_at = _parse_duration_to_expires_at(self.expires_in)
            self.expires_in = None
        return self


class WorkspaceMemberExpiryUpdateRequest(BaseModel):
    """Phase 7: extend, change, or clear a binding's ``expires_at``.

    ``expires_at=null`` or ``expires_in=null`` (both omitted) clears
    the expiry → the binding becomes permanent. Used to extend a
    contractor's access without re-creating the binding.
    """
    model_config = ConfigDict(populate_by_name=True)
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    expires_in: Optional[str] = Field(default=None, alias="expiresIn")

    @model_validator(mode="after")
    def _normalise_expiry(self) -> "WorkspaceMemberExpiryUpdateRequest":
        if self.expires_at and self.expires_in:
            raise ValueError(
                "Pass either expiresAt OR expiresIn, not both",
            )
        if self.expires_in:
            self.expires_at = _parse_duration_to_expires_at(self.expires_in)
            self.expires_in = None
        return self


# ── View grants (Layer-3 explicit shares) ───────────────────────────

class ViewGrantSubject(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: str  # "user" | "group"
    id: str
    display_name: Optional[str] = Field(default=None, alias="displayName")
    secondary: Optional[str] = None


class ViewGrantResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    grant_id: str = Field(alias="grantId")
    role: str  # "editor" | "viewer"
    granted_at: str = Field(alias="grantedAt")
    granted_by: Optional[str] = Field(default=None, alias="grantedBy")
    subject: ViewGrantSubject


class ViewGrantCreateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    subject_type: str = Field(alias="subjectType")
    subject_id: str = Field(alias="subjectId")
    role: str  # "editor" | "viewer"


# ── Audit / role-binding debug ──────────────────────────────────────

class RoleBindingAuditRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    subject_type: str = Field(alias="subjectType")
    subject_id: str = Field(alias="subjectId")
    role: str
    scope_type: str = Field(alias="scopeType")  # "global" | "workspace"
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    granted_at: str = Field(alias="grantedAt")
    granted_by: Optional[str] = Field(default=None, alias="grantedBy")
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")


# ── Permissions catalogue + role definitions ────────────────────────

class PermissionResponse(BaseModel):
    """One permission identifier and what it means in human terms.

    Phase 4.1 added ``longDescription`` and ``examples``. The
    frontend renders the long description in a hover tooltip and the
    examples as a bulleted list inside the permission detail drawer.
    Both are nullable for safety on rows that pre-date the backfill.
    """
    model_config = ConfigDict(populate_by_name=True)
    id: str  # e.g. "workspace:view:edit"
    description: str
    category: str  # "system" | "workspace" | "resource"
    long_description: Optional[str] = Field(default=None, alias="longDescription")
    examples: list[str] = Field(default_factory=list)
    # Roles holding ANY perm in this list auto-grant ``id`` (in the
    # same scope). Mirrors the shortcuts in ``has_permission`` — e.g.
    # every non-``system:admin`` perm is implied by ``system:admin``;
    # ``workspace:*`` leaves are implied by ``workspace:admin`` /
    # ``system:org-admin``. The FE consumes this to compute "which
    # roles can reach this section?" without duplicating BE logic.
    implied_by: list[str] = Field(default_factory=list, alias="impliedBy")


class PermissionUpdateRequest(BaseModel):
    """Body for ``PUT /admin/permissions/{id}``.

    All three fields are optional — ``None`` leaves them unchanged.
    Passing ``examples=[]`` clears the list. Passing
    ``longDescription=""`` clears the long description (FE falls
    back to ``description``). The ``id`` and ``category`` are
    intentionally NOT editable — they're part of the system contract
    and renaming would orphan every ``role_permissions`` row.
    """
    model_config = ConfigDict(populate_by_name=True)
    description: Optional[str] = None
    long_description: Optional[str] = Field(default=None, alias="longDescription")
    examples: Optional[list[str]] = None


class RoleDefinitionResponse(BaseModel):
    """A role's name plus the full set of permission ids it bundles.

    Returned from ``GET /admin/roles``. The frontend's Permissions
    page renders the role × permission matrix from this and the
    Permission catalogue endpoint.

    Phase 3 added scope, ``isSystem``, description, and audit fields
    so the role-editor UI can render the lifecycle controls (read-only
    badge for system roles, scope chip, etc).
    """
    model_config = ConfigDict(populate_by_name=True)
    name: str
    description: Optional[str] = None
    scope_type: str = Field(default="global", alias="scopeType")  # global | workspace
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    is_system: bool = Field(default=False, alias="isSystem")
    permissions: list[str]
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    created_by: Optional[str] = Field(default=None, alias="createdBy")
    # Bindings count is hydrated by the endpoint when affordable so the
    # admin UI can warn before delete and disable the Delete button on
    # roles that are still in use.
    binding_count: int = Field(default=0, alias="bindingCount")


class RoleCreateRequest(BaseModel):
    """Body for POST /admin/roles. ``permissions`` must reference
    existing ids in the catalogue; the endpoint rejects unknown ones."""
    model_config = ConfigDict(populate_by_name=True)
    name: str = Field(min_length=1, max_length=64)
    description: Optional[str] = None
    scope_type: str = Field(default="global", alias="scopeType")
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    permissions: list[str] = Field(default_factory=list)


class RoleUpdateRequest(BaseModel):
    """Body for PUT /admin/roles/{name}. Either field may be omitted —
    omitted fields are not changed."""
    model_config = ConfigDict(populate_by_name=True)
    description: Optional[str] = None
    permissions: Optional[list[str]] = None


# ── Per-user effective access ───────────────────────────────────────

class _BindingScope(BaseModel):
    """The (scope_type, scope_id) pair for a single binding row."""
    model_config = ConfigDict(populate_by_name=True)
    type: str  # "global" | "workspace"
    id: Optional[str] = None
    # Display name for the scope target — e.g. workspace name. Populated
    # where it can resolve, otherwise None.
    label: Optional[str] = None


class _ViaGroup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    name: str


class UserAccessBinding(BaseModel):
    """One row in the user's access map.

    A binding is direct when ``viaGroup`` is None; otherwise it points
    at the group the user inherited from.
    """
    model_config = ConfigDict(populate_by_name=True)
    binding_id: str = Field(alias="bindingId")
    role: str
    scope: _BindingScope
    granted_at: str = Field(alias="grantedAt")
    granted_by: Optional[str] = Field(default=None, alias="grantedBy")
    via_group: Optional[_ViaGroup] = Field(default=None, alias="viaGroup")


class UserAccessSubject(BaseModel):
    """Lightweight subject info embedded in the access response."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    email: str
    display_name: str = Field(alias="displayName")
    status: str
    role: str  # legacy DTO role string (highest of the user's bindings)


class UserAccessGroup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    name: str
    member_count: int = Field(alias="memberCount")


class UserAccessResponse(BaseModel):
    """Complete access picture for a single user.

    Combines:
      * identity DTO
      * every binding (direct + via group), each tagged with its origin
      * the effective ``PermissionClaims``-shaped resolution (global
        + per-workspace permission sets) — same map the JWT carries
      * group memberships
    """
    model_config = ConfigDict(populate_by_name=True)
    user: UserAccessSubject
    direct_bindings: list[UserAccessBinding] = Field(alias="directBindings")
    inherited_bindings: list[UserAccessBinding] = Field(alias="inheritedBindings")
    groups: list[UserAccessGroup]
    effective_global: list[str] = Field(alias="effectiveGlobal")
    effective_ws: dict[str, list[str]] = Field(alias="effectiveWs")


# ── Access requests (Phase 4.3) ─────────────────────────────────────

class AccessRequestRequester(BaseModel):
    """Lightweight requester DTO embedded in inbox responses.

    Best-effort: every field except ``id`` may be ``None`` if the user
    row was deleted between request creation and resolution. The
    inbox should still render the row so the admin can act on it.
    """
    model_config = ConfigDict(populate_by_name=True)
    id: str
    email: Optional[str] = None
    display_name: Optional[str] = Field(default=None, alias="displayName")


class AccessRequestTarget(BaseModel):
    """Inline target description so the FE doesn't need a second
    round-trip to label the request."""
    model_config = ConfigDict(populate_by_name=True)
    type: str  # 'workspace'
    id: str
    label: Optional[str] = None  # workspace name when resolvable


class AccessRequestResponse(BaseModel):
    """Wire shape returned by every access-request endpoint.

    Pending rows have ``resolvedAt`` / ``resolvedBy`` /
    ``resolutionNote`` set to ``None``. Approved rows carry the
    resolver id and timestamp; denied rows additionally tend to carry
    a free-form note explaining why.
    """
    model_config = ConfigDict(populate_by_name=True)
    id: str
    requester: AccessRequestRequester
    target: AccessRequestTarget
    requested_role: str = Field(alias="requestedRole")
    justification: Optional[str] = None
    status: str  # 'pending' | 'approved' | 'denied'
    created_at: str = Field(alias="createdAt")
    resolved_at: Optional[str] = Field(default=None, alias="resolvedAt")
    resolved_by: Optional[str] = Field(default=None, alias="resolvedBy")
    resolution_note: Optional[str] = Field(default=None, alias="resolutionNote")


class AccessRequestCreate(BaseModel):
    """Body for ``POST /api/v1/access-requests`` — submit a new ask."""
    model_config = ConfigDict(populate_by_name=True)
    target_type: str = Field(alias="targetType")  # only 'workspace' for now
    target_id: str = Field(alias="targetId")
    requested_role: str = Field(alias="requestedRole")
    justification: Optional[str] = None


class AccessRequestResolve(BaseModel):
    """Body for the approve / deny endpoints. ``note`` is optional but
    typically populated on denial."""
    model_config = ConfigDict(populate_by_name=True)
    note: Optional[str] = None


# ── Impact preview (Phase 4.4) ──────────────────────────────────────

class ImpactPreviewUser(BaseModel):
    """Per-user breakdown returned by every preview endpoint.

    ``before`` and ``after`` contain only the permissions that
    *changed* — the FE renders them as a green/red diff list. The
    full effective set isn't returned to keep the response compact
    when many users are affected.
    """
    model_config = ConfigDict(populate_by_name=True)
    user_id: str = Field(alias="userId")
    display_name: Optional[str] = Field(default=None, alias="displayName")
    email: Optional[str] = None
    gained: list[str] = Field(default_factory=list)
    lost: list[str] = Field(default_factory=list)


class ImpactPreviewResponse(BaseModel):
    """Aggregate response for ``preview-*`` endpoints.

    ``affectedUsers`` is the count of users whose effective
    permissions actually change (``gained`` ∪ ``lost`` non-empty).
    ``affectedWorkspaces`` is the count of distinct workspace ids
    where any change occurred. Both are pre-computed so the FE can
    surface "X users in Y workspaces" without re-counting.
    """
    model_config = ConfigDict(populate_by_name=True)
    affected_users: int = Field(alias="affectedUsers")
    affected_workspaces: int = Field(alias="affectedWorkspaces")
    gained_perms: list[str] = Field(default_factory=list, alias="gainedPerms")
    lost_perms: list[str] = Field(default_factory=list, alias="lostPerms")
    user_impact: list[ImpactPreviewUser] = Field(
        default_factory=list, alias="userImpact",
    )


class RolePreviewUpdateRequest(BaseModel):
    """Body for ``POST /admin/roles/{name}/preview-update``."""
    model_config = ConfigDict(populate_by_name=True)
    permissions: list[str]


# ── RBAC search (Phase 4.5) ─────────────────────────────────────────

class RBACSearchHit(BaseModel):
    """One result row in the unified search response.

    ``type`` tells the frontend which navigation handler to invoke.
    ``score`` is the server-side ranking number (3=exact id, 2=prefix,
    1=substring) — useful for UI grouping but not strictly required
    for rendering, since hits are returned pre-sorted.
    """
    model_config = ConfigDict(populate_by_name=True)
    type: str  # 'user' | 'group' | 'workspace' | 'role' | 'permission'
    id: str
    display_name: str = Field(alias="displayName")
    secondary: Optional[str] = None
    score: int


# ── Nav catalogue (Phase 16) ────────────────────────────────────────
# The section→permission visibility specs served by ``GET /me/nav``.
# Mirror the FE ``NavPermissionSpec`` discriminated union one-for-one;
# ``kind`` is the discriminator. Defined here (not in the service) so
# both the endpoint response and the catalogue module share one shape.

class NavSpecAlways(BaseModel):
    """Visible to every authenticated user."""
    kind: Literal["always"] = "always"


class NavSpecPerm(BaseModel):
    """Requires a single global permission."""
    kind: Literal["perm"] = "perm"
    perm: str


class NavSpecAnyPerm(BaseModel):
    """Visible when the user holds any one of ``perms``.

    Global perms are checked against the global claim bucket;
    workspace-scoped perms in the list are matched against ANY
    workspace bucket (so the section shows for a member who holds it
    in one workspace).
    """
    kind: Literal["anyPerm"] = "anyPerm"
    perms: list[str]


class NavSpecWorkspaceAny(BaseModel):
    """Requires ``perm`` held in at least one workspace bucket."""
    kind: Literal["workspaceAny"] = "workspaceAny"
    perm: str


# Discriminated on ``kind`` so the wire shape stays flat
# (``{kind, perm?, perms?}``) and round-trips through model_dump.
NavSpec = Annotated[
    Union[NavSpecAlways, NavSpecPerm, NavSpecAnyPerm, NavSpecWorkspaceAny],
    Field(discriminator="kind"),
]


class NavSection(BaseModel):
    """One catalogue entry: a stable key, a display label, and the
    visibility spec the frontend evaluates against the caller's
    claims."""
    model_config = ConfigDict(populate_by_name=True)
    key: str
    label: str
    spec: NavSpec


class NavCatalogueResponse(BaseModel):
    """Wire shape of ``GET /me/nav`` — the full section catalogue."""
    model_config = ConfigDict(populate_by_name=True)
    sidebar: dict[str, NavSection]
    admin_sections: dict[str, NavSection] = Field(alias="adminSections")
