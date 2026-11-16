"""New-version builds (doc 14 §6): when and how a versioned graph's next version is built in a second
key while the key that serves it keeps serving, then switched to — and the pacing and Postgres limits
that keep reads served while a graph is written.

Every value is a versioned-graph setting (``config/versioned_graph_settings.py``), kept in the
settings store at the platform's scope (``services.settings``) and changed live by a system
administrator (``/admin/versioning/build-policy``, Admin → Infrastructure → New-version builds). This
module keeps the names they had before the store, for the code that acts on them: each value by its
wire name (its setting's ``Legacy.build_policy``), in its old spelling (``copyMaxBytes`` 0: no limit).
:func:`resolve` brings this process's settings up to date (``settings.effective.refresh``: Redis at
most every two seconds, the database only when a save moved the settings' generation), so a save
reaches every process within about two seconds, and :func:`current` reads them without IO. Neither
raises: with the database out of reach, the values last read keep serving, and before any were read
the defaults. The route refuses what the resolver would clamp, naming the field (:func:`validate`),
saves through the store (:func:`save`) and, for one release, writes the old JSON too
(``platform_settings.gv_build_policy``, :func:`saved_values`). Each setting's card is described once,
in :data:`FIELDS`, which the admin card renders from.

Whether builds happen at all is a switch, not a value: ``candidateKeysEnabled`` (Admin → Features,
:func:`switch_state`).
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, Tuple

from backend.app.db.repositories.profiling_repo import INHERIT
from backend.app.services.settings import effective as in_force
from backend.app.services.settings import legacy, registry, resolver, store
from backend.app.services.settings.resolver import Row
from backend.app.services.settings.snapshot import env_reader

from . import config

logger = logging.getLogger(__name__)

#: The New-version builds switch (Admin → Features).
SWITCH = "candidateKeysEnabled"

MODES = ("auto", "copy", "reseed")
NO_ROOM = ("wait", "in_place")


@dataclass(frozen=True)
class Field:
    """One setting: its name on the wire, its environment default, its kind and range, and how the
    admin card shows it. ``applies``: ``next`` (a build already under way keeps the value it started
    with), ``live`` (read at every window and statement) or ``switch`` (stamped when a build
    switches, or a key is moved)."""
    wire: str
    default: Callable[[], Any]
    kind: str                         # bool | int | ratio | choice
    section: str                      # reads | when | room | lifecycle | pacing | postgres
    label: str
    help: str
    unit: str = ""                    # rows | pct | bytes | secs | ms | count | ratio
    lo: float = 0
    hi: float = 0
    choices: Tuple[str, ...] = ()
    applies: str = "next"


FIELDS: Tuple[Field, ...] = (
    Field("readMode", lambda: config.READ_MODE, "choice", "reads",
          "Reads while a new version lands",
          "What readers of a graph get while its next version is written into FalkorDB. Always the "
          "latest: the newest published version at once, from Postgres until FalkorDB holds it. "
          "Keep serving, update in place: the version FalkorDB last finished, while the next is "
          "written into it. Keep serving, switch when ready: exactly that version, while the next "
          "is built in a second key, then one switch. A graph can set its own.",
          choices=config.READ_MODES, applies="live"),
    Field("buildAboveRows", lambda: config.PROJECTION_CANDIDATE_ABOVE, "int", "when",
          "Build beside above",
          "A publish that changes more rows than this is built in a second key while the current "
          "one keeps serving; a smaller one is written in place, paced.",
          unit="rows", lo=1_000, hi=100_000_000),
    Field("buildForRebuilds", lambda: config.PROJECTION_CANDIDATE_REBUILDS, "bool", "when",
          "Rebuilds and moves too",
          "Rebuilds and moves of keys the platform owns are built beside too: the new key is "
          "seeded from Postgres while readers keep the current version, then they switch."),
    Field("buildMode", lambda: config.PROJECTION_CANDIDATE_MODE, "choice", "room",
          "How a build makes its key",
          "Auto copies the serving key when its node has room, else seeds the new key from "
          "Postgres on the node with most room. Copy only waits for room on the node; reseed only "
          "always seeds from Postgres.",
          choices=MODES),
    Field("copyMarginPct", lambda: config.PROJECTION_COPY_MARGIN_PCT, "int", "room",
          "Room a copy needs",
          "The free memory a copy needs on its node, as a share of the graph's size. While it "
          "runs, a copy holds the new key and its own buffer, each about the graph's size.",
          unit="pct", lo=100, hi=400),
    Field("copyMaxBytes", lambda: config.PROJECTION_COPY_MAX_BYTES, "int", "room",
          "Largest graph copied",
          "A graph larger than this is never copied: Auto seeds it from Postgres instead, and "
          "Copy only waits. 0: no limit.",
          unit="bytes", lo=0, hi=16 * 2 ** 40),
    Field("noRoomPolicy", lambda: config.PROJECTION_NO_ROOM_POLICY, "choice", "room",
          "With no room",
          "Wait keeps serving the current version until there's room. In place writes the change "
          "into the serving key, paced, so readers may see it partly applied until it finishes.",
          choices=NO_ROOM),
    Field("noRoomAlertSecs", lambda: config.PROJECTION_NO_ROOM_ALERT_SECS, "int", "room",
          "Alert after waiting",
          "A build that waits for room longer than this raises an alert.",
          unit="secs", lo=300, hi=86_400),
    Field("buildConcurrency", lambda: config.PROJECTION_CANDIDATE_CONCURRENCY, "int", "lifecycle",
          "Builds at once per worker",
          "How many builds each versioning worker runs at once; never more than its projection "
          "concurrency.",
          unit="count", lo=1, hi=8),
    Field("buildMaxAttempts", lambda: config.PROJECTION_CANDIDATE_MAX_ATTEMPTS, "int", "lifecycle",
          "Attempts before giving up",
          "A build that fails this many times is dropped, and the current version keeps serving.",
          unit="count", lo=1, hi=10),
    Field("flipMaxLagRows", lambda: config.PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS, "int",
          "lifecycle", "Catch-up allowed in the switch",
          "A build switches once it is this few rows behind; the rest is applied inside the switch.",
          unit="rows", lo=0, hi=1_000_000),
    Field("retireGraceSecs", lambda: config.RETIRE_GRACE_SECS, "int", "lifecycle",
          "Keep the previous key for",
          "How long a graph's previous key stays after a switch or a move, so reads already under "
          "way finish on it.",
          # Past the versioned-graph set's cache (``versioned_sources.CACHE_TTL_SECS``, 600 s): a
          # data source versioned within it still reads its own key, which must outlive it.
          unit="secs", lo=660, hi=86_400, applies="switch"),
    Field("statementTargetMs", lambda: config.PROJECTION_STATEMENT_TARGET_MS, "int", "pacing",
          "Write statement target",
          "The time each projector write statement aims at; larger batches are split to stay under "
          "it, so reads on the same node keep their turn.",
          unit="ms", lo=100, hi=10_000, applies="live"),
    Field("writeCeilingSecs", lambda: config.PROJECTION_WRITE_CEILING_S, "int", "pacing",
          "Longest write statement",
          "The most one projector write statement may take before it is stopped and split.",
          unit="secs", lo=1, hi=60, applies="live"),
    Field("pacingRatio", lambda: config.PROJECTION_PACING_RATIO, "ratio", "pacing",
          "Pause after each write",
          "The pause after each write statement, as a share of the time it took.",
          unit="ratio", lo=0, hi=5, applies="live"),
    Field("readPressureRatio", lambda: config.PROJECTION_READ_PRESSURE_RATIO, "ratio", "pacing",
          "Pause while reads wait",
          "The pause after each write statement while reads on the node are waiting, as a share of "
          "the time it took.",
          unit="ratio", lo=0, hi=10, applies="live"),
    Field("pgStatementTimeoutMs", lambda: config.READ_STATEMENT_TIMEOUT_MS, "int", "postgres",
          "Statement limit",
          "The most one read of a graph from Postgres may take, while FalkorDB holds no version of "
          "it.",
          unit="ms", lo=1_000, hi=120_000, applies="live"),
    Field("pgReadsPerGraph", lambda: config.PG_READS_PER_GRAPH, "int", "postgres",
          "Reads at once per graph",
          "How many reads of one graph from Postgres run at once in each process; more wait, then "
          "are asked to retry.",
          unit="count", lo=1, hi=64, applies="live"),
    Field("pgReadsPerProcess", lambda: config.PG_READS_PER_PROCESS, "int", "postgres",
          "Reads at once per process",
          "How many reads from Postgres run at once in each process, across graphs, so they never "
          "take the whole connection pool.",
          unit="count", lo=1, hi=64, applies="live"),
)

BY_WIRE: Dict[str, Field] = {f.wire: f for f in FIELDS}


@dataclass(frozen=True)
class BuildPolicy:
    """The settings in force, by wire name: ``policy["buildAboveRows"]``."""
    values: Mapping[str, Any]

    def __getitem__(self, wire: str) -> Any:
        return self.values[wire]


class PolicyInvalid(ValueError):
    """A value the routes refuse: unknown, out of its range, of the wrong kind, or contradicting
    another."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field


#: Each field's setting in the registry, by wire name.
_SETTINGS = {s.legacy.build_policy: s for s in registry().SETTINGS
             if s.legacy is not None and s.legacy.build_policy}
#: The policy built from this process's settings as last refreshed, and the context it came from:
#: built again only when a refresh brought new rows or switches.
_BUILT: Dict[str, Any] = {"ctx": None, "policy": None}


async def switch_state(session=None) -> Optional[bool]:
    """The New-version builds switch: True or False, or None when it can't be read — never a
    default in place of a read that failed. Through ``session`` (the management database), read now
    from the feature store; without, through the flag cache (30 seconds). A switch the registry
    hasn't seeded yet reads as off, its shipped default."""
    from backend.app.services.feature_flags import FeatureFlagService, feature_flags

    try:
        if session is None:
            return await feature_flags.is_enabled_self_session(SWITCH, default=False)
        return await FeatureFlagService(ttl=0).is_enabled(SWITCH, session, default=False)
    except Exception:  # noqa: BLE001 — unread is not off
        logger.warning("builds: the New-version builds switch could not be read", exc_info=True)
        return None


async def enabled() -> bool:
    """Whether builds are on, as this process's flag cache has it. Unreadable counts as off."""
    return await switch_state() is True


def _context(saved: Mapping[str, Any]) -> resolver.Context:
    """The settings as the platform would hold ``saved`` (by wire name, in the old spelling; None:
    not set), with the deployment's environment, for the resolver."""
    reg = registry()
    rows = [Row(s.key, "platform", "", resolver.decode(s, saved[wire]))
            for wire, s in _SETTINGS.items() if saved.get(wire) is not None]
    return resolver.context(reg.SETTINGS, rows, env=env_reader(reg.SETTINGS, reg.DEPLOYMENT),
                            why=reg.WHY)


def _values(ctx: resolver.Context) -> Dict[str, Any]:
    """Each value in force at the platform, by wire name, in its old spelling. The read mode is the
    one the platform chose (else its default), whether New-version builds are on or not: what a
    graph with no mode of its own reads by, as before the store (``candidates`` says whether a
    build happens)."""
    out = {}
    for f in FIELDS:
        s = _SETTINGS[f.wire]
        value = (resolver.resolve(ctx, s.key)["declared"] if f.wire == "readMode"
                 else resolver.effective(ctx, s.key))
        value = resolver.encode(s, value)
        out[f.wire] = float(value) if f.kind == "ratio" else value
    return out


def _policy(ctx: resolver.Context) -> BuildPolicy:
    """The policy of this process's settings ``ctx``, built once per context."""
    if _BUILT["ctx"] is not ctx:
        _BUILT.update(ctx=ctx, policy=BuildPolicy(_values(ctx)))
    return _BUILT["policy"]


def effective(saved: Mapping[str, Any]) -> BuildPolicy:
    """The settings in force given the values ``saved`` (by wire name, in the old spelling; None =
    unset), as the resolver holds them: each in its range, no more builds per worker than its
    projection concurrency, and no more Postgres reads per graph than per process."""
    return BuildPolicy(_values(_context(saved)))


def defaults() -> BuildPolicy:
    """The settings with nothing saved: the environment's where it is valid, else the code's."""
    return effective({})


def _stored(row) -> Dict[str, Any]:
    raw = getattr(row, "gv_build_policy", None) if row is not None else None
    try:
        stored = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        logger.warning("builds: the saved New-version build settings are not JSON; using defaults")
        stored = {}
    return stored if isinstance(stored, dict) else {}


def saved_values(row) -> Dict[str, Any]:
    """What ``row`` (``platform_settings``, or None) holds for each value, by wire name: the old
    storage, which a save still writes through to for one release."""
    values = _stored(row).get("values") or {}
    return {f.wire: values.get(f.wire) for f in FIELDS}


def stored_values(rows: Sequence[Row]) -> Dict[str, Any]:
    """What the settings store holds for each value at the platform (``rows``: its platform rows,
    ``store.read_scope``), by wire name, in the old spelling; None: not set."""
    held = {r.key: r.value for r in rows}
    out = {}
    for f in FIELDS:
        s = _SETTINGS[f.wire]
        out[f.wire] = None if held.get(s.key) is None else resolver.encode(s, held[s.key])
    return out


#: The generation the previous image's processes watch (its memo of this policy). Moved on a save
#: for one release, so a rolling deploy's old pods read the save within two seconds too.
_OLD_GEN_KEY = "gv:build_policy:gen"


async def invalidate() -> None:
    """Read the settings again now, in this process. A save through the store has moved the
    settings' generation already, so every other process reads it within two seconds; the old
    generation moves too, for processes still on the previous image."""
    await in_force.refresh(strict=True)
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        await asyncio.wait_for(get_redis().incr(_OLD_GEN_KEY), timeout=0.5)
    except Exception:  # noqa: BLE001 — the previous image then reads it within its 30-second memo
        logger.info("builds: the previous image's build-settings generation could not be moved")


def read_mode_of(override: Optional[str], policy: Optional["BuildPolicy"] = None) -> str:
    """A graph's read mode: its own (``projection_state.read_mode``), else the platform's
    (``readMode``, from ``policy``, else as last resolved)."""
    if override in config.READ_MODES:
        return override
    return (policy or current())["readMode"]


def max_lag_of(mode: str) -> Optional[int]:
    """How far behind its head a key may serve a graph in ``mode`` (``serving_seq``): not at all
    for ``latest``, so its reads go to Postgres until FalkorDB holds the newest version; else None,
    the platform's ``GRAPHVER_READ_MAX_LAG``."""
    return 0 if mode == "latest" else None


def current() -> BuildPolicy:
    """The settings in force as this process last refreshed them, else the defaults, without IO:
    for a path that runs per statement and can't wait on a read. Its caller resolves now and then
    (the projector, per pass section; the worker, each poll), so a change reaches it within about
    as long as :func:`resolve` takes to see one."""
    return _policy(in_force.context_now())


async def resolve(session=None) -> BuildPolicy:
    """The settings in force, after bringing this process's up to date: Redis is asked at most
    every two seconds whether a save moved the settings' generation, and the database read only
    when one did (or every 30 seconds without Redis). Never raising: with the database out of
    reach, the values last read, or before any the defaults. ``session`` is not read: the
    settings are read on a pool of their own."""
    return _policy(await in_force.refresh())


def _is_inherit(value: Any) -> bool:
    return type(value) is int and value == INHERIT


def merged(saved: Mapping[str, Any], values: Mapping[str, Any]) -> Dict[str, Any]:
    """What would be saved once ``values`` (``-1`` clears one, None leaves it) are applied. A value
    saved for a setting a later release removed is not kept."""
    out = {w: v for w, v in saved.items() if w in BY_WIRE}
    out.update({w: None if _is_inherit(v) else v for w, v in values.items() if v is not None})
    return out


def validate(values: Mapping[str, Any], saved: Mapping[str, Any]) -> None:
    """Refuse a change (``values`` by wire name; ``-1`` clears one, None leaves it) that names an
    unknown setting, gives one of the wrong kind or out of its range, or would contradict another
    once in force with what is ``saved``: :class:`PolicyInvalid` naming the field."""
    for wire, value in values.items():
        f = BY_WIRE.get(wire)
        if f is None:
            raise PolicyInvalid(wire, f"{wire} is not a New-version build setting")
        if value is None or _is_inherit(value):
            continue
        if f.kind == "bool":
            if not isinstance(value, bool):
                raise PolicyInvalid(wire, "must be true or false, or -1 for the default")
        elif f.kind == "choice":
            if value not in f.choices:
                raise PolicyInvalid(wire, f"must be {', '.join(f.choices[:-1])} or {f.choices[-1]}, "
                                          "or -1 for the default")
        elif f.kind == "ratio":
            if isinstance(value, bool) or not isinstance(value, (int, float)) \
                    or not f.lo <= value <= f.hi:
                raise PolicyInvalid(wire, f"must be a number from {f.lo:g} to {f.hi:g}, or -1 for "
                                          "the default")
        elif type(value) is not int or not f.lo <= value <= f.hi:
            raise PolicyInvalid(wire, f"must be a whole number from {int(f.lo):,} to {int(f.hi):,}, "
                                      "or -1 for the default")
    # Each value as it would be chosen once saved (else its default), before it is held to the other.
    after = _context(merged(saved, values))
    per_graph, per_process = (resolver.resolve(after, _SETTINGS[wire].key)["declared"]
                              for wire in ("pgReadsPerGraph", "pgReadsPerProcess"))
    if per_graph > per_process and {"pgReadsPerGraph", "pgReadsPerProcess"} & set(values):
        raise PolicyInvalid(
            "pgReadsPerGraph" if "pgReadsPerGraph" in values else "pgReadsPerProcess",
            f"reads at once per graph ({per_graph}) may not be more than per process "
            f"({per_process})")


async def save(session, rows: Sequence[Row], values: Mapping[str, Any], actor: Optional[str], *,
               reason: Optional[str] = None,
               before_commit: Optional[store.Hook] = None) -> store.ChangeSet:
    """Save ``values`` (by wire name, in the old spelling; None clears one; already validated)
    through the settings store, each checked against its version in ``rows`` (the platform's, as
    read for the change), as the old route's (``legacy_api``), and commit. In the same transaction
    the old JSON is written through, then ``before_commit`` runs (the route's activity record)."""
    versions = {r.key: r.version for r in rows}
    changes = [store.Change(s.key, "platform", "", versions.get(s.key, 0),
                            value=None if values[wire] is None else resolver.decode(s, values[wire]))
               for wire, s in _SETTINGS.items() if wire in values]

    async def through(s, change_set: store.ChangeSet) -> None:
        await legacy.write_through(s, change_set)
        if before_commit is not None:
            await before_commit(s, change_set)

    return await store.apply(session, registry().DOMAIN, changes, actor=actor, reason=reason,
                             source="legacy_api", before_commit=through)


def describe(rows: Sequence[Row]) -> Dict[str, Any]:
    """Each value as saved (``rows``: the settings store's at the platform, ``store.read_scope``),
    its default and its effective value; each setting's kind, range, unit, section, label and help,
    for the admin card; and who changed the settings last and when."""
    saved = stored_values(rows)
    default, effect = defaults(), effective(saved)
    keys = {s.key for s in _SETTINGS.values()}
    last = max((r for r in rows if r.key in keys), key=lambda r: r.rev, default=None)
    return {
        "values": {f.wire: {"saved": saved[f.wire], "default": default[f.wire],
                            "effective": effect[f.wire]} for f in FIELDS},
        "fields": [{"wire": f.wire, "kind": f.kind, "section": f.section, "label": f.label,
                    "help": f.help, "unit": f.unit or None,
                    "min": (f.lo if f.kind == "ratio" else int(f.lo)) if f.kind in ("int", "ratio")
                    else None,
                    "max": (f.hi if f.kind == "ratio" else int(f.hi)) if f.kind in ("int", "ratio")
                    else None,
                    "choices": list(f.choices) or None, "applies": f.applies} for f in FIELDS],
        "updatedBy": last.updated_by if last is not None else None,
        "updatedAt": (last.updated_at.isoformat()
                      if last is not None and last.updated_at is not None else None),
    }
