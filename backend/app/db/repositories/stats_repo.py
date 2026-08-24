import json
import logging
from datetime import datetime, timezone
from typing import List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from ..models import DataSourceStatsORM

logger = logging.getLogger(__name__)

async def get_data_source_stats(session: AsyncSession, ds_id: str) -> Optional[DataSourceStatsORM]:
    result = await session.execute(
        select(DataSourceStatsORM).where(DataSourceStatsORM.data_source_id == ds_id)
    )
    return result.scalar_one_or_none()

async def list_data_source_stats(
    session: AsyncSession, ds_ids: Sequence[str]
) -> List[DataSourceStatsORM]:
    """Bulk read backing /datasources/cached-stats — one SELECT for a
    whole dashboard instead of one query per data source."""
    if not ds_ids:
        return []
    result = await session.execute(
        select(DataSourceStatsORM).where(DataSourceStatsORM.data_source_id.in_(ds_ids))
    )
    return list(result.scalars().all())

async def upsert_data_source_stats(
    session: AsyncSession,
    ds_id: str,
    node_count: int,
    edge_count: int,
    entity_type_counts: str,
    edge_type_counts: str,
    schema_stats: str,
    ontology_metadata: str,
    graph_schema: str,
    *,
    lane: str = "deep",
) -> DataSourceStatsORM:
    """Full-row upsert — the deep stats facet. Stamps both freshness
    markers: ``updated_at`` (counts) and ``schema_updated_at`` (schema/
    ontology/graph_schema columns, read by the scheduler's deep due-check).

    ``lane`` names the collection lane for the history snapshot this write may
    capture (see :func:`_capture_history`); it does not affect the row."""
    now_iso = datetime.now(timezone.utc).isoformat()
    # First see if it exists
    existing = await get_data_source_stats(session, ds_id)
    # Before the overwrite: ``existing`` still holds the counts this
    # observation is a delta from.
    captured_at = await _capture_history(
        session, ds_id,
        lane=lane,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
        digest=_counts_digest(entity_type_counts, edge_type_counts),
        previous=existing,
    )
    if existing:
        existing.node_count = node_count
        existing.edge_count = edge_count
        existing.entity_type_counts = entity_type_counts
        existing.edge_type_counts = edge_type_counts
        existing.schema_stats = schema_stats
        existing.ontology_metadata = ontology_metadata
        existing.graph_schema = graph_schema
        existing.updated_at = now_iso
        existing.schema_updated_at = now_iso
        if captured_at:
            existing.last_snapshot_at = captured_at
        await session.flush()
        return existing

    # Create new
    new_stats = DataSourceStatsORM(
        data_source_id=ds_id,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
        schema_stats=schema_stats,
        ontology_metadata=ontology_metadata,
        graph_schema=graph_schema,
        schema_updated_at=now_iso,
        last_snapshot_at=captured_at,
    )
    session.add(new_stats)
    await session.flush()
    return new_stats


async def touch_schema_freshness(session: AsyncSession, ds_id: str) -> None:
    """Advance both freshness markers WITHOUT rewriting any data —
    used when a deep poll's cheap probe shows the graph is unchanged,
    so the expensive scans (and a pointless row rewrite) are skipped."""
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    existing.updated_at = now_iso
    existing.schema_updated_at = now_iso
    await session.flush()


async def invalidate_schema_facet(session: AsyncSession, ds_id: str) -> None:
    """Mark the deep schema facet stale after an ontology change.

    Resets ``graph_schema`` to the empty marker and clears
    ``schema_updated_at``. Two effects, both intended:

    * ``/cached-schema`` now MISSES on this row (``read_stats_cache``
      treats ``"{}"`` as a miss) and falls to ``build_synthetic_schema``,
      which re-resolves the live ontology — so the next read serves the
      correct containment/lineage edge types immediately.
    * ``schema_updated_at = NULL`` makes the scheduler's deep-due check
      (``_is_deep_due``) fire on its next tick, so ``collect_deep``
      rebuilds the full graph_schema (with instance counts) shortly after.

    Only the schema facet is touched — counts stay intact. No-op when the
    row doesn't exist yet (its first deep poll will build a fresh schema).
    """
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    existing.graph_schema = "{}"
    existing.schema_updated_at = None
    await session.flush()


async def invalidate_schema_facets(
    session: AsyncSession, ds_ids: Sequence[str],
) -> None:
    """Bulk :func:`invalidate_schema_facet` — one set-based UPDATE instead of
    a SELECT+UPDATE per source. Ontology writers invalidate every assigned
    data source at once; the per-row loop made that O(assignments) in DB
    round-trips (the publish 30s-hang bug). Same semantics: rows without a
    stats row are silently skipped (their first deep poll builds fresh)."""
    if not ds_ids:
        return
    from sqlalchemy import update

    await session.execute(
        update(DataSourceStatsORM)
        .where(DataSourceStatsORM.data_source_id.in_(list(ds_ids)))
        .values(graph_schema="{}", schema_updated_at=None)
    )
    await session.flush()


async def _capture_history(
    session: AsyncSession,
    ds_id: str,
    *,
    lane: str,
    node_count: int,
    edge_count: int,
    entity_type_counts: str,
    edge_type_counts: str,
    digest: str,
    previous: Optional[DataSourceStatsORM],
) -> Optional[str]:
    """Record this observation into ``data_source_count_snapshots``.

    Returns the snapshot's ``captured_at`` when one was written, else ``None``.
    The caller stamps that onto ``data_source_stats.last_snapshot_at`` — it
    owns the row in both the insert and the update branch, and on a first
    write the row does not exist yet for the capture to stamp.

    Called by BOTH upserts, and always BEFORE ``previous``'s count columns are
    overwritten — those values are the delta baseline. Capture is change-gated
    plus a heartbeat inside ``stats_history_repo``, so the 60s probe lane does
    not turn into 1,440 identical rows a day.

    In the caller's session on purpose. The alternative — a short session of
    its own, the way ``emit_refresh_event`` records audit rows — would let
    history land for a counts write that then rolled back. For an audit trail
    whose entire job is to be trusted about what the counts were, disagreeing
    with ``data_source_stats`` is worse than not being written: a capture
    failure fails the poll, and the poll is already retried.
    """
    from . import stats_history_repo

    policy = await stats_history_repo.resolve_history_policy(session)
    if not policy.enabled:
        return None
    snapshot = await stats_history_repo.maybe_capture_snapshot(
        session,
        ds_id=ds_id,
        lane=lane,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
        digest=digest,
        previous=previous,
        policy=policy,
    )
    return snapshot.captured_at if snapshot is not None else None


def _counts_digest(entity_type_counts: str, edge_type_counts: str) -> str:
    """Digest of the counts about to be written. The columns hold JSON text,
    so parse before hashing; an unparseable value hashes as empty, mirroring
    the sweeper's own read-side fallback."""
    from backend.app.services.aggregation.fingerprint import (
        counts_digest_from_counts,
    )

    try:
        entities = json.loads(entity_type_counts or "{}")
        edges = json.loads(edge_type_counts or "{}")
    except (TypeError, ValueError):
        entities, edges = {}, {}
    return counts_digest_from_counts(entities, edges)


async def upsert_data_source_stats_counts(
    session: AsyncSession,
    ds_id: str,
    node_count: int,
    edge_count: int,
    entity_type_counts: str,
    edge_type_counts: str,
    *,
    probed: bool = False,
    lane: str = "poll",
) -> DataSourceStatsORM:
    """Partial upsert — the cheap counts facet.

    Touches only the count columns + ``updated_at`` so a counts poll
    never clobbers (or waits on) the expensive schema/ontology/graph
    columns owned by the deep facet. On first contact (no row yet) the
    JSON columns fall back to their ``{}`` defaults until the first
    deep poll fills them.

    ``counts_digest`` hashes the counts being written (AGGREGATED
    included). Storing it alongside them is what lets the reconcile sweep
    detect movement with a SQL comparison instead of an evaluation pass.
    It is derived HERE rather than passed in: a caller that wrote changed
    counts without one left the row describing itself with the PREVIOUS
    digest, so the sweep's tripwire read "nothing moved" for counts that had
    just moved. Computing it beside the write makes that structural.

    ``probed`` stamps ``last_probed_at``, claiming this write for the probe
    lane's cadence. The stats poll leaves it alone: the two lanes run at
    different frequencies and must not reset each other's clock.

    ``lane`` names which collection lane observed these counts, carried onto
    the history snapshot this write may capture. It is a label, not a
    behaviour: nothing about the current-state row depends on it.
    """
    now = datetime.now(timezone.utc).isoformat()
    digest = _counts_digest(entity_type_counts, edge_type_counts)
    existing = await get_data_source_stats(session, ds_id)
    # Before the overwrite, for the same reason as the deep facet above.
    captured_at = await _capture_history(
        session, ds_id,
        lane=lane,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
        digest=digest,
        previous=existing,
    )
    if existing:
        existing.node_count = node_count
        existing.edge_count = edge_count
        existing.entity_type_counts = entity_type_counts
        existing.edge_type_counts = edge_type_counts
        existing.updated_at = now
        existing.counts_digest = digest
        if probed:
            existing.last_probed_at = now
        if captured_at:
            existing.last_snapshot_at = captured_at
        await session.flush()
        return existing

    new_stats = DataSourceStatsORM(
        data_source_id=ds_id,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
        counts_digest=digest,
        last_probed_at=now if probed else None,
        last_snapshot_at=captured_at,
    )
    session.add(new_stats)
    await session.flush()
    return new_stats


async def touch_probe_stamp(session: AsyncSession, ds_id: str) -> None:
    """Stamp ``last_probed_at`` without writing any counts.

    For probe attempts that cannot produce counts (no constant-time path on
    the provider, or a multi-label graph the counters cannot describe): the
    stamp takes the source out of the probe due-set for one interval, so it
    is retried once per interval instead of every scheduler tick — and starts
    answering the moment the provider can. UPDATE-only: fabricating a
    zero-count row here could read as a wiped overlay downstream. A source
    with no stats row stays due until its first poll creates one.
    """
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    existing.last_probed_at = datetime.now(timezone.utc).isoformat()
    # Pin the poll clock: ``updated_at`` carries ``onupdate``, and letting it
    # move on a stamp-only touch would make stale counts look freshly polled
    # (the stats_stale guard reads it). Explicitly including the current
    # value in the UPDATE keeps the hook from firing.
    flag_modified(existing, "updated_at")
    await session.flush()


async def set_top_level_nodes(session: AsyncSession, ds_id: str, payload_json: str) -> None:
    """Stamp the materialized top-level-nodes payload onto an existing row.

    Counts-lane helper: called right after ``upsert_data_source_stats_counts``
    in the same session, so the row is expected to already exist. No-ops if
    it's somehow missing (mirrors ``touch_schema_freshness``) rather than
    creating a bare row here.

    NOTE: the deep-lane ``upsert_data_source_stats`` intentionally never
    touches ``top_level_nodes``/``top_level_updated_at`` — these two columns
    are owned exclusively by the counts-lane materialization.
    """
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    existing.top_level_nodes = payload_json
    existing.top_level_updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()


async def touch_top_level_freshness(session: AsyncSession, ds_id: str) -> None:
    """Advance the top-level freshness marker WITHOUT rewriting the payload —
    used when the counts lane verifies the materialized ``top_level_nodes``
    payload is still current (fingerprint + digest match, not dirty), so the
    1-3MB payload is left untouched but its ``top_level_updated_at`` timestamp
    advances (the deep lane's ``touch_schema_freshness`` analog). No-ops if the
    row is missing (mirrors ``set_top_level_nodes``)."""
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    existing.top_level_updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
