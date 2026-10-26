"""Connections: edges as a search's results.

"Every edge from a string column called bob to anything whose parent's
family is smith": a Connections search (``kind: edges``) returns the
edges whose source meets ``sourceWhere`` (From) and whose target meets
``targetWhere`` (To). Here: the model's rules, the service's — what it
refuses, the result shape it fills in, and how each walker of the
predicate tree reaches into both ends.
"""
from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from backend.app.services.advanced_search_service import (
    ValidationError,
    _count_and_validate,
    _empty_page,
    _has_layer,
    _is_unbounded_text_any,
    _path_refs,
    _validate_items,
    _validate_predicate,
    _with_resolved_refs,
    _with_result_shape,
    follows_relationships,
)
from backend.app.services.view_library import LibraryError, _check_predicate
from backend.common.models.search import Predicate, SearchQuery, SearchRuleItem

P = TypeAdapter(Predicate).validate_python
DATASET = {"kind": "entityType", "values": ["dataset"]}
STRING = {"kind": "property", "key": "dataType", "op": "eq", "value": "string"}
SMITH_PARENT = {"kind": "related", "axis": "parent", "where": {
    "kind": "property", "key": "family", "op": "eq", "value": "smith"}}
BOB = {"kind": "text", "value": "bob"}


def edges(**raw):
    return {"kind": "edges", **raw}


def query(predicate, **options):
    return SearchQuery.model_validate({"predicate": predicate, "options": options,
                                       "scope": {"viewId": "v", "scopeMode": "view"}})


class TestModel:
    def test_defaults(self):
        p = P(edges())
        assert (p.source_where, p.target_where, p.direction, p.edge_class, p.edge_types,
                p.edge_predicate) == (None, None, "outgoing", None, None, None)

    @pytest.mark.parametrize("raw, why", [
        (edges(edgeTypes=["FEEDS"], edgeClass="lineage"), "edge types or an edge class, not both"),
        (edges(edgeTypes=["AGGREGATED"]), "AGGREGATED edges are rollups of other edges"),
        (edges(edgeTypes=[]), "at least 1 item"),
        (edges(direction="incoming"), "'outgoing' or 'either'"),
    ])
    def test_refused(self, raw, why):
        with pytest.raises(PydanticValidationError, match=why):
            P(raw)

    def test_round_trips(self):
        raw = edges(sourceWhere=STRING, targetWhere=SMITH_PARENT, direction="either",
                    edgeTypes=["DERIVES"], edgePredicate={
                        "kind": "edgeProperty", "key": "mode", "op": "eq", "value": "batch"})
        dumped = P(raw).model_dump(by_alias=True, exclude_none=True)
        assert P(dumped) == P(raw)
        assert dumped["sourceWhere"]["key"] == "dataType"
        assert dumped["targetWhere"]["axis"] == "parent"


class TestValidation:
    def test_both_ends_count_toward_the_leaves(self):
        assert _validate_predicate(P(edges(sourceWhere=STRING, targetWhere=SMITH_PARENT))) == 4
        assert _validate_predicate(P(edges())) == 1

    @pytest.mark.parametrize("raw", [
        {"kind": "group", "op": "and", "children": [edges()]},
        {"kind": "group", "op": "not", "children": [edges()]},
        {"kind": "related", "axis": "parent", "where": edges()},
        {"kind": "path", "sourceUrns": ["a"], "targetWhere": edges()},
        edges(sourceWhere=edges()),
    ])
    def test_it_is_the_whole_query(self, raw):
        with pytest.raises(ValidationError, match="must be the whole query"):
            _validate_predicate(P(raw))

    def test_a_display_rule_cannot_be_one(self):
        item = SearchRuleItem.model_validate({"id": "r", "predicate": edges()})
        with pytest.raises(ValidationError, match="A display rule tags entities"):
            _validate_items([item])
        # Counted as a search's own condition, it may.
        _validate_items([item], rule=False)

    def test_inside_a_container_may_be_an_end(self):
        assert _validate_predicate(P(edges(
            sourceWhere={"kind": "descendantOf", "urns": ["u"]},
            targetWhere={"kind": "group", "op": "and", "children": [
                {"kind": "descendantOf", "urns": ["w"]}, DATASET]}))) == 4

    @pytest.mark.parametrize("end", [
        {"kind": "withinHops", "urns": ["u"], "hops": 2},
        {"kind": "path", "sourceUrns": ["a"], "targetUrns": ["b"]},
        {"kind": "group", "op": "or", "children": [
            DATASET, {"kind": "withinHops", "urns": ["u"], "hops": 2}]},
    ])
    def test_an_end_follows_no_route(self, end):
        with pytest.raises(ValidationError, match="can't sit in a Connections search's From"):
            _validate_predicate(P(edges(targetWhere=end)))

    def test_an_ends_relationship_follows_lineage_a_few_hops(self):
        assert _validate_predicate(P(edges(sourceWhere={
            "kind": "related", "axis": "downstream", "maxHops": 3}))) == 2
        with pytest.raises(ValidationError, match="From or To, a relationship follows at most 3"):
            _validate_predicate(P(edges(sourceWhere={
                "kind": "related", "axis": "downstream", "maxHops": 5,
                "where": {"kind": "is", "refs": [{"urn": "x"}]}})))

    def test_the_edge_filter_is_checked(self):
        with pytest.raises(ValidationError, match=r"\$.edgePredicate \(mode\).*not 'gt'"):
            _validate_predicate(P(edges(edgePredicate={
                "kind": "edgeProperty", "key": "mode", "op": "gt", "value": 3})))

    def test_an_ends_comparisons_are_resolved(self):
        with pytest.raises(ValidationError, match=r"\$.sourceWhere \(size\)"):
            _validate_predicate(P(edges(sourceWhere={
                "kind": "property", "key": "size", "op": "gt", "value": "abc",
                "valueType": "number"})))


class TestResultShape:
    def test_results_is_filled_in(self):
        assert _with_result_shape(query(edges())).options.results == "edges"
        assert _with_result_shape(query(edges(), results="edges")).options.results == "edges"
        assert _with_result_shape(query(edges(), sort="relevance")).options.results == "edges"

    @pytest.mark.parametrize("options, why", [
        ({"results": "hits"}, "returns edges, not hits"),
        ({"results": "both"}, "returns edges, not both"),
        ({"aggregations": [{"kind": "ancestor", "level": 1}]}, "has no facets"),
        ({"sort": "displayName"}, "ordered by source name, target name and edge type"),
        ({"sortProperty": "size"}, "ordered by source name"),
    ])
    def test_what_a_page_of_edges_cannot_carry(self, options, why):
        with pytest.raises(ValidationError, match=why):
            _with_result_shape(query(edges(), **options))

    def test_edges_are_for_a_connections_search(self):
        with pytest.raises(ValidationError, match="is for a Connections search"):
            _with_result_shape(query(DATASET, results="edges"))
        assert _with_result_shape(query(DATASET)).options.results == "aggregates"

    def test_the_empty_page_is_one_of_edges(self):
        page = _empty_page(_with_result_shape(query(edges())))
        assert (page.edges, page.edge_type_counts, page.hits, page.aggregates) == ([], {}, None, None)

    def test_a_wrapped_one_is_refused_before_it_runs(self):
        with pytest.raises(ValidationError, match="send it as the predicate itself"):
            _count_and_validate(_with_result_shape(query(
                {"kind": "group", "op": "and", "children": [edges()]})))


class TestWalkers:
    def test_unbounded_text_needs_every_end_unbounded(self):
        assert _is_unbounded_text_any(P(edges(sourceWhere=BOB)))
        assert _is_unbounded_text_any(P(edges(sourceWhere=BOB, targetWhere=BOB)))
        assert not _is_unbounded_text_any(P(edges(sourceWhere=BOB, targetWhere=DATASET)))
        assert not _is_unbounded_text_any(P(edges()))

    def test_a_share_link_refuses_it(self):
        assert follows_relationships(P(edges(sourceWhere=DATASET)))

    def test_a_layer_in_either_end(self):
        assert _has_layer(P(edges(targetWhere={"kind": "layer", "layerAssignment": "Sales"})))
        assert not _has_layer(P(edges(sourceWhere=DATASET)))

    def test_names_in_both_ends_are_found_and_resolved(self):
        p = P(edges(sourceWhere={"kind": "is", "refs": [{"path": ["Finance", "orders"]}]},
                    targetWhere={"kind": "group", "op": "and", "children": [
                        {"kind": "descendantOf", "refs": [{"path": ["Sales"]}]}]}))
        found = _path_refs(p)
        assert [at for at, _ in found] == ["$.sourceWhere.refs[0]",
                                           "$.targetWhere.children[0].refs[0]"]
        resolved = _with_resolved_refs(p, {id(found[0][1]): ["urn:orders"],
                                           id(found[1][1]): []})
        assert [r.urn for r in resolved.source_where.refs] == ["urn:orders"]
        # A name that names nothing is a condition no entity meets.
        assert resolved.target_where.children[0].kind == "group"
        assert resolved.target_where.children[0].op == "not"


class TestLibrary:
    def test_saved_as_a_search_not_as_a_rule(self):
        raw = edges(sourceWhere=STRING, targetWhere=SMITH_PARENT)
        assert _check_predicate(raw, rule=False).kind == "edges"
        with pytest.raises(LibraryError, match="A display rule tags entities"):
            _check_predicate(raw, rule=True)
