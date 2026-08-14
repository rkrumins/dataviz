"""
Graph fingerprint computation for change detection.

Computes a deterministic hash of the graph's structure (node/edge counts by type)
to detect drift without scanning every edge.
"""
import hashlib
import json
import logging
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# The materialized overlay's edge type. Excluded from the RAW fingerprint
# below so that a rebuild — which changes only this type's count — cannot
# move the baseline it is compared against.
AGGREGATED_EDGE_TYPE = "AGGREGATED"


def raw_fingerprint_from_counts(
    entity_type_counts: Optional[Dict[str, Any]],
    edge_type_counts: Optional[Dict[str, Any]],
) -> Tuple[str, int, int]:
    """Digest the RAW graph shape from the stats service's cached counts.

    Returns ``(raw_fingerprint, observed_aggregated_edges, raw_edge_total)``,
    computed from ``data_source_stats.entity_type_counts`` /
    ``.edge_type_counts`` — no provider call, no graph query.

    This is deliberately a SEPARATE digest namespace from
    :func:`fingerprint_from_stats`, which hashes a ``GraphSchemaStats`` object
    and INCLUDES ``AGGREGATED``. Reusing that one as the drift baseline would
    move the baseline on every successful rebuild, so each rebuild would look
    like fresh drift and re-trigger itself forever.

    The invariant this function exists to guarantee: **a rebuild changes only
    the AGGREGATED count, which is excluded, so the raw fingerprint is
    invariant across rebuilds by construction.** It therefore never needs
    re-seeding when a job completes.

    The AGGREGATED key is matched case-insensitively — the count comes from
    ``type(r)`` in the provider's stats scan, and a graph loaded by an
    external system may not match our casing.
    """
    nodes = {str(k): _as_int(v) for k, v in (entity_type_counts or {}).items()}
    raw_edges: Dict[str, int] = {}
    observed_aggregated = 0
    for key, value in (edge_type_counts or {}).items():
        count = _as_int(value)
        if str(key).upper() == AGGREGATED_EDGE_TYPE:
            observed_aggregated += count
        else:
            raw_edges[str(key)] = count

    structure = {
        # Namespace tag. Without it this digest is byte-identical to
        # ``fingerprint_from_stats`` for any source that happens to have no
        # AGGREGATED edges — so a mistaken comparison between the two would
        # look correct on exactly the sources this feature exists to fix, and
        # wrong everywhere else. The tag makes the mix-up impossible to be
        # subtly right.
        "v": "raw1",
        "nodes": dict(sorted(nodes.items())),
        "edges": dict(sorted(raw_edges.items())),
    }
    raw = json.dumps(structure, sort_keys=True)
    digest = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return digest, observed_aggregated, sum(raw_edges.values())


def _as_int(value: Any) -> int:
    """Coerce a count to int; unparseable values count as 0.

    The counts arrive as JSON written by the stats service, so they are
    normally ints — but a single bad value must not blow up a fleet sweep.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def fingerprint_from_stats(stats: Any) -> str:
    """Hash an already-fetched ``GraphSchemaStats`` into the drift
    fingerprint. Factored out so a caller that already holds schema stats
    (e.g. the freshness probe) derives the SAME digest without a second
    ``get_schema_stats`` round-trip."""
    structure: Dict[str, Any] = {
        "nodes": {s.id: s.count for s in sorted(stats.entity_type_stats, key=lambda s: s.id)},
        "edges": {s.id: s.count for s in sorted(stats.edge_type_stats, key=lambda s: s.id)},
    }
    raw = json.dumps(structure, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


async def compute_graph_fingerprint(provider: Any) -> str:
    """Compute a fingerprint of the graph's current structure.

    Returns a hex digest string that changes when the graph's topology changes.
    Uses node counts by label + edge counts by type + total counts.
    """
    try:
        # Get full schema stats
        stats = await provider.get_schema_stats()
        return fingerprint_from_stats(stats)
    except Exception as e:
        logger.warning("Failed to compute graph fingerprint: %s", e)
        return ""


def fingerprints_match(fp1: Optional[str], fp2: Optional[str]) -> bool:
    """Compare two fingerprints. Both must be non-empty and equal."""
    if not fp1 or not fp2:
        return False
    return fp1 == fp2
