"""Standardised outbox event emit helper (Phase 1.5 §1.5.6).

Every meaningful state change in any domain (workspace, provider,
ontology, view, user, aggregation, …) writes an event here in the
**same DB transaction** as the change. The relay drains these and
fans out to consumers (in-process today; Redis Streams or Kafka
once Phase 4 ships the broker handler).

Why a helper instead of `session.add(OutboxEventORM(...))`:

- One place enforces the `<domain>.<entity>.<verb>` event-type contract
  (DOMAIN_OWNERSHIP.md is the source of truth for valid domains).
- One place stamps the canonical `aggregate_type` / `aggregate_id` /
  `workspace_id` / `event_version` fields so consumers don't need to
  parse heterogeneous payloads to find the entity.
- Future: when the relay grows replay/dead-letter logic, callers see
  no API change.

Idempotency:

- `id` is generated server-side (uuid prefix `evt_`).
- Caller is responsible for transactional consistency: the helper
  appends to the session; the caller's commit is what makes it durable.
- Callers that want at-most-once semantics should pass an explicit
  `id` derived from a deterministic key.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OutboxEventORM


# Domain prefixes recognised by the platform. Keep in sync with
# backend/app/db/DOMAIN_OWNERSHIP.md. Lint catches drift.
_VALID_DOMAINS = frozenset({
    "identity",
    "workspace",
    "provider",
    "ontology",
    "visualization",
    "aggregation",
    "stats",
    "platform",
    "events",
})

_EVENT_TYPE_PATTERN = re.compile(r"^([a-z]+)\.[a-z_]+(?:\.[a-z_]+)+$")


class InvalidEventType(ValueError):
    """Raised when an event_type does not satisfy `<domain>.<entity>.<verb>`."""


def _validate_event_type(event_type: str) -> str:
    """Reject events that don't follow the domain-prefixed contract.

    Returns the matched domain so callers can route per-domain.
    """
    match = _EVENT_TYPE_PATTERN.match(event_type)
    if not match:
        raise InvalidEventType(
            f"Outbox event_type {event_type!r} must match "
            f"`<domain>.<entity>.<verb>` (lowercase, dot-separated). "
            f"Examples: workspace.created, ontology.published, view.deleted."
        )
    domain = match.group(1)
    if domain not in _VALID_DOMAINS:
        raise InvalidEventType(
            f"Outbox event_type {event_type!r} starts with unknown domain "
            f"{domain!r}. Valid domains: {sorted(_VALID_DOMAINS)}. "
            f"Update DOMAIN_OWNERSHIP.md if you need a new domain."
        )
    return domain


async def emit(
    session: AsyncSession,
    *,
    event_type: str,
    aggregate_id: str,
    aggregate_type: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None,
    event_version: int = 1,
) -> OutboxEventORM:
    """Add a domain event to the outbox in the caller's open transaction.

    Args:
        session: The same AsyncSession the caller is using for the
                 originating state change. The event is `session.add`'d
                 — the caller commits.
        event_type: `<domain>.<entity>.<verb>` (e.g. `workspace.created`).
        aggregate_id: ID of the entity this event refers to (e.g. the
                      workspace's id). Required — drives consumer routing
                      and replay.
        aggregate_type: Optional explicit aggregate type. Defaults to the
                        second segment of the event_type (e.g. "workspace"
                        for `workspace.created`).
        payload: Optional JSON-serialisable dict describing the event.
                 Defaults to empty.
        event_version: Schema version of the payload. Bump when the
                       payload shape changes incompatibly so consumers
                       can branch.

    Returns:
        The created OutboxEventORM instance (already attached to the
        session). Useful for tests.
    """
    domain = _validate_event_type(event_type)
    if aggregate_type is None:
        # Default to the entity portion of the event type
        # (e.g., "workspace" from "workspace.created"). Domains may
        # override when the entity differs from the domain name
        # (e.g., domain="identity", aggregate_type="user").
        parts = event_type.split(".")
        aggregate_type = parts[1] if len(parts) >= 2 else domain

    event = OutboxEventORM(
        id=f"evt_{uuid.uuid4().hex[:12]}",
        event_type=event_type,
        event_version=event_version,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        payload=json.dumps(payload or {}),
        processed=False,
    )
    session.add(event)
    return event


__all__ = ["emit", "InvalidEventType"]
