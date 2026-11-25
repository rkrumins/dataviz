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

import re
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
from backend.common.adapters.circuit import ProviderBusy
from backend.common.models.search import (
    Predicate,
    SearchAncestorCountsRequest,
    SearchCountsRequest,
    SearchMembershipRequest,
    SearchResolveRequest,
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

    async def test_relationship_rules_answer_the_relationships_asked_about(self):
        """A rule that styles relationships is a Connections search: asked about the
        relationships on screen, by id, beside the entity rules asked about the entities. A
        relationship with an end outside the view never matches."""
        stub = StubDeepSearchProvider(nodes=[
            {"urn": "a", "entityType": "t", "ancestorUrns": ["root"]},
            {"urn": "b", "entityType": "t", "ancestorUrns": ["root"]},
            {"urn": "c", "entityType": "t", "ancestorUrns": ["other"]},
        ], edges=[
            {"id": "e1", "source": "a", "target": "b", "type": "FEEDS", "properties": {"mode": "stream"}},
            {"id": "e2", "source": "a", "target": "c", "type": "FEEDS", "properties": {"mode": "stream"}},
            {"id": "e3", "source": "b", "target": "a", "type": "FEEDS", "properties": {"mode": "batch"}},
        ])
        streams = {"kind": "group", "op": "and", "children": [{"kind": "edges", "edgePredicate": {
            "kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}}]}
        request = SearchMembershipRequest.model_validate({
            "scope": {"viewId": "v"}, "urns": ["a", "b", "c"],
            "edges": [{"id": e, "source": s, "target": t}
                      for e, s, t in (("e1", "a", "b"), ("e2", "a", "c"), ("e3", "b", "a"))],
            "items": [{"id": "all", "predicate": {"kind": "all"}},
                      {"id": "streams", "predicate": streams}]})
        out = await _service(stub, _eff(roots=("root",))).membership(request)
        assert out.matches == {"all": ["a", "b"]}
        assert out.edge_matches == {"streams": ["e1"]}
        assert out.model_dump(by_alias=True)["edgeMatches"] == {"streams": ["e1"]}
        # No relationships asked about: none matches, and the engine is not asked.
        alone = request.model_copy(update={"edges": [], "items": request.items[1:]})
        out = await _service(SimpleNamespace(), _eff(roots=("root",))).membership(alone)
        assert (out.matches, out.edge_matches) == ({}, {"streams": []})

    async def test_a_relationship_rule_past_the_member_cap_is_refused_on_its_own(self):
        """A view whose members are too many to list can't hold a Connections search's far end
        to them: the relationship rule says so, and the entity rules are answered."""
        from backend.app.services.advanced_search_service import CONNECTIONS_PAST_THE_CAP
        stub = StubDeepSearchProvider(nodes=[{"urn": "a", "entityType": "t"}])
        svc = _service(stub)
        svc._members = lambda scope, eff: object()
        request = SearchMembershipRequest.model_validate({
            "scope": {"viewId": "v"}, "urns": ["a"], "edges": [{"id": "e", "source": "a", "target": "a"}],
            "items": [{"id": "all", "predicate": {"kind": "all"}},
                      {"id": "links", "predicate": {"kind": "edges"}}]})
        out = await svc.membership(request)
        assert out.matches == {"all": ["a"]} and out.edge_matches == {"links": []}
        assert out.errors == {"links": CONNECTIONS_PAST_THE_CAP}

    async def test_a_relationship_rule_is_counted_by_the_connections_counter(self):
        counted = []

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                counted.append(query.predicate.kind)
                return {"count": 4, "status": "complete", "sessionId": "s"}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "items": [{"id": "links", "predicate": {
                "kind": "group", "op": "and", "children": [{"kind": "edges", "edgeTypes": ["FEEDS"]}]}}]})
        out = await _service(_Counts()).counts(request)
        assert out.counts["links"].count == 4 and set(counted) == {"edges"}
        # Asked of every relationship on the canvas, its ends follow lineage one hop.
        far = {"kind": "edges", "sourceWhere": {"kind": "related", "axis": "upstream", "maxHops": 2}}
        with pytest.raises(ValidationError, match="a rule follows lineage one hop"):
            await _service(_Counts()).counts(SearchCountsRequest.model_validate({
                "scope": {"viewId": "v"}, "items": [{"id": "far", "predicate": far}]}))

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

    async def test_a_long_wait_moves_counts_on_for_a_few_seconds_at_most(self):
        """A count's last unit may run its whole budget past the wait, so a
        request moves counts on for a few seconds at most, however long it
        asks to wait — and still ends inside the request timeout."""
        waits = []

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                if advance:
                    waits.append(query.options.wait_ms)
                return {"count": 0, "status": "running", "sessionId": None,
                        "progress": None}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "waitMs": 60_000,
            "items": [{"id": "x", "predicate": {"kind": "text", "value": "x"}}]})
        await _service(_Counts()).counts(request)
        assert waits and waits[0] <= 5_000

    async def test_a_searchs_condition_counts_lineage_several_hops_out(self):
        """A rule follows lineage one hop — it is asked of every entity on
        the canvas. The conditions of a search being built are counted as
        the search would run them, so "feeds X within 3 hops" counts."""
        counted = []

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                counted.append(query.predicate)
                return {"count": 7, "status": "complete", "sessionId": "s"}

        three_hops = {"kind": "related", "axis": "downstream", "maxHops": 3,
                      "where": {"kind": "entityType", "op": "in", "values": ["dashboard"]}}
        body = {"scope": {"viewId": "v"}, "items": [{"id": "feeds", "predicate": three_hops}]}

        out = await _service(_Counts()).counts(
            SearchCountsRequest.model_validate({**body, "purpose": "search"}))
        assert out.counts["feeds"].count == 7 and counted

        with pytest.raises(ValidationError, match="a rule follows lineage one hop"):
            await _service(_Counts()).counts(SearchCountsRequest.model_validate(body))

    async def test_a_searchs_condition_keeps_a_searchs_limits(self):
        # Beyond the hops a search tests from every candidate, a 400 unless
        # it is traced from its far end, as the search would run it.
        far = {"kind": "related", "axis": "downstream", "maxHops": 9}

        def request(predicate):
            return SearchCountsRequest.model_validate({
                "scope": {"viewId": "v"}, "purpose": "search",
                "items": [{"id": "far", "predicate": predicate}]})
        counted = await _service(StubDeepSearchProvider()).counts(request(far))
        assert counted.counts["far"].error is None
        with pytest.raises(ValidationError, match="Following more than 3 works"):
            await _service(StubDeepSearchProvider()).counts(request({**far, "quantifier": "none"}))

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
        # What the graph said stays in the server's log; the page says it plainly.
        assert out.counts["broken"].error and "refused" not in out.counts["broken"].error
        assert out.counts["fine"].count == 7 and out.counts["fine"].error is None

    async def test_a_count_named_that_already_failed_is_that_rules_error_alone(self):
        """The engine keeps a failed count a while, and reading it without
        advancing says it failed — for that rule; the others count on."""
        from backend.app.services.deep_search import SearchFailed

        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                if query.options.session_id == "failed":
                    raise SearchFailed("count failed: boom")
                return {"count": 7, "status": "complete", "sessionId": "s",
                        "progress": {"scanned": 10, "total": 10, "matched": 7}}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "sessions": {"broken": "failed"},
            "items": [{"id": n, "predicate": {"kind": "text", "value": n}}
                      for n in ("broken", "fine")]})
        out = await _service(_Counts()).counts(request)
        assert out.counts["broken"].status == "complete"
        assert out.counts["broken"].error and "boom" not in out.counts["broken"].error
        assert out.counts["fine"].count == 7 and out.counts["fine"].error is None

    async def test_a_count_that_left_part_of_the_view_out_says_it_is_a_floor(self):
        class _Counts:
            async def deep_search_count(self, query, *, context, advance=True):
                return {"count": 7, "status": "complete", "sessionId": "s",
                        "progress": {"scanned": 10, "total": 10, "matched": 7},
                        "lowerBound": True}

        request = SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"},
            "items": [{"id": "r", "predicate": {"kind": "text", "value": "x"}}]})
        out = await _service(_Counts()).counts(request)
        assert out.counts["r"].count == 7 and out.counts["r"].lower_bound is True
        assert out.counts["r"].model_dump(by_alias=True)["lowerBound"] is True

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
            # One ancestor list per depth the statement reads them to.
            depths = [int(d) for d in re.findall(
                r"\[\(n\)<-\[:[\w|]+\*0\.\.(\d+)\]-\(_ma\d+\) \| _ma\d+\.urn\]", cypher)] or [None]
            for urn in params["_urns"]:
                lbl, anc, flags = self.nodes[urn]
                if lbl == label:
                    # ``anc``: its ancestors' URNs, or {urn: levels up}.
                    within = [[a for a in anc
                               if d is None or not isinstance(anc, dict) or anc[a] <= d]
                              for d in depths]
                    rows.append([urn, [lbl], *within]
                                + [flags.get(i, False) for i in range(columns)])
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

    async def test_rules_a_busy_graph_could_not_check_are_not_answered(self):
        """No labels filtered every entity out, so a busy graph's rules
        matched nothing — and the canvas kept that as the answer."""
        graph = _Graph({"u1": ("A", [], {0: True})})
        answer = graph.run

        async def busy(cypher, params):
            if cypher.startswith("CALL db.labels()"):
                raise TimeoutError("Query timed out")
            return await answer(cypher, params)

        graph.run = busy
        items = [("r0", P({"kind": "property", "key": "k", "op": "eq", "value": "x"}))]
        with pytest.raises(ProviderBusy):
            await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                           items, ["u1"])

    async def test_an_entity_outside_the_views_roots_never_matches(self):
        graph = _Graph({"in": ("A", ["in", "root"], {0: True}),
                        "out": ("A", ["out", "elsewhere"], {0: True})})
        scope = SearchScope(view_id="v", scope_mode="view", root_urns=["root"])
        out = await _members(graph, scope, [("r", P({"kind": "all"}))], ["in", "out"])
        assert out["matches"] == {"r": ["in"]}
        cypher = next(s[0] for s in graph.statements if "RETURN n.urn, labels(n)" in s[0])
        assert "[(n)<-[:CONTAINS*0..12]-(_ma0) | _ma0.urn]" in cypher

    async def test_a_rules_own_descendant_of_is_checked_against_ancestors(self):
        graph = _Graph({"a": ("A", ["a", "sales"], {0: True}),
                        "b": ("A", ["b", "ops"], {0: True})})
        rule = P({"kind": "group", "op": "and", "children": [
            {"kind": "descendantOf", "urns": ["sales"]}, {"kind": "all"}]})
        out = await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                             [("r", rule)], ["a", "b"])
        assert out["matches"] == {"r": ["a"]}

    async def test_a_rules_descendant_of_reaches_no_deeper_than_its_max_depth(self):
        # ``b`` sits two levels below ``sales``, ``a`` one.
        graph = _Graph({"a": ("A", {"a": 0, "sales": 1}, {0: True}),
                        "b": ("A", {"b": 0, "mid": 1, "sales": 2}, {0: True})})
        rule = P({"kind": "group", "op": "and", "children": [
            {"kind": "descendantOf", "urns": ["sales"], "maxDepth": 1}, {"kind": "all"}]})
        out = await _members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                             [("r", rule)], ["a", "b"])
        assert out["matches"] == {"r": ["a"]}
        cypher = next(s[0] for s in graph.statements if "RETURN n.urn, labels(n)" in s[0])
        assert "[(n)<-[:CONTAINS*0..1]-(_ma0) | _ma0.urn]" in cypher and "*0..12" not in cypher

    async def test_the_views_roots_keep_the_scopes_depth_beside_a_shallower_rule(self):
        graph = _Graph({"a": ("A", {"a": 0, "sales": 1, "root": 5}, {0: True}),
                        "b": ("A", {"b": 0, "sales": 2, "root": 3}, {0: True})})
        rule = P({"kind": "group", "op": "and", "children": [
            {"kind": "descendantOf", "urns": ["sales"], "maxDepth": 1}, {"kind": "all"}]})
        scope = SearchScope(view_id="v", scope_mode="view", root_urns=["root"])
        out = await _members(graph, scope, [("r", rule)], ["a", "b"])
        assert out["matches"] == {"r": ["a"]}
        # One ancestor list per depth, each its own variable: FalkorDB binds
        # a name reused across comprehensions, and the second list is empty.
        cypher = next(s[0] for s in graph.statements if "RETURN n.urn, labels(n)" in s[0])
        assert "[(n)<-[:CONTAINS*0..1]-(_ma0) | _ma0.urn]" in cypher
        assert "[(n)<-[:CONTAINS*0..12]-(_ma1) | _ma1.urn]" in cypher

    async def test_a_view_too_large_to_list_holds_its_members_and_what_its_roots_hold(self):
        """Past the root cap a view's members aren't among its roots: one is in the
        view by being a member, as what lies under an entry people placed is."""
        graph = _Graph({"m": ("A", ["m", "far"], {0: True}),
                        "in": ("A", ["in", "root"], {0: True}),
                        "out": ("A", ["out", "far"], {0: True})})

        class _Held:
            async def holds(self, urns):
                return {u for u in urns if u == "m"}

        rule = [("r", P({"kind": "all"}))]
        for roots, matched in ((["root"], ["m", "in"]), (None, ["m"])):
            scope = SearchScope(view_id="v", scope_mode="view", root_urns=roots)
            out = await evaluate_membership(_provider(graph), scope, rule, ["m", "in", "out"],
                                            run=graph.run, timeout_s=1.0, members=_Held())
            assert out["matches"] == {"r": matched}, roots

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
# The membership statement of a rule that styles relationships
# ---------------------------------------------------------------------------

class _EdgeGraph:
    """Answers edge membership's statements: ``nodes`` urn → (label, node ID), ``edges`` id →
    (source urn, target urn) — what the edge statement finds from the anchors it is given."""

    def __init__(self, nodes, edges):
        self.nodes, self.edges = nodes, edges
        self.statements = []

    async def run(self, cypher, params):
        self.statements.append((cypher, params))
        if cypher.startswith("CALL db.labels()"):
            return SimpleNamespace(result_set=[["A"], ["B"]])
        labels = set(re.findall(r"MATCH \(r:`(\w+)`\) WHERE r\.urn IN \$_urns", cypher))
        if "RETURN r.urn AS urn, ID(r) AS id" in cypher:
            return SimpleNamespace(result_set=[[u, self.nodes[u][1]] for u in params["_urns"]
                                               if u in self.nodes and self.nodes[u][0] in labels])
        if "RETURN ID(r) AS id" in cypher:
            return SimpleNamespace(result_set=[[self.nodes[u][1]] for u in params["_urns"]
                                               if u in self.nodes and self.nodes[u][0] in labels])
        if "RETURN DISTINCT coalesce(" in cypher:
            reverse = "(n)<-[e:" in cypher
            ids = {u: i for u, (_, i) in self.nodes.items()}
            return SimpleNamespace(result_set=[
                [eid] for eid, (s, t) in self.edges.items() if eid in params["_eids"]
                and ids.get(t if reverse else s) in params["_ids"]])
        raise AssertionError(cypher)


def _edge_provider(graph):
    return SimpleNamespace(
        _ro_query=lambda c, params=None, timeout=None: graph.run(c, params or {}),
        _get_containment_edge_types=lambda: ["CONTAINS"],
        _get_lineage_edge_types=lambda: ["FEEDS"],
        _entity_type_levels={}, _name_property=None,
    )


def _asked(*ids):
    from backend.common.models.search import SearchMembershipEdge
    graph_edges = {"e1": ("a1", "b1"), "e2": ("b2", "a2"), "e3": ("a1", "a2")}
    return [SearchMembershipEdge(id=e, source=graph_edges[e][0], target=graph_edges[e][1])
            for e in ids]


def _edge_statements(graph):
    return [s for s in graph.statements if "RETURN DISTINCT coalesce(" in s[0]]


async def _edge_members(graph, scope, items, edges):
    from backend.app.providers.falkordb_search.membership import evaluate_edge_membership
    return await evaluate_edge_membership(_edge_provider(graph), scope, items, edges,
                                          run=graph.run, timeout_s=1.0)


_NODES = {"a1": ("A", 1), "a2": ("A", 2), "b1": ("B", 11), "b2": ("B", 12), "root": ("A", 99)}
_EDGES = {"e1": ("a1", "b1"), "e2": ("b2", "a2"), "e3": ("a1", "a2")}


class TestEdgeMembershipStatement:
    async def test_each_relationship_is_sought_from_its_source_by_its_id(self):
        """The Connections search's own statement, from the relationships' sources — found by
        ID once, under the labels the scope reads — and each relationship by its id among
        their edges: an end of a type the view doesn't show anchors nothing."""
        graph = _EdgeGraph(_NODES, _EDGES)
        rule = P({"kind": "edges", "edgeTypes": ["FEEDS"],
                  "targetWhere": {"kind": "property", "key": "tier", "op": "eq", "value": "gold"},
                  "edgePredicate": {"kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}})
        scope = SearchScope(view_id="v", scope_mode="data_source", entity_types=["a"])
        out = await _edge_members(graph, scope, [("r", rule)], _asked("e1", "e2", "e3"))
        assert out["matches"] == {"r": ["e1", "e3"]} and out["errors"] == {}
        found = next(c for c, _ in graph.statements if "RETURN r.urn AS urn" in c)
        assert "MATCH (r:`A`)" in found and "(r:`B`)" not in found
        [(cypher, params)] = _edge_statements(graph)
        key = "coalesce(toString(e.id), n.urn + '|' + type(e) + '|' + m.urn)"
        assert cypher.startswith("UNWIND $_ids AS _ii MATCH (n) WHERE ID(n) = _ii AND n.urn IS NOT NULL")
        assert "WITH n MATCH (n)-[e:FEEDS]->(m) WHERE m.urn IS NOT NULL AND " in cypher
        assert f"{key} IN $_eids" in cypher and cypher.endswith(f"RETURN DISTINCT {key}")
        assert "m.`tier`" in cypher and "e.`mode`" in cypher     # To, and the edge filter
        assert params["_ids"] == [1] and params["_eids"] == ["e1", "e2", "e3"]
        assert params["_farLabels"] == ["a"]

    async def test_either_way_reads_a_second_pass_from_the_targets(self):
        graph = _EdgeGraph(_NODES, _EDGES)
        rule = P({"kind": "edges", "direction": "either",
                  "sourceWhere": {"kind": "entityType", "values": ["A"]}})
        out = await _edge_members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                                  [("r", rule)], _asked("e1", "e2"))
        assert out["matches"] == {"r": ["e1", "e2"]}
        first, second = _edge_statements(graph)
        assert "MATCH (n)-[e:FEEDS]->(m)" in first[0] and first[1]["_ids"] == [1, 12]
        assert "MATCH (n)<-[e:FEEDS]-(m)" in second[0] and second[1]["_ids"] == [2, 11]
        assert "coalesce(toString(e.id), m.urn + '|' + type(e) + '|' + n.urn)" in second[0]

    async def test_the_views_roots_clamp_the_anchor_and_bound_the_far_end(self):
        graph = _EdgeGraph(_NODES, _EDGES)
        scope = SearchScope(view_id="v", scope_mode="view", root_urns=["root"], max_depth=4)
        out = await _edge_members(graph, scope, [("r", P({"kind": "edges"}))], _asked("e1"))
        [(cypher, params)] = _edge_statements(graph)
        assert "WITH n MATCH (n)<-[:CONTAINS*0..4]-(_r0) WHERE ID(_r0) IN $_roots0" in cypher
        assert params["_roots0"] == [99] and params["_farRoots"] == [99]
        assert out["matches"] == {"r": ["e1"]}

    async def test_on_the_canvas_both_ends_must_be_on_it(self):
        graph = _EdgeGraph(_NODES, _EDGES)
        scope = SearchScope(view_id="v", scope_mode="visible", visible_urns=["a1", "b1"])
        out = await _edge_members(graph, scope, [("r", P({"kind": "edges"}))], _asked("e1", "e2"))
        [(cypher, params)] = _edge_statements(graph)
        assert params["_ids"] == [1] and "m.urn IN $_farUrns" in cypher
        assert out["matches"] == {"r": ["e1"]}

    async def test_a_rule_the_engine_cannot_compile_is_its_own_error(self):
        graph = _EdgeGraph(_NODES, _EDGES)
        bad = P({"kind": "edges", "targetWhere": {"kind": "text", "value": "^x", "match": "regex"}})
        out = await _edge_members(graph, SearchScope(view_id="v", scope_mode="data_source"),
                                  [("bad", bad), ("ok", P({"kind": "edges"}))], _asked("e1"))
        assert "bad" in out["errors"] and "bad" not in out["matches"]
        assert out["matches"] == {"ok": ["e1"]}


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

    async def test_edge_membership_is_the_connections_search_narrowed_to_the_edges_asked(self):
        from backend.common.models.search import SearchMembershipEdge
        stub = StubDeepSearchProvider(nodes=self.NODES, edges=[
            {"id": "e1", "source": "a", "target": "c", "type": "HAS"},
            {"id": "e2", "source": "b", "target": "c", "type": "HAS"},
            {"source": "a", "target": "b", "type": "JOINS"},
        ])
        rule = P({"kind": "edges", "sourceWhere": {"kind": "property", "key": "owner",
                                                    "op": "eq", "value": "x"}})
        asked = [SearchMembershipEdge(id=e, source=s, target=t)
                 for e, s, t in (("e1", "a", "c"), ("e2", "b", "c"), ("a|JOINS|b", "a", "b"))]
        out = await stub.deep_search_edge_membership(SearchScope(view_id="v"), [("r", rule)], asked)
        # One stored without an id is named by its ends and type, as an edge read names it.
        assert out["matches"] == {"r": ["e1", "a|JOINS|b"]}


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

    async def test_a_share_link_answers_rules_that_stay_in_the_view(self, monkeypatch):
        """A rule that follows lineage is refused on its own, in ``errors``;
        the other rules still colour the shared view."""
        sent = {}

        async def membership(self, scope, items, urns, *, context):
            sent["items"] = [i for i, _ in items]
            return {"matches": {i: [] for i, _ in items}, "errors": {}, "elapsedMs": 1}

        provider = SimpleNamespace(deep_search_membership=None)
        monkeypatch.setattr(graph_mod, "_statement_admission", lambda engine: None)

        async def version(engine):
            return "1"

        monkeypatch.setattr(graph_mod, "_search_data_version", version)

        async def rule_scope(self, requested, *, members=False):
            return requested, SimpleNamespace(scope_hash="h", member_scope=None)

        monkeypatch.setattr(AdvancedSearchService, "_rule_scope", rule_scope)
        monkeypatch.setattr(AdvancedSearchService, "_provider_op",
                            lambda self, name: membership.__get__(self))
        body = SearchMembershipRequest.model_validate({
            "scope": {"viewId": "view-1"}, "urns": ["u"],
            "items": [{"id": "plain", "predicate": {"kind": "all"}},
                      {"id": "hops", "predicate": {"kind": "group", "children": [
                          {"kind": "withinHops", "urns": ["urn:a"], "hops": 1}]}}]})
        out = await graph_mod.search_membership(
            body=body, request=_request("view-1"), ws_id="ws",
            engine=SimpleNamespace(provider=provider), session=None)
        assert sent["items"] == ["plain"]
        assert out.errors == {"hops": graph_mod.SHARED_LINK_RELATIONSHIPS}

    async def test_a_share_link_counts_only_rules_that_stay_in_the_view(self, monkeypatch):
        counted = []

        async def count(self, query, *, context, advance=True):
            counted.append(query.predicate.kind)
            return {"count": 3, "status": "complete", "sessionId": None, "progress": None}

        async def rule_scope(self, requested, *, members=False):
            return requested, SimpleNamespace(scope_hash="h", member_scope=None)

        async def version(engine):
            return "1"

        monkeypatch.setattr(AdvancedSearchService, "_rule_scope", rule_scope)
        monkeypatch.setattr(AdvancedSearchService, "_provider_op",
                            lambda self, name: count.__get__(self))
        monkeypatch.setattr(graph_mod, "_statement_admission", lambda engine: None)
        monkeypatch.setattr(graph_mod, "_search_data_version", version)
        body = SearchCountsRequest.model_validate({
            "scope": {"viewId": "view-1"},
            "items": [{"id": "plain", "predicate": {"kind": "all"}},
                      {"id": "hops", "predicate": {"kind": "group", "children": [
                          {"kind": "withinHops", "urns": ["urn:a"], "hops": 1}]}}]})
        out = await graph_mod.search_counts(
            body=body, request=_request("view-1"), ws_id="ws",
            engine=SimpleNamespace(provider=None), session=None)
        assert counted and set(counted) == {"all"}
        assert out.counts["plain"].count == 3
        assert out.counts["hops"].error == graph_mod.SHARED_LINK_RELATIONSHIPS

    async def test_resolving_names_keeps_a_share_link_in_its_view(self):
        body = SearchResolveRequest.model_validate({
            "scope": {"viewId": "view-1", "scopeMode": "data_source"},
            "refs": [{"path": ["Country"]}]})
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_resolve(
                body=body, request=_request("view-1"), ws_id="ws",
                engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 403

    async def test_resolving_names_runs_the_service_per_statement(self, monkeypatch):
        seen = {}

        async def resolve(self, body, *, run_context=None):
            seen["confined"], seen["context"] = self._confined, run_context
            from backend.common.models.search import SearchResolveResult
            return SearchResolveResult(results=[])

        monkeypatch.setattr(AdvancedSearchService, "resolve", resolve)
        monkeypatch.setattr(graph_mod, "_statement_admission", lambda engine: "admit")

        async def version(engine):
            return "9.g"

        monkeypatch.setattr(graph_mod, "_search_data_version", version)
        body = SearchResolveRequest.model_validate({
            "scope": {"viewId": "view-1"}, "refs": [{"path": ["Country"]}]})
        await graph_mod.search_resolve(body=body, request=_request("view-1"), ws_id="ws",
                                       engine=SimpleNamespace(provider=None), session=None)
        assert seen["confined"] is True
        assert seen["context"] == SearchRunContext(data_version="9.g", admit="admit")

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
