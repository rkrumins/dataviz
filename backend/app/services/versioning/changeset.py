"""Squash & diff engine — pure functions over materialised entity states.

This is the logic the commit/checkpoint/publish/PR services build on, factored
out so it is unit-testable without a database:

* :func:`materialize` — fold an ordered list of working-change ops onto a base
  state to get a branch's head state.  A ``create`` payload is the full entity; an
  ``update`` payload is a PATCH (see ``backend.common.property_patch``): top-level
  fields replace, ``properties`` merges, a removal marker removes; ``delete``
  tombstones.
* :func:`fold_batch_ops` — the same composition for ONE batch of ops before it is
  applied (several ops on one entity become one), shared with ``apply_ops``.
* :func:`net_delta` — the **squash**: per-entity create/update/delete between a
  base state and a head state, content-hash-deduped so a no-op edit produces no
  delta (a 1M-edit draft that nets to 300 changes squashes to 300 rows).
* :func:`diff_states` / :func:`field_diff` — commit-to-commit (or vs-live) diff
  with field-level granularity for blame/history UIs (plan §7).

A "state" is ``{entity_id: payload | None}`` where ``None`` is a tombstone.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional, Set, Tuple

try:
    from .merkle import content_hash
    from backend.common.property_patch import apply_patch, compose_patches, strip_deletes
except ImportError:  # script mode
    import pathlib
    import sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[4]))
    from merkle import content_hash  # type: ignore
    from backend.common.property_patch import apply_patch, compose_patches, strip_deletes

__all__ = [
    "Delta",
    "BatchFold",
    "fold_batch_ops",
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
    PATCH applied onto the entity's current value: fields it doesn't mention
    (urn, displayName, qualifiedName, …) are preserved, ``properties`` merges key
    by key — a partial properties patch keeps the properties it doesn't name —
    and a property marked for removal is removed. Full-payload callers are
    unaffected: every field is present in the merge.
    """
    state: State = dict(base_state)
    for op in ops:
        eid = op["entity_id"]
        payload = op.get("payload")
        if op["op"] == "delete" or payload is None:
            state[eid] = None
        elif op["op"] == "update" and isinstance(state.get(eid), dict):
            state[eid] = apply_patch(state[eid], payload)
        else:                                                # create → full replace
            state[eid] = strip_deletes(dict(payload))
    return state


@dataclass
class BatchFold:
    """One batch of ops folded to at most one pending value per entity."""

    #: entity → pending value: a full payload (create / update-after-create), a
    #: PATCH (``update_ids``), or ``None`` (delete).
    new_vals: Dict[str, Optional[dict]] = field(default_factory=dict)
    kind_by_entity: Dict[str, str] = field(default_factory=dict)
    #: entities whose pending value is a PATCH still to be applied onto the current value.
    update_ids: Set[str] = field(default_factory=set)
    #: entity → the client's optimistic-concurrency token (the first update's).
    base_versions: Dict[str, str] = field(default_factory=dict)


def fold_batch_ops(
    ops: List[Mapping],
    *,
    is_edge_payload: Callable[[Mapping], bool],
    sanitize_node: Callable[[dict], dict],
) -> BatchFold:
    """Compose a batch's ops per entity, in order.

    An update after a create patches the create's payload (a node renamed before
    its first save); two updates compose into one patch that keeps both
    removals; a create or delete restarts the entity. A create never carries a
    removal marker.
    """
    out = BatchFold()
    for op in ops:
        eid = op["entity_id"]
        payload = op.get("payload") or {}
        out.kind_by_entity[eid] = (op.get("entity_kind")
                                   or ("edge" if is_edge_payload(payload) else "node"))
        earlier = out.new_vals.get(eid)
        if op["op"] == "update" and earlier is not None:
            out.new_vals[eid] = (compose_patches(earlier, payload) if eid in out.update_ids
                                 else apply_patch(earlier, payload))
        else:
            if op["op"] == "delete":
                out.new_vals[eid] = None
            elif op["op"] == "update":
                out.new_vals[eid] = dict(payload)
            else:
                out.new_vals[eid] = strip_deletes(dict(payload))
            if op["op"] == "update":
                out.update_ids.add(eid)
                if op.get("base_version"):
                    out.base_versions[eid] = op["base_version"]
            else:
                out.update_ids.discard(eid)          # a create / delete restarts the entity
        if out.new_vals[eid] is not None and out.kind_by_entity[eid] == "node":
            out.new_vals[eid] = sanitize_node(out.new_vals[eid])
    return out


def net_delta(base_state: Mapping[str, Optional[dict]], head_state: Mapping[str, Optional[dict]]) -> List[Delta]:
    """Per-entity net change from *base_state* to *head_state* (the squash).

    Content-hash-deduped: entities whose payload is unchanged produce no Delta,
    so a draft that creates then reverts an entity contributes nothing.
    """
    deltas: List[Delta] = []
    for eid in sorted(set(base_state) | set(head_state)):
        b = base_state.get(eid)
        h = head_state.get(eid)
        # A degenerate EMPTY payload ({}) is not a live entity (no urn/entityType/endpoints) — treat
        # it as a tombstone, never an update/create, so a merge that collapses an entity to {} (e.g. a
        # both-sides-delete-all-fields field merge, or a client that encoded "accept deletion" as {})
        # is DELETED, not persisted as a live identity-less node that fails GraphNode validation on
        # read. This is the universal write chokepoint, backstopping every state-building path.
        b_live = bool(b)
        h_live = bool(h)
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
