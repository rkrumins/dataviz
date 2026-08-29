"""Tests for the W0 view-scope resolver — the security/integrity boundary
that keeps searches inside their view.

Two layers of coverage:

1. **Pure helpers** (no DB) — intersection rules, canvas classification,
   scope-hash determinism. Fast, no fixtures.

2. **Resolver integration** (in-memory SQLite via the ``db_session``
   fixture from conftest) — exercises the SQL path, ViewORM round-trip,
   cross-workspace rejection, and the resolved-scope shape on each
   canvas kind.

The full HTTP-layer security tests (foreign-ws → 404, X-Search-Dropped-URNs
header, etc.) live in test_advanced_search_security.py (still TBD); this
file proves the resolver alone is correct.
"""
from __future__ import annotations

import json
from contextlib import contextmanager

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.view_scope import (
    ViewNotFound,
    ViewScopeError,
    ViewScopeResolver,
    _classify_canvas,
    _collect_content_scope,
    _collect_reference_roots,
    _compute_scope_hash,
    _intersect_entity_types,
    _intersect_root_urns,
    _parse_view_config,
)
from backend.common.models.search import SearchScope


# ---------------------------------------------------------------------------
# Pure-helper tests (no DB)
# ---------------------------------------------------------------------------

class TestIntersectRootUrns:
    def test_no_request_returns_all_allowed(self):
        kept, dropped = _intersect_root_urns(None, ["urn:a", "urn:b"])
        assert kept == ["urn:a", "urn:b"]
        assert dropped == []

    def test_empty_request_returns_all_allowed(self):
        kept, dropped = _intersect_root_urns([], ["urn:a"])
        assert kept == ["urn:a"]
        assert dropped == []

    def test_exact_match_kept(self):
        kept, dropped = _intersect_root_urns(["urn:a"], ["urn:a", "urn:b"])
        assert kept == ["urn:a"]
        assert dropped == []

    def test_descendant_under_colon_kept(self):
        # 'urn:a:child' is a descendant of 'urn:a'
        kept, dropped = _intersect_root_urns(["urn:a:child"], ["urn:a"])
        assert kept == ["urn:a:child"]
        assert dropped == []

    def test_descendant_under_slash_kept(self):
        kept, dropped = _intersect_root_urns(["urn:a/child"], ["urn:a"])
        assert kept == ["urn:a/child"]
        assert dropped == []

    def test_out_of_view_urn_dropped(self):
        kept, dropped = _intersect_root_urns(["urn:hostile"], ["urn:a"])
        assert kept == []
        assert dropped == ["urn:hostile"]

    def test_empty_urns_filtered(self):
        kept, dropped = _intersect_root_urns(["", "urn:a"], ["urn:a"])
        assert kept == ["urn:a"]
        assert dropped == []

    def test_unconstrained_view_accepts_any(self):
        # An unconstrained view (graph canvas) has no root URN restriction.
        kept, dropped = _intersect_root_urns(["urn:anything"], [])
        assert kept == ["urn:anything"]
        assert dropped == []


class TestIntersectEntityTypes:
    def test_no_request_returns_view_allow_list(self):
        result = _intersect_entity_types(None, frozenset({"Table", "Column"}))
        assert result == frozenset({"Table", "Column"})

    def test_subset_intersection(self):
        result = _intersect_entity_types(
            ["Table"], frozenset({"Table", "Column"}),
        )
        assert result == frozenset({"Table"})

    def test_out_of_view_raises(self):
        with pytest.raises(ViewScopeError) as exc:
            _intersect_entity_types(
                ["Secret"], frozenset({"Table", "Column"}),
            )
        assert exc.value.reason == "entity_type_not_in_view"
        assert "Secret" in str(exc.value)

    def test_unconstrained_view_accepts_any(self):
        result = _intersect_entity_types(["X"], frozenset())
        assert result == frozenset({"X"})

    def test_empty_entries_filtered(self):
        result = _intersect_entity_types(["", "Table"], frozenset({"Table"}))
        assert result == frozenset({"Table"})


class TestClassifyCanvas:
    def test_layout_type_overrides_view_type(self):
        assert _classify_canvas("graph", {"layoutType": "reference"}) == "reference"

    def test_view_type_when_layout_absent(self):
        assert _classify_canvas("graph", {}) == "graph"
        assert _classify_canvas("hierarchy", {}) == "hierarchy"
        assert _classify_canvas("layered-lineage", {}) == "layered-lineage"

    def test_unknown_canvas_is_classified_explicitly(self):
        # Falls into the safe "unknown" bucket so the resolver can apply
        # the most-restrictive defaults rather than guessing.
        assert _classify_canvas("freeform-doodle", {}) == "unknown"
        assert _classify_canvas(None, {}) == "unknown"


class TestComputeScopeHash:
    def test_deterministic(self):
        h1 = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a", "b"),
            entity_types=frozenset({"X"}), layer_ids=frozenset(),
            max_depth=12,
        )
        h2 = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a", "b"),
            entity_types=frozenset({"X"}), layer_ids=frozenset(),
            max_depth=12,
        )
        assert h1 == h2

    def test_updated_at_changes_hash(self):
        # Critical: view edits must invalidate downstream caches.
        h1 = _compute_scope_hash(
            view_id="v", updated_at="t1",
            root_urns=(), entity_types=frozenset(),
            layer_ids=frozenset(), max_depth=12,
        )
        h2 = _compute_scope_hash(
            view_id="v", updated_at="t2",
            root_urns=(), entity_types=frozenset(),
            layer_ids=frozenset(), max_depth=12,
        )
        assert h1 != h2

    def test_branch_id_changes_hash(self):
        # Critical: a draft's scoped search must never share a cached scope
        # with the published search on the same view (or a different draft).
        base = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a",), entity_types=frozenset(),
            layer_ids=frozenset(), max_depth=12,
        )
        draft = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a",), entity_types=frozenset(),
            layer_ids=frozenset(), max_depth=12,
            branch_id="br_x",
        )
        other = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a",), entity_types=frozenset(),
            layer_ids=frozenset(), max_depth=12,
            branch_id="br_y",
        )
        assert base != draft
        assert draft != other
        # No branch and branch_id="" hash identically (published canonical form).
        assert base == _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a",), entity_types=frozenset(),
            layer_ids=frozenset(), max_depth=12,
            branch_id="",
        )

    def test_root_urn_order_insensitive_via_sort(self):
        # We sort entity_types but NOT root_urns — root_urns ordering is
        # preserved because the compiler will see it as part of the
        # Cypher params. Document the actual contract here.
        h1 = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a", "b"),
            entity_types=frozenset({"X", "Y"}),
            layer_ids=frozenset(), max_depth=12,
        )
        h2 = _compute_scope_hash(
            view_id="v", updated_at="t",
            root_urns=("a", "b"),
            entity_types=frozenset({"Y", "X"}),  # different order
            layer_ids=frozenset(), max_depth=12,
        )
        assert h1 == h2  # entity_types order doesn't matter


class TestParseViewConfig:
    def test_empty_input(self):
        assert _parse_view_config(None) == {}
        assert _parse_view_config("") == {}

    def test_valid_json(self):
        assert _parse_view_config('{"a":1}') == {"a": 1}

    def test_invalid_json_returns_empty(self):
        assert _parse_view_config("not json") == {}

    def test_non_dict_returns_empty(self):
        assert _parse_view_config("[1,2,3]") == {}


class TestCollectReferenceRoots:
    def test_empty_layout(self):
        roots, types, layers = _collect_reference_roots({})
        assert roots == []
        assert types == frozenset()
        assert layers == frozenset()

    def test_full_layout(self):
        config = {
            "referenceLayout": {
                "layers": [
                    {
                        "id": "source",
                        "entityTypes": ["Table", "Column"],
                        "entityAssignments": [
                            {"urn": "urn:domain:Customers"},
                            {"urn": "urn:domain:Orders"},
                        ],
                    },
                    {
                        "id": "staging",
                        "entityTypes": ["View"],
                        "entityAssignments": [{"urn": "urn:stage:1"}],
                    },
                ],
            },
        }
        roots, types, layers = _collect_reference_roots(config)
        assert sorted(roots) == [
            "urn:domain:Customers", "urn:domain:Orders", "urn:stage:1",
        ]
        assert types == frozenset({"Table", "Column", "View"})
        assert layers == frozenset({"source", "staging"})

    def test_malformed_entries_skipped(self):
        config = {
            "referenceLayout": {
                "layers": [
                    {"id": "ok", "entityAssignments": [
                        {"urn": "urn:a"},
                        {"urn": None},          # skipped
                        "not a dict",           # skipped
                    ]},
                    "also not a dict",          # skipped
                ],
            },
        }
        roots, _, layers = _collect_reference_roots(config)
        assert roots == ["urn:a"]
        assert layers == frozenset({"ok"})

    def test_canonical_flattened_assignments_map_collected(self):
        """Canonical nested `layout.referenceLayout` shape with a top-level
        `assignments` map (Task 1's shape) — roots come from the assignment
        keys, not a hand-rolled `entityAssignments` walk."""
        config = {
            "layout": {
                "referenceLayout": {
                    "layers": [
                        {"id": "source", "entityTypes": ["Table"]},
                        {"id": "staging", "entityTypes": ["View"]},
                    ],
                    "assignments": {
                        "urn:domain:Customers": {"layerId": "source"},
                        "urn:stage:1": {"layerId": "staging"},
                    },
                },
            },
        }
        roots, types, layers = _collect_reference_roots(config)
        assert sorted(roots) == ["urn:domain:Customers", "urn:stage:1"]
        assert types == frozenset({"Table", "View"})
        assert layers == frozenset({"source", "staging"})

    def test_nested_location_wins_over_legacy_top_level(self):
        """When both the canonical nested location and the legacy top-level
        `referenceLayout` are present, the nested one wins (parser contract)."""
        config = {
            "layout": {
                "referenceLayout": {
                    "layers": [{"id": "nested"}],
                    "assignments": {"urn:nested": {"layerId": "nested"}},
                },
            },
            "referenceLayout": {
                "layers": [{"id": "legacy", "entityAssignments": [{"urn": "urn:legacy"}]}],
            },
        }
        roots, _, layers = _collect_reference_roots(config)
        assert roots == ["urn:nested"]
        assert layers == frozenset({"nested"})


class TestCollectContentScope:
    def test_empty_content(self):
        roots, types, depth = _collect_content_scope({})
        assert roots == []
        assert types == frozenset()
        assert depth == 0

    def test_full_content(self):
        config = {
            "content": {
                "rootUrns": ["urn:a", "urn:b"],
                "visibleEntityTypes": ["Table"],
                "maxDepth": 8,
            },
        }
        roots, types, depth = _collect_content_scope(config)
        assert roots == ["urn:a", "urn:b"]
        assert types == frozenset({"Table"})
        assert depth == 8

    def test_fallback_to_root_entity_types(self):
        # When ``visibleEntityTypes`` is missing, fall back to
        # ``rootEntityTypes`` so reference views without explicit
        # visibility lists still constrain entity types.
        config = {"content": {"rootEntityTypes": ["Domain"]}}
        _, types, _ = _collect_content_scope(config)
        assert types == frozenset({"Domain"})

    def test_invalid_max_depth_returns_zero(self):
        config = {"content": {"maxDepth": "not a number"}}
        _, _, depth = _collect_content_scope(config)
        assert depth == 0


# ---------------------------------------------------------------------------
# Resolver integration (db_session)
#
# Each integration test marks itself ``@pytest.mark.asyncio`` individually
# so the sync helper tests above don't trip the asyncio-mark warning.
# ---------------------------------------------------------------------------


async def _seed_workspace(session: AsyncSession, name: str = "WS") -> WorkspaceORM:
    ws = WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


async def _seed_view(
    session: AsyncSession,
    workspace: WorkspaceORM,
    *,
    view_type: str = "graph",
    config: dict | None = None,
    data_source_id: str | None = None,
    deleted: bool = False,
) -> ViewORM:
    view = ViewORM(
        name="Test View",
        workspace_id=workspace.id,
        data_source_id=data_source_id,
        view_type=view_type,
        config=json.dumps(config or {}),
        deleted_at="2026-05-20T00:00:00Z" if deleted else None,
    )
    session.add(view)
    await session.flush()
    return view


async def test_resolver_view_not_found(db_session: AsyncSession):
    ws = await _seed_workspace(db_session)
    resolver = ViewScopeResolver(db_session)
    with pytest.raises(ViewNotFound):
        await resolver.resolve(
            workspace_id=ws.id,
            requested=SearchScope(view_id="does-not-exist"),
        )


async def test_resolver_cross_workspace_rejection(db_session: AsyncSession):
    # Foreign-tenant access path: a view exists, but in workspace B.
    # The resolver must reject with the same ViewNotFound shape used
    # for genuinely-missing views, so the HTTP layer doesn't leak
    # existence to the attacker's workspace.
    ws_a = await _seed_workspace(db_session, name="WS A")
    ws_b = await _seed_workspace(db_session, name="WS B")
    view = await _seed_view(db_session, ws_b, view_type="graph")

    resolver = ViewScopeResolver(db_session)
    with pytest.raises(ViewNotFound):
        await resolver.resolve(
            workspace_id=ws_a.id,
            requested=SearchScope(view_id=view.id),
        )


async def test_resolver_rejects_deleted_view(db_session: AsyncSession):
    ws = await _seed_workspace(db_session)
    view = await _seed_view(db_session, ws, deleted=True)

    resolver = ViewScopeResolver(db_session)
    with pytest.raises(ViewNotFound):
        await resolver.resolve(
            workspace_id=ws.id,
            requested=SearchScope(view_id=view.id),
        )


async def test_resolver_reference_view_extracts_roots(db_session: AsyncSession):
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [
                    {
                        "id": "source",
                        "entityTypes": ["Table"],
                        "entityAssignments": [
                            {"urn": "urn:domain:Customers"},
                            {"urn": "urn:domain:Orders"},
                        ],
                    },
                ],
            },
            "content": {"maxDepth": 6},
        },
    )

    resolver = ViewScopeResolver(db_session)
    eff = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
    )
    assert eff.view_id == view.id
    assert eff.workspace_id == ws.id
    assert eff.canvas_kind == "reference"
    assert sorted(eff.root_urns) == ["urn:domain:Customers", "urn:domain:Orders"]
    assert eff.entity_type_allow_list == frozenset({"Table"})
    assert eff.layer_allow_list == frozenset({"source"})
    assert eff.max_depth == 6
    assert eff.scope_hash  # populated


async def test_resolver_intersects_client_root_urns(db_session: AsyncSession):
    # The user drilled into one of the view's roots (a legitimate
    # narrowing). The resolver must keep that URN and clear the others.
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [
                        {"urn": "urn:domain:Customers"},
                        {"urn": "urn:domain:Orders"},
                    ],
                }],
            },
        },
    )

    resolver = ViewScopeResolver(db_session)
    eff = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(
            view_id=view.id,
            root_urns=["urn:domain:Customers"],
        ),
    )
    assert eff.root_urns == ("urn:domain:Customers",)
    assert eff.dropped_urns == ()


async def test_resolver_drops_out_of_view_urns(db_session: AsyncSession):
    # The user passes a URN that isn't under any of the view's allowed
    # roots. The resolver must drop it (security boundary).
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [{"urn": "urn:domain:Customers"}],
                }],
            },
        },
    )

    resolver = ViewScopeResolver(db_session)
    eff = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(
            view_id=view.id,
            root_urns=["urn:hostile:other"],
        ),
    )
    # The hostile URN is dropped; the resolver falls back to the
    # view's own allowed roots so the search still has a scope.
    assert eff.root_urns == ()
    assert eff.dropped_urns == ("urn:hostile:other",)


async def test_resolver_rejects_out_of_view_entity_type(db_session: AsyncSession):
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="graph",
        config={"content": {"visibleEntityTypes": ["Table", "Column"]}},
    )

    resolver = ViewScopeResolver(db_session)
    with pytest.raises(ViewScopeError) as exc:
        await resolver.resolve(
            workspace_id=ws.id,
            requested=SearchScope(
                view_id=view.id,
                entity_types=["Secret"],
            ),
        )
    assert exc.value.reason == "entity_type_not_in_view"


async def test_resolver_clamps_max_depth(db_session: AsyncSession):
    # View's stored maxDepth must override the client's larger ask.
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="hierarchy",
        config={"content": {"maxDepth": 5}},
    )

    resolver = ViewScopeResolver(db_session)
    eff = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id, max_depth=20),
    )
    assert eff.max_depth == 5


async def test_resolver_unconstrained_graph_view(db_session: AsyncSession):
    # A "graph" canvas view with no rootUrns / entityTypes intentionally
    # gives the user workspace-wide search inside that view's data
    # source. The resolver returns empty root_urns + empty allow-list.
    # Cross-workspace isolation is enforced separately (different
    # FalkorDB graph per workspace), so this is safe.
    ws = await _seed_workspace(db_session)
    view = await _seed_view(db_session, ws, view_type="graph", config={})

    resolver = ViewScopeResolver(db_session)
    eff = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
    )
    assert eff.canvas_kind == "graph"
    assert eff.root_urns == ()
    assert eff.entity_type_allow_list == frozenset()
    assert eff.layer_allow_list == frozenset()


# ---------------------------------------------------------------------------
# Service-pipeline security (W0f) — view-scope behavior end-to-end through
# AdvancedSearchService.search()
#
# These tests prove the security guards in the service layer fire BEFORE
# the provider is touched. The fake engine raises if its provider is
# called, so any test that succeeds without that exception has confirmed
# the short-circuit.
# ---------------------------------------------------------------------------


class _RecordingProvider:
    """Records deep_search calls and returns a benign empty page. If
    ``raise_on_call`` is True, calling deep_search raises — used to prove
    the service short-circuited before reaching the provider."""

    def __init__(self, *, raise_on_call: bool = False) -> None:
        self.raise_on_call = raise_on_call
        self.calls: list = []

    async def deep_search(self, query, *, deadline_ms=None):
        if self.raise_on_call:
            raise AssertionError(
                "provider.deep_search must not be called when the service "
                "short-circuits to an empty page"
            )
        self.calls.append((query, deadline_ms))
        # Mirror what the real provider returns for an empty match.
        from backend.common.models.search import SearchResultPage
        return SearchResultPage(
            aggregates=None, hits=None, cursor=None,
            truncated=False, candidate_count=0,
            deadline_exceeded=False, elapsed_ms=1, cache_hit=False,
        )

    async def deep_search_explain(self, query):
        # Minimal stand-in for the real compile-only path
        # (falkordb_deep_search.explain_deep_search) — just enough shape
        # for AdvancedSearchService.explain() to attach resolvedScope.
        self.calls.append((query, None))
        return {"cypher": "MATCH (n) RETURN n", "params": {}, "notes": []}


class _FakeEngine:
    """Just enough surface to satisfy AdvancedSearchService.__init__ and
    the .provider access pattern. No ContextEngine semantics."""

    def __init__(self, *, raise_on_provider_call: bool = False) -> None:
        self.provider = _RecordingProvider(raise_on_call=raise_on_provider_call)
        self._workspace_id = None
        self._data_source_id = None


@contextmanager
def _root_urns_cap(monkeypatch, value: str):
    """Run the body with a lowered ``DEEP_SEARCH_SCOPE_ROOT_URNS_CAP``.

    The settings object is lru_cached, so both the override and its
    removal have to clear the cache — otherwise the lowered cap leaks
    into every test that runs after this one.
    """
    from backend.app.services.deep_search.settings import (
        get_deep_search_settings,
    )
    monkeypatch.setenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", value)
    get_deep_search_settings.cache_clear()
    try:
        yield
    finally:
        monkeypatch.delenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", raising=False)
        get_deep_search_settings.cache_clear()


async def test_service_short_circuits_when_all_client_urns_dropped(
    db_session: AsyncSession,
):
    """Security guarantee: if every URN the client passes is out-of-view,
    the service must NOT widen the search to "no scope clamp". It must
    return an empty page without touching the provider.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchOptions, SearchQuery, SearchScope, TagPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [{"urn": "urn:domain:Customers"}],
                }],
            },
        },
    )

    # Provider raises if called — proves the service short-circuited.
    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(
            view_id=view.id,
            root_urns=["urn:hostile:somewhere-else"],  # entirely out-of-view
        ),
        options=SearchOptions(results="both"),
    )
    page, eff_scope = await svc.search(query)

    # Empty page returned, NOT a widened search
    assert page.candidate_count == 0
    assert page.hits == []
    assert page.aggregates == []
    # Dropped URN was recorded by the resolver
    assert eff_scope.dropped_urns == ("urn:hostile:somewhere-else",)


async def test_all_client_urns_dropped_text_any_returns_empty_page(
    db_session: AsyncSession,
):
    """The out-of-view short-circuit outranks the unbounded-scan guard.

    A client that sends only out-of-view roots gets the empty page and
    its diagnostics note — the honest answer, "no matches in this
    view" — never a "this view has no boundaries yet" rejection, which
    would describe a view that in fact has roots.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchOptions, SearchQuery, SearchScope, TextPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [{"urn": "urn:domain:Customers"}],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TextPredicate(value="customer", target="any"),
        scope=SearchScope(
            view_id=view.id,
            root_urns=["urn:hostile:somewhere-else"],
        ),
        options=SearchOptions(results="both"),
    )
    page, eff_scope = await svc.search(query)

    assert page.candidate_count == 0
    assert page.hits == []
    assert eff_scope.dropped_urns == ("urn:hostile:somewhere-else",)


async def test_service_passes_resolved_scope_to_provider(
    db_session: AsyncSession,
):
    """When the client doesn't supply scope.root_urns, the resolver's
    view-derived roots reach the provider in the stamped SearchQuery.
    Compiler reads from query.scope.root_urns — so this is the load-
    bearing path that enforces "search within the view".
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityTypes": ["Table"],
                    "entityAssignments": [
                        {"urn": "urn:domain:A"},
                        {"urn": "urn:domain:B"},
                    ],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view.id),  # no client root_urns
    )
    page, eff_scope = await svc.search(query)

    assert len(engine.provider.calls) == 1
    stamped_query, _ = engine.provider.calls[0]
    # View-derived roots were stamped into the query the provider sees
    assert sorted(stamped_query.scope.root_urns or []) == ["urn:domain:A", "urn:domain:B"]
    assert stamped_query.scope.entity_types == ["Table"]
    # The eff_scope returned to the caller matches what the provider saw
    assert sorted(eff_scope.root_urns) == ["urn:domain:A", "urn:domain:B"]


async def test_service_diagnostics_only_refuses_search():
    """The for_diagnostics() constructor refuses to run a scoped search
    because it has no session/workspace. This matters: diagnostics
    constructors must NOT be used as a backdoor to bypass view scope.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService.for_diagnostics(engine)
    query = SearchQuery(
        predicate=TagPredicate(values=["x"]),
        scope=SearchScope(view_id="any"),
    )
    with pytest.raises(ValidationError, match="view_scope_unavailable"):
        await svc.search(query)


async def test_service_rejects_view_from_other_workspace(db_session: AsyncSession):
    """search() must reject a view_id that exists in a different
    workspace as ViewNotFound (mapped to 404 by the HTTP layer). Don't
    leak existence to the attacker's workspace."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    ws_a = await _seed_workspace(db_session, name="WS A")
    ws_b = await _seed_workspace(db_session, name="WS B")
    foreign_view = await _seed_view(db_session, ws_b, view_type="graph")

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws_a.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["x"]),
        scope=SearchScope(view_id=foreign_view.id),
    )
    with pytest.raises(ValidationError, match="view_not_found"):
        await svc.search(query)


async def test_bare_text_any_uses_view_roots(db_session: AsyncSession):
    """The canvas header box sends a plain word and no client roots —
    the view's own roots are the clamp. The unbounded-scan guard must
    therefore run on the RESOLVED scope, after the view's roots have
    been stamped in, or this everyday search is rejected as 400.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TextPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [
                        {"urn": "urn:domain:A"},
                        {"urn": "urn:domain:B"},
                    ],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TextPredicate(value="customer", target="any"),
        scope=SearchScope(view_id=view.id),  # no client root_urns
    )
    await svc.search(query)

    assert len(engine.provider.calls) == 1
    stamped_query, _ = engine.provider.calls[0]
    assert sorted(stamped_query.scope.root_urns or []) == [
        "urn:domain:A", "urn:domain:B",
    ]


async def test_bare_text_any_on_unscoped_view_still_400(db_session: AsyncSession):
    """A view that bounds nothing gives the resolver no roots and no
    entity types, so a plain word would scan the whole data source.
    That request is still rejected — before the provider is touched.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TextPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(db_session, ws, view_type="graph", config={})

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TextPredicate(value="customer", target="any"),
        scope=SearchScope(view_id=view.id),
    )
    with pytest.raises(ValidationError, match="no boundaries yet"):
        await svc.search(query)


async def test_visible_mode_with_urns_bypasses_guard(db_session: AsyncSession):
    """``scope_mode='visible'`` carries its own clamp: the candidate
    scan is filtered to the URNs the canvas rendered. A plain word is
    bounded by that list even when the resolved scope stamps no roots.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TextPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [{"urn": "urn:domain:A"}],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TextPredicate(value="customer", target="any"),
        scope=SearchScope(
            view_id=view.id,
            scope_mode="visible",
            visible_urns=["urn:domain:A:orders"],
        ),
    )
    await svc.search(query)

    assert len(engine.provider.calls) == 1
    stamped_query, _ = engine.provider.calls[0]
    # The compiler reads roots in view mode only, so none are stamped.
    assert stamped_query.scope.root_urns is None


async def test_service_root_cap_overflow_is_validation_error(
    db_session: AsyncSession, monkeypatch,
):
    """A view with more top-level containers than the search limit is a
    caller-facing 400 with an explanation — not the unhandled pydantic
    error the stamped ``SearchScope`` used to raise (HTTP 500).
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [
                        {"urn": f"urn:domain:{i}"} for i in range(11)
                    ],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view.id),
    )
    with _root_urns_cap(monkeypatch, "10"):
        with pytest.raises(ValidationError, match="top-level containers"):
            await svc.search(query)

    assert engine.provider.calls == []


async def test_service_data_source_mode_ignores_root_cap(
    db_session: AsyncSession, monkeypatch,
):
    """``scope_mode='data_source'`` searches the whole source — the
    compiler never reads the view's roots there, so they are neither
    stamped nor counted against the cap.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityAssignments": [
                        {"urn": f"urn:domain:{i}"} for i in range(11)
                    ],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view.id, scope_mode="data_source"),
    )
    with _root_urns_cap(monkeypatch, "10"):
        await svc.search(query)

    assert len(engine.provider.calls) == 1
    stamped_query, _ = engine.provider.calls[0]
    assert stamped_query.scope.root_urns is None


# ---------------------------------------------------------------------------
# _stamp_resolved_scope — a view's own ontology is never too big to search
#
# ``SearchScope.entity_types`` caps *client* input (default 512, raised
# from 32). A view's resolved entity-type allow list is server-derived,
# not client input, and must never trip that cap into an unhandled
# pydantic 500 (the same class of bug as the root_urns cap, fixed
# separately in ``_stamp_resolved_scope``'s root-cap branch above).
# ---------------------------------------------------------------------------


async def test_service_stamps_large_entity_type_allow_list_through(
    db_session: AsyncSession,
):
    """A view whose ontology has 35 entity types (below the 512 cap, but
    above the old 32 cap) must stamp through in full — the provider sees
    every one of the 35 types, not a truncated or dropped set."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    entity_types = [f"Type{i:03d}" for i in range(35)]
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityTypes": entity_types,
                    "entityAssignments": [{"urn": "urn:domain:A"}],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view.id),
    )
    page, eff_scope = await svc.search(query)

    assert len(eff_scope.entity_type_allow_list) == 35
    assert len(engine.provider.calls) == 1
    stamped_query, _ = engine.provider.calls[0]
    assert stamped_query.scope.entity_types == sorted(entity_types)
    # No degradation note — the allow-list stamped through untouched.
    notes = page.scope_diagnostics.notes if page.scope_diagnostics else []
    assert not any("entity-type gate was dropped" in n for n in notes)


async def test_service_drops_entity_type_gate_when_ontology_exceeds_cap(
    db_session: AsyncSession,
):
    """A view whose ontology has 600 entity types is above the field's
    512-item cap. The service must fall back to an unfiltered search
    (``entity_types=None`` — "every label", exactly what the cap-busting
    allow list already meant) rather than crash. The diagnostics note
    explains why the label gate is missing.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    entity_types = [f"Type{i:04d}" for i in range(600)]
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityTypes": entity_types,
                    "entityAssignments": [{"urn": "urn:domain:A"}],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view.id),
    )
    page, eff_scope = await svc.search(query)

    assert len(eff_scope.entity_type_allow_list) == 600
    assert len(engine.provider.calls) == 1
    stamped_query, _ = engine.provider.calls[0]
    assert stamped_query.scope.entity_types is None
    assert page.scope_diagnostics is not None
    assert any(
        "entity-type gate was dropped" in n
        for n in page.scope_diagnostics.notes
    )


async def test_explain_takes_the_same_path_for_large_entity_type_allow_list(
    db_session: AsyncSession,
):
    """``explain()`` resolves scope through the same ``_stamp_resolved_scope``
    call as ``search()``. A 35-type ontology must not raise there either —
    it should return the normal explain-result shape."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    from backend.common.models.search import (
        SearchQuery, SearchScope, TagPredicate,
    )

    entity_types = [f"Type{i:03d}" for i in range(35)]
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "referenceLayout": {
                "layers": [{
                    "id": "L1",
                    "entityTypes": entity_types,
                    "entityAssignments": [{"urn": "urn:domain:A"}],
                }],
            },
        },
    )

    engine = _FakeEngine(raise_on_provider_call=False)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
    )
    query = SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view.id),
    )
    result = await svc.explain(query)

    assert result["resolvedScope"]["entityTypes"] == sorted(entity_types)
    assert "cypher" in result


async def test_resolver_scope_hash_changes_with_view_edit(db_session: AsyncSession):
    # The `updated_at` of the view is part of the scope hash, so editing
    # a view invalidates any cache entry keyed by the previous hash.
    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="graph",
        config={"content": {"rootUrns": ["urn:a"]}},
    )

    resolver = ViewScopeResolver(db_session)
    eff1 = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
    )

    # Touch the view's updated_at by reloading and committing a no-op
    # change to its config.
    view.config = json.dumps({"content": {"rootUrns": ["urn:a"]}})
    view.updated_at = "2026-05-21T00:00:00Z"
    await db_session.flush()

    eff2 = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
    )
    assert eff1.scope_hash != eff2.scope_hash


async def test_resolver_branch_effective_config_and_distinct_hash(
    db_session: AsyncSession,
):
    # A draft's scoped search must resolve the branch-effective config (base ⊕
    # the branch's layout overlay), while published (no branch) sees the base —
    # and the two must NOT share a scope hash (no cross-branch cache collision).
    from backend.app.db.models import ViewLayoutOverlayORM

    ws = await _seed_workspace(db_session)
    view = await _seed_view(
        db_session, ws,
        view_type="reference",
        config={
            "layoutType": "reference",
            "layout": {
                "referenceLayout": {
                    "layers": [{"id": "source"}],
                    "assignments": {
                        "urn:base": {"layerId": "source", "inheritsChildren": True},
                    },
                },
            },
        },
    )
    # The draft overlay re-places a DIFFERENT entity into the layer.
    overlay = ViewLayoutOverlayORM(
        view_id=view.id,
        branch_id="br_draft",
        reference_layout=json.dumps({
            "layers": [{"id": "source"}],
            "assignments": {
                "urn:draft": {"layerId": "source", "inheritsChildren": True},
            },
        }),
        entity_scope=None,
        fork_base_layout=json.dumps({}),
        fork_base_entity_scope=None,
    )
    db_session.add(overlay)
    await db_session.flush()

    resolver = ViewScopeResolver(db_session)

    published = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
    )
    draft = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
        branch_id="br_draft",
    )
    # No overlay for this branch → base (identical to published).
    other_draft = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
        branch_id="br_other",
    )

    assert published.root_urns == ("urn:base",)
    assert draft.root_urns == ("urn:draft",)          # overlay wins
    assert other_draft.root_urns == ("urn:base",)     # no overlay → base

    # Distinct scope hashes: published, this draft, and a branch with no
    # overlay all key differently (branch_id is folded into the hash).
    assert published.scope_hash != draft.scope_hash
    assert published.scope_hash != other_draft.scope_hash
    assert draft.scope_hash != other_draft.scope_hash


# ---------------------------------------------------------------------------
# F3 — view ↔ data-source guard.
#
# The engine picks its provider from ``?dataSourceId=`` (else the workspace
# primary); the search's roots come from ``scope.viewId``. Nothing used to
# check that those two agree, so a view belonging to source A searched with
# ``?dataSourceId=B`` ran A's root URNs against B's graph and returned 0 —
# a silent wrong answer, which is worse than an error.
# ---------------------------------------------------------------------------

_DS_MISMATCH_MESSAGE = (
    "This view belongs to a different data source than the one being searched."
)


async def _seed_data_source(
    session: AsyncSession,
    workspace: WorkspaceORM,
    *,
    primary: bool = False,
    graph_name: str = "g",
):
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM

    existing = await session.get(ProviderORM, "prov_ds_guard")
    if existing is None:
        session.add(ProviderORM(
            id="prov_ds_guard", name="P", provider_type="falkordb",
        ))
        await session.flush()
    ds = WorkspaceDataSourceORM(
        workspace_id=workspace.id,
        provider_id="prov_ds_guard",
        graph_name=graph_name,
        label=f"ds-{graph_name}",
        is_primary=primary,
        is_active=True,
    )
    session.add(ds)
    await session.flush()
    return ds


def _ds_query(view_id: str):
    from backend.common.models.search import (
        SearchOptions, SearchQuery, SearchScope, TextPredicate,
    )
    return SearchQuery(
        predicate=TextPredicate(value="customer", target="name"),
        scope=SearchScope(view_id=view_id),
        options=SearchOptions(results="both"),
    )


async def test_search_rejects_view_from_a_different_data_source(
    db_session: AsyncSession,
):
    """View belongs to source A, request targets source B → 400, and the
    provider is never asked."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )

    ws = await _seed_workspace(db_session)
    ds_a = await _seed_data_source(db_session, ws, graph_name="a")
    ds_b = await _seed_data_source(db_session, ws, graph_name="b")
    view = await _seed_view(db_session, ws, data_source_id=ds_a.id)

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
        data_source_id=ds_b.id,
    )
    with pytest.raises(ValidationError) as exc:
        await svc.search(_ds_query(view.id))
    assert _DS_MISMATCH_MESSAGE in str(exc.value)
    assert engine.provider.calls == []


async def test_explain_rejects_view_from_a_different_data_source(
    db_session: AsyncSession,
):
    """The same guard on the compile-only path — explain must not hand
    back Cypher for a graph the view does not live in."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )

    ws = await _seed_workspace(db_session)
    ds_a = await _seed_data_source(db_session, ws, graph_name="a")
    ds_b = await _seed_data_source(db_session, ws, graph_name="b")
    view = await _seed_view(db_session, ws, data_source_id=ds_a.id)

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
        data_source_id=ds_b.id,
    )
    with pytest.raises(ValidationError) as exc:
        await svc.explain(_ds_query(view.id))
    assert _DS_MISMATCH_MESSAGE in str(exc.value)
    assert engine.provider.calls == []


async def test_search_rejects_when_omitted_source_falls_back_to_primary(
    db_session: AsyncSession,
):
    """The silent case: no ``?dataSourceId=`` in a multi-source workspace.

    The engine took the workspace PRIMARY; the view belongs to the other
    source. Nothing in the request names a data source, so the guard has
    to resolve the primary itself to notice.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )

    ws = await _seed_workspace(db_session)
    primary = await _seed_data_source(db_session, ws, primary=True, graph_name="p")
    other = await _seed_data_source(db_session, ws, graph_name="o")
    view = await _seed_view(db_session, ws, data_source_id=other.id)
    assert primary.id != other.id

    engine = _FakeEngine(raise_on_provider_call=True)
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
        data_source_id=None,
    )
    with pytest.raises(ValidationError) as exc:
        await svc.search(_ds_query(view.id))
    assert _DS_MISMATCH_MESSAGE in str(exc.value)
    assert engine.provider.calls == []


async def test_search_proceeds_when_view_matches_the_searched_source(
    db_session: AsyncSession,
):
    """Matching ids → the search runs as before."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    ws = await _seed_workspace(db_session)
    ds_a = await _seed_data_source(db_session, ws, graph_name="a")
    view = await _seed_view(db_session, ws, data_source_id=ds_a.id)

    engine = _FakeEngine()
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
        data_source_id=ds_a.id,
    )
    page, _eff = await svc.search(_ds_query(view.id))
    assert page.candidate_count == 0
    assert len(engine.provider.calls) == 1


async def test_search_proceeds_when_view_matches_the_primary_source(
    db_session: AsyncSession,
):
    """Omitted ``?dataSourceId=`` + a view on the primary → no rejection."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    ws = await _seed_workspace(db_session)
    primary = await _seed_data_source(db_session, ws, primary=True, graph_name="p")
    view = await _seed_view(db_session, ws, data_source_id=primary.id)

    engine = _FakeEngine()
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
        data_source_id=None,
    )
    page, _eff = await svc.search(_ds_query(view.id))
    assert page.candidate_count == 0
    assert len(engine.provider.calls) == 1


async def test_search_proceeds_when_view_has_no_data_source(
    db_session: AsyncSession,
):
    """A view with no data source of its own is not evidence of a
    mismatch — the guard stays silent rather than inventing one."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    ws = await _seed_workspace(db_session)
    ds_a = await _seed_data_source(db_session, ws, graph_name="a")
    view = await _seed_view(db_session, ws, data_source_id=None)

    engine = _FakeEngine()
    svc = AdvancedSearchService(
        engine, session=db_session, workspace_id=ws.id,
        data_source_id=ds_a.id,
    )
    page, _eff = await svc.search(_ds_query(view.id))
    assert page.candidate_count == 0
    assert len(engine.provider.calls) == 1


async def test_resolver_reports_the_views_own_data_source(
    db_session: AsyncSession,
):
    """``view_data_source_id`` is the VIEW's, never the request's — the
    existing ``data_source_id`` field is overridden by the caller's and so
    can never answer 'which source does this view belong to?'.
    """
    ws = await _seed_workspace(db_session)
    view = await _seed_view(db_session, ws, data_source_id="ds_view_owns")

    resolver = ViewScopeResolver(db_session)
    eff = await resolver.resolve(
        workspace_id=ws.id,
        requested=SearchScope(view_id=view.id),
        data_source_id="ds_the_caller_asked_for",
    )
    assert eff.view_data_source_id == "ds_view_owns"
    assert eff.data_source_id == "ds_the_caller_asked_for"
