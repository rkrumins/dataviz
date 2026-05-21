"""Unit tests for authored-graph mutation validation. Pure, no DB."""
import pytest

from backend.app.services.graph_versioning.validation import (
    EdgeSpec,
    GraphValidationError,
    NodeSpec,
    OntologySpec,
    validate_graph_state,
)


def _ok_state():
    return dict(
        nodes=[NodeSpec("urn:a", "Table"), NodeSpec("urn:b", "Table")],
        edges=[EdgeSpec("e1", "urn:a", "urn:b", "flows_to")],
    )


def test_schemaless_valid_passes():
    validate_graph_state(schema_mode="schemaless", **_ok_state())


def test_schemaless_allows_freeform_types():
    # No ontology, arbitrary/None types are fine structurally.
    validate_graph_state(
        schema_mode="schemaless",
        nodes=[NodeSpec("urn:a", None), NodeSpec("urn:b", "Whatever")],
        edges=[EdgeSpec("e1", "urn:a", "urn:b", None)],
    )


def test_dangling_edge_is_rejected():
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="schemaless",
            nodes=[NodeSpec("urn:a", "T")],
            edges=[EdgeSpec("e1", "urn:a", "urn:missing", "rel")],
        )
    codes = {v.code for v in ei.value.violations}
    assert "edge_dangling_target" in codes


def test_duplicate_node_key_rejected():
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="schemaless",
            nodes=[NodeSpec("urn:a", "T"), NodeSpec("urn:a", "T")],
            edges=[],
        )
    assert any(v.code == "node_key_duplicate" for v in ei.value.violations)


def test_all_violations_reported_at_once():
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="schemaless",
            nodes=[NodeSpec("", None), NodeSpec("urn:a", "T")],
            edges=[
                EdgeSpec("e1", "urn:a", "ghost1", "r"),
                EdgeSpec("e2", "ghost2", "urn:a", "r"),
            ],
        )
    codes = sorted(v.code for v in ei.value.violations)
    assert "node_key_empty" in codes
    assert codes.count("edge_dangling_source") == 1
    assert codes.count("edge_dangling_target") == 1
    assert len(ei.value.violations) >= 3


def test_strict_requires_ontology():
    with pytest.raises(ValueError, match="requires an OntologySpec"):
        validate_graph_state(schema_mode="strict", **_ok_state())


def test_strict_enforces_types():
    onto = OntologySpec(
        entity_types=frozenset({"Table"}),
        relationship_types=frozenset({"flows_to"}),
    )
    # Valid against ontology.
    validate_graph_state(schema_mode="strict", ontology=onto, **_ok_state())

    # Unknown entity + relationship type.
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="strict",
            ontology=onto,
            nodes=[NodeSpec("urn:a", "Ghost"), NodeSpec("urn:b", "Table")],
            edges=[EdgeSpec("e1", "urn:a", "urn:b", "teleports_to")],
        )
    codes = {v.code for v in ei.value.violations}
    assert "node_type_unknown" in codes
    assert "edge_type_unknown" in codes


def test_unknown_schema_mode_rejected():
    with pytest.raises(ValueError, match="unknown schema_mode"):
        validate_graph_state(schema_mode="loose", **_ok_state())


def test_duplicate_edge_key_rejected():
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="schemaless",
            nodes=[NodeSpec("urn:a", "T"), NodeSpec("urn:b", "T")],
            edges=[
                EdgeSpec("e1", "urn:a", "urn:b", "r"),
                EdgeSpec("e1", "urn:b", "urn:a", "r"),
            ],
        )
    assert any(v.code == "edge_key_duplicate" for v in ei.value.violations)


# ── containment DAG enforcement ────────────────────────────────────

def _lineage_onto() -> OntologySpec:
    """Mirrors the Basic Lineage seed: CONTAINS is the only containment
    edge, lineage edges may cycle."""
    return OntologySpec(
        entity_types=frozenset({"Dataset", "Pipeline"}),
        relationship_types=frozenset({"CONTAINS", "FLOWS_TO"}),
        containment_edge_types=frozenset({"CONTAINS"}),
        lineage_edge_types=frozenset({"FLOWS_TO"}),
    )


def test_containment_tree_passes():
    onto = _lineage_onto()
    validate_graph_state(
        schema_mode="strict",
        ontology=onto,
        nodes=[NodeSpec(k, "Dataset") for k in ("root", "a", "b", "c")],
        edges=[
            EdgeSpec("e1", "root", "a", "CONTAINS"),
            EdgeSpec("e2", "root", "b", "CONTAINS"),
            EdgeSpec("e3", "a", "c", "CONTAINS"),
        ],
    )


def test_containment_cycle_rejected():
    onto = _lineage_onto()
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="strict",
            ontology=onto,
            nodes=[NodeSpec(k, "Dataset") for k in ("a", "b", "c")],
            edges=[
                EdgeSpec("e1", "a", "b", "CONTAINS"),
                EdgeSpec("e2", "b", "c", "CONTAINS"),
                EdgeSpec("e3", "c", "a", "CONTAINS"),  # closes the cycle
            ],
        )
    cycles = [v for v in ei.value.violations if v.code == "containment_cycle"]
    assert len(cycles) == 1
    assert "->" in cycles[0].message


def test_lineage_cycles_permitted():
    # Data flowing back to an upstream system is legal — only containment
    # is acyclic.
    onto = _lineage_onto()
    validate_graph_state(
        schema_mode="strict",
        ontology=onto,
        nodes=[NodeSpec(k, "Dataset") for k in ("a", "b", "c")],
        edges=[
            EdgeSpec("e1", "a", "b", "FLOWS_TO"),
            EdgeSpec("e2", "b", "c", "FLOWS_TO"),
            EdgeSpec("e3", "c", "a", "FLOWS_TO"),
        ],
    )


def test_self_loop_containment_rejected():
    onto = _lineage_onto()
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="strict",
            ontology=onto,
            nodes=[NodeSpec("a", "Dataset")],
            edges=[EdgeSpec("e1", "a", "a", "CONTAINS")],
        )
    assert any(v.code == "containment_cycle" for v in ei.value.violations)


def test_no_dag_check_when_classification_empty():
    # An ontology that pre-dates the containment_edge_types extension
    # falls back to membership-only — no cycle enforcement.
    onto = OntologySpec(
        entity_types=frozenset({"T"}),
        relationship_types=frozenset({"r"}),
    )
    validate_graph_state(
        schema_mode="strict",
        ontology=onto,
        nodes=[NodeSpec(k, "T") for k in ("a", "b")],
        edges=[
            EdgeSpec("e1", "a", "b", "r"),
            EdgeSpec("e2", "b", "a", "r"),
        ],
    )


def test_containment_cycle_in_deep_chain_detected():
    onto = _lineage_onto()
    # Deep linear containment chain that loops back at the end.
    chain = [f"n{i}" for i in range(50)]
    nodes = [NodeSpec(k, "Dataset") for k in chain]
    edges = [
        EdgeSpec(f"e{i}", chain[i], chain[i + 1], "CONTAINS")
        for i in range(len(chain) - 1)
    ]
    edges.append(EdgeSpec("e_loop", chain[-1], chain[0], "CONTAINS"))
    with pytest.raises(GraphValidationError) as ei:
        validate_graph_state(
            schema_mode="strict", ontology=onto, nodes=nodes, edges=edges,
        )
    assert any(v.code == "containment_cycle" for v in ei.value.violations)
