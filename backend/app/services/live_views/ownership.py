"""Who owns which entry of a view made from a query — kept through every write.

A view's members are the server's (``view_members``): whether each is in, and whether it
cascades (``inheritsChildren``), follow the data. People own where a member sits (its
layer, order and group), and every entry they placed themselves — the only entries a
view's config holds. A canvas save sends the whole layout as the client last saw it, and
the canvas writes an entry for a member it moves (rewriting its marker and cascade flag),
so without this a save would turn members into people's entries, or keep stale copies of
ones that left.

``reconcile_layout_write`` puts each write right: an entry for a member is a move — its
placement recorded as an override (so every update keeps it) and applied to the member at
once — and is never stored; anything else carrying the server's marker is a stale echo,
and is dropped. A draft keeps its moves of members as entries of its own (marked as the
server's), remembered when it is published (``reconcile_promote``).
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
    #: Where people put members, to remember (``membership.overrides``).
    overrides: Dict[str, dict] = field(default_factory=dict)
    #: Members this write moved: their placement now (assignment-shaped), for their rows.
    moves: Dict[str, dict] = field(default_factory=dict)


def _fallback(layer_ids: Sequence[str], fallback_layer_id: Optional[str]) -> Optional[str]:
    return fallback_layer_id if fallback_layer_id in layer_ids else (layer_ids[0] if layer_ids else None)


def _placed(entry: dict, layers: Set[str], fallback: Optional[str]) -> dict:
    """``entry``, or — its layer gone — the same in the fallback layer."""
    if entry.get("layerId") in layers or fallback is None:
        return entry
    entry = {k: v for k, v in entry.items() if k not in ("orderKey", "logicalNodeId")}
    entry["layerId"] = fallback
    return entry


def _placement(entry: Mapping) -> dict:
    return {k: entry.get(k) for k in PLACEMENT_KEYS if entry.get(k) is not None}


def _moved(placed: Mapping, sent: Mapping) -> Optional[dict]:
    """``placed``'s placement with what ``sent`` changes of it, or None when it changes nothing."""
    changed = {k: sent.get(k) for k in PLACEMENT_KEYS if k in sent and sent.get(k) != placed.get(k)}
    if not changed:
        return None
    out = _placement(placed)
    for key, value in changed.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


def reconcile_layout_write(
    stored: Mapping[str, dict],
    incoming: Mapping[str, dict],
    *,
    members: Mapping[str, dict],
    layer_ids: Sequence[str],
    fallback_layer_id: Optional[str],
    record_overrides: bool,
    now: str = "",
) -> Reconciled:
    """The assignments a layout write stores, given what is stored, what the client sent
    and ``members`` — where each member among those URNs sits (assignment-shaped, from one
    read of the member table). ``record_overrides`` is off for a draft's own layout: it
    keeps its moves of members as entries of its own, remembered when it is published,
    not before."""
    layers = set(layer_ids)
    fallback = _fallback(layer_ids, fallback_layer_id)
    own = {u for u, e in stored.items() if isinstance(e, Mapping) and not is_machine(e)}
    out: Dict[str, dict] = {}
    result = Reconciled(assignments=out)
    for urn, sent in incoming.items():
        if urn in members and urn not in own:
            # A member the canvas moved, or sent back as it is.
            if not isinstance(sent, Mapping):
                continue
            member = members[urn]
            if record_overrides:
                placed = _moved(member, sent)
                if placed is not None:
                    placed = _placed(placed, layers, fallback)
                    result.moves[urn] = placed
                    result.overrides[urn] = {**placed, "at": now}
                continue
            prior = stored.get(urn)
            base = prior if is_machine(prior) else member
            placed = _moved(base, sent) or _placement(base)
            if _moved(member, placed) is not None:
                out[urn] = {**_placed(placed, layers, fallback), "assignedBy": MACHINE,
                            "inheritsChildren": member.get("inheritsChildren") is True}
            continue
        if is_machine(sent):
            continue                # a stale echo of a member that left, or one made up
        out[urn] = sent
    if not record_overrides:
        # A draft's moves the client did not send back are still its own.
        for urn, entry in stored.items():
            if urn not in incoming and urn in members and is_machine(entry):
                out[urn] = entry
    return result


def reconcile_promote(
    merged: Mapping[str, dict],
    *,
    fork: Mapping[str, dict],
    draft: Mapping[str, dict],
    members: Mapping[str, dict],
    layer_ids: Sequence[str],
    fallback_layer_id: Optional[str],
    now: str = "",
) -> Reconciled:
    """After a draft's layout is merged into the published one: the members are the
    member table's (the data moved on while the draft was open), and the draft's moves
    of them — its entries marked as the server's, other than copies taken when it opened
    — are remembered and applied. Its entries for members that left are dropped;
    everything people placed by hand is theirs."""
    layers = set(layer_ids)
    fallback = _fallback(layer_ids, fallback_layer_id)
    out: Dict[str, dict] = {u: e for u, e in merged.items() if not is_machine(e)}
    result = Reconciled(assignments=out)
    for urn, drafted in draft.items():
        if urn in out or urn not in members or not is_machine(drafted):
            continue
        forked = fork.get(urn)
        if is_machine(forked) and _moved(forked, drafted) is None:
            continue                # a copy from when the draft opened, never moved
        placed = _moved(members[urn], drafted)
        if placed is None:
            continue
        placed = _placed(placed, layers, fallback)
        result.moves[urn] = placed
        result.overrides[urn] = {**placed, "at": now}
    return result


def take_members(config: dict) -> Dict[str, dict]:
    """Take the server's entries out of a config and return them. Members live in
    ``view_members``, never in a config — but a file or a version from before they did
    carries them as entries. Edits ``config`` in place."""
    layout = config.get("layout") if isinstance(config, dict) else None
    ref = layout.get("referenceLayout") if isinstance(layout, dict) else None
    entries = ref.get("assignments") if isinstance(ref, dict) else None
    if not isinstance(entries, dict):
        return {}
    taken = machine_entries(entries)
    for urn in taken:
        entries.pop(urn)
    return taken


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
    members: Mapping[str, dict],
    layer_ids: Sequence[str],
    now: str = "",
) -> Tuple[Dict[str, dict], List[str], List[str]]:
    """``(assignments, exclude, gone)`` after keeping entities out, bringing them back,
    always including them, or stopping — ``gone``: members to take out of the member
    table at once. ``members``: where each member among ``ops.include`` sits.

    * exclude — out of the view whatever the query finds (and any entry dropped);
    * unexclude — the query decides again (it is back at the next update);
    * include — always in the view, in the layer given: a member becomes the person's
      own, keeping its place; a new one is placed by hand;
    * uninclude — no longer placed by hand (a query result comes back at the next
      update, as the server's)."""
    layers = set(layer_ids)
    out = dict(assignments)
    gone: List[str] = []
    left_out = list(dict.fromkeys(exclude))
    for urn in ops.exclude:
        out.pop(urn, None)
        gone.append(urn)
        if urn not in left_out:
            left_out.append(urn)
    if len(left_out) > EXCLUDE_MAX:
        raise MemberOpError(f"A view can keep out at most {EXCLUDE_MAX:,} entities.")
    back = set(ops.unexclude)
    left_out = [u for u in left_out if u not in back]
    for item in ops.include:
        if item.layer_id not in layers:
            raise MemberOpError("That layer is not in this view any more.")
        prev = out.get(item.urn) or members.get(item.urn)
        if isinstance(prev, Mapping):
            entry = {k: v for k, v in prev.items() if k != "assignedBy"}
            entry["assignedBy"] = "user"
            if prev.get("layerId") != item.layer_id:
                entry = {k: v for k, v in entry.items() if k not in ("orderKey", "logicalNodeId")}
                entry["layerId"] = item.layer_id
        else:
            entry = {"layerId": item.layer_id, "inheritsChildren": True, "assignedBy": "user", "assignedAt": now}
        out[item.urn] = entry
        if item.urn in members:
            gone.append(item.urn)
        left_out = [u for u in left_out if u != item.urn]
    for urn in ops.uninclude:
        if isinstance(out.get(urn), Mapping) and not is_machine(out[urn]):
            out.pop(urn)
    return out, left_out, list(dict.fromkeys(gone))


def layer_ids_of(reference_layout: Mapping) -> List[str]:
    return [
        layer["id"] for layer in (reference_layout.get("layers") or [])
        if isinstance(layer, Mapping) and isinstance(layer.get("id"), str)
    ]


def carry_into_config(new_config: dict) -> bool:
    """A view's design replaced wholesale (a version restored, a file imported over it)
    brings no members — they are data, not design, and the view keeps its own. Any it
    carries as entries (from before members had a table) are taken out. Returns True
    when the view is kept up to date: the caller marks it pending, so its members are
    worked out again in the new layers. Edits ``new_config`` in place."""
    from backend.common.models.view_membership import read_definition

    take_members(new_config)
    definition = read_definition(new_config)
    if definition is None or definition.mode != "live":
        return False
    content = new_config.get("content")
    if not isinstance(content, dict):
        content = new_config["content"] = {}
    content["entityScope"] = "curated"
    return True
