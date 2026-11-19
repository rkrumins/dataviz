"""A subset view's scope: its base's, read as the system, with its search added
to every search in it — and nothing of the base shown to a reader who can't
open it."""
from __future__ import annotations

import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.advanced_search_service import (
    SUBSET_BASE_HIDDEN,
    AdvancedSearchService,
    ValidationError,
)
from backend.app.services.view_scope import ViewNotFound, ViewScopeError, ViewScopeResolver
from backend.common.models.search import (
    EntityTypePredicate,
    GroupPredicate,
    LayerPredicate,
    SearchCountsRequest,
    SearchOptions,
    SearchQuery,
    SearchResultPage,
    SearchRuleItem,
    SearchScope,
    TagPredicate,
    TextPredicate,
)
from backend.app.services import search_views as sv
from backend.common.models.search_view import REST_LAYER_ID

P = {"kind": "tag", "values": ["pii"]}
BASE_CONFIG = {
    "layoutType": "reference",
    "content": {"entityScope": "curated"},
    "referenceLayout": {
        "layers": [
            {"id": "t", "name": "Tables", "order": 0, "entityTypes": ["table"]},
            {"id": "d", "name": "Dashboards", "order": 1, "entityTypes": ["dashboard"]},
        ],
        "assignments": {"urn:db:A": {"layerId": "t"}, "urn:db:B": {"layerId": "d"}},
    },
}


async def _ws(session: AsyncSession, name: str = "WS") -> WorkspaceORM:
    ws = WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


async def _view(session, ws, config, *, ds="ds1", deleted=False, draft=None, name="V") -> ViewORM:
    view = ViewORM(name=name, workspace_id=ws.id, data_source_id=ds, view_type="reference",
                   config=json.dumps(config), draft_branch_id=draft,
                   deleted_at="2026-05-20T00:00:00Z" if deleted else None)
    session.add(view)
    await session.flush()
    return view


def _subset(base_id, predicate=None, **over):
    return {"layoutType": "reference", "content": {"entityScope": "all"},
            "layout": {"referenceLayout": {"layers": [], "assignments": {}}},
            "search": {"v": 1, "predicate": predicate or P, "within": "view", "readIn": base_id,
                       "layout": "inherit", **over}}


async def _resolve(session, ws, view, **kw):
    return await ViewScopeResolver(session).resolve(
        workspace_id=ws.id, requested=SearchScope(view_id=view.id, **kw.pop("scope", {})), **kw)


def _placed(p):
    """A layer filter resolved against the base: the layer its placement names
    (None: any of the base's layers)."""
    assert isinstance(p, LayerPredicate) and p._placement is not None, p
    return p._placement.layer_id


def _not(p):
    assert isinstance(p, GroupPredicate) and p.op == "not" and len(p.children) == 1, p
    return p.children[0]


class TestResolver:
    async def test_a_subset_of_a_view_that_holds_nothing_holds_nothing(self, db_session):
        # Its base is curated with nothing placed: its scope is empty, never the
        # whole data source with the subset's search over it.
        ws = await _ws(db_session)
        base = await _view(db_session, ws, {
            "layoutType": "reference", "content": {"entityScope": "curated"},
            "layout": {"referenceLayout": {"layers": [{"id": "s", "name": "Stages"}],
                                           "assignments": {}}}})
        sub = await _view(db_session, ws, _subset(base.id))
        eff = await _resolve(db_session, ws, sub)
        assert eff.holds_nothing and eff.root_urns == ()
        full = await _view(db_session, ws, _subset((await _view(db_session, ws, BASE_CONFIG)).id))
        assert not (await _resolve(db_session, ws, full)).holds_nothing

    async def test_the_base_scope_and_layers_read_as_the_system(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        sub = await _view(db_session, ws, _subset(base.id))
        eff = await _resolve(db_session, ws, sub)
        assert sorted(eff.root_urns) == ["urn:db:A", "urn:db:B"]
        assert eff.entity_type_allow_list == frozenset({"table", "dashboard"})
        assert eff.read_in_view_id == base.id and eff.placement is None
        assert [layer.id for layer in eff.subset_layers] == ["t", "d", REST_LAYER_ID]
        assert eff.layers[0] == ("t", "Tables")
        assert eff.search == TagPredicate(values=["pii"])
        assert eff.scope_hash.startswith("sv") and not eff.redact_roots

    async def test_the_hash_is_the_base_scope_and_the_search_never_a_save(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        one = await _view(db_session, ws, _subset(base.id))
        two = await _view(db_session, ws, _subset(base.id), name="Another")
        other = await _view(db_session, ws, _subset(base.id, {"kind": "tag", "values": ["x"]}))
        h1 = (await _resolve(db_session, ws, one)).scope_hash
        assert h1 == (await _resolve(db_session, ws, two)).scope_hash
        assert h1 != (await _resolve(db_session, ws, other)).scope_hash
        base.updated_at, one.updated_at = "2030-01-01", "2030-01-01"
        base.name = "Renamed"
        await db_session.flush()
        assert (await _resolve(db_session, ws, one)).scope_hash == h1

    async def test_a_base_too_large_to_list_its_members_is_searched_by_them(self, db_session,
                                                                          monkeypatch):
        """Past the root cap a base made from a query bounds its subsets by its members,
        where it keeps them — and a new answer of them is a new scope to scan."""
        from backend.app.db.repositories import view_members_repo, view_membership_repo
        from backend.app.services.deep_search import get_deep_search_settings
        from backend.app.services.view_scope import MemberScope

        ws = await _ws(db_session)
        base = await _view(db_session, ws, {
            **BASE_CONFIG, "membership": {"v": 1, "mode": "live",
                                          "sources": [{"spec": {"seeds": {"urns": ["urn:s"]}}}]}})
        state = await view_membership_repo.ensure(db_session, base)
        for epoch in (1, 2):
            await view_members_repo.insert(db_session, [
                {"view_id": base.id, "epoch": epoch, "urn": f"urn:m{i}", "layer_id": "t",
                 "sort_key": f"m{i}", "ord": i, "label": "Table", "label_ord": i,
                 "whole": False, "covered": False} for i in range(3)])
        state.epoch = state.members_epoch = 1
        state.member_count = 3
        await db_session.flush()
        sub = await _view(db_session, ws, _subset(base.id))
        monkeypatch.setenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", "2")
        get_deep_search_settings.cache_clear()
        try:
            eff = await _resolve(db_session, ws, sub)
            assert eff.member_scope == MemberScope(base.id, 1, 3)
            assert sorted(eff.root_urns) == ["urn:db:A", "urn:db:B"] and not eff.holds_nothing
            state.members_epoch = 2
            await db_session.flush()
            assert (await _resolve(db_session, ws, sub)).scope_hash != eff.scope_hash
        finally:
            monkeypatch.delenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP")
            get_deep_search_settings.cache_clear()

    @pytest.mark.parametrize("trouble", ["deleted", "other_ws", "subset", "draft", "other_ds", "self"])
    async def test_without_its_base_there_is_nothing_to_look_in(self, db_session, trouble):
        ws = await _ws(db_session)
        if trouble == "other_ws":
            base = await _view(db_session, await _ws(db_session, "Other"), BASE_CONFIG)
        elif trouble == "subset":
            real = await _view(db_session, ws, BASE_CONFIG)
            base = await _view(db_session, ws, _subset(real.id))
        else:
            base = await _view(db_session, ws, BASE_CONFIG, deleted=trouble == "deleted",
                               draft="br1" if trouble == "draft" else None,
                               ds="ds2" if trouble == "other_ds" else "ds1")
        sub = await _view(db_session, ws, _subset(base.id))
        if trouble == "self":
            sub.config = json.dumps(_subset(sub.id))
            await db_session.flush()
        with pytest.raises(ViewScopeError) as exc:
            await _resolve(db_session, ws, sub)
        assert exc.value.reason == "base_missing"

    async def test_an_unreadable_search_is_refused_never_widened(self, db_session):
        ws = await _ws(db_session)
        sub = await _view(db_session, ws, {"search": {"v": 9}})
        with pytest.raises(ViewScopeError) as exc:
            await _resolve(db_session, ws, sub)
        assert exc.value.reason == "subset_unreadable"

    async def test_a_reader_of_the_subset_alone_gets_its_base_redacted(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        sub = await _view(db_session, ws, _subset(base.id))

        async def only_the_subset(view):
            return view.id == sub.id

        eff = await _resolve(db_session, ws, sub, can_read=only_the_subset)
        assert eff.redact_roots

        async def neither(view):
            return False

        with pytest.raises(ViewNotFound):
            await _resolve(db_session, ws, sub, can_read=neither)

    async def test_a_whole_data_source_subset_has_no_roots_and_its_own_layers(self, db_session):
        ws = await _ws(db_session)
        config = {"layoutType": "reference", "content": {"entityScope": "all"},
                  "layout": {"referenceLayout": {"layers": [
                      {"id": "x", "name": "Tables", "entityTypes": ["table"]},
                      {"id": "r", "name": "Rest", "showUnassigned": True}]}},
                  "search": {"v": 1, "predicate": P, "within": "dataSource", "layout": "own"}}
        eff = await _resolve(db_session, ws, await _view(db_session, ws, config))
        assert eff.root_urns == () and eff.entity_type_allow_list == frozenset()
        assert [(layer.id, layer.rest) for layer in eff.subset_layers] == [("x", False), ("r", True)]


    async def test_what_it_includes_is_part_of_every_search_in_it(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        plain = await _view(db_session, ws, _subset(base.id))
        inside = await _view(db_session, ws, _subset(base.id, include={"contents": True}), name="Inside")
        eff = await _resolve(db_session, ws, inside)
        assert isinstance(eff.search, GroupPredicate) and eff.search.op == "or"
        assert eff.search.children[0] == TagPredicate(values=["pii"])
        assert eff.search.children[1].axis == "ancestor"
        assert eff.scope_hash != (await _resolve(db_session, ws, plain)).scope_hash

    async def test_a_hidden_layer_is_not_its_and_its_matches_are_left_out(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        sub = await _view(db_session, ws, _subset(base.id, hiddenLayers=["d"]))
        eff = await _resolve(db_session, ws, sub)
        assert [layer.id for layer in eff.subset_layers] == ["t", REST_LAYER_ID]
        assert eff.layer_allow_list == frozenset({"t", REST_LAYER_ID})
        # Left out as its base places them: whatever the base puts in Dashboards.
        pii, left_out = eff.search.children
        assert pii == TagPredicate(values=["pii"]) and _placed(_not(left_out)) == "d"

    async def test_its_matches_are_placed_as_its_base_places_them(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        sub = await _view(db_session, ws, _subset(base.id))
        eff = await _resolve(db_session, ws, sub)
        placement = eff.subset_placement
        assert placement is not None and placement.spec.layer_ids == frozenset({"t", "d"})
        assert set(placement.spec.explicit) == {"urn:db:A", "urn:db:B"}
        assert eff.search == TagPredicate(values=["pii"])

    async def test_its_scans_follow_what_places_and_not_how_it_looks(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        sub = await _view(db_session, ws, _subset(base.id))
        before = (await _resolve(db_session, ws, sub)).scope_hash

        async def rewrite(change):
            config = json.loads(base.config)
            change(config["referenceLayout"])
            base.config = json.dumps(config)
            await db_session.flush()
            return (await _resolve(db_session, ws, sub)).scope_hash

        def recolour(layout):
            layout["layers"][0].update(name="Tabellen", color="#ff0000")
            layout["assignments"]["urn:db:A"]["assignedAt"] = "2026-11-04T00:00:00Z"
        assert await rewrite(recolour) == before

        def move(layout):
            layout["assignments"]["urn:db:A"]["layerId"] = "d"
        moved = await rewrite(move)
        assert moved != before

        def stop_inheriting(layout):
            layout["assignments"]["urn:db:A"]["inheritsChildren"] = False
        assert await rewrite(stop_inheriting) not in (before, moved)

    async def test_a_base_past_what_a_search_follows_is_placed_by_type(self, db_session, monkeypatch):
        from backend.app.services import advanced_search_service as svc_mod
        monkeypatch.setattr(svc_mod, "LAYER_FILTER_MAX_HAND_PLACED", 1)
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        sub = await _view(db_session, ws, _subset(base.id, hiddenLayers=["d"]))
        eff = await _resolve(db_session, ws, sub)
        assert eff.subset_placement is None
        assert eff.search == GroupPredicate(op="and", children=[
            TagPredicate(values=["pii"]), sv.types_not_in(["dashboard"])])
        _placement, why = sv.follow_placement(BASE_CONFIG)
        assert _placement is None and "places 2 entities by hand" in why

    async def test_its_own_layout_places_by_type(self, db_session):
        ws = await _ws(db_session)
        base = await _view(db_session, ws, BASE_CONFIG)
        own = _subset(base.id, layout="own")
        own["layout"]["referenceLayout"]["layers"] = [
            {"id": "t", "name": "Tables", "entityTypes": ["table"]},
            {"id": REST_LAYER_ID, "name": "Other matches", "showUnassigned": True}]
        sub = await _view(db_session, ws, own)
        eff = await _resolve(db_session, ws, sub)
        assert eff.subset_placement is None and eff.search == TagPredicate(values=["pii"])

class _Provider:
    supports_search_sessions = False

    def __init__(self):
        self.searched: list = []
        self.refs: list = []
        self.counted: list = []

    async def deep_search(self, query, *, deadline_ms=None):
        self.searched.append(query)
        return SearchResultPage(hits=[], elapsed_ms=1)

    async def deep_search_explain(self, query):
        self.searched.append(query)
        return {"cypher": "MATCH (n) WHERE n.urn IN $roots RETURN n", "params": {"roots": ["x"]},
                "notes": []}

    async def deep_search_resolve_refs(self, scope, refs, *, context, confined, with_paths=False):
        self.refs.append((scope, confined))
        return [{"urns": ["urn:db:A"], "entities": []} for _ in refs]

    async def deep_search_count(self, query, *, context, advance=True):
        self.counted.append(query)
        return {"count": 1, "status": "complete", "sessionId": "s"}

    async def deep_search_catalog(self, scope, **kw):  # pragma: no cover — refused first
        raise AssertionError("refused before the catalog is read")


class _Engine:
    def __init__(self):
        self.provider = _Provider()
        self._workspace_id = self._data_source_id = None


async def _service(db_session, *, can_read=None, confined=False, predicate=None):
    ws = await _ws(db_session)
    base = await _view(db_session, ws, BASE_CONFIG)
    sub = await _view(db_session, ws, _subset(base.id, predicate))
    engine = _Engine()
    svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id,
                                data_source_id="ds1", can_read_view=can_read, confined=confined)
    return svc, engine.provider, base, sub


class TestService:
    async def test_every_search_in_the_view_meets_its_search(self, db_session):
        svc, provider, base, sub = await _service(db_session)
        q = EntityTypePredicate(values=["table"])
        await svc.search(SearchQuery(predicate=q, scope=SearchScope(view_id=sub.id)))
        sent = provider.searched[-1]
        assert sent.predicate == GroupPredicate(op="and", children=[q, TagPredicate(values=["pii"])])
        assert sorted(sent.scope.root_urns) == ["urn:db:A", "urn:db:B"]

    async def test_outside_its_own_scope_the_callers_choice_stands(self, db_session):
        svc, provider, _base, sub = await _service(db_session)
        layer = LayerPredicate(layer_assignment="Dashboards")
        await svc.search(SearchQuery(predicate=layer,
                                     scope=SearchScope(view_id=sub.id, scope_mode="data_source")))
        # No subset search added; the layer filter is what its base places in that layer.
        assert _placed(provider.searched[-1].predicate) == "d"

    async def test_a_layer_filter_inside_is_where_its_base_places(self, db_session):
        svc, provider, _base, sub = await _service(db_session)
        await svc.search(SearchQuery(predicate=LayerPredicate(layer_assignment=REST_LAYER_ID),
                                     scope=SearchScope(view_id=sub.id)))
        rest, pii = provider.searched[-1].predicate.children
        # Other matches: what its base places in none of its layers.
        assert _placed(_not(rest)) is None
        assert pii == TagPredicate(values=["pii"])

    async def test_its_search_names_entities_across_its_base_unconfined(self, db_session):
        named = {"kind": "descendantOf", "refs": [{"path": ["**", "UK"]}]}
        svc, provider, _base, sub = await _service(db_session, confined=True, predicate=named)
        await svc.search(SearchQuery(predicate=TagPredicate(values=["x"]),
                                     scope=SearchScope(view_id=sub.id)))
        scope, confined = provider.refs[0]
        assert confined is False and scope.entity_types is None
        assert sorted(scope.root_urns) == ["urn:db:A", "urn:db:B"]
        resolved = provider.searched[-1].predicate.children[1]
        assert resolved.urns == ["urn:db:A"] and resolved.refs is None

    async def test_a_word_alone_is_bounded_by_the_subsets_search(self, db_session):
        ws = await _ws(db_session)
        whole = {"layoutType": "reference", "content": {"entityScope": "all"},
                 "layout": {"referenceLayout": {"layers": [{"id": "r", "showUnassigned": True}]}},
                 "search": {"v": 1, "predicate": P, "within": "dataSource", "layout": "own"}}
        sub = await _view(db_session, ws, whole)
        engine = _Engine()
        svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id,
                                    data_source_id="ds1")
        word = TextPredicate(value="cust", target="any")
        await svc.search(SearchQuery(predicate=word, scope=SearchScope(view_id=sub.id),
                                     options=SearchOptions(results="hits")))
        assert engine.provider.searched[-1].predicate.children == [word, TagPredicate(values=["pii"])]
        # The caller's own whole-data-source search has no subset to bound it.
        with pytest.raises(ValidationError, match="no boundaries"):
            await svc.search(SearchQuery(predicate=word,
                                         scope=SearchScope(view_id=sub.id, scope_mode="data_source"),
                                         options=SearchOptions(results="hits")))

    async def test_counts_meet_the_subsets_search(self, db_session):
        svc, provider, _base, sub = await _service(db_session)
        await svc.counts(SearchCountsRequest(
            scope=SearchScope(view_id=sub.id),
            items=[SearchRuleItem(id="r", predicate=EntityTypePredicate(values=["table"]))]))
        assert provider.counted[-1].predicate.children[1] == TagPredicate(values=["pii"])

    async def test_a_layer_counted_inside_is_where_its_base_places(self, db_session):
        svc, provider, _base, sub = await _service(db_session)
        await svc.counts(SearchCountsRequest(
            scope=SearchScope(view_id=sub.id),
            items=[SearchRuleItem(id="r", predicate=LayerPredicate(layer_assignment="Tables"))]))
        placed, pii = provider.counted[-1].predicate.children
        assert _placed(placed) == "t" and pii == TagPredicate(values=["pii"])

    async def test_explain_hides_the_base_from_a_reader_who_cant_open_it(self, db_session):
        async def not_the_base(view):
            return view.id != base_id

        svc, provider, base, sub = await _service(db_session, can_read=not_the_base)
        base_id = base.id
        out = await svc.explain(SearchQuery(predicate=TagPredicate(values=["x"]),
                                            scope=SearchScope(view_id=sub.id)))
        assert out["resolvedScope"]["rootUrns"] == []
        assert "cypher" not in out and "params" not in out and "inlinedCypher" not in out
        assert SUBSET_BASE_HIDDEN in out["notes"]
        page, _eff = await svc.search(SearchQuery(predicate=TagPredicate(values=["x"]),
                                                  scope=SearchScope(view_id=sub.id)))
        assert page.scope_diagnostics.effective_root_urns == []
        assert SUBSET_BASE_HIDDEN in page.scope_diagnostics.notes

    @pytest.mark.parametrize("call", ["explain", "catalog", "resolve"])
    async def test_a_shared_link_cant_reach_past_the_matches(self, db_session, call):
        from backend.common.models.search import SearchCatalogRequest, SearchResolveRequest
        svc, _provider, _base, sub = await _service(db_session, confined=True)
        scope = SearchScope(view_id=sub.id)
        with pytest.raises(ValidationError, match="shared_link_subset"):
            if call == "explain":
                await svc.explain(SearchQuery(predicate=TagPredicate(values=["x"]), scope=scope))
            elif call == "catalog":
                await svc.catalog(SearchCatalogRequest(scope=scope))
            else:
                await svc.resolve(SearchResolveRequest(scope=scope, refs=[{"path": ["**", "UK"]}]))

    async def test_a_missing_base_is_a_conflict_never_a_wider_search(self, db_session):
        svc, provider, base, sub = await _service(db_session)
        base.deleted_at = "2026-01-01"
        await db_session.flush()
        with pytest.raises(ValidationError, match="base_missing"):
            await svc.search(SearchQuery(predicate=TagPredicate(values=["x"]),
                                         scope=SearchScope(view_id=sub.id)))
        assert provider.searched == []


#: A view made from a query with layers of its own (auto layers: a top-level type each).
LIST_LAYERS = [{"id": "L1", "name": "Datasets", "order": 0, "entityTypes": ["dataset"]},
               {"id": "L2", "name": "Charts", "order": 1, "entityTypes": ["chart"]}]
#: urn → (layer, kept whole).
LIST_MEMBERS = {"urn:ds1": ("L1", False), "urn:ds2": ("L1", True), "urn:ch1": ("L2", False)}


async def _list_base(session, ws, *, layout=None, members=LIST_MEMBERS, epoch=1):
    from backend.app.db.repositories import view_members_repo, view_membership_repo

    base = await _view(session, ws, {
        "layoutType": "reference", "content": {"entityScope": "curated", "visibleEntityTypes": []},
        "layout": {"referenceLayout": {"layers": [] if layout else LIST_LAYERS,
                                       "assignments": {"urn:e1": {"layerId": "L2"}}}},
        "membership": {"v": 1, "mode": "live", "sources": [{"spec": {"seeds": {"urns": ["urn:s"]}}}],
                       **({"layout": layout} if layout else {})}}, name="Members")
    state = await view_membership_repo.ensure(session, base)
    await view_members_repo.insert(session, [
        {"view_id": base.id, "epoch": epoch, "urn": urn, "layer_id": layer, "sort_key": urn, "ord": i,
         "label": "Table", "label_ord": i, "whole": whole, "covered": False}
        for i, (urn, (layer, whole)) in enumerate(members.items())])
    state.epoch = state.members_epoch = epoch
    state.member_count = len(members)
    await session.flush()
    return base


class TestSubsetOfAListView:
    """Following a view made from a query, a subset's matches are placed by that view's member
    rows: a layer holds its members — what is inside them too — and "Other matches" the rest."""

    async def test_its_matches_are_placed_by_the_bases_members(self, db_session):
        from backend.app.services.view_scope import MemberLayers

        ws = await _ws(db_session)
        base = await _list_base(db_session, ws)
        eff = await _resolve(db_session, ws, await _view(db_session, ws, _subset(base.id)))
        assert eff.subset_placement is None
        assert eff.subset_members == MemberLayers(base.id, 1, entries={"urn:e1": "L2"})
        assert [layer.id for layer in eff.subset_layers] == ["L1", "L2", REST_LAYER_ID]
        assert sorted(eff.root_urns) == ["urn:ch1", "urn:ds1", "urn:ds2", "urn:e1"]
        assert eff.entity_type_allow_list == frozenset(), "bounded by its members, not its layers' types"
        assert sv.layer_condition(eff.subset_layers[0], None, eff.subset_members) == sv.member_layer("L1")
        assert isinstance(sv.layer_condition(eff.subset_layers[2], None, eff.subset_members),
                          type(sv.MatchAllPredicate()))

    async def test_not_for_a_view_that_follows_another_nor_an_ordinary_one(self, db_session):
        ws = await _ws(db_session)
        plain = await _view(db_session, ws, BASE_CONFIG)
        follow = await _list_base(db_session, ws, layout={"kind": "follow", "sourceViewId": plain.id})
        for base in (plain, follow):
            eff = await _resolve(db_session, ws, await _view(db_session, ws, _subset(base.id)))
            assert eff.subset_members is None
        own = await _resolve(db_session, ws, await _view(db_session, ws, {
            **_subset((await _list_base(db_session, ws)).id, layout="own"),
            "layout": {"referenceLayout": {"layers": [
                {"id": REST_LAYER_ID, "name": "Other matches", "showUnassigned": True}], "assignments": {}}}}))
        assert own.subset_members is None, "its own layout places by type"
        with pytest.raises(ViewScopeError, match="no longer available"):
            await _resolve(db_session, ws, await _view(db_session, ws, _subset(
                (await _view(db_session, ws, _subset(plain.id))).id)))

    async def test_a_member_moved_or_a_new_answer_is_a_new_scope(self, db_session):
        from backend.app.db.repositories import view_members_repo
        from backend.app.db.models import ViewMembershipStateORM

        ws = await _ws(db_session)
        base = await _list_base(db_session, ws)
        sub = await _view(db_session, ws, _subset(base.id))
        before = (await _resolve(db_session, ws, sub)).scope_hash
        moved = {"urn:ds1": ("L2", False), "urn:ds2": ("L1", True), "urn:ch1": ("L2", False)}
        await view_members_repo.insert(db_session, [
            {"view_id": base.id, "epoch": 2, "urn": urn, "layer_id": layer, "sort_key": urn, "ord": i,
             "label": "Table", "label_ord": i, "whole": whole, "covered": False}
            for i, (urn, (layer, whole)) in enumerate(moved.items())])
        state = await db_session.get(ViewMembershipStateORM, base.id)
        state.members_epoch = 2
        await db_session.flush()
        assert (await _resolve(db_session, ws, sub)).scope_hash != before, "same roots, placed anew"

    async def test_a_layer_inside_reads_the_bases_members_there(self, db_session):
        ws = await _ws(db_session)
        base = await _list_base(db_session, ws)
        sub = await _view(db_session, ws, _subset(base.id))
        engine = _Engine()
        svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id,
                                    data_source_id="ds1")
        page, eff = await svc.search(SearchQuery(predicate=LayerPredicate(layer_assignment="Charts"),
                                                 scope=SearchScope(view_id=sub.id)))
        sent = engine.provider.searched[-1]
        assert sent.scope.root_urns == ["urn:ch1", "urn:e1"], "its members there, and the entry"
        assert sent.predicate == GroupPredicate(op="and", children=[
            sv.MatchAllPredicate(), TagPredicate(values=["pii"])]), "narrowed: the layer met"
        assert sent.scope.entity_types is None
        # Other matches: every match of its base, each page placed as the base draws it.
        await svc.search(SearchQuery(predicate=LayerPredicate(layer_assignment=REST_LAYER_ID),
                                     scope=SearchScope(view_id=sub.id)))
        assert sorted(engine.provider.searched[-1].scope.root_urns) == [
            "urn:ch1", "urn:ds1", "urn:ds2", "urn:e1"]
        # Inside OR: the layer's members, listed.
        either = GroupPredicate(op="or", children=[LayerPredicate(layer_assignment="L1"),
                                                   TagPredicate(values=["x"])])
        await svc.search(SearchQuery(predicate=either, scope=SearchScope(view_id=sub.id)))
        listed = engine.provider.searched[-1].predicate.children[0].children[0]
        assert [r.urn for r in listed.refs] == ["urn:ds1", "urn:ds2"]

    async def test_a_hidden_layers_members_are_left_out_up_to_a_limit(self, db_session, monkeypatch):
        from backend.app.services import advanced_search_service

        ws = await _ws(db_session)
        base = await _list_base(db_session, ws)
        sub = await _view(db_session, ws, _subset(base.id, hiddenLayers=["L2"]))
        eff = await _resolve(db_session, ws, sub)
        assert [layer.id for layer in eff.subset_layers] == ["L1", REST_LAYER_ID]
        pii, left_out = eff.search.children
        assert pii == TagPredicate(values=["pii"])
        assert [r.urn for r in _not(left_out).refs] == ["urn:ch1", "urn:e1"]
        monkeypatch.setattr(advanced_search_service, "MEMBER_LAYER_LISTED_MAX", 1)
        with pytest.raises(ViewScopeError, match="more than 1,000 members") as refused:
            await _resolve(db_session, ws, sub)
        assert refused.value.reason == "hidden_layers_too_large"
