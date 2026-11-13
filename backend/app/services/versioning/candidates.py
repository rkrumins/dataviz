"""A new version built beside the key that serves (read mode ``beside``: Keep serving, switch when
ready): what a build is, when one is wanted, and how it reads in the watermark.

A graph whose readers should see exactly one version at a time has a large change built in a second
key of its own (``keymigrate.build_key``, in the serving key's cluster slot) while the serving key
keeps serving its version whole; then its readers are switched to the new key in one transaction
(``GraphVersioningService.switch_to_candidate``) and the old key is retired after a grace period.
Nothing writes the serving key while a build exists.

The steps, one a projection pass (``FalkorProjector._advance_candidate``):

* ``queued`` — asked for; waits for room for a copy on the serving key's node (``noRoomPolicy``:
  ``wait`` keeps serving and asks again; ``in_place`` drops the build, and the change is written
  into the serving key, paced);
* ``copying`` — ``GRAPH.COPY`` of the serving key, its lineage summaries included, which holds
  exactly the version it serves (``candidate_seq``);
* ``catching_up`` — the commits since then written into the build's key, a window at a time, its
  summaries moved by the windows' deltas;
* ``switching`` — the build holds the head: checked against Postgres, then switched to.

A build that fails is tried again from its copy, up to ``buildMaxAttempts``, then dropped with its
key, and the change is written in place, as the read mode's fallback. The serving key never
stops serving meanwhile.

Its state lives in ``projection_state`` (``candidate_*``), so a pass on any worker, after a
restart, takes the build up where it is: each step is idempotent, and the build key's own marker
says what it holds.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Mapping, Optional

STEPS = ("queued", "copying", "catching_up", "switching")
#: Why a build was asked for. A large publish window, in this release.
REASONS = ("window",)


def new_state(reason: str, *, now: str, rows: Optional[int] = None) -> Dict[str, Any]:
    """A build's state as it is asked for: ``queued``, no attempt yet."""
    if reason not in REASONS:
        raise ValueError(f"unknown build reason {reason!r}")
    return {"id": f"build_{uuid.uuid4().hex[:12]}", "reason": reason, "mode": "copy",
            "step": "queued", "attempts": 0, "error": None, "retryAt": None, "since": now,
            "waiting": None, **({"rows": int(rows)} if rows is not None else {})}


def wanted(*, read_mode: str, switch_on: Optional[bool], owned: bool, rows: int,
           above: int) -> bool:
    """Whether a publish window of ``rows`` version rows is built beside rather than written in
    place: the graph reads ``beside``, New-version builds is on, the platform owns its key (a
    customer's own key is never copied), and the window is larger than ``buildAboveRows``. A
    smaller window is written in place, paced, as it always was."""
    return read_mode == "beside" and switch_on is True and owned and rows > above


def block(ps: Any) -> Optional[Dict[str, Any]]:
    """The build a graph has, for its watermark and its admin row: ``{id, step, reason, mode,
    seq, attempts, error, waiting, since, rows}``, or None while it has none."""
    state = getattr(ps, "candidate_state", None)
    if not isinstance(state, Mapping):
        return None
    return {"id": state.get("id"), "step": state.get("step"), "reason": state.get("reason"),
            "mode": state.get("mode"), "seq": getattr(ps, "candidate_seq", None),
            "attempts": int(state.get("attempts") or 0), "error": state.get("error"),
            "waiting": state.get("waiting"), "since": state.get("since"),
            "rows": state.get("rows")}
