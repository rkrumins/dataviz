"""The Cypher a typed comparison compiles to — the engine-safety rules.

``falkordb_typed_ops.compile_comparison`` must never emit a fragment that
a FalkorDB 4.18 quirk can break, whatever the stored values are. Each rule
here is a measured behaviour (see the module docstring), and each one broke
a query before it was a rule:

* ``toString`` / ``toLower`` / ``size`` / ``STARTS WITH`` raise on the wrong
  type and abort the WHOLE query — and ``CASE`` does not guard them,
  because FalkorDB evaluates every branch;
* ``toFloat`` / ``toFloatOrNull`` parse text at 32-bit precision;
* integer ORDER comparisons wrap (``9223372036854775807 > -1`` is false);
* comprehension variables are not scoped, so a bare ``p`` or ``s`` would
  read a path query's own variables.

What each fragment MEANS is ``search_semantics.evaluate``'s job and the
live parity test's (``tests/integration/test_search_semantics_live.py``).
"""
import re

import pytest

from backend.app.providers.falkordb_typed_ops import compile_comparison
from backend.common.search_semantics import OPERATOR_TABLE, resolve_comparison


SAMPLE = {
    "string": {"one": "Alpha", "many": ["Alpha", "b"], "pair": ["a", "m"]},
    "number": {"one": 5, "many": [5, 1.5], "pair": [-1, 10]},
    "boolean": {"one": True, "many": [True]},
    "date": {"one": "2024-05-01", "pair": ["2024-05-01", "2024-05-02T10:00:00"],
             "duration": "P30D"},
}


def _cases():
    for op, spec in OPERATOR_TABLE.items():
        if spec.arity == "none":
            yield op, None, "auto"
            continue
        for kind in spec.types:
            value = SAMPLE[kind].get(spec.arity)
            if value is not None:
                yield op, value, kind


CASES = list(_cases())


def _compile(op, value, value_type="auto", **kw):
    params = {}

    def bind(v):
        name = f"p{len(params)}"
        params[name] = v
        return f"${name}"

    cmp = resolve_comparison(op, value, value_type=value_type, **kw)
    return compile_comparison("n.`k`", cmp, bind), params


@pytest.mark.parametrize("op,value,value_type", CASES,
                         ids=[f"{c[0]}-{c[2]}" for c in CASES])
class TestEverySafetyRule:
    def test_no_raising_conversions(self, op, value, value_type):
        where, _ = _compile(op, value, value_type)
        # toStringOrNull is total; toString raises on a list.
        assert not re.search(r"toString\(", where)
        assert "toFloat" not in where

    def test_text_functions_only_see_text(self, op, value, value_type):
        where, _ = _compile(op, value, value_type)
        # The raw column only ever reaches typeOf, IS [NOT] NULL, = [],
        # list construction and a String-filtered CASE — never a text
        # function or a text operator directly.
        for fn in ("toLower", "trim", "substring", "replace", "size", "split"):
            assert f"{fn}(n.`k`" not in where
        assert not re.search(r"n\.`k` (CONTAINS|STARTS WITH|ENDS WITH)", where)

    def test_every_bound_variable_is_private(self, op, value, value_type):
        where, _ = _compile(op, value, value_type)
        for var in re.findall(r"(?:\[|ANY\(|ALL\()\s*(\w+) IN ", where):
            assert var.startswith("_"), (var, where)

    def test_brackets_balance(self, op, value, value_type):
        where, _ = _compile(op, value, value_type)
        stripped = re.sub(r"'[^']*'", "", where)
        for open_, close in ("()", "[]"):
            depth = 0
            for ch in stripped:
                depth += (ch == open_) - (ch == close)
                assert depth >= 0
            assert depth == 0


class TestNumberOrdering:
    """``_x <op> $p`` is only trusted where both sides share a sign."""

    @pytest.mark.parametrize("op,value,expected", [
        ("gt", 5, "(_x >= 0 AND _x > $p0)"),
        ("gt", -5, "(_x >= 0 OR _x > $p0)"),
        ("gte", 0, "(_x >= 0 AND _x >= $p0)"),
        ("lt", 5, "(_x < 0 OR _x < $p0)"),
        ("lt", -5, "(_x < 0 AND _x < $p0)"),
        ("lte", -1.5, "(_x < 0 AND _x <= $p0)"),
    ])
    def test_sign_guard(self, op, value, expected):
        where, params = _compile(op, value)
        assert expected in where
        assert params == {"p0": value}

    def test_between_guards_both_ends(self):
        where, params = _compile("between", [-3, 9])
        assert "(_x >= 0 OR _x >= $p0) AND (_x < 0 OR _x <= $p1)" in where
        assert params == {"p0": -3, "p1": 9}

    def test_text_and_date_order_need_no_guard(self):
        where, _ = _compile("gt", "m")
        assert "_x > $p0" in where and "_x >= 0" not in where
        where, _ = _compile("between", ["2024-05-01", "2024-06-01"])
        assert "$p0 <= _x <= $p1" in where


class TestParams:
    def test_text_is_folded_unless_case_sensitive(self):
        assert _compile("eq", "AbC")[1] == {"p0": "abc"}
        assert _compile("eq", "AbC", case_sensitive=True)[1] == {"p0": "AbC"}
        assert _compile("in", ["ΑΣ", "B"])[1] == {"p0": ["ασ", "b"]}

    def test_int64_is_bound_as_an_integer(self):
        where, params = _compile("eq", "-3746471915534727923", "number")
        assert params == {"p0": -3746471915534727923}

    def test_contains_all_binds_its_keys_once(self):
        where, params = _compile("containsAll", ["a", "b"])
        assert where.startswith("ANY(_ks IN [")
        assert "WHERE ALL(_v IN $p0 WHERE _v IN _ks))" in where
        assert params == {"p0": ["a", "b"]}

    def test_negatives_decide_the_missing_key(self):
        assert _compile("neq", "a")[0].startswith("(n.`k` IS NOT NULL AND NOT ANY(")
        assert _compile("neq", "a", include_missing=True)[0].startswith(
            "(n.`k` IS NULL OR NOT ANY(")
