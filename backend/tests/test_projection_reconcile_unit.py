"""In-place reconcile of a versioned graph's FalkorDB projection — the pure core.

A heal or an explicit rebuild used to DROP the graph and replay Postgres into
an empty key. That renumbered every label / relationship type / property key
(every long-lived client then decoded nodes with the wrong names — Domain
rendered as Schema Field), wiped the indexes, and wiped every ``:AGGREGATED``
rollup until a full aggregation job ran.

The reconcile instead diffs what FalkorDB holds against what Postgres says it
should hold and writes ONLY the difference, and adjusts the rollups by the
same delta rules a publish uses:

* a lineage edge FalkorDB has but Postgres does not → -1 over its ancestor
  pairs as FalkorDB's CURRENT containment places them (that is what the stored
  rollups were built from);
* a lineage edge Postgres has but FalkorDB does not → +1 as Postgres's
  containment places it;
* a lineage edge both have, under an entity whose containment differs between
  the two → -1 the old placement, +1 the new one.

These tests pin that arithmetic against the batch pipeline's own pair rules.
"""
from backend.app.services.versioning.projection_reconcile import (
    ActualEdge,
    ActualNode,
    ExpectedEdge,
    ExpectedNode,
    diff_projection,
    plan_rollup_deltas,
)

CONT = {"CONTAINS"}
LIN = {"TRANSFORMS", "DEPENDS_ON"}


def _en(fp="x"):
    return ExpectedNode(entity_id="e", ref=None, fp=fp)


def _ee(fp="x"):
    return ExpectedEdge(entity_id="e", ref=None, fp=fp)


def _an(fp="x"):
    return ActualNode(fp)


# ── raw diff (nodes are (label, urn); edges are label-anchored at both ends) ──


def test_identical_projection_writes_nothing():
    nodes = {("domain", "a"): _en(), ("dataset", "b"): _en()}
    edges = {("domain", "a", "CONTAINS", "dataset", "b"): _ee()}
    d = diff_projection(
        nodes, edges,
        {("domain", "a"): _an(), ("dataset", "b"): _an()},
        {("domain", "a", "CONTAINS", "dataset", "b"): ActualEdge("x")},
    )
    assert d.empty


def test_missing_extra_and_changed_are_the_only_writes():
    expected_nodes = {("domain", "a"): _en(), ("dataset", "b"): _en("new"), ("dataset", "c"): _en()}
    expected_edges = {("domain", "a", "CONTAINS", "dataset", "c"): _ee()}
    actual_nodes = {("domain", "a"): _an(), ("dataset", "b"): _an("old"), ("dataset", "z"): _an()}
    actual_edges = {("domain", "a", "CONTAINS", "dataset", "z"): ActualEdge("x")}
    d = diff_projection(expected_nodes, expected_edges, actual_nodes, actual_edges)
    assert sorted(d.node_upserts) == [("dataset", "b"), ("dataset", "c")]   # "a" untouched
    assert d.node_deletes == [("dataset", "z")]
    assert d.edge_upserts == [("domain", "a", "CONTAINS", "dataset", "c")]
    # The extra edge dies with its endpoint's DETACH DELETE — no separate write.
    assert d.edge_deletes == []


def test_a_retyped_node_is_relabelled_in_place_and_keeps_its_edges():
    # Deleting and recreating it took every edge and rollup cell on it with it.
    d = diff_projection(
        {("schemaField", "a"): _en("new"), ("dataset", "b"): _en()},
        {("schemaField", "a", "TRANSFORMS", "dataset", "b"): _ee()},
        {("domain", "a"): _an(), ("dataset", "b"): _an()},
        {("domain", "a", "TRANSFORMS", "dataset", "b"): ActualEdge("x")},
    )
    assert d.relabels == [("a", "domain", "schemaField")]
    assert d.node_upserts == [("schemaField", "a")]
    assert d.node_deletes == [] and d.edge_upserts == [] and d.edge_deletes == []


def test_two_live_entities_sharing_a_urn_are_two_nodes():
    # Different types → different (label, urn) keys, as every projector write has made them.
    both = {("chart", "u"): _en(), ("dataset", "u"): _en()}
    d = diff_projection(both, {}, {("chart", "u"): _an()}, {})
    assert d.node_upserts == [("dataset", "u")] and not d.relabels and not d.node_deletes


def test_an_unstamped_projection_is_rewritten_once_in_place():
    # Graphs projected before fingerprints existed carry none: every item is
    # rewritten on the first reconcile (in place, no drop), then never again.
    d = diff_projection({("domain", "a"): _en()}, {}, {("domain", "a"): _an(None)}, {})
    assert d.node_upserts == [("domain", "a")] and not d.node_deletes


def test_an_extra_edge_between_surviving_nodes_is_deleted():
    d = diff_projection(
        {("domain", "a"): _en(), ("domain", "b"): _en()}, {},
        {("domain", "a"): _an(), ("domain", "b"): _an()},
        {("domain", "a", "DEPENDS_ON", "domain", "b"): ActualEdge("x")},
    )
    assert d.edge_deletes == [("domain", "a", "DEPENDS_ON", "domain", "b")]


# ── rollup deltas ─────────────────────────────────────────────────────────
#
#   D1 ─CONTAINS→ t1 ─TRANSFORMS→ t2 ←CONTAINS─ D2


def _tree():
    return {
        ("D1", "CONTAINS", "t1"),
        ("D2", "CONTAINS", "t2"),
    }


def _plan(expected, actual, cap=1000):
    return plan_rollup_deltas(
        expected, actual, lineage_types=LIN, cont_types=CONT,
        canonical=True, cap=cap, level_of=lambda _u: None,
    )


def test_no_lineage_difference_means_no_rollup_writes():
    keys = _tree() | {("t1", "TRANSFORMS", "t2")}
    plan = _plan(keys, set(keys))
    assert plan.pairs == {} and not plan.stale


def test_a_missing_lineage_edge_adds_its_ancestor_pairs():
    plan = _plan(_tree() | {("t1", "TRANSFORMS", "t2")}, _tree())
    assert plan.pairs[("D1", "D2")]["dw"] == 1
    assert plan.pairs[("D1", "D2")]["types"] == {"TRANSFORMS"}
    # The same cells a publish of that edge would have written.
    assert ("t1", "t2") not in plan.pairs            # the raw edge itself is not a rollup


def test_an_extra_lineage_edge_is_subtracted_where_falkordb_placed_it():
    # FalkorDB holds t1 under OLD, Postgres under D1, and the edge is gone in
    # Postgres: the -1 must land on OLD (what the stored rollup counted), not D1.
    actual = {("OLD", "CONTAINS", "t1"), ("D2", "CONTAINS", "t2"), ("t1", "TRANSFORMS", "t2")}
    plan = _plan(_tree(), actual)
    assert plan.pairs[("OLD", "D2")]["dw"] == -1
    assert ("D1", "D2") not in plan.pairs


def test_a_moved_container_recounts_the_lineage_under_it():
    # Same lineage edge on both sides, but t1 moved from OLD to D1.
    edge = ("t1", "TRANSFORMS", "t2")
    actual = {("OLD", "CONTAINS", "t1"), ("D2", "CONTAINS", "t2"), edge}
    expected = _tree() | {edge}
    plan = _plan(expected, actual)
    assert plan.pairs[("OLD", "D2")]["dw"] == -1
    assert plan.pairs[("D1", "D2")]["dw"] == 1


def test_a_move_high_in_the_tree_reaches_lineage_deep_below_it():
    # R ⊃ D1 ⊃ t1 on both sides, but D1 moved under R2 — t1's closure changed
    # although t1's own parent did not.
    edge = ("t1", "TRANSFORMS", "t2")
    actual = {("R", "CONTAINS", "D1"), ("D1", "CONTAINS", "t1"), ("D2", "CONTAINS", "t2"), edge}
    expected = {("R2", "CONTAINS", "D1"), ("D1", "CONTAINS", "t1"), ("D2", "CONTAINS", "t2"), edge}
    plan = _plan(expected, actual)
    assert plan.pairs[("R", "D2")]["dw"] == -1
    assert plan.pairs[("R2", "D2")]["dw"] == 1
    # D1 → D2 is counted on both sides: it nets to zero and is not written.
    assert ("D1", "D2") not in plan.pairs


def test_a_change_too_large_to_do_inline_is_handed_to_the_batch_job():
    many = {(f"s{i}", "TRANSFORMS", f"t{i}") for i in range(5)}
    plan = _plan(many, set(), cap=4)
    assert plan.stale and plan.pairs is None


def test_rollups_themselves_are_never_treated_as_lineage():
    plan = _plan({("a", "AGGREGATED", "b")}, set())
    assert plan.pairs == {} and not plan.stale
