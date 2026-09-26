"""Property values kept in ``propertiesRaw``, searched exactly.

The pure parts: the probe that finds the nodes whose raw JSON may hold a key,
the reference evaluation of what it read, how the compiler wraps a property
condition so both answers compose in any boolean context, the per-graph
"keeps anything raw?" check, and the engine asking a unit's raw values before
its statements run. ``tests/integration/test_raw_properties_live.py`` checks
the whole on FalkorDB.
"""
import json

import pytest
from pydantic import TypeAdapter

from backend.app.providers.falkordb_deep_search import _Compiler
from backend.app.providers.falkordb_search import raw_properties
from backend.app.providers.falkordb_search.raw_properties import (
    RawLeaf,
    answered,
    evaluate_rows,
    graph_raw_labels,
    probe_condition,
)
from backend.common.models.search import Predicate
from backend.common.search_semantics import resolve_predicate

_PRED = TypeAdapter(Predicate)


def _leaf(key="owner", *, key_match="exact", i=0, native="true", **cmp):
    comparison = resolve_predicate(_PRED.validate_python({"kind": "property", "key": key, **cmp})) \
        if cmp else None
    return RawLeaf(key=key, cmp=comparison, key_match=key_match,
                   raw_ids=f"r{i}", true_ids=f"t{i}", native=native)


def _row(node_id, raw):
    return [node_id, json.dumps(raw)]


class TestProbe:
    def test_an_exact_key_is_found_as_json_writes_it(self):
        cond, params = probe_condition([_leaf("owner", op="eq", value="x")])
        assert cond == "(n.propertiesRaw CONTAINS $_rawf0)"
        assert params == {"_rawf0": '"owner":'}

    def test_a_key_matched_by_name_is_found_folded(self):
        cond, params = probe_condition([
            _leaf("Legacy", key_match="prefix"), _leaf("REF", key_match="contains", i=1)])
        assert cond == ("(toLower(n.propertiesRaw) CONTAINS $_rawl0 "
                        "OR toLower(n.propertiesRaw) CONTAINS $_rawl1)")
        assert params == {"_rawl0": '"legacy', "_rawl1": "ref"}

    def test_a_non_ascii_key_is_found_escaped_or_not(self):
        _, params = probe_condition([_leaf("ówner", op="isSet")])
        assert set(params.values()) == {'"\\u00f3wner":', '"ówner":'}

    def test_a_non_ascii_name_to_match_reads_every_raw_node(self):
        cond, params = probe_condition([_leaf("ówn", key_match="prefix")])
        assert cond == "n.propertiesRaw IS NOT NULL AND n.propertiesRaw <> '{}'"
        assert params == {}

    def test_the_same_key_twice_is_probed_once(self):
        _, params = probe_condition([_leaf(op="isSet"), _leaf(op="eq", value="x", i=1)])
        assert params == {"_rawf0": '"owner":'}


class TestEvaluation:
    def test_a_value_is_compared_as_the_native_one_would_be(self):
        leaf = _leaf(op="contains", value="FIN")
        rows = [_row(1, {"owner": "Finance"}), _row(2, {"owner": "risk"}), _row(3, {"other": 1})]
        assert evaluate_rows(rows, [leaf]) == {"r0": [1, 2], "t0": [1]}

    def test_an_int64_compares_exactly(self):
        leaf = _leaf("size", op="eq", value=str(2 ** 63 - 1), valueType="number")
        rows = [_row(1, {"size": 2 ** 63 - 1}), _row(2, {"size": 2 ** 63 - 2})]
        assert evaluate_rows(rows, [leaf])["t0"] == [1]

    def test_a_nested_value_compares_as_its_json_text(self):
        leaf = _leaf(op="contains", value="finance")
        rows = [_row(1, {"owner": {"team": "finance", "since": 2020}}),
                _row(2, {"owner": [{"team": "risk"}]})]
        assert evaluate_rows(rows, [leaf]) == {"r0": [1, 2], "t0": [1]}

    def test_a_negative_condition_holds_for_a_raw_value_that_does_not_match(self):
        leaf = _leaf(op="notContains", value="data")
        rows = [_row(1, {"owner": "data-core"}), _row(2, {"owner": "finance"})]
        assert evaluate_rows(rows, [leaf]) == {"r0": [1, 2], "t0": [2]}

    def test_presence_by_exact_name_prefix_or_contained_text(self):
        rows = [_row(1, {"legacy_ref": "a"}), _row(2, {"LegacyId": 3}), _row(3, {"other": 1})]
        leaves = [_leaf("legacy_ref"), _leaf("legacy", key_match="prefix", i=1),
                  _leaf("acyi", key_match="contains", i=2)]
        assert evaluate_rows(rows, leaves) == {
            "r0": [], "t0": [1], "r1": [], "t1": [1, 2], "r2": [], "t2": [2]}

    def test_empty_or_malformed_raw_text_answers_nothing(self):
        rows = [[1, "{}"], [2, "not json"], [3, "[1, 2]"], [4, None]]
        assert evaluate_rows(rows, [_leaf(op="isSet")]) == {"r0": [], "t0": []}


class TestUnwrap:
    def test_a_condition_no_node_keeps_raw_here_is_the_native_one(self):
        value = _leaf(op="eq", value="x", native="n.owner = $p0")
        presence = _leaf("legacy_ref", i=1, native="EXISTS(n.`legacy_ref`)")
        where = f"{value.wrapped} AND NOT ({presence.wrapped})"
        assert answered(where, [value, presence], {"r0": [], "t0": [], "r1": [], "t1": []}) \
            == "n.owner = $p0 AND NOT (EXISTS(n.`legacy_ref`))"

    def test_a_condition_some_node_keeps_raw_here_stays_wrapped(self):
        value = _leaf(op="notContains", value="x", native="NOT n.owner CONTAINS $p0")
        # A raw value that fails the condition still decides the node.
        lists = {"r0": [7], "t0": []}
        assert answered(value.wrapped, [value], lists) == value.wrapped


class TestCompiler:
    def _compile(self, predicate):
        compiler = _Compiler(lineage_edge_types=set(), containment_edge_types={"CONTAINS"})
        compiler.raw_leaves = []
        return compiler.compile(_PRED.validate_python(predicate)), compiler

    def test_a_value_condition_is_answered_by_the_raw_lists_where_they_hold(self):
        where, compiler = self._compile({"kind": "property", "key": "owner", "op": "eq",
                                         "value": "finance", "valueType": "string"})
        [leaf] = compiler.raw_leaves
        assert where.startswith(f"((ID(n) IN ${leaf.raw_ids} AND ID(n) IN ${leaf.true_ids}) "
                                f"OR (NOT ID(n) IN ${leaf.raw_ids} AND ")
        assert compiler.params[leaf.raw_ids] == [] and compiler.params[leaf.true_ids] == []

    def test_presence_is_either_place_and_negation_wraps_the_whole(self):
        where, compiler = self._compile({"kind": "hasProperty", "key": "legacy_ref",
                                         "negate": True})
        [leaf] = compiler.raw_leaves
        assert where == f"NOT ((EXISTS(n.`legacy_ref`) OR ID(n) IN ${leaf.true_ids}))"

    def test_a_text_match_on_a_property_is_a_raw_leaf_too(self):
        _, compiler = self._compile({"kind": "text", "target": "property",
                                     "propertyKey": "owner", "value": "fin"})
        assert [leaf.key for leaf in compiler.raw_leaves] == ["owner"]

    def test_without_raw_values_nothing_is_wrapped(self):
        compiler = _Compiler(lineage_edge_types=set(), containment_edge_types={"CONTAINS"})
        where = compiler.compile(_PRED.validate_python(
            {"kind": "property", "key": "owner", "op": "isSet"}))
        assert "ID(n)" not in where and compiler.raw_leaves is None


class _Result:
    def __init__(self, rows):
        self.result_set = rows


class TestRawLabels:
    @pytest.fixture(autouse=True)
    def _fresh(self, monkeypatch):
        monkeypatch.setattr(raw_properties, "_RAW_LABELS", {})

    async def test_read_once_per_graph_and_data_version(self):
        provider = type("P", (), {"_graph_name": "g"})()
        asked = []

        async def run(cypher, params):
            asked.append(cypher)
            return _Result([["Dataset"], ["Legacy"]])

        assert await graph_raw_labels(provider, run, "7.a") == {"Dataset", "Legacy"}
        assert await graph_raw_labels(provider, run, "7.a") == {"Dataset", "Legacy"}
        assert len(asked) == 1
        await graph_raw_labels(provider, run, "8.a")
        assert len(asked) == 2

    async def test_read_every_time_without_a_data_version(self):
        provider = type("P", (), {"_graph_name": "g"})()
        asked = []

        async def run(cypher, params):
            asked.append(cypher)
            return _Result([])

        assert await graph_raw_labels(provider, run, "") == frozenset()
        assert await graph_raw_labels(provider, run, "") == frozenset()
        assert len(asked) == 2


async def test_a_unit_asks_for_its_raw_values_before_its_statements():
    from backend.app.providers.falkordb_search.engine import _run_unit
    from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
    from backend.app.providers.falkordb_search.plan import Context, Unit

    leaf = _leaf(op="eq", value="finance", native="n.owner = 'finance'")
    other = _leaf("size", op="isSet", i=1, native="n.size IS NOT NULL")
    ctx = Context(where=f"{leaf.wrapped} AND {other.wrapped}",
                  params={leaf.raw_ids: [], leaf.true_ids: [],
                          other.raw_ids: [], other.true_ids: []},
                  sort=SortSpec((SortKey("n.urn"),)), containment=("CONTAINS",), max_depth=12,
                  raw_leaves=(leaf, other), raw_labels=frozenset({"Dataset"}))
    unit = Unit(kind="range", label="Dataset", lo=0, hi=100, size=100)
    session = type("S", (), {"k": 0, "clamps": [], "clamp_depths": [], "after": None})()
    seen = []

    async def run(cypher, params, timeout_s):
        seen.append((cypher, params))
        if "RETURN ID(n), n.propertiesRaw" in cypher:
            return _Result([[5, json.dumps({"owner": "finance"})],
                            [6, json.dumps({"owner": "risk"})]])
        return _Result([[1]])

    count, rows, _ = await _run_unit(unit, session, ctx, run, 1.0)
    assert count == 1 and rows == []
    probe, counted = seen
    assert "n.propertiesRaw CONTAINS $_rawf0" in probe[0] and "ID(n) >= $_lo" in probe[0]
    assert "n.owner = 'finance'" not in probe[0]          # the unit's nodes, not the predicate
    assert counted[1][leaf.raw_ids] == [5, 6] and counted[1][leaf.true_ids] == [5]
    # ``size`` is kept raw by no node of the unit: its condition runs native.
    assert leaf.wrapped in counted[0] and other.wrapped not in counted[0]
    assert "n.size IS NOT NULL" in counted[0]


async def test_a_unit_of_a_label_keeping_nothing_raw_is_not_probed():
    from backend.app.providers.falkordb_search.engine import _run_unit
    from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
    from backend.app.providers.falkordb_search.plan import Context, Unit

    leaf = _leaf(op="eq", value="finance", native="n.owner = 'finance'")
    ctx = Context(where=leaf.wrapped, params={leaf.raw_ids: [], leaf.true_ids: []},
                  sort=SortSpec((SortKey("n.urn"),)), containment=("CONTAINS",), max_depth=12,
                  raw_leaves=(leaf,), raw_labels=frozenset({"Legacy"}))
    session = type("S", (), {"k": 0, "clamps": [], "clamp_depths": [], "after": None})()
    seen = []

    async def run(cypher, params, timeout_s):
        seen.append(cypher)
        return _Result([[3]])

    count, _, _ = await _run_unit(Unit(kind="range", label="Dataset", lo=0, hi=100),
                                  session, ctx, run, 1.0)
    assert count == 3
    [statement] = seen
    assert "propertiesRaw" not in statement and "n.owner = 'finance'" in statement
