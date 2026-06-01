"""Hierarchical, copy-on-write Merkle tree over a graph's entity set.

Why this exists (plan §2 decision #2, §5, §16.5 #3):

* **Integrity** — the per-commit ``merkle_root`` is a tamper-evident fingerprint
  of the entire graph state at that commit.
* **Incremental projection** — to project commit *N* into FalkorDB given the
  last-projected commit *P*, we walk the two trees top-down and descend only
  where subtree hashes differ, yielding the exact set of changed entities in
  ``O(changed · depth)`` instead of rescanning the whole graph.

Design:

* Entities (nodes *and* edges, keyed by their stable ``entity_id``) are bucketed
  into a fixed 16-way (one hex nibble per level) trie of configurable depth
  (:data:`config.MERKLE_DEPTH`).  Default depth 4 → 16⁴ = 65 536 leaf buckets.
* A leaf bucket's hash covers the sorted ``(entity_id, content_hash)`` pairs in
  it; an internal node's hash covers its 16 child hashes.  All hashing routes
  through :func:`config.hash_parts` (length-prefixed, cryptographic).
* :meth:`MerkleTree.apply` is **copy-on-write**: only buckets on the path to a
  changed entity are recomputed; untouched subtree hashes are shared by value.

The hash algorithm and depth are **configurable** (see :mod:`config`) but are
immutable-after-data: changing them invalidates existing roots.
"""
from __future__ import annotations

import hashlib
import json
from typing import Dict, Iterable, List, Mapping, Optional, Tuple

try:  # imported as part of the package …
    from . import config
except ImportError:  # … or run directly as a script (python merkle.py)
    import config  # type: ignore

__all__ = ["canonical_hash", "content_hash", "MerkleTree", "DEFAULT_DEPTH"]

DEFAULT_DEPTH = config.MERKLE_DEPTH
_FANOUT = 16                       # one hex nibble per trie level
_EMPTY = config.empty_hash()       # sentinel hash for an absent child/bucket

Path = Tuple[int, ...]


# --------------------------------------------------------------------------- #
# Hashing                                                                      #
# --------------------------------------------------------------------------- #
def canonical_hash(obj) -> str:
    """Deterministic content hash of an arbitrary JSON-able object (sorted keys)."""
    blob = json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return config.hash_parts(blob.encode("utf-8"))


def content_hash(payload: Optional[Mapping]) -> str:
    """Content hash of an entity payload.

    A tombstone (``payload is None``) gets a distinct, stable hash so "deleted"
    differs from "never existed" and from any real payload.
    """
    if payload is None:
        return config.hash_parts(b"\x00tombstone")
    return canonical_hash(payload)


def _leaf_path(entity_id: str, depth: int) -> Path:
    """Deterministic leaf bucket for *entity_id* (first *depth* hex nibbles).

    Uses a small fixed blake2b digest purely to spread ids across buckets; this
    is a bucketing function, not the integrity hash, so it is intentionally
    independent of the configurable content hash.
    """
    digest = hashlib.blake2b(entity_id.encode("utf-8"), digest_size=16).hexdigest()
    return tuple(int(c, 16) for c in digest[:depth])


def _leaf_hash(bucket: Mapping[str, str]) -> str:
    """Order-independent hash of a leaf bucket's ``{entity_id: content_hash}``."""
    if not bucket:
        return _EMPTY
    parts: List[bytes] = []
    for eid in sorted(bucket):
        parts.append(eid.encode("utf-8"))
        parts.append(bucket[eid].encode("ascii"))
    return config.hash_parts(*parts)


# --------------------------------------------------------------------------- #
# The tree                                                                    #
# --------------------------------------------------------------------------- #
class MerkleTree:
    """Immutable-by-convention Merkle tree (use :meth:`apply` for CoW updates).

    * ``leaves``: ``{leaf_path: {entity_id: content_hash}}`` — non-empty buckets.
    * ``nodes``:  ``{prefix_path: hash}`` for every non-empty node; ``nodes[()]``
      is the root.  Absent prefixes hash to :data:`_EMPTY`.
    """

    __slots__ = ("depth", "leaves", "nodes")

    def __init__(self, depth: int, leaves: Dict[Path, Dict[str, str]], nodes: Dict[Path, str]):
        self.depth = depth
        self.leaves = leaves
        self.nodes = nodes

    @classmethod
    def build(cls, entities: Mapping[str, str], depth: Optional[int] = None) -> "MerkleTree":
        """Build a tree from ``{entity_id: content_hash}`` for all live entities."""
        d = DEFAULT_DEPTH if depth is None else depth
        leaves: Dict[Path, Dict[str, str]] = {}
        for eid, chash in entities.items():
            leaves.setdefault(_leaf_path(eid, d), {})[eid] = chash
        tree = cls(d, leaves, {})
        tree._recompute(set(leaves.keys()))
        return tree

    @property
    def root(self) -> str:
        return self.nodes.get((), _EMPTY)

    def apply(self, changes: Mapping[str, Optional[str]]) -> "MerkleTree":
        """Return a new tree with *changes* applied (CoW).

        ``changes`` maps ``entity_id -> content_hash`` for upserts and
        ``entity_id -> None`` to drop the entity from the tree entirely (used
        when a squash collapses a create+delete within one branch).  Only buckets
        on the path to a changed entity are recomputed.
        """
        new_leaves: Dict[Path, Dict[str, str]] = dict(self.leaves)
        touched: set[Path] = set()
        for eid, chash in changes.items():
            path = _leaf_path(eid, self.depth)
            bucket = dict(new_leaves.get(path, {}))   # copy only touched buckets
            if chash is None:
                bucket.pop(eid, None)
            else:
                bucket[eid] = chash
            if bucket:
                new_leaves[path] = bucket
            else:
                new_leaves.pop(path, None)
            touched.add(path)

        new = MerkleTree(self.depth, new_leaves, dict(self.nodes))
        new._recompute(touched)
        return new

    def changed_leaf_paths(self, other: "MerkleTree") -> List[Path]:
        """Leaf paths whose hash differs — top-down, pruning equal subtrees."""
        out: List[Path] = []
        self._walk_diff((), other, out)
        return out

    def changed_entities(self, other: "MerkleTree") -> Dict[str, Tuple[Optional[str], Optional[str]]]:
        """Differing entities as ``{entity_id: (self_hash, other_hash)}`` (None = absent)."""
        diff: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
        for path in self.changed_leaf_paths(other):
            a = self.leaves.get(path, {})
            b = other.leaves.get(path, {})
            for eid in set(a) | set(b):
                av, bv = a.get(eid), b.get(eid)
                if av != bv:
                    diff[eid] = (av, bv)
        return diff

    # ---- internals ------------------------------------------------------- #
    def _walk_diff(self, prefix: Path, other: "MerkleTree", out: List[Path]) -> None:
        if self.nodes.get(prefix, _EMPTY) == other.nodes.get(prefix, _EMPTY):
            return
        if len(prefix) == self.depth:
            out.append(prefix)
            return
        for idx in range(_FANOUT):
            self._walk_diff(prefix + (idx,), other, out)

    def _recompute(self, touched_leaves: Iterable[Path]) -> None:
        dirty_by_level: Dict[int, set[Path]] = {}
        for leaf in touched_leaves:
            bucket = self.leaves.get(leaf)
            if bucket:
                self.nodes[leaf] = _leaf_hash(bucket)
            else:
                self.nodes.pop(leaf, None)
            for level in range(self.depth + 1):
                dirty_by_level.setdefault(level, set()).add(leaf[:level])

        for level in range(self.depth - 1, -1, -1):
            for prefix in dirty_by_level.get(level, ()):  # type: ignore[arg-type]
                child_hashes = [
                    self.nodes.get(prefix + (idx,), _EMPTY) for idx in range(_FANOUT)
                ]
                if all(h == _EMPTY for h in child_hashes):
                    self.nodes.pop(prefix, None)
                else:
                    self.nodes[prefix] = config.hash_parts(
                        *(h.encode("ascii") for h in child_hashes)
                    )


# --------------------------------------------------------------------------- #
# Self-test                                                                    #
# --------------------------------------------------------------------------- #
def _selftest() -> None:
    import random

    ents = {f"e{i}": content_hash({"v": i}) for i in range(500)}
    t1 = MerkleTree.build(ents)
    items = list(ents.items())
    random.shuffle(items)
    assert t1.root == MerkleTree.build(dict(items)).root, "root must be order-independent"
    assert t1.root != _EMPTY

    empty = MerkleTree.build({})
    assert empty.root == _EMPTY and empty.changed_entities(empty) == {}

    t3 = t1.apply({"e42": content_hash({"v": 999})})
    assert t3.root != t1.root
    assert set(t1.changed_entities(t3)) == {"e42"}
    assert len(t1.changed_leaf_paths(t3)) == 1

    changes = {"e1": content_hash({"v": -1}), "newX": content_hash({"v": 7}), "e2": None}
    rebuilt = dict(ents)
    rebuilt["e1"] = content_hash({"v": -1})
    rebuilt["newX"] = content_hash({"v": 7})
    rebuilt.pop("e2")
    assert t1.apply(changes).root == MerkleTree.build(rebuilt).root, "CoW == full rebuild"

    d2 = t1.changed_entities(t1.apply(changes))
    assert d2["newX"] == (None, content_hash({"v": 7}))
    assert d2["e2"][1] is None

    big = {f"n{i}": content_hash({"i": i}) for i in range(5000)}
    b1 = MerkleTree.build(big)
    assert b1.changed_leaf_paths(MerkleTree.build(dict(big))) == []
    assert len(b1.changed_leaf_paths(b1.apply({"n2500": content_hash({"i": "x"})}))) == 1

    assert content_hash(None) != content_hash({}) != content_hash({"a": 1})
    print("merkle.py self-test: OK")


if __name__ == "__main__":
    _selftest()
