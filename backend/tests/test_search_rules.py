"""Display rules at any scale: membership for what is on screen, exact counts.

``POST /search/membership`` answers "which of these URNs match which rules"
without downloading every entity a rule matches; ``POST /search/counts``
counts each rule's matches in the whole view, exactly, across requests.
Here against fakes: what the service checks and how it shares a request's
time between counts, the membership statement and the Python scope check,
the in-memory stub, and the routes' guards. The live suite holds the answers
to a real graph (``tests/integration/test_search_engine_live.py``).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import TypeAdapter
from starlette.requests import Request

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.providers.falkordb_search.membership import evaluate_membership
from backend.app.services.advanced_search_service import (
    AdvancedSearchService,
    ValidationError,
)
from backend.app.services.deep_search import SearchRunContext
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import (
    Predicate,
    SearchAncestorCountsRequest,
    SearchCountsRequest,
    SearchMembershipRequest,
    SearchScope,
)
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

P = TypeAdapter(Predicate).validate_python


def _eff(roots=(), types=frozenset()) -> EffectiveViewScope:
    return EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
        root_urns=tuple(roots), entity_type_allow_list=types,
        layer_allow_list=frozenset(), max_depth=12, scope_hash="h1")


def _service(provider, eff=None, monkeypatch=None) -> AdvancedSearchService:
    svc = AdvancedSearchService(SimpleNamespace(provider=provider), session=None,
                                workspace_id="ws")

    async def resolve(requested):
        return eff or _eff()

    async def guard(scope):
        return None

    svc._resolve_scope = resolve
    svc._guard_view_data_source = guard
    return svc


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class TestService:
    async def test_a_rule_that_cannot_be_compared_is_a_400_naming_it(self):
        request = SearchMembershipRequest.model_validate({
            "scope": {"viewId": "v"}, "urns": ["u"],
            "items": [{"id": "ok", "predicate": {"kind": "text", "value": "x"}},
                      {"id": "bad", "predicate": {"kind": "property", "key": "size",
                                                  "op": "gt", "value": "big",
                                                  "valueType": "number"}}]})
        with pytest.raises(ValidationError, match=r"\$\.items\[1\]\.predicate \(size\)"):
            await _service(StubDeepSearchProvider()).membership(request)

    async def test_roots_that_all_fall_outside_the_view_match_nothing(self):
        request = SearchMembershipRequest.model_validate({
            "scope": {"viewId": "v", "rootUrns": ["urn:elsewhere"]}, "urns": ["a"],
            "items": [{"id": "r", "predicate": {"kind": "all"}}]})
        stub = StubDeepSearchProvider(nodes=[{"urn": "a", "entityType": "t"}])
        out = await _service(stub, _eff(roots=())).membership(request)
        assert out.matches == {"r": []}

    async def test_membership_reads_the_resolved_scope(self):
        stub = StubDeepSearchProvider(nodes=[
            {"urn": "a", "entityType": "t", "ancestorUrns": ["root"], "displayName": "x"},
            {"urn": "b", "entityType": "t", "ancestorUrns": ["other"], "displayName": "x"},
        ])
        request = SearchMembershipRequest.model_validate({
            "scope": {"viewId": "v"}, "urns": ["a", "b"],
            "items": [{"id": "r", "predicate": {"kind": "all"}}]})
        out = await _service(stub, _eff(roots=("root",))).membership(request)
        # "b" holds everything the rule asks, but lies outside the view.
        assert out.matches == {"r": ["a"]}

    async def test_counts_read_every_count_then_move_the_least_advanced_first(self):
        calls = []

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                name = query.predicate.children[0].value if hasattr(query.predicate, "children") \
                    else query.predicate.value
                calls.append((name, advance, query.options.session_id, query.options.wait_ms))
                done = {"a": 0.9, "b": 0.1, "c": 1.0}[name]
                status = "complete" if done == 1.0 else "running"
                if advance:
                    status = "running"
                return {"count": 3, "status": status, "sessionId": f"s-{name}",
                        "progress": {"scanned": int(done * 10), "total": 10, "matched": 3}}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "waitMs": 5000,
            "sessions": {"a": "prev-a"},
            "items": [{"id": n, "predicate": {"kind": "text", "value": n}} for n in "abc"]})
        out = await _service(_Counts()).counts(request)

        peeks = [c for c in calls if not c[1]]
        moves = [c for c in calls if c[1]]
        assert [c[0] for c in peeks] == ["a", "b", "c"]
        assert peeks[0][2] == "prev-a"                   # continues the client's session
        # Complete counts are left alone; the least advanced moves first.
        assert [c[0] for c in moves] == ["b", "a"]
        assert moves[0][2] == "s-b"
        assert set(out.counts) == {"a", "b", "c"} and out.counts["c"].status == "complete"

    async def test_past_its_wait_a_request_moves_only_the_first_count(self):
        moved = []

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                if advance:
                    moved.append(query.predicate.value)
                return {"count": 0, "status": "running", "sessionId": None,
                        "progress": None}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "waitMs": 0,
            "items": [{"id": n, "predicate": {"kind": "text", "value": n}} for n in "xyz"]})
        out = await _service(_Counts()).counts(request)
        assert moved == ["x"]
        assert {k: v.status for k, v in out.counts.items()} == {
            "x": "running", "y": "running", "z": "running"}

    async def test_a_rule_the_engine_cannot_count_says_why(self):
        from backend.app.services.deep_search import CompileError

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                raise CompileError("path search has no count")

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"},
            "items": [{"id": "p", "predicate": {"kind": "text", "value": "x"}}]})
        out = await _service(_Counts()).counts(request)
        assert out.counts["p"].error == "path search has no count"

    async def test_a_count_that_fails_is_that_rules_error_alone(self):
        from backend.app.services.deep_search import SearchFailed

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                name = query.predicate.value
                if not advance:
                    return {"count": 0, "status": "running", "sessionId": None,
                            "progress": None}
                if name == "broken":
                    raise SearchFailed("count failed: the graph refused a read")
                return {"count": 7, "status": "complete", "sessionId": "s",
                        "progress": {"scanned": 10, "total": 10, "matched": 7}}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "waitMs": 5000,
            "items": [{"id": n, "predicate": {"kind": "text", "value": n}}
                      for n in ("broken", "fine")]})
        out = await _service(_Counts()).counts(request)
        assert out.counts["broken"].status == "complete"
        assert out.counts["broken"].error == "count failed: the graph refused a read"
        assert out.counts["fine"].count == 7 and out.counts["fine"].error is None

    async def test_container_counts_are_read_for_the_resolved_view_only(self):
        seen = {}

        class _Sessions:
            async def deep_search_ancestor_counts(self, session_id, urns, *, context):
                seen.update(sid=session_id, urns=urns, scope_hash=context.scope_hash)
                return {"status": "complete", "counts": {
                    u: {"count": 2, "typeCounts": {"Dataset": 2}} for u in urns}}

        request = SearchAncestorCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "sessionId": "sid-1", "urns": ["a", "a", "", "b"]})
        out = await _service(_Sessions()).ancestor_counts(request)
        # The session must be this view's: the scope the search resolved.
        assert seen == {"sid": "sid-1", "urns": ["a", "b"], "scope_hash": "h1"}
        assert out.status == "complete" and out.counts["b"].type_counts == {"Dataset": 2}

    async def test_container_counts_need_a_session_engine(self):
        request = SearchAncestorCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "sessionId": "sid-1", "urns": ["a"]})
        with pytest.raises(NotImplementedError):
            await _service(StubDeepSearchProvider()).ancestor_counts(request)

    async def test_a_provider_without_rules_is_a_501(self):
        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"},
            "items": [{"id": "p", "predicate": {"kind": "text", "value": "x"}}]})
        with pytest.raises(NotImplementedError):
            await _service(SimpleNamespace()).counts(request)


# ---------------------------------------------------------------------------
# The membership statement
# ---------------------------------------------------------------------------

class _Graph:
    """Answers the membership statement from a table of nodes, asserting
    the shape it is sent."""

    def __init__(self, nodes):
        self.nodes = nodes          # urn -> (label, ancestors, {column: bool})
        self.statements = []

    async def run(self, cypher, params):
        self.statements.append((cypher, params))
        if cypher.startswith("CALL db.labels()"):
            return SimpleNamespace(result_set=[["A"], ["B"]])
        rows = []
        if "RETURN n.urn, labels(n)" in cypher:
            label = cypher.split("MATCH (n:`", 1)[1].split("`", 1)[0]
            columns = cypher.count("ANY(_mz IN [0] WHERE")
            for urn in params["_urns"]:
                lbl, anc, flags = self.nodes[urn]
                if lbl == label:
                    rows.append([urn, [lbl], anc] + [flags.get(i, False) for i in range(columns)])
        return SimpleNamespace(result_set=rows)


def _provider(graph, containment=("CONTAINS",)):
    async def labels_of(urns):
        return {u: graph.nodes[u][0] if u in graph.nodes else None for u in urns}

    return SimpleNamespace(
        _ro_query=lambda c, params=None, timeout=None: graph.run(c, params or {}),
        _get_containment_edge_types=lambda: list(containment),
        _get_lineage_edge_types=lambda: [],
        _entity_type_levels={},
        _resolve_urn_labels_bulk=labels_of,
    )


async def _members(graph, scope, items, urns, **kw):
    return await evaluate_membership(_provider(graph, **kw), scope, items, urns,
                                     run=graph.run, timeout_s=1.0)


class TestMembershipStatement:
    async def test_rules_share_one_statement_with_distinct_parameters(self):
        graph = _Graph({"u1": ("A", [], {0: True, 1: False})})
        items = [("r0", P({"kind": "property", "key": "k", "op": "eq", "value": "x"})),
                 ("r1", P({"kind": "property", "key": "k", "op": "eq", "value": "y"}))]
        out = await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                             items, ["u1"])
        assert out["matches"] == {"r0": ["u1"], "r1": []}
        cypher, params = next(s for s in graph.statements if "RETURN n.urn, labels(n)" in s[0])
        assert cypher.count("ANY(_mz IN [0] WHERE") == 2
        assert params["p0"] == "x" and params["p1"] == "y"
        assert "[] ," not in cypher and ", [], " in cypher      # no ancestors needed

    async def test_an_entity_outside_the_views_roots_never_matches(self):
        graph = _Graph({"in": ("A", ["in", "root"], {0: True}),
                        "out": ("A", ["out", "elsewhere"], {0: True})})
        scope = SearchScope(view_id="v", scope_mode="view", root_urns=["root"])
        out = await _members(graph, scope, [("r", P({"kind": "all"}))], ["in", "out"])
        assert out["matches"] == {"r": ["in"]}
        cypher = next(s[0] for s in graph.statements if "RETURN n.urn, labels(n)" in s[0])
        assert "[(n)<-[:CONTAINS*0..12]-(_ma) | _ma.urn]" in cypher

    async def test_a_rules_own_descendant_of_is_checked_against_ancestors(self):
        graph = _Graph({"a": ("A", ["a", "sales"], {0: True}),
                        "b": ("A", ["b", "ops"], {0: True})})
        rule = P({"kind": "group", "op": "and", "children": [
            {"kind": "descendantOf", "urns": ["sales"]}, {"kind": "all"}]})
        out = await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                             [("r", rule)], ["a", "b"])
        assert out["matches"] == {"r": ["a"]}

    async def test_without_roots_the_views_types_bound_it(self):
        graph = _Graph({"a": ("A", [], {0: True}), "b": ("B", [], {0: True})})
        scope = SearchScope(view_id="v", scope_mode="data_source", entity_types=["b"])
        out = await _members(graph, scope, [("r", P({"kind": "all"}))], ["a", "b"])
        assert out["matches"] == {"r": ["b"]}

    async def test_the_visible_urns_bound_a_visible_scope(self):
        graph = _Graph({"a": ("A", [], {0: True}), "b": ("A", [], {0: True})})
        scope = SearchScope(view_id="v", scope_mode="visible", visible_urns=["b"])
        out = await _members(graph, scope, [("r", P({"kind": "all"}))], ["a", "b"])
        assert out["matches"] == {"r": ["b"]}

    async def test_a_route_through_the_graph_is_not_a_rule(self):
        graph = _Graph({"a": ("A", [], {0: True})})
        rule = P({"kind": "group", "op": "and", "children": [
            {"kind": "withinHops", "urns": ["x"], "hops": 2, "edgeTypes": ["T"]}]})
        out = await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                             [("hops", rule), ("ok", P({"kind": "all"}))], ["a"])
        assert "hops" in out["errors"] and "hops" not in out["matches"]
        assert out["matches"] == {"ok": ["a"]}

    async def test_an_unknown_urn_matches_nothing(self):
        graph = _Graph({"a": ("A", [], {0: True})})
        out = await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                             [("r", P({"kind": "all"}))], ["a", "gone"])
        assert out["matches"] == {"r": ["a"]}


# ---------------------------------------------------------------------------
# The stub
# ---------------------------------------------------------------------------

class TestStub:
    NODES = [
        {"urn": "a", "entityType": "table", "displayName": "orders", "owner": "x"},
        {"urn": "b", "entityType": "table", "displayName": "customers", "owner": "y"},
        {"urn": "c", "entityType": "column", "displayName": "order_id", "owner": "x"},
    ]

    async def test_membership_and_counts_follow_the_predicate_and_scope(self):
        stub = StubDeepSearchProvider(nodes=self.NODES)
        scope = SearchScope(view_id="v", entity_types=["table"])
        rule = P({"kind": "property", "key": "owner", "op": "eq", "value": "x"})
        out = await stub.deep_search_membership(scope, [("r", rule)], ["a", "b", "c"])
        assert out["matches"] == {"r": ["a"]}
        from backend.common.models.search import SearchQuery
        count = await stub.deep_search_count(SearchQuery(predicate=rule, scope=scope))
        assert count["count"] == 1 and count["status"] == "complete"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _request(view_capability=None) -> Request:
    state = {} if view_capability is None else {"view_capability": view_capability}
    return Request({"type": "http", "headers": [], "state": state})


class TestRoutes:
    def _body(self, scope_mode="view"):
        return SearchMembershipRequest.model_validate({
            "scope": {"viewId": "view-1", "scopeMode": scope_mode}, "urns": ["u"],
            "items": [{"id": "r", "predicate": {"kind": "all"}}]})

    @pytest.mark.parametrize("scope_mode", ["data_source", "visible"])
    async def test_a_share_link_stays_inside_its_view(self, scope_mode):
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_membership(
                body=self._body(scope_mode), request=_request("view-1"), ws_id="ws",
                engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 403

    async def test_rules_are_admitted_per_statement(self, monkeypatch):
        seen = {}

        async def membership(self, body, *, run_context=None):
            seen["context"] = run_context
            from backend.common.models.search import SearchMembershipResult
            return SearchMembershipResult()

        monkeypatch.setattr(AdvancedSearchService, "membership", membership)
        monkeypatch.setattr(graph_mod, "_statement_admission", lambda engine: "admit")

        async def version(engine):
            return "7.g"

        monkeypatch.setattr(graph_mod, "_search_data_version", version)
        await graph_mod.search_membership(
            body=self._body(), request=_request(), ws_id="ws",
            engine=SimpleNamespace(provider=None), session=None)
        assert seen["context"] == SearchRunContext(data_version="7.g", admit="admit")

    @pytest.mark.parametrize("scope_mode", ["data_source", "visible"])
    async def test_container_counts_stay_inside_a_share_links_view(self, scope_mode):
        body = SearchAncestorCountsRequest.model_validate({
            "scope": {"viewId": "view-1", "scopeMode": scope_mode},
            "sessionId": "s", "urns": ["u"]})
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_ancestor_counts(
                body=body, request=_request("view-1"), ws_id="ws",
                engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 403

    async def test_counts_need_a_workspace(self):
        body = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "items": [{"id": "r", "predicate": {"kind": "all"}}]})
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_counts(body=body, request=_request(), ws_id=None,
                                          engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 400
