"""Centralised Redis key/stream-name helpers for the job platform.

Every Redis key the platform uses is constructed here. Brokers and
state stores reference these; the rest of the codebase should not
build Redis keys for jobs by hand.

Why this matters. When we eventually add a multi-tenant prefix or
swap key formats (e.g. namespacing per environment), one file
changes. Without this seam, key strings are scattered across
producers, consumers, and ad-hoc redis-cli operators' muscle memory.
"""
from __future__ import annotations

import os


_KEY_PREFIX = os.getenv("JOB_REDIS_KEY_PREFIX", "job")
"""Optional prefix for namespacing (e.g. per-environment ``staging``,
``prod``). Default ``job`` keeps keys short and matches the design
plan's examples."""


PROGRESS_TTL_SECS: int = int(os.getenv("AGGREGATION_PROGRESS_TTL_SECS", "86400"))
"""How long a job's live-state HSET sticks around after the last
write. 24h default: long enough that a UI viewing a recently-
completed job sees the live view; short enough that long-since-
completed jobs don't accumulate."""


PER_JOB_STREAM_MAXLEN: int = int(os.getenv("JOB_EVENTS_PER_JOB_MAXLEN", "200"))
"""``MAXLEN ~`` cap on the per-job event stream. 200 sub-batch
heartbeats accommodates a multi-minute outer batch without truncation
under normal cadence; consumers that fall behind further get the
``resync`` semantic."""


PER_TENANT_STREAM_MAXLEN: int = int(os.getenv("JOB_EVENTS_PER_TENANT_MAXLEN", "1000"))
"""Per-tenant fan-out cap. Phase 3 use; defined here so the constant
lives next to its sibling."""


def state_key(job_id: str) -> str:
    """Live-state HSET key. Holds the current snapshot of a job."""
    return f"{_KEY_PREFIX}:state:{job_id}"


def per_job_events_stream(job_id: str) -> str:
    """Per-job event log stream. Backfill via XRANGE; live tail via
    XREAD BLOCK."""
    return f"{_KEY_PREFIX}:events:{job_id}"


def per_tenant_events_stream(workspace_id: str) -> str:
    """Per-tenant fan-out stream. Phase 3: one EventSource per
    workspace replaces N EventSources per visible row."""
    return f"{_KEY_PREFIX}:tenant:{workspace_id}"


def control_stream(job_id: str) -> str:
    """Control-plane stream. Phase 2: cancel / pause / resume signals
    flow here when workers run on a different replica than the API
    tier (cross-process cancel)."""
    return f"{_KEY_PREFIX}:control:{job_id}"
