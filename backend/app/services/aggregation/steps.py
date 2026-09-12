"""The run's step ledger — what the aggregation service is doing now, what
it has already done, and how much of the current step is left.

WHY THIS EXISTS. A run used to report one pair of counters
(``processed_edges`` / ``total_edges``) and one monotonic percentage. Both
only ever mean "lineage edges scanned during EXTRACT": the pipeline's
``_checkpoint`` sends the extract totals whatever phase is running, so from
RECONCILE onwards the counters are frozen and the percentage is the only
moving number — with its denominator nowhere on the page. And two stretches
of the run had no phase at all: the worker's preamble (indices, identity
stamp) before the pipeline's first checkpoint, and the closing fingerprint
scan after its last. On a large graph those bookends are minutes of a
running job with no phase, no bar and no stepper.

WHAT IT IS. An ordered list of the run's six real steps. Each entry carries
its own state, when it started and ended, the seconds it has accumulated
across every visit, how many times it has been entered, why it is parked if
it is, and its OWN unit of work — the numbers the pipeline already computes
at each checkpoint and used to fold into the percentage and discard.

The ledger is written into ``run_stats["steps"]``, so the same record is the
live view while the job runs and the run's history once it is over.

STEP IDS are the pipeline's own ``phase_label`` values, unchanged, plus the
two worker-owned bookends. No new vocabulary: ``PHASE_BANDS`` in the
frontend and ``_progress_pct`` in the pipeline keep meaning what they meant.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Execution order. ``extracting`` … ``applying`` are the pipeline's phase
# labels; ``preparing`` and ``finalizing`` are the worker's bookends.
STEP_IDS = (
    "preparing",
    "extracting",
    "computing",
    "reconciling",
    "applying",
    "finalizing",
)

# A step is ``pending`` until entered, ``running`` while it holds the run,
# ``waiting`` when it holds the run but is parked on something outside it
# (a retry backoff, a quiesce park, a failover park), ``done`` once a later
# step opens, and ``failed`` / ``cancelled`` when the run ends inside it.
_OPEN = ("running", "waiting")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class StepLedger:
    """Ordered record of the run's steps. Not thread-safe and not meant to
    be: one run, one asyncio task, one ledger.

    Every mutator returns True when the snapshot actually changed, so the
    caller can keep its dirty flag honest and leave the commit cadence to
    the checkpoint policy that already owns it.
    """

    __slots__ = ("_steps", "_open", "_clock")

    def __init__(self, *, clock=_now) -> None:
        self._clock = clock
        self._open: Optional[str] = None
        self._steps: Dict[str, Dict[str, Any]] = {
            step_id: {
                "id": step_id,
                "state": "pending",
                "started_at": None,
                "ended_at": None,
                "secs": 0.0,
                "visits": 0,
                # Unit of work for THIS step, in its own units. None until
                # the step reports them; ``computing`` and the two bookends
                # never do (they have no countable unit, and inventing one
                # would be worse than saying nothing).
                "done": None,
                "total": None,
                "unit": None,
                "waiting_for": None,
            }
            for step_id in STEP_IDS
        }

    # ── mutators ────────────────────────────────────────────────────

    def enter(self, step_id: str) -> bool:
        """Open ``step_id``, closing whatever was open.

        Re-entering a step the run already visited (a transient failure
        sends the pipeline back to EXTRACT from the cursor) reopens it:
        the accumulated seconds stand, the visit count rises, and every
        step AFTER it goes back to pending — because it did.
        """
        if step_id not in self._steps:
            return False
        if self._open == step_id:
            # Already here. Re-entering must not re-count the visit or
            # restart the clock — but it DOES mean the run is moving again,
            # so it clears a park.
            entry = self._steps[step_id]
            if entry["state"] == "waiting":
                entry["state"] = "running"
                entry["waiting_for"] = None
                return True
            return False
        now = self._clock()
        self._close_open(now, "done")
        entry = self._steps[step_id]
        entry["state"] = "running"
        entry["started_at"] = now
        entry["ended_at"] = None
        entry["visits"] = int(entry["visits"]) + 1
        entry["waiting_for"] = None
        self._open = step_id
        # Going backwards un-does what came after. Anything else would
        # claim work that is about to be redone is already finished.
        for later in STEP_IDS[STEP_IDS.index(step_id) + 1:]:
            later_entry = self._steps[later]
            if later_entry["state"] != "pending":
                later_entry.update(
                    state="pending", started_at=None, ended_at=None,
                    done=None, total=None, unit=None, waiting_for=None,
                )
        return True

    def note(self, *, done: Any = None, total: Any = None, unit: Any = None) -> bool:
        """Record the open step's own unit of work. Any report of progress
        also clears a park — the run is moving again."""
        if self._open is None:
            return False
        entry = self._steps[self._open]
        changed = False
        for field, value in (("done", done), ("total", total), ("unit", unit)):
            if value is None:
                continue
            coerced = str(value) if field == "unit" else _as_int(value)
            if coerced is not None and entry[field] != coerced:
                entry[field] = coerced
                changed = True
        if entry["state"] == "waiting":
            entry["state"] = "running"
            entry["waiting_for"] = None
            changed = True
        return changed

    def waiting(self, reason: str) -> bool:
        """The open step is parked on something outside itself. Without
        this a retry backoff and a quiesce park read exactly like a hang:
        the same step, the same frozen counters, no explanation."""
        if self._open is None:
            return False
        entry = self._steps[self._open]
        reason = (reason or "")[:200]
        if entry["state"] == "waiting" and entry["waiting_for"] == reason:
            return False
        entry["state"] = "waiting"
        entry["waiting_for"] = reason
        return True

    def seal(self, status: str) -> bool:
        """Close the open step with the run's terminal state. ``completed``
        closes it as done; anything else closes it as itself, so the ledger
        names the step the run died in."""
        final = "done" if status == "completed" else (status or "failed")
        changed = self._close_open(self._clock(), final)
        self._open = None
        return changed

    # ── readers ─────────────────────────────────────────────────────

    def snapshot(self) -> List[Dict[str, Any]]:
        """The ledger, in execution order. Stable between real changes:
        the open step's elapsed time is NOT baked in here — its
        ``started_at`` is, and the reader adds the difference. Recomputing
        it on every call would mark the record dirty on every checkpoint
        and turn the commit cadence into one write per batch."""
        return [dict(self._steps[step_id]) for step_id in STEP_IDS]

    @property
    def open_step(self) -> Optional[str]:
        return self._open

    # ── internals ───────────────────────────────────────────────────

    def _close_open(self, now: str, state: str) -> bool:
        if self._open is None:
            return False
        entry = self._steps[self._open]
        if entry["state"] not in _OPEN:
            return False
        entry["state"] = state
        entry["ended_at"] = now
        entry["secs"] = round(
            float(entry["secs"]) + _span_secs(entry["started_at"], now), 2,
        )
        entry["waiting_for"] = None
        return True


def _as_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _span_secs(started_at: Optional[str], ended_at: str) -> float:
    """Seconds between two ISO instants, never negative. Wall clock rather
    than a monotonic counter because the ledger is persisted and read back:
    a resumed worker has no monotonic origin in common with the one that
    wrote the row."""
    if not started_at:
        return 0.0
    try:
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(ended_at)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, (end - start).total_seconds())


# ── how much of a run is left ───────────────────────────────────────────


def open_step(steps: Any) -> Optional[Dict[str, Any]]:
    """The step holding the run, or None. Tolerates anything: the ledger is
    read back out of a JSON column written by some other process."""
    if not isinstance(steps, list):
        return None
    for entry in steps:
        if isinstance(entry, dict) and entry.get("state") in _OPEN:
            return entry
    return None


def remaining_secs(
    current: Any, previous: Any, *, now: Optional[datetime] = None,
) -> Optional[float]:
    """Seconds this run still owes, read off its ledger against the previous
    completed run's on the same source.

    What it replaces extrapolated ``elapsed * (100 - pct) / pct`` from one
    percentage. That is only right if every stage runs at the same rate,
    which is exactly false — EXTRACT is a scan, APPLY is paced writes, and
    the two bookends are fingerprints. It was also wrong twice over on a
    RESUMED run, where the percentage was held up by a monotonic clamp and
    ``elapsed`` ran from the first attempt's start.

    Returns None when either run has no ledger, when nothing is open, or
    when the previous run is too fast to be signal. **None is the honest
    answer, not a fallback to guessing**: without a comparable run there is
    no basis for a whole-run figure, and the stage's own "3 of 12 scan
    ranges, 9 left" is a better answer to "how much is left" than a
    confidently wrong clock time.
    """
    if not isinstance(current, list) or not isinstance(previous, list):
        return None
    prior: Dict[str, float] = {}
    for entry in previous:
        if isinstance(entry, dict) and isinstance(entry.get("secs"), (int, float)):
            prior[str(entry.get("id"))] = float(entry["secs"])
    if sum(prior.values()) < _SIGNAL_MIN_SECS:
        return None

    open_ = open_step(current)
    if open_ is None:
        return None
    idx = STEP_IDS.index(open_["id"]) if open_.get("id") in STEP_IDS else -1
    if idx < 0:
        return None

    done, total = _as_int(open_.get("done")), _as_int(open_.get("total"))
    frac = 0.0
    if done is not None and total and total > 0:
        frac = max(0.0, min(1.0, done / total))
    elapsed = float(open_.get("secs") or 0.0) + _span_secs(
        open_.get("started_at"), (now or datetime.now(timezone.utc)).isoformat(),
    )
    # What this stage still owes: what it took last time less the part
    # already through, or — when this run is already slower than that —
    # what this run's OWN rate says. An estimate that keeps sliding is
    # worse than one that was pessimistic from the start.
    by_history = prior.get(open_["id"], 0.0) * (1.0 - frac)
    by_rate = elapsed * (1.0 / frac - 1.0) if frac > 0 else 0.0
    remaining = max(by_history, by_rate)
    for later in STEP_IDS[idx + 1:]:
        remaining += prior.get(later, 0.0)
    return remaining if remaining > 0 else None


#: Below this the previous run is too fast to project anything from.
_SIGNAL_MIN_SECS = 5.0


# ── the attempt log ─────────────────────────────────────────────────────
#
# A job ROW is a run; a run has many ATTEMPTS. Every per-attempt field —
# the ledger, the progress, the error, the retry count — used to be
# overwritten in place, so resuming a failed job erased the record of why
# you were resuming it. The attempts that did not succeed are archived
# here first, and the row keeps its history across every resume.


def _attempts_kept() -> int:
    """How many failed attempts a run keeps. Only attempts that did NOT
    succeed are archived — a successful one IS the run record, and storing
    it twice doubles every row's payload for nothing — so a healthy row
    carries none of this at all and the bound only ever binds on a run
    that is genuinely in trouble."""
    try:
        raw = int(os.getenv("AGGREGATION_ATTEMPTS_KEPT", "20"))
    except ValueError:
        raw = 20
    return max(1, min(100, raw))


#: What an archived attempt keeps of each stage. The full ledger entry
#: carries timestamps and a park reason that only mean anything while the
#: stage is live; dropping them roughly halves what a troubled row stores.
_ARCHIVED_STEP_FIELDS = ("id", "state", "secs", "visits", "done", "total", "unit")


def _archive_steps(steps: Any) -> List[Dict[str, Any]]:
    return [
        {k: entry.get(k) for k in _ARCHIVED_STEP_FIELDS}
        for entry in steps
        if isinstance(entry, dict) and entry.get("state") != "pending"
    ]


def failed_stage(steps: Any) -> Optional[str]:
    """The stage an attempt stopped in, or None when it finished them all."""
    if not isinstance(steps, list):
        return None
    for entry in steps:
        if isinstance(entry, dict) and entry.get("state") in ("failed", "cancelled"):
            return str(entry.get("id"))
    return None


def record_attempt(doc: Dict[str, Any], **fields: Any) -> bool:
    """Move the ledger currently on ``doc`` into its attempt log.

    Returns whether anything changed. Idempotent by construction: the
    ledger is REMOVED from the document as it is archived, so a second call
    finds nothing to move. That is what lets both the manual resume path
    and the worker's own attempt start call this without coordinating —
    whichever runs first does the work, the other no-ops.
    """
    steps = doc.get("steps")
    archived = _archive_steps(steps) if isinstance(steps, list) else []
    if not archived:
        doc.pop("steps", None)
        return False
    # A run that finished every stage is not an attempt worth keeping: the
    # row's own record already describes it.
    stage = failed_stage(steps)
    if stage is None and all(e.get("state") == "done" for e in archived):
        doc.pop("steps", None)
        return False

    log = doc.get("attempts")
    log = list(log) if isinstance(log, list) else []
    log.append({
        # Off the highest number the log has held, not its LENGTH: trimming
        # must not restart the count, or two different attempts end up
        # called "3" and the history stops being a history.
        "n": max((int(a.get("n") or 0) for a in log), default=0) + 1,
        "stage": stage,
        "secs": round(sum(float(e.get("secs") or 0) for e in archived), 2),
        "steps": archived,
        **{k: v for k, v in fields.items() if v is not None},
    })
    # Keep the most recent: the failure being worked is the recent one.
    doc["attempts"] = log[-_attempts_kept():]
    doc.pop("steps", None)
    return True


def archive_attempt(job: Any, *, category: Optional[str] = None) -> bool:
    """``record_attempt`` against a job row's ``run_stats`` column.

    Best-effort like every other ``run_stats`` write: a record that cannot
    be serialised must never fail a resume or a job.
    """
    if not hasattr(job, "run_stats"):
        return False
    try:
        doc = json.loads(getattr(job, "run_stats", None) or "{}")
        if not isinstance(doc, dict):
            return False
        changed = record_attempt(
            doc,
            status=getattr(job, "status", None),
            ended_at=getattr(job, "completed_at", None) or getattr(job, "updated_at", None),
            progress=getattr(job, "progress", None),
            error=(getattr(job, "error_message", None) or None),
            category=category,
            writes=doc.get("writes"),
            deletes=doc.get("deletes"),
        )
        job.run_stats = json.dumps(doc)
        return changed
    except (TypeError, ValueError):
        return False
