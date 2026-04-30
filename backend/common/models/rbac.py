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
