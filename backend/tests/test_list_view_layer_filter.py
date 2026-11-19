"""A layer filter in a view made from a query that keeps its own layers.

Its stored config is curated and holds no assignments — its members are rows of their own
table — so a layer filter can't be read from its placement, as an ordinary view's is (it
matched nothing). It reads the members instead: one every match meets (the search's top
level, in the view's own scope) narrows the search's roots to that layer's members and
the entries people placed there — listed while they fit the root cap, else read where they
are kept, a band at a time, that layer's only — and is folded into the scope's hash. One
inside OR or NOT (or a rule's) is a list of the layer's members, at most 1,000, else a 400.
"""
from __future__ import annotations

import json
from contextlib import contextmanager

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.db.repositories import view_members_repo, view_membership_repo
from backend.app.services import advanced_search_service as service
from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError
from backend.app.services.deep_search import SearchRunContext
from backend.app.services.view_scope import MemberScope, ViewScopeResolver
from backend.common.models.search import (
    GroupPredicate,
    IsPredicate,
    LayerPredicate,
    MatchAllPredicate,
    SearchMembershipRequest,
    SearchOptions,
    SearchQuery,
    SearchResultPage,
    SearchRuleItem,
    SearchScope,
    TagPredicate,
)

LAYERS = [{"id": "L1", "name": "Tables", "order": 0, "entityTypes": []},
          {"id": "L2", "name": "Columns", "order": 1, "entityTypes": []},
          {"id": "L3", "name": "Empty", "order": 2, "entityTypes": []}]
#: urn → (layer, kept whole, inside a whole one in another layer).
MEMBERS = {"urn:t1": ("L1", False, False), "urn:t2": ("L1", True, False),
           "urn:c1": ("L2", False, False), "urn:c2": ("L2", False, True), "urn:c3": ("L2", False, False)}
#: An entry a person placed: "Always include".
ENTRY = {"urn:e1": {"layerId": "L1", "inheritsChildren": True, "assignedBy": "user"}}


class Provider:
    """Records what reaches the graph; reads a view's members where they are kept."""
    supports_member_scope = True
    supports_search_sessions = True

    def __init__(self):
        self.queries, self.contexts, self.items = [], [], []

    async def deep_search(self, query, *, deadline_ms=None):
        self.queries.append(query)
        return SearchResultPage(hits=[], elapsed_ms=1)

    async def deep_search_session(self, query, *, context):
        self.queries.append(query)
        self.contexts.append(context)
        return SearchResultPage(hits=[], elapsed_ms=1)

    async def deep_search_membership(self, scope, items, urns, *, context):
        self.items.extend(items)
        return {"matches": {i: [] for i, _ in items}, "errors": {}, "elapsedMs": 1}


class Engine:
    def __init__(self):
        self.provider = Provider()
        self._workspace_id = self._data_source_id = None


@contextmanager
def root_cap(monkeypatch, value: int):
    from backend.app.services.deep_search.settings import get_deep_search_settings

    monkeypatch.setenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", str(value))
    get_deep_search_settings.cache_clear()
    try:
        yield
    finally:
        monkeypatch.delenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", raising=False)
        get_deep_search_settings.cache_clear()


async def list_view(session: AsyncSession, *, layout=None) -> tuple:
    ws = WorkspaceORM(name="Layers")
    session.add(ws)
    await session.flush()
    membership = {"v": 1, "mode": "live", "sources": [{"spec": {"seeds": {"urns": ["urn:s"]}}}],
                  **({"layout": layout} if layout else {})}
    config = {"layoutType": "reference", "content": {"entityScope": "curated"},
              "layout": {"type": "reference", "referenceLayout": {"layers": LAYERS, "assignments": ENTRY}},
              "membership": membership}
    view = ViewORM(name="Members", workspace_id=ws.id, view_type="reference", config=json.dumps(config))
    session.add(view)
    await session.flush()
    state = await view_membership_repo.ensure(session, view)
    await view_members_repo.insert(session, [
        {"view_id": view.id, "epoch": 1, "urn": urn, "layer_id": layer, "sort_key": urn, "ord": i,
         "label": "Table", "label_ord": i, "whole": whole, "covered": covered}
        for i, (urn, (layer, whole, covered)) in enumerate(MEMBERS.items())])
    state.epoch = state.members_epoch = 1
    state.member_count = len(MEMBERS)
    await session.flush()
    return ws, view


def search(view, predicate, **scope) -> SearchQuery:
    return SearchQuery(predicate=predicate, scope=SearchScope(view_id=view.id, **scope),
                       options=SearchOptions(results="hits"))


def layer(name: str) -> LayerPredicate:
    return LayerPredicate.model_validate({"kind": "layer", "layerAssignment": name})


async def test_a_layer_at_the_top_narrows_the_roots_to_its_members(db_session):
    ws, view = await list_view(db_session)
    whole_view = await ViewScopeResolver(db_session).resolve(workspace_id=ws.id, requested=SearchScope(view_id=view.id))
    assert whole_view.placement is None and whole_view.member_layers.entries == {"urn:e1": "L1"}

    engine = Engine()
    svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id)
    tagged = TagPredicate(values=["pii"])
    _page, eff = await svc.search(search(view, GroupPredicate(op="and", children=[layer("Tables"), tagged])))
    sent = engine.provider.queries[-1]
    assert sent.scope.root_urns == ["urn:e1", "urn:t1", "urn:t2"], "its members and its entry"
    assert sent.predicate == GroupPredicate(op="and", children=[MatchAllPredicate(), tagged])
    assert eff.scope_hash != whole_view.scope_hash

    _page, by_id = await svc.search(search(view, layer("L2")))
    assert engine.provider.queries[-1].scope.root_urns == ["urn:c1", "urn:c2", "urn:c3"]
    assert len({eff.scope_hash, by_id.scope_hash, whole_view.scope_hash}) == 3, "layer:<id> in the hash"

    asked = len(engine.provider.queries)
    page, _eff = await svc.search(search(view, layer("Empty")))
    assert len(engine.provider.queries) == asked, "a layer that holds nothing finds nothing, unsearched"
    assert service.LAYER_HOLDS_NOTHING in page.scope_diagnostics.notes

    await svc.search(search(view, GroupPredicate(op="and", children=[layer("L1"), layer("L2")])))
    assert len(engine.provider.queries) == asked, "a member is in one layer"


async def test_past_the_root_cap_a_layer_is_read_where_its_members_are_kept(db_session, monkeypatch):
    ws, view = await list_view(db_session)
    engine = Engine()
    svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id)
    with root_cap(monkeypatch, 2):
        _page, eff = await svc.search(search(view, layer("Tables")), run_context=SearchRunContext())
        assert eff.member_scope == MemberScope(view.id, 1, 2, layer_id="L1")
        sent, context = engine.provider.queries[-1], engine.provider.contexts[-1]
        assert sent.scope.root_urns == ["urn:e1", "urn:t2"], "the whole one and the entry: roots"
        members = context.members
        assert await members.counts() == {"Table": (1, 1)}, "the layer's own members, read in bands"
        assert await members.read("Table", 0, 10) == ["urn:t1"]
        assert await members.holds(["urn:t1", "urn:c1"]) == {"urn:t1"}
        assert context.scope_hash == eff.scope_hash

        await svc.search(search(view, layer("Columns")), run_context=SearchRunContext())
        members = engine.provider.contexts[-1].members
        assert await members.read("Table", 0, 10) == ["urn:c1", "urn:c2", "urn:c3"], (
            "one inside a whole one in another layer is read itself: that one is no root here")


async def test_a_layer_inside_or_or_not_lists_its_members_up_to_a_limit(db_session, monkeypatch):
    ws, view = await list_view(db_session)
    engine = Engine()
    svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id)
    either = GroupPredicate(op="or", children=[layer("Tables"), TagPredicate(values=["pii"])])
    _page, eff = await svc.search(search(view, either))
    sent = engine.provider.queries[-1]
    assert len(sent.scope.root_urns) == 6, "the whole view's roots: nothing narrowed"
    listed = sent.predicate.children[0]
    assert isinstance(listed, IsPredicate) and [r.urn for r in listed.refs] == ["urn:e1", "urn:t1", "urn:t2"]

    # Outside the view's own scope nothing narrows: the canvas's entities, say.
    await svc.search(search(view, GroupPredicate(op="and", children=[layer("Tables"), TagPredicate(values=["x"])]),
                            scope_mode="visible", visible_urns=["urn:t1", "urn:c1"]))
    assert [r.urn for r in engine.provider.queries[-1].predicate.children[0].refs] == ["urn:e1", "urn:t1", "urn:t2"]

    monkeypatch.setattr(service, "MEMBER_LAYER_LISTED_MAX", 2)
    with pytest.raises(ValidationError, match="more than 2 members"):
        await svc.search(search(view, GroupPredicate(op="not", children=[layer("Columns")])))


async def test_a_rule_with_a_layer_lists_its_members_and_one_too_large_is_its_own_error(db_session, monkeypatch):
    ws, view = await list_view(db_session)
    engine = Engine()
    svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id)
    monkeypatch.setattr(service, "MEMBER_LAYER_LISTED_MAX", 2)
    out = await svc.membership(SearchMembershipRequest(
        scope=SearchScope(view_id=view.id),
        items=[SearchRuleItem(id="small", predicate=layer("L3")), SearchRuleItem(id="big", predicate=layer("L2"))],
        urns=["urn:t1"]))
    assert [i for i, _ in engine.provider.items] == ["small"]
    assert "more than 2 members" in out.errors["big"]


async def test_a_view_that_follows_another_is_placed_as_before(db_session):
    """Its layers are the view it follows': a layer filter reads that view's placement."""
    ws, view = await list_view(db_session, layout={"kind": "follow", "sourceViewId": "v-base"})
    base = ViewORM(id="v-base", name="Base", workspace_id=ws.id, view_type="reference", config=json.dumps({
        "layout": {"referenceLayout": {"layers": LAYERS, "assignments": {}}}, "content": {"entityScope": "all"}}))
    db_session.add(base)
    await db_session.flush()
    eff = await ViewScopeResolver(db_session).resolve(workspace_id=ws.id, requested=SearchScope(view_id=view.id))
    assert eff.member_layers is None and eff.placement is not None


class Sessions(Provider):
    """A session per search, kept with the scope it was planned for; ancestor counts read
    from it by the engine's own check (``read_ancestor_counts``), handed what the service
    resolved — as ``falkordb_provider.deep_search_ancestor_counts`` hands it."""

    def __init__(self):
        super().__init__()
        self.planned = {}

    async def deep_search_session(self, query, *, context):
        page = await super().deep_search_session(query, context=context)
        page.session_id = f"s{len(self.planned)}"
        self.planned[page.session_id] = context.scope_hash
        return page

    async def deep_search_ancestor_counts(self, session_id, urns, *, context):
        from backend.app.providers.falkordb_search.engine import read_ancestor_counts
        return await read_ancestor_counts(self, session_id, urns, scope_hash=context.scope_hash,
                                          scope_hashes=context.scope_hashes)


@pytest.fixture()
def sessions(monkeypatch):
    """The engine's session store, as the scopes ``Sessions`` planned."""
    from types import SimpleNamespace

    from backend.app.providers.falkordb_search import engine as engine_mod

    class Store:
        def __init__(self, provider):
            self.provider = provider

        async def load(self, sid):
            planned = self.provider.planned.get(sid)
            return None if planned is None else SimpleNamespace(scope_hash=planned, status="complete")

        async def read_tallies(self, sid, urns):
            return {"urn:t1": [2, "t1", "Table", {"Table": 2}]}

    monkeypatch.setattr(engine_mod, "store_for", lambda provider: Store(provider))


async def test_ancestor_counts_after_a_layer_filter_read_that_search(db_session, sessions):
    """A search filtered to a layer at the top runs in that layer's scope (``layer:<id>``
    folded into the hash): its ancestor counts are read from it, not refused as another
    scope's. Another view's session still is."""
    from backend.common.models.search import SearchAncestorCountsRequest

    ws, view = await list_view(db_session)
    engine = Engine()
    engine.provider = Sessions()
    svc = AdvancedSearchService(engine, session=db_session, workspace_id=ws.id)

    async def counts(sid):
        return await svc.ancestor_counts(SearchAncestorCountsRequest(
            scope=SearchScope(view_id=view.id), session_id=sid, urns=["urn:t1"]))

    whole_view = await ViewScopeResolver(db_session).resolve(workspace_id=ws.id,
                                                             requested=SearchScope(view_id=view.id))
    page, eff = await svc.search(search(view, layer("Tables")), run_context=SearchRunContext())
    assert eff.scope_hash == service.layer_fold(whole_view.scope_hash, {"L1"})
    answered = await counts(page.session_id)
    assert answered.status == "complete" and answered.counts["urn:t1"].count == 2
    unfiltered, _eff = await svc.search(search(view, TagPredicate(values=["pii"])),
                                        run_context=SearchRunContext())
    assert (await counts(unfiltered.session_id)).status == "complete"

    ws2, other = await list_view(db_session)
    elsewhere = AdvancedSearchService(engine, session=db_session, workspace_id=ws2.id)
    theirs, _eff = await elsewhere.search(search(other, layer("Tables")), run_context=SearchRunContext())
    assert (await elsewhere.ancestor_counts(SearchAncestorCountsRequest(
        scope=SearchScope(view_id=other.id), session_id=theirs.session_id, urns=["urn:t1"]))).status == "complete"
    assert (await counts(theirs.session_id)).status == "expired", "another view's layer scope"
