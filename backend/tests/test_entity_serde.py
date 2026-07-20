"""Canonical entity ↔ payload serialization contract (entity_serde).

The bug this closes: five edge producers FLATTENED user props to the payload top level and dropped
`confidence`, while the reseed reads the canonical `{confidence(top), properties(nested)}` shape —
so a rebuild blanked every edge's confidence + properties. These tests pin the canonical shape and
the both-ways tolerance of `row_to_edge_payload` / `payload_to_edge`.
"""
from backend.app.services.versioning import entity_serde as es
from backend.common.models.graph import GraphEdge, GraphNode


def test_edge_to_payload_is_canonical():
    e = GraphEdge(id="E1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS",
                  confidence=0.9, properties={"sql": "select 1", "cols": ["a", "b"]})
    p = es.edge_to_payload(e)
    assert p == {"edgeType": "FLOWS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
                 "confidence": 0.9, "properties": {"sql": "select 1", "cols": ["a", "b"]}}


def test_edge_to_payload_omits_empty_confidence_and_properties():
    e = GraphEdge(id="E", sourceUrn="a", targetUrn="b", edgeType="REL")
    assert es.edge_to_payload(e) == {"edgeType": "REL", "sourceEntityId": "a", "targetEntityId": "b"}


def test_row_to_edge_payload_canonical_row_passthrough():
    row = {"kind": "edge", "id": "E1", "edgeType": "FLOWS",
           "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
           "confidence": 0.42, "properties": {"k": "v"}}
    assert es.row_to_edge_payload(row) == {
        "edgeType": "FLOWS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
        "confidence": 0.42, "properties": {"k": "v"}}


def test_row_to_edge_payload_recovers_legacy_flattened():
    # The pre-fix shape: user props spread at top level, endpoints as source/target, no confidence.
    legacy = {"kind": "edge", "id": "E1", "edgeType": "FLOWS",
              "source": "urn:a", "target": "urn:b", "sql": "select 1", "weight": 3}
    p = es.row_to_edge_payload(legacy)
    assert p["sourceEntityId"] == "urn:a" and p["targetEntityId"] == "urn:b"
    assert p["edgeType"] == "FLOWS"
    assert p["properties"] == {"sql": "select 1", "weight": 3}   # re-nested, not lost
    assert "confidence" not in p                                  # legacy never stored it


def test_payload_to_edge_roundtrips_both_shapes():
    e = GraphEdge(id="E1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS",
                  confidence=0.7, properties={"m": {"nested": 1}})
    back = es.payload_to_edge("E1", es.edge_to_payload(e))
    assert back.source_urn == "urn:a" and back.target_urn == "urn:b"
    assert back.edge_type == "FLOWS" and back.confidence == 0.7
    assert back.properties == {"m": {"nested": 1}}
    # legacy flattened payload recovers identically (minus confidence, never stored)
    legacy = {"edgeType": "FLOWS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b", "m": {"nested": 1}}
    lback = es.payload_to_edge("E1", legacy)
    assert lback.properties == {"m": {"nested": 1}} and lback.confidence is None


def test_node_to_payload_nests_properties():
    n = GraphNode(urn="urn:x", entityType="Layer", displayName="Sales",
                  properties={"owner": "team-a"})
    p = es.node_to_payload(n)
    assert p["urn"] == "urn:x" and p["entityType"] == "Layer" and p["displayName"] == "Sales"
    assert p["properties"] == {"owner": "team-a"}                 # nested, not flattened


def test_node_payload_roundtrips():
    n = GraphNode(urn="urn:x", entityType="Object", displayName="Accounts",
                  properties={"rows": 10})
    back = es.payload_to_node("urn:x", es.node_to_payload(n))
    assert back.urn == "urn:x" and back.entity_type == "Object"
    assert back.display_name == "Accounts" and back.properties == {"rows": 10}


def test_discriminator_preserved_top_level_when_present():
    row = {"kind": "edge", "edgeType": "FLOWS", "sourceEntityId": "a", "targetEntityId": "b",
           "discriminator": "d1", "properties": {"k": "v"}}
    p = es.row_to_edge_payload(row)
    assert p["discriminator"] == "d1" and p["properties"] == {"k": "v"}


def test_edge_payload_matches_versioned_branch_provider():
    """The write-through edit path serializes edges via ``versioned_branch_provider._edge_payload`` —
    a SEPARATE implementation from ``entity_serde.edge_to_payload``. If the two drift, an edit and a
    bootstrap/reseed would store DIFFERENT shapes for the same edge and the round-trip breaks. This
    pins them equal (a drift guard as a test, not a runtime import, so providers stays cycle-free)."""
    from backend.app.providers.versioned_branch_provider import _edge_payload
    cases = [
        GraphEdge(id="E1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS",
                  confidence=0.9, properties={"sql": "select 1", "cols": ["a", "b"]}),
        GraphEdge(id="E2", sourceUrn="a", targetUrn="b", edgeType="REL"),          # neither conf nor props
        GraphEdge(id="E3", sourceUrn="x", targetUrn="y", edgeType="DERIVES",
                  confidence=0.0, properties={"m": {"nested": 1}}),                # 0.0 must NOT be dropped
    ]
    for e in cases:
        assert es.edge_to_payload(e) == _edge_payload(e), e.id
