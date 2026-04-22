"""Pydantic envelope for a stats poll job carried over the Redis Stream."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class StatsJobEnvelope(BaseModel):
    data_source_id: str
    workspace_id: str
    enqueued_at: datetime
    attempt: int = 1

    def to_stream_fields(self) -> dict[str, str]:
        return {
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
