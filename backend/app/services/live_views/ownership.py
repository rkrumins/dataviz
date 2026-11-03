"""Who owns which entry of a view made from a query — kept through every write.

The server owns whether each ``assignedBy: "query"`` entry exists and whether it
cascades (``inheritsChildren``): those follow the data. People own where an entry
sits (its layer, order and group), and every entry they placed themselves. A
canvas save sends the whole layout as the client last saw it, so without this a
save would drop members that arrived since, or bring back ones that left; and the
canvas rewrites the marker and the cascade flag on any entry it moves.

``reconcile_layout_write`` puts each write right: the server's entries are kept
(and only their placement taken from the client — recorded as overrides, so the
next update keeps it), stale echoes of entries the server dropped are discarded,
and anything the client invents with the server's marker is ignored.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

from backend.common.models.view_membership import (
    EXCLUDE_MAX,
    MACHINE,
    OVERRIDES_MAX,
    MemberOps,
)

PLACEMENT_KEYS = ("layerId", "orderKey", "logicalNodeId")


def is_machine(entry: Optional[Mapping]) -> bool:
    return isinstance(entry, Mapping) and entry.get("assignedBy") == MACHINE


def machine_entries(assignments: Mapping[str, dict]) -> Dict[str, dict]:
    return {u: e for u, e in assignments.items() if is_machine(e)}


@dataclass
class Reconciled:
    assignments: Dict[str, dict]
    #: Where people put the server's entries, to remember (``membership.overrides``).
    overrides: Dict[str, dict] = field(default_factory=dict)
    #: An entry lost its layer and sits in the fallback until it is placed again.
    replace_needed: bool = False


def _placed(entry: dict, layers: Set[str], fallback: Optional[str]) -> Tuple[dict, bool]:
    if entry.get("layerId") in layers or fallback is None:
        return entry, False
    entry = {k: v for k, v in entry.items() if k not in ("orderKey", "logicalNodeId")}
    entry["layerId"] = fallback
    return entry, True


def reconcile_layout_write(
    stored: Mapping[str, dict],
    incoming: Mapping[str, dict],
    *,
    layer_ids: Sequence[str],
    fallback_layer_id: Optional[str],
    record_overrides: bool,
    now: str = "",
) -> Reconciled:
    """The assignments a layout write stores, given what is stored and what the
    client sent. ``record_overrides`` is off for a draft's own layout (a draft's
    choices are remembered when it is published, not before)."""
    layers = set(layer_ids)
    fallback = fallback_layer_id if fallback_layer_id in layers else (layer_ids[0] if layer_ids else None)
    machine = machine_entries(stored)
    out: Dict[str, dict] = {
        u: e for u, e in incoming.items()
        if u not in machine and not is_machine(e)
    }
    result = Reconciled(assignments=out)
    for urn, kept in machine.items():
        sent = incoming.get(urn)
        entry = dict(kept)
        if isinstance(sent, Mapping):
            moved = {k: sent.get(k) for k in PLACEMENT_KEYS if k in sent and sent.get(k) != kept.get(k)}
            for key, value in moved.items():
                if value is None:
                    entry.pop(key, None)
                else:
                    entry[key] = value
            if moved and record_overrides:
                result.overrides[urn] = {**{k: entry.get(k) for k in PLACEMENT_KEYS if entry.get(k)}, "at": now}
        entry["assignedBy"] = MACHINE
        entry["inheritsChildren"] = kept.get("inheritsChildren") is True
        entry, lost = _placed(entry, layers, fallback)
        result.replace_needed |= lost
        out[urn] = entry
    return result


def reconcile_promote(
    merged: Mapping[str, dict],
    *,
    fork: Mapping[str, dict],
    published: Mapping[str, dict],
    draft: Mapping[str, dict],
    layer_ids: Sequence[str],
    fallback_layer_id: Optional[str],
    now: str = "",
) -> Reconciled:
    """After a draft's layout is merged into the published one: the published view's
    server entries are the truth (the data moved on while the draft was open), the
    draft's moves of them are kept and remembered, and its stale copies of entries
    the server has since dropped are discarded."""
    layers = set(layer_ids)
    fallback = fallback_layer_id if fallback_layer_id in layers else (layer_ids[0] if layer_ids else None)
    authority = machine_entries(published)
    out: Dict[str, dict] = {u: e for u, e in merged.items() if not is_machine(e) or u in authority}
    result = Reconciled(assignments=out)
    for urn, truth in authority.items():
        if urn in out and not is_machine(out[urn]):
            continue                         # the draft placed it by hand: theirs now
        entry = dict(out.get(urn) or truth)
        drafted, forked = draft.get(urn), fork.get(urn)
        if isinstance(drafted, Mapping) and isinstance(forked, Mapping):
            moved = {k: drafted.get(k) for k in PLACEMENT_KEYS if drafted.get(k) != forked.get(k)}
            if moved:
                for key, value in moved.items():
                    if value is None:
                        entry.pop(key, None)
                    else:
                        entry[key] = value
                result.overrides[urn] = {**{k: entry.get(k) for k in PLACEMENT_KEYS if entry.get(k)}, "at": now}
        entry["assignedBy"] = MACHINE
        entry["inheritsChildren"] = truth.get("inheritsChildren") is True
        entry, lost = _placed(entry, layers, fallback)
        result.replace_needed |= lost
        out[urn] = entry
    return result


def carry_machine_entries(
    new: Mapping[str, dict],
    old: Mapping[str, dict],
    *,
    layer_ids: Sequence[str],
    fallback_layer_id: Optional[str],
) -> Reconciled:
    """A view's design replaced wholesale (a version restored, a file imported over
    it) brings no members — they are data, not design. Keep the ones it had until
    the next update, in the new layers where they fit."""
    layers = set(layer_ids)
    fallback = fallback_layer_id if fallback_layer_id in layers else (layer_ids[0] if layer_ids else None)
    out: Dict[str, dict] = {u: e for u, e in new.items() if not is_machine(e)}
    result = Reconciled(assignments=out)
    for urn, entry in machine_entries(old).items():
        if urn in out:
            continue
        entry, lost = _placed(dict(entry), layers, fallback)
        result.replace_needed |= lost
        out[urn] = entry
    return result


def remember(overrides: Mapping[str, dict], new: Mapping[str, dict]) -> Dict[str, dict]:
    """``overrides`` with ``new`` recorded, the oldest forgotten past the limit."""
    merged = {**overrides, **new}
    if len(merged) <= OVERRIDES_MAX:
        return merged
    ranked = sorted(merged.items(), key=lambda kv: str((kv[1] or {}).get("at") or ""))
    return dict(ranked[-OVERRIDES_MAX:])


class MemberOpError(ValueError):
    """A member operation that cannot be applied, said in words."""


def apply_member_ops(
    assignments: Mapping[str, dict],
    exclude: Sequence[str],
    ops: MemberOps,
    *,
    layer_ids: Sequence[str],
    now: str = "",
) -> Tuple[Dict[str, dict], List[str]]:
    """``(assignments, exclude)`` after keeping entities out, bringing them back,
    always including them, or stopping.

    * exclude — out of the view whatever the query finds (and any entry dropped);
    * unexclude — the query decides again (it is back at the next update);
    * include — always in the view, in the layer given: a server entry becomes the
      person's own, keeping its place; a new one is placed by hand;
    * uninclude — no longer placed by hand (a query result comes back at the next
      update, as the server's)."""
    layers = set(layer_ids)
    out = dict(assignments)
    left_out = list(dict.fromkeys(exclude))
    for urn in ops.exclude:
        out.pop(urn, None)
        if urn not in left_out:
            left_out.append(urn)
    if len(left_out) > EXCLUDE_MAX:
        raise MemberOpError(f"A view can keep out at most {EXCLUDE_MAX:,} entities.")
    gone = set(ops.unexclude)
    left_out = [u for u in left_out if u not in gone]
    for item in ops.include:
        if item.layer_id not in layers:
            raise MemberOpError("That layer is not in this view any more.")
        prev = out.get(item.urn)
        if isinstance(prev, Mapping):
            entry = {k: v for k, v in prev.items() if k != "assignedBy"}
            entry["assignedBy"] = "user"
            if prev.get("layerId") != item.layer_id:
                entry = {k: v for k, v in entry.items() if k not in ("orderKey", "logicalNodeId")}
                entry["layerId"] = item.layer_id
        else:
            entry = {"layerId": item.layer_id, "inheritsChildren": True, "assignedBy": "user", "assignedAt": now}
        out[item.urn] = entry
        left_out = [u for u in left_out if u != item.urn]
    for urn in ops.uninclude:
        if isinstance(out.get(urn), Mapping) and not is_machine(out[urn]):
            out.pop(urn)
    return out, left_out
