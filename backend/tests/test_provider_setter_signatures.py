"""Provider setter-signature conformance — pure unit tests, no I/O.

Plan §1.5 D2: ``ContextEngine._inject_resolved`` calls every provider's
``set_containment_edge_types(types, from_ontology=...)`` — a KEYWORD
argument every ``GraphDataProvider`` subclass must accept, since the engine
calls it on whichever provider is currently resolved without knowing (or
caring) which adapter that is.

Neo4j's own override had dropped the parameter entirely
(``def set_containment_edge_types(self, types)``) — a ``TypeError`` the
instant ContextEngine pointed at a Neo4j provider — and, independently,
never observed the ``from_ontology`` guard the base class's default relies
on to distinguish "the ontology resolved to empty" from "an introspection
probe found nothing" (see ``GraphDataProvider.set_containment_edge_types``'s
docstring). Its override did nothing the base default does not already do
(same upper-casing, same sentinel), only less correctly, so it was deleted
rather than patched — Neo4j now inherits the base implementation.

This pins the fix against Neo4j specifically, and against Spanner's own
(already correct, already-parameterised) override as a second data point,
so the contract has more than one example.
"""
from __future__ import annotations

import pytest

from backend.common.interfaces.provider import GraphDataProvider
from backend.graph.adapters.neo4j_provider import Neo4jProvider
from backend.graph.adapters.spanner_provider import SpannerProvider


def _neo4j() -> Neo4jProvider:
    return Neo4jProvider(uri="bolt://localhost:7687", username="neo4j", password="test")


def _spanner() -> SpannerProvider:
    return SpannerProvider(project_id="p", instance_id="i", database_id="d")


@pytest.mark.parametrize("make_provider", [_neo4j, _spanner], ids=["neo4j", "spanner"])
def test_set_containment_edge_types_accepts_the_context_engine_call_shape(make_provider):
    """The exact call ContextEngine._inject_resolved makes: a positional list
    plus the ``from_ontology`` keyword. Must not raise TypeError."""
    provider = make_provider()
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    assert provider.containment_configured is True


def test_neo4j_inherits_the_base_setter_rather_than_overriding_it():
    """Regression for the crash: Neo4j had its own positional-only override.
    It is now inherited from GraphDataProvider rather than redefined --
    confirmed directly, not just by absence of a TypeError above."""
    assert Neo4jProvider.set_containment_edge_types is GraphDataProvider.set_containment_edge_types


def test_neo4j_introspection_only_empty_does_not_mark_containment_configured():
    """``from_ontology=False`` with an empty list is an introspection probe
    that found nothing -- it must NOT be taken as "resolved to empty" (the
    base class's documented distinction). Neo4j's deleted override did not
    observe this and would have marked the sentinel configured regardless."""
    provider = _neo4j()
    provider.set_containment_edge_types([], from_ontology=False)
    assert provider.containment_configured is False


def test_neo4j_positional_only_call_shape_still_works():
    """Pre-existing 1-arg call sites (aggregation worker, scripts) must keep
    working: ``from_ontology`` defaults to True, so a truthy ``types`` list
    always configures."""
    provider = _neo4j()
    provider.set_containment_edge_types(["HAS"])
    assert provider.containment_configured is True
