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
