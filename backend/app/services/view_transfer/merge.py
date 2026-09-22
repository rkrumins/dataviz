"""Updating an existing view from a file: where the two sides stand, and how to combine them.

Versions are content-addressed and a file carries the hashes of every version in its history,
so finding the last design both sides agreed on (the merge base) is a set intersection:
the newest version of the target view whose hash appears in the file's history.

From there, the relationship between the file and the view here is one of:

* ``up_to_date``: the view here already has exactly the file's design;
* ``file_is_older``: the file holds a design this view has already moved past; importing it
  rolls the view back;
* ``fast_forward``: the view here hasn't changed since the base, so taking the file loses
  nothing here;
* ``diverged``: both sides changed since the base. Replace takes the file; Merge keeps what
  changed here and lets the file win where both changed;
* ``unrelated``: no common version (e.g. overwriting a view that never came from this file's
  lineage). Only Replace is possible.

Merge reuses the draft-promote 3-way merge for the layout (``layout_promote``), with the file in
the draft role, and applies the same draft-wins rule, key by key, to everything else.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.app.services.versioning.layout_promote import (
    merge_default_sort_3way,
    merge_display_rules_3way,
    merge_layout_3way,
    merge_scope_3way,
)
from backend.app.services.view_transfer.references import reference_layout

UP_TO_DATE = "up_to_date"
FILE_IS_OLDER = "file_is_older"
FAST_FORWARD = "fast_forward"
DIVERGED = "diverged"
UNRELATED = "unrelated"

_ABSENT = object()


@dataclass
class UpdateStatus:
    status: str
    base_version: Optional[int] = None
    base_hash: Optional[str] = None


def update_status(
    *,
    incoming_hash: str,
    incoming_history_hashes: Sequence[str],
    target_working_hash: str,
    target_versions: Sequence[Tuple],
) -> UpdateStatus:
    """Classify the file against the target view.

    ``target_versions`` are the target's history, in any order, as ``(version, hash)`` or
    ``(version, hash, origin_hash)``. ``origin_hash`` is set on an import version that stored
    something other than its file (``ViewVersionORM.origin_hash``): that version also answers
    to the file's hash, and because what it stored differs from the file, the difference (the
    choices made on import) counts as a change made here.
    """
    if incoming_hash == target_working_hash:
        return UpdateStatus(UP_TO_DATE)
    newest_first = sorted(target_versions, key=lambda v: v[0], reverse=True)

    def answers_to(v: Tuple) -> List[str]:
        return [h for h in (v[1], v[2] if len(v) > 2 else None) if h]

    for position, v in enumerate(newest_first):
        if incoming_hash in answers_to(v):
            if incoming_hash != v[1] and position == 0 and v[1] == target_working_hash:
                # This very file was imported here last, and nothing has changed since.
                return UpdateStatus(UP_TO_DATE, v[0], incoming_hash)
            return UpdateStatus(FILE_IS_OLDER, v[0], incoming_hash)
    known = set(incoming_history_hashes)
    for v in newest_first:
        for hash_ in answers_to(v):
            if hash_ in known:
                if hash_ == target_working_hash:
                    return UpdateStatus(FAST_FORWARD, v[0], hash_)
                return UpdateStatus(DIVERGED, v[0], hash_)
    return UpdateStatus(UNRELATED)


@dataclass
class MergeResult:
    definition: dict
    conflicts: List[str] = field(default_factory=list)


def _layers_by_id(layout: dict) -> Dict[Any, Any]:
    return {layer.get("id"): layer for layer in layout.get("layers") or []
            if isinstance(layer, dict) and layer.get("id") is not None}


def _keyed_conflicts(base: dict, ours: dict, theirs: dict, prefix: str) -> List[str]:
    """Keys changed on BOTH sides, differently: where the file's value wins over ours."""
    out = []
    for key in sorted(set(base) | set(ours) | set(theirs), key=repr):
        b, o, t = base.get(key, _ABSENT), ours.get(key, _ABSENT), theirs.get(key, _ABSENT)
        if o != b and t != b and o != t:
            out.append(f"{prefix}.{key}")
    return out


def _merge_value(base: Any, ours: Any, theirs: Any, path: str, conflicts: List[str]) -> Any:
    """Draft-wins 3-way on one value; dicts merge key by key, anything else is atomic."""
    if theirs == base:
        return ours
    if ours == base or ours == theirs:
        return theirs
    if isinstance(base, dict) and isinstance(ours, dict) and isinstance(theirs, dict):
        merged: Dict[str, Any] = {}
        for key in sorted(set(base) | set(ours) | set(theirs)):
            value = _merge_value(base.get(key, _ABSENT), ours.get(key, _ABSENT),
                                 theirs.get(key, _ABSENT), f"{path}.{key}" if path else key, conflicts)
            if value is not _ABSENT:
                merged[key] = value
        return merged
    conflicts.append(path or "(definition)")
    return theirs


def merge_definitions(base: dict, ours: dict, theirs: dict) -> MergeResult:
    """Combine ``theirs`` (the file) into ``ours`` (the view here) against ``base``.

    The file wins wherever both sides changed the same thing; everything only one side
    changed is kept. Never mutates its inputs.
    """
    conflicts: List[str] = []
    rl_base = reference_layout(base) or {}
    rl_ours = reference_layout(ours) or {}
    rl_theirs = reference_layout(theirs) or {}

    def _without_rl(definition: dict) -> dict:
        out = copy.deepcopy(definition)
        layout = out.get("layout")
        if isinstance(layout, dict):
            layout.pop("referenceLayout", None)
        content = out.get("content")
        if isinstance(content, dict):
            content.pop("entityScope", None)
        return out

    merged = _merge_value(_without_rl(base), _without_rl(ours), _without_rl(theirs), "", conflicts)
    if merged is _ABSENT or not isinstance(merged, dict):
        merged = {}

    if rl_base or rl_ours or rl_theirs:
        merged_rl = merge_layout_3way(rl_base, rl_ours, rl_theirs)
        rules = merge_display_rules_3way(rl_base, rl_ours, rl_theirs)
        if rules is not None:
            merged_rl["displayRules"] = rules
        default_sort = merge_default_sort_3way(rl_base, rl_ours, rl_theirs)
        if default_sort is not None:
            merged_rl["defaultNodeSortMode"] = default_sort
        # Side fields the layout merge doesn't know about still merge, key by key.
        known = {"layers", "assignments", "displayRules", "defaultNodeSortMode"}
        extra_keys = (set(rl_base) | set(rl_ours) | set(rl_theirs)) - known
        for key in sorted(extra_keys):
            value = _merge_value(rl_base.get(key, _ABSENT), rl_ours.get(key, _ABSENT),
                                 rl_theirs.get(key, _ABSENT), f"layout.referenceLayout.{key}", conflicts)
            if value is not _ABSENT:
                merged_rl[key] = value
        conflicts += _keyed_conflicts(_layers_by_id(rl_base), _layers_by_id(rl_ours),
                                      _layers_by_id(rl_theirs), "layers")
        conflicts += _keyed_conflicts(rl_base.get("assignments") or {}, rl_ours.get("assignments") or {},
                                      rl_theirs.get("assignments") or {}, "assignments")
        layout = merged.get("layout") if isinstance(merged.get("layout"), dict) else {}
        layout["referenceLayout"] = merged_rl
        merged["layout"] = layout

    scope = merge_scope_3way(
        (base.get("content") or {}).get("entityScope"),
        (ours.get("content") or {}).get("entityScope"),
        (theirs.get("content") or {}).get("entityScope"),
    )
    content = merged.get("content") if isinstance(merged.get("content"), dict) else {}
    if scope is not None:
        content["entityScope"] = scope
    merged["content"] = content
    return MergeResult(definition=merged, conflicts=conflicts)
