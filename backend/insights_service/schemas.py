"""Pydantic envelopes for insights-service jobs carried over Redis Streams.

Each job kind has its own envelope class. ``parse_envelope`` dispatches
on the ``kind`` field of the stream message; if absent it defaults to
``stats_poll`` for compatibility with any in-flight pre-rename messages.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Union

from pydantic import BaseModel


class StatsJobEnvelope(BaseModel):
    """Post-registration data-source poll. Scope = (data_source_id, workspace_id)."""

    kind: Literal["stats_poll"] = "stats_poll"
    data_source_id: str
    workspace_id: str
    enqueued_at: datetime
    attempt: int = 1

    @property
    def scope_key(self) -> str:
        """Identity used by the SET NX dedup claim."""
        return self.data_source_id

    def to_stream_fields(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "data_source_id": self.data_source_id,
            "workspace_id": self.workspace_id,
            "enqueued_at": self.enqueued_at.isoformat(),
            "attempt": str(self.attempt),
        }

    @classmethod
    def from_stream_fields(cls, fields: dict[str, str]) -> "StatsJobEnvelope":
        return cls(
            data_source_id=fields["data_source_id"],
            workspace_id=fields["workspace_id"],
            enqueued_at=datetime.fromisoformat(fields["enqueued_at"]),
            attempt=int(fields.get("attempt", "1")),
        )


class DiscoveryJobEnvelope(BaseModel):
    """Pre-registration provider asset discovery.

    Two flavors keyed off ``asset_name``:
    * ``""``  — list every asset on the provider (sentinel row).
    * other   — fetch stats for that single asset.
    """

    kind: Literal["discovery"] = "discovery"
    provider_id: str
    asset_name: str = ""  # "" sentinel = list-all
    enqueued_at: datetime
    attempt: int = 1

    @property
    def scope_key(self) -> str:
        # Two flavors share the provider_id but should not collapse together,
        # otherwise a list-all in flight would block a per-asset request.
        return f"{self.provider_id}:{self.asset_name}"

    def to_stream_fields(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "provider_id": self.provider_id,
            "asset_name": self.asset_name,
            "enqueued_at": self.enqueued_at.isoformat(),
            "attempt": str(self.attempt),
        }

    @classmethod
    def from_stream_fields(cls, fields: dict[str, str]) -> "DiscoveryJobEnvelope":
        return cls(
            provider_id=fields["provider_id"],
            asset_name=fields.get("asset_name", ""),
            enqueued_at=datetime.fromisoformat(fields["enqueued_at"]),
            attempt=int(fields.get("attempt", "1")),
        )


class SchemaJobEnvelope(BaseModel):
    """Explicit schema cache priming. Same scope as ``StatsJobEnvelope`` but
    only the schema field of ``data_source_stats`` is updated, so the worker
    can target a faster code path when the caller only needs schema."""

    kind: Literal["schema_refresh"] = "schema_refresh"
    data_source_id: str
    workspace_id: str
    enqueued_at: datetime
    attempt: int = 1

    @property
    def scope_key(self) -> str:
        return self.data_source_id

    def to_stream_fields(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "data_source_id": self.data_source_id,
            "workspace_id": self.workspace_id,
            "enqueued_at": self.enqueued_at.isoformat(),
            "attempt": str(self.attempt),
        }

    @classmethod
    def from_stream_fields(cls, fields: dict[str, str]) -> "SchemaJobEnvelope":
        return cls(
            data_source_id=fields["data_source_id"],
            workspace_id=fields["workspace_id"],
            enqueued_at=datetime.fromisoformat(fields["enqueued_at"]),
            attempt=int(fields.get("attempt", "1")),
        )


JobEnvelope = Union[StatsJobEnvelope, DiscoveryJobEnvelope, SchemaJobEnvelope]


_ENVELOPE_BY_KIND: dict[str, type[BaseModel]] = {
    "stats_poll": StatsJobEnvelope,
    "discovery": DiscoveryJobEnvelope,
    "schema_refresh": SchemaJobEnvelope,
}


def parse_envelope(fields: dict[str, str]) -> JobEnvelope:
    """Dispatch on the ``kind`` field; default to stats_poll for compatibility."""
    kind = fields.get("kind", "stats_poll")
    cls = _ENVELOPE_BY_KIND.get(kind)
    if cls is None:
        raise ValueError(f"Unknown job kind on stream message: {kind!r}")
    return cls.from_stream_fields(fields)  # type: ignore[attr-defined]
