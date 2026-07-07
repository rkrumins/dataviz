"""
Phase 3 — Unit tests for backend.app.services.assignment_engine.AssignmentEngine

Tests target the pure-logic internal helpers (_build_parent_cache, _get_ancestors,
_build_rule_index) which do not depend on the module-level context_engine singleton.
"""
import pytest

from backend.app.services.assignment_engine import AssignmentEngine
from backend.common.models.assignment import (
    EntityAssignment,
    EntityAssignmentConfig,
    LayerAssignmentRuleConfig,
    ViewLayerConfig,
)
from backend.common.models.graph import GraphEdge, GraphNode


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

    def test_valid_layer_ids_collected(self):
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0),
            ViewLayerConfig(id="transform", name="Transform", color="#222", order=1),
        ]
        index = self.engine._build_rule_index(layers)
        assert index["valid_layer_ids"] == {"source", "transform"}


# ---------------------------------------------------------------------------
# _resolve_assignment — persisted node layerAssignment must survive reload
# ---------------------------------------------------------------------------


class TestResolveAssignmentNodeLayer:
    """A node created directly into a layer persists its target in the node's
    `layerAssignment` property. On reload it has no view-config entity_assignment
    yet and matches no rule, so before the fix it fell through to the layers[0]
    (Source) default. These tests pin the node-property tier and its precedence.
    """

    def setup_method(self):
        self.engine = AssignmentEngine()
        # Two plain layers, NO rules / entityTypes, so nothing but the node
        # property (or the layers[0] default) can place a Layer-typed node.
        self.layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0),
            ViewLayerConfig(id="transform", name="Transform", color="#222", order=1),
        ]
        self.index = self.engine._build_rule_index(self.layers)
        self.lsm = {l.id: i for i, l in enumerate(self.layers)}

    def _resolve(self, node, parent_id=None, parent_assignment=None):
        return self.engine._resolve_assignment(
            node, parent_id, parent_assignment, self.index, self.layers, self.lsm
        )

    def _node(self, urn, etype="Layer", layer_assignment=None, properties=None):
        return GraphNode(
            urn=urn, entityType=etype, displayName=urn,
            layerAssignment=layer_assignment, properties=properties or {},
        )

    def test_root_created_in_transform_lands_in_transform(self):
        """Regression: was assigned to 'source' (layers[0] default)."""
        node = self._node("urn:new-layer-test", "Layer", layer_assignment="transform")
        result = self._resolve(node)
        assert result is not None
        assert result.layer_id == "transform"

    def test_layer_assignment_from_properties_bag(self):
        """The frontend also mirrors the choice into properties.layerAssignment."""
        node = self._node("urn:x", "Layer", properties={"layerAssignment": "transform"})
        result = self._resolve(node)
        assert result.layer_id == "transform"

    def test_without_node_layer_falls_back_to_default(self):
        """No property, no rule -> layers[0] default (unchanged behaviour)."""
        node = self._node("urn:plain", "Layer")
        result = self._resolve(node)
        assert result.layer_id == "source"

    def test_stale_layer_id_ignored_falls_back_to_default(self):
        """A property naming a layer that no longer exists must not win."""
        node = self._node("urn:y", "Layer", layer_assignment="deleted-layer")
        result = self._resolve(node)
        assert result.layer_id == "source"

    def test_view_config_assignment_outranks_node_property(self):
        """An explicit view-config move (instance) beats a stale node stamp."""
        assignment = EntityAssignmentConfig(
            entityId="urn:x", layerId="source", priority=100,
            assignedBy="test", assignedAt="2026-01-01",
        )
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0,
                            entityAssignments=[assignment]),
            ViewLayerConfig(id="transform", name="Transform", color="#222", order=1),
        ]
        index = self.engine._build_rule_index(layers)
        node = self._node("urn:x", "Layer", layer_assignment="transform")
        result = self.engine._resolve_assignment(node, None, None, index, layers, self.lsm)
        assert result.layer_id == "source"

    def test_containment_inheritance_outranks_node_property(self):
        """HARD RULE: a child follows its parent's layer even if its own
        stamped property says otherwise."""
        parent_assignment = EntityAssignment(
            entityId="urn:parent", layerId="source", isInherited=False, confidence=1.0,
        )
        child = self._node("urn:child", "Object", layer_assignment="transform")
        result = self._resolve(child, parent_id="urn:parent", parent_assignment=parent_assignment)
        assert result.layer_id == "source"
        assert result.is_inherited is True

    def test_explicit_node_assignment_outranks_generic_type_rule(self):
        """Regression (a saved move "disappears" on reload): an explicit
        per-entity assignment — the node's own `layerAssignment`, which a move
        rewrites — MUST beat a GENERIC entity-type rule. Otherwise moving a
        `Layer`-typed entity to "warehouse" snaps back to its type-rule layer."""
        type_rule = LayerAssignmentRuleConfig(
            id="type-layer-source", priority=10, entityTypes=["Layer"],
        )
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0,
                            rules=[type_rule]),
            ViewLayerConfig(id="warehouse", name="Warehouse", color="#333", order=1),
        ]
        index = self.engine._build_rule_index(layers)
        node = self._node("urn:x", "Layer", layer_assignment="warehouse")
        result = self.engine._resolve_assignment(node, None, None, index, layers, self.lsm)
        assert result.layer_id == "warehouse"


# ---------------------------------------------------------------------------
# _build_rule_index / _resolve_assignment — canonical view-config assignments
# map (request.assignments), inheritsChildren=False, and entityScope='curated'
# ---------------------------------------------------------------------------


class TestRequestAssignmentsAndEntityScope:
    def setup_method(self):
        self.engine = AssignmentEngine()

    def test_explicit_map_beats_rules(self):
        """A request-level `assignments` entry outranks generic rule matching."""
        type_rule = LayerAssignmentRuleConfig(id="r1", priority=10, entityTypes=["Table"])
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0, rules=[type_rule]),
            ViewLayerConfig(id="curated", name="Curated", color="#222", order=1),
        ]
        request_assignments = {
            "urn:x": EntityAssignmentConfig(
                entityId="urn:x", layerId="curated", priority=100,
                assignedBy="user", assignedAt="2026-01-01",
            ),
        }
        index = self.engine._build_rule_index(layers, request_assignments)
        lsm = {l.id: i for i, l in enumerate(layers)}
        node = GraphNode(urn="urn:x", entityType="Table", displayName="urn:x")
        result = self.engine._resolve_assignment(node, None, None, index, layers, lsm)
        assert result.layer_id == "curated"
        assert result.is_inherited is False

    def test_legacy_entity_assignments_still_honored_union(self):
        """Legacy per-layer entity_assignments remain indexed even when a
        request-level assignments map is also present (union, not replace)."""
        legacy = EntityAssignmentConfig(
            entityId="urn:legacy", layerId="source", priority=100,
            assignedBy="test", assignedAt="2026-01-01",
        )
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0,
                            entityAssignments=[legacy]),
            ViewLayerConfig(id="curated", name="Curated", color="#222", order=1),
        ]
        request_assignments = {
            "urn:x": EntityAssignmentConfig(
                entityId="urn:x", layerId="curated", priority=100,
                assignedBy="user", assignedAt="2026-01-01",
            ),
        }
        index = self.engine._build_rule_index(layers, request_assignments)
        assert index["instances"]["urn:legacy"][0] == "source"
        assert index["instances"]["urn:x"][0] == "curated"

    def test_request_map_wins_on_collision_with_legacy(self):
        legacy = EntityAssignmentConfig(
            entityId="urn:x", layerId="source", priority=100,
            assignedBy="legacy", assignedAt="2026-01-01",
        )
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0,
                            entityAssignments=[legacy]),
            ViewLayerConfig(id="curated", name="Curated", color="#222", order=1),
        ]
        request_assignments = {
            "urn:x": EntityAssignmentConfig(
                entityId="urn:x", layerId="curated", priority=100,
                assignedBy="user", assignedAt="2026-01-01",
            ),
        }
        index = self.engine._build_rule_index(layers, request_assignments)
        assert index["instances"]["urn:x"][0] == "curated"

    def test_inherits_children_false_falls_through(self):
        """A parent's explicit assignment with inheritsChildren=False does NOT
        cascade to its children — they fall through to tiers 3-5 (here, the
        layers[0] default) instead of inheriting the parent's layer."""
        layers = [
            ViewLayerConfig(id="other", name="Other", color="#222", order=0),
            ViewLayerConfig(id="source", name="Source", color="#111", order=1),
        ]
        request_assignments = {
            "urn:parent": EntityAssignmentConfig(
                entityId="urn:parent", layerId="source", inheritsChildren=False,
                priority=100, assignedBy="user", assignedAt="2026-01-01",
            ),
        }
        index = self.engine._build_rule_index(layers, request_assignments)
        lsm = {l.id: i for i, l in enumerate(layers)}
        parent_assignment = EntityAssignment(
            entityId="urn:parent", layerId="source", isInherited=False, confidence=1.0,
        )
        child = GraphNode(urn="urn:child", entityType="Object", displayName="urn:child")
        result = self.engine._resolve_assignment(
            child, "urn:parent", parent_assignment, index, layers, lsm,
        )
        assert result.layer_id == "other"  # layers[0] default, NOT inherited "source"
        assert result.is_inherited is False

    def test_node_hint_ignored_in_curated_scope(self):
        """The node's own persisted layerAssignment hint is only honoured in
        open scope; curated scope skips this tier entirely."""
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0),
            ViewLayerConfig(id="transform", name="Transform", color="#222", order=1),
        ]
        index = self.engine._build_rule_index(layers)
        lsm = {l.id: i for i, l in enumerate(layers)}
        node = GraphNode(
            urn="urn:x", entityType="Layer", displayName="urn:x",
            layerAssignment="transform",
        )
        result = self.engine._resolve_assignment(
            node, None, None, index, layers, lsm, entity_scope="curated",
        )
        assert result is None

    def test_curated_unassigned_dropped(self):
        """Curated scope = explicit assignment + containment inheritance only.
        An entity that fails tiers 1-2 gets no assignment, even when a generic
        rule would otherwise have matched it."""
        type_rule = LayerAssignmentRuleConfig(id="r1", priority=10, entityTypes=["Table"])
        layers = [
            ViewLayerConfig(id="source", name="Source", color="#111", order=0, rules=[type_rule]),
        ]
        index = self.engine._build_rule_index(layers)
        lsm = {l.id: i for i, l in enumerate(layers)}
        node = GraphNode(urn="urn:unassigned", entityType="Table", displayName="urn:unassigned")
        result = self.engine._resolve_assignment(
            node, None, None, index, layers, lsm, entity_scope="curated",
        )
        assert result is None

    @pytest.mark.parametrize("scope", [None, "all"])
    def test_open_scope_default_layer(self, scope):
        """Existing default behaviour (layers[0] fallback) is unchanged for
        open scope ('all' or the None/absent default)."""
        layers = [ViewLayerConfig(id="source", name="Source", color="#111", order=0)]
        index = self.engine._build_rule_index(layers)
        lsm = {l.id: i for i, l in enumerate(layers)}
        node = GraphNode(urn="urn:plain", entityType="Table", displayName="urn:plain")
        result = self.engine._resolve_assignment(
            node, None, None, index, layers, lsm, entity_scope=scope,
        )
        assert result.layer_id == "source"
        assert result.confidence == 0.5
