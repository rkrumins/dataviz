"""Pure 3-way merge of a Context View's ``referenceLayout``, used when a draft
branch's view layout is promoted into the published base on merge/publish.

No DB / ORM / SQLAlchemy imports — pure dict logic, deterministic, and it never
mutates its inputs — so it is safe to unit-test in isolation (see
backend/tests/test_layout_promote.py) and to call from the promote path where
failure must self-heal rather than raise.

A ``referenceLayout`` is the canonical shape produced by
``backend.app.services.layout_config.parse_reference_layout``:

    {"layers":      [ {"id": ..., "name": ..., "order": ..., ...}, ... ],
     "assignments": { "<urn>": {"layerId": ..., "inheritsChildren": ..., ...} }}

The merge treats the layout as two independently keyed collections — the
``assignments`` map (keyed by urn) and the ``layers`` list (keyed by
``layer.id``) — and applies the same per-key 3-way rule to each:

    F = fork-point base   (snapshot when the draft was opened)
    P = current published  (may have moved since the fork)
    D = draft's effective  (F + draft edits)

Per key, comparing the value on each side (any side may be ABSENT):
  * draft untouched (D == F) -> take P: preserves published's own since-fork
    create/update/delete (P absent => the key stays deleted).
  * draft changed   (D != F) -> DRAFT WINS: take D (D absent => delete),
    whether or not published also moved (conflict resolves to the draft).

Layer order follows the DRAFT's array order for layers the draft has; any layer
that exists only on published-since-fork is appended at the end, and ``order``
is renumbered 0..n-1 on the final list. A final referential-integrity pass
drops any surviving assignment whose ``layerId`` is no longer a merged layer.

``merge_scope_3way`` (scalar ``entityScope``) and ``merge_display_rules_3way``
(the opaque, ordered ``displayRules`` array) apply the same draft-wins rule to
the referenceLayout's non-keyed side-fields and are kept separate so callers
compose them with ``merge_layout_3way`` — which, merging only the keyed
``layers``/``assignments`` collections, would otherwise drop ``displayRules``.
"""
from __future__ import annotations

import copy
from typing import Any

from backend.app.services.layout_config import parse_reference_layout

# Sentinel for "this key is present on no side" / "deleted on the winning side".
_ABSENT = object()


def _guard_bare_layout(layout: dict) -> dict:
    """Guard against a FULL view config being passed where a bare
    ``referenceLayout`` is expected.

    A bare referenceLayout carries ``layers``/``assignments`` at top level; a
    full view config instead nests them under ``layout.referenceLayout`` and
    carries ``content``/``layout`` wrappers. Without this guard a full config
    double-nests to ``{"layout": {"referenceLayout": {"layout": ...}}}`` and
    normalizes to EMPTY — so every published layer/assignment looks deleted and
    the merge silently WIPES the published layout. Auto-unwrap a recoverable
    ``layout.referenceLayout``; otherwise raise so the mistake is loud."""
    looks_like_full_config = "layout" in layout or "content" in layout
    is_bare_layout = "layers" in layout or "assignments" in layout
    if looks_like_full_config and not is_bare_layout:
        nested = layout.get("layout")
        if isinstance(nested, dict) and isinstance(nested.get("referenceLayout"), dict):
            return nested["referenceLayout"]
        raise ValueError(
            "merge_layout_3way expects a bare referenceLayout, got a full view config"
        )
    return layout


def _normalize(layout: Any) -> tuple[list[dict], dict[str, dict]]:
    """Up-convert a bare ``referenceLayout`` dict to ``(layers, assignments)``
    via the shared parser — the single source of truth for the
    entityAssignments / exact-rule up-convert semantics. Non-dict input (None,
    ``{}``, malformed) normalizes to empty rather than raising."""
    raw = layout if isinstance(layout, dict) else {}
    if raw:
        raw = _guard_bare_layout(raw)
    parsed = parse_reference_layout({"layout": {"referenceLayout": raw}})
    return parsed.layers, parsed.assignments


def _values_equal(a: Any, b: Any) -> bool:
    """Deep value equality where ``_ABSENT`` equals only ``_ABSENT``. Python
    ``==`` on dicts is key-order-insensitive and deep, which is exactly the
    assignment/layer entry semantics we need."""
    if a is _ABSENT or b is _ABSENT:
        return a is _ABSENT and b is _ABSENT
    return a == b


def _pick(f: Any, p: Any, d: Any) -> Any:
    """The per-key 3-way choice, returning the winning value or ``_ABSENT`` when
    the key resolves to deleted/absent. Draft untouched (``d == f``) yields the
    published value (its own since-fork change); draft changed yields the draft
    value (draft wins conflicts)."""
    if _values_equal(d, f):
        return p
    return d


def _layers_by_id(layers: list) -> dict:
    """Key a layer list by ``id`` (first occurrence wins on duplicate ids).
    Non-dict or id-less entries can't participate in a keyed merge and are
    dropped — canonical layers always carry an id."""
    out: dict = {}
    for layer in (layers if isinstance(layers, list) else []):
        if isinstance(layer, dict) and layer.get("id") is not None:
            out.setdefault(layer["id"], layer)
    return out


def _merge_layers(f_layers: list, p_layers: list, d_layers: list) -> list:
    """3-way merge the layer set (keyed by id), then order the survivors by the
    draft's array order, appending published-only layers, and renumber
    ``order`` 0..n-1."""
    f_by_id = _layers_by_id(f_layers)
    p_by_id = _layers_by_id(p_layers)
    d_by_id = _layers_by_id(d_layers)

    merged: dict = {}
    for lid in set(f_by_id) | set(p_by_id) | set(d_by_id):
        chosen = _pick(
            f_by_id.get(lid, _ABSENT), p_by_id.get(lid, _ABSENT), d_by_id.get(lid, _ABSENT)
        )
        if chosen is not _ABSENT:
            merged[lid] = copy.deepcopy(chosen)

    ordered: list = []
    emitted: set = set()

    def _emit_in_order(source_layers: list) -> None:
        for layer in (source_layers if isinstance(source_layers, list) else []):
            lid = layer.get("id") if isinstance(layer, dict) else None
            if lid in merged and lid not in emitted:
                ordered.append(merged[lid])
                emitted.add(lid)

    _emit_in_order(d_layers)  # draft array order first
    _emit_in_order(p_layers)  # then published-only survivors, appended
    # Safety net: any survivor unreachable via draft/published order (should be
    # empty for canonical inputs) — sorted for determinism.
    for lid in sorted((k for k in merged if k not in emitted), key=repr):
        ordered.append(merged[lid])
        emitted.add(lid)

    for index, layer in enumerate(ordered):
        if isinstance(layer, dict):
            layer["order"] = index
    return ordered


def _merge_assignments(f_map: dict, p_map: dict, d_map: dict) -> dict:
    """3-way merge the assignment map (keyed by urn). Keys iterated in sorted
    order for deterministic construction."""
    out: dict = {}
    for urn in sorted(set(f_map) | set(p_map) | set(d_map), key=repr):
        chosen = _pick(
            f_map.get(urn, _ABSENT), p_map.get(urn, _ABSENT), d_map.get(urn, _ABSENT)
        )
        if chosen is not _ABSENT:
            out[urn] = copy.deepcopy(chosen)
    return out


def _prune_orphan_assignments(assignments: dict, layers: list) -> dict:
    """Referential-integrity self-heal: drop any assignment whose ``layerId`` is
    not one of the merged layers (e.g. the draft deleted the layer but an
    assignment onto it survived on published). Never raises."""
    layer_ids = {layer.get("id") for layer in layers if isinstance(layer, dict)}
    return {
        urn: entry
        for urn, entry in assignments.items()
        if isinstance(entry, dict) and entry.get("layerId") in layer_ids
    }


def merge_layout_3way(fork_base: dict, published: dict, draft: dict) -> dict:
    """3-way merge a Context View's ``referenceLayout`` on branch merge/publish.

    ``fork_base`` (F): base referenceLayout snapshot when the draft was opened.
    ``published`` (P): CURRENT published base referenceLayout (may have moved
    since the fork).
    ``draft`` (D): the draft's effective referenceLayout (F + draft edits).
    Returns P' — the merged referenceLayout to write back to the published base.

    All three are canonical ``{layers: [...], assignments: {urn: {...}}}`` (or
    anything ``parse_reference_layout`` up-converts to that). Inputs are never
    mutated; the result is freshly owned.
    """
    f_layers, f_assign = _normalize(fork_base)
    p_layers, p_assign = _normalize(published)
    d_layers, d_assign = _normalize(draft)

    merged_layers = _merge_layers(f_layers, p_layers, d_layers)
    merged_assignments = _merge_assignments(f_assign, p_assign, d_assign)
    merged_assignments = _prune_orphan_assignments(merged_assignments, merged_layers)

    return {"layers": merged_layers, "assignments": merged_assignments}


def merge_scope_3way(fork_scope: str, published_scope: str, draft_scope: str) -> str:
    """3-way merge the scalar ``entityScope`` with the same draft-wins rule:
    the draft's value when the draft changed it, else the (possibly since-fork
    moved) published value."""
    if draft_scope != fork_scope:
        return draft_scope
    return published_scope


def _display_rules_of(layout: Any) -> list | None:
    """Extract the ``displayRules`` array from a bare ``referenceLayout``, or
    ``None`` when absent/malformed. Applies ``_guard_bare_layout`` so a full
    config accidentally passed here reads its nested displayRules rather than
    silently normalizing to none (the same wipe the guard prevents for
    layers/assignments)."""
    raw = layout if isinstance(layout, dict) else {}
    if raw:
        raw = _guard_bare_layout(raw)
    rules = raw.get("displayRules")
    return rules if isinstance(rules, list) else None


def merge_display_rules_3way(fork_base: dict, published: dict, draft: dict) -> list | None:
    """3-way merge a ``referenceLayout``'s ``displayRules`` — an opaque, ordered
    array of rule objects treated as ONE value — with the same draft-wins rule
    as ``merge_scope_3way``: the draft's array when the draft changed it vs the
    fork-point base, else the (possibly since-fork moved) published array.

    Kept separate from ``merge_layout_3way`` (which returns only the merged
    ``layers``/``assignments``) so the caller re-attaches the result and the
    promote never wipes displayRules. Returns the winning array, or ``None`` when
    it resolves to absent (the caller then writes no ``displayRules`` key)."""
    f = _display_rules_of(fork_base)
    p = _display_rules_of(published)
    d = _display_rules_of(draft)
    if d != f:
        return d
    return p
