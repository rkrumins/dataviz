"""
Graph fingerprint computation for change detection.

Computes a deterministic hash of the graph's structure (node/edge counts by type)
to detect drift without scanning every edge.
"""
import hashlib
import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


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
