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


class StatsDeepJobEnvelope(StatsJobEnvelope):
    """Deep stats facet: full schema stats (samples + tags scans),
    ontology metadata, and the built graph schema. Split from the cheap
    counts poll (``stats_poll``) so one slow large-graph scan set never
    blocks counts freshness — deep jobs ride the heavy worker lane.
    Same wire fields as the counts envelope, different ``kind``."""

    kind: Literal["stats_deep"] = "stats_deep"  # type: ignore[assignment]


class ProbeJobEnvelope(StatsJobEnvelope):
    """Drift probe: constant-time counts only, no scan.

    Same scope and fields as a counts poll — deliberately, so the two share
    the enqueue plumbing — but a different ``kind`` routes it to the probe
    lane and a different handler. What it writes is narrower too: the counts
    and their digest, never the schema/ontology columns.
    """

    kind: Literal["probe"] = "probe"  # type: ignore[assignment]


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


class PurgeJobEnvelope(BaseModel):
    """Async aggregation-edge purge.

    Scope is the ``data_source_id`` so two purge requests against the
    same source coalesce. The pre-existing ``aggregation_jobs`` row
    (``job_id``) is the durable status / audit record; the worker
    updates that row to ``completed`` / ``failed`` after the provider
    DELETE finishes. We carry ``workspace_id`` along so the handler can
    resolve a provider client without a redundant DB lookup.
    """

    kind: Literal["purge"] = "purge"
    job_id: str           # AggregationJobORM.id (durable record)
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
            "job_id": self.job_id,
            "data_source_id": self.data_source_id,
            "workspace_id": self.workspace_id,
            "enqueued_at": self.enqueued_at.isoformat(),
            "attempt": str(self.attempt),
        }

    @classmethod
    def from_stream_fields(cls, fields: dict[str, str]) -> "PurgeJobEnvelope":
        return cls(
            job_id=fields["job_id"],
            data_source_id=fields["data_source_id"],
            workspace_id=fields["workspace_id"],
            enqueued_at=datetime.fromisoformat(fields["enqueued_at"]),
            attempt=int(fields.get("attempt", "1")),
        )


JobEnvelope = Union[
    StatsJobEnvelope, StatsDeepJobEnvelope, ProbeJobEnvelope,
    DiscoveryJobEnvelope, PurgeJobEnvelope,
]


_ENVELOPE_BY_KIND: dict[str, type[BaseModel]] = {
    "stats_poll": StatsJobEnvelope,
    "stats_deep": StatsDeepJobEnvelope,
    "probe": ProbeJobEnvelope,
    "discovery": DiscoveryJobEnvelope,
    "purge": PurgeJobEnvelope,
}


def parse_envelope(fields: dict[str, str]) -> JobEnvelope:
    """Dispatch on the ``kind`` field; default to stats_poll for compatibility."""
    kind = fields.get("kind", "stats_poll")
    cls = _ENVELOPE_BY_KIND.get(kind)
    if cls is None:
        raise ValueError(f"Unknown job kind on stream message: {kind!r}")
    return cls.from_stream_fields(fields)  # type: ignore[attr-defined]
