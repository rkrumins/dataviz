"""Unit tests for the ``query_timeout`` / ``known_total_count`` kwargs added
to ``get_top_level_or_orphan_nodes`` on FalkorDBProvider and ContextEngine.

No live FalkorDB required — ``_ro_query`` is monkeypatched (same pattern as
``test_falkordb_failloud.py``).
"""
from __future__ import annotations

import pytest

from backend.app.config import resilience
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import OntologyMetadata, TopLevelNodesResult


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0  # skip the redis cache read/write path

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    # Empty containment set = flat graph (a valid resolved state); keeps
    # `_get_containment_edge_types()` from raising ProviderConfigurationError.
    p._resolved_containment_types = set()
    p._resolved_containment_types_set = True
    return p


class _Result:
    def __init__(self, result_set):
        self.result_set = result_set


def _recording_ro_query(calls):
    """Records (cypher, params, timeout) for every call; count query
    returns a total of 7 so tests can distinguish "count ran" from not."""
    async def _ro_query(cypher, params=None, **kw):
        calls.append((cypher, params, kw.get("timeout")))
        if "count(" in cypher.lower():
            return _Result([[7]])
        return _Result([])
    return _ro_query


# ── Provider-level: timeout propagation ─────────────────────────────

@pytest.mark.asyncio
async def test_default_timeout_used_for_both_queries(monkeypatch):
    p = _make_provider()
    calls = []
    monkeypatch.setattr(p, "_ro_query", _recording_ro_query(calls))
    await p.get_top_level_or_orphan_nodes(include_child_count=False)
    assert len(calls) == 2
    assert calls[0][2] == resilience.FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS
    assert calls[1][2] == resilience.FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS


@pytest.mark.asyncio
async def test_query_timeout_override_propagates_to_both_queries(monkeypatch):
    p = _make_provider()
    calls = []
    monkeypatch.setattr(p, "_ro_query", _recording_ro_query(calls))
    await p.get_top_level_or_orphan_nodes(include_child_count=False, query_timeout=99)
    assert len(calls) == 2
    assert calls[0][2] == 99
    assert calls[1][2] == 99


# ── Provider-level: known_total_count skips the count query ────────

@pytest.mark.asyncio
async def test_known_total_count_skips_count_query(monkeypatch):
    p = _make_provider()
    calls = []
    monkeypatch.setattr(p, "_ro_query", _recording_ro_query(calls))
    result = await p.get_top_level_or_orphan_nodes(
        include_child_count=False, known_total_count=42,
    )
    assert len(calls) == 1  # only the page query ran
    assert result.total_count == 42


# ── Engine-level: pass-through + TypeError fallback ─────────────────

def _ontology_meta() -> OntologyMetadata:
    return OntologyMetadata(
        containmentEdgeTypes=[], lineageEdgeTypes=[], edgeTypeMetadata={},
        entityTypeHierarchy={}, rootEntityTypes=[],
    )


class _OldSignatureProvider:
    """Mimics DraftOverlayProvider / VersionedBranchProvider: fixed
    keyword-only signature, no query_timeout/known_total_count."""

    def __init__(self):
        self.calls = []

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return _ontology_meta()

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types=None, entity_types=None, search_query=None,
        limit: int = 100, cursor=None, include_child_count: bool = True,
    ) -> TopLevelNodesResult:
        self.calls.append({"limit": limit})
        return TopLevelNodesResult(nodes=[], totalCount=0, hasMore=False)


class _NewSignatureProvider(_OldSignatureProvider):
    """Accepts the new kwargs (e.g. FalkorDBProvider)."""

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types=None, entity_types=None, search_query=None,
        limit: int = 100, cursor=None, include_child_count: bool = True,
        query_timeout=None, known_total_count=None,
    ) -> TopLevelNodesResult:
        self.calls.append(
            {"query_timeout": query_timeout, "known_total_count": known_total_count}
        )
        return TopLevelNodesResult(
            nodes=[], totalCount=known_total_count or 0, hasMore=False,
        )


@pytest.mark.asyncio
async def test_engine_retries_without_extra_kwargs_on_old_provider():
    """Old fixed-signature provider raises TypeError on the new kwargs;
    the engine must retry once without them rather than propagating it."""
    provider = _OldSignatureProvider()
    engine = ContextEngine(provider=provider)
    result = await engine.get_top_level_or_orphan_nodes(known_total_count=1)
    assert result.total_count == 0  # old provider never saw known_total_count
    assert len(provider.calls) == 1  # only the successful retry call landed


@pytest.mark.asyncio
async def test_engine_passes_new_kwargs_to_new_provider():
    provider = _NewSignatureProvider()
    engine = ContextEngine(provider=provider)
    result = await engine.get_top_level_or_orphan_nodes(
        known_total_count=1, query_timeout=5,
    )
    assert result.total_count == 1
    assert provider.calls[0]["query_timeout"] == 5
    assert provider.calls[0]["known_total_count"] == 1
