"""Where a database stands on this build's migration chain, and what an upgrade would do to it.

Read-only: nothing here writes. The upgrade Job (``scripts/upgrade.py``) acts on these answers,
``synodic-upgrade plan`` and the pre-upgrade backup report them, and the admin schema status
(``services/system_status/schema.py``) shows them.

* **Stamps another build wrote.** ``alembic_version`` can name revisions this build doesn't have:
  another branch's build, a newer release's before a rollback, a merge made by hand. They are
  placed at the last revisions of this chain the database ran, from the lineage the database
  keeps (``migration_records``) or the frozen record (``alembic/other_lines.json``); a stamp no
  lineage places is refused unless recovery estimates it (:func:`parting_point`).
* **The plan** (:func:`plan_upgrade`): refused, a fresh install, up to date, or which migrations
  an upgrade would run, in order, with what should be known first.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import inspect, text

#: Any of these present means the database is not virgin. ``users`` alone would do; the other
#: two make the check survive a future rename.
APP_TABLES = ("users", "workspaces", "providers")


class Refused(Exception):
    """The Job won't go on, and has changed nothing: the message says why, and what to do."""


@dataclass
class Placement:
    """Where a database stamped by another build is placed on this chain."""

    foreign: list[str]      # the stamps this build doesn't have
    kept: list[str]         # the stamps of ours beside them
    stamps: list[str]       # the stamps it gets: the last revisions of ours it ran
    how: str                # how that was found, for the log


def stamps(conn) -> list[str]:
    """The revisions ``alembic_version`` names (none without the table)."""
    if not inspect(conn).has_table("alembic_version"):
        return []
    return sorted(r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version")))


def is_virgin(conn) -> bool:
    """True when this database has no schema of ours at all.

    ``alembic/env.py`` creates ``alembic_version`` as a side effect of loading, so anything asking
    after it has loaded sees a table env.py just made: asked before, here. ``alembic_version``
    present but EMPTY still counts as virgin — what env.py leaves if a first run dies early.
    """
    inspector = inspect(conn)
    if any(inspector.has_table(name) for name in APP_TABLES):
        return False
    if not inspector.has_table("alembic_version"):
        return True
    return conn.execute(text("SELECT count(*) FROM alembic_version")).scalar() == 0


def built_from() -> tuple[str, bool | None]:
    """Where this image was built from, and whether that commit is on ``main``: True, False, or None
    when the image doesn't say. ``deploy/build-images.sh`` and the ``build-images`` workflow record
    it (``SYNODIC_BUILD_*``, baked in by the Dockerfiles); an image built any other way doesn't."""
    sha, ref = os.getenv("SYNODIC_BUILD_SHA"), os.getenv("SYNODIC_BUILD_REF")
    if not sha:
        return "an unrecorded commit", None
    return f"{ref or '?'} at {sha}", os.getenv("SYNODIC_BUILD_ON_MAIN") == "true"


def foreign(script, stamped: list[str]) -> list[str]:
    """The stamps this build's chain doesn't have; Alembic can't start from them."""
    known = {rev.revision for rev in script.walk_revisions()}
    return [v for v in stamped if v not in known]


def parting_point(script, foreign_stamps: list[str]) -> str | None:
    """Where this build's chain and the one that wrote ``foreign_stamps`` most likely parted:
    walking this build's chain down from its head, the first revision whose id — which leads with
    when it was written, to the minute — is from an earlier minute than every foreign one. One from
    the same minute may be newer or older, so it counts as not run. A newer release's stamp parts at
    this build's head: nothing of ours to run. Walked in chain order, not sorted by id: a revision
    moved onto a newer parent keeps its older id."""
    oldest = min(foreign_stamps)[:13]           # YYYYMMDD_HHMM
    return next((rev.revision for rev in script.walk_revisions() if rev.revision[:13] < oldest), None)


def other_lines(script_location: str) -> dict[str, list[list[str]]]:
    """``alembic/other_lines.json`` (``scripts/other_lines.py``): each revision another line of work
    has and this chain doesn't, with the parents to walk — those it has at a branch's tip where it
    is on one, else every set it was ever given. Empty when the file is missing or unreadable."""
    try:
        recorded = json.loads((Path(script_location) / "other_lines.json")
                              .read_text(encoding="utf-8"))["revisions"]
        return {rev: entry.get("at_tips") or entry["parents"] for rev, entry in recorded.items()}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}


def ran(script, lines: dict, revision: str, depth: int = 0) -> list[frozenset] | None:
    """The revisions of this chain a database stamped ``revision`` has run: one set for each way
    its recorded parents could have been. None when its lineage reaches a revision nothing records."""
    try:
        ours = script.get_revision(revision) is not None
    except Exception:  # noqa: BLE001 — not one of ours: look it up
        ours = False
    if ours:
        return [frozenset(r.revision for r in script.iterate_revisions(revision, "base"))]
    if revision not in lines or depth > 500:
        return None
    out: list[frozenset] = []
    for parents in lines[revision]:
        sets = [frozenset()]
        for parent in parents:
            below = ran(script, lines, parent, depth + 1)
            if below is None:
                return None
            sets = [a | b for a in sets for b in below]
        out.extend(sets)
    return out


def ancestors(script, stamped) -> set[str]:
    """Every revision of ours a database stamped ``stamped`` (ours) has run, the stamps included."""
    return {r.revision for stamp in stamped for r in script.iterate_revisions(stamp, "base")}


def maximal(script, revisions: set) -> list[str]:
    """The stamps of a database that has run exactly ``revisions``: those nothing in it follows."""
    return sorted(r for r in revisions if not (script.get_revision(r).nextrev & revisions))


def placed(script, lines: dict, foreign_stamps: list[str], kept: list[str]) -> list[str] | None:
    """Exactly where a database stamped with ``foreign_stamps`` (beside ``kept``, ours) stands on
    this chain, as the stamps of the last revisions it ran: what every recorded way each foreign
    stamp could have come about has in common. None when a foreign stamp's lineage isn't recorded."""
    have = ancestors(script, kept)
    for revision in foreign_stamps:
        sets = ran(script, lines, revision)
        if not sets:
            return None
        have |= frozenset.intersection(*sets)
    if not have:
        return None
    return maximal(script, have)


_GAP = re.compile(r"^(?:missing table|missing column|type mismatch|nullability mismatch) ([\w.]+)")


def below_gaps(script, stamped: list[str], kept: list[str], gaps: list[str]) -> list[str] | None:
    """Where to place a database again when, upgraded from ``stamped``, its schema still lacks
    ``gaps``: below each revision the placement took as run (``kept``, the stamps of ours it had,
    it trusts) whose migration names what's missing — its table, or its table and column. None
    when some gap is named by none of them: nothing of ours run again would bring it."""
    claimed = ancestors(script, stamped) - ancestors(script, kept)
    sources: dict[str, str] = {}
    culprits: set[str] = set()
    for gap in gaps:
        found = _GAP.match(gap)
        if not found:
            return None
        words = found.group(1).split(".")[1:]           # the schema is no name a migration uses
        named = set()
        for revision in claimed:
            if revision not in sources:
                sources[revision] = Path(script.get_revision(revision).path).read_text(encoding="utf-8")
            if all(re.search(rf"\b{re.escape(w)}\b", sources[revision]) for w in words):
                named.add(revision)
        if not named:
            return None
        culprits |= named
    have = {r for r in ancestors(script, stamped) if not (ancestors(script, [r]) & culprits)}
    return maximal(script, have) or None


def placement(script, stamped: list[str], lines: dict, own: dict, rewind_to: str | None = None,
              recover: bool = False) -> Placement | None:
    """Where a database stamped ``stamped`` goes on this chain, or None when every stamp is ours.

    From the lineage the database keeps (``own``, ahead of the record ``lines``), exactly; or at
    ``rewind_to``, named by an operator; or, with ``recover``, where the chains most likely parted.
    Otherwise :class:`Refused`, naming the estimate."""
    foreign_stamps = foreign(script, stamped)
    if not foreign_stamps:
        return None
    kept = [v for v in stamped if v not in foreign_stamps]
    exact = None if rewind_to is not None else placed(script, {**lines, **own}, foreign_stamps, kept)
    if exact is not None:
        how = ("exactly, from this database's own lineage" if all(f in own for f in foreign_stamps)
               else "exactly, from the lineage other lines recorded")
        return Placement(foreign_stamps, kept, exact, how)
    if rewind_to is not None:
        script.get_revision(rewind_to)                  # one of ours, or Alembic says it isn't
        to, how = rewind_to, "as named (--rewind-to)"
    elif recover:
        to, how = parting_point(script, foreign_stamps), "where the two most likely parted (--recover)"
    else:
        raise Refused(
            f"alembic_version names {foreign_stamps}, which this build doesn't have, and no lineage "
            "(this database's own, or alembic/other_lines.json) says what it ran. Nothing was "
            "changed. Name the last revision of this build's that it ran: `upgrade --rewind-to "
            "<revision>`; or let this build estimate it, checked against the schema: `upgrade "
            "--recover` (Helm: upgrade.recoverForeignStamps). Its estimate would be "
            f"{parting_point(script, foreign_stamps)}.")
    if to is None:
        raise Refused(f"alembic_version names {foreign_stamps}, which this build doesn't have, and none "
                      "of this build's revisions is older: deploy the build that has them.")
    # One of ours still stamped beside a foreign one may already be past the parting point.
    past = to in ancestors(script, kept)
    return Placement(foreign_stamps, kept, kept if past else sorted(set(kept) | {to}), how)


def gather(conn, script, script_location: str) -> dict:
    """What :func:`plan_upgrade` reads from a database, on a (sync) connection."""
    from backend.app.db import migration_records

    return {
        "stamped": stamps(conn),
        "virgin": is_virgin(conn),
        "own": migration_records.read_chain(conn),
        "lines": other_lines(script_location),
        "open_placement": migration_records.open_placement(conn),
        "changed": [revision for revision, _path in migration_records.changed(conn, script)],
    }


def plan_upgrade(script, *, stamped: list[str], virgin: bool, own: dict, lines: dict,
                 open_placement: dict | None, changed: list[str], built: tuple[str, bool | None],
                 recover: bool = False, shared: bool = False, rewind_to: str | None = None) -> dict:
    """What ``synodic-upgrade upgrade`` (to every head) would do to this database, changing nothing.

    ``verdict``: ``refused`` (it would stop, with nothing changed: ``reason`` says why),
    ``fresh_install``, ``up_to_date`` or ``upgrade``; ``placement`` for a database another build
    stamped; ``wouldRun``, the migrations in the order they'd run; ``warnings``."""
    where, on_main = built
    heads = sorted(script.get_heads())
    out = {"build": {"from": where, "onMain": on_main}, "heads": heads, "stamps": stamped,
           "verdict": "up_to_date", "reason": "", "placement": None, "wouldRun": [], "warnings": []}
    warnings = out["warnings"]
    for revision in changed:
        warnings.append(f"Migration {revision} has changed since it ran on this database; the change "
                        "won't reach it.")
    if shared and on_main is None:
        warnings.append("The database is shared, and this image doesn't record the commit it was "
                        "built from, so it can't be held to main's.")
    if shared and on_main is False and stamped != heads:
        out.update(verdict="refused", reason=f"The database is shared, and this build is from {where}, "
                   "not a commit on main: only builds from main migrate a shared database.")
        return out
    if virgin:
        out.update(verdict="fresh_install", reason="An empty database: the schema is built at head "
                   "and the reference data seeded; no migration replays.")
        return out
    now = stamped
    if open_placement is not None and not foreign(script, stamped):
        warnings.append(f"An upgrade placed this database at {open_placement.get('stamps')} and stopped "
                        "before checking its schema: the next upgrade checks it.")
    try:
        place = placement(script, stamped, lines, own, rewind_to, recover)
    except Refused as refused:
        out.update(verdict="refused", reason=str(refused))
        return out
    if place is not None:
        now = place.stamps
        out["placement"] = {"foreign": place.foreign, "stamps": place.stamps, "how": place.how}
    # Everything the heads need that the stamps don't already have, ancestors first: what Alembic
    # runs. (A path above the stamps alone would miss the other side of a merge.)
    have = ancestors(script, now)
    pending = [r.revision for r in reversed(list(script.walk_revisions())) if r.revision not in have]
    out["wouldRun"] = pending
    if pending or place is not None:
        out["verdict"] = "upgrade"
        out["reason"] = (f"{len(pending)} migration(s) to run." if pending
                         else "Nothing to run once placed; the stamps move.")
    else:
        out["reason"] = "At this build's head: nothing to run."
    return out


def describe(plan: dict) -> str:
    """``plan`` as an operator reads it."""
    build = plan["build"]
    on_main = {True: "on main", False: "not on main", None: "on main or not, unrecorded"}[build["onMain"]]
    lines = [f"This build: {build['from']} ({on_main}); its chain ends at {plan['heads']}",
             f"The database is stamped {plan['stamps'] or 'nothing'}",
             f"An upgrade would: {plan['verdict'].replace('_', ' ')}. {plan['reason']}"]
    if plan["placement"]:
        lines.append(f"  placed at {plan['placement']['stamps']}, {plan['placement']['how']}")
    for i, revision in enumerate(plan["wouldRun"], 1):
        lines.append(f"  {i:>3}. {revision}")
    lines += [f"Warning: {w}" for w in plan["warnings"]]
    return "\n".join(lines)
