"""Type-aware field-level 3-way merge — one engine, four uses.

Reused for (plan §8): (1) MVP same-branch conflict resolve, (2) draft pull/rebase
when ``main`` advances, (3) draft→main squash, (4) fork PR→base.

Strategies (plan §16.5 #5) — a generic "field-level" merge that treated nested
objects/arrays atomically would destroy them, so we dispatch by shape:

* **scalar** — standard 3-way: identical change → keep; one-sided change → take it;
  divergent change → conflict.  (Field removal is modelled as a change to the
  :data:`MISSING` sentinel, so delete/modify falls out of the same rules.)
* **object (dict)** — *recursive* 3-way, so editing different keys of the same
  nested object auto-merges.
* **set (list, opt-in via ``set_fields``)** — commutative 3-way set union/removal
  (e.g. ``tags``): adds from either side applied, removals from either side
  applied, never conflicts.
* **other arrays** — treated as an opaque scalar (safe: divergent edits conflict
  rather than silently corrupting order).

Entity-level create/delete is handled before field merge, including the
**delete/modify** conflict.  Cross-entity referential integrity (an edge whose
endpoint the other side tombstoned — invisible to per-entity merge, plan §16.5 #8)
is :func:`find_dangling_edges`.

Pure stdlib — no DB / FalkorDB / app imports.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Mapping, Optional, Tuple

__all__ = [
    "MISSING",
    "Conflict",
    "MergeOutcome",
    "three_way_merge",
    "find_dangling_edges",
]


class _Missing:
    """Sentinel for "key absent on this side" (distinct from a ``None`` value)."""

    _instance: "Optional[_Missing]" = None

    def __new__(cls) -> "_Missing":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "MISSING"


MISSING = _Missing()

Path = Tuple[str, ...]


@dataclass(frozen=True)
class Conflict:
    """A divergent change both sides made that the engine cannot auto-resolve."""

    path: Path                 # () = whole-entity (e.g. delete/modify); else field path
    base: Any
    ours: Any
    theirs: Any
    kind: str = "field"        # "field" | "delete/modify"


@dataclass
class MergeOutcome:
    """Result of a merge: the tentatively-merged value + any conflicts.

    ``merged`` is always populated with a best-effort resolution (ours-biased on
    a hard conflict) so the UI has something to render; ``conflicts`` is the
    authoritative list the user must resolve before the merge may be committed.
    """

    merged: Optional[Dict[str, Any]]
    conflicts: List[Conflict] = field(default_factory=list)

    @property
    def has_conflicts(self) -> bool:
        return bool(self.conflicts)


# --------------------------------------------------------------------------- #
# Entity-level merge                                                           #
# --------------------------------------------------------------------------- #
def three_way_merge(
    base: Optional[Mapping[str, Any]],
    ours: Optional[Mapping[str, Any]],
    theirs: Optional[Mapping[str, Any]],
    set_fields: FrozenSet[str] = frozenset(),
) -> MergeOutcome:
    """3-way merge one entity. ``None`` means absent/tombstoned on that side."""
    # ── entity-level create/delete ──────────────────────────────────────
    if ours is None and theirs is None:
        return MergeOutcome(None, [])

    if ours is None or theirs is None:
        present = theirs if ours is None else ours
        if base is None:
            # One side created it, the other never had it → take the creation.
            return MergeOutcome(dict(present), [])
        if present == base:
            # The surviving side didn't touch it → honour the deletion.
            return MergeOutcome(None, [])
        # delete on one side, modify on the other → conflict (keep the modified
        # side tentatively so the user can choose).
        return MergeOutcome(
            dict(present),
            [Conflict((), dict(base), _orNone(ours), _orNone(theirs), kind="delete/modify")],
        )

    # ── both present → recursive field merge ────────────────────────────
    merged, conflicts = _merge_fields(base or {}, ours, theirs, set_fields, ())
    return MergeOutcome(merged, conflicts)


def _merge_fields(
    base: Mapping[str, Any],
    ours: Mapping[str, Any],
    theirs: Mapping[str, Any],
    set_fields: FrozenSet[str],
    path: Path,
) -> Tuple[Dict[str, Any], List[Conflict]]:
    result: Dict[str, Any] = {}
    conflicts: List[Conflict] = []
    for key in sorted(set(base) | set(ours) | set(theirs)):
        bv = base.get(key, MISSING)
        ov = ours.get(key, MISSING)
        tv = theirs.get(key, MISSING)
        value, confs = _merge_value(bv, ov, tv, key in set_fields, set_fields, path + (key,))
        conflicts.extend(confs)
        if value is not MISSING:
            result[key] = value
    return result, conflicts


def _merge_value(
    bv: Any, ov: Any, tv: Any, is_set: bool, set_fields: FrozenSet[str], path: Path
) -> Tuple[Any, List[Conflict]]:
    if ov == tv:
        return ov, []            # identical on both sides (incl. both removed)
    if ov == bv:
        return tv, []            # only theirs changed
    if tv == bv:
        return ov, []            # only ours changed

    # Both sides changed, differently.
    if is_set:
        return _merge_set(bv, ov, tv), []

    if isinstance(ov, dict) and isinstance(tv, dict) and (isinstance(bv, dict) or bv is MISSING):
        base_d = bv if isinstance(bv, dict) else {}
        merged, confs = _merge_fields(base_d, ov, tv, set_fields, path)
        return merged, confs

    # Opaque scalar / array divergence → conflict (ours-biased tentative value).
    return ov, [Conflict(path, _orNone(bv), _orNone(ov), _orNone(tv))]


def _merge_set(bv: Any, ov: Any, tv: Any) -> List[Any]:
    """Commutative 3-way set merge for unordered collections (e.g. tags)."""
    b = set(bv) if isinstance(bv, list) else set()
    o = set(ov) if isinstance(ov, list) else set()
    t = set(tv) if isinstance(tv, list) else set()
    added = (o - b) | (t - b)
    removed = (b - o) | (b - t)
    return sorted((b | added) - removed, key=lambda x: (str(type(x)), str(x)))


def _orNone(v: Any) -> Any:
    return None if v is MISSING else v


# --------------------------------------------------------------------------- #
# Referential integrity (cross-entity — plan §16.5 #8)                         #
# --------------------------------------------------------------------------- #
def find_dangling_edges(
    live_node_ids: "set[str]", edges: Mapping[str, Tuple[str, str]]
) -> List[str]:
    """Edge ids whose source or target is not a live node in the merged state.

    The per-entity 3-way merge structurally cannot catch "main added edge E→N
    while the draft tombstoned N" — E and N are *different* entities.  Run this
    over the merged result (``live_node_ids`` = nodes that survive, i.e. exclude
    tombstones) to surface those as conflicts before publish.
    """
    dangling: List[str] = []
    for edge_id, (src, tgt) in edges.items():
        if src not in live_node_ids or tgt not in live_node_ids:
            dangling.append(edge_id)
    return dangling


# --------------------------------------------------------------------------- #
# Self-test (run directly: ``python backend/app/services/versioning/merge.py``)
# --------------------------------------------------------------------------- #
def _selftest() -> None:
    # 1) Non-overlapping field edits auto-merge.
    out = three_way_merge({"a": 1, "b": 2}, {"a": 1, "b": 2, "c": 3}, {"a": 1, "b": 9})
    assert out.merged == {"a": 1, "b": 9, "c": 3} and not out.has_conflicts, out

    # 2) Same field, divergent change → conflict.
    out = three_way_merge({"a": 1}, {"a": 2}, {"a": 3})
    assert out.has_conflicts and out.conflicts[0].path == ("a",), out
    assert (out.conflicts[0].base, out.conflicts[0].ours, out.conflicts[0].theirs) == (1, 2, 3)

    # 3) Same field, identical change → no conflict.
    assert not three_way_merge({"a": 1}, {"a": 2}, {"a": 2}).has_conflicts

    # 4) One-sided change wins.
    assert three_way_merge({"a": 1}, {"a": 1}, {"a": 2}).merged == {"a": 2}

    # 5) Field removed on one side, untouched on other → removed.
    out = three_way_merge({"a": 1, "b": 2}, {"a": 1}, {"a": 1, "b": 2})
    assert out.merged == {"a": 1} and not out.has_conflicts, out

    # 6) Field removed vs modified → conflict.
    out = three_way_merge({"b": 2}, {}, {"b": 5})
    assert out.has_conflicts and out.conflicts[0].path == ("b",), out

    # 7) Nested object: different keys edited → recursive auto-merge.
    out = three_way_merge(
        {"p": {"x": 1, "y": 1}}, {"p": {"x": 2, "y": 1}}, {"p": {"x": 1, "y": 3}}
    )
    assert out.merged == {"p": {"x": 2, "y": 3}} and not out.has_conflicts, out

    # 8) Set field (tags): union of adds, honour removals, no conflict.
    out = three_way_merge(
        {"tags": ["a", "b"]}, {"tags": ["a", "b", "c"]}, {"tags": ["a", "d"]},
        set_fields=frozenset({"tags"}),
    )
    assert out.merged == {"tags": ["a", "c", "d"]} and not out.has_conflicts, out

    # 9) Entity-level: both deleted → gone; delete vs unchanged → gone.
    assert three_way_merge({"a": 1}, None, None).merged is None
    assert three_way_merge({"a": 1}, None, {"a": 1}).merged is None

    # 10) Entity-level delete vs modify → conflict, keeps modified side tentatively.
    out = three_way_merge({"a": 1}, None, {"a": 2})
    assert out.has_conflicts and out.conflicts[0].kind == "delete/modify"
    assert out.merged == {"a": 2}, out

    # 11) Both created identically vs divergently.
    assert not three_way_merge(None, {"a": 1}, {"a": 1}).has_conflicts
    assert three_way_merge(None, {"a": 1}, {"a": 2}).has_conflicts

    # 12) Referential integrity: edge to a tombstoned node is dangling.
    dangling = find_dangling_edges({"n1", "n2"}, {"e1": ("n1", "n2"), "e2": ("n1", "n3")})
    assert dangling == ["e2"], dangling

    print("merge.py self-test: OK")


if __name__ == "__main__":
    _selftest()
