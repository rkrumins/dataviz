"""Derived in-graph artifacts — the platform's own output, not source data.

The aggregation pipeline, the versioning projector and the dedicated-projection
scaffolding all write bookkeeping into the very graphs they maintain. Those
writes are OURS: they are not entities a user ingested, they carry no ontology
meaning, and every surface that enumerates "what is in this graph" has to leave
them out or it reports the platform back to the user as if it were their data.

Getting this wrong is not cosmetic, and it has bitten twice:

* ``versioning/reconcile.falkor_counts`` once excluded only ``_GVRollupMeta``,
  so after ANY aggregation job the node count came back one high, the verify
  reported "extra entities vs committed main", and the projection watermark
  was pinned until a human rebuilt by hand.
* ``get_stats``/``get_counts_fast`` never excluded any of them, so ``_AggMeta``
  reached the profiling snapshots. Because the aggregation pipeline MERGEs it
  per run while projection seeds and purges wipe it, it toggles 1 → 0 → 1 —
  and every dip raised a SEVERE ``type_gone`` finding plus a notification
  ("<source>: _AggMeta is gone"). The same unfiltered counts also fed the
  aggregation drift fingerprint, so a rebuild moved the baseline it was
  measured against and reported itself as drift.

Both were one missing copy of one list. Hence: **ONE definition, here**,
imported by everything that needs it — providers, repositories, the aggregation
reconciler, and the versioning package (which re-exports it for its own
callers). Adding an artifact means adding it here, once.

Membership is EXACT, not a ``_``-prefix rule. These are our own writes with
known spellings, while a customer's graph may legitimately contain a label of
its own that starts with an underscore — and that is their data, which must
keep showing up as theirs.
"""
from __future__ import annotations

from typing import Dict, Iterable, Mapping


#: In-graph bookkeeping NODES: the projector's rollup watermark, the
#: aggregation pipeline's run stamp, and the dedicated-projection scaffolding.
DERIVED_LABELS: tuple = ("_GVRollupMeta", "_AggMeta", "_Projection")

#: Derived RELATIONSHIP types — materialised rollups, not ingested lineage.
#:
#: Deliberately separate from the labels above, because the two are not
#: excluded in the same places. Rollup volume is a real operational number, so
#: raw stats and edge counts KEEP reporting ``AGGREGATED``; only the profiling
#: surfaces (where it reads as a data-quality anomaly appearing and vanishing)
#: strip it. Never assume one implies the other.
DERIVED_EDGE_TYPES: tuple = ("AGGREGATED",)


def is_derived_label(name: str) -> bool:
    """True when *name* is one of the platform's own bookkeeping node labels."""
    return bool(name) and str(name) in DERIVED_LABELS


def is_derived_edge_type(name: str) -> bool:
    """True when *name* is a materialised (platform-written) relationship type.

    Case-insensitive, unlike :func:`is_derived_label`: the edge type reaches
    callers via ``type(r)`` from stats scans of graphs an external system may
    have loaded, so its casing is not guaranteed to be ours.
    """
    return bool(name) and str(name).upper() in {t.upper() for t in DERIVED_EDGE_TYPES}


def strip_derived_counts(
    counts: Mapping[str, int], *, edges: bool = False,
) -> Dict[str, int]:
    """Copy *counts* without the derived keys.

    ``edges=False`` (default) strips :data:`DERIVED_LABELS` from a node-type
    count map; ``edges=True`` strips :data:`DERIVED_EDGE_TYPES` from an
    edge-type one. Returns a new dict — callers routinely hold the original for
    a separate purpose (an unfiltered total, a digest over raw data), and
    mutating it in place is how those two uses get silently conflated.
    """
    drop = is_derived_edge_type if edges else is_derived_label
    return {k: v for k, v in (counts or {}).items() if not drop(k)}


def not_derived_clause(var: str, labels: Iterable[str] = DERIVED_LABELS) -> str:
    """Cypher predicate excluding every derived label from matches on *var*.

    e.g. ``MATCH (n) WHERE {not_derived_clause('n')} RETURN count(n)``. The
    label list is interpolated, never parameterised, because it is a module
    constant — no caller-supplied value reaches the query text.
    """
    return " AND ".join(f"NOT '{label}' IN labels({var})" for label in labels)
