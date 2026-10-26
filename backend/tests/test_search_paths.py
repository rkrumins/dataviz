"""Path patterns: every route from a source to a target, either end named or
a condition.

"Every route from a topic to a dataset through edges in stream mode": a
path's ends may be conditions (``sourceWhere`` / ``targetWhere``) as well
as named entities. Here: the model's rules, the service's, the statement
each kind of end starts from, and the routes the reference finds (the
stub, which ``tests/integration/test_search_relations_live.py`` holds
FalkorDB's to).
"""
from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from backend.app.providers.falkordb_deep_search import _Compiler, _run_path_query
from backend.app.services.advanced_search_service import (
    AdvancedSearchService,
    ValidationError,
    _validate_predicate,
)
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import Predicate, SearchQuery, SearchScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

P = TypeAdapter(Predicate).validate_python
DATASET = {"kind": "entityType", "values": ["dataset"]}
TOPIC = {"kind": "entityType", "values": ["topic"]}


def path(**raw):
    return {"kind": "path", **raw}


class TestModel:
    @pytest.mark.parametrize("raw, why", [
        (path(targetUrns=["b"]), "sources needs urns or refs"),
        (path(sourceUrns=["a"], sourceWhere=DATASET, targetUrns=["b"]),
         "sources are named or a condition, not both"),
        (path(sourceUrns=["a"], targetWhere=DATASET, maxHops=5), "an end a condition goes at most 4"),
        (path(sourceWhere=TOPIC, targetWhere=DATASET, maxHops=4),
         "both ends a condition goes at most 3"),
    ])
    def test_each_end_is_named_or_a_condition(self, raw, why):
        with pytest.raises(PydanticValidationError, match=why):
            P(raw)

    def test_the_default_reach_shortens_for_conditions(self):
        assert P(path(sourceUrns=["a"], targetUrns=["b"])).max_hops == 4
        assert P(path(sourceUrns=["a"], targetWhere=DATASET)).max_hops == 4
        assert P(path(sourceWhere=TOPIC, targetWhere=DATASET)).max_hops == 3


class TestValidation:
    def test_an_ends_condition_is_held_to_a_relationships_rules(self):
        assert _validate_predicate(P(path(sourceWhere=TOPIC, targetWhere={
            "kind": "group", "op": "and", "children": [DATASET, DATASET]}))) == 4
        with pytest.raises(ValidationError, match=r"\$.targetWhere.*can't sit inside"):
            _validate_predicate(P(path(sourceUrns=["a"], targetWhere={
                "kind": "descendantOf", "urns": ["u"]})))
        deep = {"kind": "related", "axis": "parent", "where": {
            "kind": "related", "axis": "parent", "where": {
                "kind": "related", "axis": "parent"}}}
        with pytest.raises(ValidationError, match="more than 3 deep"):
            _validate_predicate(P(path(sourceUrns=["a"], targetWhere=deep)))


class TestCompiler:
    def test_an_end_is_filtered_in_stages(self):
        c = _Compiler(lineage_edge_types={"FLOWS_TO"}, containment_edge_types={"CONTAINS"})
        c.compile(P(path(sourceWhere=TOPIC, targetWhere={
            "kind": "group", "op": "and", "children": [
                {"kind": "related", "axis": "parent", "where": DATASET}, DATASET]})))
        hoisted = c.hoisted_path
        assert hoisted["source_where"] == ["(toLower(labels(s)[0]) IN $p0)"]
        plain, related = hoisted["target_where"]
        assert plain == "(toLower(labels(t)[0]) IN $p1)"
        assert related.startswith("ANY(_xb2 IN [(t)<-[:CONTAINS]-(_xr2) WHERE ID(_xr2) <> ID(t)")


class _Provider:
    """Answers the label list and urn lookups (urns ending in ``x`` exist
    nowhere); records every statement."""

    def __init__(self):
        self.sent = []

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    async def _ro_query(self, cypher, *, params=None, timeout=None):
        self.sent.append((cypher, params or {}))
        if "db.labels" in cypher:
            rows = [["L"]]
        elif "RETURN ID(r)" in cypher:
            rows = [[i] for i, u in enumerate(params["_urns"]) if not u.endswith("x")]
        else:
            rows = []
        return SimpleNamespace(result_set=rows)


def _run(raw, scope=None):
    c = _Compiler(lineage_edge_types={"FLOWS_TO"}, containment_edge_types={"CONTAINS"})
    c.compile(P(path(**raw)))
    provider = _Provider()
    asyncio.run(_run_path_query(provider, c.hoisted_path, timeout_s=1.0,
                                compiled_params=c.params, scope=scope))
    return provider.sent[-1]


class TestWhereAPathStarts:
    def test_at_named_sources_sought_by_id(self):
        cypher, params = _run({"sourceUrns": ["a"], "targetUrns": ["b"]})
        assert cypher.startswith("UNWIND $_pathSrcIds AS _ps MATCH (s) WHERE ID(s) = _ps")
        assert (params["_pathSrcIds"], params["_pathTgtIds"]) == ([0], [0])

    def test_at_named_targets_when_the_sources_are_a_condition(self):
        cypher, params = _run({"sourceWhere": TOPIC, "targetUrns": ["b"]})
        assert cypher.startswith("UNWIND $_pathTgtIds AS _pt MATCH (t) WHERE ID(t) = _pt")
        assert "_pathSrcIds" not in params

    @pytest.mark.parametrize("scope, head", [
        (SearchScope(view_id="v", scope_mode="view", root_urns=["r"]),
         "UNWIND $_pathScope AS _pr MATCH (_r) WHERE ID(_r) = _pr MATCH (_r)-[:CONTAINS*0..12]->(s)"),
        (SearchScope(view_id="v", scope_mode="visible", visible_urns=["a", "b"]),
         "UNWIND $_pathScope AS _pr MATCH (s) WHERE ID(s) = _pr"),
        (SearchScope(view_id="v", scope_mode="view", entity_types=["Topic"]),
         "MATCH (s) WHERE s.urn IS NOT NULL AND toLower(labels(s)[0]) IN $_pathScope"),
        (SearchScope(view_id="v", scope_mode="data_source"), "MATCH (s) WHERE s.urn IS NOT NULL"),
    ])
    def test_in_the_scope_when_both_ends_are_conditions(self, scope, head):
        cypher, _ = _run({"sourceWhere": TOPIC, "targetWhere": DATASET}, scope)
        assert cypher.startswith(head)

    def test_a_named_end_that_exists_nowhere_finds_no_path(self):
        cypher, _ = _run({"sourceUrns": ["ax"], "targetUrns": ["b"]})
        assert "MATCH p =" not in cypher


def _graph() -> StubDeepSearchProvider:
    """events → orders → revenue, orders → costs, a ⇄ b; Sales ⊃ orders."""
    nodes = [("events", "topic"), ("orders", "dataset"), ("revenue", "dashboard"),
             ("costs", "dashboard"), ("a", "dataset"), ("b", "dataset"), ("sales", "domain")]
    lineage = [("events", "orders", "stream"), ("orders", "revenue", "batch"),
               ("orders", "costs", None), ("a", "b", None), ("b", "a", None)]
    return StubDeepSearchProvider(
        nodes=[{"urn": u, "entityType": t, "displayName": u} for u, t in nodes],
        edges=([{"source": s, "target": t, "type": "FLOWS_TO", "confidence": 0.9,
                 **({"properties": {"mode": m}} if m else {})} for s, t, m in lineage]
               + [{"source": "sales", "target": "orders", "type": "CONTAINS"}]))


async def _routes(raw, **options):
    page = await _graph().deep_search(SearchQuery.model_validate({
        "predicate": path(**raw), "scope": {"viewId": "v", "scopeMode": "data_source"},
        "options": {"results": "paths", **options}}))
    return ["/".join(n.urn for n in r.nodes) for r in page.paths], page.truncated


class TestRoutes:
    async def test_every_route_from_a_condition_to_a_condition(self):
        assert await _routes({"sourceWhere": TOPIC, "targetWhere": {
            "kind": "entityType", "values": ["dashboard"]}}) == (
            ["events/orders/costs", "events/orders/revenue"], False)

    async def test_a_route_passes_no_entity_twice(self):
        """a ⇄ b, either way: two routes to b — along a → b and against
        b → a — and none back to a."""
        assert await _routes({"sourceUrns": ["a"], "targetWhere": {"kind": "all"},
                              "direction": "any"}) == (["a/b", "a/b"], False)

    async def test_every_edge_meets_the_edge_filter(self):
        stream = {"kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}
        assert await _routes({"sourceWhere": {"kind": "all"}, "targetWhere": {"kind": "all"},
                              "edgePredicate": stream}) == (["events/orders"], False)

    async def test_cut_at_max_paths(self):
        routes, truncated = await _routes({"sourceWhere": DATASET,
                                           "targetWhere": {"kind": "all"}, "maxPaths": 2})
        assert len(routes) == 2 and truncated


class TestService:
    async def test_names_in_an_ends_condition_are_resolved(self):
        stub = _graph()
        svc = AdvancedSearchService(SimpleNamespace(provider=stub), session=None,
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
        page, _ = await svc.search(SearchQuery.model_validate({
            "predicate": {"kind": "group", "children": [path(
                sourceWhere={"kind": "is", "refs": [{"path": ["**", "events"]}]},
                targetWhere={"kind": "entityType", "values": ["dashboard"]})]},
            "scope": {"viewId": "v"}, "options": {"results": "paths"}}))
        assert sorted("/".join(n.urn for n in r.nodes) for r in page.paths) == [
            "events/orders/costs", "events/orders/revenue"]
        assert re.fullmatch(r"\$\.children\[0\]\.sourceWhere\.refs\[0\]",
                            page.scope_diagnostics.resolved_refs[0].at)
