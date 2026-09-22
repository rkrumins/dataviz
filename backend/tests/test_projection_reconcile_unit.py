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


def _en(label, fp="x"):
    return ExpectedNode(entity_id="e", label=label, payload={}, fp=fp)


def _ee(fp="x"):
    return ExpectedEdge(entity_id="e", payload={}, fp=fp)


# ── raw diff ──────────────────────────────────────────────────────────────


def test_identical_projection_writes_nothing():
    nodes = {"a": _en("domain"), "b": _en("dataset")}
    edges = {("a", "CONTAINS", "b"): _ee()}
    d = diff_projection(
        nodes, edges,
        {"a": ActualNode("domain", "x"), "b": ActualNode("dataset", "x")},
        {("a", "CONTAINS", "b"): ActualEdge("x")},
    )
    assert d.empty


def test_missing_extra_and_changed_are_the_only_writes():
    expected_nodes = {"a": _en("domain"), "b": _en("dataset", fp="new"), "c": _en("dataset")}
    expected_edges = {("a", "CONTAINS", "c"): _ee()}
    actual_nodes = {"a": ActualNode("domain", "x"), "b": ActualNode("dataset", "old"),
                    "z": ActualNode("dataset", "x")}
    actual_edges = {("a", "CONTAINS", "z"): ActualEdge("x")}
    d = diff_projection(expected_nodes, expected_edges, actual_nodes, actual_edges)
    assert sorted(d.node_upserts) == ["b", "c"]          # changed + missing; "a" untouched
    assert d.node_deletes == [("z", "dataset")]
    assert d.edge_upserts == [("a", "CONTAINS", "c")]
    # The extra edge dies with its endpoint's DETACH DELETE — no separate write.
    assert d.edge_deletes == []


def test_a_node_whose_type_changed_is_recreated_under_its_new_label():
    # MERGE keys on (label, urn): merging under the new label alone would leave
    # the old-label node behind as a duplicate.
    d = diff_projection(
        {"a": _en("schemaField"), "b": _en("dataset")},
        {("a", "TRANSFORMS", "b"): _ee()},
        {"a": ActualNode("domain", "x"), "b": ActualNode("dataset", "x")},
        {("a", "TRANSFORMS", "b"): ActualEdge("x")},
    )
    assert d.node_upserts == ["a"]
    assert d.node_deletes == [("a", "domain")]
    assert d.relabelled == {"a"}
    # Its edges went with the old node, so they are written again.
    assert d.edge_upserts == [("a", "TRANSFORMS", "b")]


def test_an_unstamped_projection_is_rewritten_once_in_place():
    # Graphs projected before fingerprints existed carry none: every item is
    # rewritten on the first reconcile (in place, no drop), then never again.
    d = diff_projection(
        {"a": _en("domain")}, {},
        {"a": ActualNode("domain", None)}, {},
    )
    assert d.node_upserts == ["a"] and not d.node_deletes


def test_an_extra_edge_between_surviving_nodes_is_deleted():
    d = diff_projection(
        {"a": _en("domain"), "b": _en("domain")}, {},
        {"a": ActualNode("domain", "x"), "b": ActualNode("domain", "x")},
        {("a", "DEPENDS_ON", "b"): ActualEdge("x")},
    )
    assert d.edge_deletes == [("a", "DEPENDS_ON", "b")]


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
