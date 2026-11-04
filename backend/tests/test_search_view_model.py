"""Subset views without a database or a graph: the definition, the layers a
subset shows (its own, or its base's by type), and the searches that fill them."""
import pytest
from pydantic import TypeAdapter, ValidationError

from backend.app.services import search_views as sv
from backend.common.models.search import (
    EdgesPredicate,
    EntityTypePredicate,
    GroupPredicate,
    MatchAllPredicate,
    PathPredicate,
    Predicate,
    RelatedPredicate,
    TagPredicate,
)
from backend.common.models.search_view import (
    REST_LAYER_ID,
    FromSearchRequest,
    SearchViewDefinition,
    read_search_definition,
)

P = {"kind": "tag", "values": ["pii"]}
PRED = TypeAdapter(Predicate)


def _config(layers, *, assignments=None, search=None, **extra):
    config = {"layout": {"referenceLayout": {"layers": layers, "assignments": assignments or {}}},
              **extra}
    if search is not None:
        config["search"] = search
    return config


def _search(**over):
    return {"v": 1, "predicate": P, "within": "view", "readIn": "base", "layout": "inherit", **over}


BASE = _config([
    {"id": "b", "name": "Bronze", "order": 0, "color": "#a", "entityTypes": ["dataset", "table"]},
    {"id": "s", "name": "Silver", "order": 1, "entityTypes": ["Dataset", "dashboard"],
     "nodeSortMode": "custom", "width": 300},
    {"id": "g", "name": "Gold", "order": 2, "entityTypes": ["chart"], "rules": [
        {"id": "r", "tags": ["gold"]}], "anchorUrn": "urn:x"},
])


class TestDefinition:
    def test_a_subset_of_a_view_names_it_and_a_whole_source_search_does_not(self):
        SearchViewDefinition.model_validate(_search())
        with pytest.raises(ValidationError, match="readIn"):
            SearchViewDefinition.model_validate(_search(readIn=None))
        with pytest.raises(ValidationError, match="no base view"):
            SearchViewDefinition.model_validate(_search(within="dataSource", layout="own"))
        with pytest.raises(ValidationError, match="follow"):
            SearchViewDefinition.model_validate(_search(within="dataSource", readIn=None))
        SearchViewDefinition.model_validate(_search(within="dataSource", readIn=None, layout="own"))

    def test_hashes(self):
        one = SearchViewDefinition.model_validate(_search())
        same = SearchViewDefinition.model_validate(_search())
        other_base = SearchViewDefinition.model_validate(_search(readIn="other"))
        other_search = SearchViewDefinition.model_validate(_search(predicate={"kind": "tag", "values": ["x"]}))
        assert one.definition_hash() == same.definition_hash()
        assert one.definition_hash() != other_base.definition_hash()
        assert one.predicate_hash() == other_base.predicate_hash()
        assert one.predicate_hash() != other_search.predicate_hash()

    def test_read_search_definition(self):
        assert read_search_definition({}) is None
        assert read_search_definition({"search": {"v": 9}}) is None
        assert read_search_definition({"search": _search()}).read_in == "base"

    def test_from_search_request_layers_go_with_an_own_layout(self):
        body = {"name": "PII", "workspaceId": "ws", "predicate": P, "readIn": "base"}
        assert FromSearchRequest.model_validate(body).layout == "inherit"
        with pytest.raises(ValidationError, match="layout 'own'"):
            FromSearchRequest.model_validate({**body, "layers": [{"name": "T", "entityTypes": ["t"]}]})
        with pytest.raises(ValidationError, match="needs a layer"):
            FromSearchRequest.model_validate({**body, "layout": "own", "rest": None})


class TestCheckPredicate:
    def test_a_rule_shaped_search_is_kept(self):
        assert isinstance(sv.check_predicate(P), TagPredicate)

    @pytest.mark.parametrize("raw, words", [
        ({"kind": "layer", "layerAssignment": "Gold"}, "filter by layer"),
        ({"kind": "group", "op": "and", "children": [{"kind": "layer", "layerAssignment": "g"}]},
         "filter by layer"),
        ({"kind": "edges", "sourceWhere": P}, "edges"),
        ({"kind": "withinHops", "urns": ["urn:a"], "hops": 2}, "route"),
        ({"kind": "nope"}, "invalid predicate"),
    ])
    def test_refusals_say_why(self, raw, words):
        with pytest.raises(sv.SubsetError) as exc:
            sv.check_predicate(raw)
        assert exc.value.status == 422
        assert words in exc.value.detail


class TestLayers:
    def test_each_type_has_one_owner_the_first_in_board_order(self):
        layers = {layer.id: layer for layer in sv.layers_of(BASE, add_rest=True)}
        assert layers["b"].entity_types == ["dataset", "table"]
        assert layers["s"].entity_types == ["dashboard"]        # Dataset is Bronze's
        assert layers["g"].entity_types == ["chart"]
        rest = layers[REST_LAYER_ID]
        assert rest.rest and rest.name == "Other matches"
        assert rest.excluded_types == ["dataset", "table", "dashboard", "chart"]

    def test_board_order_is_order_then_position(self):
        config = _config([{"id": "late", "order": 5, "entityTypes": ["t"]},
                          {"id": "early", "order": 1, "entityTypes": ["t"]}])
        layers = {layer.id: layer for layer in sv.layers_of(config, add_rest=False)}
        assert layers["early"].entity_types == ["t"] and layers["late"].entity_types == []

    def test_the_base_fallback_layer_is_the_rest_and_keeps_its_own_types(self):
        config = _config([{"id": "a", "entityTypes": ["t"]},
                          {"id": "u", "name": "Unplaced", "showUnassigned": True, "entityTypes": ["v"]}])
        layers = sv.layers_of(config, add_rest=True)
        assert [layer.id for layer in layers] == ["a", "u"]
        assert layers[1].rest and layers[1].excluded_types == ["t"]

    def test_places_by_more_than_type(self):
        assert sv.places_by_more_than_type(BASE)                     # Gold's rule and anchor
        typed = _config([{"id": "a", "entityTypes": ["t"]}])
        assert not sv.places_by_more_than_type(typed)
        assert sv.places_by_more_than_type(_config([{"id": "a", "entityTypes": ["t"]}],
                                                   assignments={"urn:1": {"layerId": "a"}}))
        assert sv.places_by_more_than_type(_config([{"id": "a", "logicalNodes": [{"id": "n"}]}]))

    def test_a_followed_layout_looks_like_the_base_and_holds_by_type(self):
        base = {**BASE, "layout": {"referenceLayout": {
            **BASE["layout"]["referenceLayout"], "displayRules": [{"id": "d"}],
            "defaultNodeSortMode": "alpha-desc"}}}
        followed = sv.followed_reference_layout(base)
        by_id = {layer["id"]: layer for layer in followed["layers"]}
        assert list(by_id) == ["b", "s", "g", REST_LAYER_ID]
        assert by_id["b"] == {"id": "b", "name": "Bronze", "order": 0, "color": "#a",
                              "entityTypes": ["dataset", "table"]}
        assert by_id["s"] == {"id": "s", "name": "Silver", "order": 1, "width": 300,
                              "entityTypes": ["dashboard"]}           # no custom order
        assert "rules" not in by_id["g"] and "anchorUrn" not in by_id["g"]
        assert by_id[REST_LAYER_ID]["showUnassigned"] is True and by_id[REST_LAYER_ID]["order"] == 3
        assert followed["assignments"] == {}
        assert followed["displayRules"] == [{"id": "d"}]
        assert followed["defaultNodeSortMode"] == "alpha-desc"

    def test_served_config(self):
        base = {**BASE, "entityOverrides": {"table": {"color": "red"}},
                "content": {"visibleRelationshipTypes": ["FEEDS"]}}
        mine = _config([], search=_search(), content={"entityScope": "all"})
        served = sv.served_config(mine, base)
        assert [layer["id"] for layer in served["layout"]["referenceLayout"]["layers"]][:3] == ["b", "s", "g"]
        assert served["entityOverrides"] == {"table": {"color": "red"}}
        assert served["content"] == {"entityScope": "all", "visibleRelationshipTypes": ["FEEDS"]}
        assert mine["layout"]["referenceLayout"]["layers"] == []             # not mutated
        gone = sv.served_config(mine, None)
        assert gone["layout"]["referenceLayout"] == {"layers": [], "assignments": {}}
        own = _config([{"id": "t", "entityTypes": ["t"]}], search=_search(layout="own"))
        assert sv.served_config(own, base) is own

    def test_own_layers_store_type_layers(self):
        stored = sv.own_layers(sv.layers_of(BASE, add_rest=True))
        assert stored[1] == {"id": "s", "name": "Silver", "order": 1, "entityTypes": ["dashboard"]}
        assert stored[-1]["showUnassigned"] is True and stored[-1]["entityTypes"] == []


class TestLayoutProblems:
    def own(self, layers, **kw):
        return _config(layers, search=_search(layout="own"), **kw)

    def test_a_followed_layout_stores_no_layers(self):
        assert sv.layout_problems(_config([], search=_search())) is None
        assert "base view" in sv.layout_problems(_config([{"id": "a"}], search=_search()))

    def test_an_own_layout_holds_type_layers_alone(self):
        assert sv.layout_problems(self.own([{"id": "a", "entityTypes": ["t"]},
                                            {"id": "r", "showUnassigned": True}])) is None

    @pytest.mark.parametrize("layers, assignments, words", [
        ([{"id": "a", "rules": [{"tags": ["x"]}]}], None, "rule"),
        ([{"id": "a", "logicalNodes": [{"id": "n"}]}], None, "groups"),
        ([{"id": "a", "anchorUrn": "urn:x"}], None, "anchored"),
        ([{"id": "a", "nodeSortMode": "custom"}], None, "custom order"),
        ([{"id": "a", "entityTypes": [f"t{i}" for i in range(33)]}], None, "33 types"),
        ([{"id": f"l{i}", "entityTypes": [f"t{i}"]} for i in range(13)], None, "at most 12"),
        ([{"id": "a", "showUnassigned": True}, {"id": "b", "showUnassigned": True}], None, "one layer"),
        ([{"id": "a", "entityTypes": ["t"]}], {"urn:1": {"layerId": "a"}}, "by hand"),
    ])
    def test_refusals(self, layers, assignments, words):
        assert words in sv.layout_problems(self.own(layers, assignments=assignments))


class TestSearches:
    LAYERS = {layer.id: layer for layer in sv.layers_of(BASE, add_rest=True)}

    def test_a_layer_reads_its_types(self):
        p = sv.check_predicate(P)
        fed = sv.feed_predicate(p, self.LAYERS["s"])
        assert isinstance(fed, GroupPredicate) and fed.op == "and"
        assert fed.children[0] == p
        assert fed.children[1] == EntityTypePredicate(op="in", values=["dashboard"])

    def test_the_rest_reads_every_type_the_others_do_not(self):
        p = sv.check_predicate(P)
        fed = sv.feed_predicate(p, self.LAYERS[REST_LAYER_ID])
        assert fed.children[1] == EntityTypePredicate(
            op="notIn", values=["dataset", "table", "dashboard", "chart"])
        lone = sv.layers_of(_config([]), add_rest=True)[0]
        assert sv.feed_predicate(p, lone) == p

    def test_a_layer_owning_nothing_holds_nothing(self):
        empty = sv.layers_of(_config([{"id": "a"}]), add_rest=False)[0]
        assert sv.feed_predicate(sv.check_predicate(P), empty) is None

    def test_types_past_one_leaf_chunk(self):
        types = [f"t{i}" for i in range(40)]
        assert [len(c.values) for c in sv.types_in(types).children] == [32, 8]
        assert sv.types_in(types).op == "or"
        assert sv.types_not_in(types).op == "and"

    def test_scope_types_prune_to_the_boundary(self):
        boundary = frozenset({"dataset", "Dashboard", "column"})
        assert sv.scope_types(self.LAYERS["b"], boundary) == ["dataset"]
        assert sv.scope_types(self.LAYERS["s"], boundary) == ["dashboard"]
        assert sv.scope_types(self.LAYERS["g"], boundary) == []
        assert sv.scope_types(self.LAYERS[REST_LAYER_ID], boundary) == ["column"]
        assert sv.scope_types(self.LAYERS[REST_LAYER_ID], frozenset()) is None
        assert sv.scope_types(self.LAYERS["b"], frozenset()) == ["dataset", "table"]

    def test_with_boundary(self):
        p = sv.check_predicate(P)
        q = PRED.validate_python({"kind": "entityType", "values": ["table"]})
        both = sv.with_boundary(q, p)
        assert both.op == "and" and both.children == [q, p]
        assert sv.with_boundary(MatchAllPredicate(), p) == p
        edges = sv.with_boundary(EdgesPredicate(source_where=q), p)
        assert edges.source_where.children == [q, p] and edges.target_where == p
        path = sv.with_boundary(PathPredicate(source_urns=["urn:a"], target_where=q), p)
        assert path.source_where == p and path.target_where.children == [q, p]

    def test_a_layer_filter_is_the_types_the_layer_holds(self):
        layers = list(self.LAYERS.values())
        by_name = sv.layer_filter_as_types(PRED.validate_python(
            {"kind": "layer", "layerAssignment": "silver"}), layers)
        assert by_name == EntityTypePredicate(op="in", values=["dashboard"])
        nested = sv.layer_filter_as_types(PRED.validate_python({"kind": "group", "op": "or", "children": [
            {"kind": "layer", "layerAssignment": REST_LAYER_ID},
            {"kind": "related", "axis": "parent", "where": {"kind": "layer", "layerAssignment": "nope"}},
        ]}), layers)
        assert nested.children[0].op == "notIn"
        assert nested.children[1].where == sv.NOTHING

    def test_boundary_hash(self):
        a = sv.boundary_hash(view_id="v", data_source_id="d", root_urns=["b", "a"],
                             entity_types=["T", "s"], max_depth=12, predicate_hash="p")
        b = sv.boundary_hash(view_id="v", data_source_id="d", root_urns=["a", "b"],
                             entity_types=["s", "t"], max_depth=12, predicate_hash="p")
        assert a == b and a.startswith("sv")
        assert a != sv.boundary_hash(view_id="v", data_source_id="d", root_urns=["a", "b"],
                                     entity_types=["s", "t"], max_depth=12, predicate_hash="q")



class TestIncludeAndHiddenLayers:
    """What a subset keeps beside its matches, as one search; and the base layers
    a following subset leaves out, with their matches."""

    def test_just_the_matches_is_the_search_itself(self):
        definition = SearchViewDefinition.model_validate(_search())
        assert definition.search_predicate() == definition.predicate

    def test_each_inclusion_is_one_relationship_to_a_match(self):
        definition = SearchViewDefinition.model_validate(_search(include={
            "contents": True, "containers": True, "upstream": True, "downstream": True}))
        found = definition.search_predicate()
        assert isinstance(found, GroupPredicate) and found.op == "or"
        matches, *related = found.children
        assert matches == definition.predicate
        assert [r.axis for r in related] == ["ancestor", "descendant", "downstream", "upstream"]
        assert all(r.max_hops is None for r in related)
        inside, contains, feeds, fed = related
        assert inside.where == contains.where == definition.predicate
        # A lineage step is taken from a match or anything inside it, as a trace walks a container.
        reach = GroupPredicate(op="or", children=[definition.predicate,
                                                  RelatedPredicate(axis="ancestor", where=definition.predicate)])
        assert feeds.where == fed.where == reach

    def test_what_it_includes_is_part_of_what_it_shares_scans_by(self):
        plain = SearchViewDefinition.model_validate(_search())
        inside = SearchViewDefinition.model_validate(_search(include={"contents": True}))
        assert plain.predicate_hash() != inside.predicate_hash()
        assert plain.definition_hash() != inside.definition_hash()

    def test_every_inclusion_is_a_search_a_subset_keeps(self):
        definition = SearchViewDefinition.model_validate(_search(include={
            "contents": True, "containers": True, "upstream": True, "downstream": True}))
        sv.check_predicate(definition.search_predicate().model_dump(mode="json", by_alias=True, exclude_none=True))

    def test_a_one_step_lineage_search_can_include_a_step_more(self):
        # Each relationship is one step, asked of one entity: the rules a subset keeps allow the chain.
        one_step = {"kind": "related", "axis": "upstream", "where": P}
        definition = SearchViewDefinition.model_validate(_search(predicate=one_step, include={"downstream": True}))
        sv.check_predicate(definition.search_predicate().model_dump(mode="json", by_alias=True, exclude_none=True))

    def test_only_a_following_subset_hides_layers(self):
        with pytest.raises(ValidationError, match="follows its base"):
            SearchViewDefinition.model_validate(_search(within="dataSource", readIn=None, layout="own",
                                                        hiddenLayers=["b"]))
        with pytest.raises(ValidationError, match="leaving"):
            FromSearchRequest.model_validate({"name": "x", "workspaceId": "w", "predicate": P, "readIn": "base",
                                              "layout": "own", "layers": [{"name": "T", "entityTypes": ["table"]}],
                                              "hiddenLayers": ["layer-1"]})

    def test_hidden_layers_are_marked_and_left_out_of_what_it_shows(self):
        definition = SearchViewDefinition.model_validate(_search(hiddenLayers=["s"]))
        layers = sv.subset_layers(definition, {}, BASE)
        assert [(l.id, l.hidden) for l in layers] == [
            ("b", False), ("s", True), ("g", False), (REST_LAYER_ID, False)]
        assert [l.id for l in sv.shown_layers(layers)] == ["b", "g", REST_LAYER_ID]
        served = sv.followed_reference_layout(BASE, definition.hidden_layers)
        assert [l["id"] for l in served["layers"]] == ["b", "g", REST_LAYER_ID]

    def test_a_hidden_layers_matches_are_left_out_and_others_still_fall_to_the_rest(self):
        definition = SearchViewDefinition.model_validate(_search(hiddenLayers=["s"]))
        layers = sv.subset_layers(definition, {}, BASE)
        found = sv.shown_search(definition.predicate, layers)
        # Silver owns "dashboard" (Bronze owns dataset): its matches go; the rest still takes the others.
        assert found == sv._and(definition.predicate, sv.types_not_in(["dashboard"]))

    def test_with_the_rest_hidden_only_the_shown_columns_types_are_found(self):
        definition = SearchViewDefinition.model_validate(_search(hiddenLayers=[REST_LAYER_ID]))
        layers = sv.subset_layers(definition, {}, BASE)
        found = sv.shown_search(definition.predicate, layers)
        assert found == sv._and(definition.predicate, sv.types_in(["dataset", "table", "dashboard", "chart"]))

    def test_what_can_be_hidden(self):
        layers = sv.layers_of(BASE, add_rest=True)
        assert sv.hidden_layer_problems(["s"], layers) is None
        assert "no layer 'x'" in sv.hidden_layer_problems(["x"], layers)
        assert "at least one" in sv.hidden_layer_problems(["b", "s", "g", REST_LAYER_ID], layers)
