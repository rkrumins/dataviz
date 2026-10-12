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

A comparison is one branch per stored kind, each gated by ``typeOf``::

    (typeOf(c) IN ['Integer', 'Float'] AND c = c AND <test(c)>)
    OR (typeOf(c) = 'String' AND … AND <test(<the number the text spells>)>)
    OR …
    OR (typeOf(c) = 'List' AND ANY(_e IN c WHERE <the same branches for _e>))

FalkorDB short-circuits AND / OR in a WHERE (and inside ANY), so an entity
pays only for the branch of its own kind — a scalar compared directly costs
two to three times a raw comparison, where mapping every value through a
list cost ten. In a projection (rule membership, rule counts) every branch
runs, so each is built from total functions and each is true or false, never
null. A negative operator is the negation of its positive, with the missing
key decided explicitly. ``search_semantics.evaluate`` is the same thing in
Python; the live parity test holds them together in both contexts.
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

def text_of(var: str) -> str:
    """The text of a value as ``string`` comparisons read it: a float
    through toJSON ("1.5" — toString says "1.500000"), everything else
    through toStringOrNull (null for a list). Total on every type."""
    return (f"CASE WHEN typeOf({var}) = 'Float' "
            f"THEN toJSON(CASE WHEN typeOf({var}) = 'Float' THEN {var} END) "
            f"ELSE toStringOrNull({var}) END")


_TEXT = text_of("_e")

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
    values = cmp.comparable
    if op == "containsAll":
        # Bind the keys once; ALL would otherwise rebuild them per value.
        keys = _keys_of(f"CASE WHEN typeOf({col}) = 'List' THEN {col} ELSE [{col}] END", cmp)
        return (f"ANY(_ks IN [{keys}] "
                f"WHERE ALL(_v IN {bind(list(values))} WHERE _v IN _ks))")
    test = _test(op, cmp, values, bind)
    # One branch per stored kind, each gated by typeOf. FalkorDB
    # short-circuits AND / OR in a WHERE, so an entity pays only for the
    # branch of its own kind — a scalar compared directly, a list element by
    # element — at two to three times the cost of a raw comparison where one
    # list per entity cost ten. In a projection every branch runs, so each
    # is built from total functions and is true or false, never null.
    branches = _scalar_branches(col, cmp, test)
    # A list: the same branches, element by element (a nested list, like any
    # other kind the type cannot read, matches no branch).
    element = " OR ".join(_scalar_branches("_e", cmp, test))
    branches.append(
        f"(typeOf({col}) = 'List' AND ANY(_e IN "
        f"CASE WHEN typeOf({col}) = 'List' THEN {col} ELSE [] END WHERE {element}))")
    return "(" + " OR ".join(branches) + ")"


_TEXT_KINDS = "['String', 'Integer', 'Boolean', 'Date', 'Datetime', 'Duration', 'Point']"


def _decimal_of(text: str) -> str:
    """"12.5" as 125 * 1.0 / 10.0 ^ 1 — see ``_TEXT_NUMBER``."""
    return (f"[_p IN [split({text}, '.')] | CASE WHEN size(_p) = 2 "
            f"THEN toIntegerOrNull(_p[0] + _p[1]) * 1.0 / 10.0 ^ size(_p[1]) END][0]")


def _scalar_branches(col: str, cmp: Comparison, test) -> list:
    """A stored value that is not a list, one branch per kind the type can
    read — each exactly that kind's key in ``_keys_of``, written for a
    scalar, and gated so only that kind reaches it."""
    if cmp.type == "number":
        text = f"toStringOrNull({col})"
        whole = f"toIntegerOrNull({text})"
        return [
            # A NaN equals nothing, not even itself — yet FalkorDB's IN finds
            # it equal to every value; ``= itself`` keeps it out.
            f"(typeOf({col}) IN ['Integer', 'Float'] AND {col} = {col} AND {test(col)})",
            f"(typeOf({col}) = 'String' AND NOT {text} CONTAINS '.' "
            f"AND {whole} IS NOT NULL AND {test(whole)})",
            f"(typeOf({col}) = 'String' AND {text} CONTAINS '.' AND ANY(_x IN "
            f"[_k IN [{_decimal_of(text)}] WHERE _k IS NOT NULL] WHERE {test('_x')}))",
        ]
    if cmp.type == "string":
        text = f"toStringOrNull({col})"
        floats = f"toJSON(CASE WHEN typeOf({col}) = 'Float' THEN {col} END)"
        if not cmp.case_sensitive:
            text, floats = f"toLower({text})", f"toLower({floats})"
        return [
            f"(typeOf({col}) IN {_TEXT_KINDS} AND {test(text)})",
            f"(typeOf({col}) = 'Float' AND {test(floats)})",
        ]
    if cmp.type == "boolean":
        parsed = f"toBooleanOrNull(toStringOrNull({col}))"
        return [
            f"(typeOf({col}) = 'Boolean' AND {test(col)})",
            f"(typeOf({col}) = 'String' AND {parsed} IS NOT NULL AND {test(parsed)})",
        ]
    text = f"toStringOrNull({col})"
    digits = f"substring({text}, 0, 4) + substring({text}, 5, 2) + substring({text}, 8, 2)"
    if cmp.grain == "day":
        key = f"substring({text}, 0, 10)"
    else:
        t = f"replace(substring({text}, 0, 19), ' ', 'T')"
        # ``coalesce``: substring(…, null) raises, and in a projection this
        # runs for a value that is not text at all.
        key = f"{t} + substring('{_SECOND_TEMPLATE}', coalesce(size({t}), 19))"
    # Cheapest first: the dashes and the comparison itself rule out nearly
    # every entity before the digits are checked.
    return [
        f"(typeOf({col}) IN ['String', 'Date', 'Datetime'] "
        f"AND substring({text}, 4, 1) = '-' AND substring({text}, 7, 1) = '-' "
        f"AND {test(key)} AND toStringOrNull(toIntegerOrNull({digits})) = {digits})",
    ]


def _test(op: str, cmp: Comparison, values, bind: Bind):
    """The comparison of one key against the values, for any key
    expression — parameters are bound once, however many times it is
    written out."""
    if op == "in":
        p = bind(list(values))
        return lambda x: f"{x} IN {p}"
    if cmp.type == "number" and op in ("gt", "gte", "lt", "lte"):
        order = _number_order(op, values[0], bind)
        return order
    if cmp.type == "number" and op == "between":
        lo = _number_order("gte", values[0], bind)
        hi = _number_order("lte", values[1], bind)
        return lambda x: f"{lo(x)} AND {hi(x)}"
    if op in ("between", "withinLast"):
        lo, hi = bind(values[0]), bind(values[1])
        return lambda x: f"{lo} <= {x} <= {hi}"
    p = bind(values[0])
    return lambda x: f"{x} {_SYMBOL[op]} {p}"


def _number_order(op: str, value: Any, bind: Bind):
    """``x <op> value`` for numbers, immune to FalkorDB's wrapping integer
    ordering. Two numbers of the same sign subtract without overflow, and
    across signs the sign alone decides — so the raw comparison is only
    trusted where both sides share a sign. The sign of ``value`` is known
    here; the sign of ``x`` is tested (``x >= 0`` cannot overflow)."""
    p = bind(value)
    if op in ("gt", "gte"):
        if value >= 0:
            return lambda x: f"({x} >= 0 AND {x} {_SYMBOL[op]} {p})"
        return lambda x: f"({x} >= 0 OR {x} {_SYMBOL[op]} {p})"
    if value >= 0:
        return lambda x: f"({x} < 0 OR {x} {_SYMBOL[op]} {p})"
    return lambda x: f"({x} < 0 AND {x} {_SYMBOL[op]} {p})"


def _keys_of(elements: str, cmp: Comparison) -> str:
    """The comparable keys of a list of elements, those without one
    dropped — so a test over them is true or false, never null."""
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
