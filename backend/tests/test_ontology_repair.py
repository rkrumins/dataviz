"""Unit tests for backend.app.ontology.repair.canonicalize_case_variants — the data-at-rest
counterpart of the frontend save-time fold. Pure, no I/O."""
from backend.app.ontology.repair import canonicalize_case_variants


def test_merges_duplicate_rel_keys_and_remaps_lists():
    rel_defs = {
        "TO": {"name": "To", "is_containment": False, "is_lineage": False, "description": "edge"},
        "To": {"name": "To", "is_containment": False, "is_lineage": True},
    }
    out = canonicalize_case_variants({}, rel_defs, containment_edge_types=[], lineage_edge_types=["TO"])
    # 'TO' is referenced by the lineage list, so it wins the tie; classification is unioned.
    assert list(out.relationship_type_definitions.keys()) == ["TO"]
    surviving = out.relationship_type_definitions["TO"]
    assert surviving["is_lineage"] is True
    assert "also seen as: To" in surviving["description"]
    assert out.lineage_edge_types == ["TO"]
    assert out.merged_relationships == {"TO": ["To"]}
    assert out.changed is True


def test_no_op_when_no_duplicates():
    rel_defs = {"HAS": {"name": "Has", "is_containment": True}, "FLOWS": {"name": "Flows", "is_lineage": True}}
    out = canonicalize_case_variants({}, rel_defs, ["HAS"], ["FLOWS"])
    assert set(out.relationship_type_definitions.keys()) == {"HAS", "FLOWS"}
    assert out.changed is False


def test_folds_entity_keys_and_rewrites_hierarchy_refs():
    entity_defs = {
        "Node": {"name": "Node", "hierarchy": {"can_contain": ["node"], "can_be_contained_by": ["Roots"]}},
        "node": {"name": "node", "hierarchy": {"can_contain": [], "can_be_contained_by": []}},
        "Roots": {"name": "Roots", "hierarchy": {"can_contain": ["Node"]}},
    }
    out = canonicalize_case_variants(entity_defs, {})
    assert set(out.entity_type_definitions.keys()) == {"Node", "Roots"}
    # The self-nesting reference "node" is rewritten to the canonical "Node".
    assert out.entity_type_definitions["Node"]["hierarchy"]["can_contain"] == ["Node"]
    assert out.merged_entities == {"Node": ["node"]}


def test_merged_result_passes_the_case_insensitive_collision_guard():
    """After repair the document must satisfy the same guard the write path enforces."""
    from backend.app.ontology.resolver import case_insensitive_type_id_collisions

    rel_defs = {"Has": {"name": "Has"}, "HAS": {"name": "Has", "is_containment": True}}
    out = canonicalize_case_variants({"Roots": {"name": "Roots"}}, rel_defs, ["HAS"], [])
    collisions = case_insensitive_type_id_collisions(
        list(out.entity_type_definitions.keys()),
        list(out.relationship_type_definitions.keys()),
    )
    assert collisions == []
