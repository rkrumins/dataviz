"""
Graph fingerprint computation for change detection.

Computes a deterministic hash of the graph's structure (node/edge counts by type)
to detect drift without scanning every edge.
"""
import hashlib
import inspect
import json
import logging
from typing import Any, Dict, Optional, Tuple
from weakref import WeakKeyDictionary

from backend.common.derived_artifacts import strip_derived_counts

logger = logging.getLogger(__name__)

#: ``get_schema_stats`` → does it accept ``budget_s``. Keyed on the underlying
#: FUNCTION, not the bound method: ``provider.get_schema_stats`` builds a new
#: bound method on every attribute access, so a cache keyed on that would never
#: hit and — being weak — would evict itself immediately. The function object is
#: shared by every instance of the class and lives as long as the class does.
_BUDGET_SUPPORT: "WeakKeyDictionary[Any, bool]" = WeakKeyDictionary()


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
    the AGGREGATED count and the derived bookkeeping nodes, both excluded, so
    the raw fingerprint is invariant across rebuilds by construction.** It
    therefore never needs re-seeding when a job completes.

    The derived-node half of that was missing and the invariant was simply
    false: ``_stamp_run_meta`` MERGEs an ``_AggMeta`` singleton at the end of
    every run, so the FIRST aggregation of a source added a node key here and
    moved the very baseline the next sweep compared against — ``_raw_drift``
    then reported drift and queued a rebuild that had nothing to fix, which
    stamped it again. Excluding the labels restores the stated property rather
    than adding a new rule.

    The AGGREGATED key is matched case-insensitively — the count comes from
    ``type(r)`` in the provider's stats scan, and a graph loaded by an
    external system may not match our casing.
    """
    nodes = {
        str(k): _as_int(v)
        for k, v in strip_derived_counts(entity_type_counts or {}).items()
    }
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


def counts_digest_from_counts(
    entity_type_counts: Optional[Dict[str, Any]],
    edge_type_counts: Optional[Dict[str, Any]],
) -> str:
    """Digest EVERY count, AGGREGATED included — "did anything at all move?".

    This is the sweeper's *tripwire*, and it is deliberately the opposite of
    :func:`raw_fingerprint_from_counts`, which excludes AGGREGATED so that a
    rebuild cannot move the drift baseline it is compared against.

    The distinction matters because the two answer different questions.
    Comparing this digest against a BASELINE would indeed re-trigger forever,
    since a rebuild changes the AGGREGATED count. But it is compared against
    the counts the sweeper last *looked at*, which makes it exact: it fires
    if and only if some count changed since the previous evaluation. Excluding
    AGGREGATED here would blind the tripwire to a wiped overlay with unchanged
    raw data — precisely the failure this whole mechanism exists to catch.

    The derived bookkeeping labels stay here for exactly the same reason, even
    though :func:`raw_fingerprint_from_counts` strips them: ``_AggMeta``
    disappearing IS the signal that the overlay was wiped or reseeded. Do not
    "align" the two functions — the asymmetry is the point.
    """
    nodes = {str(k): _as_int(v) for k, v in (entity_type_counts or {}).items()}
    edges = {str(k): _as_int(v) for k, v in (edge_type_counts or {}).items()}
    structure = {
        # Own namespace, same reasoning as the "raw1" tag above: on a source
        # with no AGGREGATED edges this would otherwise be byte-identical to
        # the raw digest, so a mix-up would look correct on exactly the
        # never-aggregated sources and be wrong everywhere else.
        "v": "all1",
        "nodes": dict(sorted(nodes.items())),
        "edges": dict(sorted(edges.items())),
    }
    raw = json.dumps(structure, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _as_int(value: Any) -> int:
    """Coerce a count to int; unparseable values count as 0.

    The counts arrive as JSON written by the stats service, so they are
    normally ints — but a single bad value must not blow up a fleet sweep.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _drift_digest(nodes: Dict[str, Any], edges: Dict[str, Any]) -> str:
    """THE drift digest: per-label node counts and per-type edge counts.

    Deliberately untagged, unlike ``raw_fingerprint_from_counts`` ("raw1") and
    the all-in digest ("all1") above — this one predates both and its value is
    persisted on every data source row, so a version tag here would read as
    drift on every source at once.

    The two functions below are its only entry points, and they share this body
    so that a fingerprint taken from the fast counters and one taken from a full
    scan can never disagree. They ARE compared against each other: a source
    fingerprinted by the scan yesterday is fingerprinted by the counters today.
    """
    structure: Dict[str, Any] = {
        "nodes": dict(sorted(nodes.items())),
        "edges": dict(sorted(edges.items())),
    }
    raw = json.dumps(structure, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def fingerprint_from_stats(stats: Any) -> str:
    """Hash an already-fetched ``GraphSchemaStats`` into the drift
    fingerprint. Factored out so a caller that already holds schema stats
    (e.g. the freshness probe) derives the SAME digest without a second
    ``get_schema_stats`` round-trip."""
    return _drift_digest(
        {s.id: s.count for s in stats.entity_type_stats},
        {s.id: s.count for s in stats.edge_type_stats},
    )


def fingerprint_from_fast_counts(counts: Dict[str, Any]) -> str:
    """The same digest, from ``get_counts_fast``'s constant-time counters.

    ``get_counts_fast`` is built to reproduce ``get_stats``' breakdown exactly —
    same derived-label exclusion, the same "unknown" bucket for unlabelled
    nodes, zero-count buckets dropped — and returns ``None`` rather than guess
    when it cannot. So the digest it yields is byte-identical to the scanned
    one, which is what makes it safe to swap in underneath a stored value.
    """
    return _drift_digest(
        counts.get("entityTypeCounts") or {},
        counts.get("edgeTypeCounts") or {},
    )


def _takes_budget(fn: Any) -> bool:
    """Whether this provider's ``get_schema_stats`` accepts a deadline.

    Cached per function object. A provider that predates the deadline — a
    third-party adapter, a test double — must not have its call raise
    TypeError here: `compute_graph_fingerprint` turns any exception into an
    empty fingerprint, and an empty fingerprint is read as "the graph
    changed", which signals a rebuild. A signature mismatch would quietly
    become a rebuild storm.
    """
    key = getattr(fn, "__func__", fn)
    try:
        cached = _BUDGET_SUPPORT.get(key)
    except TypeError:                      # not weak-referenceable
        key, cached = None, None
    if cached is None:
        try:
            cached = "budget_s" in inspect.signature(fn).parameters
        except (TypeError, ValueError):
            cached = False
        if key is not None:
            try:
                _BUDGET_SUPPORT[key] = cached
            except TypeError:
                pass
    return cached


async def _schema_stats(provider: Any, budget_s: Optional[float]):
    fn = provider.get_schema_stats
    if budget_s is not None and _takes_budget(fn):
        return await fn(budget_s=budget_s)
    return await fn()


async def compute_graph_fingerprint(
    provider: Any, *, budget_s: Optional[float] = None,
) -> str:
    """Compute a fingerprint of the graph's current structure.

    Returns a hex digest string that changes when the graph's topology changes.
    Uses node counts by label + edge counts by type + total counts.

    ``budget_s`` is the caller's own wall clock, handed down as a DEADLINE for
    the three full scans behind it. Without one, each scan carried the 30s env
    ceiling while every caller waited 5s — so the caller gave up and the node
    kept scanning for a result nobody would read, three times per source per
    sweep, on a database that serves queries from a small fixed thread count.
    """
    # The counters first. The digest reads only per-label node counts and
    # per-type edge counts, and `get_counts_fast` answers exactly those from
    # FalkorDB's label/relation matrix — ~1.3ms against ~514ms of scanning on a
    # 500k-node graph. The scan path additionally collected displayName samples
    # and every node's tags, neither of which the digest has ever looked at.
    fast = getattr(provider, "get_counts_fast", None)
    if fast is not None:
        try:
            counts = await fast()
            if counts is not None:
                return fingerprint_from_fast_counts(counts)
            # None means the counters cannot be trusted for THIS graph
            # (multi-label nodes); fall through to the scan deliberately.
        except Exception as e:
            logger.info(
                "fast count probe failed, falling back to the full scan: %s", e)

    try:
        # Get full schema stats
        stats = await _schema_stats(provider, budget_s)
        return fingerprint_from_stats(stats)
    except Exception as e:
        logger.warning("Failed to compute graph fingerprint: %s", e)
        return ""


def fingerprints_match(fp1: Optional[str], fp2: Optional[str]) -> bool:
    """Compare two fingerprints. Both must be non-empty and equal."""
    if not fp1 or not fp2:
        return False
    return fp1 == fp2


def fingerprint_unknown(fp: Optional[str]) -> bool:
    """True when a fingerprint could not be taken at all.

    :func:`compute_graph_fingerprint` returns ``""`` when every probe failed
    — the fast counters could not answer for this graph AND the scan fell
    over or ran past its budget. That is the absence of a measurement, and
    it is NOT the same fact as "the graph changed", however convenient it
    was to treat the two alike: ``fingerprints_match`` says False for both,
    so an unmeasurable graph read as permanently drifting.

    What that cost, on exactly the large graphs where the scan cannot
    finish: the scope-wide read generation was bumped on every automatic
    check, so no cached read of that source ever survived to be hit, and a
    rebuild was queued every time, which made the next scan slower still.

    Callers that have their OWN evidence of a write (an external loader
    saying so, an operator forcing a refresh) are right to proceed anyway.
    Callers whose only evidence was the probe have none when it fails."""
    return not fp
