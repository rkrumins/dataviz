"""A new version built beside the key that serves (read mode ``beside``: Keep serving, switch when
ready): what a build is, when one is wanted, and how it reads in the watermark.

A graph whose readers should see exactly one version at a time has a large change built in a second
key of its own (``keymigrate.build_key``, in the serving key's cluster slot) while the serving key
keeps serving its version whole; then its readers are switched to the new key in one transaction
(``GraphVersioningService.switch_to_candidate``) and the old key is retired after a grace period.
Nothing writes the serving key while a build exists.

Why a build was asked for (``REASONS``):

* ``window`` — a publish larger than ``buildAboveRows``;
* ``rebuild`` — an operator's rebuild, or one the projector started on its own (``CAUSES``: drift
  its verify found, or windows that kept failing under pressure), with ``buildForRebuilds`` on;
* ``move`` — an administrator's move of the graph to another key or provider (``target``), with
  ``buildForRebuilds`` on.

A rebuild or a move is always seeded from Postgres (mode ``reseed``), never copied: a rebuild does
not trust the serving key, and a move's key is elsewhere. A rebuild seeds the head, carrying over
what it can of the serving key's lineage summaries, and hands them to the batch job once switched
(``rollupsStale``); a move seeds the version the serving key holds whole, its summaries exactly.

The steps, one a projection pass (``FalkorProjector._advance_candidate``):

* ``queued`` — asked for; waits for room as ``buildMode`` says: ``copy`` for a copy on the serving
  key's node, ``reseed`` for a seed on the node with most room, ``auto`` for a copy, else a seed
  (``noRoomPolicy``: ``wait`` keeps serving and asks again; ``in_place`` drops the build, and the
  change is written into the serving key, paced);
* ``copying`` — ``GRAPH.COPY`` of the serving key, its lineage summaries included, which holds
  exactly the version it serves (``candidate_seq``);
* ``seeding`` — instead of a copy, the build's key written from Postgres at the version the
  serving key serves (a rebuild: the head), a page at a time when large, then the serving key's
  lineage summaries carried over (mode ``reseed``);
* ``catching_up`` — the commits since then written into the build's key, a window at a time, its
  summaries moved by the windows' deltas;
* ``switching`` — the build holds the head: checked against Postgres, then switched to.

A build that fails is tried again from a fresh copy (a seeded one: seeded again, in its key), up to
``buildMaxAttempts``, then dropped with its key, and the change is made in place, as the read
mode's fallback: a window written into the serving key, a rebuild or a move made as it is without
builds (``GraphVersioningService.drop_candidate``). The serving key never stops serving meanwhile.

Its state lives in ``projection_state`` (``candidate_*``), so a pass on any worker, after a
restart, takes the build up where it is: each step is idempotent, and the build key's own marker
says what it holds.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Mapping, Optional

STEPS = ("queued", "copying", "seeding", "catching_up", "switching")
#: Why a build was asked for: a large publish window, a rebuild, or a move.
REASONS = ("window", "rebuild", "move")
#: Who asked for a rebuild: an operator, or the projector on its own (drift its verify found, or
#: windows that kept failing under pressure).
CAUSES = ("operator", "drift", "failures")


def new_state(reason: str, *, now: str, rows: Optional[int] = None,
              rebuild: Optional[Mapping[str, Any]] = None,
              target: Optional[Mapping[str, Any]] = None, step: str = "queued") -> Dict[str, Any]:
    """A build's state as it is asked for, no attempt yet: ``queued``, or ``seeding`` for a move
    whose seed was admitted with it (its version and cursor are taken on its first pass). A
    rebuild or a move is seeded from Postgres. ``rebuild`` (``{cause, why}``): the build replaces
    a rebuild, whose summaries are handed to the batch job once switched. ``target``
    (``{providerId, key, shardMap, movedBy, retired}``): the key a move goes to, and its entries
    in ``retired_keys`` it took off them (a move back), put back should the move be dropped."""
    if reason not in REASONS:
        raise ValueError(f"unknown build reason {reason!r}")
    if rebuild is not None and rebuild.get("cause") not in CAUSES:
        raise ValueError(f"unknown rebuild cause {rebuild.get('cause')!r}")
    state = {"id": f"build_{uuid.uuid4().hex[:12]}", "reason": reason,
             "mode": "copy" if reason == "window" else "reseed",
             "step": step, "attempts": 0, "error": None, "retryAt": None, "since": now,
             "waiting": None, **({"rows": int(rows)} if rows is not None else {})}
    if rebuild is not None:
        state["rebuild"] = {"cause": rebuild["cause"], "why": rebuild.get("why")}
        state["rollupsStale"] = True
    if target is not None:
        state["target"] = {k: target.get(k)
                           for k in ("providerId", "key", "shardMap", "movedBy", "retired")}
    if step == "seeding":
        state.update(seedSeq=None, seedPhase=None, summariesAt=0)
    return state


def wanted(*, read_mode: str, switch_on: Optional[bool], owned: bool, rows: int,
           above: int) -> bool:
    """Whether a publish window of ``rows`` version rows is built beside rather than written in
    place: the graph reads ``beside``, New-version builds is on, the platform owns its key (a
    customer's own key is never copied), and the window is larger than ``buildAboveRows``. A
    smaller window is written in place, paced, as it always was."""
    return read_mode == "beside" and switch_on is True and owned and rows > above


def beside_wanted(*, read_mode: str, switch_on: Optional[bool], for_rebuilds: Any) -> bool:
    """Whether the policy wants a rebuild or a move built beside: the graph reads ``beside``,
    New-version builds is on (a switch that can't be read counts as off) and ``buildForRebuilds``
    is on. The graph's row decides the rest (``service._beside_ok``)."""
    return read_mode == "beside" and switch_on is True and for_rebuilds is True


def on_request(build: Any, *, reason: str, target: Optional[Mapping[str, Any]] = None,
               pin: Optional[Mapping[str, Any]] = None) -> str:
    """What a rebuild or a move asked for does to the build a graph has (``build``, its
    ``candidate_state``; ``target`` and ``pin``: ``{providerId, key}``):

    * ``none`` — there is none: the request goes ahead as it would with none;
    * ``keep`` — the build already does it (a rebuild beside, a move to the same key), or a move to
      the key the graph is on asks nothing of it: left as it is;
    * ``upgrade`` — a rebuild asked during a move: the move rebuilds too, as its raw layer comes
      from Postgres anyway;
    * ``replace`` — the build is dropped, its key retired at once, and the request goes ahead: a
      window's build is built beside the key a rebuild distrusts or a move leaves, and a move
      elsewhere supersedes a rebuild or a move (inheriting the rebuild);
    * ``cancel`` — a move back to the key the graph is on, while it moves: the move is dropped."""
    if not isinstance(build, Mapping):
        return "none"
    kind = build.get("reason")

    def where(of: Optional[Mapping[str, Any]]) -> tuple:
        return ((of or {}).get("providerId"), (of or {}).get("key"))

    if reason == "move" and where(target) == where(pin):
        return "cancel" if kind == "move" else "keep"
    if kind == "window":
        return "replace"
    if reason == "rebuild":
        return "upgrade" if kind == "move" and not build.get("rebuild") else "keep"
    if kind == "move" and where(target) == where(build.get("target")):
        return "keep"
    return "replace"


def block(ps: Any) -> Optional[Dict[str, Any]]:
    """The build a graph has, for its watermark and its admin row: ``{id, step, reason, mode,
    seq, attempts, error, waiting, since, rows, progress, target, rebuild}``, or None while it has
    none. ``progress`` (``{done, total}``) is how far a seed or a catch-up has written, while it
    does; ``target`` (``{providerId, key}``) the key a move goes to; ``rebuild`` who asked for the
    rebuild it makes (``CAUSES``)."""
    state = getattr(ps, "candidate_state", None)
    if not isinstance(state, Mapping):
        return None
    target = state.get("target") if isinstance(state.get("target"), Mapping) else None
    rebuild = state.get("rebuild") if isinstance(state.get("rebuild"), Mapping) else None
    return {"id": state.get("id"), "step": state.get("step"), "reason": state.get("reason"),
            "mode": state.get("mode"), "seq": getattr(ps, "candidate_seq", None),
            "attempts": int(state.get("attempts") or 0), "error": state.get("error"),
            "waiting": state.get("waiting"), "since": state.get("since"),
            "rows": state.get("rows"), "progress": state.get("progress"),
            "target": ({"providerId": target.get("providerId"), "key": target.get("key")}
                       if target else None),
            "rebuild": rebuild.get("cause") if rebuild else None}
