"""Pure unit tests for the source + enrichment composition function.

Pins every rule from the layered-model addendum so a future tweak
(field-level merge change, tag policy, suppression semantics) doesn't
regress silently.
"""
from __future__ import annotations

from backend.app.services.graph_composition import (
    EnrichmentEdgeProjection,
    EnrichmentNodeProjection,
    SourceEdgeProjection,
    SourceNodeProjection,
    compose,
)


def _sn(urn, **kw):
    return SourceNodeProjection(
        urn=urn,
        entity_type=kw.get("entity_type", "Dataset"),
        display_name=kw.get("display_name", urn),
        position=kw.get("position"),
        properties=kw.get("properties", {}),
        tags=tuple(kw.get("tags", [])),
    )


def _en(urn, **kw):
    return EnrichmentNodeProjection(
        urn=urn,
        entity_type=kw.get("entity_type"),
        display_name=kw.get("display_name"),
        position=kw.get("position"),
        properties=kw.get("properties", {}),
        tags=tuple(kw.get("tags", [])),
        deleted=kw.get("deleted", False),
    )


def _se(urn, src, tgt, **kw):
    return SourceEdgeProjection(
        urn=urn, source_urn=src, target_urn=tgt,
        edge_type=kw.get("edge_type", "flows_to"),
        properties=kw.get("properties", {}),
        tags=tuple(kw.get("tags", [])),
    )


def _ee(urn, src, tgt, **kw):
    return EnrichmentEdgeProjection(
        urn=urn, source_urn=src, target_urn=tgt,
        edge_type=kw.get("edge_type"),
        properties=kw.get("properties", {}),
        tags=tuple(kw.get("tags", [])),
        deleted=kw.get("deleted", False),
    )


def test_source_only_node_passes_through():
    g = compose(
        source_nodes={"u:n1": _sn("u:n1", display_name="Source name")},
        source_edges={},
        enrichment_nodes={}, enrichment_edges={},
    )
    assert g.nodes["u:n1"].origin == "source"
    assert g.nodes["u:n1"].display_name == "Source name"


def test_enrichment_only_node_passes_through():
    g = compose(
        source_nodes={}, source_edges={},
        enrichment_nodes={"u:n2": _en("u:n2", entity_type="Tag", display_name="User add")},
        enrichment_edges={},
    )
    assert g.nodes["u:n2"].origin == "enrichment"
    assert g.nodes["u:n2"].display_name == "User add"


def test_hybrid_node_enrichment_overrides_source_display_name():
    g = compose(
        source_nodes={"u:n3": _sn("u:n3", display_name="Source", entity_type="Dataset")},
        source_edges={},
        enrichment_nodes={"u:n3": _en("u:n3", display_name="Curated by Alice")},
        enrichment_edges={},
    )
    n = g.nodes["u:n3"]
    assert n.origin == "hybrid"
    assert n.display_name == "Curated by Alice"
    # entity_type fell through because enrichment didn't set it.
    assert n.entity_type == "Dataset"


def test_hybrid_node_properties_merge_with_enrichment_winning():
    g = compose(
        source_nodes={"u:n4": _sn("u:n4", properties={"a": 1, "b": 2})},
        source_edges={},
        enrichment_nodes={"u:n4": _en("u:n4", properties={"b": 99, "c": 3})},
        enrichment_edges={},
    )
    assert g.nodes["u:n4"].properties == {"a": 1, "b": 99, "c": 3}


def test_hybrid_node_tags_union_preserves_source_order():
    g = compose(
        source_nodes={"u:n5": _sn("u:n5", tags=["red", "green"])},
        source_edges={},
        enrichment_nodes={"u:n5": _en("u:n5", tags=["green", "blue"])},
        enrichment_edges={},
    )
    assert g.nodes["u:n5"].tags == ("red", "green", "blue")


def test_enrichment_tombstone_suppresses_source_node():
    g = compose(
        source_nodes={"u:n6": _sn("u:n6")},
        source_edges={},
        enrichment_nodes={"u:n6": _en("u:n6", deleted=True)},
        enrichment_edges={},
    )
    assert "u:n6" not in g.nodes
    assert g.diagnostics.nodes_suppressed_by_enrichment == 1


def test_dangling_edge_dropped_with_diagnostic():
    # Edge references a node that exists in neither layer.
    g = compose(
        source_nodes={"u:n1": _sn("u:n1")},
        source_edges={"e1": _se("e1", "u:n1", "u:GONE")},
        enrichment_nodes={}, enrichment_edges={},
    )
    assert "e1" not in g.edges
    assert g.diagnostics.edges_dropped_dangling == 1
    assert g.diagnostics.edges_dropped_endpoint_suppressed == 0


def test_edge_endpoint_suppressed_separately_counted():
    # Endpoint existed in input but was suppressed by enrichment tombstone.
    g = compose(
        source_nodes={"u:n1": _sn("u:n1"), "u:n2": _sn("u:n2")},
        source_edges={"e1": _se("e1", "u:n1", "u:n2")},
        enrichment_nodes={"u:n2": _en("u:n2", deleted=True)},
        enrichment_edges={},
    )
    assert "e1" not in g.edges
    assert g.diagnostics.edges_dropped_endpoint_suppressed == 1
    assert g.diagnostics.edges_dropped_dangling == 0


def test_enrichment_tombstone_on_edge_suppresses_source_edge():
    g = compose(
        source_nodes={"u:n1": _sn("u:n1"), "u:n2": _sn("u:n2")},
        source_edges={"e1": _se("e1", "u:n1", "u:n2")},
        enrichment_nodes={},
        enrichment_edges={"e1": _ee("e1", "u:n1", "u:n2", deleted=True)},
    )
    assert "e1" not in g.edges
    assert g.diagnostics.edges_suppressed_by_enrichment == 1


def test_pure_enrichment_graph_no_source_layer():
    # Mode-1 (authored) graphs hit composition with empty source maps.
    g = compose(
        source_nodes={}, source_edges={},
        enrichment_nodes={
            "u:n1": _en("u:n1", entity_type="Layer", display_name="Bronze"),
            "u:n2": _en("u:n2", entity_type="Layer", display_name="Silver"),
        },
        enrichment_edges={"e1": _ee("e1", "u:n1", "u:n2", edge_type="contains")},
    )
    assert set(g.nodes) == {"u:n1", "u:n2"}
    assert g.nodes["u:n1"].origin == "enrichment"
    assert g.edges["e1"].origin == "enrichment"
