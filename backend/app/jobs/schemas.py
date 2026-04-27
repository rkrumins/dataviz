"""JobEvent v1 — versioned wire format for the job platform.

Every event the platform publishes — for any kind, any backend — has
this exact shape. Versioning the envelope from day one is the cheap
insurance: the moment a partner / long-lived consumer / audit pipeline
attaches to events, the schema becomes a forever-API. Schema-evolution
without a ``v`` field is impossible to roll forward without breaking
old consumers.

The payload is intentionally a free-form ``dict`` (kind-specific
fields). The JSON-Schema in this module pins the *envelope* shape;
per-kind payload shapes will be added as kinds adopt the platform.

Idempotency. ``(job_id, sequence)`` is the dedup key. Producers must
emit strictly monotonic sequence numbers per ``job_id``; consumers
deduplicate on this pair. ``sequence`` resets to 0 only on a new
``job_id`` — not on resume, not on retry.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


JobKind = Literal["aggregation", "purge", "stats", "discovery"]
"""Discriminator for the job's domain. New kinds extend this Literal —
breaking change managed via the ``v`` field on the envelope."""


JobEventType = Literal["state", "phase", "progress", "terminal", "resync"]
"""Event type. ``state`` = lifecycle transition (pending/running/...).
``phase`` = within-running stage change (counting → materializing → ...).
``progress`` = sample point with metric updates. ``terminal`` = final
state landed. ``resync`` = synthetic event consumers emit when they
detect a sequence gap (MAXLEN truncation, etc.) signalling clients to
re-fetch via REST."""


JobStatus = Literal[
    "pending", "running", "completed", "failed", "cancelled", "stuck"
]


class JobScope(BaseModel):
    """Scope identifiers for a job. Optional fields per kind:

    * ``workspace_id`` — always present; the per-tenant fan-out key.
    * ``data_source_id`` — present for aggregation, purge, stats.
    * ``provider_id`` + ``asset_name`` — present for discovery.
    """

    model_config = ConfigDict(extra="allow")

    workspace_id: str
    data_source_id: Optional[str] = None
    provider_id: Optional[str] = None
    asset_name: Optional[str] = None


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobEvent(BaseModel):
    """The wire format. **All** events on the platform are this shape.

    Producers create via ``JobEmitter.publish(...)``; consumers receive
    via ``JobEventConsumer.stream(...)``. Direct construction outside
    those seams is a smell.
    """

    model_config = ConfigDict(extra="forbid")

    v: Literal[1] = 1
    """Envelope version. Incrementing this is a hard breaking change
    that requires a coordinated producer + consumer rollout."""

    type: JobEventType

    job_id: str
    """Stable identifier for the job. Format depends on kind (e.g.
    ``agg_<uuid>`` for aggregation); platform treats as opaque."""

    kind: JobKind

    scope: JobScope

    sequence: int = Field(ge=0)
    """Monotonic per ``job_id``. ``(job_id, sequence)`` is the
    idempotency key. Consumers detect gaps as sequence non-monotonicity
    and emit a synthetic ``resync`` event."""

    ts: str = Field(default_factory=_utcnow_iso)
    """ISO 8601 timestamp at producer-side emit. UTC. Not used for
    ordering — ``sequence`` is."""

    payload: dict[str, Any] = Field(default_factory=dict)
    """Type- and kind-specific fields. The envelope shape is fixed;
    payloads evolve via additive changes. JSON-Schema enforcement of
    payload shape per (kind, type) is a follow-up."""

    def to_wire(self) -> dict[str, Any]:
        """Serialize for transport. Pydantic handles the rest; this is
        a label for emit sites so nobody confuses ``model_dump()`` with
        sending bytes over the wire."""
        return self.model_dump(mode="json")

    @classmethod
    def from_wire(cls, data: dict[str, Any]) -> "JobEvent":
        """Inverse of ``to_wire``. Validates ``v`` and rejects unknown
        envelope shapes via ``extra='forbid'``."""
        return cls.model_validate(data)


class BackfillNotSupported(Exception):
    """Raised by a ``JobBroker.stream`` implementation when
    ``from_sequence`` is set but the backend can't replay (e.g. GCP
    Pub/Sub without snapshot). Callers fall back to REST + live-tail.
    The contract is part of the broker abstraction so consumers can
    handle backend swaps without code changes."""
