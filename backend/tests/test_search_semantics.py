"""What a property comparison means — ``backend/common/search_semantics``.

Reported: on a large graph, value search on properties "doesn't work" —
``gvHash equals -3746471915534728000`` found nothing (the browser had
rounded the 19-digit id), a stored "15" was never greater than 10, a stored
list aborted CONTAINS for the whole query, and ``1.5`` stored as a float read
back as "1.500000". These tests pin the contract every engine now shares:
each operator per value type, per stored kind, lists, missing keys and the
exact integers. ``tests/integration/test_search_semantics_live.py`` holds
the compiled Cypher to the same answers on a real FalkorDB.
"""
from datetime import datetime, timezone
from typing import get_args

import pytest

from backend.common.models.search import PropertyOp, PropertyPredicate
from backend.common.search_semantics import (
    OPERATOR_TABLE,
    Comparison,
    SemanticsError,
    element_texts,
    evaluate,
    fold_case,
    operator_table,
    resolve_comparison,
    resolve_predicate,
)


NOW = datetime(2024, 5, 20, 12, 0, 0, tzinfo=timezone.utc)


def matches(stored, op, value=None, **kw):
    return evaluate(stored, resolve_comparison(op, value, now=NOW, **kw))


# ---------------------------------------------------------------------------
# The table
# ---------------------------------------------------------------------------

class TestOperatorTable:
    def test_every_model_operator_has_a_meaning(self):
        assert set(get_args(PropertyOp)) == set(OPERATOR_TABLE)

    def test_negative_operators_are_the_ones_with_a_positive(self):
        negative = {op for op, spec in OPERATOR_TABLE.items() if spec.negative}
        assert negative == {"neq", "notIn", "notContains"}

    def test_plain_data_for_the_frontend(self):
        table = operator_table()
        assert table["between"] == {
            "arity": "pair", "types": ["number", "date", "string"],
            "negative": False,
        }
        assert table["isEmpty"]["arity"] == "none"


# ---------------------------------------------------------------------------
# Resolving values
# ---------------------------------------------------------------------------

class TestResolveAuto:
    """``auto`` keeps what predicates always meant: the value decides."""

    @pytest.mark.parametrize("op,value,kind", [
        ("eq", "15", "string"),        # equality keeps text as text
        ("eq", 15, "number"),
        ("eq", 1.5, "number"),
        ("eq", True, "boolean"),
        ("gt", "10", "number"),        # order reads numeric text as a number
        ("gt", "2024-05-01", "date"),
        ("gt", "m", "string"),
        ("between", ["1", "16"], "number"),
        ("in", ["a", 1], "string"),
        ("in", [1, 2.5], "number"),
        ("contains", 74, "string"),    # text operators read text, always
        ("withinLast", "P30D", "date"),
    ])
    def test_value_decides_the_type(self, op, value, kind):
        assert resolve_comparison(op, value, now=NOW).type == kind

    def test_true_and_false_have_no_order(self):
        with pytest.raises(SemanticsError, match="no order"):
            resolve_comparison("gt", True)


class TestResolveDeclared:
    def test_declared_type_wins(self):
        cmp = resolve_comparison("eq", "15", value_type="number")
        assert (cmp.type, cmp.values) == ("number", (15,))

    def test_a_type_the_operator_does_not_compare(self):
        with pytest.raises(SemanticsError, match="does not compare boolean"):
            resolve_comparison("gt", True, value_type="boolean")

    def test_text_operators_ignore_a_declared_type(self):
        """``gvHash contains 74`` on a numeric property means its digits."""
        cmp = resolve_comparison("contains", "74", value_type="number")
        assert (cmp.type, cmp.values) == ("string", ("74",))

    def test_unknown_operator_and_type(self):
        with pytest.raises(SemanticsError, match="unknown operator"):
            resolve_comparison("like", "x")
        with pytest.raises(SemanticsError, match="unknown value type"):
            resolve_comparison("eq", "x", value_type="uuid")


class TestResolveNumbers:
    def test_int64_digits_stay_exact(self):
        for text in ("-3746471915534727923", "9223372036854775807",
                     "-9223372036854775808"):
            cmp = resolve_comparison("eq", text, value_type="number")
            assert cmp.values == (int(text),)
            assert isinstance(cmp.values[0], int)

    def test_beyond_int64_is_refused_with_a_way_out(self):
        with pytest.raises(SemanticsError, match="compare it as text"):
            resolve_comparison("eq", "18446744073709551615", value_type="number")

    @pytest.mark.parametrize("value,expected", [
        ("007", 7), (" 12 ", 12), ("+5", 5), ("1.5", 1.5), (".5", 0.5),
        ("1e3", 1000.0), (1.0, 1.0),
    ])
    def test_number_spellings(self, value, expected):
        assert resolve_comparison("eq", value, value_type="number").values == (expected,)

    @pytest.mark.parametrize("value", ["abc", "", "nan", "inf", "0x1A", True, float("nan")])
    def test_not_numbers(self, value):
        with pytest.raises(SemanticsError, match="not a number"):
            resolve_comparison("eq", value, value_type="number")

    def test_between_puts_the_ends_in_order(self):
        assert resolve_comparison("between", [20, 1]).values == (1, 20)
        assert resolve_comparison(
            "between", ["b", "A"], value_type="string").values == ("A", "b")


class TestResolveShapes:
    def test_one_value(self):
        with pytest.raises(SemanticsError, match="enter a value"):
            resolve_comparison("eq", None)
        assert resolve_comparison("eq", ["x"]).values == ("x",)
        with pytest.raises(SemanticsError, match="not a single value"):
            resolve_comparison("eq", {"a": 1})

    def test_many_values(self):
        assert resolve_comparison("in", "x").values == ("x",)
        assert resolve_comparison("in", ["a", "a", "", None, "b"]).values == ("a", "b")
        with pytest.raises(SemanticsError, match="at least one"):
            resolve_comparison("in", [])

    def test_pair(self):
        for bad in ([1], [1, None], 5, [1, 2, 3], ["", 2]):
            with pytest.raises(SemanticsError, match="lower and an upper"):
                resolve_comparison("between", bad)

    def test_text_operators_need_text(self):
        with pytest.raises(SemanticsError, match="some text"):
            resolve_comparison("contains", "")

    def test_presence_takes_no_value(self):
        cmp = resolve_comparison("isEmpty", "ignored")
        assert (cmp.type, cmp.values) == (None, ())

    def test_booleans(self):
        assert resolve_comparison("eq", " TRUE ", value_type="boolean").values == (True,)
        with pytest.raises(SemanticsError, match="true or false"):
            resolve_comparison("eq", "yes", value_type="boolean")


class TestResolveDates:
    def test_a_day_compares_days(self):
        cmp = resolve_comparison("eq", "2024-05-01", value_type="date")
        assert (cmp.values, cmp.grain) == (("2024-05-01",), "day")

    def test_a_time_compares_seconds_in_utc(self):
        cmp = resolve_comparison("eq", "2024-05-01T10:00:00+02:00", value_type="date")
        assert (cmp.values, cmp.grain) == (("2024-05-01T08:00:00",), "second")
        cmp = resolve_comparison("eq", "2024-05-01T10:00:00.9Z", value_type="date")
        assert cmp.values == ("2024-05-01T10:00:00",)

    def test_mixed_grain_range_covers_whole_days(self):
        cmp = resolve_comparison(
            "between", ["2024-05-03T12:00:00", "2024-05-01"], value_type="date")
        assert (cmp.values, cmp.grain) == (
            ("2024-05-01T00:00:00", "2024-05-03T12:00:00"), "second")
        cmp = resolve_comparison(
            "between", ["2024-05-01T06:00:00", "2024-05-03"], value_type="date")
        assert cmp.values == ("2024-05-01T06:00:00", "2024-05-03T23:59:59")

    @pytest.mark.parametrize("value", ["2024-02-30", "yesterday", "2024/05/01", "20240501"])
    def test_not_dates(self, value):
        with pytest.raises(SemanticsError, match="not a date"):
            resolve_comparison("eq", value, value_type="date")

    @pytest.mark.parametrize("duration,bounds,grain", [
        ("P30D", ("2024-04-20", "2024-05-20"), "day"),
        ("P2W", ("2024-05-06", "2024-05-20"), "day"),
        ("P1M", ("2024-04-20", "2024-05-20"), "day"),
        ("P1Y", ("2023-05-20", "2024-05-20"), "day"),
        ("PT2H", ("2024-05-20T10:00:00", "2024-05-20T12:00:00"), "second"),
        ("p1dt6h", ("2024-05-19T06:00:00", "2024-05-20T12:00:00"), "second"),
    ])
    def test_within_last(self, duration, bounds, grain):
        cmp = resolve_comparison("withinLast", duration, now=NOW)
        assert (cmp.values, cmp.grain) == (bounds, grain)

    def test_within_last_clamps_month_ends(self):
        cmp = resolve_comparison(
            "withinLast", "P1M", now=datetime(2024, 3, 31, tzinfo=timezone.utc))
        assert cmp.values[0] == "2024-02-29"

    @pytest.mark.parametrize("duration", ["30 days", "P", "PT", "P1DT", 30, "P99999Y"])
    def test_not_durations(self, duration):
        with pytest.raises(SemanticsError):
            resolve_comparison("withinLast", duration, now=NOW)


def test_resolve_predicate_reads_the_model():
    pred = PropertyPredicate.model_validate({
        "kind": "property", "key": "k", "op": "neq", "value": "x",
        "valueType": "string", "caseSensitive": True, "includeMissing": True,
    })
    cmp = resolve_predicate(pred)
    assert cmp == Comparison("neq", "string", ("x",), None, True, True)


# ---------------------------------------------------------------------------
# Evaluating stored values
# ---------------------------------------------------------------------------

class TestText:
    def test_every_scalar_kind_has_text(self):
        assert matches(15, "eq", "15")
        assert matches(-3746471915534727923, "eq", "-3746471915534727923")
        assert matches(1.5, "eq", "1.5")           # not "1.500000"
        assert matches(15.0, "eq", "15")
        assert matches(True, "eq", "TRUE")
        assert not matches(None, "eq", "none")

    def test_the_reported_contains_on_an_int64(self):
        assert matches(-3746471915534727923, "contains", "74")
        assert not matches(-3746471915534727923, "contains", "99")

    def test_case(self):
        assert matches("Alpha", "startsWith", "al")
        assert not matches("Alpha", "startsWith", "al", case_sensitive=True)
        assert matches("ΑΣ", "eq", "ασ")           # no final sigma
        assert matches("İstanbul", "startsWith", "ist")

    def test_float_text_is_percent_15g(self):
        assert element_texts([0.1, 1e20, -0.0, 123456789.123456789]) == (
            "0.1", "1e+20", "-0", "123456789.123457")

    def test_text_order(self):
        assert matches("b", "gt", "A")
        assert matches("B", "between", ["a", "c"])


class TestNumbers:
    def test_numeric_text_is_a_number(self):
        assert matches("15", "gt", 10)
        assert matches("007", "eq", 7)
        assert matches(" 12", "eq", 12)
        assert matches("1.5", "eq", 1.5)
        assert matches("0.1", "eq", 0.1)          # exact, not a 32-bit float
        assert matches("123456789.5", "eq", 123456789.5)
        assert matches("-.5", "eq", -0.5)
        assert matches("5.", "eq", 5)

    def test_int64_is_exact_both_ways(self):
        big = "-3746471915534727923"
        assert matches(big, "eq", big, value_type="number")
        assert matches(int(big), "eq", big, value_type="number")
        assert not matches(int(big) + 1, "eq", big, value_type="number")
        assert matches(2 ** 63 - 1, "gt", -1)   # FalkorDB wraps this one
        assert matches(-(2 ** 63), "lt", 2 ** 63 - 1)

    @pytest.mark.parametrize("stored", [
        "abc", "", "12 ", "1e3", "0x1A", "nan", "inf", "1.2.3", "١٢", "1_000",
        "99999999999999999999", True, [], None, float("nan"),
    ])
    def test_not_numbers_never_match(self, stored):
        for op, value in (("eq", 12), ("gt", -1e30), ("lt", 1e30), ("in", [12])):
            assert not matches(stored, op, value), (stored, op)

    def test_int_and_float_compare_as_doubles(self):
        assert matches(9007199254740993, "eq", 9007199254740992.0)
        assert matches(15, "eq", 15.0)


class TestBooleansAndDates:
    def test_booleans(self):
        assert matches(True, "eq", True)
        assert matches("true", "eq", True)
        assert matches("FALSE", "eq", False)
        assert not matches(" true", "eq", True)   # toBooleanOrNull does not trim
        assert not matches(1, "eq", True)
        assert not matches("yes", "eq", True)

    def test_dates_at_day_grain(self):
        assert matches("2024-05-01T23:59:59Z", "eq", "2024-05-01", value_type="date")
        assert matches("2024-05-02", "gt", "2024-05-01")
        assert not matches("2024-05-01T10:00:00", "gt", "2024-05-01")
        assert not matches("2024-5-1", "eq", "2024-05-01", value_type="date")
        assert not matches("n/a", "lt", "2024-05-01")

    def test_dates_at_second_grain(self):
        assert matches("2024-05-01 10:00:00", "eq", "2024-05-01T10:00:00",
                       value_type="date")
        assert matches("2024-05-01T10:00", "eq", "2024-05-01T10:00:00",
                       value_type="date")
        assert matches("2024-05-01", "lt", "2024-05-01T00:00:01", value_type="date")

    def test_within_last(self):
        assert matches("2024-05-19", "withinLast", "P7D")
        assert matches("2024-05-20T11:30:00Z", "withinLast", "PT1H")
        assert not matches("2024-05-20T10:30:00Z", "withinLast", "PT1H")
        assert not matches("2024-06-01", "withinLast", "P30D")   # the future


class TestListsAndAbsence:
    def test_a_list_matches_when_an_element_does(self):
        assert matches(["a", "B"], "eq", "b")
        assert matches(["15", 20], "gt", 19)
        assert matches(["x", ["nested"]], "contains", "x")
        assert not matches([], "eq", "a")

    def test_negatives_mean_no_element(self):
        assert not matches(["a", "b"], "neq", "a")
        assert matches(["a", "b"], "notIn", ["c"])
        assert not matches(["a", "b"], "notContains", "b")

    def test_contains_all(self):
        assert matches(["a", "B", "c"], "containsAll", ["b", "a"])
        assert not matches(["a"], "containsAll", ["a", "b"])
        assert matches([1, 2], "containsAll", [2.0])
        assert matches("x", "containsAll", ["X"])

    def test_missing_keys_and_negation(self):
        assert not matches(None, "neq", "a")
        assert matches(None, "neq", "a", include_missing=True)
        assert matches("b", "neq", "a", include_missing=True)
        assert not matches(None, "notIn", ["a"])
        assert matches(None, "notContains", "a", include_missing=True)

    @pytest.mark.parametrize("stored,is_set,is_empty", [
        (None, False, True), ("", True, True), ("  ", True, True),
        ("\t", True, False), ([], True, True), ([""], True, False),
        (0, True, False), (False, True, False), ("x", True, False),
    ])
    def test_presence(self, stored, is_set, is_empty):
        assert matches(stored, "isSet") is is_set
        assert matches(stored, "isNotSet") is (not is_set)
        assert matches(stored, "isEmpty") is is_empty
        assert matches(stored, "isNotEmpty") is (not is_empty)


def test_fold_case_is_per_character():
    assert fold_case("ΑΣ") == "ασ"
    assert fold_case("İ") == "i"
    assert fold_case("ÉCOLE") == "école"
    assert fold_case("MiXeD") == "mixed"


def test_committed_artifacts_are_current():
    """The frontend generates its types and operator metadata from these
    files — a model or table change without a re-export would ship a
    browser that disagrees with the server."""
    from pathlib import Path

    from backend.scripts.export_search_schema import (
        build_schema,
        canonical_json,
        operator_table_text,
    )

    schema_dir = Path(__file__).resolve().parents[1] / "common" / "schema"
    hint = "run: python -m backend.scripts.export_search_schema"
    assert (schema_dir / "searchoperators.v1.json").read_text(
        encoding="utf-8") == operator_table_text(), hint
    assert (schema_dir / "searchquery.v1.min.json").read_text(
        encoding="utf-8") == canonical_json(build_schema()), hint
