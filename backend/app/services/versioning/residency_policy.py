"""The versioned graphs' residency policy (doc 17): what the capacity loop evicts and loads by.

Every value is changed live by a system administrator (``/admin/versioning/residency-policy``) and
stored on the single ``platform_settings`` row; NULL there means unset, and the environment's
default applies (``config``). :func:`resolve` is the one reader: the saved value, else the default,
clamped to the value's range, with the pairs kept in order (Coldline never outlives Standard; the
stop mark stays five points under the start mark), memoized for up to 30 seconds per process, and
never raising: a row that cannot be read resolves to the defaults. The routes refuse what
:func:`resolve` would clamp, naming the field (:func:`validate`).

Whether any of it applies is a deploy setting, not a policy value: ``GRAPHVER_RESIDENCY_ENABLED``
(:func:`enabled`).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Tuple

from backend.app.db.repositories.profiling_repo import INHERIT

from . import config

logger = logging.getLogger(__name__)

CLASSES = ("always", "standard", "coldline")


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

_MEMO_TTL_S = 30.0
_MEMO: Dict[str, Any] = {"policy": None, "at": 0.0}
_clock = time.monotonic


class PolicyInvalid(ValueError):
    """A value the routes refuse: out of its range, of the wrong kind, or contradicting another."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field


def enabled() -> bool:
    """Whether residency applies on this deployment (``GRAPHVER_RESIDENCY_ENABLED``)."""
    return config.RESIDENCY_ENABLED


def _env() -> Dict[str, Any]:
    return {
        "evictionEnabled": config.EVICTION_ENABLED,
        "defaultResidency": "standard",
        "standardIdleSecs": config.STANDARD_IDLE_SECS,
        "coldlineIdleSecs": config.COLDLINE_IDLE_SECS,
        "highWaterPct": config.MASTER_HIGH_WATER_PCT,
        "lowWaterPct": config.MASTER_LOW_WATER_PCT,
        "loadMarginPct": config.LOAD_MARGIN_PCT,
        "bytesPerEntity": config.BYTES_PER_ENTITY,
        "coldlineCanvasLoadAbove": config.COLDLINE_CANVAS_LOAD_ABOVE,
        "capacityIntervalSecs": config.CAPACITY_SECS,
    }


def _in_range(wire: str, value: Any, fallback: Any) -> Any:
    """``value`` as its field holds it, each on its own: a whole number clamped to its range, a
    class or a switch as given; ``fallback`` for anything that cannot be read as one."""
    if wire == "evictionEnabled":
        return value if isinstance(value, bool) else fallback
    if wire == "defaultResidency":
        return value if value in CLASSES else fallback
    try:
        lo, hi = RANGES[wire]
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return fallback


def _single(saved: Mapping[str, Any]) -> Dict[str, Any]:
    """Each value saved, else its default, in its own range — the pairs not yet put in order."""
    out = {}
    for wire, env in _env().items():
        default = _in_range(wire, env, env)
        value = saved.get(wire)
        out[wire] = default if value is None else _in_range(wire, value, default)
    return out


def effective(saved: Mapping[str, Any]) -> ResidencyPolicy:
    """The policy in force given the values ``saved`` (by wire name; None = unset)."""
    values = _single(saved)
    values["coldlineIdleSecs"] = min(values["coldlineIdleSecs"], values["standardIdleSecs"])
    values["lowWaterPct"] = min(values["lowWaterPct"], values["highWaterPct"] - 5)
    return ResidencyPolicy(**{WIRE_NAMES[w]: v for w, v in values.items()})


def defaults() -> ResidencyPolicy:
    """The policy with nothing saved."""
    return effective({})


def saved_values(row) -> Dict[str, Any]:
    """What ``row`` (``platform_settings``, or None) holds for each value, by wire name."""
    return {wire: getattr(row, f"gv_{attr}", None) if row is not None else None
            for wire, attr in WIRE_NAMES.items()}


def invalidate() -> None:
    """Drop the memo, so this process reads a just-saved policy at once. Other processes see it
    within the memo's 30 seconds."""
    _MEMO.update(policy=None, at=0.0)


async def resolve(session=None) -> ResidencyPolicy:
    """The policy in force: memoized for up to 30 seconds, and never raising (the defaults when
    the row cannot be read). Without ``session``, a READONLY-pool session of the management
    database is opened when the memo is stale."""
    now = _clock()
    if _MEMO["policy"] is not None and now - _MEMO["at"] < _MEMO_TTL_S:
        return _MEMO["policy"]
    from backend.app.db.models import PlatformSettingsORM

    try:
        if session is not None:
            row = await session.get(PlatformSettingsORM, 1)
        else:
            from backend.app.db.engine import get_readonly_session

            async with get_readonly_session() as own:
                row = await own.get(PlatformSettingsORM, 1)
    except Exception as exc:  # noqa: BLE001 — a policy read must never fail its caller
        logger.warning("residency policy unreadable, using the defaults: %s", exc)
        return defaults()
    policy = effective(saved_values(row))
    _MEMO.update(policy=policy, at=now)
    return policy


async def default_class() -> str:
    """The class a new graph gets."""
    return (await resolve()).default_residency


def _is_inherit(value: Any) -> bool:
    return type(value) is int and value == INHERIT


def merged(saved: Mapping[str, Any], values: Mapping[str, Any]) -> Dict[str, Any]:
    """What would be saved once ``values`` (``-1`` clears one, None leaves it) are applied."""
    out = dict(saved)
    out.update({w: None if _is_inherit(v) else v for w, v in values.items() if v is not None})
    return out


def validate(values: Mapping[str, Any], saved: Mapping[str, Any]) -> None:
    """Refuse a change (``values`` by wire name; ``-1`` clears one, None leaves it) that names an
    unknown value, gives one of the wrong kind or out of its range, or would contradict another
    once in force with what is ``saved``: :class:`PolicyInvalid` naming the field."""
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
    after = _single(merged(saved, values))
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


def apply(row, values: Mapping[str, Any]) -> None:
    """Write ``values`` (already validated) onto ``row``: ``-1`` clears a value to its default,
    None leaves it as it is."""
    for wire, value in values.items():
        if value is not None:
            setattr(row, f"gv_{WIRE_NAMES[wire]}", None if _is_inherit(value) else value)


def describe(row) -> Dict[str, Any]:
    """Each value as saved, its default and its effective value, with each whole number's range,
    who changed the policy last and when, and whether residency is on here."""
    saved = saved_values(row)
    default, effect = defaults(), effective(saved)
    return {
        "enabled": enabled(),
        "values": {wire: {"saved": saved[wire], "default": getattr(default, attr),
                          "effective": getattr(effect, attr)}
                   for wire, attr in WIRE_NAMES.items()},
        "ranges": {wire: {"min": lo, "max": hi} for wire, (lo, hi) in RANGES.items()},
        "updatedBy": getattr(row, "gv_policy_updated_by", None),
        "updatedAt": getattr(row, "gv_policy_updated_at", None),
    }
