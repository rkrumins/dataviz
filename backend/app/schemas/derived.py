"""Response envelope for derived (cached/computed) endpoints.

Applied to `/graph/stats` and `/graph/metadata/schema` so a cold or
degraded cache never produces a 504 — every response is a normal 200
with an explicit ``status`` field that the frontend can handle.

Envelope is intentionally generic so other derived endpoints can adopt
it later with ``response_model=DerivedResponse[MyType]`` and no new
design work; today only the two problem endpoints use it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Generic, List, Literal, Optional, TypeVar

from pydantic import BaseModel, Field


class DerivedStatus(str, Enum):
    FRESH = "fresh"               # within TTL
    STALE = "stale"               # past TTL, usable, recompute queued
    COMPUTING = "computing"       # no cached data, recompute queued
    PARTIAL = "partial"           # schema only: types present, counts missing
    UNAVAILABLE = "unavailable"   # cache dead and fallback dead (rare)


class DerivedMeta(BaseModel):
    status: DerivedStatus
    # Intentionally excludes "live": GET handlers must not call the provider.
    source: Literal["memory", "db", "ontology", "none"] = "none"
    computed_at: Optional[datetime] = None
    age_seconds: int = 0
    ttl_seconds: int = 0
    job_id: Optional[str] = None
    missing_fields: List[str] = Field(default_factory=list)


T = TypeVar("T")


class DerivedResponse(BaseModel, Generic[T]):
    data: Optional[T] = None
    meta: DerivedMeta


def _now() -> datetime:
    return datetime.now(timezone.utc)


def compute_age_seconds(updated_at_iso: Optional[str]) -> int:
    """Seconds since ``updated_at_iso`` (ISO string, timezone-aware or naive-UTC).

    Returns 0 if the timestamp is missing or unparseable — callers should
    treat that as "unknown age", not "fresh".
    """
    if not updated_at_iso:
        return 0
    try:
        ts = datetime.fromisoformat(updated_at_iso)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return max(0, int((_now() - ts).total_seconds()))
    except (ValueError, TypeError):
        return 0


def classify_freshness(age_seconds: int, ttl_seconds: int) -> DerivedStatus:
    """``fresh`` if age ≤ TTL, ``stale`` otherwise. Caller picks TTL per endpoint."""
    return DerivedStatus.FRESH if age_seconds <= ttl_seconds else DerivedStatus.STALE
