"""Pure unit tests for graph_source_repo content-addressing.

The DB-touching paths (apply_source_diff, start/finish_snapshot,
list_orphans) are integration-suite territory. What's pure-enough to
pin here:

- node/edge content_hash stability across equal-content inputs
- root_hash order-independence (two clients in different order agree)
- root_hash sensitivity to a single byte change in a properties dict
"""
from __future__ import annotations

from backend.app.db.repositories.graph_source_repo import (
    _edge_content_hash,
    _node_content_hash,
    _root_hash,
)


def test_node_content_hash_stable_across_property_dict_order():
    h1 = _node_content_hash(
        urn="u:n1", entity_type="Dataset", display_name="D",
        position=None, properties={"a": 1, "b": 2}, tags=["x"],
    )
    h2 = _node_content_hash(
        urn="u:n1", entity_type="Dataset", display_name="D",
        position=None, properties={"b": 2, "a": 1}, tags=["x"],
    )
    assert h1 == h2


def test_node_content_hash_differs_on_display_name_change():
    a = _node_content_hash(
        urn="u:n1", entity_type="Dataset", display_name="A",
        position=None, properties={}, tags=[],
    )
    b = _node_content_hash(
        urn="u:n1", entity_type="Dataset", display_name="B",
        position=None, properties={}, tags=[],
    )
    assert a != b


def test_edge_content_hash_includes_endpoints():
    e1 = _edge_content_hash(
        urn="e1", source_urn="u:a", target_urn="u:b",
        edge_type="flows_to", properties={}, tags=[],
    )
    e2 = _edge_content_hash(
        urn="e1", source_urn="u:a", target_urn="u:c",
        edge_type="flows_to", properties={}, tags=[],
    )
    assert e1 != e2


def test_root_hash_order_independent():
    h1 = _root_hash(["h1", "h2", "h3"], ["e1", "e2"])
    h2 = _root_hash(["h3", "h1", "h2"], ["e2", "e1"])
    assert h1 == h2


def test_root_hash_sensitive_to_single_node_change():
    a = _root_hash(["h1", "h2"], ["e1"])
    b = _root_hash(["h1_CHANGED", "h2"], ["e1"])
    assert a != b


def test_root_hash_distinguishes_node_set_from_edge_set():
    # An "h1" in nodes vs "h1" in edges must produce different roots.
    a = _root_hash(["h1"], [])
    b = _root_hash([], ["h1"])
    assert a != b
