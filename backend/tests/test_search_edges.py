"""Connections: edges as a search's results.

"Every edge from a string column called bob to anything whose parent's
family is smith": a Connections search (``kind: edges``) returns the
edges whose source meets ``sourceWhere`` (From) and whose target meets
``targetWhere`` (To). Here: the model's rules, the service's — what it
refuses, the result shape it fills in, and how each walker of the
predicate tree reaches into both ends.
"""
from __future__ import annotations

import dataclasses
import json
import re
from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from backend.app.providers.falkordb_search import edges as edges_mod
from backend.app.providers.falkordb_search import engine as engine_mod
from backend.app.providers.falkordb_search.plan import Plan, Unit

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
from backend.app.services.deep_search import CompileError, SearchRunContext, get_deep_search_settings
from backend.app.services.view_library import LibraryError, _check_predicate
from backend.common.models.graph import GraphNode
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


# ---------------------------------------------------------------------------
# The compiler
# ---------------------------------------------------------------------------

def _compiler():
    from backend.app.providers.falkordb_deep_search import _Compiler
    return _Compiler(lineage_edge_types={"FEEDS", "DERIVES", "AGGREGATED"},
                     containment_edge_types={"CONTAINS"})


class TestCompiler:
    def test_the_edge_types(self):
        c = _compiler()
        # Every link: all but containment — and never a rollup.
        assert c.connection_edge_types(P(edges())) == ["DERIVES", "FEEDS"]
        assert c.connection_edge_types(P(edges(edgeClass="lineage"))) == ["DERIVES", "FEEDS"]
        assert c.connection_edge_types(P(edges(edgeClass="containment"))) == ["CONTAINS"]
        assert c.connection_edge_types(P(edges(edgeClass="any"))) == ["CONTAINS", "DERIVES", "FEEDS"]
        # Named, containment too.
        assert c.connection_edge_types(P(edges(edgeTypes=["FEEDS", "CONTAINS"]))) == [
            "CONTAINS", "FEEDS"]

    def test_the_far_end_is_a_where_and_stages(self):
        c = _compiler()
        head, stages = c.compile_far_end(P({"kind": "group", "op": "and", "children": [
            SMITH_PARENT, STRING, {"kind": "descendantOf", "urns": ["u"], "maxDepth": 2}]}),
            "m", 12)
        assert "m.`dataType`" in head and "n." not in head
        inside, related = stages
        assert re.fullmatch(r"\(m\.urn IN \$p\d+ OR ANY\(_xb\d+ IN \[\(m\)<-\[:CONTAINS\*1\.\.2\]"
                            r"-\(_xr\d+\) WHERE _xr\d+\.urn IN \$p\d+ \| true\] WHERE _xb\d+\)\)",
                            inside), inside
        assert related.startswith("ANY(_xb") and "(m)<-[:CONTAINS]-(_xr" in related
        # Every comprehension its own name (S0 §15).
        names = re.findall(r"_x[a-z]\d+", inside + related)
        assert len(set(n for n in names if n.startswith("_xr"))) == 2

    def test_inside_without_a_depth_reaches_the_scopes(self):
        _, [inside] = _compiler().compile_far_end(P({"kind": "descendantOf", "urns": ["u"]}),
                                                  "m", 7)
        assert "*1..7]" in inside

    def test_inside_a_container_sits_in_an_ends_top_level_and(self):
        with pytest.raises(CompileError, match="top-level AND"):
            _compiler().compile_far_end(P({"kind": "group", "op": "or", "children": [
                {"kind": "descendantOf", "urns": ["u"]}, DATASET]}), "m", 12)

    def test_a_far_end_hoists_nothing(self):
        with pytest.raises(CompileError, match="withinHops can't sit"):
            _compiler().compile_far_end(P({"kind": "withinHops", "urns": ["u"], "hops": 2}),
                                        "m", 12)

    def test_a_condition_on_either_end_is_one_projection(self):
        c = _compiler()
        cond = c.condition(P({"kind": "group", "op": "and", "children": [STRING, SMITH_PARENT]}),
                           "n", 12)
        assert cond.startswith("(") and " AND " in cond and "(n)<-[:CONTAINS]-" in cond
        assert c.condition(None, "n", 12) == "true"

    def test_the_whole_search_is_never_compiled_as_a_condition(self):
        with pytest.raises(CompileError, match="only the uncapped search engine"):
            _compiler().compile(P(edges()))


# ---------------------------------------------------------------------------
# The statements
# ---------------------------------------------------------------------------

def _fake_provider(**extra):
    return SimpleNamespace(
        _get_lineage_edge_types=lambda: ["DERIVES", "FEEDS"],
        _get_containment_edge_types=lambda: ["CONTAINS"],
        _name_property=None, _entity_type_levels={}, **extra)


def _edge_query(raw, scope=None, **options):
    return SearchQuery.model_validate({
        "predicate": {"kind": "edges", **raw}, "options": {"results": "edges", **options},
        "scope": scope or {"viewId": "v", "scopeMode": "data_source"}})


def _ectx(raw, *, anchor="source", scope=None, state=None):
    query = _edge_query(raw, scope)
    return edges_mod.edge_context(_fake_provider(), query, {
        "anchor": anchor, "far_labels": ["column", "dataset"], "far_roots": None,
        **(state or {})})


UNIT = Unit("range", "column", 0, 100, size=10, espan=1000)


class TestStatements:
    def test_from_the_source_as_stored(self):
        ectx = _ectx({"sourceWhere": STRING, "targetWhere": SMITH_PARENT,
                      "edgeTypes": ["DERIVES"]})
        cypher, params = edges_mod.unit_statement(UNIT, ectx, [], 50)
        assert "MATCH (n:`column`) WHERE ID(n) >= $_lo AND ID(n) < $_hi" in cypher
        assert ("WITH n MATCH (n)-[e:DERIVES]->(m) WHERE m.urn IS NOT NULL AND "
                "(ANY(_xl") in cypher
        # The far end's relationship is a stage after the edge, carrying all three.
        assert "WITH n, e, m, ANY(_xb" in cypher and " AS _xf0 WHERE _xf0 WITH n, e, m " in cypher
        assert cypher.endswith(
            "WITH type(e) AS _t, count(*) AS _c, collect([_k0, _k1, _k2, _k3, _k4, _k5, "
            "ID(n), ID(m)]) AS _rows RETURN _t, _c, _rows[..$_k]")
        assert "toUpper(type(e)) AS _k2, n.urn AS _k3, m.urn AS _k4, ID(e) AS _k5" in cypher
        assert params["_farLabels"] == ["column", "dataset"] and params["_k"] == 50

    def test_from_the_target_the_arrow_turns_and_rows_stay_source_first(self):
        ectx = _ectx({"sourceWhere": STRING, "targetWhere": DATASET}, anchor="target")
        cypher, _ = edges_mod.unit_statement(UNIT, ectx, [], 50)
        assert "MATCH (n)<-[e:DERIVES|FEEDS]-(m)" in cypher
        assert "m.urn AS _k3, n.urn AS _k4" in cypher and "ID(m), ID(n)]) AS _rows" in cypher
        assert "m.`dataType`" in cypher       # From, tested on the far end

    def test_either_way_the_second_pass_leaves_out_the_first_passes_edges(self):
        ectx = _ectx({"sourceWhere": STRING, "targetWhere": DATASET, "direction": "either"})
        first, _ = edges_mod.unit_statement(UNIT, ectx, [], 50)
        assert "MATCH (n)-[e:DERIVES|FEEDS]->(m)" in first and "_xa" not in first
        second, _ = edges_mod.unit_statement(dataclasses.replace(UNIT, reverse=True), ectx, [], 50)
        assert "WITH n, coalesce(toLower(labels(n)[0]) IN $p" in second
        assert "false) AS _xa MATCH (n)<-[e:DERIVES|FEEDS]-(m)" in second
        # NOT, written so its parse stays linear (``parse_cost.operand``).
        assert "WITH n, e, m, _xa, (coalesce(" in second
        assert "false) AND _xa) = false AS _xf0 WHERE _xf0" in second
        assert "WITH n, e, m, _xa, " in second
        assert "m.urn AS _k3, n.urn AS _k4" in second

    def test_a_band_of_edge_ids(self):
        ectx = _ectx({"sourceWhere": STRING})
        cypher, params = edges_mod.count_statement(
            dataclasses.replace(UNIT, elo=10, ehi=20), ectx, [])
        assert "ID(e) >= $_elo AND ID(e) < $_ehi" in cypher and (params["_elo"], params["_ehi"]) == (10, 20)
        assert cypher.endswith("RETURN type(e), count(*)")

    def test_the_edge_filter_reads_e(self):
        ectx = _ectx({"sourceWhere": STRING, "edgePredicate": {
            "kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}})
        cypher, _ = edges_mod.count_statement(UNIT, ectx, [])
        assert "toLower(coalesce(e.properties, '')) CONTAINS $p" in cypher

    def test_the_far_end_is_held_to_the_scope(self):
        visible = _ectx({"sourceWhere": STRING}, scope={
            "viewId": "v", "scopeMode": "visible", "visibleUrns": ["a", "b"]})
        cypher, params = edges_mod.count_statement(Unit("visible", "column"), visible, [])
        assert "AND (m.urn IN $_farUrns)" in cypher and params["_farUrns"] == ["a", "b"]
        rooted = _ectx({"sourceWhere": STRING}, state={"far_roots": [7, 9]}, scope={
            "viewId": "v", "scopeMode": "view", "rootUrns": ["r"], "maxDepth": 4})
        cypher, params = edges_mod.count_statement(UNIT, rooted, [])
        assert re.search(r"ANY\(_xs\d+ IN \[\(m\)<-\[:CONTAINS\*0\.\.4\]-\(_xq\d+\) \| ID\(_xq\d+\)\] "
                         r"WHERE _xs\d+ IN \$_farRoots\) = true AS _xf0", cypher)
        assert params["_farRoots"] == [7, 9]

    def test_a_later_page_filters_before_it_orders(self):
        ectx = _ectx({"sourceWhere": STRING})
        cypher, params = edges_mod.after_statement(UNIT, ectx, [], 50, ["a", "b", "T", "u1", "u2", 5])
        assert " WHERE (_k0 > $_a0 OR (_k0 = $_a0 AND " in cypher
        assert cypher.endswith("ORDER BY _k0, _k1, _k2, _k3, _k4, _k5 LIMIT $_k "
                               "RETURN _k0, _k1, _k2, _k3, _k4, _k5, _si, _ti")
        assert params["_a5"] == 5

    def test_the_anchor_end_is_an_entity_searches_own(self):
        ectx = _ectx({"sourceWhere": {"kind": "group", "op": "and", "children": [
            STRING, SMITH_PARENT]}, "targetWhere": DATASET})
        cypher, _ = edges_mod.unit_statement(UNIT, ectx, [], 50)
        head = cypher.split(" MATCH (n)-[e")[0]
        # The anchor's relationship is a tail stage of its own, on n alone.
        assert " AS _xt0 WHERE _xt0 WITH n" in head and "m." not in head


# ---------------------------------------------------------------------------
# Which end anchors
# ---------------------------------------------------------------------------

def _side(raw, stats=None):
    stats = stats or {"column": (180_000, 0), "dataset": (20_000, 0)}
    return edges_mod._anchor_side(_fake_provider(), _edge_query(raw), list(stats), stats)


COLUMN = {"kind": "entityType", "values": ["column"]}


class TestAnchorSide:
    def test_named_entities_anchor(self):
        assert _side({"sourceWhere": STRING,
                      "targetWhere": {"kind": "is", "refs": [{"urn": "x"}]}}) == "target"
        assert _side({"sourceWhere": {"kind": "descendantOf", "urns": ["x"]},
                      "targetWhere": STRING}) == "source"

    def test_a_plain_condition_over_a_relationship(self):
        assert _side({"sourceWhere": SMITH_PARENT, "targetWhere": STRING}) == "target"
        assert _side({"sourceWhere": STRING, "targetWhere": SMITH_PARENT}) == "source"

    def test_types_alone_over_a_relationship_alone(self):
        assert _side({"sourceWhere": {"kind": "group", "op": "and", "children": [
            COLUMN, SMITH_PARENT]}, "targetWhere": DATASET}) == "target"

    def test_the_fewer_entities_by_type(self):
        assert _side({"sourceWhere": COLUMN, "targetWhere": DATASET}) == "target"
        assert _side({"sourceWhere": DATASET, "targetWhere": COLUMN}) == "source"

    def test_an_end_left_out_or_free_text_anchors_last(self):
        assert _side({"targetWhere": COLUMN}) == "target"
        assert _side({"sourceWhere": BOB, "targetWhere": COLUMN}) == "target"
        assert _side({}) == "source"


# ---------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------

class TestUnits:
    def test_an_edge_unit_splits_in_quarters(self):
        parts = Unit("range", "column", 0, 100, size=100, espan=1000).split()
        assert [(p.lo, p.hi, p.elo, p.ehi, p.espan, p.size) for p in parts] == [
            (0, 50, None, 500, 0, 25), (0, 50, 500, None, 500, 25),
            (50, 100, None, 500, 0, 25), (50, 100, 500, None, 500, 25)]

    def test_a_hub_alone_is_cut_by_its_edges(self):
        hub = Unit("ids", roots=[220], size=1, reverse=True, espan=4)
        halves = hub.split()
        assert [(p.roots, p.elo, p.ehi, p.reverse) for p in halves] == [
            ([220], None, 2, True), ([220], 2, None, True)]
        assert Unit("ids", roots=[220], elo=3, ehi=4).split() is None

    def test_an_entity_unit_splits_as_ever(self):
        halves = Unit("range", "L", 0, 100, size=100).split()
        assert [(p.lo, p.hi, p.banded) for p in halves] == [(0, 50, False), (50, 100, False)]

    def test_a_unit_round_trips(self):
        unit = Unit("walk", roots=[1, 2], depth=3, reverse=True, elo=5, ehi=9)
        assert Unit.from_dict(json.loads(json.dumps(unit.to_dict()))) == unit


# ---------------------------------------------------------------------------
# Sessions, against a scripted scan
# ---------------------------------------------------------------------------

def _edge(src, tgt, eid, edge_type="FEEDS"):
    """A row as a unit returns it: the six keys, then the ends' node IDs."""
    return [src.lower(), tgt.lower(), edge_type.upper(), f"urn:{src}", f"urn:{tgt}", eid,
            100 + eid, 200 + eid]


class _EdgeScan:
    """Stands in for ``_plan`` and each unit's statement: a unit is a label
    whose edges are given, already in order."""

    def __init__(self, units, *, gone=(), pressure=False):
        self.units, self.gone, self.pressure = units, set(gone), pressure
        self.runs = []

    async def plan(self, provider, query, run, settings, deadline):
        return (Plan([Unit("range", label, size=len(rows), espan=8)
                      for label, rows in self.units.items()]),
                {"anchor": "source", "types": {}, "far_labels": ["L"], "far_roots": None})

    async def unit(self, work, unit, timeout_s):
        self.runs.append((unit.label, unit.elo, unit.ehi))
        band = (unit.ehi if unit.ehi is not None else (unit.elo or 0) + unit.espan) - (unit.elo or 0)
        if self.pressure and band > 4:      # too many edges to read in one statement
            raise RuntimeError("Query timed out")
        rows = [r for r in self.units[unit.label]
                if (unit.elo or 0) <= r[5] < (unit.ehi if unit.ehi is not None else 10 ** 9)]
        session = work.session
        if session.k == 0:
            return [("FEEDS", len(rows))] if rows else [], []
        if session.after is not None:
            return [], [r for r in rows if r[:6] > session.after[:6]][:session.k]
        return ([("FEEDS", len(rows))] if rows else []), rows[:session.k]


class _HydrationProvider:
    """Reads a page back as the graph would — every edge but the gone ones —
    and knows where each end sits."""

    def __init__(self, gone=()):
        self.gone = set(gone)
        self._name_property = None
        self._entity_type_levels = {}

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _get_lineage_edge_types(self):
        return ["FEEDS"]

    async def get_ancestor_chains(self, urns):
        return {u: ["urn:parent", "urn:root"] for u in urns}

    async def get_nodes_batch(self, urns):
        return [GraphNode(urn=u, entityType="container", displayName=u[4:]) for u in urns]

    async def _ro_query(self, cypher, params=None, *, timeout=None, op=None):
        assert cypher.startswith("UNWIND $_rows AS _r")
        rows = [[eid, su, su[4:], "column", tu, tu[4:], "dataset", "FEEDS",
                 {"properties": '{"mode": "batch"}', "id": f"e{eid}"}]
                for sid, tid, eid, su, tu in params["_rows"] if eid not in self.gone]
        return SimpleNamespace(result_set=rows)


@pytest.fixture
def edge_scan(monkeypatch):
    from backend.app.providers.falkordb_search import session as session_mod
    monkeypatch.setattr(session_mod, "_MEMORY", session_mod.MemorySessionStore())

    def install(units, **kw):
        s = _EdgeScan(units, **kw)
        monkeypatch.setattr(edges_mod, "_plan", s.plan)
        monkeypatch.setattr(edges_mod._EdgeWork, "unit",
                            lambda work, unit, timeout_s: s.unit(work, unit, timeout_s))
        monkeypatch.setattr(engine_mod, "_is_pressure", lambda exc: "timed out" in str(exc))
        return s
    return install


async def _edge_search(provider, *, cursor=None, page_size=5, data_version="1"):
    options = {"pageSize": page_size, **({"cursor": cursor} if cursor else {})}
    return await engine_mod.execute_session_search(
        provider, _edge_query({"sourceWhere": STRING}, **options),
        context=SearchRunContext(data_version=data_version, scope_hash="h"))


A_ROWS = [_edge(f"a{i}", "t", i) for i in range(4)]
B_ROWS = [_edge(f"b{i}", "t", 10 + i) for i in range(3)]


class TestEdgeSessions:
    async def test_every_edge_is_counted_and_the_page_is_the_global_first(self, edge_scan):
        edge_scan({"A": A_ROWS, "B": B_ROWS})
        page = await _edge_search(_HydrationProvider())
        assert page.status == "complete" and page.total_count == 7
        assert page.edge_type_counts == {"FEEDS": 7} and page.hits is None
        assert [e.source.urn for e in page.edges] == [
            "urn:a0", "urn:a1", "urn:a2", "urn:a3", "urn:b0"]
        first = page.edges[0]
        assert (first.key, first.id, first.edge_type, first.properties) == (
            "0", "e0", "FEEDS", {"mode": "batch", "id": "e0"})
        # Where each end sits: root first, its parent the nearest.
        assert [a.urn for a in first.target.ancestor_path] == ["urn:root", "urn:parent"]
        assert first.target.parent.urn == "urn:parent"
        assert (first.source.display_name, first.source.entity_type) == ("a0", "column")

    async def test_pages_follow_the_order_to_the_end(self, edge_scan, monkeypatch):
        """Past the rows a session keeps, a later page is a session of the
        rows after the last one — the totals still the first page's."""
        edge_scan({"A": A_ROWS * 1, "B": B_ROWS})
        monkeypatch.setattr(edges_mod, "SESSION_EDGES", 1)
        monkeypatch.setenv("DEEP_SEARCH_SESSION_ROWS", "50")
        get_deep_search_settings.cache_clear()
        rows = sorted(A_ROWS + B_ROWS)
        try:
            provider, seen, cursor, pages = _HydrationProvider(), [], None, []
            while True:
                page = await _edge_search(provider, cursor=cursor, page_size=1)
                seen += [e.key for e in page.edges]
                pages.append(page)
                cursor = page.cursor
                if not cursor:
                    break
        finally:
            get_deep_search_settings.cache_clear()
        assert seen == [str(r[5]) for r in rows]
        assert all(p.total_count == 7 and p.edge_type_counts == {"FEEDS": 7} for p in pages)

    async def test_an_edge_gone_since_the_scan_is_left_out(self, edge_scan):
        edge_scan({"A": A_ROWS})
        page = await _edge_search(_HydrationProvider(gone={1}))
        assert [e.key for e in page.edges] == ["0", "2", "3"] and page.total_count == 4

    async def test_a_unit_out_of_time_is_cut_by_its_edges_and_counted_once(self, edge_scan):
        s = edge_scan({"A": A_ROWS, "B": B_ROWS}, pressure=True)
        page = await _edge_search(_HydrationProvider())
        assert page.total_count == 7 and page.edge_type_counts == {"FEEDS": 7}
        assert ("A", None, None) in s.runs and ("A", None, 4) in s.runs

    async def test_the_count_session(self, edge_scan):
        edge_scan({"A": A_ROWS, "B": B_ROWS})
        answer = await engine_mod.execute_count_session(
            _HydrationProvider(), _edge_query({"sourceWhere": STRING}),
            context=SearchRunContext(data_version="1", scope_hash="h"))
        assert answer["count"] == 7 and answer["status"] == "complete"


# ---------------------------------------------------------------------------
# The reference (the stub), which the live suite holds FalkorDB's answers to
# ---------------------------------------------------------------------------

def _graph():
    """Domain d holds datasets s1 (family smith) and s2 (jones); s1 holds
    columns c1 (string, bob) and c3 (int, bob), s2 holds c2 (string,
    alice). FEEDS c1 → c2, c2 → c1, c3 → c2; DERIVES c1 → c3; a rollup
    s1 → s2."""
    from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider
    nodes = [{"urn": "d", "entityType": "domain", "displayName": "D"},
             {"urn": "s1", "entityType": "dataset", "displayName": "S1", "family": "smith"},
             {"urn": "s2", "entityType": "dataset", "displayName": "S2", "family": "jones"},
             {"urn": "c1", "entityType": "column", "displayName": "C1", "dataType": "string",
              "first_name": "bob"},
             {"urn": "c2", "entityType": "column", "displayName": "C2", "dataType": "string",
              "first_name": "alice"},
             {"urn": "c3", "entityType": "column", "displayName": "C3", "dataType": "int",
              "first_name": "bob"}]
    contains = [("d", "s1"), ("d", "s2"), ("s1", "c1"), ("s1", "c3"), ("s2", "c2")]
    links = [("c1", "c2", "FEEDS"), ("c2", "c1", "FEEDS"), ("c3", "c2", "FEEDS"),
             ("c1", "c3", "DERIVES"), ("s1", "s2", "AGGREGATED")]
    return StubDeepSearchProvider(
        nodes=nodes,
        edges=[{"source": a, "target": b, "type": "CONTAINS"} for a, b in contains]
        + [{"source": a, "target": b, "type": t, "properties": {"mode": "batch"}}
           for a, b, t in links],
        containment_edge_types=["CONTAINS"])


def _found(raw, scope=None):
    return ["/".join((e.source.urn, e.edge_type, e.target.urn))
            for e in _graph()._connections(P(edges(**raw)), _edge_query({}, scope).scope)]


class TestReference:
    def test_your_example(self):
        """A string column to anything whose parent's family is smith."""
        assert _found({"sourceWhere": STRING, "targetWhere": SMITH_PARENT}) == [
            "c1/DERIVES/c3", "c2/FEEDS/c1"]

    def test_either_way_each_edge_once(self):
        assert _found({"sourceWhere": STRING, "targetWhere": SMITH_PARENT,
                       "direction": "either"}) == [
            "c1/FEEDS/c2", "c1/DERIVES/c3", "c2/FEEDS/c1", "c3/FEEDS/c2"]

    def test_rollups_never_and_containment_only_when_asked(self):
        assert "s1/AGGREGATED/s2" not in _found({"edgeClass": "any"})
        assert _found({"sourceWhere": {"kind": "is", "refs": [{"urn": "d"}]}}) == []
        assert _found({"sourceWhere": {"kind": "is", "refs": [{"urn": "d"}]},
                       "edgeClass": "containment"}) == ["d/CONTAINS/s1", "d/CONTAINS/s2"]

    def test_both_ends_in_the_scope(self):
        assert _found({}, {"viewId": "v", "scopeMode": "view", "rootUrns": ["s1"]}) == [
            "c1/DERIVES/c3"]
        # A root reaches its scope's depth, no further.
        assert _found({}, {"viewId": "v", "scopeMode": "view", "rootUrns": ["d"],
                           "maxDepth": 1}) == []
        assert _found({}, {"viewId": "v", "scopeMode": "visible",
                           "visibleUrns": ["c1", "c2"]}) == ["c1/FEEDS/c2", "c2/FEEDS/c1"]

    def test_inside_a_container_at_either_end(self):
        inside = {"kind": "descendantOf", "urns": ["s2"]}
        assert _found({"sourceWhere": inside}) == ["c2/FEEDS/c1"]
        assert _found({"targetWhere": inside}) == ["c1/FEEDS/c2", "c3/FEEDS/c2"]

    def test_an_edge_carries_its_ends_and_their_containers(self):
        [hit] = _graph()._connections(P(edges(sourceWhere={"kind": "is", "refs": [{"urn": "c3"}]})),
                                      _edge_query({}).scope)
        assert (hit.id, hit.edge_type, hit.properties) == ("c3|FEEDS|c2", "FEEDS", {"mode": "batch"})
        assert [a.urn for a in hit.target.ancestor_path] == ["d", "s2"]
        assert hit.target.parent.urn == "s2" and hit.source.display_name == "C3"

    async def test_through_the_service(self):
        from backend.app.services.advanced_search_service import AdvancedSearchService
        from backend.app.services.view_scope import EffectiveViewScope

        svc = AdvancedSearchService(SimpleNamespace(provider=_graph()), session=None,
                                    workspace_id="ws")
        eff = EffectiveViewScope(
            view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
            root_urns=(), entity_type_allow_list=frozenset(), layer_allow_list=frozenset(),
            max_depth=12, scope_hash="h")

        async def resolve(requested):
            return eff

        async def guard(scope):
            return None

        svc._resolve_scope, svc._guard_view_data_source = resolve, guard
        page, _ = await svc.search(query(edges(sourceWhere=STRING, targetWhere=SMITH_PARENT)))
        assert [e.key for e in page.edges] and page.total_count == 2
        assert page.edge_type_counts == {"DERIVES": 1, "FEEDS": 1}
