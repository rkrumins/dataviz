"""Subset views without a database or a graph: the definition, the layers a
subset shows (its own, or its base's by type), and the searches that fill them."""
import pytest
from pydantic import TypeAdapter, ValidationError

from backend.app.services import search_views as sv
from backend.app.services.view_placement import NodeFacts
from backend.common.models.search import (
    AncestorRef,
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
        by_name = sv.layer_filters_in_subset(PRED.validate_python(
            {"kind": "layer", "layerAssignment": "silver"}), layers)
        assert by_name == EntityTypePredicate(op="in", values=["dashboard"])
        nested = sv.layer_filters_in_subset(PRED.validate_python({"kind": "group", "op": "or", "children": [
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

    def test_levels_and_kinds_narrow_what_comes_with_them(self):
        definition = SearchViewDefinition.model_validate(_search(include={
            "contents": True, "contentsLevels": 2, "contentsKinds": ["column", "Column", "table"],
            "containers": True, "containersLevels": 1}))
        _matches, inside, contains = definition.search_predicate().children
        # Of the kinds named, the kind first, so another kind is never walked.
        kinds, related = inside.children
        assert inside.op == "and" and kinds.values == ["Column", "column", "table"]
        assert (related.axis, related.max_hops) == ("ancestor", 2)
        assert (contains.axis, contains.max_hops) == ("descendant", 1)
        sv.check_predicate(definition.search_predicate().model_dump(mode="json", by_alias=True, exclude_none=True))

    def test_every_level_stays_unset_so_existing_definitions_keep_their_hashes(self):
        before = SearchViewDefinition.model_validate(_search(include={"contents": True}))
        same = SearchViewDefinition.model_validate(_search(include={
            "contents": True, "contentsLevels": None, "contentsKinds": []}))
        assert same.definition_hash() == before.definition_hash()
        assert same.predicate_hash() == before.predicate_hash()
        assert "contentsLevels" not in before.model_dump(mode="json", by_alias=True, exclude_none=True)["include"]
        assert SearchViewDefinition.model_validate(_search(include={
            "contents": True, "contentsLevels": 20})).predicate_hash() != before.predicate_hash()

    def test_levels_and_kinds_go_with_their_choice(self):
        off = SearchViewDefinition.model_validate(_search(include={
            "contents": False, "contentsLevels": 2, "containersKinds": ["db"]}))
        assert off.include.contents_levels is None and off.include.containers_kinds is None
        assert off.definition_hash() == SearchViewDefinition.model_validate(_search()).definition_hash()
        with pytest.raises(ValidationError):
            SearchViewDefinition.model_validate(_search(include={"contents": True, "contentsLevels": 21}))

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


class TestFollowingTheBasesPlacement:
    """A subset that follows its base places its matches as the base's canvas
    does: by hand, by what children inherit, by stamps and by rules."""
    HAND = _config([{"id": "src", "name": "Source systems", "order": 0},
                    {"id": "rep", "name": "Reporting", "order": 1, "entityTypes": ["dashboard"]}],
                   assignments={"urn:db:oracle": {"layerId": "src"},
                                "urn:db:legacy": {"layerId": "src", "inheritsChildren": False}})

    def _layers(self, config=None):
        return {layer.id: layer for layer in sv.layers_of(config or self.HAND, add_rest=True)}

    def test_it_follows_a_base_that_has_layers(self):
        placement, why = sv.follow_placement(self.HAND)
        assert why is None and placement.spec.explicit["urn:db:oracle"].layer_id == "src"
        assert sv.follow_placement(_config([])) == (None, None)

    def test_each_layer_holds_what_the_base_places_there(self):
        placement, _ = sv.follow_placement(self.HAND)
        layers = self._layers()
        src = sv.layer_condition(layers["src"], placement)
        assert src._placement.layer_id == "src" and src._placement.digest == placement.digest
        assert sv.feed_predicate(PRED.validate_python(P), layers["src"], placement).children[0] is not None
        # Other matches: what it places in none of its layers.
        rest = sv.layer_condition(layers[REST_LAYER_ID], placement)
        assert rest.op == "not" and rest.children[0]._placement.layer_id is None
        # Any type its base reads can be placed in any layer.
        assert sv.scope_types(layers["src"], frozenset({"table", "db"}), placement) == ["db", "table"]
        assert sv.scope_types(layers["src"], frozenset(), placement) is None

    def test_a_base_fallback_layer_holds_what_it_draws(self):
        base = _config([{"id": "a", "entityTypes": ["t"]},
                        {"id": "u", "name": "Unplaced", "showUnassigned": True}])
        placement, _ = sv.follow_placement(base)
        layers = self._layers(base)
        assert set(layers) == {"a", "u"}
        assert sv.layer_condition(layers["u"], placement)._placement.layer_id == "u"

    def test_a_left_out_layer_leaves_out_what_the_base_places_there(self):
        placement, _ = sv.follow_placement(self.HAND)
        layers = [layer.model_copy(update={"hidden": layer.id in ("rep", REST_LAYER_ID)})
                  for layer in sv.layers_of(self.HAND, add_rest=True)]
        pii, no_rep, placed = sv.shown_search(PRED.validate_python(P), layers, placement).children
        assert pii == TagPredicate(values=["pii"])
        assert no_rep.op == "not" and no_rep.children[0]._placement.layer_id == "rep"
        # Leaving Other matches out keeps what the base places somewhere.
        assert placed._placement.layer_id is None

    def test_a_layer_filter_inside_is_where_the_base_places(self):
        placement, _ = sv.follow_placement(self.HAND)
        layers = list(self._layers().values())
        named = sv.layer_filters_in_subset(
            PRED.validate_python({"kind": "layer", "layerAssignment": "source systems"}),
            layers, placement)
        assert named._placement.layer_id == "src"
        other = sv.layer_filters_in_subset(
            PRED.validate_python({"kind": "layer", "layerAssignment": "Other matches"}),
            layers, placement)
        assert other.op == "not" and other.children[0]._placement.layer_id is None
        # The server's own, already resolved, stands.
        resolved = sv.placed_in(placement, None)
        assert sv.layer_filters_in_subset(resolved, layers, placement) is resolved

    def test_past_what_a_search_follows_it_places_by_type_and_says_why(self, monkeypatch):
        from backend.app.services import advanced_search_service as svc_mod
        monkeypatch.setattr(svc_mod, "LAYER_FILTER_MAX_HAND_PLACED", 1)
        placement, why = sv.follow_placement(self.HAND)
        assert placement is None and "places 2 entities by hand" in why and "by type" in why

    def test_its_digest_follows_what_places_and_not_how_it_looks(self):
        def digest(layers, assignments):
            return sv.follow_placement(_config(layers, assignments=assignments))[0].digest

        layers = [{"id": "src", "name": "Source systems", "order": 0},
                  {"id": "rep", "name": "Reporting", "order": 1, "entityTypes": ["dashboard"]}]
        placed = {"urn:db:oracle": {"layerId": "src"}}
        before = digest(layers, placed)
        looks = [{**layers[0], "name": "Sources", "color": "#f00", "width": 320}, layers[1]]
        assert digest(looks, {"urn:db:oracle": {"layerId": "src", "assignedAt": "2026-11-04"}}) == before
        assert digest(layers, {"urn:db:oracle": {"layerId": "rep"}}) != before
        assert digest([{**layers[0], "order": 2}, layers[1]], placed) != before
        ruled = [layers[0], {**layers[1], "rules": [{"id": "r", "tags": ["bi"]}]}]
        assert digest(ruled, placed) != before

    def test_the_boundary_hash_carries_the_placement(self):
        kw = {"view_id": "b", "data_source_id": "ds", "root_urns": [], "entity_types": [],
              "max_depth": 3, "predicate_hash": "p"}
        assert sv.boundary_hash(**kw) == sv.boundary_hash(**kw, placement="")
        assert sv.boundary_hash(**kw, placement="x") != sv.boundary_hash(**kw)


class TestWhereTheySit:
    """How many of a match's nearest containers its layer holds too: what the
    canvas draws it inside, as its base draws it."""

    @staticmethod
    def _ref(urn, kind, facts=True):
        ref = AncestorRef(urn=urn, display_name=urn, entity_type=kind)
        if facts:
            ref._facts = NodeFacts(urn=urn, entity_type=kind)
        return ref

    def test_placed_as_the_base_places_them(self):
        base = _config([{"id": "src", "name": "Source systems", "order": 0},
                        {"id": "rep", "name": "Reporting", "order": 1}],
                       assignments={"urn:db": {"layerId": "src"}, "urn:bi": {"layerId": "rep"}})
        placement, _ = sv.follow_placement(base)
        layers = {layer.id: layer for layer in sv.layers_of(base, add_rest=True)}
        r = self._ref
        paths = [
            [r("urn:db", "database"), r("urn:sales", "schema")],   # both in Source systems
            [r("urn:bi", "folder")],                                # in Reporting
            [r("urn:loose", "schema")],                             # placed nowhere
            [r("urn:db", "database"), r("urn:half", "schema", facts=False)],   # read in part
            [],                                                     # a root
        ]
        assert sv.containers_here(layers["src"], placement, paths) == [2, 0, 0, 0, 0]
        assert sv.containers_here(layers["rep"], placement, paths) == [0, 1, 0, 0, 0]
        assert sv.containers_here(layers[REST_LAYER_ID], placement, paths) == [0, 0, 1, 0, 0]

    def test_the_run_stops_at_the_first_container_in_another_layer(self):
        base = _config([{"id": "a", "order": 0}, {"id": "b", "order": 1}],
                       assignments={"urn:top": {"layerId": "a"}, "urn:mid": {"layerId": "b"},
                                    "urn:low": {"layerId": "a", "inheritsChildren": False}})
        placement, _ = sv.follow_placement(base)
        layer_a = next(layer for layer in sv.layers_of(base, add_rest=False) if layer.id == "a")
        r = self._ref
        path = [r("urn:top", "x"), r("urn:mid", "x"), r("urn:low", "x")]
        assert sv.containers_here(layer_a, placement, [path]) == [1]

    def test_placed_by_type_by_their_type_alone(self):
        own = _config([{"id": "t", "name": "Tables", "entityTypes": ["table"]},
                       {"id": "r", "name": "Rest", "showUnassigned": True}])
        layers = {layer.id: layer for layer in sv.layers_of(own, add_rest=False)}
        r = self._ref
        paths = [[r("urn:db", "database"), r("urn:t1", "Table")], [r("urn:t2", "table"), r("urn:s", "schema")]]
        assert sv.containers_here(layers["t"], None, paths) == [1, 0]
        assert sv.containers_here(layers["r"], None, paths) == [0, 1]
