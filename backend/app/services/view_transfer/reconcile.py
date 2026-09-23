"""Reconcile a view against a target graph: what matched, what didn't, and how much.

Pure and deterministic. The identity lookups (``provider.resolve_identities``), the target's
types and the environment's policy are passed in, so this is testable without a graph and
the same function answers the wizard's preview and the import's final record.

Every URN the view names ends in exactly one state:

* ``matched``: it exists here, as the same type;
* ``renamed``: it exists here as the same type, under a different name (still a match);
* ``type_changed``: it exists here, but as a different type (layers that place by type may put
  it somewhere else);
* ``missing``: looked for, and not here;
* ``unknown``: the lookup failed. Never counted as missing: a flaky connection must not read as
  a broken view, so the score is taken over what could actually be checked.
"""
from __future__ import annotations

import difflib
from collections.abc import Hashable
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set

from backend.app.services.view_transfer.references import collect, reference_layout

MATCHED = "matched"
RENAMED = "renamed"
TYPE_CHANGED = "type_changed"
MISSING = "missing"
UNKNOWN = "unknown"

READY = "ready"
ATTENTION = "attention"
BLOCKED = "blocked"

#: At or above this share of checked entities found, with no missing types, a view is ready.
READY_THRESHOLD = 0.95
#: A view naming at least this many entities, none of which exist here, is almost certainly
#: pointed at the wrong graph.
WRONG_GRAPH_MIN_REFS = 20
#: Exceptions listed per view. Counts are always exact; only the list is capped.
MAX_EXCEPTIONS = 20_000

_STATUS_ORDER = {MISSING: 0, UNKNOWN: 1, TYPE_CHANGED: 2, RENAMED: 3, MATCHED: 4}


@dataclass
class TargetTypes:
    """The target's entity and relationship types, id → label. None fields mean "unknown"."""
    entity: Optional[Dict[str, str]] = None
    relationship: Optional[Dict[str, str]] = None


@dataclass
class Policy:
    """What this environment allows, where it changes what an import can keep."""
    view_type_allowed: bool = True
    node_sorting_enabled: bool = True


@dataclass
class _Counts:
    total: int = 0
    matched: int = 0
    renamed: int = 0
    type_changed: int = 0
    missing: int = 0
    unknown: int = 0

    def add(self, status: str) -> None:
        self.total += 1
        setattr(self, status, getattr(self, status) + 1)

    @property
    def found(self) -> int:
        return self.matched + self.renamed + self.type_changed

    @property
    def checked(self) -> int:
        return self.total - self.unknown

    def as_dict(self) -> Dict[str, Any]:
        return {
            "total": self.total, "matched": self.matched, "renamed": self.renamed,
            "typeChanged": self.type_changed, "missing": self.missing, "unknown": self.unknown,
            "found": self.found, "checked": self.checked,
            "matchRate": (self.found / self.checked) if self.checked else None,
        }


def _same(a: Optional[str], b: Optional[str]) -> bool:
    return (a or "").casefold() == (b or "").casefold()


def _status(urn: str, exported: Optional[dict], lookup: Dict[str, Optional[dict]]) -> str:
    if urn not in lookup:
        return UNKNOWN
    target = lookup[urn]
    if target is None:
        return MISSING
    if exported:
        # Type ids are compared without case: the graph spells a label the way its source did,
        # which is not always the ontology's declared casing.
        if exported.get("type") and target.get("type") and not _same(exported["type"], target["type"]):
            return TYPE_CHANGED
        if exported.get("name") and target.get("name") and exported["name"] != target["name"]:
            return RENAMED
    return MATCHED


def suggest_types(missing: str, known: Dict[str, str], limit: int = 3) -> List[str]:
    """Likely equivalents of a missing type id: a case-only difference first, then the closest
    ids and labels."""
    exact = [tid for tid in known if tid.casefold() == missing.casefold()]
    if exact:
        return exact[:limit]
    by_key: Dict[str, str] = {}
    for tid, label in known.items():
        by_key.setdefault(tid.casefold(), tid)
        if label:
            by_key.setdefault(label.casefold(), tid)
    close = difflib.get_close_matches(missing.casefold(), list(by_key), n=limit * 2, cutoff=0.6)
    out: List[str] = []
    for key in close:
        tid = by_key[key]
        if tid not in out:
            out.append(tid)
    return out[:limit]


def _type_report(referenced: Set[str], known: Optional[Dict[str, str]],
                 layers_using: Dict[str, List[str]]) -> List[Dict[str, Any]]:
    out = []
    for tid in sorted(referenced):
        if known is None:
            status, suggestions = UNKNOWN, []
        elif tid in known:
            status, suggestions = "present", []
        else:
            status, suggestions = MISSING, suggest_types(tid, known)
        out.append({"id": tid, "status": status, "suggestions": suggestions,
                    "layers": layers_using.get(tid, [])})
    return out


def _has_ordering(definition: Any) -> int:
    """How many node-ordering settings the definition carries (what a disabled node-sorting
    switch would strip on write)."""
    rl = reference_layout(definition) or {}
    count = 1 if rl.get("defaultNodeSortMode") else 0
    count += sum(1 for layer in rl.get("layers") or [] if isinstance(layer, dict) and "nodeSortMode" in layer)
    assignments = rl.get("assignments")
    if isinstance(assignments, dict):
        count += sum(1 for entry in assignments.values() if isinstance(entry, dict) and "orderKey" in entry)
    return count


def reconcile_view(
    definition: Any,
    *,
    exported: Dict[str, Dict[str, Any]],
    lookup: Dict[str, Optional[dict]],
    types: TargetTypes,
    policy: Policy,
    entities_resolved_at_export: bool = True,
) -> Dict[str, Any]:
    """The reconciliation report for one view. See the module docstring for the states."""
    refs = collect(definition)
    rl = reference_layout(definition) or {}
    assignments = rl.get("assignments") if isinstance(rl.get("assignments"), dict) else {}
    layers = [layer for layer in rl.get("layers") or [] if isinstance(layer, dict)]

    overall = _Counts()
    by_kind: Dict[str, _Counts] = {}
    statuses: Dict[str, str] = {}
    exceptions: List[Dict[str, Any]] = []
    for urn in sorted(refs.urns):
        status = _status(urn, exported.get(urn), lookup)
        statuses[urn] = status
        overall.add(status)
        for kind in refs.urns[urn]:
            by_kind.setdefault(kind, _Counts()).add(status)
        if status != MATCHED:
            entry = assignments.get(urn) if isinstance(assignments.get(urn), dict) else None
            target = lookup.get(urn)
            exceptions.append({
                "urn": urn,
                "status": status,
                "kinds": sorted(refs.urns[urn]),
                "layerId": entry.get("layerId") if entry else None,
                "exported": exported.get(urn),
                "target": target if isinstance(target, dict) else None,
            })
    exceptions.sort(key=lambda e: (_STATUS_ORDER[e["status"]], e["urn"]))

    layers_using: Dict[str, List[str]] = {}
    for layer in layers:
        for tid in layer.get("entityTypes") or []:
            if isinstance(tid, str):
                layers_using.setdefault(tid, []).append(layer.get("name") or layer.get("id"))
    entity_types = _type_report(refs.entity_types, types.entity, layers_using)
    relationship_types = _type_report(refs.relationship_types, types.relationship, {})
    missing_entity_types = sum(1 for t in entity_types if t["status"] == MISSING)
    missing_relationship_types = sum(1 for t in relationship_types if t["status"] == MISSING)

    # One pass over the assignments, not one per layer: 30 layers × 250,000 placements took seconds.
    by_layer: Dict[Any, _Counts] = {}
    for urn, entry in assignments.items():
        layer_id = entry.get("layerId") if isinstance(entry, dict) else None
        if isinstance(entry, dict) and isinstance(layer_id, Hashable):
            by_layer.setdefault(layer_id, _Counts()).add(statuses.get(urn, UNKNOWN))
    layer_rows = []
    healthy = 0
    for layer in layers:
        layer_id = layer.get("id")
        counts = (by_layer.get(layer_id) if isinstance(layer_id, Hashable) else None) or _Counts()
        anchor_urn = layer.get("anchorUrn") if isinstance(layer.get("anchorUrn"), str) else None
        anchor = {"urn": anchor_urn, "status": statuses.get(anchor_urn, UNKNOWN)} if anchor_urn else None
        ok = counts.missing == 0 and counts.unknown == 0 and (anchor is None or anchor["status"] != MISSING)
        healthy += 1 if ok else 0
        layer_rows.append({
            "id": layer.get("id"), "name": layer.get("name"), "color": layer.get("color"),
            **{k: v for k, v in counts.as_dict().items() if k != "matchRate"},
            "anchor": anchor,
            "healthy": ok,
        })

    notices: List[Dict[str, Any]] = []
    if not policy.view_type_allowed:
        notices.append({"code": "view_type_disabled", "severity": "error",
                        "message": "This kind of view isn't enabled in this environment."})
    ordering = _has_ordering(definition)
    if ordering and not policy.node_sorting_enabled:
        notices.append({"code": "node_sorting_disabled", "severity": "warning", "count": ordering,
                        "message": "Node sorting is turned off here, so the view's custom node "
                                   "order won't be kept."})
    if types.entity is None:
        notices.append({"code": "ontology_unavailable", "severity": "warning",
                        "message": "This data source's semantic layer couldn't be read, so entity "
                                   "and relationship types weren't checked."})
    if refs.urn_patterns:
        notices.append({"code": "urn_patterns", "severity": "info", "count": len(refs.urn_patterns),
                        "message": "Some rules match entities by URN pattern. They'll apply to "
                                   "whatever matches here; they can't be checked in advance."})
    if not entities_resolved_at_export:
        notices.append({"code": "names_unavailable", "severity": "info",
                        "message": "The exporting environment couldn't name its entities, so "
                                   "entities that aren't found here are shown by URN."})
    if overall.unknown:
        notices.append({"code": "unchecked", "severity": "warning", "count": overall.unknown,
                        "message": "Some entities couldn't be checked because the data source "
                                   "didn't answer. They are not counted as missing; retry to "
                                   "check them."})

    summary = overall.as_dict()
    match_rate = summary["matchRate"]
    if not policy.view_type_allowed:
        verdict, reason = BLOCKED, "This kind of view isn't enabled here."
    elif overall.checked >= WRONG_GRAPH_MIN_REFS and overall.found == 0:
        verdict, reason = BLOCKED, (
            f"None of the {overall.checked:,} entities this view places exist in this data source. "
            "It looks like a different graph.")
    elif (match_rate is None or match_rate >= READY_THRESHOLD) and not missing_entity_types \
            and not missing_relationship_types and not overall.unknown:
        verdict, reason = READY, "Everything this view needs is here." if not overall.missing else (
            f"{overall.missing:,} of {overall.total:,} entities aren't here; they'll be kept, "
            "marked as not found.")
    else:
        verdict, reason = ATTENTION, _attention_reason(overall, missing_entity_types,
                                                      missing_relationship_types)

    return {
        "summary": {
            "entities": summary,
            "byKind": {kind: counts.as_dict() for kind, counts in sorted(by_kind.items())},
            "entityTypes": {"total": len(entity_types), "missing": missing_entity_types},
            "relationshipTypes": {"total": len(relationship_types), "missing": missing_relationship_types},
            "layers": {"total": len(layers), "healthy": healthy},
            "displayRules": len(rl.get("displayRules") or []) if isinstance(rl.get("displayRules"), list) else 0,
            "urnPatterns": len(refs.urn_patterns),
            "matchRate": match_rate,
            "coverage": (overall.checked / overall.total) if overall.total else 1.0,
            "verdict": verdict,
            "verdictReason": reason,
        },
        "entities": exceptions[:MAX_EXCEPTIONS],
        "entitiesTruncated": len(exceptions) > MAX_EXCEPTIONS,
        "types": {"entity": entity_types, "relationship": relationship_types},
        "layers": layer_rows,
        "notices": notices,
    }


def _attention_reason(overall: _Counts, missing_types: int, missing_rel_types: int) -> str:
    parts = []
    if overall.missing:
        parts.append(f"{overall.missing:,} of {overall.total:,} entities aren't here")
    if overall.type_changed:
        parts.append(f"{overall.type_changed:,} are a different type here")
    if missing_types:
        parts.append(f"{missing_types} entity type{'s' if missing_types != 1 else ''} don't exist here")
    if missing_rel_types:
        parts.append(f"{missing_rel_types} relationship type{'s' if missing_rel_types != 1 else ''} don't exist here")
    if overall.unknown:
        parts.append(f"{overall.unknown:,} couldn't be checked")
    return ("; ".join(parts) + ".") if parts else "Some things need a look before importing."


def aggregate(reports: List[Dict[str, Any]]) -> Dict[str, Any]:
    """One score across several views (a multi-view file)."""
    total = _Counts()
    verdicts: Dict[str, int] = {}
    for report in reports:
        entities = report["summary"]["entities"]
        total.total += entities["total"]
        total.matched += entities["matched"]
        total.renamed += entities["renamed"]
        total.type_changed += entities["typeChanged"]
        total.missing += entities["missing"]
        total.unknown += entities["unknown"]
        verdict = report["summary"]["verdict"]
        verdicts[verdict] = verdicts.get(verdict, 0) + 1
    return {"entities": total.as_dict(), "verdicts": verdicts, "views": len(reports)}


__all__ = [
    "MATCHED", "RENAMED", "TYPE_CHANGED", "MISSING", "UNKNOWN", "READY", "ATTENTION", "BLOCKED",
    "TargetTypes", "Policy", "reconcile_view", "suggest_types", "aggregate",
]

