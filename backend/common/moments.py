"""One way to store a date, and a moment in time.

A date is stored as ``YYYY-MM-DD``. A moment is stored in UTC, as ``YYYY-MM-DDTHH:MM:SSZ``, with
``.sss`` when it has milliseconds. Every write of a property goes through ``property_patch``,
which stores a moment this way however it was written: with a space for the ``T``, without
seconds, with an offset, or with no zone at all. A moment with no zone is read as UTC, as the app
shows it: an export shows its moments in UTC, so a time typed beside them means UTC.

Two values that name the same date or moment are the same value (``same_moment``), so a moment
sent back in another form changes nothing. A value stored before this rule keeps its form until
it is changed.

The import also reads the dates a spreadsheet writes back (``locale_readings``). Opening a CSV in
Excel and saving it turns ``2026-11-18`` into ``18/11/2026`` or ``11/18/2026``, depending on the
machine. Such a date is read both ways round, and is only taken when one reading fits.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, List, Mapping, Optional, Tuple, Union

__all__ = ["parse", "canonical", "canonical_props", "same_moment", "as_like", "from_cell",
           "locale_readings", "is_temporal"]

_ISO = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})"
    r"(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$",
    re.IGNORECASE)

#: A spreadsheet's own writing of a date: ``18/11/2026``, ``11-18-2026``, ``18.11.2026``, with a time
#: (``5:42``, ``05:42:07``, ``5:42 PM``) or not. Day-first or month-first can't be told by shape.
_LOCALE = re.compile(
    r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})"
    r"(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$",
    re.IGNORECASE)

Parsed = Tuple[str, Union[date, datetime]]


def parse(value: Any) -> Optional[Parsed]:
    """``("date", date)`` or ``("moment", aware UTC datetime)`` for an ISO 8601 date or moment;
    None for anything else (a moment with no zone is UTC)."""
    if not isinstance(value, str):
        return None
    m = _ISO.match(value.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, frac, zone = m.groups()
    try:
        if h is None:
            return "date", date(int(y), int(mo), int(d))
        micro = int((frac or "0").ljust(6, "0")[:6])
        at = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0), micro)
    except ValueError:                                  # 2026-02-30, 25:00
        return None
    if zone and zone.upper() != "Z":
        sign = -1 if zone[0] == "-" else 1
        digits = zone[1:].replace(":", "")
        offset = timedelta(hours=int(digits[:2]), minutes=int(digits[2:4] or 0))
        at = at.replace(tzinfo=timezone(sign * offset))
    else:
        at = at.replace(tzinfo=timezone.utc)
    return "moment", at.astimezone(timezone.utc)


def _text(p: Parsed) -> str:
    kind, at = p
    if kind == "date":
        return at.isoformat()
    ms = at.microsecond // 1000
    return at.strftime("%Y-%m-%dT%H:%M:%S") + (f".{ms:03d}" if ms else "") + "Z"


def canonical(value: Any) -> Any:
    """A date or moment in its stored form; any other value as it is."""
    p = parse(value)
    return _text(p) if p else value


def canonical_props(props: Optional[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """``props`` with each date or moment in its stored form — the same mapping when none changes."""
    if not props:
        return props
    out = None
    for k, v in props.items():
        c = canonical(v) if isinstance(v, str) else v
        if c is not v and c != v:
            if out is None:
                out = dict(props)
            out[k] = c
    return out if out is not None else props


def _instant(p: Parsed) -> datetime:
    kind, at = p
    return datetime(at.year, at.month, at.day, tzinfo=timezone.utc) if kind == "date" else at


def same_moment(a: Any, b: Any) -> bool:
    """Both name the same date or moment, however written. A date and a moment are the same only
    when the moment is that day's start in UTC, which is how a spreadsheet's date cell comes back."""
    pa, pb = parse(a), parse(b)
    if pa is None or pb is None:
        return False
    if pa[0] == pb[0]:
        return pa[1] == pb[1]
    return _instant(pa) == _instant(pb)


def as_like(value: Any, like: Any) -> Any:
    """``value`` (a date or moment) in its stored form, and of the kind ``like`` is: a date for a
    date, so a spreadsheet's date cell does not turn one into a moment at midnight, and a moment
    for a moment. A value that is no date or moment is returned as it is."""
    p, pl = parse(value), parse(like)
    if p is None:
        return value
    if pl is not None and pl[0] == "date" and p[0] == "moment" and p[1].time() == time(0):
        return p[1].date().isoformat()
    if pl is not None and pl[0] == "moment" and p[0] == "date":
        return _text(("moment", _instant(p)))
    return _text(p)


def from_cell(value: Any) -> Any:
    """A spreadsheet cell's date or time value (openpyxl's ``datetime``, ``date``, ``time``,
    ``timedelta``) as text, so it can be stored and compared: a date at midnight as a date, any
    other moment in its stored form (Excel keeps no zone: UTC), a time of day as ``HH:MM:SS``. Any
    other value as it is."""
    if isinstance(value, datetime):
        at = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        at = at.astimezone(timezone.utc)
        if at.time() == time(0) and at.microsecond == 0:
            return at.date().isoformat()
        return _text(("moment", at))
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.replace(microsecond=0, tzinfo=None).isoformat()
    if isinstance(value, timedelta):
        return str(value)
    return value


def locale_readings(value: Any) -> List[str]:
    """What a spreadsheet's writing of a date can mean, each in its stored form: day first and
    month first (one reading when only one is a real date, or both say the same). Empty for
    anything else."""
    if not isinstance(value, str):
        return []
    m = _LOCALE.match(value.strip())
    if not m:
        return []
    a, b, y, h, mi, s, half = m.groups()
    hour = int(h) if h is not None else None
    if hour is not None and half:
        if hour > 12:
            return []
        hour = hour % 12 + (12 if half.upper() == "PM" else 0)
    out: List[str] = []
    for day, month in ((int(a), int(b)), (int(b), int(a))):
        try:
            if hour is None:
                text = date(int(y), month, day).isoformat()
            else:
                text = _text(("moment", datetime(int(y), month, day, hour, int(mi), int(s or 0),
                                                 tzinfo=timezone.utc)))
        except ValueError:
            continue
        if text not in out:
            out.append(text)
    return out


def is_temporal(value: Any) -> bool:
    """An ISO 8601 date or moment."""
    return parse(value) is not None
