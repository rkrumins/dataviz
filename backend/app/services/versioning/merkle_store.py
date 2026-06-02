"""Persisted copy-on-write Merkle tree (plan §2 #2, §16.5 #3).

Makes ``_merkle_root`` **incremental** for a linear branch: instead of rebuilding
the whole tree from full state every commit (O(graph)), a commit recomputes only
the buckets containing its changed entities and bubbles to the root
(O(changed · depth)), persisting **only the changed-path rows**. Unchanged
subtrees are inherited from earlier commits via the as-of index
``(graph_id, branch_id, path, commit_seq)``.

The in-memory hashing/bucketing lives in :mod:`merkle`; this module is the
Postgres-backed persistence + as-of reconstruction + tree-diff + integrity check.

Scope: used for a **non-fork graph's `main`** (the long-lived linear branch where
the full rebuild hurts at scale). Draft checkpoints and fork mains keep the
in-memory ``MerkleTree.build`` fallback (cross-branch CoW is a later step).
"""
from __future__ import annotations

from typing import Dict, Iterable, Optional, Tuple

from sqlalchemy import select

from . import config
from .merkle import _EMPTY, _FANOUT, _leaf_hash, _leaf_path
from .models import MerkleNodeORM

Path = Tuple[int, ...]


def _path_str(path: Path) -> str:
    return "/".join(f"{n:x}" for n in path)


def _parse_path(s: str) -> Path:
    return tuple(int(c, 16) for c in s.split("/")) if s else ()


class MerkleStore:
    def __init__(self, depth: Optional[int] = None):
        self._depth = config.MERKLE_DEPTH if depth is None else depth

    async def commit_tree(
        self, s, graph_id: str, branch_id: str, commit_id: str, commit_seq: int,
        changes: Dict[str, Optional[str]],
    ) -> str:
        """Incrementally build & persist the CoW tree for a commit; return the root.

        ``changes``: ``entity_id -> content_hash`` (upsert) or ``None`` (remove).
        Parent values are read as-of ``commit_seq - 1`` on this branch.
        """
        depth = self._depth
        if not changes:
            return await self.root_at(s, graph_id, branch_id, commit_seq - 1)

        by_leaf: Dict[Path, Dict[str, Optional[str]]] = {}
        for eid, ch in changes.items():
            by_leaf.setdefault(_leaf_path(eid, depth), {})[eid] = ch

        touched_leaves = set(by_leaf)
        dirty_internal: set = set()
        for lp in touched_leaves:
            for lvl in range(depth):
                dirty_internal.add(lp[:lvl])
        need: set = set(touched_leaves)
        for prefix in dirty_internal:
            for idx in range(_FANOUT):
                need.add(prefix + (idx,))
        parent = await self._as_of_many(s, graph_id, branch_id, need, commit_seq - 1)

        new_hash: Dict[Path, str] = {}
        new_bucket: Dict[Path, dict] = {}
        for lp, ch in by_leaf.items():
            prow = parent.get(lp)
            bucket = dict((prow.get("bucket") if prow else None) or {})
            for eid, h in ch.items():
                if h is None:
                    bucket.pop(eid, None)
                else:
                    bucket[eid] = h
            new_bucket[lp] = bucket
            new_hash[lp] = _leaf_hash(bucket) if bucket else _EMPTY

        for lvl in range(depth - 1, -1, -1):
            for prefix in [p for p in dirty_internal if len(p) == lvl]:
                child_hashes = []
                for idx in range(_FANOUT):
                    cp = prefix + (idx,)
                    if cp in new_hash:
                        child_hashes.append(new_hash[cp])
                    else:
                        row = parent.get(cp)
                        child_hashes.append(row["hash"] if row else _EMPTY)
                new_hash[prefix] = (
                    _EMPTY if all(h == _EMPTY for h in child_hashes)
                    else config.hash_parts(*(h.encode("ascii") for h in child_hashes))
                )

        for path, h in new_hash.items():
            prow = parent.get(path)
            if prow is not None and prow["hash"] == h:
                continue                       # unchanged subtree — inherit, write nothing
            s.add(MerkleNodeORM(
                graph_id=graph_id, branch_id=branch_id, commit_id=commit_id,
                commit_seq=commit_seq, path=_path_str(path), level=len(path), hash=h,
                bucket=(new_bucket.get(path) if len(path) == depth else None),
            ))
        return new_hash.get((), _EMPTY)

    async def root_at(self, s, graph_id: str, branch_id: str, seq: int) -> str:
        if seq < 1:
            return _EMPTY
        row = (await s.execute(
            select(MerkleNodeORM.hash).where(
                MerkleNodeORM.graph_id == graph_id, MerkleNodeORM.branch_id == branch_id,
                MerkleNodeORM.path == "", MerkleNodeORM.commit_seq <= seq,
            ).order_by(MerkleNodeORM.commit_seq.desc()).limit(1)
        )).scalar_one_or_none()
        return row or _EMPTY

    async def diff(self, s, graph_id: str, branch_id: str, seq_m: int, seq_n: int) -> Dict[str, Tuple]:
        """Entities that differ between two commits — top-down walk, pruning equal
        subtrees → ``{entity_id: (hash_at_m, hash_at_n)}``."""
        out: Dict[str, Tuple] = {}
        await self._walk(s, graph_id, branch_id, (), seq_m, seq_n, out)
        return out

    async def verify(self, s, graph_id: str, branch_id: str, seq: int, live: Dict[str, str]) -> bool:
        """Integrity check: the persisted root at ``seq`` equals a tree freshly
        built from ``live`` (``{entity_id: content_hash}``)."""
        from .merkle import MerkleTree
        return await self.root_at(s, graph_id, branch_id, seq) == MerkleTree.build(live, self._depth).root

    # ---- internals -------------------------------------------------------- #
    async def _as_of_many(self, s, graph_id, branch_id, paths: Iterable[Path], seq: int) -> Dict[Path, dict]:
        path_list = list(paths)
        if not path_list or seq < 1:
            return {}
        rows = (await s.execute(
            select(MerkleNodeORM.path, MerkleNodeORM.hash, MerkleNodeORM.bucket).where(
                MerkleNodeORM.graph_id == graph_id, MerkleNodeORM.branch_id == branch_id,
                MerkleNodeORM.path.in_([_path_str(p) for p in path_list]),
                MerkleNodeORM.commit_seq <= seq,
            ).order_by(MerkleNodeORM.path, MerkleNodeORM.commit_seq.desc()).distinct(MerkleNodeORM.path)
        )).all()
        return {_parse_path(p): {"hash": h, "bucket": b} for p, h, b in rows}

    async def _walk(self, s, graph_id, branch_id, prefix: Path, m: int, n: int, out: Dict[str, Tuple]) -> None:
        hm = (await self._as_of_many(s, graph_id, branch_id, {prefix}, m)).get(prefix)
        hn = (await self._as_of_many(s, graph_id, branch_id, {prefix}, n)).get(prefix)
        hmh = hm["hash"] if hm else _EMPTY
        hnh = hn["hash"] if hn else _EMPTY
        if hmh == hnh:
            return
        if len(prefix) == self._depth:
            bm = (hm.get("bucket") if hm else None) or {}
            bn = (hn.get("bucket") if hn else None) or {}
            for eid in set(bm) | set(bn):
                if bm.get(eid) != bn.get(eid):
                    out[eid] = (bm.get(eid), bn.get(eid))
            return
        for idx in range(_FANOUT):
            await self._walk(s, graph_id, branch_id, prefix + (idx,), m, n, out)
