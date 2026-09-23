"""
Cypher for one typed property comparison — ``search_semantics`` compiled
for FalkorDB.

Every comparison has to survive every kind of stored value. A property is
text on one node, an integer on the next, a list on a third — and a single
FalkorDB type error aborts the WHOLE query, not just that row:
``toString(<list>)`` raises, so does ``5 STARTS WITH 'a'``, ``toLower(5)``
and ``size(5)``.

Guarding with ``CASE`` does not help, because FalkorDB evaluates EVERY
branch of a ``CASE`` whatever the condition (4.18: ``CASE WHEN
typeOf(x) = 'List' THEN 0 ELSE toString(x) END`` raises on a list). So
the guards go INSIDE the arguments, and only functions that are total on
every type are applied to a raw value: ``typeOf``, ``toStringOrNull``,
``toIntegerOrNull``, ``toBooleanOrNull``, ``=``, and ``toJSON`` on a value
already filtered down to a float.

Two more engine behaviours shape the numbers (FalkorDB 4.18):

* ``toFloat`` / ``toFloatOrNull`` parse TEXT into a 32-bit float —
  ``toFloat('0.1')`` is 0.100000001490116 — so numeric text never goes
  through them. Integer text goes through ``toIntegerOrNull`` (exact
  int64); decimal text is its digits as an integer over a power of ten.
* Integer ordering is computed by subtraction and wraps:
  ``9223372036854775807 > -1`` is false. Equality is safe, so ``=`` and
  ``IN`` are left alone, but every ORDER comparison against a number is
  split on sign (``_number_order``) so the subtraction never overflows.

Each comparison has the same shape::

    ANY(_x IN <keys> WHERE <test>)

``<keys>`` maps the stored value's elements (a scalar is a one-element
list) to comparable keys of the comparison's type and drops the ones that
have none, so ``<test>`` only ever compares like with like and is true or
false — never null. A negative operator is the negation of its positive,
with the missing key decided explicitly. ``search_semantics.evaluate`` is
the same thing in Python; the live parity test holds them together.
"""
from __future__ import annotations

from typing import Any, Callable

from backend.common.search_semantics import POSITIVE_OF, Comparison


#: Registers a parameter value and returns its ``$name``.
Bind = Callable[[Any], str]

_SYMBOL = {
    "eq": "=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<=",
    "contains": "CONTAINS", "startsWith": "STARTS WITH",
    "endsWith": "ENDS WITH",
}

# Every variable a comparison binds starts with "_": FalkorDB does not scope
# comprehension variables, so a bare ``p`` would resolve to a path query's
# own ``p`` (and ``size(p)`` would fail on the Path).

# The text of an element: a float through toJSON ("1.5" — toString says
# "1.500000"), everything else through toStringOrNull (null for a list).
_TEXT = ("CASE WHEN typeOf(_e) = 'Float' "
         "THEN toJSON(CASE WHEN typeOf(_e) = 'Float' THEN _e END) "
         "ELSE toStringOrNull(_e) END")

# The number an element holds. Text without a point is an integer through
# toIntegerOrNull (which would truncate "1.5" to 1 — hence the split);
# "12.5" is 125 * 1.0 / 10.0 ^ 1, built in doubles from its digits.
_TEXT_NUMBER = ("[_s IN [CASE WHEN typeOf(_e) = 'String' THEN _e END] | "
                "CASE WHEN _s CONTAINS '.' "
                "THEN [_p IN [split(_s, '.')] | CASE WHEN size(_p) = 2 "
                "THEN toIntegerOrNull(_p[0] + _p[1]) * 1.0 / 10.0 ^ size(_p[1]) END][0] "
                "ELSE toIntegerOrNull(_s) END][0]")
_NUMBER = ("CASE typeOf(_e) WHEN 'Integer' THEN _e WHEN 'Float' THEN _e "
           f"WHEN 'String' THEN {_TEXT_NUMBER} END")

_BOOLEAN = ("CASE typeOf(_e) WHEN 'Boolean' THEN _e "
            "WHEN 'String' THEN toBooleanOrNull(_e) END")

_DATE_TEXT = ("CASE WHEN typeOf(_e) IN ['String', 'Date', 'Datetime'] "
              "THEN toStringOrNull(_e) END")

# "YYYY-MM-DD…": dashes where ISO puts them and eight digits around them
# that print back as themselves (FalkorDB has no regex).
_DIGITS = "substring(_s, 0, 4) + substring(_s, 5, 2) + substring(_s, 8, 2)"
_ISO_DAY_SHAPE = (f"substring(_s, 4, 1) = '-' AND substring(_s, 7, 1) = '-' "
                  f"AND toStringOrNull(toIntegerOrNull({_DIGITS})) = {_DIGITS}")

_SECOND_TEMPLATE = "0000-00-00T00:00:00"


def compile_comparison(col: str, cmp: Comparison, bind: Bind) -> str:
    """A WHERE fragment true exactly where ``search_semantics.evaluate``
    is, for the stored value ``col`` (``n.`key``` or ``rel.`key```)."""
    op = cmp.op
    if op == "isSet":
        return f"{col} IS NOT NULL"
    if op == "isNotSet":
        return f"{col} IS NULL"
    if op in ("isEmpty", "isNotEmpty"):
        blank = (f"coalesce({col} IS NULL OR {col} = [] OR "
                 f"trim(CASE WHEN typeOf({col}) = 'String' THEN {col} END) = '', "
                 f"false)")
        return blank if op == "isEmpty" else f"NOT {blank}"
    positive = POSITIVE_OF.get(op)
    if positive is None:
        return _match(col, op, cmp, bind)
    test = _match(col, positive, cmp, bind)
    if cmp.include_missing:
        return f"({col} IS NULL OR NOT {test})"
    return f"({col} IS NOT NULL AND NOT {test})"


def _match(col: str, op: str, cmp: Comparison, bind: Bind) -> str:
    keys = _keys(col, cmp)
    values = cmp.comparable
    if op == "containsAll":
        # Bind the keys once; ALL would otherwise rebuild them per value.
        return (f"ANY(_ks IN [{keys}] "
                f"WHERE ALL(_v IN {bind(list(values))} WHERE _v IN _ks))")
    if op == "in":
        test = f"_x IN {bind(list(values))}"
    elif cmp.type == "number" and op in ("gt", "gte", "lt", "lte"):
        test = _number_order(op, values[0], bind)
    elif cmp.type == "number" and op == "between":
        test = (f"{_number_order('gte', values[0], bind)} "
                f"AND {_number_order('lte', values[1], bind)}")
    elif op in ("between", "withinLast"):
        test = f"{bind(values[0])} <= _x <= {bind(values[1])}"
    else:
        test = f"_x {_SYMBOL[op]} {bind(values[0])}"
    return f"ANY(_x IN {keys} WHERE {test})"


def _number_order(op: str, value: Any, bind: Bind) -> str:
    """``_x <op> value`` for numbers, immune to FalkorDB's wrapping integer
    ordering. Two numbers of the same sign subtract without overflow, and
    across signs the sign alone decides — so the raw comparison is only
    trusted where both sides share a sign. The sign of ``value`` is known
    here; the sign of ``_x`` is tested (``_x >= 0`` cannot overflow)."""
    raw = f"_x {_SYMBOL[op]} {bind(value)}"
    if op in ("gt", "gte"):
        return f"(_x >= 0 AND {raw})" if value >= 0 else f"(_x >= 0 OR {raw})"
    return f"(_x < 0 OR {raw})" if value >= 0 else f"(_x < 0 AND {raw})"


def _keys(col: str, cmp: Comparison) -> str:
    elements = f"CASE WHEN typeOf({col}) = 'List' THEN {col} ELSE [{col}] END"
    if cmp.type == "string":
        text = _TEXT if cmp.case_sensitive else f"toLower({_TEXT})"
        return f"[_k IN [_e IN {elements} | {text}] WHERE _k IS NOT NULL]"
    if cmp.type == "number":
        # ``_k = _k`` drops null AND NaN: FalkorDB's IN finds a NaN equal
        # to every value.
        return f"[_k IN [_e IN {elements} | {_NUMBER}] WHERE _k = _k]"
    if cmp.type == "boolean":
        return f"[_k IN [_e IN {elements} | {_BOOLEAN}] WHERE _k IS NOT NULL]"
    dated = f"[_s IN [_e IN {elements} | {_DATE_TEXT}] WHERE {_ISO_DAY_SHAPE}]"
    if cmp.grain == "day":
        return f"[_s IN {dated} | substring(_s, 0, 10)]"
    # To the second: 'T' for a space, cut at seconds, and a short value
    # padded from the template ("2024-05-01" → "2024-05-01T00:00:00").
    return (f"[_t IN [_s IN {dated} | replace(substring(_s, 0, 19), ' ', 'T')] "
            f"| _t + substring('{_SECOND_TEMPLATE}', size(_t))]")
