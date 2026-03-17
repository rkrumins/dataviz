"""
Drift detector — compares inbound graph schema stats against the active
ontology mapping profile and reports any unmapped types.

Usage
-----
Called at ingestion time (e.g. after a DataHub sync) or on-demand via the
/data-sources/{id}/drift endpoint.

Design
------
- Pure function: takes stats + mapping dict, returns DriftReport.
- No I/O: callers provide the mapping profile from the DB.
- The hash of the external schema snapshot is stored so drift checks are
  skipped when nothing has changed (cheap path).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ─── Domain types ─────────────────────────────────────────────────────────────

@dataclass
class DriftIssue:
    kind: str              # "unmapped_entity_type" | "unmapped_relationship_type"
    external_label: str
    suggestion: Optional[str] = None   # Closest known Synodic type id, if any


@dataclass
class DriftReport:
    has_drift: bool
    schema_hash: str
    issues: List[DriftIssue] = field(default_factory=list)


# ─── Detection ────────────────────────────────────────────────────────────────

def detect_drift(
    external_entity_types: List[str],
    external_relationship_types: List[str],
    entity_type_mappings: Dict[str, str],
    relationship_type_mappings: Dict[str, str],
    known_synodic_entity_types: Optional[List[str]] = None,
    known_synodic_relationship_types: Optional[List[str]] = None,
) -> DriftReport:
    """
    Compare external type labels against the mapping profile.

    Parameters
    ----------
    external_entity_types:         Types seen in the latest provider sync.
    external_relationship_types:   Edge types seen in the latest provider sync.
    entity_type_mappings:          Mapping profile: external_label → synodic_id.
    relationship_type_mappings:    Mapping profile: external_label → synodic_id.
    known_synodic_entity_types:    All valid Synodic entity type ids (for suggestions).
    known_synodic_relationship_types: All valid Synodic relationship type ids.
    """
    schema_content = json.dumps(
        {
            "entities": sorted(external_entity_types),
            "relationships": sorted(external_relationship_types),
        },
        sort_keys=True,
    )
    schema_hash = hashlib.sha256(schema_content.encode()).hexdigest()

    issues: List[DriftIssue] = []

    # Normalise mapping keys to uppercase for case-insensitive lookup
    entity_map_upper = {k.upper(): v for k, v in entity_type_mappings.items()}
    rel_map_upper = {k.upper(): v for k, v in relationship_type_mappings.items()}

    for ext in external_entity_types:
        if ext.upper() not in entity_map_upper:
            suggestion = _closest_match(ext, known_synodic_entity_types or [])
            issues.append(DriftIssue(
                kind="unmapped_entity_type",
                external_label=ext,
                suggestion=suggestion,
            ))

    for ext in external_relationship_types:
        if ext.upper() not in rel_map_upper:
            suggestion = _closest_match(ext, known_synodic_relationship_types or [])
            issues.append(DriftIssue(
                kind="unmapped_relationship_type",
                external_label=ext,
                suggestion=suggestion,
            ))

    return DriftReport(
        has_drift=bool(issues),
        schema_hash=schema_hash,
        issues=issues,
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _closest_match(label: str, candidates: List[str]) -> Optional[str]:
    """
    Return the candidate whose lowercase form has the longest common prefix
    with the normalised label.  A very lightweight heuristic — good enough
    for surface-level drift suggestions without pulling in a full fuzzy-match lib.
    """
    if not candidates:
        return None
    norm = label.lower().replace("_", "").replace("-", "")
    best, best_len = None, 0
    for c in candidates:
        c_norm = c.lower().replace("_", "").replace("-", "")
        common = len(_common_prefix(norm, c_norm))
        if common > best_len:
            best, best_len = c, common
    return best if best_len > 0 else None


def _common_prefix(a: str, b: str) -> str:
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return a[:i]
    return a[:n]
