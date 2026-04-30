"""Pydantic DTOs for RBAC endpoints (Phase 2).

Covers groups, group members, workspace role bindings, view grants, and
the role-binding audit query.

Naming convention follows the rest of the codebase: ``Field(alias="camelCase")``
with ``model_config = ConfigDict(populate_by_name=True)`` so JSON bodies
arrive in either case and serialization defaults to camelCase.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


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
    role: str  # "admin" | "user" | "viewer"
    granted_at: str = Field(alias="grantedAt")
    granted_by: Optional[str] = Field(default=None, alias="grantedBy")
    subject: WorkspaceMemberSubject


class WorkspaceMemberCreateRequest(BaseModel):
    """Bind a user or group to a workspace at a specific role."""
    model_config = ConfigDict(populate_by_name=True)
    subject_type: str = Field(alias="subjectType")  # "user" | "group"
    subject_id: str = Field(alias="subjectId")
    role: str  # "admin" | "user" | "viewer"


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
