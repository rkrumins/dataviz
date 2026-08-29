"""Handler-direct tests for ``POST /search/advanced``.

The bulkhead is a route-layer concern no service test can reach: the
compute must run inside the per-(provider, graph) concurrency slot, so a
keystroke storm from search-as-you-type sheds load (429 + Retry-After)
instead of pegging FalkorDB's single Cypher thread — the same treatment
every other heavy graph route already gets from ``_bounded_compute``.

The handler is called directly (no TestClient), matching the project's
existing route-test style — see ``test_search_schema_endpoint.py``.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.responses import Response

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import SearchQuery, SearchResultPage


def _query() -> SearchQuery:
    return SearchQuery.model_validate({
        "predicate": {"kind": "text", "value": "orders"},
        "scope": {"viewId": "view-1", "rootUrns": ["urn:root"]},
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

    async def _fake_search(self, query):
        calls.append(query)
        return _page(), _eff_scope()

    monkeypatch.setattr(AdvancedSearchService, "search", _fake_search)
    return calls


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


async def test_search_runs_inside_the_provider_slot(slot, patched_search):
    """The search compute is wrapped in the per-(provider, graph) slot:
    acquired once with the provider's cache key, released on the way
    out."""
    await graph_mod.search_advanced(
        query=_query(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(),
        session=None,
    )

    assert slot["acquisitions"] == [("prov-1", "graph-1")]
    assert not slot["sem"].locked(), "slot must be released after the search"


async def test_slot_is_held_while_the_search_runs(slot, monkeypatch):
    """Guards against a wrapper that acquires and releases around nothing
    — the semaphore must still be held at the moment the compute runs."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    observed: list = []

    async def _fake_search(self, query):
        observed.append(slot["sem"].locked())
        return _page(), _eff_scope()

    monkeypatch.setattr(AdvancedSearchService, "search", _fake_search)

    await graph_mod.search_advanced(
        query=_query(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(),
        session=None,
    )

    assert observed == [True]


async def test_slot_released_when_the_search_raises(slot, monkeypatch):
    """A failing search must not leak the slot — eight failures would
    otherwise wedge the provider permanently."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )

    async def _boom(self, query):
        raise ValidationError("view_not_found: view-1")

    monkeypatch.setattr(AdvancedSearchService, "search", _boom)

    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_advanced(
            query=_query(),
            response=Response(),
            ws_id="ws-1",
            engine=_FakeEngine(),
            session=None,
        )

    assert exc.value.status_code == 404
    assert not slot["sem"].locked()


async def test_provider_without_cache_key_is_unbounded(slot, patched_search):
    """Draft/versioned wrappers expose no ``manager_cache_key`` — those
    paths are Postgres-overlay-heavy, not FalkorDB fan-out, so they
    degrade to unbounded rather than borrowing another graph's slot."""
    page = await graph_mod.search_advanced(
        query=_query(),
        response=Response(),
        ws_id="ws-1",
        engine=_FakeEngine(cache_key=None),
        session=None,
    )

    assert slot["acquisitions"] == []
    assert page is not None
    assert len(patched_search) == 1
