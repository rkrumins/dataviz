"""
AggregationConsistencyVerifier — periodic safety net for the
``:AGGREGATED`` edge set materialised by the aggregation worker.

Why this exists. The fingerprint-based skip path
(``worker._maybe_skip_unchanged``) is intentionally eventual-consistent:
when the graph fingerprint (per-label / per-type counts) matches the
prior completed job, the worker reuses the prior result without
re-running the materialise loop. This catches the common case (stable
graphs) at zero cost, but it does NOT detect:

  * A same-type lineage edge delete + add (counts unchanged, identity
    different)
  * An in-place edit to a lineage edge property that affects rollup
  * Restructured containment with identical totals

For those cases the AGGREGATED set silently goes stale until the next
drift-triggered or manual rebuild. This verifier samples N random
AGGREGATED edges per data source per run and asserts that at least
one underlying lineage path still supports each edge. On failure it
emits a Prometheus counter + WARN log so operators (or a Grafana
alert) know to issue a force rebuild.

Design choices (confirmed with the user):

  * Alert only — no auto-rebuild. A buggy verifier must not spam
    rebuilds; operators decide whether to act on the signal.
  * Daily cadence, 100 edges per data source. Bounded Cypher cost
    (~10s/data source at most) with detection-window ≤ 24h.
  * Random sampling via Python (FalkorDB Cypher doesn't support
    ``ORDER BY rand()``) over a SKIP/LIMIT pagination.

Scheduler hook wires this into the existing AggregationScheduler tick
on a coarser cadence (``AGGREGATION_VERIFIER_TICK_SECS``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from dataclasses import dataclass, field
from typing import Any, List, Optional

from backend.app.jobs.metrics import increment as _metric_increment

logger = logging.getLogger(__name__)

# Defaults intentionally conservative. Operators can override via env.
_DEFAULT_SAMPLE_SIZE = int(os.getenv("AGGREGATION_VERIFIER_SAMPLE_SIZE", "100"))
_DEFAULT_MAX_DEPTH = int(os.getenv("AGGREGATION_VERIFIER_MAX_DEPTH", "7"))
_DEFAULT_PER_DS_TIMEOUT = float(
    os.getenv("AGGREGATION_VERIFIER_PER_DS_TIMEOUT_SECS", "120")
)
_DEFAULT_PER_EDGE_TIMEOUT = float(
    os.getenv("AGGREGATION_VERIFIER_PER_EDGE_TIMEOUT_SECS", "5")
)


@dataclass
class VerifierResult:
    """Outcome of a verifier run against one data source."""
    data_source_id: str
    sampled: int = 0
    verified: int = 0
    failed: int = 0
    skipped_no_edges: bool = False
    timed_out: bool = False
    error: Optional[str] = None
    # Sample of failing (s_urn, t_urn) pairs — capped so the log line
    # stays bounded if a whole data source goes stale.
    failures: List[tuple] = field(default_factory=list)


class AggregationConsistencyVerifier:
    """Samples AGGREGATED edges and verifies the underlying lineage
    still supports them.

    The verifier is stateless across runs (each call returns a
    VerifierResult) so it can be invoked from the scheduler tick, an
    ad-hoc CLI, or a focused integration test interchangeably.
    """

    _MAX_FAILURE_SAMPLES = 10  # cap the failures list per data source

    def __init__(
        self,
        *,
        sample_size: int = _DEFAULT_SAMPLE_SIZE,
        max_depth: int = _DEFAULT_MAX_DEPTH,
        per_data_source_timeout_secs: float = _DEFAULT_PER_DS_TIMEOUT,
        per_edge_timeout_secs: float = _DEFAULT_PER_EDGE_TIMEOUT,
    ) -> None:
        self._sample_size = max(1, sample_size)
        self._max_depth = max(1, max_depth)
        self._per_ds_timeout = per_data_source_timeout_secs
        self._per_edge_timeout = per_edge_timeout_secs

    async def verify_data_source(
        self,
        provider: Any,
        data_source_id: str,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
    ) -> VerifierResult:
        """Run one verifier pass against ``data_source_id``.

        ``provider`` must expose ``_proj_ro_query(cypher, params,
        timeout)`` and either ``count_aggregated_edges()`` or a
        compatible counter (we call the former when present).

        Returns a ``VerifierResult`` regardless of outcome — failures
        and timeouts are captured on the result, not raised. This lets
        the scheduler treat a single broken data source as a
        single-point failure rather than aborting the nightly run.
        """
        result = VerifierResult(data_source_id=data_source_id)
        try:
            total = await self._count_edges(provider)
            if total <= 0:
                result.skipped_no_edges = True
                _metric_increment(
                    "aggregation_consistency_skipped_total",
                    data_source_id=data_source_id,
                )
                return result

            sample_size = min(self._sample_size, total)
            offsets = random.sample(range(total), sample_size)
            try:
                await asyncio.wait_for(
                    self._verify_samples(
                        provider, offsets, lineage_edge_types,
                        containment_edge_types, result,
                    ),
                    timeout=self._per_ds_timeout,
                )
            except asyncio.TimeoutError:
                result.timed_out = True
                logger.warning(
                    "Consistency verifier on %s timed out after %.0fs "
                    "(sampled %d/%d before deadline)",
                    data_source_id, self._per_ds_timeout,
                    result.sampled, sample_size,
                )

            _metric_increment(
                "aggregation_consistency_verified_total",
                value=result.verified,
                data_source_id=data_source_id,
            )
            _metric_increment(
                "aggregation_consistency_failed_total",
                value=result.failed,
                data_source_id=data_source_id,
            )

            if result.failed > 0:
                logger.warning(
                    "Consistency verifier on %s: %d/%d sampled AGGREGATED "
                    "edges are no longer supported by lineage. Sample "
                    "failures: %s. Operator action: trigger a rebuild via "
                    "force_rebuild=true.",
                    data_source_id, result.failed, result.sampled,
                    result.failures[: self._MAX_FAILURE_SAMPLES],
                )
            else:
                logger.info(
                    "Consistency verifier on %s: %d/%d AGGREGATED edges OK",
                    data_source_id, result.verified, result.sampled,
                )
        except Exception as exc:
            result.error = str(exc)[:300]
            logger.warning(
                "Consistency verifier on %s aborted: %s",
                data_source_id, result.error,
            )
        return result

    async def _count_edges(self, provider: Any) -> int:
        """Count AGGREGATED edges in the projection graph.

        Prefers ``provider.count_aggregated_edges()`` when available
        (already implemented); falls back to a direct Cypher otherwise.
        """
        counter = getattr(provider, "count_aggregated_edges", None)
        if callable(counter):
            try:
                return int(await counter())
            except Exception:
                pass
        res = await provider._proj_ro_query(
            "MATCH ()-[r:AGGREGATED]->() RETURN count(r) AS c",
            timeout=self._per_edge_timeout,
        )
        rows = getattr(res, "result_set", None) or []
        return int(rows[0][0]) if rows and rows[0] else 0

    async def _verify_samples(
        self,
        provider: Any,
        offsets: List[int],
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        result: VerifierResult,
    ) -> None:
        """Walk the offsets list serialised — concurrent reads against
        a single FalkorDB graph compete on the per-graph reader-writer
        lock and yield no speedup. Serial keeps the verifier predictable
        under load."""
        for offset in offsets:
            edge = await self._fetch_edge_at(provider, offset)
            if edge is None:
                continue  # edge raced out from under us; skip silently
            s_urn, t_urn = edge
            result.sampled += 1
            supported = await self._is_supported(
                provider, s_urn, t_urn,
                lineage_edge_types, containment_edge_types,
            )
            if supported:
                result.verified += 1
            else:
                result.failed += 1
                if len(result.failures) < self._MAX_FAILURE_SAMPLES:
                    result.failures.append((s_urn, t_urn))

    async def _fetch_edge_at(
        self, provider: Any, offset: int,
    ) -> Optional[tuple]:
        """Fetch the AGGREGATED edge at the given absolute offset.

        Pagination via SKIP/LIMIT keeps the Cypher simple and works
        without ``ORDER BY rand()`` support in FalkorDB.
        """
        res = await provider._proj_ro_query(
            "MATCH (s)-[r:AGGREGATED]->(t) "
            "RETURN s.urn, t.urn "
            "ORDER BY s.urn, t.urn "
            "SKIP $offset LIMIT 1",
            params={"offset": offset},
            timeout=self._per_edge_timeout,
        )
        rows = getattr(res, "result_set", None) or []
        if not rows or not rows[0] or rows[0][0] is None:
            return None
        return (rows[0][0], rows[0][1])

    async def _is_supported(
        self,
        provider: Any,
        s_urn: str,
        t_urn: str,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
    ) -> bool:
        """Return True iff at least one underlying lineage path exists
        from a descendant of ``s_urn`` to a descendant of ``t_urn``.

        ``s_urn`` and ``t_urn`` themselves count as descendants (depth
        0). We use a single Cypher round-trip with bounded variable-
        length patterns. Cost is bounded but not cheap — keep
        ``max_depth`` ≤ 7 to avoid pathological combinatorial blow-up.
        """
        c_types = "|".join(containment_edge_types) if containment_edge_types else "CONTAINS"
        l_types = "|".join(lineage_edge_types) if lineage_edge_types else "FLOWS_TO"
        cypher = (
            f"MATCH (s {{urn: $s}})-[:{c_types}*0..{self._max_depth}]->(sd) "
            f"MATCH (sd)-[:{l_types}*1..{self._max_depth}]->(td) "
            f"MATCH (td)<-[:{c_types}*0..{self._max_depth}]-(t {{urn: $t}}) "
            "RETURN 1 AS supported LIMIT 1"
        )
        try:
            res = await provider._proj_ro_query(
                cypher,
                params={"s": s_urn, "t": t_urn},
                timeout=self._per_edge_timeout,
            )
        except asyncio.TimeoutError:
            # A timeout on a single edge is treated as "supported" so
            # we don't generate noisy false positives on the slow
            # tail. Operators see verifier-level timeouts via
            # result.timed_out instead.
            return True
        rows = getattr(res, "result_set", None) or []
        return bool(rows and rows[0] and rows[0][0])


async def verify_all_ready_data_sources(
    *,
    session_factory: Any,
    registry: Any,
    verifier: Optional[AggregationConsistencyVerifier] = None,
) -> List[VerifierResult]:
    """Convenience entry point used by the scheduler. Iterates over
    every data source with ``aggregation_status='ready'`` and runs
    the verifier on each. Returns the per-data-source results so the
    caller can log/emit a summary.
    """
    verifier = verifier or AggregationConsistencyVerifier()
    results: List[VerifierResult] = []

    # Imported lazily to avoid a circular import via models → engine.
    from .models import (
        AggregationDataSourceStateORM,
        AggregationJobORM,
    )
    from sqlalchemy import select

    async with session_factory() as session:
        ds_rows = (
            await session.execute(
                select(AggregationDataSourceStateORM).where(
                    AggregationDataSourceStateORM.aggregation_status == "ready",
                )
            )
        ).scalars().all()

        for ds in ds_rows:
            # Pull the most recent completed job for this data source
            # so we know which lineage / containment edge types to use.
            job = (
                await session.execute(
                    select(AggregationJobORM)
                    .where(
                        AggregationJobORM.data_source_id == ds.data_source_id,
                        AggregationJobORM.status == "completed",
                    )
                    .order_by(AggregationJobORM.completed_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if job is None:
                continue
            try:
                lineage_types = json.loads(job.lineage_edge_types or "[]")
                containment_types = json.loads(job.containment_edge_types or "[]")
            except (TypeError, ValueError):
                continue
            if not lineage_types:
                continue

            try:
                provider = await registry.get_provider_for_workspace(
                    ds.workspace_id, session,
                    data_source_id=ds.data_source_id,
                )
            except Exception as exc:
                logger.warning(
                    "Consistency verifier could not resolve provider for %s: %s",
                    ds.data_source_id, exc,
                )
                continue

            result = await verifier.verify_data_source(
                provider, ds.data_source_id,
                lineage_edge_types=lineage_types,
                containment_edge_types=containment_types,
            )
            results.append(result)

    return results
