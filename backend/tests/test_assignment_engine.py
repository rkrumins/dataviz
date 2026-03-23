"""
Phase 3 — Unit tests for backend.app.services.assignment_engine.AssignmentEngine

Tests target the pure-logic internal helpers (_build_parent_cache, _get_ancestors,
_build_rule_index) which do not depend on the module-level context_engine singleton.
"""
import pytest

from backend.app.services.assignment_engine import AssignmentEngine
from backend.common.models.assignment import (
    EntityAssignmentConfig,
    LayerAssignmentRuleConfig,
    ViewLayerConfig,
)
from backend.common.models.graph import GraphEdge


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _edge(src: str, tgt: str, etype: str = "CONTAINS") -> GraphEdge:
    return GraphEdge(id=f"{src}->{tgt}", sourceUrn=src, targetUrn=tgt, edgeType=etype)


# ---------------------------------------------------------------------------
# _build_parent_cache
# ---------------------------------------------------------------------------


class TestBuildParentCache:
    def setup_method(self):
        self.engine = AssignmentEngine()

    def test_contains_edges_map_target_to_source(self):
        """CONTAINS: source=parent, target=child -> child maps to parent."""
        edges = [_edge("urn:parent", "urn:child", "CONTAINS")]
        result = self.engine._build_parent_cache(edges, containment_edge_types={"CONTAINS"})
        assert result["parent_map"]["urn:child"] == "urn:parent"

    def test_belongs_to_edges_map_source_to_target(self):
        """BELONGS_TO: source=child, target=parent -> child maps to parent."""
        edges = [_edge("urn:child", "urn:parent", "BELONGS_TO")]
        result = self.engine._build_parent_cache(edges, containment_edge_types={"BELONGS_TO"})
        assert result["parent_map"]["urn:child"] == "urn:parent"

    def test_non_containment_edges_are_ignored(self):
        """Only edges with types in containment_edge_types are processed."""
        edges = [
            _edge("urn:a", "urn:b", "CONTAINS"),
            _edge("urn:c", "urn:d", "TRANSFORMS"),
        ]
        result = self.engine._build_parent_cache(edges, containment_edge_types={"CONTAINS"})
        assert "urn:b" in result["parent_map"]
        assert "urn:c" not in result["parent_map"]
        assert "urn:d" not in result["parent_map"]

    def test_mixed_containment_types(self):
        """Both CONTAINS and BELONGS_TO in one call."""
        edges = [
            _edge("urn:parent1", "urn:child1", "CONTAINS"),
            _edge("urn:child2", "urn:parent2", "BELONGS_TO"),
        ]
        result = self.engine._build_parent_cache(
            edges, containment_edge_types={"CONTAINS", "BELONGS_TO"},
        )
        assert result["parent_map"]["urn:child1"] == "urn:parent1"
        assert result["parent_map"]["urn:child2"] == "urn:parent2"

    def test_empty_containment_types_means_flat(self):
        """Empty set = ontology says no containment -> parent_map is empty."""
        edges = [_edge("urn:a", "urn:b", "CONTAINS")]
        result = self.engine._build_parent_cache(edges, containment_edge_types=set())
        assert result["parent_map"] == {}

    def test_none_containment_types_uses_fallback(self):
        """None = legacy path -> falls back to hardcoded {CONTAINS, BELONGS_TO}."""
        edges = [_edge("urn:parent", "urn:child", "CONTAINS")]
        result = self.engine._build_parent_cache(edges, containment_edge_types=None)
        assert result["parent_map"]["urn:child"] == "urn:parent"


# ---------------------------------------------------------------------------
# _get_ancestors
# ---------------------------------------------------------------------------


class TestGetAncestors:
    def setup_method(self):
        self.engine = AssignmentEngine()

    def test_linear_chain(self):
        """a -> b -> c produces ancestors [b, c] for a, [c] for b, [] for c."""
        cache = {"parent_map": {"urn:a": "urn:b", "urn:b": "urn:c"}}
        ancestors = self.engine._get_ancestors("urn:a", cache)
        assert ancestors == ["urn:b", "urn:c"]

    def test_no_parent_returns_empty(self):
        cache = {"parent_map": {}}
        ancestors = self.engine._get_ancestors("urn:orphan", cache)
        assert ancestors == []

    def test_cycle_protection(self):
        """Cycles do not cause infinite loop; partial chain is returned."""
        cache = {"parent_map": {"urn:a": "urn:b", "urn:b": "urn:a"}}
        ancestors = self.engine._get_ancestors("urn:a", cache)
        # Should get at least one ancestor before cycle stops
        assert "urn:b" in ancestors
        # Must terminate (cycle-safe)
        assert len(ancestors) <= 2


# ---------------------------------------------------------------------------
# _build_rule_index
# ---------------------------------------------------------------------------


class TestBuildRuleIndex:
    def setup_method(self):
        self.engine = AssignmentEngine()

    def test_type_rules_indexed(self):
        rule = LayerAssignmentRuleConfig(id="r1", priority=10, entityTypes=["dataset"])
        layer = ViewLayerConfig(id="L1", name="Layer 1", color="#fff", order=0, rules=[rule])
        index = self.engine._build_rule_index([layer])
        assert "dataset" in index["by_type"]
        assert index["by_type"]["dataset"][0][0] == "L1"

    def test_tag_rules_indexed(self):
        rule = LayerAssignmentRuleConfig(id="r2", priority=5, tags=["pii"])
        layer = ViewLayerConfig(id="L2", name="Layer 2", color="#000", order=1, rules=[rule])
        index = self.engine._build_rule_index([layer])
        assert "pii" in index["by_tag"]
        assert index["by_tag"]["pii"][0][0] == "L2"

    def test_pattern_rules_compiled(self):
        rule = LayerAssignmentRuleConfig(id="r3", priority=3, urnPattern="urn:li:dataset:*")
        layer = ViewLayerConfig(id="L3", name="Layer 3", color="#aaa", order=2, rules=[rule])
        index = self.engine._build_rule_index([layer])
        assert len(index["patterns"]) == 1
        _, _, regex = index["patterns"][0]
        assert regex.match("urn:li:dataset:foo")
        assert not regex.match("urn:li:chart:foo")

    def test_instance_assignments_indexed(self):
        assignment = EntityAssignmentConfig(
            entityId="urn:x",
            layerId="L4",
            priority=100,
            assignedBy="test",
            assignedAt="2026-01-01",
        )
        layer = ViewLayerConfig(
            id="L4", name="Layer 4", color="#bbb", order=3,
            entityAssignments=[assignment],
        )
        index = self.engine._build_rule_index([layer])
        assert "urn:x" in index["instances"]
        assert index["instances"]["urn:x"][0] == "L4"

    def test_entity_types_on_layer_create_synthetic_rules(self):
        layer = ViewLayerConfig(
            id="L5", name="Layer 5", color="#ccc", order=4,
            entityTypes=["chart"],
        )
        index = self.engine._build_rule_index([layer])
        assert "chart" in index["by_type"]

    def test_empty_layers_returns_empty_index(self):
        index = self.engine._build_rule_index([])
        assert index["by_type"] == {}
        assert index["by_tag"] == {}
        assert index["patterns"] == []
        assert index["instances"] == {}
