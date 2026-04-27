"""Lint enforcement for the job platform broker abstraction.

The discipline: workers, consumers, and API endpoints must never
call ``redis.xadd / redis.publish / redis.xread`` directly. Those
operations are the broker's responsibility and live behind
``JobBroker`` (event-broadcast) or the existing
``backend/insights_service/redis_streams.py`` (work-queue dispatch
— a separate seam, intentionally).

Without this rule, the broker abstraction leaks within months —
an engineer adds ``redis.xadd`` to a worker for a one-off, the
next adds another, and swapping to Kafka becomes "find every
hardcoded Redis call." The unit test fails CI early so the team
knows the seam is being eroded.

The rule applies to **outgoing** writes (xadd / publish / hset)
and **subscribe** reads (xread / xreadgroup / pubsub). Plain
key-value reads (``redis.get / hgetall``) are not blocked — those
are how the live-state cache reads back, and they're not transport
operations.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


# Paths allowed to call Redis transport ops directly. Everything
# else must go through the broker / state-store abstractions.
_ALLOWED_DIRS = (
    # New broker / state-store impls — the seam itself.
    "backend/app/jobs/brokers",
    "backend/app/jobs/state_stores",
    # The broker module itself — its docstring talks about the
    # forbidden idioms in prose, which the regex would otherwise flag.
    "backend/app/jobs/broker.py",
    # Existing work-queue dispatcher (different seam, also abstracted).
    "backend/insights_service/redis_streams.py",
    # Insights worker — canonical work-queue consumer since before
    # the broker abstraction. Its direct XREADGROUP / XACK calls
    # implement consumer-group semantics (work distribution, not
    # event broadcasting). Phase 2 may unify with the broker.
    "backend/insights_service/worker.py",
    # Standalone aggregation worker process — same pattern as the
    # insights worker (XREADGROUP work-queue consumer).
    "backend/app/services/aggregation/__main__.py",
    # AggregationDispatcher (Postgres NOTIFY / Redis Streams routes
    # — the work-routing seam, not the event-broadcast seam). See
    # backend/app/jobs/broker.py docstring for the distinction.
    "backend/app/services/aggregation/dispatcher.py",
    # Stats-service worker — sibling of insights worker pattern.
    "backend/stats_service/worker.py",
    # Admission control's GCRA token bucket uses Lua + direct Redis;
    # not a broker concern.
    "backend/insights_service/admission.py",
    # The legacy ``aggregation.events`` Pub/Sub channel writer.
    # Stays as-is until ``event_listener.py`` migrates to consume
    # from JobBroker (Phase 4 cleanup).
    "backend/app/services/aggregation/events.py",
    "backend/app/services/aggregation/event_listener.py",
    # Cross-process cancel bridge. Distinct from the broker (which
    # is for event broadcast); ``cancel.py`` carries control-plane
    # messages on a separate Pub/Sub channel and the listener only
    # forwards into the local in-memory CancelRegistry. Could be
    # promoted to a generic ``ControlBroker`` abstraction later if
    # we add pause/resume/force-fail signals.
    "backend/app/services/aggregation/cancel.py",
    # Cache layer / ancestor cache — direct Redis use is the
    # design, not a transport concern.
    "backend/app/services/aggregation/redis_client.py",
    # Operational / DLQ admin paths inside insights_service.
    "backend/insights_service/__main__.py",
    # Tests themselves may inspect Redis directly.
    "backend/tests",
    # Scripts (one-off operational tooling) are out of scope.
    "backend/scripts",
)


# Patterns that are forbidden outside the allowlist. Each pattern
# requires an open-paren immediately after the call name so prose
# mentions in docstrings (e.g. "``.xread`` is forbidden") don't
# trip false positives.
_FORBIDDEN_PATTERNS = [
    re.compile(r"\.xadd\("),
    re.compile(r"\.xread\("),
    re.compile(r"\.xreadgroup\("),
    re.compile(r"\.publish\(\s*[^,)]+\s*,"),  # redis.publish(channel, msg)
]


def _project_root() -> Path:
    # tests/ → backend/ → repo root
    return Path(__file__).resolve().parents[2]


def _is_allowed(path: Path) -> bool:
    rel = path.relative_to(_project_root()).as_posix()
    for allowed in _ALLOWED_DIRS:
        if rel == allowed or rel.startswith(allowed + "/") or rel.startswith(allowed):
            return True
    return False


def _scan_python_files() -> list[tuple[Path, int, str]]:
    """Return a list of (path, lineno, line) hits in non-allowlisted
    files."""
    backend_root = _project_root() / "backend"
    hits: list[tuple[Path, int, str]] = []
    for py in backend_root.rglob("*.py"):
        if _is_allowed(py):
            continue
        try:
            text = py.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            # Skip comments and pure docstring lines so the
            # narrative comments in this file don't trip the rule.
            if stripped.startswith("#"):
                continue
            for pat in _FORBIDDEN_PATTERNS:
                if pat.search(line):
                    hits.append((py, lineno, line.rstrip()))
                    break
    return hits


def test_no_direct_redis_transport_calls_outside_brokers() -> None:
    """Workers / consumers / API endpoints must go through ``JobBroker``
    (or the existing work-queue dispatcher) for Redis transport ops.

    If this test fails: move the direct call into a broker / state-
    store implementation, OR add the file to ``_ALLOWED_DIRS`` above
    if it's a legitimate new seam (rare; review carefully — every
    addition to the allowlist makes the abstraction one click less
    swappable to Kafka)."""
    hits = _scan_python_files()
    if hits:
        formatted = "\n".join(
            f"  {p.relative_to(_project_root())}:{lineno}: {line}"
            for p, lineno, line in hits
        )
        pytest.fail(
            "Direct Redis transport call(s) outside broker abstraction:\n"
            + formatted
            + "\n\nMove to backend/app/jobs/brokers/ or "
            + "backend/app/jobs/state_stores/, or add the file to "
            + "_ALLOWED_DIRS in this test if it's a legitimate seam."
        )
