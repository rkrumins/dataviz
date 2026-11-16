"""The versioned graphs' residency policy (doc 17): what the capacity loop evicts and loads by.

Every value is a versioned-graph setting (``residency.*``, ``config/versioned_graph_settings.py``),
kept in the settings store at the platform's scope (``services.settings``) and changed live by a
system administrator (``/admin/versioning/residency-policy``). This module keeps the shape it had
before the store, for the code that acts on it: :class:`ResidencyPolicy`, and each value's wire name
(:data:`WIRE_NAMES`, its setting's ``Legacy.residency_policy``). :func:`resolve` brings this
process's settings up to date (``settings.effective.refresh``), so a save reaches every process
within about two seconds (the settings' generation), and gives the values in force, each in its
range with the pairs kept in order (Coldline never outlives Standard; the stop mark stays five
points under the start mark). It never raises: while the settings can't be read, the values last
read (before any, the defaults) keep serving, with eviction off until they can. The routes refuse
what the resolver would clamp, naming the field (:func:`validate`), save through the store
(:func:`apply`) and, for one release, write the old ``platform_settings`` columns too
(:func:`saved_values`).

The residency class (``residency.class``, ``defaultResidency`` on the wire) is the exception. It
was the class a new graph got; it is now the class every graph inherits, platform → workspace →
graph, set in Admin → Versioned graphs. The policy route reads it but refuses a change to it
(:data:`CLASS_MOVED`). The evictor decides in SQL, so each graph's class in force is kept on its
row (``projection_state.residency``): :func:`classes` works it out from the settings, and
``residency.keep_classes`` writes it after a save and before each capacity pass.

Whether any of it applies is not a policy value but a switch a system administrator turns on and
off at runtime: Graph residency (Admin → Features, ``residencyEnabled``; :func:`switch_state`). The
versioning worker reads it from the feature store at the start of every capacity pass and decides
there; the API reads it through the flag cache (:func:`enabled`). Reads never depend on it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any, Collection, Dict, Mapping, Optional, Sequence, Tuple

from backend.app.db.repositories.profiling_repo import INHERIT
from backend.app.services.settings import effective as in_force
from backend.app.services.settings import legacy, registry, resolver, store
from backend.app.services.settings.resolver import Row, Target
from backend.app.services.settings.snapshot import env_reader

logger = logging.getLogger(__name__)

CLASSES = ("always", "standard", "coldline")
#: The setting a graph's class is.
CLASS = "residency.class"
#: Why the policy route refuses a change to the class (``defaultResidency``).
CLASS_MOVED = ("The platform's residency class is now the class every graph inherits, not only "
               "the class of a new graph. Change it in Admin → Versioned graphs "
               "(residency.class).")


@dataclass(frozen=True)
class ResidencyPolicy:
    eviction_enabled: bool
    default_residency: str
    standard_idle_secs: int
    coldline_idle_secs: int
    high_water_pct: int
    low_water_pct: int
    load_margin_pct: int
    bytes_per_entity: int
    coldline_canvas_load_above: int
    capacity_interval_secs: int


#: Each value's name on the wire, and its attribute; its column is ``gv_`` + the attribute.
WIRE_NAMES: Dict[str, str] = {
    "evictionEnabled": "eviction_enabled",
    "defaultResidency": "default_residency",
    "standardIdleSecs": "standard_idle_secs",
    "coldlineIdleSecs": "coldline_idle_secs",
    "highWaterPct": "high_water_pct",
    "lowWaterPct": "low_water_pct",
    "loadMarginPct": "load_margin_pct",
    "bytesPerEntity": "bytes_per_entity",
    "coldlineCanvasLoadAbove": "coldline_canvas_load_above",
    "capacityIntervalSecs": "capacity_interval_secs",
}

#: The range of each whole-number value.
RANGES: Dict[str, Tuple[int, int]] = {
    "standardIdleSecs": (3600, 365 * 86400),
    "coldlineIdleSecs": (300, 7 * 86400),
    "highWaterPct": (50, 95),
    "lowWaterPct": (30, 90),
    "loadMarginPct": (100, 300),
    "bytesPerEntity": (100, 10_000),
    "coldlineCanvasLoadAbove": (0, 100_000_000),
    "capacityIntervalSecs": (15, 600),
}

#: Each value's setting in the registry, by wire name.
_SETTINGS = {s.legacy.residency_policy: s for s in registry().SETTINGS
             if s.legacy is not None and s.legacy.residency_policy}
#: The policy built from this process's settings as last refreshed, and the context it came from:
#: built again only when a refresh brought new rows or switches.
_BUILT: Dict[str, Any] = {"ctx": None, "policy": None}


#: The Graph residency switch (Admin → Features).
SWITCH = "residencyEnabled"
#: How long after the capacity leader first sees the switch on before anything is evicted. An API
#: process reads the switch through its flag cache, which may be up to 30 seconds old, and until it
#: sees it on it takes no read leases and notes no reads: an eviction in that window could drop a
#: key a read is using, or a graph people read every day. 90 seconds is that window three times
#: over, and it is anchored on the platform settings row, so it is the same for every worker.
GRACE_SECS = 90


class PolicyInvalid(ValueError):
    """A value the routes refuse: out of its range, of the wrong kind, or contradicting another."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field


async def switch_state(session=None) -> Optional[bool]:
    """The Graph residency switch: True or False, or None when it cannot be read — never a default
    in place of a read that failed. Through ``session`` (the management database), read now from the
    feature store, as an admin's save left it, whatever this process's flag cache holds; without,
    through the flag cache (30 seconds), as every gate reads a flag. A switch the registry has not
    seeded yet reads as off, its shipped default."""
    from backend.app.services.feature_flags import FeatureFlagService, feature_flags

    try:
        if session is None:
            return await feature_flags.is_enabled_self_session(SWITCH, default=False)
        return await FeatureFlagService(ttl=0).is_enabled(SWITCH, session, default=False)
    except Exception:  # noqa: BLE001 — unread is not off
        logger.warning("residency: the Graph residency switch could not be read", exc_info=True)
        return None


async def enabled() -> bool:
    """Whether residency is on, as this process's flag cache has it: what the API reads for read
    leases and read notes, a new graph's class and the policy routes. Unreadable counts as off."""
    return await switch_state() is True


def _context(saved: Mapping[str, Any]) -> resolver.Context:
    """The settings as the platform would hold ``saved`` (by wire name; None: not set), with the
    deployment's environment, for the resolver."""
    reg = registry()
    rows = [Row(s.key, "platform", "", saved[wire])
            for wire, s in _SETTINGS.items() if saved.get(wire) is not None]
    return resolver.context(reg.SETTINGS, rows, env=env_reader(reg.SETTINGS, reg.DEPLOYMENT),
                            why=reg.WHY)


def _of(ctx: resolver.Context) -> ResidencyPolicy:
    """The policy in force at the platform in ``ctx``."""
    return ResidencyPolicy(**{WIRE_NAMES[wire]: resolver.effective(ctx, s.key)
                              for wire, s in _SETTINGS.items()})


def _policy(ctx: resolver.Context) -> ResidencyPolicy:
    """The policy of this process's settings ``ctx``, built once per context."""
    if _BUILT["ctx"] is not ctx:
        _BUILT.update(ctx=ctx, policy=_of(ctx))
    return _BUILT["policy"]


def effective(saved: Mapping[str, Any]) -> ResidencyPolicy:
    """The policy in force given the values ``saved`` (by wire name; None = unset), as the resolver
    holds them: each in its range, Coldline's idle time no longer than Standard's, the stop mark at
    least five points under the start mark."""
    return _of(_context(saved))


def defaults() -> ResidencyPolicy:
    """The policy with nothing saved: the environment's where it is valid, else the code's."""
    return effective({})


def saved_values(row) -> Dict[str, Any]:
    """What ``row`` (``platform_settings``, or None) holds for each value, by wire name: the old
    storage, which a save still writes through to for one release."""
    return {wire: getattr(row, f"gv_{attr}", None) if row is not None else None
            for wire, attr in WIRE_NAMES.items()}


def stored_values(rows: Sequence[Row]) -> Dict[str, Any]:
    """What the settings store holds for each value at the platform (``rows``: its platform rows,
    ``store.read_scope``), by wire name; None: not set."""
    held = {r.key: r.value for r in rows}
    return {wire: held.get(_SETTINGS[wire].key) for wire in WIRE_NAMES}


async def invalidate() -> None:
    """Read the settings again now, in this process. A save through the store has moved the
    settings' generation already, so every other process reads it within two seconds."""
    await in_force.refresh(strict=True)


async def resolve(session=None) -> ResidencyPolicy:
    """The policy in force, after bringing this process's settings up to date (Redis at most every
    two seconds; the database only when a save moved the settings' generation), and never raising.
    While they can't be read (before the first read, or since one failed), the values last read,
    or before any the defaults, with eviction off — loads go on: the defaults would turn eviction
    back on where an administrator turned it off. ``session`` is not read: the settings are read
    on a pool of their own."""
    policy = _policy(await in_force.refresh())
    if not in_force.readable():
        return replace(policy, eviction_enabled=False)
    return policy


async def default_class(workspace_id: Optional[str] = None,
                        data_source_id: Optional[str] = None) -> str:
    """The class a new graph gets: the one in force for it (``residency.class``: one its data
    source's graph had, else its workspace's, else the platform's), as this process's settings
    last read them. It inherits from there on."""
    return await in_force.value_of(CLASS, workspace_id=workspace_id, graph_id=data_source_id)


@dataclass(frozen=True)
class Classes:
    """Each graph's class as the settings give it: its own, by its data source (``own``), else its
    workspace's (``workspaces``), else ``inherited``. ``inherited`` is None while the graphs' own
    values wait for their import (:func:`graph_values_pending`): until then a graph keeps the
    class on its row unless one was set on it since, and nothing is re-classed."""
    inherited: Optional[str]
    workspaces: Mapping[str, str]
    own: Mapping[str, str]

    def of(self, workspace_id: Optional[str], data_source_id: Optional[str], stored: str) -> str:
        """A graph's class, given the class ``stored`` on its row."""
        own = self.own.get(data_source_id)
        if own is not None:
            return own
        if self.inherited is None:
            return stored
        return self.workspaces.get(workspace_id, self.inherited)


def classes(ctx: resolver.Context, *, pending: bool = False) -> Classes:
    """The classes the settings in ``ctx`` give, as the resolver resolves them. ``pending``: the
    graphs' own values are not in the store yet (:func:`graph_values_pending`)."""
    own: Dict[str, str] = {}
    workspaces: Dict[str, str] = {}
    for (key, scope, scope_id), row in ctx.rows.items():
        if key != CLASS or row.value is None or not scope_id:
            continue
        if scope == "graph":
            # Its own, unless the resolver passes over it (a value it can't take, a lock).
            if resolver.effective(ctx, CLASS, Target("graph", graph_id=scope_id)) == row.value:
                own[scope_id] = row.value
        elif scope == "workspace" and not pending:
            workspaces[scope_id] = resolver.effective(ctx, CLASS, Target("graph", scope_id))
    inherited = None if pending else resolver.effective(ctx, CLASS, Target("graph"))
    return Classes(inherited, workspaces, own)


def graph_values_pending(done: Collection[str]) -> bool:
    """Whether the graphs' own values are still to be copied into the settings store, given the
    one-time imports ``done``: the import migration ran (``legacy``) but could not reach a
    separate graph store (no ``legacy_graph`` yet), so the versioning worker copies them at
    start-up (``legacy.import_graph_values``)."""
    return legacy.MARKER in done and legacy.GRAPH_MARKER not in done


async def stored_classes() -> Classes:
    """The classes as the settings store holds them now. Read from the store, not this process's
    snapshot, which can be seconds behind: what writes the classes must never put back one that
    a save has just changed."""
    from backend.app.db.engine import get_readonly_session

    reg = registry()
    async with get_readonly_session() as session:
        rows = await store.read_key(session, reg.DOMAIN, CLASS)
        done = await store.imports_done(session)
    ctx = resolver.context(reg.SETTINGS, rows, env=env_reader(reg.SETTINGS, reg.DEPLOYMENT),
                           why=reg.WHY)
    return classes(ctx, pending=graph_values_pending(done))


def _is_inherit(value: Any) -> bool:
    return type(value) is int and value == INHERIT


def merged(saved: Mapping[str, Any], values: Mapping[str, Any]) -> Dict[str, Any]:
    """What would be saved once ``values`` (``-1`` clears one, None leaves it) are applied."""
    out = dict(saved)
    out.update({w: None if _is_inherit(v) else v for w, v in values.items() if v is not None})
    return out


def validate(values: Mapping[str, Any], saved: Mapping[str, Any]) -> None:
    """Refuse a change (``values`` by wire name; ``-1`` clears one, None leaves it) that names an
    unknown value, gives one of the wrong kind or out of its range, would change the residency
    class (:data:`CLASS_MOVED`; the class in force sent back unchanged, as a client that echoes
    the whole policy sends it, passes), or would contradict another once in force with what is
    ``saved``: :class:`PolicyInvalid` naming the field."""
    for wire, value in values.items():
        if wire not in WIRE_NAMES:
            raise PolicyInvalid(wire, f"{wire} is not a residency setting")
        if value is None or _is_inherit(value):
            continue
        if wire == "evictionEnabled":
            if not isinstance(value, bool):
                raise PolicyInvalid(wire, "must be true or false, or -1 for the default")
        elif wire == "defaultResidency":
            if value not in CLASSES:
                raise PolicyInvalid(wire, "must be always, standard or coldline, or -1 for the "
                                          "default")
        else:
            lo, hi = RANGES[wire]
            if type(value) is not int or not lo <= value <= hi:
                raise PolicyInvalid(wire, f"must be a whole number from {lo:,} to {hi:,}, or -1 "
                                          "for the default")
    if "defaultResidency" in values and (effective(merged(saved, values)).default_residency
                                         != effective(saved).default_residency):
        raise PolicyInvalid("defaultResidency", CLASS_MOVED)
    # Each value as it would be chosen once saved (else its default), before it is held to another.
    ctx = _context(merged(saved, values))
    after = {wire: resolver.resolve(ctx, _SETTINGS[wire].key)["declared"]
             for wire in ("standardIdleSecs", "coldlineIdleSecs", "highWaterPct", "lowWaterPct")}
    standard, coldline = after["standardIdleSecs"], after["coldlineIdleSecs"]
    if coldline > standard and {"standardIdleSecs", "coldlineIdleSecs"} & set(values):
        raise PolicyInvalid(
            "coldlineIdleSecs" if "coldlineIdleSecs" in values else "standardIdleSecs",
            f"the Coldline idle time ({coldline:,} s) may not be longer than the Standard idle "
            f"time ({standard:,} s)")
    high, low = after["highWaterPct"], after["lowWaterPct"]
    if low > high - 5 and {"highWaterPct", "lowWaterPct"} & set(values):
        raise PolicyInvalid(
            "lowWaterPct" if "lowWaterPct" in values else "highWaterPct",
            f"the stop mark ({low}%) must be at least 5 points under the start mark ({high}%)")


async def apply(session, rows: Sequence[Row], values: Mapping[str, Any], actor: Optional[str], *,
                reason: Optional[str] = None,
                before_commit: Optional[store.Hook] = None) -> store.ChangeSet:
    """Save ``values`` (by wire name; None clears one; already validated) through the settings
    store, each checked against its version in ``rows`` (the platform's, as read for the change), as
    the old route's (``legacy_api``), and commit. In the same transaction the old columns are
    written through, then ``before_commit`` runs (the route's activity record)."""
    versions = {r.key: r.version for r in rows}
    changes = [store.Change(s.key, "platform", "", versions.get(s.key, 0), value=values[wire])
               for wire, s in _SETTINGS.items() if wire in values]

    async def through(s, change_set: store.ChangeSet) -> None:
        await legacy.write_through(s, change_set)
        if before_commit is not None:
            await before_commit(s, change_set)

    return await store.apply(session, registry().DOMAIN, changes, actor=actor, reason=reason,
                             source="legacy_api", before_commit=through)


def describe(rows: Sequence[Row]) -> Dict[str, Any]:
    """Each value as saved (``rows``: the settings store's at the platform, ``store.read_scope``),
    its default and its effective value, with each whole number's range, and who changed the policy
    last and when (another platform setting saved since doesn't count)."""
    saved = stored_values(rows)
    default, effect = defaults(), effective(saved)
    keys = {s.key for s in _SETTINGS.values()}
    last = max((r for r in rows if r.key in keys), key=lambda r: r.rev, default=None)
    return {
        "values": {wire: {"saved": saved[wire], "default": getattr(default, attr),
                          "effective": getattr(effect, attr)}
                   for wire, attr in WIRE_NAMES.items()},
        "ranges": {wire: {"min": lo, "max": hi} for wire, (lo, hi) in RANGES.items()},
        "updatedBy": last.updated_by if last is not None else None,
        "updatedAt": (last.updated_at.isoformat()
                      if last is not None and last.updated_at is not None else None),
    }
