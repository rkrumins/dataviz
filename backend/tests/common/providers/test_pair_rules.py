"""Unit tests for the shared DAG-correct pair rules.

``pair_rules`` is the single semantic mirror shared by the batch
pipeline (int node ids), the incremental write hooks and the versioning
projector (URN strings). These tests pin the contract all three rely
on: ancestors-or-self closures with set semantics (a diamond yields the
shared grandparent ONCE), the full-cube cross-product, and the DAG
generalization of the canonical depth-diagonal — which must reduce
byte-for-byte to the legacy single-parent rule on chain-shaped input.
"""
from __future__ import annotations

import pytest

from backend.common.providers.pair_rules import (
    ancestor_closure,
    boundary_pairs,
    cube_pairs,
)


# ---------------------------------------------------------------------------
# ancestor_closure
# ---------------------------------------------------------------------------

def test_closure_single_chain():
    # c -> b -> a (child -> parent)
    parents = {"c": ("b",), "b": ("a",)}
    assert ancestor_closure(parents, "c") == {"c": 2, "b": 1, "a": 0}
    assert ancestor_closure(parents, "b") == {"b": 1, "a": 0}
    assert ancestor_closure(parents, "a") == {"a": 0}


def test_closure_root_has_only_self():
    assert ancestor_closure({}, "solo") == {"solo": 0}


def test_closure_multi_parent_fans_out_to_both_ancestries():
    # leaf under X and Y, X under R1, Y under R2 — the explicit
    # requirement: BOTH ancestries appear.
    parents = {"leaf": ("X", "Y"), "X": ("R1",), "Y": ("R2",)}
    assert ancestor_closure(parents, "leaf") == {
        "leaf": 2, "X": 1, "Y": 1, "R1": 0, "R2": 0,
    }


def test_closure_diamond_yields_shared_grandparent_once():
    # leaf -> {X, Y} -> G. G must appear once (set semantics) — the
    # invariant that prevents double-counting a raw edge into G.
    parents = {"leaf": ("X", "Y"), "X": ("G",), "Y": ("G",)}
    closure = ancestor_closure(parents, "leaf")
    assert closure == {"leaf": 2, "X": 1, "Y": 1, "G": 0}


def test_closure_depth_is_max_over_parents():
    # Ragged multi-parent: one parent is deep, one is a root.
    # depth(leaf) = 1 + max(depth(X)=2, depth(Y)=0) = 3.
    parents = {"leaf": ("X", "Y"), "X": ("M",), "M": ("R",)}
    assert ancestor_closure(parents, "leaf") == {
        "leaf": 3, "X": 2, "M": 1, "R": 0, "Y": 0,
    }


def test_closure_cycle_is_cut_and_terminates():
    parents = {"a": ("b",), "b": ("a",)}
    closure = ancestor_closure(parents, "a")
    # The cycle-closing link is cut: both nodes present, finite depths.
    assert set(closure) == {"a", "b"}
    assert closure["a"] == closure["b"] + 1


def test_closure_self_parent_is_ignored():
    parents = {"a": ("a", "r"), "r": ()}
    assert ancestor_closure(parents, "a") == {"a": 1, "r": 0}


def test_closure_memo_is_shared_and_correct():
    parents = {"c": ("b",), "b": ("a",), "d": ("b",)}
    memo: dict = {}
    ancestor_closure(parents, "c", memo=memo)
    assert "b" in memo  # intermediate closures cached
    assert ancestor_closure(parents, "d", memo=memo) == {"d": 2, "b": 1, "a": 0}


def test_closure_int_keys():
    # Batch pipeline uses packed int node ids.
    parents = {3: (2,), 2: (1,)}
    assert ancestor_closure(parents, 3) == {3: 2, 2: 1, 1: 0}


# ---------------------------------------------------------------------------
# cube_pairs
# ---------------------------------------------------------------------------

def _cube(s_cl, t_cl, **kw):
    return set(cube_pairs(s_cl, t_cl, **kw))


def test_cube_full_cross_product_without_leaf_mirror():
    s_cl = {"s": 1, "S": 0}
    t_cl = {"t": 1, "T": 0}
    got = _cube(s_cl, t_cl, include_leaf_mirror=False, s="s", t="t")
    # Every ancestor combination EXCEPT the raw (s, t) mirror.
    assert got == {("s", "T"), ("S", "t"), ("S", "T")}


def test_cube_leaf_mirror_knob_includes_raw_pair():
    s_cl = {"s": 1, "S": 0}
    t_cl = {"t": 1, "T": 0}
    got = _cube(s_cl, t_cl, include_leaf_mirror=True, s="s", t="t")
    assert ("s", "t") in got
    assert got == {("s", "t"), ("s", "T"), ("S", "t"), ("S", "T")}


def test_cube_excludes_equal_endpoints():
    # Shared ancestor A on both sides never pairs with itself.
    s_cl = {"s": 2, "A": 0}
    t_cl = {"t": 1, "A": 0}
    got = _cube(s_cl, t_cl, include_leaf_mirror=False, s="s", t="t")
    assert ("A", "A") not in got
    assert got == {("s", "A"), ("A", "t")}


def test_cube_multi_parent_covers_every_combination():
    # The user's scenario: column A under Table1 under {X, Y} under App12
    # with lineage to column B under Table2 under {YZ, Z} under App34.
    s_cl = ancestor_closure(
        {"colA": ("t1",), "t1": ("X", "Y"), "X": ("app12",), "Y": ("app12",)},
        "colA",
    )
    t_cl = ancestor_closure(
        {"colB": ("t2",), "t2": ("YZ", "Z"), "YZ": ("app34",), "Z": ("app34",)},
        "colB",
    )
    got = _cube(s_cl, t_cl, include_leaf_mirror=False, s="colA", t="colB")
    # 5 source ancestors-or-self x 5 target — minus the raw mirror.
    assert len(got) == 5 * 5 - 1
    for sp in ("colA", "t1", "X", "Y", "app12"):
        for tp in ("colB", "t2", "YZ", "Z", "app34"):
            if (sp, tp) == ("colA", "colB"):
                continue
            assert (sp, tp) in got


# ---------------------------------------------------------------------------
# boundary_pairs
# ---------------------------------------------------------------------------

def _legacy_boundary(cs, ct):
    """The pre-DAG rule, transcribed from _merge_canonical_pairs
    (falkordb_materialize.py): chains are (rank, id) deepest-first; for
    each rank in the union, pair each side's deepest rep at rank <= R."""
    pairs = set()
    for level in {l for l, _ in cs} | {l for l, _ in ct}:
        sp = next((i for l, i in cs if l <= level), None)
        tp = next((i for l, i in ct if l <= level), None)
        if sp is None or tp is None or sp == tp:
            continue
        pairs.add((sp, tp))
    return pairs


def test_boundary_reduces_to_legacy_rule_on_chains_aligned():
    # domain > table on both sides (aligned depths).
    s_reps = {"s_tbl": 1, "s_dom": 0}
    t_reps = {"t_tbl": 1, "t_dom": 0}
    legacy = _legacy_boundary(
        ((1, "s_tbl"), (0, "s_dom")),
        ((1, "t_tbl"), (0, "t_dom")),
    )
    assert boundary_pairs(s_reps, t_reps) == legacy == {
        ("s_tbl", "t_tbl"), ("s_dom", "t_dom"),
    }


def test_boundary_reduces_to_legacy_rule_on_ragged_chains():
    # Source has depth 2 container, target only reaches depth 1: the
    # ragged case yields the mixed-depth cell (s2 -> t1).
    s_reps = {"s2": 2, "s1": 1, "s0": 0}
    t_reps = {"t1": 1, "t0": 0}
    legacy = _legacy_boundary(
        ((2, "s2"), (1, "s1"), (0, "s0")),
        ((1, "t1"), (0, "t0")),
    )
    assert boundary_pairs(s_reps, t_reps) == legacy == {
        ("s2", "t1"), ("s1", "t1"), ("s0", "t0"),
    }


def test_boundary_gap_depths_bridge_downward():
    # Source side skips depth 1 entirely (a container directly under a
    # root holding deep children): rank 1 bridges to the depth-0 rep.
    s_reps = {"s2": 2, "s0": 0}
    t_reps = {"t1": 1, "t0": 0}
    legacy = _legacy_boundary(((2, "s2"), (0, "s0")), ((1, "t1"), (0, "t0")))
    assert boundary_pairs(s_reps, t_reps) == legacy == {
        ("s2", "t1"), ("s0", "t1"), ("s0", "t0"),
    }


def test_boundary_drops_equal_endpoints():
    shared = {"c": 1, "r": 0}
    assert boundary_pairs(shared, shared) == set()


def test_boundary_empty_side_yields_nothing():
    assert boundary_pairs({}, {"t": 0}) == set()
    assert boundary_pairs({"s": 0}, {}) == set()


def test_boundary_multi_parent_pairs_every_rep_at_rank():
    # Source leaf under BOTH X and Y (depth 1): at rank 1 the source
    # side is the SET {X, Y}; both pair with the target's depth-1 rep.
    s_reps = {"X": 1, "Y": 1, "R1": 0, "R2": 0}
    t_reps = {"T1": 1, "T0": 0}
    assert boundary_pairs(s_reps, t_reps) == {
        ("X", "T1"), ("Y", "T1"), ("R1", "T0"), ("R2", "T0"),
    }


def test_boundary_diamond_grandparent_once():
    # Diamond above the source: reps {X:1, Y:1, G:0}. G pairs once per
    # target rep — set output makes double-counting impossible.
    s_reps = {"X": 1, "Y": 1, "G": 0}
    t_reps = {"T1": 1, "T0": 0}
    got = boundary_pairs(s_reps, t_reps)
    assert got == {("X", "T1"), ("Y", "T1"), ("G", "T0")}


def test_boundary_deep_vs_root_only():
    # Target side has only a root container: every source rank bridges
    # to it (the canvas cell "anything -> root").
    s_reps = {"s3": 3, "s1": 1, "s0": 0}
    t_reps = {"T": 0}
    legacy = _legacy_boundary(((3, "s3"), (1, "s1"), (0, "s0")), ((0, "T"),))
    assert boundary_pairs(s_reps, t_reps) == legacy == {
        ("s3", "T"), ("s1", "T"), ("s0", "T"),
    }
