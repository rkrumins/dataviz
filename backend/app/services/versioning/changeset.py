"""Squash & diff engine — pure functions over materialised entity states.

This is the logic the commit/checkpoint/publish/PR services build on, factored
out so it is unit-testable without a database:

* :func:`materialize` — fold an ordered list of working-change ops onto a base
  state to get a branch's head state.  A working-change ``payload`` is the *full*
  entity payload at that edit (the client stages the whole optimistic state, plan
  decision #10), so create/update both replace and delete tombstones.
* :func:`net_delta` — the **squash**: per-entity create/update/delete between a
  base state and a head state, content-hash-deduped so a no-op edit produces no
  delta (a 1M-edit draft that nets to 300 changes squashes to 300 rows).
* :func:`diff_states` / :func:`field_diff` — commit-to-commit (or vs-live) diff
  with field-level granularity for blame/history UIs (plan §7).

A "state" is ``{entity_id: payload | None}`` where ``None`` is a tombstone.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Tuple

try:
    from .merkle import content_hash
except ImportError:  # script mode
    from merkle import content_hash  # type: ignore

__all__ = [
    "Delta",
    "materialize",
    "net_delta",
    "field_diff",
    "diff_states",
]

State = Dict[str, Optional[dict]]


@dataclass(frozen=True)
class Delta:
    """One entity's net change in a squash/diff."""

    entity_id: str
    op: str                       # create | update | delete
    payload: Optional[dict]       # new payload (None for delete)
    prev_content_hash: Optional[str]
    content_hash: str


def materialize(base_state: Mapping[str, Optional[dict]], ops: List[Mapping]) -> State:
    """Apply ordered working-change *ops* onto *base_state* → head state.

    Each op is ``{"entity_id", "op", "payload"}``.  ``delete`` sets a tombstone
    (``None``).  A ``create`` replaces the entity wholesale; an ``update`` is a
    field-level PATCH — its payload is merged onto the entity's current value so
    fields it doesn't mention (urn, displayName, qualifiedName, …) are preserved.
    (The canvas sends partial update payloads — only the edited fields — so a
    wholesale replace here would silently strip the rest and surface as blank
    names + lost properties once a publish/merge projects the truncated entity.
    Full-payload callers are unaffected: every field is present in the merge.)
    """
    state: State = dict(base_state)
    for op in ops:
        eid = op["entity_id"]
        payload = op.get("payload")
        if op["op"] == "delete" or payload is None:
            state[eid] = None
        elif op["op"] == "update" and isinstance(state.get(eid), dict):
            state[eid] = {**state[eid], **dict(payload)}     # PATCH: merge onto current
        else:                                                # create → full replace
            state[eid] = dict(payload)
    return state


def net_delta(base_state: Mapping[str, Optional[dict]], head_state: Mapping[str, Optional[dict]]) -> List[Delta]:
    """Per-entity net change from *base_state* to *head_state* (the squash).

    Content-hash-deduped: entities whose payload is unchanged produce no Delta,
    so a draft that creates then reverts an entity contributes nothing.
    """
    deltas: List[Delta] = []
    for eid in sorted(set(base_state) | set(head_state)):
        b = base_state.get(eid)
        h = head_state.get(eid)
        b_live = b is not None
        h_live = h is not None
        if not b_live and not h_live:
            continue                            # never existed / created+deleted
        if h_live and not b_live:
            deltas.append(Delta(eid, "create", dict(h), None, content_hash(h)))
        elif b_live and not h_live:
            deltas.append(
                Delta(eid, "delete", None, content_hash(b), content_hash(None))
            )
        else:
            bh, hh = content_hash(b), content_hash(h)
            if bh != hh:
                deltas.append(Delta(eid, "update", dict(h), bh, hh))
    return deltas


def field_diff(old: Optional[dict], new: Optional[dict]) -> Dict[str, Tuple]:
    """Field-level diff ``{field: (old_value, new_value)}`` (missing → absent)."""
    o = old or {}
    n = new or {}
    out: Dict[str, Tuple] = {}
    for key in sorted(set(o) | set(n)):
        if o.get(key) != n.get(key):
            out[key] = (o.get(key), n.get(key))
    return out


def diff_states(a: Mapping[str, Optional[dict]], b: Mapping[str, Optional[dict]]) -> Dict[str, object]:
    """Diff two materialised states (e.g. commit M vs commit N, or N vs live).

    Returns ``{"added": [...], "removed": [...], "modified": {eid: field_diff}}``.
    """
    added: List[str] = []
    removed: List[str] = []
    modified: Dict[str, Dict[str, Tuple]] = {}
    for delta in net_delta(a, b):
        if delta.op == "create":
            added.append(delta.entity_id)
        elif delta.op == "delete":
            removed.append(delta.entity_id)
        else:
            modified[delta.entity_id] = field_diff(a.get(delta.entity_id), b.get(delta.entity_id))
    return {"added": added, "removed": removed, "modified": modified}


def _selftest() -> None:
    base: State = {"a": {"name": "A"}, "b": {"name": "B"}}

    # materialize: ops collapse, last-write-wins, create+delete → tombstone.
    head = materialize(
        base,
        [
            {"entity_id": "b", "op": "update", "payload": {"name": "B2"}},
            {"entity_id": "c", "op": "create", "payload": {"name": "C"}},
            {"entity_id": "c", "op": "update", "payload": {"name": "C2"}},
            {"entity_id": "a", "op": "delete", "payload": None},
            {"entity_id": "d", "op": "create", "payload": {"name": "D"}},
            {"entity_id": "d", "op": "delete", "payload": None},
        ],
    )
    assert head == {"a": None, "b": {"name": "B2"}, "c": {"name": "C2"}, "d": None}

    # net_delta squash: a deleted, b updated, c created; d (create+delete) drops out.
    deltas = {d.entity_id: d for d in net_delta(base, head)}
    assert set(deltas) == {"a", "b", "c"}, set(deltas)
    assert deltas["a"].op == "delete"
    assert deltas["b"].op == "update"
    assert deltas["c"].op == "create"

    # No-op edit (set same value) → no delta.
    head2 = materialize(base, [{"entity_id": "a", "op": "update", "payload": {"name": "A"}}])
    assert net_delta(base, head2) == []

    # field_diff.
    assert field_diff({"x": 1, "y": 2}, {"x": 1, "y": 3, "z": 4}) == {
        "y": (2, 3),
        "z": (None, 4),
    }

    # diff_states (commit M vs N).
    d = diff_states(base, head)
    assert d["added"] == ["c"] and d["removed"] == ["a"] and set(d["modified"]) == {"b"}
    assert d["modified"]["b"] == {"name": ("B", "B2")}

    print("changeset.py self-test: OK")


if __name__ == "__main__":
    _selftest()
