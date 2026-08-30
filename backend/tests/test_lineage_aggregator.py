"""
Unit tests for backend.app.services.lineage_aggregator.LineageAggregator

Covers:
- materialize_lineage delegates to provider
- backfill_all_lineage (no-op currently)
- get_aggregator() factory function
"""
from typing import Any, Dict, List, Optional

import pytest

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import (
    GraphEdge,
    GraphNode,
    GraphSchemaStats,
    LineageResult,
    NodeQuery,
    EdgeQuery,
    OntologyMetadata,
)
from backend.app.services.lineage_aggregator import LineageAggregator, get_aggregator


# ---------------------------------------------------------------------------
# Stub provider
# ---------------------------------------------------------------------------


class _StubFalkorDBProvider:
    """
    Minimal stub that looks like FalkorDBProvider for lineage aggregator tests.
    Tracks calls to materialize_lineage_for_edge for assertion.
    """

    def __init__(self):
        self.materialize_calls: List[dict] = []

    async def materialize_lineage_for_edge(
        self, source_urn: str, target_urn: str, lineage_edge_type: str
    ):
        self.materialize_calls.append({
            "source_urn": source_urn,
            "target_urn": target_urn,
            "lineage_edge_type": lineage_edge_type,
        })


class _StubFalkorDBProviderWithError:
    """Provider that raises on materialize_lineage_for_edge."""

    async def materialize_lineage_for_edge(self, source_urn, target_urn, lineage_edge_type):
        raise RuntimeError("DB connection failed")


# ---------------------------------------------------------------------------
# Tests — materialize_lineage
# ---------------------------------------------------------------------------


class TestMaterializeLineage:

    async def test_materialize_delegates_to_provider(self):
        """materialize_lineage calls provider.materialize_lineage_for_edge."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        await aggregator.materialize_lineage("urn:col:a", "urn:col:b", "TRANSFORMS")

        assert len(provider.materialize_calls) == 1
        call = provider.materialize_calls[0]
        assert call["source_urn"] == "urn:col:a"
        assert call["target_urn"] == "urn:col:b"
        assert call["lineage_edge_type"] == "TRANSFORMS"

    async def test_materialize_with_default_edge_type(self):
        """Default lineage_edge_type is TRANSFORMS."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        await aggregator.materialize_lineage("urn:a", "urn:b")

        assert provider.materialize_calls[0]["lineage_edge_type"] == "TRANSFORMS"

    async def test_materialize_with_custom_edge_type(self):
        """Custom edge type is passed through."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        await aggregator.materialize_lineage("urn:a", "urn:b", "PRODUCES")

        assert provider.materialize_calls[0]["lineage_edge_type"] == "PRODUCES"

    async def test_materialize_propagates_provider_error(self):
        """If provider raises, the error propagates up."""
        provider = _StubFalkorDBProviderWithError()
        aggregator = LineageAggregator(provider=provider)

        with pytest.raises(RuntimeError, match="DB connection failed"):
            await aggregator.materialize_lineage("urn:a", "urn:b")

    async def test_materialize_multiple_edges(self):
        """Multiple calls each delegate independently."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        await aggregator.materialize_lineage("urn:a", "urn:b")
        await aggregator.materialize_lineage("urn:c", "urn:d")
        await aggregator.materialize_lineage("urn:e", "urn:f")

        assert len(provider.materialize_calls) == 3


# ---------------------------------------------------------------------------
# Tests — backfill_all_lineage
# ---------------------------------------------------------------------------


class TestBackfillAllLineage:

    async def test_backfill_is_noop(self):
        """backfill_all_lineage currently does nothing (pass body)."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        # Should not raise
        await aggregator.backfill_all_lineage()

        # No provider calls expected from backfill
        assert len(provider.materialize_calls) == 0


# ---------------------------------------------------------------------------
# Tests — edge cases
# ---------------------------------------------------------------------------


class TestLineageAggregatorEdgeCases:

    async def test_empty_urns(self):
        """Empty URNs are passed through (no validation in aggregator)."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        await aggregator.materialize_lineage("", "", "TRANSFORMS")

        assert len(provider.materialize_calls) == 1
        assert provider.materialize_calls[0]["source_urn"] == ""

    async def test_same_source_and_target(self):
        """Self-loop edge is delegated without error."""
        provider = _StubFalkorDBProvider()
        aggregator = LineageAggregator(provider=provider)

        await aggregator.materialize_lineage("urn:a", "urn:a", "TRANSFORMS")

        assert len(provider.materialize_calls) == 1


# ---------------------------------------------------------------------------
# Tests — get_aggregator() factory function
#
# Plan §1.5 D6 / T-C: this used to be `isinstance(provider, FalkorDBProvider)`
# — a name-based check that could never recognize a second provider with the
# same capability. Now it's `supports_feature(provider, AGGREGATION_
# MATERIALIZATION)`, keyed off the catalog's `provider_type`, same as
# `ContextEngine.materialize_aggregated_edges`'s gate. `_StubFalkorDBProvider`
# (used above) predates `provider_type` and deliberately doesn't set it, so
# these tests use their own fakes that do.
# ---------------------------------------------------------------------------


class _TypedProvider(_StubFalkorDBProvider):
    """`_StubFalkorDBProvider` plus a catalog `provider_type` — what
    `supports_feature` actually keys off, replacing the old class-identity
    check."""
    provider_type = "falkordb"


class _TypedProviderWithoutTheFeature(_StubFalkorDBProvider):
    """A registered provider type that does NOT support batch materialization
    (see the plan §2.3 feature matrix: neo4j has no AGGREGATION_MATERIALIZATION)."""
    provider_type = "neo4j"


class TestGetAggregator:

    def test_returns_an_aggregator_for_a_provider_typed_falkordb(self):
        # Registers "falkordb" in backend.common.providers.catalog (see that
        # package's __init__ docstring: FalkorDB self-registers from there,
        # not from the kernel, so nothing has necessarily imported it yet in
        # a unit-test process). Without this, supports_feature sees an
        # unregistered type and falls back to the safe default (unsupported).
        import backend.app.providers.falkordb_provider  # noqa: F401
        provider = _TypedProvider()
        aggregator = get_aggregator(provider)

        assert isinstance(aggregator, LineageAggregator)
        assert aggregator.provider is provider

    def test_returns_none_for_a_registered_type_without_the_feature(self):
        assert get_aggregator(_TypedProviderWithoutTheFeature()) is None

    def test_returns_none_for_an_untyped_provider(self):
        """A provider with no `provider_type` at all (e.g. an old-style
        stub, or a test double) — unknown types default to unsupported."""
        assert get_aggregator(_StubFalkorDBProvider()) is None

    def test_returns_none_for_none(self):
        assert get_aggregator(None) is None
