"""Name references: an entity by its path of display names instead of its URN.

``Country / United Kingdom`` names an entity the same way in every
environment, so a saved query or rule that uses one keeps working after a
view or library moves. Here: the model's rules, what a reference names (the
stub's resolver is the reference semantics; ``tests/integration/
test_search_refs_live.py`` holds FalkorDB's to it), that a reference never
reaches the compiler unresolved, and the service resolving them for every
kind of request.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from backend.app.providers.falkordb_deep_search import _Compiler
from backend.app.services.advanced_search_service import (
    AdvancedSearchService,
    ValidationError,
)
from backend.app.services.deep_search import CompileError
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import (
    DescendantOfPredicate,
    NodeRef,
    PathPredicate,
    Predicate,
    SearchCountsRequest,
    SearchMembershipRequest,
    SearchQuery,
    SearchResolveRequest,
    SearchScope,
    WithinHopsPredicate,
)
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

P = TypeAdapter(Predicate).validate_python

NODES = [
    {"urn": "country", "entityType": "domain", "displayName": "Country"},
    {"urn": "uk", "entityType": "region", "displayName": "United Kingdom"},
    {"urn": "london-uk", "entityType": "city", "displayName": "London"},
    {"urn": "manchester", "entityType": "city", "displayName": "Manchester"},
    {"urn": "canada", "entityType": "region", "displayName": "Canada"},
    {"urn": "london-ca", "entityType": "city", "displayName": "London"},
    {"urn": "product", "entityType": "domain", "displayName": "Product"},
    {"urn": "uk2", "entityType": "region", "displayName": "United Kingdom"},
    {"urn": "sales", "entityType": "domain", "displayName": "Sales"},
    {"urn": "orders", "entityType": "dataset", "displayName": "orders", "tags": ["PII"]},
]
CONTAINS = [("country", "uk"), ("uk", "london-uk"), ("uk", "manchester"),
            ("country", "canada"), ("canada", "london-ca"), ("product", "uk2"),
            ("sales", "orders")]


def _stub(nodes=NODES, contains=CONTAINS) -> StubDeepSearchProvider:
    return StubDeepSearchProvider(
        nodes=nodes,
        edges=[{"source": s, "target": t, "type": "CONTAINS"} for s, t in contains])


def _scope(mode="data_source", roots=None) -> SearchScope:
    return SearchScope(view_id="v", scope_mode=mode, root_urns=roots)


async def _named(stub, path=None, scope=None, **ref):
    ref = NodeRef.model_validate({"path": path, **ref} if path else ref)
    [answer] = await stub.deep_search_resolve_refs(scope or _scope(), [ref])
    return answer


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------

class TestModel:
    def test_a_path_is_trimmed_and_reads_with_slashes(self):
        ref = NodeRef.model_validate({"path": [" Country ", "United Kingdom"],
                                      "entityType": "region"})
        assert ref.path == ["Country", "United Kingdom"]
        assert ref.label() == "Country / United Kingdom (region)"
        assert NodeRef(urn="urn:x").label() == "urn:x"

    @pytest.mark.parametrize("raw, why", [
        ({"urn": "u", "path": ["a"]}, "not both"),
        ({}, "not both"),
        ({"path": ["a", "**"]}, "ends with a name"),
        ({"path": ["**", "**", "a"]}, "twice in a row"),
        ({"path": ["**", "a"], "caseSensitive": False}, "compares names exactly"),
        ({"urn": "u", "entityType": "x"}, "apply to a path"),
        ({"path": ["   "]}, "1–256 characters"),
    ])
    def test_a_reference_takes_one_clear_form(self, raw, why):
        with pytest.raises(PydanticValidationError, match=why):
            NodeRef.model_validate(raw)

    def test_kinds_that_took_urns_take_references_instead(self):
        ref = {"path": ["Country"]}
        assert DescendantOfPredicate.model_validate({"refs": [ref]}).urns == []
        assert WithinHopsPredicate.model_validate({"refs": [ref], "hops": 1}).urns == []
        path = PathPredicate.model_validate({"sourceRefs": [ref], "targetUrns": ["u"]})
        assert path.source_urns == [] and path.target_urns == ["u"]

    @pytest.mark.parametrize("raw", [
        {"kind": "descendantOf"},
        {"kind": "withinHops", "hops": 1},
        {"kind": "path", "sourceUrns": ["a"]},
        {"kind": "path", "targetRefs": [{"path": ["a"]}]},
    ])
    def test_they_still_need_something_to_start_from(self, raw):
        with pytest.raises(PydanticValidationError, match="needs urns or refs"):
            P(raw)


# ---------------------------------------------------------------------------
# What a reference names (the reference semantics)
# ---------------------------------------------------------------------------

class TestWhatAReferenceNames:
    async def test_a_path_steps_down_from_a_top_level_entity(self):
        assert (await _named(_stub(), ["Country", "United Kingdom"]))["urns"] == ["uk"]

    async def test_a_path_starts_at_the_top(self):
        """"United Kingdom" alone is no top-level entity — there are two
        below others, and neither is named this way."""
        assert (await _named(_stub(), ["United Kingdom"]))["urns"] == []

    async def test_names_compare_exactly_unless_asked(self):
        assert (await _named(_stub(), ["country", "united kingdom"]))["urns"] == []
        answer = await _named(_stub(), ["country", "united kingdom"], caseSensitive=False)
        assert answer["urns"] == ["uk"]

    async def test_any_depth_and_the_type_narrowing_the_last_step(self):
        assert (await _named(_stub(), ["Country", "**", "London"]))["urns"] == [
            "london-ca", "london-uk"]
        assert (await _named(_stub(), ["Country", "**", "London"],
                             entityType="city"))["urns"] == ["london-ca", "london-uk"]
        assert (await _named(_stub(), ["Country", "**", "London"],
                             entityType="region"))["urns"] == []
        # "**" spans no levels too.
        assert (await _named(_stub(), ["Country", "**", "United Kingdom"]))["urns"] == ["uk"]

    async def test_a_leading_any_depth_starts_anywhere_in_scope(self):
        assert (await _named(_stub(), ["**", "United Kingdom"]))["urns"] == ["uk", "uk2"]
        in_view = await _named(_stub(), ["**", "United Kingdom"],
                               scope=_scope("view", roots=["country"]))
        assert in_view["urns"] == ["uk"]

    async def test_a_urn_names_itself(self):
        assert (await _named(_stub(), urn="anything"))["urns"] == ["anything"]

    async def test_too_many_is_refused_with_why(self):
        many = [{"urn": f"x{i}", "entityType": "t", "displayName": "x"} for i in range(70)]
        stub = _stub(NODES + many, CONTAINS + [("sales", f"x{i}") for i in range(70)])
        answer = await _named(stub, ["Sales", "x"])
        assert answer["urns"] == []
        assert "more than 64 entities" in answer["error"]

    async def test_a_share_link_is_kept_to_its_view(self):
        stub = _stub()
        view = _scope("view", roots=["country"])
        ref = NodeRef.model_validate({"path": ["Product", "United Kingdom"]})
        [open_answer] = await stub.deep_search_resolve_refs(view, [ref])
        [shared] = await stub.deep_search_resolve_refs(view, [ref], confined=True)
        assert open_answer["urns"] == ["uk2"] and shared["urns"] == []

    async def test_entities_come_with_their_containers_when_asked(self):
        ref = NodeRef.model_validate({"path": ["Country", "United Kingdom", "London"]})
        [answer] = await _stub().deep_search_resolve_refs(_scope(), [ref], with_paths=True)
        [entity] = answer["entities"]
        assert entity["displayName"] == "London"
        assert [a["displayName"] for a in entity["ancestorPath"]] == ["Country", "United Kingdom"]


# ---------------------------------------------------------------------------
# Never compiled unresolved
# ---------------------------------------------------------------------------

class TestCompiler:
    def test_is_tests_the_entity_itself(self):
        c = _Compiler()
        assert c.compile(P({"kind": "is", "refs": [{"urn": "a"}, {"urn": "b"}]})) == "n.urn IN $p0"
        assert c.params == {"p0": ["a", "b"]}

    @pytest.mark.parametrize("raw", [
        {"kind": "is", "refs": [{"path": ["Country"]}]},
        {"kind": "descendantOf", "refs": [{"path": ["Country"]}]},
        {"kind": "withinHops", "refs": [{"path": ["Country"]}], "hops": 1},
    ])
    def test_an_unresolved_path_is_refused_not_widened(self, raw):
        with pytest.raises(CompileError, match="was not resolved"):
            _Compiler(lineage_edge_types={"L"}, containment_edge_types={"C"}).compile(raw and P(raw))

    def test_urn_references_count_as_urns(self):
        c = _Compiler(containment_edge_types={"C"})
        c.compile(P({"kind": "descendantOf", "urns": ["a"], "refs": [{"urn": "b"}]}))
        assert c.hoisted_root_urns == [["a", "b"]]


# ---------------------------------------------------------------------------
# The service resolves them
# ---------------------------------------------------------------------------

def _eff(roots=()) -> EffectiveViewScope:
    return EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
        root_urns=tuple(roots), entity_type_allow_list=frozenset(),
        layer_allow_list=frozenset(), max_depth=12, scope_hash="h1")


def _service(provider, eff=None, confined=False) -> AdvancedSearchService:
    svc = AdvancedSearchService(SimpleNamespace(provider=provider), session=None,
                                workspace_id="ws", confined=confined)

    async def resolve(requested):
        return eff or _eff()

    async def guard(scope):
        return None

    svc._resolve_scope = resolve
    svc._guard_view_data_source = guard
    return svc


def _search(*children, results="hits") -> SearchQuery:
    return SearchQuery.model_validate({
        "predicate": {"kind": "group", "op": "and", "children": list(children)},
        "scope": {"viewId": "v"}, "options": {"results": results}})


class TestService:
    async def test_a_search_names_entities_and_says_what_each_reference_named(self):
        page, _ = await _service(_stub()).search(_search(
            {"kind": "is", "refs": [{"path": ["Country", "United Kingdom"]}]}))
        assert [h.node.urn for h in page.hits] == ["uk"]
        [resolved] = page.scope_diagnostics.resolved_refs
        assert (resolved.at, resolved.ref, resolved.count, resolved.ambiguous) == (
            "$.children[0].refs[0]", "Country / United Kingdom", 1, False)
        assert [s.display_name for s in resolved.samples] == ["United Kingdom"]

    async def test_a_reference_naming_nothing_matches_nothing(self):
        page, _ = await _service(_stub()).search(_search(
            {"kind": "is", "refs": [{"path": ["Nowhere"]}]}))
        assert page.hits == []
        assert page.scope_diagnostics.resolved_refs[0].count == 0

    async def test_an_ambiguous_reference_names_every_match(self):
        page, _ = await _service(_stub()).search(_search(
            {"kind": "is", "refs": [{"path": ["**", "London"]}]}))
        assert sorted(h.node.urn for h in page.hits) == ["london-ca", "london-uk"]
        assert page.scope_diagnostics.resolved_refs[0].ambiguous is True

    async def test_a_reference_naming_too_many_is_a_400_saying_where(self):
        many = [{"urn": f"x{i}", "entityType": "t", "displayName": "x"} for i in range(70)]
        stub = _stub(NODES + many, CONTAINS + [("sales", f"x{i}") for i in range(70)])
        with pytest.raises(ValidationError, match=r"\$\.children\[1\]\.refs\[0\].*more than 64"):
            await _service(stub).search(_search(
                {"kind": "all"}, {"kind": "is", "refs": [{"path": ["Sales", "x"]}]}))

    async def test_rules_use_references_too(self):
        svc = _service(_stub())
        rule = {"kind": "group", "children": [
            {"kind": "is", "refs": [{"path": ["Country", "**", "London"]}]}]}
        membership = await svc.membership(SearchMembershipRequest.model_validate({
            "scope": {"viewId": "v"}, "urns": ["london-uk", "manchester"],
            "items": [{"id": "r", "predicate": rule}]}))
        assert membership.matches == {"r": ["london-uk"]}
        counts = await svc.counts(SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"}, "items": [{"id": "r", "predicate": rule}]}))
        assert counts.counts["r"].count == 2

    async def test_a_rules_unusable_reference_is_its_own_error(self):
        many = [{"urn": f"x{i}", "entityType": "t", "displayName": "x"} for i in range(70)]
        stub = _stub(NODES + many, CONTAINS + [("sales", f"x{i}") for i in range(70)])
        counts = await _service(stub).counts(SearchCountsRequest.model_validate({
            "scope": {"viewId": "v"},
            "items": [{"id": "bad", "predicate": {"kind": "is", "refs": [{"path": ["Sales", "x"]}]}},
                      {"id": "fine", "predicate": {"kind": "all"}}]}))
        assert "more than 64" in counts.counts["bad"].error
        assert counts.counts["fine"].count == len(NODES) + 70

    async def test_resolve_lists_matches_with_their_containers(self):
        result = await _service(_stub()).resolve(SearchResolveRequest.model_validate({
            "scope": {"viewId": "v"},
            "refs": [{"path": ["**", "London"]}, {"path": ["Nowhere"]}]}))
        found, missing = result.results
        assert found.count == 2 and missing.count == 0
        paths = sorted([a.display_name for a in m.ancestor_path] for m in found.matches)
        assert paths == [["Country", "Canada"], ["Country", "United Kingdom"]]

    async def test_a_share_link_resolves_inside_its_view(self):
        svc = _service(_stub(), eff=_eff(roots=["country"]), confined=True)
        result = await svc.resolve(SearchResolveRequest.model_validate({
            "scope": {"viewId": "v"}, "refs": [{"path": ["Product", "United Kingdom"]}]}))
        assert result.results[0].count == 0
