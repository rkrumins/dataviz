"""FalkorDB index policy — the single source of truth for WHICH labels and
properties ``ensure_indices`` creates indexes on.

Shared between the provider (which executes the DDL) and the
alignment-analysis endpoint (which PREDICTS query performance from cached
profiling data): a physical label is index-backed iff it appears in
``indexed_labels(...)`` — case-sensitively, because FalkorDB labels are.
Keeping both consumers on one module means the analysis can never silently
drift from what the provider actually indexes.
"""
from __future__ import annotations

from typing import Iterable, List, Optional

# Platform built-in labels every graph gets indexed regardless of ontology.
DEFAULT_INDEX_LABELS: List[str] = [
    "domain",
    "dataPlatform",
    "container",
    "dataset",
    "schemaField",
]

# `level` indexed for trace queries that filter by hierarchy level
# (Cypher: WHERE n.level = $level).
INDEXED_NODE_PROPS: List[str] = ["urn", "displayName", "qualifiedName", "level"]


def indexed_labels(entity_type_ids: Optional[Iterable[str]] = None) -> List[str]:
    """The exact, deduplicated, order-preserving label list ``ensure_indices``
    indexes: platform defaults first, then the ontology's declared entity
    type ids (their DECLARED spelling — a case-drifted physical label is by
    construction not in this list, so queries against it label-scan)."""
    extra = list(entity_type_ids) if entity_type_ids else []
    seen: set[str] = set()
    labels: List[str] = []
    for lbl in DEFAULT_INDEX_LABELS + extra:
        if lbl not in seen:
            seen.add(lbl)
            labels.append(lbl)
    return labels
