"""A user's edge properties: kept in the edge's JSON, and searched there.

An edge keeps the platform's own fields natively and a user's properties as
one JSON text (ADR-026), so an edge filter on a user's key used to compile
to a column no edge has, and matched nothing. Here: how a condition reads
such a key (``backend.common.edge_properties`` — the reference semantics,
which ``tests/integration/test_search_relations_live.py`` holds the Cypher
to), what it may ask of one, and what discovery and path results show of
them.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_deep_search import (
    _discover_edge_metadata,
    _edge_properties,
)
from backend.app.services.advanced_search_service import ValidationError, _validate_predicate
from backend.common.edge_properties import json_holds, value_texts
from backend.common.models.search import WithinHopsPredicate
from backend.common.search_semantics import resolve_comparison


def cmp(op, value=None, **kw):
    return resolve_comparison(op, value, **kw)


class TestReading:
    PROPS = {"mode": "Stream", "rows": 5.0, "ok": True, "n": 1,
             "note": '"mode": "batch"', "nested": {"job": "j1"}}

    def test_presence_is_of_a_top_level_key(self):
        assert json_holds(self.PROPS, "mode", cmp("isSet"))
        assert not json_holds(self.PROPS, "job", cmp("isSet"))
        assert json_holds(self.PROPS, "job", cmp("isNotSet"))
        assert json_holds(None, "mode", cmp("isNotSet"))

    def test_equality_by_the_values_json(self):
        assert json_holds(self.PROPS, "mode", cmp("eq", "stream"))          # case ignored
        assert not json_holds(self.PROPS, "mode", cmp("eq", "stream", case_sensitive=True))
        assert json_holds(self.PROPS, "rows", cmp("eq", 5, value_type="number"))
        assert json_holds(self.PROPS, "ok", cmp("eq", True, value_type="boolean"))
        # true is not 1, nor "1" one.
        assert not json_holds(self.PROPS, "n", cmp("eq", True, value_type="boolean"))
        assert not json_holds(self.PROPS, "n", cmp("eq", "1", value_type="string"))
        assert json_holds(self.PROPS, "mode", cmp("in", ["batch", "STREAM"]))

    def test_is_not_passes_a_missing_key_only_when_asked(self):
        assert json_holds(self.PROPS, "mode", cmp("neq", "batch"))
        assert not json_holds(self.PROPS, "job", cmp("neq", "x"))
        assert json_holds(self.PROPS, "job", cmp("neq", "x", include_missing=True))
        assert not json_holds(self.PROPS, "mode", cmp("notIn", ["stream"]))

    def test_a_whole_number_is_written_both_ways(self):
        assert value_texts(cmp("eq", 5, value_type="number")) == ["5", "5.0"]
        assert value_texts(cmp("eq", 0.5, value_type="number")) == ["0.5"]
        assert value_texts(cmp("eq", "x")) == ['"x"']


class TestValidation:
    @staticmethod
    def hops(edge):
        return WithinHopsPredicate.model_validate({"urns": ["u"], "hops": 2,
                                                   "edgePredicate": edge})

    @pytest.mark.parametrize("op, value", [("eq", "x"), ("neq", "x"), ("in", ["x"]),
                                           ("notIn", ["x"]), ("isSet", None),
                                           ("isNotSet", None)])
    def test_presence_and_equality_on_a_users_key(self, op, value):
        _validate_predicate(self.hops({"kind": "edgeProperty", "key": "mode", "op": op,
                                       "value": value}))

    @pytest.mark.parametrize("op, value", [("gt", 1), ("contains", "x"), ("startsWith", "x"),
                                           ("between", [1, 2])])
    def test_other_operators_are_refused_with_why(self, op, value):
        with pytest.raises(ValidationError, match=r"\(mode\): an edge keeps its own properties "
                                                  r"as JSON text.*is set, is, is not or is one of"):
            _validate_predicate(self.hops({"kind": "edgeProperty", "key": "mode", "op": op,
                                           "value": value}))

    def test_a_native_field_takes_every_operator(self):
        _validate_predicate(self.hops({"kind": "edgeProperty", "key": "confidence",
                                       "op": "between", "value": [0.5, 1]}))


class TestWhatReadersSee:
    def test_discovery_finds_a_users_keys_in_the_json(self):
        edges = [
            ("FLOWS_TO", {"id": "e1", "confidence": 0.9,
                          "properties": json.dumps({"mode": "stream", "rows": 5})}),
            ("FLOWS_TO", {"id": "e2", "properties": json.dumps({"mode": "batch"})}),
            ("AGGREGATED", {"weight": 3}),
        ]

        class _Provider:
            async def _ro_query(self, cypher, *, params=None, timeout=None):
                return SimpleNamespace(result_set=[
                    [t, SimpleNamespace(properties=p)] for t, p in edges])

        out = asyncio.run(_discover_edge_metadata(_Provider()))
        flows = out["FLOWS_TO"]
        assert flows["keys"] == ["confidence", "id", "mode", "rows"]
        assert flows["storedAs"] == {"confidence": "native", "id": "native",
                                     "mode": "json", "rows": "json"}
        assert flows["valueSamplesByKey"]["mode"] == ["batch", "stream"]
        assert out["AGGREGATED"]["storedAs"] == {"weight": "native"}

    def test_a_paths_edges_show_a_users_properties(self):
        assert _edge_properties({"id": "e1", "confidence": 0.9,
                                 "properties": '{"mode": "stream"}'}) == {
            "mode": "stream", "id": "e1", "confidence": 0.9}
        assert _edge_properties({"properties": "not json"}) == {}
        assert _edge_properties(None) == {}
