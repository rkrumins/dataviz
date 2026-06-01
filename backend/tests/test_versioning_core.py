"""Unit tests for the versioning pure-logic core (Merkle, 3-way merge, ULID).

These have no DB/FalkorDB dependency, so they run fast in CI.  The same
invariants are also exercised by each module's ``_selftest()`` (run directly via
``python backend/app/services/versioning/<module>.py``) for environments without
the full test stack installed.
"""
from backend.app.services.versioning import ids
from backend.app.services.versioning.changeset import (
    diff_states,
    field_diff,
    materialize,
    net_delta,
)
from backend.app.services.versioning.merge import (
    Conflict,
    find_dangling_edges,
    three_way_merge,
)
from backend.app.services.versioning.merkle import MerkleTree, content_hash


# --------------------------------------------------------------------------- #
# Merkle                                                                       #
# --------------------------------------------------------------------------- #
def _entities(n: int) -> dict[str, str]:
    return {f"e{i}": content_hash({"v": i}) for i in range(n)}


def test_merkle_root_is_order_independent():
    ents = _entities(300)
    items = list(ents.items())
    items.reverse()
    assert MerkleTree.build(ents).root == MerkleTree.build(dict(items)).root


def test_merkle_diff_isolates_single_change():
    t1 = MerkleTree.build(_entities(300))
    t2 = t1.apply({"e42": content_hash({"v": 999})})
    assert set(t1.changed_entities(t2)) == {"e42"}
    # And only one leaf bucket is touched — the projection-diff is bounded.
    assert len(t1.changed_leaf_paths(t2)) == 1


def test_merkle_cow_apply_matches_full_rebuild():
    ents = _entities(300)
    t1 = MerkleTree.build(ents)
    changes = {"e1": content_hash({"v": -1}), "newX": content_hash({"v": 7}), "e2": None}
    rebuilt = dict(ents)
    rebuilt["e1"] = content_hash({"v": -1})
    rebuilt["newX"] = content_hash({"v": 7})
    rebuilt.pop("e2")
    assert t1.apply(changes).root == MerkleTree.build(rebuilt).root


def test_merkle_identical_graphs_have_no_diff():
    ents = _entities(1000)
    assert MerkleTree.build(ents).changed_leaf_paths(MerkleTree.build(dict(ents))) == []


def test_merkle_tombstone_hash_is_distinct():
    assert content_hash(None) != content_hash({}) != content_hash({"a": 1})


# --------------------------------------------------------------------------- #
# 3-way merge                                                                  #
# --------------------------------------------------------------------------- #
def test_merge_non_overlapping_fields_auto_merge():
    out = three_way_merge({"a": 1, "b": 2}, {"a": 1, "b": 2, "c": 3}, {"a": 1, "b": 9})
    assert out.merged == {"a": 1, "b": 9, "c": 3}
    assert not out.has_conflicts


def test_merge_divergent_same_field_conflicts():
    out = three_way_merge({"a": 1}, {"a": 2}, {"a": 3})
    assert out.has_conflicts
    c = out.conflicts[0]
    assert (c.path, c.base, c.ours, c.theirs) == (("a",), 1, 2, 3)


def test_merge_nested_object_recursive_auto_merge():
    out = three_way_merge(
        {"p": {"x": 1, "y": 1}}, {"p": {"x": 2, "y": 1}}, {"p": {"x": 1, "y": 3}}
    )
    assert out.merged == {"p": {"x": 2, "y": 3}}
    assert not out.has_conflicts


def test_merge_set_field_union():
    out = three_way_merge(
        {"tags": ["a", "b"]},
        {"tags": ["a", "b", "c"]},
        {"tags": ["a", "d"]},
        set_fields=frozenset({"tags"}),
    )
    assert out.merged == {"tags": ["a", "c", "d"]}
    assert not out.has_conflicts


def test_merge_delete_vs_modify_conflicts():
    out = three_way_merge({"a": 1}, None, {"a": 2})
    assert out.has_conflicts and out.conflicts[0].kind == "delete/modify"
    # delete vs unchanged honours the deletion
    assert three_way_merge({"a": 1}, None, {"a": 1}).merged is None


def test_referential_integrity_finds_edge_to_tombstoned_node():
    assert find_dangling_edges(
        {"n1", "n2"}, {"e1": ("n1", "n2"), "e2": ("n1", "n3")}
    ) == ["e2"]


# --------------------------------------------------------------------------- #
# ULID                                                                         #
# --------------------------------------------------------------------------- #
def test_ulid_is_sortable_and_unique():
    batch = [ids.ulid() for _ in range(2000)]
    assert batch == sorted(batch)
    assert len(set(batch)) == len(batch)
    assert all(len(u) == 26 for u in batch)


def test_prefixed_id_shape():
    pid = ids.prefixed_id("cmt")
    assert pid.startswith("cmt_") and len(pid) == 4 + 26


# --------------------------------------------------------------------------- #
# changeset (squash / diff)                                                    #
# --------------------------------------------------------------------------- #
def test_materialize_collapses_ops_last_write_wins():
    base = {"a": {"n": "A"}, "b": {"n": "B"}}
    head = materialize(
        base,
        [
            {"entity_id": "b", "op": "update", "payload": {"n": "B2"}},
            {"entity_id": "c", "op": "create", "payload": {"n": "C"}},
            {"entity_id": "a", "op": "delete", "payload": None},
            {"entity_id": "d", "op": "create", "payload": {"n": "D"}},
            {"entity_id": "d", "op": "delete", "payload": None},
        ],
    )
    assert head == {"a": None, "b": {"n": "B2"}, "c": {"n": "C"}, "d": None}


def test_net_delta_squashes_and_dedups():
    base = {"a": {"n": "A"}, "b": {"n": "B"}}
    head = {"a": None, "b": {"n": "B2"}, "c": {"n": "C"}, "d": None}
    by_id = {d.entity_id: d.op for d in net_delta(base, head)}
    # 'd' (created then deleted within the draft) contributes nothing.
    assert by_id == {"a": "delete", "b": "update", "c": "create"}


def test_net_delta_noop_edit_produces_nothing():
    base = {"a": {"n": "A"}}
    head = materialize(base, [{"entity_id": "a", "op": "update", "payload": {"n": "A"}}])
    assert net_delta(base, head) == []


def test_field_diff_and_diff_states():
    assert field_diff({"x": 1, "y": 2}, {"x": 1, "y": 3, "z": 4}) == {"y": (2, 3), "z": (None, 4)}
    d = diff_states({"a": {"n": "A"}, "b": {"n": "B"}}, {"a": None, "b": {"n": "B2"}, "c": {"n": "C"}})
    assert d["added"] == ["c"] and d["removed"] == ["a"]
    assert d["modified"] == {"b": {"n": ("B", "B2")}}
