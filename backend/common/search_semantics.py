"""
What a property comparison MEANS — one operator table, one value coercion
and one reference evaluator, shared by everything that answers one.

Advanced search, display rules, the stub and (later) membership, bulk edits
and exports all ask the same question of a stored value: does it compare to
the user's value the way the operator says? The answer used to depend on
who asked. The FalkorDB compiler compared raw values (a stored "15" was
never > 10, a stored list aborted the whole query on CONTAINS), the stub
compared Python values, and the browser coerced text to numbers on its own
terms. Here the meaning is written down once:

* ``OPERATOR_TABLE`` — what each operator takes (no value, one, many, a
  pair, a duration), which value types it compares as, and whether it is
  a NEGATIVE operator (``neq`` / ``notIn`` / ``notContains``): the only
  kind for which a missing key needs a decision (``include_missing``).
* ``resolve_comparison`` — turns a predicate's raw value into exact,
  comparable values of one type, or says in plain words why it cannot.
  Integers stay integers end to end (``int(str)``, never a double), dates
  are ISO text at day or second grain, ``P30D`` becomes a pair of bounds.
* ``evaluate`` — the reference evaluator: FalkorDB's semantics written in
  Python, measured against FalkorDB 4.18 and pinned by the live parity
  test (``tests/integration/test_search_semantics_live.py``). The stub
  adapter answers with it, so its results are production's results.

The value TYPE decides how a stored value is read, whatever kind it was
stored as:

* ``string``  — its text. Integers print exactly, floats as ``%.15g``
  (FalkorDB's ``toJSON``, so ``1.5`` reads "1.5", not "1.500000"),
  booleans as "true"/"false". Case-insensitive unless ``case_sensitive``.
* ``number``  — integers and floats as themselves; text that spells an
  integer ("15", "007", "-3746471915534727923") is that exact integer and
  text with a decimal point ("1.5", ".5") is that decimal. Exponent, hex,
  inf and nan spellings are not numbers: FalkorDB parses text into a
  32-bit float (``toFloat('0.1')`` is 0.100000001490116), so they could
  never compare exactly — the decimal is built from its digits instead.
* ``boolean`` — booleans, and the text "true"/"false" in any case.
* ``date``    — ISO text (and FalkorDB Date/Datetime values), compared at
  the grain of the user's value: a day ("2024-05-01") compares calendar
  days, a date-time compares to the second. Offsets written on STORED
  values are not normalised — they compare as written.

A stored LIST matches when any element does; for the negative operators
when none does. ``in`` is therefore also "has any of" on a list, and
``containsAll`` is "has all of". The presence operators (``isSet``,
``isEmpty`` and their negations) take no value and no type.

Every comparison is true or false, never null, so a ``not`` group means
what it says: ``not (owner = "alice")`` includes the entities without an
owner, while ``owner ≠ "alice"`` leaves them out unless
``include_missing`` asks for them.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional, Sequence, Tuple


VALUE_TYPES: Tuple[str, ...] = ("auto", "string", "number", "boolean", "date")

INT64_MIN = -(2 ** 63)
INT64_MAX = 2 ** 63 - 1


class SemanticsError(ValueError):
    """A value that cannot be compared the way the predicate asks. The
    message is written for the person who typed the value."""


@dataclass(frozen=True)
class OperatorSpec:
    #: ``none`` | ``one`` | ``many`` | ``pair`` | ``duration``
    arity: str
    #: The value types the operator compares as. One type means the
    #: operator always compares as it (text operators read the text of
    #: any value; ``withinLast`` reads dates), whatever type is declared.
    types: Tuple[str, ...]
    #: Matches by absence — the only operators ``include_missing`` affects.
    negative: bool = False


_EQUALITY_TYPES = ("string", "number", "boolean", "date")
_ORDER_TYPES = ("number", "date", "string")
_SET_TYPES = ("string", "number", "boolean")

OPERATOR_TABLE: Dict[str, OperatorSpec] = {
    "eq": OperatorSpec("one", _EQUALITY_TYPES),
    "neq": OperatorSpec("one", _EQUALITY_TYPES, negative=True),
    "gt": OperatorSpec("one", _ORDER_TYPES),
    "gte": OperatorSpec("one", _ORDER_TYPES),
    "lt": OperatorSpec("one", _ORDER_TYPES),
    "lte": OperatorSpec("one", _ORDER_TYPES),
    "between": OperatorSpec("pair", _ORDER_TYPES),
    "in": OperatorSpec("many", _SET_TYPES),
    "notIn": OperatorSpec("many", _SET_TYPES, negative=True),
    "containsAll": OperatorSpec("many", _SET_TYPES),
    "contains": OperatorSpec("one", ("string",)),
    "notContains": OperatorSpec("one", ("string",), negative=True),
    "startsWith": OperatorSpec("one", ("string",)),
    "endsWith": OperatorSpec("one", ("string",)),
    "withinLast": OperatorSpec("duration", ("date",)),
    "isSet": OperatorSpec("none", ()),
    "isNotSet": OperatorSpec("none", ()),
    "isEmpty": OperatorSpec("none", ()),
    "isNotEmpty": OperatorSpec("none", ()),
}

#: Each negative operator is the negation of a positive one.
POSITIVE_OF: Dict[str, str] = {
    "neq": "eq", "notIn": "in", "notContains": "contains",
}

_ORDER_OPS = frozenset({"gt", "gte", "lt", "lte", "between"})


def operator_table() -> Dict[str, Dict[str, Any]]:
    """The table as plain data — what the schema export writes for the
    frontend, so both sides read one definition."""
    return {
        op: {"arity": s.arity, "types": list(s.types), "negative": s.negative}
        for op, s in OPERATOR_TABLE.items()
    }


@dataclass(frozen=True)
class Comparison:
    """A predicate resolved to one type and exact comparable values."""
    op: str
    #: ``string`` | ``number`` | ``boolean`` | ``date``; None for presence.
    type: Optional[str]
    #: Coerced values, in the case they were typed — see ``comparable``.
    values: Tuple[Any, ...] = ()
    #: Dates only: ``day`` or ``second``.
    grain: Optional[str] = None
    case_sensitive: bool = False
    include_missing: bool = False

    @property
    def comparable(self) -> Tuple[Any, ...]:
        """The values as a stored key is compared against them: text
        case-folded unless the comparison is case-sensitive."""
        if self.type == "string" and not self.case_sensitive:
            return tuple(fold_case(v) for v in self.values)
        return self.values


# ---------------------------------------------------------------------------
# Resolving a predicate's value
# ---------------------------------------------------------------------------

def resolve_predicate(pred: Any, *, now: Optional[datetime] = None) -> Comparison:
    """``resolve_comparison`` for a PropertyPredicate / EdgePropertyPredicate."""
    return resolve_comparison(
        pred.op, pred.value,
        value_type=getattr(pred, "value_type", "auto") or "auto",
        case_sensitive=bool(getattr(pred, "case_sensitive", False)),
        include_missing=bool(getattr(pred, "include_missing", False)),
        now=now,
    )


def resolve_comparison(
    op: str,
    value: Any,
    *,
    value_type: str = "auto",
    case_sensitive: bool = False,
    include_missing: bool = False,
    now: Optional[datetime] = None,
) -> Comparison:
    spec = OPERATOR_TABLE.get(op)
    if spec is None:
        raise SemanticsError(f"unknown operator {op!r}")
    if value_type not in VALUE_TYPES:
        raise SemanticsError(f"unknown value type {value_type!r}")
    if spec.arity == "none":
        return Comparison(op, None, include_missing=include_missing)

    raw = _raw_values(op, spec.arity, value)
    kind = _resolve_type(op, spec, raw, value_type)

    if kind == "date":
        if op == "withinLast":
            values, grain = _duration_bounds(raw[0], now)
        else:
            values, grain = _date_values(raw, spec.arity)
        return Comparison(op, "date", values, grain,
                          include_missing=include_missing)

    coerce = {"string": _to_string, "number": _to_number,
              "boolean": _to_boolean}[kind]
    values = tuple(coerce(v) for v in raw)
    if spec.types == ("string",) and values[0] == "":
        raise SemanticsError("type some text to look for")
    if spec.arity == "pair":
        lo, hi = values
        folded = (fold_case(lo), fold_case(hi)) if (
            kind == "string" and not case_sensitive) else (lo, hi)
        if _less(folded[1], folded[0]):
            values = (hi, lo)
    elif spec.arity == "many":
        values = tuple(dict.fromkeys(values))
    return Comparison(op, kind, values, None, case_sensitive, include_missing)


def _raw_values(op: str, arity: str, value: Any) -> Tuple[Any, ...]:
    if arity == "many":
        items = list(value) if isinstance(value, (list, tuple)) else [value]
        items = [v for v in items if v is not None and v != ""]
        if not items:
            raise SemanticsError("choose at least one value")
        for v in items:
            _require_scalar(v)
        return tuple(items)
    if arity == "pair":
        if (not isinstance(value, (list, tuple)) or len(value) != 2
                or any(v is None or v == "" for v in value)):
            raise SemanticsError("between needs a lower and an upper value")
        for v in value:
            _require_scalar(v)
        return tuple(value)
    # one / duration
    if isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    if value is None or (arity == "duration" and value == ""):
        raise SemanticsError("enter a value")
    _require_scalar(value)
    if arity == "duration" and not isinstance(value, str):
        raise SemanticsError("give a duration like P30D (30 days)")
    return (value,)


def _require_scalar(v: Any) -> None:
    if not isinstance(v, (str, int, float, bool)):
        raise SemanticsError(f"{_show(v)} is not a single value")


def _resolve_type(op: str, spec: OperatorSpec, raw: Sequence[Any],
                  declared: str) -> str:
    if len(spec.types) == 1:
        return spec.types[0]
    if declared != "auto":
        if declared not in spec.types:
            raise SemanticsError(
                f"{op!r} does not compare {declared} values")
        return declared
    # ``auto`` — the value decides, as it always has: text compares as
    # text. Only the ORDER operators read text that spells a number or a
    # date as one; equality keeps text as text, which is exact for any
    # integer (a stored 64-bit id prints digit for digit).
    if all(isinstance(v, bool) for v in raw):
        if "boolean" not in spec.types:
            raise SemanticsError("true and false have no order")
        return "boolean"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in raw):
        return "number"
    if op in _ORDER_OPS and all(isinstance(v, str) for v in raw):
        if all(_NUMBER_TEXT.fullmatch(v.strip()) for v in raw):
            return "number"
        if all(_looks_like_date(v) for v in raw):
            return "date"
    return "string"


_INT_TEXT = re.compile(r"[+-]?[0-9]+")
_NUMBER_TEXT = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_DAY_TEXT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _show(v: Any) -> str:
    return f'"{v}"' if isinstance(v, str) else repr(v)


def _to_string(v: Any) -> str:
    text = _text(v)
    if text is None:
        raise SemanticsError(f"{_show(v)} is not a text value")
    return text


def _to_number(v: Any):
    if isinstance(v, bool):
        raise SemanticsError(f"{_show(v)} is not a number")
    if isinstance(v, int):
        return _int64(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            raise SemanticsError(f"{_show(v)} is not a number")
        return v
    if isinstance(v, str):
        s = v.strip()
        if _INT_TEXT.fullmatch(s):
            return _int64(int(s))
        if _NUMBER_TEXT.fullmatch(s):
            f = float(s)
            if math.isfinite(f):
                return f
    raise SemanticsError(f"{_show(v)} is not a number")


def _int64(n: int) -> int:
    if not INT64_MIN <= n <= INT64_MAX:
        raise SemanticsError(
            f"{n} is beyond the 64-bit integers a graph can store — "
            f"compare it as text instead")
    return n


def _to_boolean(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in ("true", "false"):
        return v.strip().lower() == "true"
    raise SemanticsError(f"{_show(v)} is not true or false")


def _looks_like_date(v: Any) -> bool:
    try:
        _to_date(v)
    except SemanticsError:
        return False
    return True


def _to_date(v: Any) -> Tuple[str, str]:
    """``(key, grain)`` for a user's date value."""
    if isinstance(v, str):
        s = v.strip()
        if _DAY_TEXT.fullmatch(s):
            try:
                date.fromisoformat(s)
            except ValueError:
                pass
            else:
                return s, "day"
        elif len(s) > 10:
            try:
                dt = datetime.fromisoformat(s)
            except ValueError:
                pass
            else:
                if dt.tzinfo is not None:
                    dt = dt.astimezone(timezone.utc)
                return dt.replace(tzinfo=None).isoformat(timespec="seconds"), "second"
    raise SemanticsError(
        f"{_show(v)} is not a date — use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS")


def _date_values(raw: Sequence[Any], arity: str) -> Tuple[Tuple[str, ...], str]:
    parsed = [_to_date(v) for v in raw]
    if arity == "pair":
        # A day sorts before every time on it, so ISO text sorts in time.
        parsed.sort(key=lambda kg: kg[0])
    if all(grain == "day" for _, grain in parsed):
        return tuple(key for key, _ in parsed), "day"
    # Mixed grains compare to the second: a day as a LOWER bound is its
    # first second, as an UPPER bound its last — "between 1 May and
    # 3 May 12:00" covers all of 1 May.
    keys = []
    for i, (key, grain) in enumerate(parsed):
        if grain == "day":
            key += "T23:59:59" if (arity == "pair" and i == 1) else "T00:00:00"
        keys.append(key)
    return tuple(keys), "second"


_DURATION = re.compile(
    r"P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?"
    r"(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?",
    re.IGNORECASE,
)


def _duration_bounds(text: str, now: Optional[datetime]) -> Tuple[Tuple[str, str], str]:
    """``withinLast`` as ``((lower, upper), grain)``: from ``now`` minus the
    duration up to ``now``. A duration with a time part (``PT12H``)
    compares to the second; days, weeks, months and years compare days."""
    m = _DURATION.fullmatch(text.strip())
    if not m or not any(m.groups()) or text.strip().upper().endswith("T"):
        raise SemanticsError(
            f"{_show(text)} is not a duration — use P30D (30 days), "
            f"P2W, P6M, P1Y or PT12H")
    years, months, weeks, days, hours, minutes, seconds = (
        int(g or 0) for g in m.groups())
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current = current.replace(tzinfo=None, microsecond=0)
    try:
        start = _minus_months(current, years * 12 + months) - timedelta(
            weeks=weeks, days=days, hours=hours, minutes=minutes,
            seconds=seconds)
    except (OverflowError, ValueError):
        raise SemanticsError(f"{_show(text)} reaches back too far")
    if hours or minutes or seconds:
        return (start.isoformat(), current.isoformat()), "second"
    return (start.date().isoformat(), current.date().isoformat()), "day"


def _minus_months(dt: datetime, months: int) -> datetime:
    if not months:
        return dt
    index = dt.year * 12 + dt.month - 1 - months
    year, month = divmod(index, 12)
    month += 1
    if year < 1:
        raise ValueError("before year 1")
    # Clamp the day: 31 March minus one month is 29 February, not 3 March.
    next_month = date(year + (month == 12), month % 12 + 1, 1)
    last_day = (next_month - timedelta(days=1)).day
    return dt.replace(year=year, month=month, day=min(dt.day, last_day))


# ---------------------------------------------------------------------------
# The reference evaluator — FalkorDB's semantics, in Python
# ---------------------------------------------------------------------------

def evaluate(stored: Any, cmp: Comparison) -> bool:
    """Whether a stored value satisfies the comparison. ``stored`` is None
    for a missing key."""
    op = cmp.op
    if op == "isSet":
        return stored is not None
    if op == "isNotSet":
        return stored is None
    if op in ("isEmpty", "isNotEmpty"):
        return _is_blank(stored) == (op == "isEmpty")
    positive = POSITIVE_OF.get(op)
    if positive is not None:
        if stored is None:
            return cmp.include_missing
        return not _matches(stored, positive, cmp)
    return _matches(stored, op, cmp)


def element_texts(stored: Any) -> Tuple[str, ...]:
    """The text of each element of a stored value, as a ``string``
    comparison reads it — what highlighting should show."""
    return tuple(t for t in (_text(e) for e in _elements(stored)) if t is not None)


def value_slot(value: Any) -> Tuple[str, Any]:
    """One distinct value, as FalkorDB groups them: equal numbers are one
    (15 and 15.0 — equal as numbers, and both read "15" as text), while
    text and booleans stay apart from numbers ("15" is not 15, true is not
    1). For counting values the way the engine does."""
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, (int, float)):
        return ("number", value)
    return (type(value).__name__, value)


def fold_case(s: str) -> str:
    """``toLower`` as FalkorDB applies it: one character at a time (simple
    case mapping), so "ΑΣ" folds to "ασ" and "İ" to "i" — ``str.lower``
    would apply the final-sigma rule and expand the dotted I."""
    if s.isascii():
        return s.lower()
    return "".join("i" if ch == "İ" else ch.lower() for ch in s)


def _elements(stored: Any) -> list:
    return stored if isinstance(stored, list) else [stored]


def _is_blank(v: Any) -> bool:
    # FalkorDB's trim() strips spaces only — a tab is content.
    return v is None or v == [] or (isinstance(v, str) and v.strip(" ") == "")


def _matches(stored: Any, op: str, cmp: Comparison) -> bool:
    keys = [k for k in (_key(e, cmp) for e in _elements(stored)) if k is not None]
    values = cmp.comparable
    if op == "containsAll":
        return all(any(_same(k, v) for k in keys) for v in values)
    return any(_test(k, op, values) for k in keys)


def _key(e: Any, cmp: Comparison) -> Any:
    t = cmp.type
    if t == "string":
        text = _text(e)
        if text is None or cmp.case_sensitive:
            return text
        return fold_case(text)
    if t == "number":
        return _stored_number(e)
    if t == "boolean":
        return _stored_boolean(e)
    return _stored_date(e, cmp.grain)


def _test(k: Any, op: str, values: Tuple[Any, ...]) -> bool:
    v = values[0]
    if op == "eq":
        return _same(k, v)
    if op == "in":
        return any(_same(k, x) for x in values)
    if op == "gt":
        return _less(v, k)
    if op == "gte":
        return not _less(k, v)
    if op == "lt":
        return _less(k, v)
    if op == "lte":
        return not _less(v, k)
    if op in ("between", "withinLast"):
        return not _less(k, values[0]) and not _less(values[1], k)
    if op == "contains":
        return v in k
    if op == "startsWith":
        return k.startswith(v)
    if op == "endsWith":
        return k.endswith(v)
    raise SemanticsError(f"unknown operator {op!r}")  # pragma: no cover


def _numeric_pair(a: Any, b: Any) -> Tuple[Any, Any]:
    # FalkorDB compares an integer with a float as two doubles.
    if isinstance(a, float) or isinstance(b, float):
        return float(a), float(b)
    return a, b


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        a, b = _numeric_pair(a, b)
    return a == b


def _less(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        a, b = _numeric_pair(a, b)
    return a < b


def _text(e: Any) -> Optional[str]:
    # FalkorDB: toJSON for a float, toStringOrNull for the rest — null
    # for a list, so a nested list never aborts a comparison.
    if isinstance(e, bool):
        return "true" if e else "false"
    if isinstance(e, int):
        return str(e)
    if isinstance(e, float):
        return "%.15g" % e
    if isinstance(e, str):
        return e
    return None


def _is_int64_text(s: str) -> bool:
    # ``toStringOrNull(toIntegerOrNull(s)) = s``: the canonical spelling
    # of an int64 — no sign, spaces or leading zeros that would print back
    # differently.
    if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", s) or s == "-0":
        return False
    return INT64_MIN <= int(s) <= INT64_MAX


# ``toIntegerOrNull`` on text: C ``strtoll`` over the whole string —
# leading whitespace and a sign allowed, ASCII digits only, nothing after.
_INTEGER_SPELLING = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+")


def _text_integer(s: str) -> Optional[int]:
    if not _INTEGER_SPELLING.fullmatch(s):
        return None
    n = int(s)
    return n if INT64_MIN <= n <= INT64_MAX else None


def _stored_number(e: Any) -> Any:
    if isinstance(e, bool):
        return None
    if isinstance(e, int):
        return e
    if isinstance(e, float):
        return None if math.isnan(e) else e
    if not isinstance(e, str):
        return None
    if "." not in e:
        return _text_integer(e)
    # "12.5" is 125 / 10^1 in doubles — the same arithmetic the Cypher
    # does, so both round alike.
    parts = e.split(".")
    if len(parts) != 2:
        return None
    n = _text_integer(parts[0] + parts[1])
    if n is None:
        return None
    try:
        scale = 10.0 ** len(parts[1])
    except OverflowError:
        scale = math.inf
    return float(n) / scale


def _stored_boolean(e: Any) -> Optional[bool]:
    if isinstance(e, bool):
        return e
    if isinstance(e, str):
        return {"true": True, "false": False}.get(e.lower())
    return None


_DATE_TEMPLATE = "0000-00-00T00:00:00"


def _stored_date(e: Any, grain: Optional[str]) -> Optional[str]:
    if not isinstance(e, str):
        return None
    digits = e[0:4] + e[5:7] + e[8:10]
    if not (e[4:5] == "-" and e[7:8] == "-" and _is_int64_text(digits)):
        return None
    if grain == "day":
        return e[0:10]
    t = e[0:19].replace(" ", "T")
    return t + _DATE_TEMPLATE[len(t):]
