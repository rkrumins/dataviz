"""Per-source vocabulary alignment (Task E).

Third-party / ONBOARDED graphs carry their OWN relationship- and entity-type
spellings (``has`` / ``to``) which need not match the spelling the ontology
declares (``HAS`` / ``TO``). FalkorDB matches relationship types and node labels
case-SENSITIVELY, so a query built from the ontology's declared casing silently
misses a differently-cased graph and flattens the hierarchy.

The fix is NOT to rewrite the source vocabulary (we don't own it) nor to sprinkle
``toUpper`` case-hacks across every query. Instead this module derives ONE
alignment per (data source, ontology): declared type id → the source's OBSERVED
spelling(s). The engine injects the resulting alias map into the provider, which
translates declared → observed at the single point where a type set becomes a
Cypher pattern. Governed/versioned graphs are canonicalized at the commit
boundary (Task C), so their observed spellings already equal the declared ones —
alignment is an identity and short-circuits.

Design (mirrors ``drift_detector`` — pure, no I/O; callers provide the observed
type lists and any explicit human-edited overrides, and persist the result):

* :func:`derive_alignment` compares declared vs observed case-insensitively and
  classifies each declared type as ``identity`` / ``case_variant`` /
  ``multi_variant`` / ``missing_observed``.
* ``multi_variant`` (one source spelling a type three ways: ``has`` + ``HAS`` +
  ``Has``) is the only decision-bearing case. Reads use a PROPOSED merge (all
  observed variants matched at once) immediately so the system stays correct;
  the entry is flagged ``needs_confirmation`` so the UI can ask the user to Keep
  (confirm the merge) or Split (treat as distinct types). Explicit overrides win.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Mapping, Optional

# Alignment "kinds" — how a declared type relates to the source's observed spellings.
IDENTITY = "identity"                 # exactly one observed spelling, equal to declared
CASE_VARIANT = "case_variant"         # exactly one observed spelling, different casing
MULTI_VARIANT = "multi_variant"       # >1 observed spelling for one declared type (needs confirm)
MISSING_OBSERVED = "missing_observed"  # declared type not present in the source graph at all


@dataclass
class AlignmentEntry:
    declared: str                       # the ontology's declared/canonical spelling
    observed: List[str] = field(default_factory=list)  # matched source spellings (empty when missing)
    kind: str = IDENTITY
    explicit: bool = False              # human-edited (wins over auto-derivation)
    needs_confirmation: bool = False    # multi_variant awaiting a Keep/Split decision

    @property
    def is_identity(self) -> bool:
        return self.kind == IDENTITY

    def to_json(self) -> dict:
        return {
            "declared": self.declared,
            "observed": list(self.observed),
            "kind": self.kind,
            "auto": not self.explicit,
            "needsConfirmation": self.needs_confirmation,
        }


@dataclass
class SourceAlignment:
    relationship_entries: Dict[str, AlignmentEntry] = field(default_factory=dict)
    entity_entries: Dict[str, AlignmentEntry] = field(default_factory=dict)
    schema_hash: str = ""

    @property
    def has_drift(self) -> bool:
        """User-facing mismatch: the graph spells a type differently than the ontology
        DECLARES it (Day-N ``has`` vs ``HAS``). Distinct from the alias map, which also
        compensates for the provider's internal uppercasing even without user drift."""
        return any(not e.is_identity for e in self.relationship_entries.values()) or \
            any(not e.is_identity for e in self.entity_entries.values())

    def rel_alias_map(self) -> Dict[str, List[str]]:
        return _alias_map(self.relationship_entries)

    def entity_alias_map(self) -> Dict[str, List[str]]:
        return _alias_map(self.entity_entries)

    def drift_details(self) -> List[dict]:
        """Structured, plain-language-ready issues for the DS-panel warning + the
        persisted ``drift_details`` column. Identity entries are omitted."""
        out: List[dict] = []
        for dim, entries in (("relationship", self.relationship_entries),
                             ("entity", self.entity_entries)):
            for e in entries.values():
                if e.is_identity:
                    continue
                out.append({"dimension": dim, **e.to_json()})
        return out


def _alias_map(entries: Mapping[str, AlignmentEntry]) -> Dict[str, List[str]]:
    """``UPPER(declared) → [observed spelling(s)]`` — the provider's render-compensation
    map. Two provider channels reach a Cypher rel-type: the containment set (uppercased
    at injection) and a declared-cased query param. To normalize BOTH to the graph's
    observed spelling we key by uppercase and emit for every declared type present in the
    graph. The ONE no-op we skip is an already-uppercase declared type the graph spells
    identically — there the uppercased set and the declared param already render right, so
    the common governed graph keeps an empty map (cheap short-circuit)."""
    out: Dict[str, List[str]] = {}
    for e in entries.values():
        if not e.observed:
            continue
        up = e.declared.upper()
        if e.declared == up and e.observed == [up]:
            continue
        out[up] = list(e.observed)
    return out


def _schema_hash(observed_rel: Iterable[str], observed_entity: Iterable[str]) -> str:
    content = json.dumps(
        {"rels": sorted(observed_rel), "entities": sorted(observed_entity)},
        sort_keys=True,
    )
    return hashlib.sha256(content.encode()).hexdigest()


def _group_by_casefold(names: Iterable[str]) -> Dict[str, List[str]]:
    """``{casefolded: [spelling, …]}`` preserving first-seen order (dedup exact repeats)."""
    groups: Dict[str, List[str]] = {}
    for n in names:
        if not n:
            continue
        s = str(n)
        bucket = groups.setdefault(s.lower(), [])
        if s not in bucket:
            bucket.append(s)
    return groups


def _derive_dimension(
    declared_types: Iterable[str],
    observed_types: Iterable[str],
    explicit: Optional[Mapping[str, Mapping]],
) -> Dict[str, AlignmentEntry]:
    observed_by_casefold = _group_by_casefold(observed_types)
    explicit = {k.lower(): v for k, v in (explicit or {}).items()}
    entries: Dict[str, AlignmentEntry] = {}
    seen: set = set()
    for declared in declared_types:
        if not declared:
            continue
        declared = str(declared)
        key = declared.lower()
        if key in seen:
            continue  # a type appearing in >1 declared list (containment + rel-defs) — align once
        seen.add(key)
        ex = explicit.get(key)
        if ex and ex.get("observed"):
            obs = [str(s) for s in ex["observed"]]
            entries[declared] = AlignmentEntry(
                declared=declared, observed=obs,
                kind=_classify(declared, obs), explicit=True,
                needs_confirmation=False,   # an explicit decision has been made
            )
            continue
        obs = list(observed_by_casefold.get(key, []))
        kind = _classify(declared, obs)
        entries[declared] = AlignmentEntry(
            declared=declared, observed=obs, kind=kind,
            needs_confirmation=(kind == MULTI_VARIANT),
        )
    return entries


def _classify(declared: str, observed: List[str]) -> str:
    if not observed:
        return MISSING_OBSERVED
    if len(observed) == 1:
        return IDENTITY if observed[0] == declared else CASE_VARIANT
    return MULTI_VARIANT


def derive_alignment(
    *,
    declared_relationship_types: Iterable[str],
    declared_entity_types: Iterable[str],
    observed_relationship_types: Iterable[str],
    observed_entity_types: Iterable[str],
    explicit_relationship_mappings: Optional[Mapping[str, Mapping]] = None,
    explicit_entity_mappings: Optional[Mapping[str, Mapping]] = None,
) -> SourceAlignment:
    """Compare an ontology's declared type spellings against a source graph's
    observed spellings and build the per-source alignment. Pure; no I/O.

    ``explicit_*`` are human-confirmed overrides loaded from
    ``ontology_source_mappings`` — shape ``{declared: {"observed": [...]}}`` — and
    win over auto-derivation (an explicit merge is never re-flagged for confirmation).
    """
    observed_rel = list(observed_relationship_types or [])
    observed_ent = list(observed_entity_types or [])
    return SourceAlignment(
        relationship_entries=_derive_dimension(
            declared_relationship_types, observed_rel, explicit_relationship_mappings),
        entity_entries=_derive_dimension(
            declared_entity_types, observed_ent, explicit_entity_mappings),
        schema_hash=_schema_hash(observed_rel, observed_ent),
    )
