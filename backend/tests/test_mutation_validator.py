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

    def test_can_contain_membership_is_case_insensitive(self):
        # entity_type and parent_entity_type both match known_types exactly (no
        # entity-type-id normalization involved) — only the can_contain entry is
        # cased differently ("DATASET" vs the child's known id "dataset").
        parent_def = EntityTypeDefEntry(
            name="domain",
            hierarchy=EntityHierarchyData(can_contain=["DATASET"]),
        )
        ont = _make_ontology(entity_types=[("domain", parent_def), "dataset"])
        r = validate_node_mutation(
            MutationOp.CREATE, "dataset", ont, parent_entity_type="domain"
        )
        assert r.ok is True

    def test_can_contain_membership_violation_is_still_case_insensitive(self):
        parent_def = EntityTypeDefEntry(
            name="domain",
            hierarchy=EntityHierarchyData(can_contain=["PIPELINE"]),
        )
        ont = _make_ontology(entity_types=[("domain", parent_def), "dataset"])
        r = validate_node_mutation(
            MutationOp.CREATE, "dataset", ont, parent_entity_type="domain"
        )
        assert r.ok is False
        assert "does not allow" in r.errors[0]

    def test_parent_entity_type_lookup_is_case_insensitive(self):
        # parent_entity_type is passed in a different case than the ontology's
        # canonical definition key ("domain" vs "Domain") — a discovered graph's
        # parent node type. can_contain matches the child's known id exactly, so
        # only the parent-lookup fix is exercised.
        parent_def = EntityTypeDefEntry(
            name="Domain",
            hierarchy=EntityHierarchyData(can_contain=["dataset"]),
        )
        ont = _make_ontology(entity_types=[("Domain", parent_def), "dataset"])
        r = validate_node_mutation(
            MutationOp.CREATE, "dataset", ont, parent_entity_type="domain"
        )
        assert r.ok is True


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

    def test_type_change_with_no_parent_or_children_is_accepted(self):
        # No hierarchy context supplied -> nothing to validate the new type
        # against, so the change is accepted (type changes are no longer
        # forbidden outright).
        ont = _make_ontology(entity_types=["dataset", "pipeline"])
        r = validate_node_mutation(
            MutationOp.UPDATE, "pipeline", ont, existing_entity_type="dataset"
        )
        assert r.ok is True

    def test_type_change_to_valid_child_and_container_is_accepted(self):
        # New type "container" can be contained by "dataPlatform" and can
        # contain "column" -> changing dataset -> container under that
        # parent, with an existing "column" child, is accepted.
        container_def = EntityTypeDefEntry(
            name="container",
            hierarchy=EntityHierarchyData(
                can_be_contained_by=["dataPlatform"],
                can_contain=["column"],
            ),
        )
        ont = _make_ontology(
            entity_types=[("container", container_def), "dataset", "column", "dataPlatform"]
        )
        r = validate_node_mutation(
            MutationOp.UPDATE, "container", ont,
            existing_entity_type="dataset",
            parent_entity_type="dataPlatform",
            child_entity_types=["column"],
        )
        assert r.ok is True

    def test_type_change_rejected_when_new_type_invalid_under_parent(self):
        # New type "column" cannot be contained by "dataPlatform".
        column_def = EntityTypeDefEntry(
            name="column",
            hierarchy=EntityHierarchyData(
                can_be_contained_by=["dataset"],
                can_contain=["tag"],
            ),
        )
        ont = _make_ontology(
            entity_types=[("column", column_def), "container", "dataset", "dataPlatform", "tag"]
        )
        r = validate_node_mutation(
            MutationOp.UPDATE, "column", ont,
            existing_entity_type="container",
            parent_entity_type="dataPlatform",
            child_entity_types=[],
        )
        assert r.ok is False
        assert "can't" in r.errors[0].lower() or "cannot" in r.errors[0].lower()

    def test_type_change_rejected_when_new_type_cannot_contain_existing_child(self):
        # New type "column" cannot contain "dataset".
        column_def = EntityTypeDefEntry(
            name="column",
            hierarchy=EntityHierarchyData(
                can_be_contained_by=["dataset"],
                can_contain=["tag"],
            ),
        )
        ont = _make_ontology(
            entity_types=[("column", column_def), "container", "dataset", "tag"]
        )
        r = validate_node_mutation(
            MutationOp.UPDATE, "column", ont,
            existing_entity_type="container",
            parent_entity_type="dataset",
            child_entity_types=["dataset"],
        )
        assert r.ok is False

    def test_type_change_is_case_insensitive(self):
        container_def = EntityTypeDefEntry(
            name="container",
            hierarchy=EntityHierarchyData(
                can_be_contained_by=["dataPlatform"],
                can_contain=["column"],
            ),
        )
        ont = _make_ontology(
            entity_types=[("container", container_def), "dataset", "column", "dataPlatform"]
        )
        r = validate_node_mutation(
            MutationOp.UPDATE, "CONTAINER", ont,
            existing_entity_type="DATASET",
            parent_entity_type="DATAPLATFORM",
            child_entity_types=["COLUMN"],
        )
        assert r.ok is True

    def test_no_ontology_fails_open_on_type_change(self):
        ont = _make_ontology()  # no entity type definitions -> fail open
        r = validate_node_mutation(
            MutationOp.UPDATE, "x", ont,
            existing_entity_type="y",
            parent_entity_type=None,
            child_entity_types=[],
        )
        assert r.ok is True


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

    def test_source_and_target_membership_is_case_insensitive(self):
        # A discovered graph's lowercase edge type ('flows_to') and entity types
        # ('dataJob'/'dataset') must validate identically to the ontology-cased
        # relationship definition ('FLOWS_TO', ['DataJob'], ['Dataset']).
        rel = RelationshipTypeDefEntry(
            name="FLOWS_TO",
            source_types=["DataJob"],
            target_types=["Dataset"],
        )
        ont = _make_ontology(rel_types=[("FLOWS_TO", rel)])
        r = validate_edge_mutation(MutationOp.CREATE, "flows_to", "dataJob", "dataset", ont)
        assert r.ok is True

    def test_source_membership_violation_is_still_case_insensitive(self):
        rel = RelationshipTypeDefEntry(
            name="FLOWS_TO",
            source_types=["Pipeline"],
            target_types=["Dataset"],
        )
        ont = _make_ontology(rel_types=[("FLOWS_TO", rel)])
        r = validate_edge_mutation(MutationOp.CREATE, "flows_to", "dataset", "dataset", ont)
        assert r.ok is False
        assert "not a valid source" in r.errors[0]


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
