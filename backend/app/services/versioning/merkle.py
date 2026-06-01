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
  into a fixed-arity (16-way, i.e. one hex nibble per level) trie of configurable
  ``depth``.  Default depth 4 → 16⁴ = 65 536 leaf buckets, ~1.5k entities/bucket
  at 100M — small enough that a changed bucket re-projects cheaply.
* A leaf bucket's hash covers the sorted ``(entity_id, content_hash)`` pairs in
  it; an internal node's hash covers its 16 child hashes.  Hashing is
  **length-prefixed** so concatenation is unambiguous.
* :meth:`MerkleTree.apply` is **copy-on-write**: only buckets on the path to a
  changed entity are recomputed; untouched subtree hashes are shared by value.

Hashing uses ``blake2b`` (cryptographic, stdlib — no dependency).  ``blake3`` is
a drop-in upgrade later: swap :data:`_DIGEST_SIZE`/:func:`_hash` only.  We do
**not** use a non-cryptographic hash (xxHash/Murmur) because the tree carries an
integrity guarantee that those would forfeit (plan §16.5 #3).
"""
from __future__ import annotations

import hashlib
import json
from typing import Dict, Iterable, List, Mapping, Optional, Tuple

__all__ = [
    "canonical_hash",
    "content_hash",
    "MerkleTree",
    "DEFAULT_DEPTH",
]

DEFAULT_DEPTH = 4          # 16**4 = 65536 leaf buckets
_FANOUT = 16               # one hex nibble per level
_DIGEST_SIZE = 32          # 256-bit, integrity-grade
_EMPTY = "0" * (_DIGEST_SIZE * 2)   # sentinel hash for an absent child/bucket

Path = Tuple[int, ...]


# --------------------------------------------------------------------------- #
# Hashing primitives                                                          #
# --------------------------------------------------------------------------- #
def _hash(*parts: bytes) -> str:
    """Length-prefixed blake2b over *parts*.

    Length-prefixing each part means ``_hash(b"ab", b"c")`` ≠ ``_hash(b"a", b"bc")``
    — without it, concatenation would create avoidable collisions.
    """
    h = hashlib.blake2b(digest_size=_DIGEST_SIZE)
    for p in parts:
        h.update(len(p).to_bytes(8, "big"))
        h.update(p)
    return h.hexdigest()


def canonical_hash(obj) -> str:
    """Deterministic hash of an arbitrary JSON-able object (sorted keys)."""
    blob = json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return _hash(blob.encode("utf-8"))


def content_hash(payload: Optional[Mapping]) -> str:
    """Content hash of an entity payload.

    A tombstone (``payload is None``) gets a distinct, stable hash so that
    "deleted" differs from "never existed" and from any real payload.
    """
    if payload is None:
        return _hash(b"\x00tombstone")
    return canonical_hash(payload)


def _leaf_path(entity_id: str, depth: int) -> Path:
    """Deterministic leaf bucket for *entity_id* (first *depth* hex nibbles)."""
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
    return _hash(*parts)


# --------------------------------------------------------------------------- #
# The tree                                                                    #
# --------------------------------------------------------------------------- #
class MerkleTree:
    """Immutable-by-convention Merkle tree.

    Internal state:

    * ``leaves``: ``{leaf_path: {entity_id: content_hash}}`` — only non-empty
      buckets are stored.
    * ``nodes``:  ``{prefix_path: hash}`` for every internal node *and* leaf that
      is non-empty (so ``nodes[()]`` is the root).  Absent prefixes hash to
      :data:`_EMPTY`.

    Treat instances as immutable: :meth:`apply` returns a new tree (CoW).
    """

    __slots__ = ("depth", "leaves", "nodes")

    def __init__(self, depth: int, leaves: Dict[Path, Dict[str, str]], nodes: Dict[Path, str]):
        self.depth = depth
        self.leaves = leaves
        self.nodes = nodes

    # ---- construction ---------------------------------------------------- #
    @classmethod
    def build(cls, entities: Mapping[str, str], depth: int = DEFAULT_DEPTH) -> "MerkleTree":
        """Build a tree from ``{entity_id: content_hash}`` for all live entities."""
        leaves: Dict[Path, Dict[str, str]] = {}
        for eid, chash in entities.items():
            leaves.setdefault(_leaf_path(eid, depth), {})[eid] = chash
        tree = cls(depth, leaves, {})
        tree._recompute(set(leaves.keys()))
        return tree

    @property
    def root(self) -> str:
        return self.nodes.get((), _EMPTY)

    # ---- copy-on-write update ------------------------------------------- #
    def apply(self, changes: Mapping[str, Optional[str]], depth: Optional[int] = None) -> "MerkleTree":
        """Return a new tree with *changes* applied (CoW).

        ``changes`` maps ``entity_id -> content_hash`` for upserts and
        ``entity_id -> None`` for removals (tombstone *projection*: a tombstone
        is still a live row with a tombstone content_hash, so callers pass the
        tombstone hash for "deleted but tracked", and ``None`` only to drop an
        entity from the tree entirely — used when squashing collapses a
        create+delete within one branch).

        Only buckets on the path to a changed entity are recomputed; every other
        subtree hash is shared by value with *self*.
        """
        d = self.depth if depth is None else depth
        if d != self.depth:  # pragma: no cover - guard against mismatched trees
            raise ValueError("cannot apply changes across differing tree depths")

        new_leaves: Dict[Path, Dict[str, str]] = dict(self.leaves)
        touched: set[Path] = set()
        for eid, chash in changes.items():
            path = _leaf_path(eid, d)
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

        new = MerkleTree(d, new_leaves, dict(self.nodes))
        new._recompute(touched)
        return new

    # ---- diffing (the projection index) --------------------------------- #
    def changed_leaf_paths(self, other: "MerkleTree") -> List[Path]:
        """Leaf paths whose hash differs between ``self`` and ``other``.

        Walks top-down and prunes any subtree whose hash matches — this is the
        ``O(changed · depth)`` projection-diff, not an ``O(N)`` scan.
        """
        out: List[Path] = []
        self._walk_diff((), other, out)
        return out

    def changed_entities(self, other: "MerkleTree") -> Dict[str, Tuple[Optional[str], Optional[str]]]:
        """Entities that differ, as ``{entity_id: (self_hash, other_hash)}``.

        ``self_hash``/``other_hash`` is ``None`` where the entity is absent on
        that side (added/removed).  Built only from buckets the Merkle walk
        flagged, so cost scales with the change set.
        """
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
        """Recompute leaf hashes for *touched_leaves* and all their ancestors."""
        dirty_by_level: Dict[int, set[Path]] = {}
        for leaf in touched_leaves:
            # leaf hash
            bucket = self.leaves.get(leaf)
            if bucket:
                self.nodes[leaf] = _leaf_hash(bucket)
            else:
                self.nodes.pop(leaf, None)
            for level in range(self.depth + 1):
                dirty_by_level.setdefault(level, set()).add(leaf[:level])

        # Recompute internal nodes bottom-up (deepest internal level first).
        for level in range(self.depth - 1, -1, -1):
            for prefix in dirty_by_level.get(level, ()):  # type: ignore[arg-type]
                child_hashes = [
                    self.nodes.get(prefix + (idx,), _EMPTY) for idx in range(_FANOUT)
                ]
                if all(h == _EMPTY for h in child_hashes):
                    self.nodes.pop(prefix, None)
                else:
                    self.nodes[prefix] = _hash(*(h.encode("ascii") for h in child_hashes))


# --------------------------------------------------------------------------- #
# Self-test (run directly: ``python backend/app/services/versioning/merkle.py``)
# --------------------------------------------------------------------------- #
def _selftest() -> None:
    import random

    # 1) Determinism + order-independence.
    ents = {f"e{i}": content_hash({"v": i}) for i in range(500)}
    t1 = MerkleTree.build(ents)
    items = list(ents.items())
    random.shuffle(items)
    t2 = MerkleTree.build(dict(items))
    assert t1.root == t2.root, "root must be order-independent"
    assert t1.root != _EMPTY

    # 2) Empty graph.
    empty = MerkleTree.build({})
    assert empty.root == _EMPTY
    assert empty.changed_entities(empty) == {}

    # 3) Single change → diff isolates exactly that entity.
    t3 = t1.apply({"e42": content_hash({"v": 999})})
    assert t3.root != t1.root
    diff = t1.changed_entities(t3)
    assert set(diff) == {"e42"}, f"expected only e42 to change, got {set(diff)}"

    # 4) CoW apply == full rebuild (root + entity equivalence).
    changes = {"e1": content_hash({"v": -1}), "newX": content_hash({"v": 7}), "e2": None}
    rebuilt_src = dict(ents)
    rebuilt_src["e1"] = content_hash({"v": -1})
    rebuilt_src["newX"] = content_hash({"v": 7})
    rebuilt_src.pop("e2")
    cow = t1.apply(changes)
    full = MerkleTree.build(rebuilt_src)
    assert cow.root == full.root, "CoW apply must match a full rebuild"

    # 5) add + remove reported correctly.
    d2 = t1.changed_entities(cow)
    assert d2["newX"] == (None, content_hash({"v": 7})), "added entity"
    assert d2["e2"][1] is None, "removed entity"
    assert "e1" in d2 and "e0" not in d2

    # 6) Identical large graphs → no diff, prune is cheap.
    big = {f"n{i}": content_hash({"i": i}) for i in range(5000)}
    b1 = MerkleTree.build(big)
    b2 = MerkleTree.build(dict(big))
    assert b1.changed_leaf_paths(b2) == [], "identical graphs must diff to nothing"
    b3 = b1.apply({"n2500": content_hash({"i": "changed"})})
    paths = b1.changed_leaf_paths(b3)
    assert len(paths) == 1, f"one changed entity should touch one leaf bucket, got {len(paths)}"

    # 7) Tombstone hash is distinct.
    assert content_hash(None) != content_hash({}) != content_hash({"a": 1})

    print("merkle.py self-test: OK")


if __name__ == "__main__":
    _selftest()
