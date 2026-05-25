"""Service-layer integration tests against the in-memory stub provider.

These tests bypass FalkorDB entirely. They verify that the
``DeepSearchProvider`` Protocol (W0.3) is implementable end-to-end and
that the most common predicate kinds round-trip through the stub.

Why this exists:
  * CI runs without a graph backend. Until W0.4 there was no way to
    exercise the HTTP / service layer in a unit-test environment.
  * Phase 3 will graduate these into full HTTP integration tests
    against a FastAPI test client; the per-predicate coverage here
    is the building block.
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

from backend.app.services.deep_search import (
    CompileError,
    DeepSearchProvider,
)
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider
from backend.common.models.search import (
    EntityTypePredicate,
    GroupPredicate,
    HasPropertyPredicate,
    LayerPredicate,
    PropertyPredicate,
    SearchOptions,
    SearchQuery,
    SearchScope,
    TagPredicate,
    TextPredicate,
)


# ---------------------------------------------------------------------------
# Fixture: small graph that covers the predicate surface we test.
# ---------------------------------------------------------------------------


def _fixture_nodes() -> List[Dict[str, Any]]:
    return [
        {
            "urn": "urn:dataset:orders",
            "entityType": "dataset",
            "displayName": "Orders",
            "qualifiedName": "warehouse.public.orders",
            "description": "Customer order events",
            "tags": ["PII", "GDPR"],
            "layerAssignment": "Source",
            "rowCount": 5_000_000,
            "owner": "data-platform",
            "sourceSystem": "snowflake",
        },
        {
            "urn": "urn:dataset:customers",
            "entityType": "dataset",
            "displayName": "Customers",
            "qualifiedName": "warehouse.public.customers",
            "description": "Customer master",
            "tags": ["PII"],
            "layerAssignment": "Source",
            "rowCount": 250_000,
            "owner": "data-platform",
            "sourceSystem": "snowflake",
        },
        {
            "urn": "urn:dataset:reporting_daily",
            "entityType": "dataset",
            "displayName": "ReportingDaily",
            "qualifiedName": "marts.reporting.daily",
            "description": "Daily KPI rollup",
            "tags": [],
            "layerAssignment": "Gold",
            "rowCount": 365,
            "owner": "analytics",
            "sourceSystem": "dbt",
        },
        {
            "urn": "urn:domain:customers",
            "entityType": "domain",
            "displayName": "Customers Domain",
            "qualifiedName": "domain:customers",
            "description": "",
            "tags": [],
            "layerAssignment": None,
        },
    ]


def _fixture_edges() -> List[Dict[str, Any]]:
    return [
        {
            "source": "urn:dataset:customers",
            "target": "urn:dataset:reporting_daily",
            "type": "LINEAGE",
            "confidence": 0.95,
        },
        {
            "source": "urn:dataset:orders",
            "target": "urn:dataset:reporting_daily",
            "type": "LINEAGE",
            "confidence": 0.42,
        },
    ]


@pytest.fixture
def stub() -> StubDeepSearchProvider:
    return StubDeepSearchProvider(
        nodes=_fixture_nodes(), edges=_fixture_edges(),
    )


def _query(predicate, *, results: str = "hits", page_size: int = 50) -> SearchQuery:
    """Convenience builder. The stub bypasses ViewScopeResolver, so we
    can pass a minimal scope with just ``view_id``."""
    return SearchQuery(
        predicate=predicate,
        scope=SearchScope(view_id="test-view"),
        options=SearchOptions(results=results, page_size=page_size),
    )


# ---------------------------------------------------------------------------
# Protocol conformance + happy path
# ---------------------------------------------------------------------------


def test_stub_satisfies_protocol(stub):
    """The runtime-checkable Protocol accepts our stub."""
    assert isinstance(stub, DeepSearchProvider)


@pytest.mark.asyncio
async def test_deep_search_returns_search_result_page(stub):
    query = _query(EntityTypePredicate(op="in", values=["dataset"]))
    page = await stub.deep_search(query)
    assert page.candidate_count == 3  # three datasets in the fixture
    assert page.hits is not None
    assert {h.node.urn for h in page.hits} == {
        "urn:dataset:orders",
        "urn:dataset:customers",
        "urn:dataset:reporting_daily",
    }


@pytest.mark.asyncio
async def test_deep_search_explain_shape(stub):
    query = _query(EntityTypePredicate(op="in", values=["dataset"]))
    result = await stub.deep_search_explain(query)
    # The stub doesn't emit real Cypher; it returns the same dict shape
    # the FE dev panel expects from explain_deep_search.
    for key in (
        "cypher", "hits_cypher", "params", "candidate_cap",
        "hoisted_root_urns", "effective_root_urns", "notes",
    ):
        assert key in result
    assert "stub" in result["cypher"]
    assert isinstance(result["candidate_cap"], int)


@pytest.mark.asyncio
async def test_deep_search_discover_walks_fixture(stub):
    result = await stub.deep_search_discover(sample_per_label=200)
    assert "dataset" in result["labels"]
    assert "domain" in result["labels"]
    # PII appears twice (orders + customers); GDPR once.
    assert result["tagValues"]["PII"] == 2
    assert result["tagValues"]["GDPR"] == 1
    # Edge discovery surfaces the LINEAGE edge with its confidence key.
    assert "LINEAGE" in result["edges"]
    assert "confidence" in result["edges"]["LINEAGE"]["keys"]


# ---------------------------------------------------------------------------
# Per-predicate coverage — the predicate kinds the smoke tests need.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_property_predicate_eq(stub):
    query = _query(PropertyPredicate(key="sourceSystem", op="eq", value="snowflake"))
    page = await stub.deep_search(query)
    assert page.candidate_count == 2


@pytest.mark.asyncio
async def test_property_predicate_gt(stub):
    query = _query(PropertyPredicate(key="rowCount", op="gt", value=1_000_000))
    page = await stub.deep_search(query)
    assert page.candidate_count == 1
    assert page.hits[0].node.urn == "urn:dataset:orders"


@pytest.mark.asyncio
async def test_property_predicate_between(stub):
    query = _query(PropertyPredicate(
        key="rowCount", op="between", value=[100, 1_000_000],
    ))
    page = await stub.deep_search(query)
    assert page.candidate_count == 2  # customers + reporting_daily


@pytest.mark.asyncio
async def test_has_property_predicate(stub):
    query = _query(HasPropertyPredicate(key="sourceSystem"))
    page = await stub.deep_search(query)
    # Only the three datasets have sourceSystem (the domain doesn't).
    assert page.candidate_count == 3


@pytest.mark.asyncio
async def test_tag_predicate_has_any(stub):
    query = _query(TagPredicate(op="hasAny", values=["PII"]))
    page = await stub.deep_search(query)
    assert {h.node.urn for h in page.hits} == {
        "urn:dataset:orders", "urn:dataset:customers",
    }


@pytest.mark.asyncio
async def test_tag_predicate_not_has(stub):
    query = _query(TagPredicate(op="notHas", values=["PII"]))
    page = await stub.deep_search(query)
    assert {h.node.urn for h in page.hits} == {
        "urn:dataset:reporting_daily", "urn:domain:customers",
    }


@pytest.mark.asyncio
async def test_layer_predicate(stub):
    query = _query(LayerPredicate(layer_assignment="Source"))
    page = await stub.deep_search(query)
    assert page.candidate_count == 2  # orders + customers


@pytest.mark.asyncio
async def test_text_predicate_target_any(stub):
    query = _query(TextPredicate(value="orders", target="any", match="substring"))
    page = await stub.deep_search(query)
    assert any(h.node.urn == "urn:dataset:orders" for h in page.hits)


@pytest.mark.asyncio
async def test_text_predicate_substring_matches_property_value(stub):
    """The stub's target='any' search includes string fields (display
    name, qualifiedName, description, tags). Property-value matching is
    a W1.3 enhancement; the stub does not yet include arbitrary
    property strings."""
    query = _query(TextPredicate(value="reporting", target="any"))
    page = await stub.deep_search(query)
    assert any(
        h.node.urn == "urn:dataset:reporting_daily" for h in page.hits
    )


@pytest.mark.asyncio
async def test_group_predicate_and(stub):
    query = _query(GroupPredicate(op="and", children=[
        EntityTypePredicate(op="in", values=["dataset"]),
        TagPredicate(op="hasAny", values=["PII"]),
    ]))
    page = await stub.deep_search(query)
    assert page.candidate_count == 2


@pytest.mark.asyncio
async def test_group_predicate_or(stub):
    query = _query(GroupPredicate(op="or", children=[
        LayerPredicate(layer_assignment="Gold"),
        TagPredicate(op="hasAny", values=["GDPR"]),
    ]))
    page = await stub.deep_search(query)
    # orders has GDPR + reporting_daily is Gold = 2 hits.
    assert {h.node.urn for h in page.hits} == {
        "urn:dataset:orders", "urn:dataset:reporting_daily",
    }


@pytest.mark.asyncio
async def test_group_predicate_not(stub):
    query = _query(GroupPredicate(op="not", children=[
        EntityTypePredicate(op="in", values=["domain"]),
    ]))
    page = await stub.deep_search(query)
    # Three datasets, no domain.
    assert page.candidate_count == 3


# ---------------------------------------------------------------------------
# Negative paths — the stub raises CompileError on unsupported kinds.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unsupported_predicate_raises_compile_error(stub):
    # PathPredicate isn't implemented in the stub; the test confirms
    # the stub fails LOUDLY rather than silently returning wrong rows.
    from backend.common.models.search import PathPredicate
    query = _query(PathPredicate(
        source_urns=["urn:dataset:orders"],
        target_urns=["urn:dataset:reporting_daily"],
        max_hops=4,
    ))
    with pytest.raises(CompileError):
        await stub.deep_search(query)
