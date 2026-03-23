"""
Tests for backend.app.ontology.mutation_validator — validate_node_mutation,
validate_edge_mutation, would_create_containment_cycle.
"""
from backend.app.ontology.models import (
    ResolvedOntology,
    EntityTypeDefEntry,
    EntityHierarchyData,
    RelationshipTypeDefEntry,
)
from backend.app.ontology.mutation_validator import (
    MutationOp,
    validate_node_mutation,
    validate_edge_mutation,
    would_create_containment_cycle,
)


# ── Helper ──────────────────────────────────────────────────────────────────

def _make_ontology(entity_types=None, rel_types=None):
    """Build a minimal ResolvedOntology for testing."""
    etd = {}
    for et in (entity_types or []):
        if isinstance(et, str):
            etd[et] = EntityTypeDefEntry(name=et)
        else:
            etd[et[0]] = et[1]
    rtd = {}
    for rt in (rel_types or []):
        if isinstance(rt, str):
            rtd[rt] = RelationshipTypeDefEntry(name=rt)
        else:
            rtd[rt[0]] = rt[1]
    return ResolvedOntology(entity_type_definitions=etd, relationship_type_definitions=rtd)


# ── Node mutations ──────────────────────────────────────────────────────────

class TestValidateNodeMutationCreate:
    def test_known_type_ok(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(MutationOp.CREATE, "dataset", ont)
        assert r.ok is True
        assert r.errors == []

    def test_unknown_type_fails(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(MutationOp.CREATE, "goblin", ont)
        assert r.ok is False
        assert "goblin" in r.errors[0]

    def test_parent_containment_allowed(self):
        parent_def = EntityTypeDefEntry(
            name="domain",
            hierarchy=EntityHierarchyData(can_contain=["dataset"]),
        )
        ont = _make_ontology(entity_types=[("domain", parent_def), "dataset"])
        r = validate_node_mutation(
            MutationOp.CREATE, "dataset", ont, parent_entity_type="domain"
        )
        assert r.ok is True

    def test_parent_containment_violation(self):
        parent_def = EntityTypeDefEntry(
            name="domain",
            hierarchy=EntityHierarchyData(can_contain=["pipeline"]),
        )
        ont = _make_ontology(entity_types=[("domain", parent_def), "dataset"])
        r = validate_node_mutation(
            MutationOp.CREATE, "dataset", ont, parent_entity_type="domain"
        )
        assert r.ok is False
        assert "does not allow" in r.errors[0]

    def test_parent_type_unknown_fails(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(
            MutationOp.CREATE, "dataset", ont, parent_entity_type="nonexistent"
        )
        assert r.ok is False
        assert "nonexistent" in r.errors[0]


class TestValidateNodeMutationUpdate:
    def test_known_type_ok(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(MutationOp.UPDATE, "dataset", ont)
        assert r.ok is True

    def test_unknown_type_ok_with_warning(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(MutationOp.UPDATE, "legacy_type", ont)
        assert r.ok is True
        assert len(r.warnings) > 0
        assert "legacy_type" in r.warnings[0]

    def test_type_change_fails(self):
        ont = _make_ontology(entity_types=["dataset", "pipeline"])
        r = validate_node_mutation(
            MutationOp.UPDATE, "pipeline", ont, existing_entity_type="dataset"
        )
        assert r.ok is False
        assert "Changing entity type" in r.errors[0]


class TestValidateNodeMutationDelete:
    def test_known_type_ok(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(MutationOp.DELETE, "dataset", ont)
        assert r.ok is True

    def test_unknown_type_ok_with_warning(self):
        ont = _make_ontology(entity_types=["dataset"])
        r = validate_node_mutation(MutationOp.DELETE, "old_type", ont)
        assert r.ok is True
        assert len(r.warnings) > 0


# ── Edge mutations ──────────────────────────────────────────────────────────

class TestValidateEdgeMutationCreate:
    def test_known_type_ok(self):
        rel = RelationshipTypeDefEntry(name="FLOWS_TO")
        ont = _make_ontology(rel_types=[("FLOWS_TO", rel)])
        r = validate_edge_mutation(MutationOp.CREATE, "FLOWS_TO", "dataset", "pipeline", ont)
        assert r.ok is True

    def test_unknown_type_fails(self):
        ont = _make_ontology(rel_types=["CONTAINS"])
        r = validate_edge_mutation(MutationOp.CREATE, "UNKNOWN", "a", "b", ont)
        assert r.ok is False
        assert "UNKNOWN" in r.errors[0]

    def test_source_type_constraint_violation(self):
        rel = RelationshipTypeDefEntry(
            name="FLOWS_TO",
            source_types=["pipeline"],
            target_types=["dataset"],
        )
        ont = _make_ontology(rel_types=[("FLOWS_TO", rel)])
        r = validate_edge_mutation(MutationOp.CREATE, "FLOWS_TO", "dataset", "dataset", ont)
        assert r.ok is False
        assert "not a valid source" in r.errors[0]

    def test_target_type_constraint_violation(self):
        rel = RelationshipTypeDefEntry(
            name="FLOWS_TO",
            source_types=["pipeline"],
            target_types=["dataset"],
        )
        ont = _make_ontology(rel_types=[("FLOWS_TO", rel)])
        r = validate_edge_mutation(MutationOp.CREATE, "FLOWS_TO", "pipeline", "pipeline", ont)
        assert r.ok is False
        assert "not a valid target" in r.errors[0]


class TestValidateEdgeMutationUpdate:
    def test_unknown_type_ok_with_warning(self):
        ont = _make_ontology(rel_types=["CONTAINS"])
        r = validate_edge_mutation(MutationOp.UPDATE, "OLD_REL", "a", "b", ont)
        assert r.ok is True
        assert len(r.warnings) > 0
        assert "OLD_REL" in r.warnings[0]


class TestValidateEdgeMutationDelete:
    def test_delete_always_ok(self):
        ont = _make_ontology()
        r = validate_edge_mutation(MutationOp.DELETE, "ANYTHING", "a", "b", ont)
        assert r.ok is True
        assert r.errors == []


# ── Containment cycle guard ────────────────────────────────────────────────

class TestWouldCreateContainmentCycle:
    def test_no_cycle(self):
        # A -> B (existing), adding C -> D => no cycle
        containment = {"B": "A"}
        assert would_create_containment_cycle("C", "D", containment) is False

    def test_direct_cycle(self):
        # A -> B exists; adding B -> A would create A -> B -> A
        containment = {"B": "A"}
        assert would_create_containment_cycle("B", "A", containment) is True

    def test_transitive_cycle(self):
        # A -> B -> C exists; adding C -> A would create cycle
        containment = {"B": "A", "C": "B"}
        assert would_create_containment_cycle("C", "A", containment) is True

    def test_existing_cycle_in_map_terminates(self):
        # Existing map has a cycle: X -> Y -> X
        # Adding Z -> W should not loop forever and should return False
        containment = {"Y": "X", "X": "Y"}
        assert would_create_containment_cycle("Z", "W", containment) is False
