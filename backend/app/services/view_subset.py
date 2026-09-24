"""The config of a SUBSET view, built from its source view's config.

A subset is an ordinary curated Context View: the source's layers, groups and
display settings, holding only the entities picked for it. What makes it a
subset is what it is BUILT from — this module — and the provenance link the
endpoint stores (``views.derived_from_view_id``).

Pure: no I/O, no session. ``build_subset_config`` takes the source's full
config dict (whatever ``json.loads(ViewORM.config)`` returns) and returns the
new view's full config dict, or raises ``SubsetConfigError`` when the picks do
not fit the source (a layer or group that is not there) — which the endpoint
answers with 422, because it means the source changed under the builder.

Three things it must get right, each of which a naive copy gets wrong:

* EXACT-URN RULES ARE ASSIGNMENTS IN DISGUISE. ``layout_config._normalize``
  (and its frontend mirror) turns a layer or group rule whose ``urnPattern``
  names one urn into an assignment on every read — but leaves the rule on the
  layer. Copying the source's layers verbatim would put every entity such a
  rule names back into the subset, picked or not. They are stripped; glob
  rules stay (a curated view never places by them).
* THE SCOPE IS STAMPED ``curated``. A subset holds what was picked and nothing
  else; left to inference, a subset of an open view would resolve by its
  layers' type rules and hold everything again.
* NOTHING OF THE SOURCE'S MEMBERSHIP LEAKS THROUGH. The assignment map is
  rebuilt from the picks alone, a column's anchor survives only if the anchor
  itself was kept, groups nobody was picked into are dropped, and the source's
  ``rootUrns`` (a search-scope widening) is not carried over.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

from backend.app.services.layout_config import (
    _is_exact_urn_pattern,
    _resolve_raw_layout,
    parse_reference_layout,
    sanitize_node_ordering,
)


class SubsetConfigError(ValueError):
    """The picks do not fit the source view (it changed, or the client is
    wrong). Answered with 422 and this message."""


@dataclass(frozen=True)
class SubsetMember:
    urn: str
    layer_id: str
    logical_node_id: Optional[str] = None
    inherits_children: bool = True


def _without_exact_rules(rules: Any) -> Any:
    if not isinstance(rules, list):
        return rules
    return [
        rule for rule in rules
        if not (isinstance(rule, dict) and _is_exact_urn_pattern(rule.get("urnPattern")))
    ]


def _group_ids(nodes: Any) -> Set[str]:
    out: Set[str] = set()
    for node in nodes if isinstance(nodes, list) else []:
        if isinstance(node, dict):
            if node.get("id"):
                out.add(str(node["id"]))
            out |= _group_ids(node.get("children"))
    return out


def _prune_groups(nodes: Any, keep: Set[str]) -> List[dict]:
    """The group tree with only the groups in ``keep`` and their ancestors,
    each stripped of exact-urn rules. A group survives if it or anything
    below it is kept."""
    out: List[dict] = []
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        children = _prune_groups(node.get("children"), keep)
        if node.get("id") in keep or children:
            pruned = {k: v for k, v in node.items() if k not in ("children", "rules")}
            if "rules" in node:
                pruned["rules"] = _without_exact_rules(node.get("rules"))
            if "children" in node:
                pruned["children"] = children
            out.append(pruned)
    return out


def _dedupe(members: Iterable[SubsetMember]) -> List[SubsetMember]:
    seen: Dict[str, SubsetMember] = {}
    for member in members:
        seen.setdefault(member.urn, member)
    return list(seen.values())


def build_subset_config(
    source_config: Mapping[str, Any],
    members: Sequence[SubsetMember],
    *,
    connectivity: Mapping[str, Any],
    now: str,
) -> Dict[str, Any]:
    """The new view's full config. See the module docstring."""
    members = _dedupe(members)
    if not members:
        raise SubsetConfigError("a subset keeps at least one entity")

    source = copy.deepcopy(dict(source_config or {}))
    layout = parse_reference_layout(source)
    layers_by_id = {
        str(layer["id"]): layer for layer in layout.layers
        if isinstance(layer, dict) and layer.get("id")
    }

    # Every pick must land somewhere the source actually has.
    groups_by_layer = {lid: _group_ids(layer.get("logicalNodes")) for lid, layer in layers_by_id.items()}
    for member in members:
        if member.layer_id not in layers_by_id:
            raise SubsetConfigError(
                f"the source view has no layer {member.layer_id!r} (for {member.urn}) — "
                "its layers changed; reopen it and pick again"
            )
        if member.logical_node_id and member.logical_node_id not in groups_by_layer[member.layer_id]:
            raise SubsetConfigError(
                f"layer {member.layer_id!r} has no group {member.logical_node_id!r} (for {member.urn}) — "
                "the source view's groups changed; reopen it and pick again"
            )

    kept_layer_ids = {m.layer_id for m in members}
    inheriting = {m.urn for m in members if m.inherits_children}
    groups_kept: Dict[str, Set[str]] = {}
    for member in members:
        if member.logical_node_id:
            groups_kept.setdefault(member.layer_id, set()).add(member.logical_node_id)

    layers: List[dict] = []
    for layer in layout.layers:
        if not isinstance(layer, dict) or str(layer.get("id")) not in kept_layer_ids:
            continue
        lid = str(layer["id"])
        kept = {k: v for k, v in layer.items() if k not in ("rules", "logicalNodes", "anchorUrn")}
        if "rules" in layer:
            kept["rules"] = _without_exact_rules(layer.get("rules"))
        if "logicalNodes" in layer:
            kept["logicalNodes"] = _prune_groups(layer.get("logicalNodes"), groups_kept.get(lid, set()))
        anchor = layer.get("anchorUrn")
        if anchor and anchor in inheriting:
            kept["anchorUrn"] = anchor
        layers.append(kept)

    assignments: Dict[str, dict] = {}
    for member in members:
        entry: Dict[str, Any] = {
            "layerId": member.layer_id,
            "inheritsChildren": bool(member.inherits_children),
            "assignedBy": "user",
            "assignedAt": now,
        }
        if member.logical_node_id:
            entry["logicalNodeId"] = member.logical_node_id
        prior = layout.assignments.get(member.urn)
        if (
            isinstance(prior, dict)
            and prior.get("layerId") == member.layer_id
            and isinstance(prior.get("orderKey"), str)
        ):
            entry["orderKey"] = prior["orderKey"]
        assignments[member.urn] = entry

    raw = _resolve_raw_layout(source)
    reference_layout: Dict[str, Any] = {"layers": layers, "assignments": assignments}
    for key in ("displayRules", "defaultNodeSortMode"):
        if key in raw:
            reference_layout[key] = copy.deepcopy(raw[key])
    reference_layout = sanitize_node_ordering(reference_layout)

    out = source
    out.pop("referenceLayout", None)           # the legacy top-level spelling
    layout_block = out.get("layout") if isinstance(out.get("layout"), dict) else {}
    layout_block = dict(layout_block)
    layout_block["type"] = "reference"
    layout_block["referenceLayout"] = reference_layout
    out["layout"] = layout_block

    content = out.get("content") if isinstance(out.get("content"), dict) else {}
    content = {k: v for k, v in content.items() if k != "rootUrns"}
    content["entityScope"] = "curated"
    content["connectivity"] = {
        "mode": connectivity.get("mode", "bridged"),
        "maxHops": int(connectivity.get("maxHops", 10)),
    }
    out["content"] = content
    return out
