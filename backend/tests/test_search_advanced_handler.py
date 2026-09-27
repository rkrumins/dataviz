"""Handler-direct tests for ``POST /search/advanced``.

Two route-layer concerns no service test can reach:

1. **Bulkhead.** The compute must run inside the per-(provider, graph)
   concurrency slot, so a keystroke storm from search-as-you-type sheds
   load (429 + Retry-After) instead of pegging FalkorDB's single Cypher
   thread — the same treatment every other heavy graph route already
   gets from ``_bounded_compute``. The uncapped engine runs many
   statements per search, so it is handed the same slot to take per
   STATEMENT (``SearchRunContext.admit``) instead.

2. **Capability guard.** The view scope IS the RBAC boundary for a
   share-link identity. ``scopeMode='data_source'`` drops the view's
   root clamp outright, and ``scopeMode='visible'``'s only clamp is the
   CLIENT-supplied URN list — either one lets a capability identity read
   outside the view it was granted.

The handler is called directly (no TestClient), matching the project's
existing route-test style — see ``test_search_schema_endpoint.py``.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import SearchQuery, SearchResultPage


def _query(scope_mode: str = "view", view_id: str = "view-1") -> SearchQuery:
    return SearchQuery.model_validate({
        "predicate": {"kind": "text", "value": "orders"},
        "scope": {
            "viewId": view_id,
            "scopeMode": scope_mode,
            "rootUrns": ["urn:root"],
        },
    })


def _eff_scope() -> EffectiveViewScope:
    return EffectiveViewScope(
        view_id="view-1",
        workspace_id="ws-1",
        data_source_id="ds-1",
        canvas_kind="hierarchy",
        root_urns=("urn:root",),
        entity_type_allow_list=frozenset(),
        layer_allow_list=frozenset(),
        max_depth=12,
        scope_hash="deadbeef1234",
    )


def _page() -> SearchResultPage:
    return SearchResultPage(
        aggregates=None, hits=None, cursor=None,
        truncated=False, candidate_count=0,
        deadline_exceeded=False, elapsed_ms=1, cache_hit=False,
    )


class _Provider:
    """Stand-in for a provider that ``_bounded_compute`` recognises."""

    def __init__(self, *, cache_key=("prov-1", "graph-1")) -> None:
        if cache_key is not None:
            self.manager_cache_key = cache_key


class _FakeEngine:
    """Just enough surface for the route: a ``.provider``."""

    def __init__(self, *, cache_key=("prov-1", "graph-1")) -> None:
        self.provider = _Provider(cache_key=cache_key)


def _request(*, view_capability: str | None = None) -> Request:
    state: dict = {}
    if view_capability is not None:
        state["view_capability"] = view_capability
    return Request({"type": "http", "headers": [], "state": state})


@pytest.fixture
def patched_search(monkeypatch):
    """Replace ``AdvancedSearchService.search`` with a recorder.

    The route imports the service lazily inside the handler, so patching
    the class attribute on its module is what the handler picks up. This
    keeps the test on the route layer — no resolver, no DB session.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    calls: list = []

    async def _fake_search(self, query, **kwargs):
        calls.append(query)
        return _page(), _eff_scope()

    monkeypatch.setattr(AdvancedSearchService, "search", _fake_search)
    return calls


def _use_engine(monkeypatch, engine: str) -> None:
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_ENGINE", engine)
    get_deep_search_settings.cache_clear()


@pytest.fixture
def legacy_engine(monkeypatch):
    _use_engine(monkeypatch, "legacy")
    yield
    from backend.app.services.deep_search import get_deep_search_settings
    get_deep_search_settings.cache_clear()


@pytest.fixture
def uncapped_engine(monkeypatch):
    _use_engine(monkeypatch, "v2")
    yield
    from backend.app.services.deep_search import get_deep_search_settings
    get_deep_search_settings.cache_clear()


@pytest.fixture
def slot(monkeypatch):
    """Monkeypatch ``acquire_provider_slot`` onto a real semaphore.

    Returns the recorder so a test can assert both that the slot was
    taken (with the provider's cache key) and — via ``sem.locked()`` —
    that it was still held while the compute ran and released after.
    """
    sem = asyncio.Semaphore(1)
    acquisitions: list = []

    async def _acquire(provider_id, graph_name=""):
        acquisitions.append((provider_id, graph_name))
        await sem.acquire()
        return sem

    monkeypatch.setattr(
        graph_mod.provider_manager, "acquire_provider_slot", _acquire,
    )
    return {"sem": sem, "acquisitions": acquisitions}


# ---------------------------------------------------------------------------
# Bulkhead
# ---------------------------------------------------------------------------

async def test_search_runs_inside_the_provider_slot(slot, patched_search, legacy_engine):
    """The search compute is wrapped in the per-(provider, graph) slot:
    acquired once with the provider's cache key, released on the way
    out."""
    await graph_mod.search_advanced(
        query=_query(),
        request=_request(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(),
        session=None,
    )

    assert slot["acquisitions"] == [("prov-1", "graph-1")]
    assert not slot["sem"].locked(), "slot must be released after the search"


async def test_slot_is_held_while_the_search_runs(slot, monkeypatch, legacy_engine):
    """Guards against a wrapper that acquires and releases around nothing
    — the semaphore must still be held at the moment the compute runs."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    observed: list = []

    async def _fake_search(self, query, **kwargs):
        observed.append(slot["sem"].locked())
        return _page(), _eff_scope()

    monkeypatch.setattr(AdvancedSearchService, "search", _fake_search)

    await graph_mod.search_advanced(
        query=_query(),
        request=_request(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(),
        session=None,
    )

    assert observed == [True]


async def test_slot_released_when_the_search_raises(slot, monkeypatch, legacy_engine):
    """A failing search must not leak the slot — eight failures would
    otherwise wedge the provider permanently."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )

    async def _boom(self, query, **kwargs):
        raise ValidationError("view_not_found: view-1")

    monkeypatch.setattr(AdvancedSearchService, "search", _boom)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_advanced(
            query=_query(),
            request=_request(),
            response=Response(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 404
    assert not slot["sem"].locked()


async def test_provider_without_cache_key_is_unbounded(slot, patched_search, legacy_engine):
    """Draft/versioned wrappers expose no ``manager_cache_key`` — those
    paths are Postgres-overlay-heavy, not FalkorDB fan-out, so they
    degrade to unbounded rather than borrowing another graph's slot."""
    page = await graph_mod.search_advanced(
        query=_query(),
        request=_request(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(cache_key=None),
        session=None,
    )

    assert slot["acquisitions"] == []
    assert page is not None
    assert len(patched_search) == 1


async def test_uncapped_engine_is_admitted_per_statement(slot, monkeypatch, uncapped_engine):
    """The uncapped engine runs many statements per search, so the route
    does not hold a slot around the whole search — it hands the service
    the same slot to take per statement, keyed like ``_bounded_compute``."""
    from backend.app.services.advanced_search_service import AdvancedSearchService
    seen: dict = {}

    async def _fake_search(self, query, *, run_context=None, **kwargs):
        seen["held_during_search"] = slot["sem"].locked()
        seen["context"] = run_context
        async with run_context.admit():
            seen["held_in_statement"] = slot["sem"].locked()
        return _page(), _eff_scope()

    monkeypatch.setattr(AdvancedSearchService, "search", _fake_search)
    await graph_mod.search_advanced(
        query=_query(), request=_request(), response=Response(),
        ws_id="ws-1", engine=_FakeEngine(), session=None,
    )

    assert seen["held_during_search"] is False
    assert seen["held_in_statement"] is True
    assert slot["acquisitions"] == [("prov-1", "graph-1")]
    assert not slot["sem"].locked(), "the statement's slot is released after it"


async def test_uncapped_engine_without_cache_key_is_unbounded(slot, monkeypatch, uncapped_engine):
    from backend.app.services.advanced_search_service import AdvancedSearchService
    contexts: list = []

    async def _fake_search(self, query, *, run_context=None, **kwargs):
        contexts.append(run_context)
        return _page(), _eff_scope()

    monkeypatch.setattr(AdvancedSearchService, "search", _fake_search)
    await graph_mod.search_advanced(
        query=_query(), request=_request(), response=Response(),
        ws_id="ws-1", engine=_FakeEngine(cache_key=None), session=None,
    )

    assert contexts[0].admit is None
    assert slot["acquisitions"] == []


async def test_the_data_version_is_the_published_graphs(monkeypatch):
    """A draft searches the graph it is a draft of, so its sessions are
    versioned by the published graph's content generation — never the
    draft's own, which moves with every edit to the draft."""
    from backend.app.services.graph_cache import CacheScope
    asked: list = []

    class _Cache:
        async def content_generation(self, scope):
            asked.append(scope)
            return "41"

    monkeypatch.setattr(graph_mod, "get_graph_cache", lambda: _Cache())
    monkeypatch.setattr(graph_mod, "_cache_scope", lambda engine: CacheScope(
        workspace_id="ws-1", data_source_id="ds-1", branch_id="draft-7", graph_ns="g9"))

    assert await graph_mod._search_data_version(_FakeEngine()) == "41.g9"
    assert asked[0].branch_id == ""


async def test_no_workspace_means_no_data_version(monkeypatch):
    monkeypatch.setattr(graph_mod, "_cache_scope", lambda engine: None)
    assert await graph_mod._search_data_version(_FakeEngine()) == ""


# ---------------------------------------------------------------------------
# Capability guard
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scope_mode", ["data_source", "visible"])
async def test_capability_identity_cannot_leave_its_view(
    scope_mode, slot, patched_search,
):
    """A share-link identity is authorised for ONE view. ``data_source``
    drops the view clamp and ``visible`` clamps only to client-supplied
    URNs — both are refused, before any provider work."""
    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_advanced(
            query=_query(scope_mode),
            request=_request(view_capability="view-1"),
            response=Response(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 403
    assert exc.value.detail == "This link can only search inside its view."
    assert patched_search == [], "must refuse before running the search"
    assert slot["acquisitions"] == []


async def test_capability_identity_may_search_its_view(slot, patched_search):
    """``view`` mode is the capability's own scope — always allowed."""
    page = await graph_mod.search_advanced(
        query=_query("view"),
        request=_request(view_capability="view-1"),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(),
        session=None,
    )

    assert page is not None
    assert len(patched_search) == 1


async def test_capability_identity_cannot_name_a_foreign_view_in_the_body(
    slot, patched_search,
):
    """``?viewId=view-1`` authorises the capability, but the search body
    carries its OWN ``scope.viewId`` — naming a different view there
    must not let the identity search it, even in ``view`` mode, which
    is otherwise always allowed."""
    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_advanced(
            query=_query("view", view_id="view-2"),
            request=_request(view_capability="view-1"),
            response=Response(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 403
    assert exc.value.detail == "This link can only search inside its view."
    assert patched_search == [], "must refuse before running the search"
    assert slot["acquisitions"] == []


@pytest.mark.parametrize("scope_mode", ["data_source", "visible", "view"])
async def test_full_permission_user_is_unaffected(
    scope_mode, slot, patched_search,
):
    """No capability marker on the request → membership identity → every
    scope mode stays available."""
    page = await graph_mod.search_advanced(
        query=_query(scope_mode),
        request=_request(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(),
        session=None,
    )

    assert page is not None
    assert len(patched_search) == 1


# ---------------------------------------------------------------------------
# The same guard on /search/explain
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scope_mode", ["data_source", "visible"])
async def test_explain_applies_the_same_capability_guard(
    scope_mode, monkeypatch,
):
    """``/search/explain`` returns the compiled Cypher plus the resolved
    scope — the same read boundary, so the same refusal."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    calls: list = []

    async def _fake_explain(self, query):
        calls.append(query)
        return {}

    monkeypatch.setattr(AdvancedSearchService, "explain", _fake_explain)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_explain(
            query=_query(scope_mode),
            request=_request(view_capability="view-1"),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 403
    assert calls == []


async def test_explain_refuses_a_foreign_view_named_in_the_body(monkeypatch):
    """Same escape as ``search_advanced``'s, same refusal."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    calls: list = []

    async def _fake_explain(self, query):
        calls.append(query)
        return {}

    monkeypatch.setattr(AdvancedSearchService, "explain", _fake_explain)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_explain(
            query=_query("view", view_id="view-2"),
            request=_request(view_capability="view-1"),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 403
    assert calls == []


# ---------------------------------------------------------------------------
# A provider that cannot search says so as a 501
# ---------------------------------------------------------------------------

REFUSAL = (
    "Search isn't available while the published graph is catching up — "
    "try again in a moment."
)


async def test_provider_refusal_becomes_the_501_body(slot, monkeypatch):
    """The branch/stale-main reader refuses with product copy meant for
    the caller. The route must pass it through — a message the user
    never sees is not a user-facing message."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    async def _refuse(self, query, **kwargs):
        raise NotImplementedError(REFUSAL)

    monkeypatch.setattr(AdvancedSearchService, "search", _refuse)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_advanced(
            query=_query(),
            request=_request(),
            response=Response(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 501
    assert exc.value.detail == REFUSAL


async def test_bare_refusal_keeps_the_provider_fallback(slot, monkeypatch):
    """A provider that simply has no deep-search implementation raises a
    bare NotImplementedError and still gets the developer-facing
    fallback naming it — that diagnostic is not lost."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    async def _refuse(self, query, **kwargs):
        raise NotImplementedError

    monkeypatch.setattr(AdvancedSearchService, "search", _refuse)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_advanced(
            query=_query(),
            request=_request(),
            response=Response(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 501
    assert "_Provider" in exc.value.detail


async def test_explain_maps_a_refusal_to_501(monkeypatch):
    """``/search/explain`` had no NotImplementedError arm at all, so the
    same refusal escaped as a 500 — the exact failure mode this change
    removes from ``/search/advanced``."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    async def _refuse(self, query, **kwargs):
        raise NotImplementedError(REFUSAL)

    monkeypatch.setattr(AdvancedSearchService, "explain", _refuse)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_explain(
            query=_query(),
            request=_request(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 501
    assert exc.value.detail == REFUSAL


# ---------------------------------------------------------------------------
# /search/discover — whole-graph diagnostics, and the same 501 arm
# ---------------------------------------------------------------------------

def _patch_discover(monkeypatch, result=None, raises=None):
    """Replace ``AdvancedSearchService.discover`` with a recorder.

    Returns the call list so a test can assert the provider was never
    sampled — a guard that refuses only after the scan has already run
    has leaked the answer it was meant to withhold.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    calls: list = []

    async def _fake_discover(self, *, sample_per_label=200):
        calls.append(sample_per_label)
        if raises is not None:
            raise raises
        return result if result is not None else {}

    monkeypatch.setattr(AdvancedSearchService, "discover", _fake_discover)
    return calls


async def test_discover_refuses_a_capability_identity(monkeypatch):
    """Discover reports the labels, property keys and tag values of the
    WHOLE graph — there is no scope that narrows it to the granted view,
    so a share-link identity is refused outright rather than by mode."""
    calls = _patch_discover(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_discover(
            request=_request(view_capability="view-1"),
            samplePerLabel=200,
            engine=_FakeEngine(),
        )

    assert exc.value.status_code == 403
    assert exc.value.detail == "This link can only search inside its view."
    assert calls == [], "must refuse before the graph is sampled"


async def test_discover_reports_missing_searchable_text(monkeypatch):
    """A membership identity gets the payload, including the count that
    tells the zero-results panel the backfill hasn't run."""
    calls = _patch_discover(monkeypatch, result={
        "labels": {}, "missingSearchableText": 7,
    })

    result = await graph_mod.search_discover(
        request=_request(),
        samplePerLabel=200,
        engine=_FakeEngine(),
    )

    assert result["missingSearchableText"] == 7
    assert calls == [200]


async def test_discover_maps_a_refusal_to_501(monkeypatch):
    """A draft over a stale main reaches discover too; without this arm
    its refusal escaped as a 500 with FalkorDB internals in the body."""
    _patch_discover(monkeypatch, raises=NotImplementedError(REFUSAL))

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_discover(
            request=_request(),
            samplePerLabel=200,
            engine=_FakeEngine(),
        )

    assert exc.value.status_code == 501
    assert exc.value.detail == REFUSAL
