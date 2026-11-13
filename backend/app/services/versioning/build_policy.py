"""New-version builds (doc 14 §6): when and how a versioned graph's next version is built in a second
key while the key that serves it keeps serving, then switched to — and the pacing and Postgres limits
that keep reads served while a graph is written.

Every value is changed live by a system administrator (``/admin/versioning/build-policy``, Admin →
Infrastructure → New-version builds) and kept as JSON on the single ``platform_settings`` row
(``gv_build_policy``); a value not saved there takes the environment's default (``config``).
:func:`resolve` is the one reader: the saved value, else the default, in its range, memoized for up
to 30 seconds per process — re-read sooner when a save bumps the policy's generation in Redis
(:func:`invalidate`) — and never raising: a row that can't be read gives the last policy read, else
the defaults. The routes refuse what :func:`resolve` would clamp, naming the field (:func:`validate`).
Each setting is described once, in :data:`FIELDS`, which the admin card renders from.

Whether builds happen at all is a switch, not a value: ``candidateKeysEnabled`` (Admin → Features,
:func:`switch_state`).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from backend.app.db.repositories.profiling_repo import INHERIT

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
          "Rebuilds, moves and loads of platform-owned keys are built beside too, so reads keep the "
          "current version meanwhile."),
    Field("buildMode", lambda: config.PROJECTION_CANDIDATE_MODE, "choice", "room",
          "How a build makes its key",
          "Auto copies the serving key when its node has room, else seeds the new key from "
          "Postgres on the node with most room. Copy only waits for room on the node; reseed only "
          "always seeds from Postgres.",
          choices=MODES),
    Field("copyMarginPct", lambda: config.PROJECTION_COPY_MARGIN_PCT, "int", "room",
          "Room a copy needs",
          "The free memory a copy needs on its node, as a share of the graph's size.",
          unit="pct", lo=100, hi=400),
    Field("copyMaxBytes", lambda: config.PROJECTION_COPY_MAX_BYTES, "int", "room",
          "Largest graph copied",
          "A graph larger than this is seeded from Postgres rather than copied. 0: no limit.",
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
    Field("warmSecs", lambda: config.PROJECTION_CANDIDATE_WARM_SECS, "int", "lifecycle",
          "Warm-up before switching",
          "How long a build's key is read to warm it before readers are switched to it.",
          unit="secs", lo=0, hi=600),
    Field("retireGraceSecs", lambda: config.RETIRE_GRACE_SECS, "int", "lifecycle",
          "Keep the previous key for",
          "How long a graph's previous key stays after a switch or a move, so reads already under "
          "way finish on it.",
          unit="secs", lo=60, hi=86_400, applies="switch"),
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


_MEMO_TTL_S = 30.0
#: How often a fresh memo still asks Redis whether a save moved the policy's generation.
_GEN_CHECK_S = 2.0
_GEN_KEY = "gv:build_policy:gen"
#: ``policy``: the memo, until ``at`` is 30 seconds old or the generation moves; ``good``: the last
#: policy read, kept through a failed read.
_MEMO: Dict[str, Any] = {"policy": None, "at": 0.0, "gen": None, "gen_at": 0.0, "good": None}
_clock = time.monotonic


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


def _in_range(f: Field, value: Any, fallback: Any) -> Any:
    """``value`` as ``f`` holds it: a number clamped to its range, a choice or a switch as given;
    ``fallback`` for anything that can't be read as one."""
    if f.kind == "bool":
        return value if isinstance(value, bool) else fallback
    if f.kind == "choice":
        return value if value in f.choices else fallback
    if isinstance(value, bool):
        return fallback
    try:
        number = float(value) if f.kind == "ratio" else int(value)
    except (TypeError, ValueError):
        return fallback
    clamped = max(f.lo, min(f.hi, number))
    return float(clamped) if f.kind == "ratio" else int(clamped)


def _single(saved: Mapping[str, Any]) -> Dict[str, Any]:
    """Each value saved, else its default, in its own range — the pairs not yet put in order."""
    out = {}
    for f in FIELDS:
        env = f.default()
        default = _in_range(f, env, env)
        value = saved.get(f.wire)
        out[f.wire] = default if value is None else _in_range(f, value, default)
    return out


def effective(saved: Mapping[str, Any]) -> BuildPolicy:
    """The settings in force given the values ``saved`` (by wire name; None = unset): no more
    builds per worker than its projection concurrency, and no more Postgres reads per graph than per
    process."""
    values = _single(saved)
    values["buildConcurrency"] = min(values["buildConcurrency"], max(1, config.PROJECTION_CONCURRENCY))
    values["pgReadsPerGraph"] = min(values["pgReadsPerGraph"], values["pgReadsPerProcess"])
    return BuildPolicy(values)


def defaults() -> BuildPolicy:
    """The settings with nothing saved."""
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
    """What ``row`` (``platform_settings``, or None) holds for each value, by wire name."""
    values = _stored(row).get("values") or {}
    return {f.wire: values.get(f.wire) for f in FIELDS}


async def _generation() -> Optional[str]:
    """The policy's generation in Redis, which a save moves; None when Redis can't say."""
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        gen = await asyncio.wait_for(get_redis().get(_GEN_KEY), timeout=0.2)
    except Exception:  # noqa: BLE001 — without Redis, the 30-second memo still bounds staleness
        return None
    return gen.decode() if isinstance(gen, bytes) else (str(gen) if gen is not None else None)


async def invalidate() -> None:
    """Drop this process's memo, and move the policy's generation in Redis so every other process
    reads a just-saved policy on its next look (within two seconds), not 30 seconds later."""
    _MEMO.update(policy=None, at=0.0)
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        await asyncio.wait_for(get_redis().incr(_GEN_KEY), timeout=0.5)
    except Exception:  # noqa: BLE001 — the others then see it within the memo's 30 seconds
        logger.info("builds: the New-version build settings' generation could not be moved")


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
    """The settings :func:`resolve` last read, else the defaults: for a path that runs per statement
    and can't wait on a read. Its caller resolves now and then (the projector, per pass section),
    so a change reaches it within about as long as :func:`resolve` takes to see one."""
    return _MEMO["policy"] or defaults()


async def resolve(session=None) -> BuildPolicy:
    """The settings in force: memoized for up to 30 seconds, sooner when a save moves the
    generation, and never raising. When the row can't be read, the last policy read, or with none
    yet the defaults, kept as the memo for its 30 seconds. Without ``session``, a READONLY-pool
    session of the management database is opened when the memo is stale."""
    now = _clock()
    policy = _MEMO["policy"]
    if policy is not None and now - _MEMO["at"] < _MEMO_TTL_S:
        if now - _MEMO["gen_at"] < _GEN_CHECK_S:
            return policy
        gen = await _generation()
        _MEMO["gen_at"] = now
        if gen is None or gen == _MEMO["gen"]:
            return policy
    gen = await _generation()
    from backend.app.db.models import PlatformSettingsORM

    try:
        if session is not None:
            row = await session.get(PlatformSettingsORM, 1)
        else:
            from backend.app.db.engine import get_readonly_session

            async with get_readonly_session() as own:
                row = await own.get(PlatformSettingsORM, 1)
    except Exception as exc:  # noqa: BLE001 — a settings read must never fail its caller
        fallback = _MEMO["good"] or defaults()
        logger.warning("New-version build settings unreadable, using %s: %s",
                       "the last ones read" if _MEMO["good"] else "the defaults", exc)
        _MEMO.update(policy=fallback, at=now, gen=gen, gen_at=now)
        return fallback
    policy = effective(saved_values(row))
    _MEMO.update(policy=policy, at=now, gen=gen, gen_at=now, good=policy)
    return policy


def _is_inherit(value: Any) -> bool:
    return type(value) is int and value == INHERIT


def merged(saved: Mapping[str, Any], values: Mapping[str, Any]) -> Dict[str, Any]:
    """What would be saved once ``values`` (``-1`` clears one, None leaves it) are applied."""
    out = dict(saved)
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
    after = _single(merged(saved, values))
    per_graph, per_process = after["pgReadsPerGraph"], after["pgReadsPerProcess"]
    if per_graph > per_process and {"pgReadsPerGraph", "pgReadsPerProcess"} & set(values):
        raise PolicyInvalid(
            "pgReadsPerGraph" if "pgReadsPerGraph" in values else "pgReadsPerProcess",
            f"reads at once per graph ({per_graph}) may not be more than per process "
            f"({per_process})")


def save(row, values: Mapping[str, Any], actor: Optional[str]) -> None:
    """Write the settings ``values`` (by wire name, None = unset; already validated and merged)
    onto ``row``, with who saved them and when."""
    row.gv_build_policy = json.dumps({
        "values": {w: v for w, v in values.items() if v is not None},
        "updatedBy": actor,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }, sort_keys=True)


def describe(row) -> Dict[str, Any]:
    """Each value as saved, its default and its effective value; each setting's kind, range, unit,
    section, label and help, for the admin card; and who changed the settings last and when."""
    saved, default, effect = saved_values(row), defaults(), effective(saved_values(row))
    stored = _stored(row)
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
        "updatedBy": stored.get("updatedBy"),
        "updatedAt": stored.get("updatedAt"),
    }
