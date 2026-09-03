"""Audit-log DTOs (Phase 7).

Surfaces the ``outbox_events`` table to the admin audit lens with
payload-derived fields (actor / target_user / target_role) hoisted
to top-level so the FE can filter without re-parsing JSON.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AuditEventResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    event_id: str = Field(alias="eventId")
    event_type: str = Field(alias="eventType")
    event_version: int = Field(alias="eventVersion")
    aggregate_type: Optional[str] = Field(default=None, alias="aggregateType")
    aggregate_id: Optional[str] = Field(default=None, alias="aggregateId")
    created_at: str = Field(alias="createdAt")

    # Derived from payload introspection — denormalised onto the
    # response so the FE can filter / sort / display without parsing
    # the raw payload. ``None`` when the payload doesn't carry the
    # field (e.g. an automated user.access_denied has no actor).
    actor_id: Optional[str] = Field(default=None, alias="actorId")
    target_user_id: Optional[str] = Field(default=None, alias="targetUserId")
    target_role: Optional[str] = Field(default=None, alias="targetRole")
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")

    # WHO those ids actually are, resolved in one batched lookup per page.
    # An audit row used to carry nothing but `usr_ac3f19`-shaped strings, so
    # reading the log meant opening a tab per row to find out who did what to
    # whom — and once an account was deleted, there was no way to find out at
    # all.
    #
    # NULL HERE MEANS UNRESOLVED, NEVER "nobody". A system-generated event, a
    # hard-deleted row, or a payload naming something that was never a user all
    # leave these empty, and the id stays authoritative — the client must go on
    # showing it rather than print a name the database cannot vouch for.
    #
    # `*_deleted` marks an account that is soft-deleted but still named: the
    # log is a record of what happened, and "who was that account we removed"
    # is precisely the question it exists to answer.
    # Every other internal id this event mentions — groups, IdP
    # connections, views, workspaces inside the payload — resolved to
    # its display name, keyed by the id. Same contract as the people
    # above: absence means unresolved, and the id stays authoritative.
    resolved_names: dict[str, str] = Field(
        default_factory=dict, alias="resolvedNames",
    )
    workspace_name: Optional[str] = Field(default=None, alias="workspaceName")
    actor_name: Optional[str] = Field(default=None, alias="actorName")
    actor_email: Optional[str] = Field(default=None, alias="actorEmail")
    actor_deleted: bool = Field(default=False, alias="actorDeleted")
    target_user_name: Optional[str] = Field(default=None, alias="targetUserName")
    target_user_email: Optional[str] = Field(default=None, alias="targetUserEmail")
    target_user_deleted: bool = Field(default=False, alias="targetUserDeleted")

    # Phase 8: human-readable display fields the FE keys off so the
    # admin audit table doesn't show raw event_type codes.
    # ``severity`` is one of ``info`` / ``warning`` / ``critical`` and
    # drives the row colour; ``summary`` is a one-line sentence.
    severity: str = Field(default="info")
    summary: str = Field(default="")

    payload: dict[str, Any] = Field(default_factory=dict)


class AuditListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    events: list[AuditEventResponse]
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
