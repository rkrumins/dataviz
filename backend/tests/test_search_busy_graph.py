"""A busy graph is never a graph with nothing in it.

``_searchable_labels`` answered every failure of ``CALL db.labels()`` with
``[]``. On a busy graph a search then planned nothing and completed with 0
matches — kept for the session's lifetime — its name lookups cached "not
found", and its value pickers called an empty list complete. Each now says
the graph is busy (``ProviderBusy``: a 429 the client retries) and is asked
again; only a graph that doesn't exist yet has no labels.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_deep_search import (
    _searchable_labels,
    suggest_property_values,
)
from backend.app.providers.falkordb_search import engine as engine_mod
from backend.app.providers.falkordb_search import refs as refs_mod
from backend.app.providers.falkordb_search.session import MemorySessionStore
from backend.app.services.deep_search import SearchRunContext
from backend.common.adapters.circuit import (
    ProviderBusy,
    ProviderLoading,
    ProviderTimeout,
    ProviderUnavailable,
)
from backend.common.models.search import NodeRef, SearchQuery, SearchScope


class _Db:
    """Answers ``db.labels()`` — or fails it, ``fail`` times — and nothing
    else, unless a test scripts more."""

    def __init__(self, error=None, *, fail=1, labels=("Dataset",)):
        self.error, self.fail, self.labels = error, fail, list(labels)
        self.lookups = 0

    async def _ro_query(self, cypher, params=None, *, timeout=None, op=None):
        if cypher.startswith("CALL db.labels()"):
            self.lookups += 1
            if self.error is not None and self.fail > 0:
                self.fail -= 1
                raise self.error
            return SimpleNamespace(result_set=[[lbl] for lbl in self.labels])
        return SimpleNamespace(result_set=[])


class TestTheLabelLookup:
    @pytest.mark.parametrize("error", [
        TimeoutError(),
        RuntimeError("Query timed out"),
        ConnectionError("Connection reset by peer"),
        ProviderTimeout("falkordb", "slow"),
    ])
    async def test_a_lookup_that_fails_says_the_graph_is_busy(self, error):
        with pytest.raises(ProviderBusy) as caught:
            await _searchable_labels(_Db(error), timeout_s=1.0)
        assert caught.value.retry_after_seconds == 2
        assert "busy" in caught.value.reason

    @pytest.mark.parametrize("error", [
        ProviderBusy("falkordb", "queue full", 1),
        ProviderLoading("falkordb", "loading", 5),
        ProviderUnavailable("falkordb", "breaker open", 30),
    ])
    async def test_what_the_provider_already_said_reaches_the_caller(self, error):
        with pytest.raises(type(error)) as caught:
            await _searchable_labels(_Db(error), timeout_s=1.0)
        assert caught.value is error

    async def test_a_graph_that_does_not_exist_yet_has_no_labels(self):
        db = _Db(RuntimeError("Invalid graph operation on empty key"))
        assert await _searchable_labels(db, timeout_s=1.0) == []

    async def test_value_suggestions_say_they_are_incomplete(self):
        out = await suggest_property_values(_Db(TimeoutError()), key="owner")
        assert out["values"] == [] and out["complete"] is False


class TestNameLookups:
    async def test_a_failed_lookup_is_not_remembered_as_not_found(self, monkeypatch):
        monkeypatch.setattr(refs_mod, "_RESOLVED", {})
        db = _Db(TimeoutError())
        provider = SimpleNamespace(_ro_query=db._ro_query, _graph_name="g",
                                   _get_containment_edge_types=lambda: ["CONTAINS"])

        async def run(cypher, params):
            if "RETURN ID(_r) AS id" in cypher:
                return SimpleNamespace(result_set=[[7]])
            if "RETURN _n.urn" in cypher:
                return SimpleNamespace(result_set=[["urn:sales", "Sales", "Dataset"]])
            return SimpleNamespace(result_set=[])

        scope = SearchScope(view_id="v", scope_mode="data_source")
        ref = NodeRef(path=["Sales"])
        with pytest.raises(ProviderBusy):
            await refs_mod.resolve_refs(provider, scope, [ref], run=run, data_version="1")
        assert refs_mod._RESOLVED == {}
        [answer] = await refs_mod.resolve_refs(provider, scope, [ref], run=run,
                                               data_version="1")
        assert answer["urns"] == ["urn:sales"] and answer["error"] is None


class _Provider:
    """What the engine reads itself before planning: whether the graph keeps
    properties raw (it keeps none), then the labels — busy ``fail`` times."""

    def __init__(self, fail):
        self.db = _Db(TimeoutError(), fail=fail)
        self._redis = None
        self._cache_ns = None

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _get_lineage_edge_types(self):
        return []

    async def _ro_query(self, cypher, params=None, *, timeout=None, op=None):
        return await self.db._ro_query(cypher, params, timeout=timeout)

    async def get_nodes_batch(self, urns):
        return []


class TestSessionSearch:
    async def test_a_busy_graph_keeps_no_empty_answer(self, monkeypatch):
        from backend.app.providers.falkordb_search import session as session_mod
        store = MemorySessionStore()
        monkeypatch.setattr(session_mod, "_MEMORY", store)
        query = SearchQuery.model_validate({
            "predicate": {"kind": "text", "value": "orders"},
            "scope": {"viewId": "v", "scopeMode": "data_source"},
            "options": {"results": "hits", "pageSize": 5}})
        context = SearchRunContext(data_version="1", scope_hash="h")
        provider = _Provider(fail=1)

        with pytest.raises(ProviderBusy):
            await engine_mod.execute_session_search(provider, query, context=context)
        # Nothing was kept under the search's session: the next request plans
        # again instead of finding "complete, 0 matches".
        assert not store._sessions

        await engine_mod.execute_session_search(provider, query, context=context)
        assert provider.db.lookups == 2
