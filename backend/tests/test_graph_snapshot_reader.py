"""Unit tests for snapshot reconstruction + working-set application.
Pure logic, no DB (fetchers injected)."""
import gzip

import pytest

from backend.app.services.graph_versioning.commit import EdgeState, NodeState
from backend.app.services.graph_versioning.content_address import (
    edge_content_hash,
    node_content_hash,
)
from backend.app.services.graph_versioning.manifest import (
    ManifestEntry,
    build_snapshot,
    decode_partition_entries,
)
from backend.app.services.graph_versioning.snapshot_reader import (
    StaleBaseError,
    WorkingSetError,
    apply_changes,
    rebuild_snapshot,
)


def _entries(n):
    return [ManifestEntry(f"urn:{i}", "node", f"h{i}") for i in range(n)]


def _fetchers(snap):
    root = sorted((i, p.manifest_hash) for i, p in snap.partitions.items())
    by_hash = {p.manifest_hash: dict(p.entries) for p in snap.partitions.values()}
    return (lambda rh: root), (lambda mh: by_hash[mh])


def test_partition_gzip_roundtrips_through_decoder():
    snap = build_snapshot(_entries(50), 64)
    p = next(iter(snap.partitions.values()))
    restored = decode_partition_entries(gzip.decompress(p.gzip_bytes()))
    assert restored == dict(p.entries)


def test_rebuild_roundtrips_root_and_partitions():
    snap = build_snapshot(_entries(300), 128)
    fr, fp = _fetchers(snap)
    rebuilt = rebuild_snapshot(
        root_hash=snap.root_hash, partition_count=128,
        fetch_root=fr, fetch_partition=fp,
    )
    assert rebuilt.root_hash == snap.root_hash
    assert set(rebuilt.partitions) == set(snap.partitions)
    for idx, p in snap.partitions.items():
        assert rebuilt.partitions[idx].manifest_hash == p.manifest_hash
        assert dict(rebuilt.partitions[idx].entries) == dict(p.entries)


def test_none_or_unknown_root_is_empty_snapshot():
    empty = rebuild_snapshot(
        root_hash=None, partition_count=64,
        fetch_root=lambda h: None, fetch_partition=lambda h: {},
    )
    assert empty.partitions == {}
    unknown = rebuild_snapshot(
        root_hash="deadbeef", partition_count=64,
        fetch_root=lambda h: None, fetch_partition=lambda h: {},
    )
    assert unknown.partitions == {}


def test_corrupt_manifest_detected():
    snap = build_snapshot(_entries(20), 32)
    fr, _ = _fetchers(snap)
    # Partition fetcher returns tampered entries -> rebuilt root differs.
    with pytest.raises(ValueError, match="integrity"):
        rebuild_snapshot(
            root_hash=snap.root_hash, partition_count=32,
            fetch_root=fr,
            fetch_partition=lambda mh: {"urn:tampered": ("node", "x")},
        )


# ── apply_changes ──────────────────────────────────────────────────

def _node(k, name="n"):
    return NodeState(k, "T", name, {"x": 0, "y": 0}, {})


def test_apply_add_update_delete_nodes():
    base = {"urn:a": _node("urn:a", "a")}
    nodes, edges = apply_changes(
        base_nodes=base, base_edges={},
        changes=[
            {"change_type": "add_node", "payload": {
                "key": "urn:b", "entity_type": "T", "display_name": "b",
                "position": {"x": 1, "y": 1}, "properties": {}, "tags": []}},
            {"change_type": "update_node", "payload": {
                "key": "urn:a", "entity_type": "T", "display_name": "a2",
                "position": {"x": 0, "y": 0}, "properties": {}, "tags": []}},
        ],
    )
    assert set(nodes) == {"urn:a", "urn:b"}
    assert nodes["urn:a"].display_name == "a2"
    # base map not mutated
    assert base["urn:a"].display_name == "a"


def test_apply_edge_lifecycle_and_delete():
    base_n = {"urn:a": _node("urn:a"), "urn:b": _node("urn:b")}
    nodes, edges = apply_changes(
        base_nodes=base_n, base_edges={},
        changes=[
            {"change_type": "add_edge", "payload": {
                "key": "e1", "source_key": "urn:a", "target_key": "urn:b",
                "edge_type": "r", "properties": {}}},
            {"change_type": "delete_node", "payload": {"key": "urn:b"}},
        ],
    )
    assert "e1" in edges
    assert "urn:b" not in nodes  # dangling-edge now; validator catches at commit


@pytest.mark.parametrize("bad", [
    {"change_type": "update_node", "payload": {"key": "ghost"}},
    {"change_type": "delete_node", "payload": {"key": "ghost"}},
    {"change_type": "delete_edge", "payload": {"key": "ghost"}},
    {"change_type": "nonsense", "payload": {}},
])
def test_impossible_ops_raise(bad):
    with pytest.raises(WorkingSetError):
        apply_changes(base_nodes={}, base_edges={}, changes=[bad])


def test_duplicate_add_raises():
    with pytest.raises(WorkingSetError, match="already exists"):
        apply_changes(
            base_nodes={"urn:a": _node("urn:a")}, base_edges={},
            changes=[{"change_type": "add_node", "payload": {
                "key": "urn:a", "entity_type": "T", "display_name": "x",
                "position": None, "properties": {}, "tags": []}}],
        )


# ── base_content_hash lost-update guard ────────────────────────────

def _hash_of_node(n: NodeState) -> str:
    return node_content_hash(
        entity_type=n.entity_type,
        display_name=n.display_name,
        position=n.position,
        properties=n.properties,
        tags=n.tags,
    )


def _hash_of_edge(e: EdgeState) -> str:
    return edge_content_hash(
        source_node_key=e.source_key,
        target_node_key=e.target_key,
        edge_type=e.edge_type,
        confidence=e.confidence,
        properties=e.properties,
    )


def test_stale_base_content_hash_on_update_node_raises():
    base_node = _node("urn:a", "a")
    base = {"urn:a": base_node}
    with pytest.raises(StaleBaseError) as exc:
        apply_changes(
            base_nodes=base, base_edges={},
            changes=[{
                "change_type": "update_node",
                "payload": {
                    "key": "urn:a", "entity_type": "T",
                    "display_name": "a-edited",
                    "position": {"x": 0, "y": 0}, "properties": {}, "tags": [],
                },
                "base_content_hash": "0" * 64,  # client thought it was something else
            }],
        )
    (v,) = exc.value.violations
    assert v.object_kind == "node"
    assert v.object_id == "urn:a"
    assert v.expected_base_content_hash == "0" * 64
    assert v.observed_content_hash == _hash_of_node(base_node)


def test_matching_base_content_hash_passes():
    base_node = _node("urn:a", "a")
    base = {"urn:a": base_node}
    nodes, _ = apply_changes(
        base_nodes=base, base_edges={},
        changes=[{
            "change_type": "update_node",
            "payload": {
                "key": "urn:a", "entity_type": "T",
                "display_name": "a-edited",
                "position": {"x": 0, "y": 0}, "properties": {}, "tags": [],
            },
            "base_content_hash": _hash_of_node(base_node),
        }],
    )
    assert nodes["urn:a"].display_name == "a-edited"


def test_missing_base_content_hash_skips_check():
    # Older clients that don't send base_content_hash still work — the
    # ref CAS remains the protection.
    base_node = _node("urn:a", "a")
    nodes, _ = apply_changes(
        base_nodes={"urn:a": base_node}, base_edges={},
        changes=[{
            "change_type": "update_node",
            "payload": {
                "key": "urn:a", "entity_type": "T", "display_name": "a-edited",
                "position": {"x": 0, "y": 0}, "properties": {}, "tags": [],
            },
            # no base_content_hash
        }],
    )
    assert nodes["urn:a"].display_name == "a-edited"


def test_delete_against_disappeared_object_is_stale():
    # Object existed when the client staged delete, but now it is gone
    # from base (e.g. another commit removed it). observed=None.
    with pytest.raises(StaleBaseError) as exc:
        apply_changes(
            base_nodes={}, base_edges={},
            changes=[{
                "change_type": "delete_node",
                "payload": {"key": "urn:gone"},
                "base_content_hash": "abc123",
            }],
        )
    (v,) = exc.value.violations
    assert v.object_id == "urn:gone"
    assert v.observed_content_hash is None


def test_stale_base_collects_all_violations():
    base = {
        "urn:a": _node("urn:a", "a"),
        "urn:b": _node("urn:b", "b"),
    }
    with pytest.raises(StaleBaseError) as exc:
        apply_changes(
            base_nodes=base, base_edges={},
            changes=[
                {"change_type": "update_node",
                 "payload": {"key": "urn:a", "entity_type": "T",
                             "display_name": "a2", "position": None,
                             "properties": {}, "tags": []},
                 "base_content_hash": "bad-a"},
                {"change_type": "update_node",
                 "payload": {"key": "urn:b", "entity_type": "T",
                             "display_name": "b2", "position": None,
                             "properties": {}, "tags": []},
                 "base_content_hash": "bad-b"},
            ],
        )
    ids = {v.object_id for v in exc.value.violations}
    assert ids == {"urn:a", "urn:b"}


def test_add_node_ignores_base_content_hash():
    # Adds never get a stale-check (no base to compare against).
    nodes, _ = apply_changes(
        base_nodes={}, base_edges={},
        changes=[{
            "change_type": "add_node",
            "payload": {
                "key": "urn:new", "entity_type": "T", "display_name": "n",
                "position": None, "properties": {}, "tags": [],
            },
            "base_content_hash": "irrelevant",
        }],
    )
    assert "urn:new" in nodes


def test_stale_base_on_edge_update():
    base_edge = EdgeState("e1", "urn:a", "urn:b", "r", None, {})
    base = {"e1": base_edge}
    with pytest.raises(StaleBaseError) as exc:
        apply_changes(
            base_nodes={"urn:a": _node("urn:a"), "urn:b": _node("urn:b")},
            base_edges=base,
            changes=[{
                "change_type": "update_edge",
                "payload": {
                    "key": "e1", "source_key": "urn:a", "target_key": "urn:b",
                    "edge_type": "r2", "properties": {},
                },
                "base_content_hash": "stale",
            }],
        )
    (v,) = exc.value.violations
    assert v.object_kind == "edge"
    assert v.observed_content_hash == _hash_of_edge(base_edge)
