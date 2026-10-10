"""Activity-ledger DTOs: one event as the explorer shows it.

Ids stay authoritative throughout. Every ``name`` beside an id is resolved in
a batch per page and is ABSENT, never invented, when the id resolves to
nothing — a system actor, a hard-deleted row — so a client shows the raw id
rather than a name the database cannot vouch for.

The summary and health documents are returned as plain dicts, like the
analytics documents: wide and evolving, typed where they are consumed.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ActivityPerson(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: Optional[str] = None
    email: Optional[str] = None
    #: Soft-deleted but still named: the log is a record of what happened.
    deleted: bool = False


class ActivityTarget(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Optional[str] = None
    id: Optional[str] = None
    #: The name it had AT THE TIME when the event recorded one, else its
    #: current name.
    label: Optional[str] = None


class ActivityEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    event_type: str = Field(alias="eventType")
    #: The verb phrase the type is filed under ("Triggered aggregation").
    label: str
    category: str
    severity: str
    outcome: str
    #: One line, with every id it mentions named.
    summary: str
    occurred_at: str = Field(alias="occurredAt")
    recorded_at: str = Field(alias="recordedAt")
    #: ``user`` | ``service`` | ``system`` | ``anonymous``.
    actor_kind: str = Field(alias="actorKind")
    actor: Optional[ActivityPerson] = None
    #: The person it happened TO, when it happened to one.
    subject: Optional[ActivityPerson] = None
    target: Optional[ActivityTarget] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    workspace_name: Optional[str] = Field(default=None, alias="workspaceName")
    data_source_id: Optional[str] = Field(default=None, alias="dataSourceId")
    data_source_name: Optional[str] = Field(default=None, alias="dataSourceName")
    #: The "why" a person gave. Absent is "no reason given", never "".
    stated_reason: Optional[str] = Field(default=None, alias="statedReason")
    #: The HTTP request it came from; events sharing it happened together.
    correlation_id: Optional[str] = Field(default=None, alias="correlationId")
    #: Recorded operations' particulars (job id, trigger source, scope…).
    details: dict[str, Any] = Field(default_factory=dict)
    #: Every other id the event mentions, named. Same contract as above.
    resolved_names: dict[str, str] = Field(default_factory=dict, alias="resolvedNames")
    #: The event as emitted. Platform scope only.
    payload: Optional[dict[str, Any]] = None


class ActivityPage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    events: list[ActivityEvent]
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
    #: How far the ledger trails the outbox — first page only.
    ledger: Optional[dict[str, Any]] = None


class ActivityNewer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    count: int
    #: More than ``count`` arrived; the client shows "count+".
    capped: bool = False


class ActivityEventDetail(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    event: ActivityEvent
    #: Everything else the same request did.
    same_request: list[ActivityEvent] = Field(default_factory=list, alias="sameRequest")
    #: The latest other events on the same target.
    same_target: list[ActivityEvent] = Field(default_factory=list, alias="sameTarget")


class ActivityCatalogueEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: str
    label: str
    category: str
    severity: str
    workspace_visible: bool = Field(alias="workspaceVisible")


class ActivityCatalogue(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    categories: list[str]
    event_types: list[ActivityCatalogueEntry] = Field(alias="eventTypes")
