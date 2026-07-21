"""Repair stored ontology-definition documents that carry case-variant duplicate type ids.

The canonical contract (see :func:`resolver.case_insensitive_type_id_collisions`) allows exactly ONE
declared id per case-fold; physical graph spellings fold onto it at read/commit time. Older data — a
pre-guard save, the historical UPPER_SNAKE-ing bug, or an import that bypassed normalization — can
still hold two keys that differ only by case (``TO`` next to ``To``, ``Has`` next to ``HAS``). The
write-path guard now rejects such a payload and the Schema page folds it on save, so a corrupted
ontology heals the next time it is edited; this module repairs the ones nobody edits.

For each case-fold group it collapses the keys to ONE canonical key, unions the containment/lineage
classification, records the folded spellings in the description ("also seen as: …"), and rewrites
the containment/lineage lists and entity hierarchy references onto the survivor.

Pure — no I/O. ``scripts/repair_ontology_case_variants.py`` applies it across stored ontologies.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _case_fold(s: str) -> str:
    return (s or "").strip().lower()


def _also_seen_note(description: Optional[str], folded: List[str]) -> Optional[str]:
    if not folded:
        return description
    note = "also seen as: " + ", ".join(folded)
    desc = description if isinstance(description, str) and description else ""
    if note in desc:
        return desc
    return f"{desc} ({note})" if desc else note


def _pick_canonical(keys: List[str], prefer: Optional[set] = None) -> str:
    """Deterministic survivor for a case-fold group: a `prefer`red spelling (e.g. one already
    referenced in the containment/lineage lists, or a system-default spelling) wins, else the
    first-seen key (dicts preserve insertion order)."""
    if prefer:
        for k in keys:
            if k in prefer:
                return k
    return keys[0]


@dataclass
class RepairResult:
    entity_type_definitions: Dict[str, Any]
    relationship_type_definitions: Dict[str, Any]
    containment_edge_types: List[str]
    lineage_edge_types: List[str]
    # canonical id -> the off-spellings folded into it (only groups that actually merged)
    merged_relationships: Dict[str, List[str]] = field(default_factory=dict)
    merged_entities: Dict[str, List[str]] = field(default_factory=dict)

    @property
    def changed(self) -> bool:
        return bool(self.merged_relationships or self.merged_entities)


def _group_by_casefold(keys: List[str]) -> Dict[str, List[str]]:
    groups: Dict[str, List[str]] = {}
    for k in keys:
        groups.setdefault(_case_fold(k), []).append(k)
    return groups


def canonicalize_case_variants(
    entity_defs: Dict[str, Any],
    rel_defs: Dict[str, Any],
    containment_edge_types: Optional[List[str]] = None,
    lineage_edge_types: Optional[List[str]] = None,
) -> RepairResult:
    """Collapse case-variant declared keys in one ontology document to a canonical key each.

    Mirrors the frontend save-time fold (``caseFold.canonicalizeRelDefsForSave`` /
    ``canonicalizeEntityDefsForSave``) so a repair-at-rest and an edit-and-save produce the same
    canonical shape.
    """
    containment = list(containment_edge_types or [])
    lineage = list(lineage_edge_types or [])

    # ── Relationships ──────────────────────────────────────────────
    ref_spellings = set(containment) | set(lineage)  # a spelling already referenced wins the tie
    rel_canonical_of: Dict[str, str] = {}
    out_rels: Dict[str, Any] = {}
    merged_rels: Dict[str, List[str]] = {}

    for cf, keys in _group_by_casefold(list(rel_defs.keys())).items():
        canonical = _pick_canonical(keys, prefer=ref_spellings)
        rel_canonical_of[cf] = canonical
        base: Dict[str, Any] = dict(rel_defs.get(canonical) or {})
        is_c = bool(base.get("is_containment", base.get("isContainment", False)))
        is_l = bool(base.get("is_lineage", base.get("isLineage", False)))
        folded: List[str] = []
        for k in keys:
            if k == canonical:
                continue
            d = rel_defs.get(k) or {}
            is_c = is_c or bool(d.get("is_containment", d.get("isContainment", False)))
            is_l = is_l or bool(d.get("is_lineage", d.get("isLineage", False)))
            folded.append(k)
        base["is_containment"] = is_c
        base["is_lineage"] = is_l
        if folded:
            base["description"] = _also_seen_note(base.get("description"), folded)
            merged_rels[canonical] = folded
        out_rels[canonical] = base

    def _remap_refs(values: List[str]) -> List[str]:
        out: List[str] = []
        for t in values or []:
            canonical = rel_canonical_of.get(_case_fold(t), t)
            if canonical not in out:
                out.append(canonical)
        return out

    # ── Entities (rewrite hierarchy references onto survivors) ──────
    ent_canonical_of: Dict[str, str] = {}
    for cf, keys in _group_by_casefold(list(entity_defs.keys())).items():
        ent_canonical_of[cf] = _pick_canonical(keys)

    def _remap_ent(ref: str) -> str:
        return ent_canonical_of.get(_case_fold(ref), ref)

    def _remap_ent_list(values: Any) -> Any:
        if not isinstance(values, list):
            return values
        out: List[str] = []
        for v in values:
            c = _remap_ent(str(v))
            if c not in out:
                out.append(c)
        return out

    out_entities: Dict[str, Any] = {}
    merged_entities: Dict[str, List[str]] = {}
    for cf, keys in _group_by_casefold(list(entity_defs.keys())).items():
        canonical = ent_canonical_of[cf]
        base = dict(entity_defs.get(canonical) or {})
        hier = dict(base.get("hierarchy") or {})
        for field_name in ("can_contain", "canContain"):
            if field_name in hier:
                hier[field_name] = _remap_ent_list(hier[field_name])
        for field_name in ("can_be_contained_by", "canBeContainedBy"):
            if field_name in hier:
                hier[field_name] = _remap_ent_list(hier[field_name])
        base["hierarchy"] = hier
        folded = [k for k in keys if k != canonical]
        if folded:
            base["description"] = _also_seen_note(base.get("description"), folded)
            merged_entities[canonical] = folded
        out_entities[canonical] = base

    return RepairResult(
        entity_type_definitions=out_entities,
        relationship_type_definitions=out_rels,
        containment_edge_types=_remap_refs(containment),
        lineage_edge_types=_remap_refs(lineage),
        merged_relationships=merged_rels,
        merged_entities=merged_entities,
    )
