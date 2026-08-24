"""Per-data-source stats collection — two facets, two job kinds.

* ``stats_poll`` (:func:`collect_counts`, fast worker lane) — the cheap
  counts facet: node/edge counts + per-type breakdowns via two grouped
  scans, partial-upserted so counts freshness never waits on schema
  work. Triggered by the scheduler interval, read-path stale enqueues,
  and app write paths (``enqueue.mark_stats_changed``).
* ``stats_deep`` (:func:`collect_deep`, heavy worker lane) — ONE
  ``get_schema_stats`` pass (labels+samples, edge-type, tags scans)
  serves the counts derivation AND the graph-schema build (pre-fetched
  injection into ``get_graph_schema``); full-row upsert stamps
  ``schema_updated_at``.

Session discipline (the rule documented in ``backend/app/db/engine.py``:
never hold a DB session across an outbound network call): each handler
opens a first short JOBS session to resolve the provider, closes it,
runs the provider queries with no session held, then opens a second
short session for the upsert. The caller owns timeout wrapping
(``asyncio.wait_for``).
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from backend.app.config import resilience
from backend.app.db.engine import get_jobs_session
from backend.app.db.models import DataSourcePollingConfigORM, WorkspaceDataSourceORM
from backend.app.db.repositories.stats_repo import (
    touch_probe_stamp,
    touch_schema_freshness,
    upsert_data_source_stats,
    upsert_data_source_stats_counts,
)
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine
from backend.app.services.top_level_cache import (
    TOP_LEVEL_MATERIALIZE_LIMIT,
    build_top_level_payload,
    consume_dirty_flag,
    containment_digest,
    restore_dirty_flag,
    should_rematerialize,
)

from . import admission
from .schemas import StatsJobEnvelope

logger = logging.getLogger(__name__)


# Parity tripwire: when enabled, each deep poll ALSO runs the provider's
# direct count scans and logs any divergence from the schema-stats-
# derived counts. Costs two extra full scans per poll — enable for one
# release when validating the derivation (e.g. after a provider
# upgrade), keep off otherwise.
_COUNTS_PARITY_CHECK = (
    os.getenv("INSIGHTS_COUNTS_PARITY_CHECK", "0").lower() in ("1", "true")
)


async def _open_context(
    envelope: StatsJobEnvelope, *, resolve_ontology: bool,
) -> tuple[Any, Any, str, Optional[Any], Optional[Any]]:
    """One short JOBS session: build the workspace-scoped engine and
    resolve ``provider_id`` (admission-gate granularity). Also capture
    the resolved ontology (containment / root types) while the session
    is open — the counts lane needs it to build the top-level
    materialization digest. For the deep facet, additionally resolve the
    flat ontology metadata. Both ontology reads are in-memory cache hits
    after the eager resolution inside ``for_workspace``, but a TTL
    re-resolve must never land on a closed session. The resolved-ontology
    capture is best-effort (warning + None on failure) so counts never
    fail because ontology resolution did. Returns
    ``(engine, provider, provider_id, ontology_meta, resolved)``.
    """
    async with get_jobs_session() as session:
        engine = await ContextEngine.for_workspace(
            workspace_id=envelope.workspace_id,
            registry=provider_registry,
            session=session,
            data_source_id=envelope.data_source_id,
        )
        provider = engine.provider

        # Look up provider_id so the admission gate can throttle at the
        # right granularity. ContextEngine.for_workspace already loaded
        # the row, so this hits the session's identity map.
        ds_row = await session.get(WorkspaceDataSourceORM, envelope.data_source_id)
        # A job enqueued before the source was deleted is still on the stream;
        # without this it would poll the provider for a deleted data source.
        if ds_row is not None and ds_row.deleted_at is not None:
            raise RuntimeError(
                f"Data source {envelope.data_source_id} has been deleted — poll rejected."
            )
        provider_id = (
            ds_row.provider_id if ds_row is not None else envelope.data_source_id
        )

        ontology_meta = None
        if resolve_ontology:
            # Eager ontology resolution in for_workspace logs a warning
            # and continues on failure, leaving the provider's sentinel
            # flag unset. Surface that upfront so the poll fails with a
            # specific message instead of a cryptic mid-fetch traceback.
            if getattr(provider, "_resolved_containment_types_set", True) is False:
                raise RuntimeError(
                    f"Provider for ds={envelope.data_source_id} is unconfigured — "
                    "ontology resolution failed during ContextEngine.for_workspace. "
                    "Check the scheduler log for the preceding warning."
                )
            ontology_meta = await engine.get_ontology_metadata()

        # Best-effort: the counts lane materializes the top-level payload
        # only when this resolves, and must not fail when it doesn't.
        resolved = None
        try:
            resolved = await engine.get_resolved_ontology()
        except Exception as exc:
            logger.warning(
                "_open_context: resolved-ontology capture failed for ds=%s: %s",
                envelope.data_source_id, exc,
            )

    return engine, provider, provider_id, ontology_meta, resolved


async def _stamp_poll_success(session, data_source_id: str) -> None:
    config = await session.get(DataSourcePollingConfigORM, data_source_id)
    if config is not None:
        config.last_polled_at = datetime.now(timezone.utc).isoformat()
        config.last_status = "success"
        config.last_error = None


async def collect_counts(envelope: StatsJobEnvelope) -> None:
    """Cheap counts facet — two grouped-count scans.

    ``bypass_cache=True`` so the poll never READS the provider's 300s
    stats cache (persisting pre-aged counts as fresh was a correctness
    bug); the provider still write-through primes that cache on the way
    out, so discovery / web-tier callers get poll-fresh values.
    """
    engine, provider, provider_id, _, resolved = await _open_context(
        envelope, resolve_ontology=False,
    )

    async with admission.gate(provider_id, op_kind="stats_poll"):
        try:
            stats = await provider.get_stats(bypass_cache=True)
        except TypeError:
            # Provider without the bypass flag (non-FalkorDB) — its own
            # cache semantics apply.
            stats = await provider.get_stats()

    node_count = int(stats.get("nodeCount", 0) or 0)
    entity_counts = stats.get("entityTypeCounts", {}) or {}
    edge_counts = stats.get("edgeTypeCounts", {}) or {}

    async with get_jobs_session() as session:
        await upsert_data_source_stats_counts(
            session=session,
            ds_id=envelope.data_source_id,
            node_count=node_count,
            edge_count=int(stats.get("edgeCount", 0) or 0),
            entity_type_counts=json.dumps(entity_counts),
            edge_type_counts=json.dumps(edge_counts),
            lane="poll",
        )
        await _stamp_poll_success(session, envelope.data_source_id)

    # The session scope above committed — warm the UI entry caches with
    # the freshly-written row visible.
    from . import cache_warmer
    cache_warmer.schedule_warm(
        ws_id=envelope.workspace_id,
        ds_id=envelope.data_source_id,
        node_count=node_count,
    )

    # Large graphs: materialize the top-level-nodes payload so the
    # /top-level endpoint serves pages out of Postgres instead of running
    # the expensive live roots query per request. Fully isolated from the
    # counts write above — a roots-query failure must never lose counts.
    await materialize_top_level(
        engine=engine, envelope=envelope, stats=stats, resolved=resolved,
        provider_id=provider_id, node_count=node_count,
    )


async def materialize_top_level(
    *, engine, envelope: StatsJobEnvelope, stats: dict, resolved,
    provider_id: str, node_count: int,
) -> None:
    """Materialize the top-level-nodes payload for a large graph.

    Shared by both collection lanes so a freshly profiled data source
    gets its payload on the first deep profile instead of waiting for
    the counts cadence. Change-detected against the stored payload's
    fingerprint + a Redis dirty flag so steady-state polls do zero
    extra provider work. Never raises — materialization is an
    optimization, not a correctness dependency.
    """
    if node_count >= resilience.STATS_POLL_LARGE_THRESHOLD and resolved is not None:
        from backend.app.db.repositories.stats_repo import (
            get_data_source_stats,
            set_top_level_nodes,
            touch_top_level_freshness,
        )
        dirty = False
        try:
            async with get_jobs_session() as session:
                stored = await get_data_source_stats(session, envelope.data_source_id)
                raw = stored.top_level_nodes if stored is not None else None
            stored_payload = None
            if raw:
                try:
                    stored_payload = json.loads(raw)
                except (TypeError, ValueError):
                    stored_payload = None

            dirty = await consume_dirty_flag(envelope.data_source_id)
            digest = containment_digest(
                getattr(resolved, "containment_edge_types", None) or [],
                getattr(resolved, "root_entity_types", None) or [],
            )
            if not should_rematerialize(
                stored_payload, fresh_stats=stats, digest=digest, dirty=dirty,
            ):
                # Verified unchanged — advance freshness like the deep lane's
                # unchanged path (touch_schema_freshness), timestamp-only. Without
                # this the timestamp only ever moved on a real rematerialize, so a
                # stable large graph aged past the serve path's absolute-expiry
                # tier and every request fell back to the live O(N) scan this
                # feature exists to avoid. No provider work here → short session.
                async with get_jobs_session() as session:
                    await touch_top_level_freshness(session, envelope.data_source_id)
                logger.debug(
                    "top_level_materialize.skip ds=%s — payload current",
                    envelope.data_source_id,
                )
            else:
                # Second, separate admission acquisition. The roots query
                # runs with NO DB session held (session discipline: never
                # hold a session across provider IO); the admission gate
                # from the counts fetch above is already released.
                async with admission.gate(provider_id, op_kind="stats_poll"):
                    result = await engine.get_top_level_or_orphan_nodes(
                        limit=TOP_LEVEL_MATERIALIZE_LIMIT,
                        include_child_count=True,
                        query_timeout=resilience.STATS_POLL_TIMEOUT_LARGE_SECS,
                    )
                # Fail-safe against a mid-query ontology re-resolve. The roots
                # query internally re-resolves the ontology (300s TTL), which the
                # preceding counts scan + admission wait can outlast on big
                # graphs. A lapse re-resolves — possibly to a fallback
                # introspection ontology with different containment/root types —
                # under which the roots result was built, while `digest` still
                # reflects the pre-query ontology. Recompute post-query (a cache
                # hit in the normal case) and, if it moved, skip the write so we
                # never persist nodes stamped with a digest that doesn't match the
                # ontology they were computed under; the next poll retries.
                post_resolved = await engine.get_resolved_ontology()
                post_digest = containment_digest(
                    getattr(post_resolved, "containment_edge_types", None) or [],
                    getattr(post_resolved, "root_entity_types", None) or [],
                )
                if post_digest != digest:
                    logger.warning(
                        "top_level_materialize.ontology_shifted ds=%s — digest "
                        "changed mid-query (pre=%s post=%s), skipping persist",
                        envelope.data_source_id, digest, post_digest,
                    )
                    if dirty:
                        await restore_dirty_flag(envelope.data_source_id)
                else:
                    payload_json = build_top_level_payload(
                        result, stats=stats, digest=digest,
                    )
                    async with get_jobs_session() as session:
                        await set_top_level_nodes(
                            session, envelope.data_source_id, payload_json,
                        )
                    # Seed the Redis count side-cache so even live-path
                    # unfiltered requests (e.g. before the Redis response
                    # cache warms) skip the O(N) count scan. Params shape
                    # MUST match the endpoint's count_params for the
                    # unfiltered case. Best-effort.
                    if result.total_count is not None:
                        try:
                            from backend.app.services.graph_cache import (
                                CacheScope,
                                get_graph_cache,
                            )
                            await get_graph_cache().set_top_level_count(
                                CacheScope(
                                    workspace_id=envelope.workspace_id,
                                    data_source_id=envelope.data_source_id,
                                ),
                                {"entityTypes": None, "searchQuery": None},
                                result.total_count,
                            )
                        except Exception as exc:
                            logger.warning(
                                "top_level_materialize.count_seed_failed ds=%s: %s",
                                envelope.data_source_id, exc,
                            )
                    logger.info(
                        "top_level_materialize.done ds=%s totalCount=%s nodes=%d truncated=%s",
                        envelope.data_source_id, result.total_count, len(result.nodes),
                        result.has_more
                        or (result.total_count is not None
                            and len(result.nodes) < result.total_count),
                    )
        except Exception as exc:
            logger.warning(
                "top_level_materialize.failed ds=%s: %s",
                envelope.data_source_id, exc,
            )
            if dirty:
                await restore_dirty_flag(envelope.data_source_id)


async def collect_deep(envelope: StatsJobEnvelope) -> None:
    """Deep facet — one ``get_schema_stats`` pass serves everything.

    Counts derive from its per-type summaries (same key expressions as
    ``get_stats`` — ``labels(n)[0] or "unknown"`` / ``type(r) or
    "UNKNOWN"`` — so the persisted dicts are byte-identical), and the
    graph schema is built from it without re-fetching.

    CHANGE DETECTION: before the heavy scan set, a cheap counts probe
    is compared against the stored row — identical per-type counts mean
    the graph hasn't changed, so the samples/tags scans and schema
    rebuild are SKIPPED and only the freshness markers advance. At
    hundreds of graphs this is the difference between the deep sweep
    re-profiling everything every interval and it costing two grouped
    scans per unchanged graph (near-zero with INSIGHTS_FAST_COUNTS).
    """
    engine, provider, provider_id, ontology_meta, resolved = await _open_context(
        envelope, resolve_ontology=True,
    )

    async with get_jobs_session() as session:
        from backend.app.db.repositories.stats_repo import get_data_source_stats
        stored = await get_data_source_stats(session, envelope.data_source_id)
        stored_counts = None
        # An emptied ``graph_schema`` means an ontology change invalidated the
        # schema facet (see ``invalidate_schema_facet``). Never short-circuit on
        # unchanged counts in that case — the counts didn't move but the ontology
        # (containment/lineage edge types) did, so the schema MUST be rebuilt.
        if (
            stored is not None
            and stored.schema_stats and stored.schema_stats != "{}"
            and stored.graph_schema and stored.graph_schema != "{}"
        ):
            try:
                stored_counts = {
                    "nodeCount": stored.node_count,
                    "edgeCount": stored.edge_count,
                    # Parsed (not string-compared): row order from the
                    # provider scans is not stable across runs.
                    "entityTypeCounts": json.loads(stored.entity_type_counts or "{}"),
                    "edgeTypeCounts": json.loads(stored.edge_type_counts or "{}"),
                }
            except (TypeError, ValueError):
                stored_counts = None

    async with admission.gate(provider_id, op_kind="stats_deep"):
        if stored_counts is not None:
            try:
                probe = await provider.get_stats(bypass_cache=True)
            except TypeError:
                probe = await provider.get_stats()
            if (
                probe.get("nodeCount") == stored_counts["nodeCount"]
                and probe.get("edgeCount") == stored_counts["edgeCount"]
                and probe.get("entityTypeCounts", {}) == stored_counts["entityTypeCounts"]
                and probe.get("edgeTypeCounts", {}) == stored_counts["edgeTypeCounts"]
            ):
                logger.info(
                    "stats_deep.unchanged ds=%s — counts identical, skipping "
                    "schema scans", envelope.data_source_id,
                )
                async with get_jobs_session() as session:
                    await touch_schema_freshness(session, envelope.data_source_id)
                    await _stamp_poll_success(session, envelope.data_source_id)
                return

        schema_stats = await provider.get_schema_stats()
        graph_schema = await engine.get_graph_schema(
            stats=schema_stats, ontology=ontology_meta,
        )
        if _COUNTS_PARITY_CHECK:
            await _log_counts_parity(provider, schema_stats, envelope.data_source_id)

    node_count = schema_stats.total_nodes
    stats_payload = {
        "nodeCount": node_count,
        "edgeCount": schema_stats.total_edges,
        "entityTypeCounts": {s.id: s.count for s in schema_stats.entity_type_stats},
        "edgeTypeCounts": {s.id: s.count for s in schema_stats.edge_type_stats},
    }

    # Write-through prime of the provider-side stats cache so per-asset
    # discovery and web-tier get_stats callers serve poll-fresh counts.
    prime = getattr(provider, "prime_stats_cache", None)
    if prime is not None:
        await prime(stats_payload)

    async with get_jobs_session() as session:
        await upsert_data_source_stats(
            session=session,
            ds_id=envelope.data_source_id,
            node_count=node_count,
            edge_count=stats_payload["edgeCount"],
            entity_type_counts=json.dumps(stats_payload["entityTypeCounts"]),
            edge_type_counts=json.dumps(stats_payload["edgeTypeCounts"]),
            schema_stats=schema_stats.model_dump_json(by_alias=True),
            ontology_metadata=ontology_meta.model_dump_json(by_alias=True),
            graph_schema=graph_schema.model_dump_json(by_alias=True),
            lane="deep",
        )
        # Deep genuinely refreshed the counts too — stamping the polling
        # config resets the counts cadence so the two facets don't
        # double-poll back to back.
        await _stamp_poll_success(session, envelope.data_source_id)

    from . import cache_warmer
    cache_warmer.schedule_warm(
        ws_id=envelope.workspace_id,
        ds_id=envelope.data_source_id,
        node_count=node_count,
    )

    # A freshly profiled large data source should be servable from the
    # materialized payload immediately — don't wait for the counts lane.
    # Same change-detection as the counts lane, so an unchanged payload
    # costs one Postgres read.
    await materialize_top_level(
        engine=engine, envelope=envelope, stats=stats_payload,
        resolved=resolved, provider_id=provider_id, node_count=node_count,
    )


async def _log_counts_parity(provider, schema_stats, ds_id: str) -> None:
    try:
        live = await provider.get_stats(bypass_cache=True)
    except TypeError:
        # Provider without the bypass_cache param — cached read is fine
        # for a diagnostic.
        live = await provider.get_stats()
    except Exception as exc:
        logger.warning("counts_parity.check_failed ds=%s: %s", ds_id, exc)
        return
    if (
        live.get("nodeCount") != schema_stats.total_nodes
        or live.get("edgeCount") != schema_stats.total_edges
    ):
        logger.warning(
            "counts_parity.MISMATCH ds=%s derived_nodes=%d live_nodes=%s "
            "derived_edges=%d live_edges=%s",
            ds_id, schema_stats.total_nodes, live.get("nodeCount"),
            schema_stats.total_edges, live.get("edgeCount"),
        )


async def record_failure(data_source_id: str, error: str) -> None:
    """Write an error into the polling config — used by the worker after
    a failed poll of either facet (per-source, not crash-level). Opens
    its own short JOBS session so the worker doesn't manage one."""
    async with get_jobs_session() as session:
        config = await session.get(DataSourcePollingConfigORM, data_source_id)
        if config is None:
            return
        config.last_status = "error"
        config.last_error = error[:2000]
        config.last_polled_at = datetime.now(timezone.utc).isoformat()


async def probe_counts(envelope: StatsJobEnvelope) -> None:
    """Drift probe — the counts facet with no scan behind it.

    ``get_counts_fast`` answers from FalkorDB's label/relation counters, so
    this costs milliseconds where :func:`collect_counts` costs a full scan.
    That difference is the entire reason drift detection can run on a 60s
    cadence while the counts poll stays at 900s.

    Deliberately narrower than the counts poll: no top-level
    materialization, no cache warming, no polling-config lifecycle. Those
    belong to the poll that owns them, and loading them here would give the
    tripwire the cost profile it exists to avoid.

    When the provider cannot answer cheaply this SKIPS rather than falling
    back to a scan — a non-FalkorDB provider, or a graph whose multi-label
    nodes make per-label counts non-equivalent. Running the scan here would
    put minutes of work in a lane budgeted for milliseconds and blow the
    probe's fixed timeout. Such a source simply keeps the behaviour it has
    today: the stats poll refreshes it on the usual interval, and the sweep's
    own check interval remains the correctness backstop. The probe is an
    accelerator, never a dependency.
    """
    _engine, provider, provider_id, _, _ = await _open_context(
        envelope, resolve_ontology=False,
    )

    fast = getattr(provider, "get_counts_fast", None)
    if fast is None:
        logger.debug(
            "probe: %s has no constant-time counts — leaving it to the poll",
            envelope.data_source_id,
        )
        # Stamp without counts, or the NULL last_probed_at sorts this source
        # to the head of the due-set and it is re-enqueued every scheduler
        # tick forever, spending the batch cap on sources that cannot answer.
        async with get_jobs_session() as session:
            await touch_probe_stamp(session, envelope.data_source_id)
        return

    async with admission.gate(provider_id, op_kind="probe"):
        stats = await fast()

    if stats is None:
        logger.info(
            "probe: %s cannot be counted from counters — leaving it to the poll",
            envelope.data_source_id,
        )
        async with get_jobs_session() as session:
            await touch_probe_stamp(session, envelope.data_source_id)
        return

    entity_counts = stats.get("entityTypeCounts", {}) or {}
    edge_counts = stats.get("edgeTypeCounts", {}) or {}

    async with get_jobs_session() as session:
        await upsert_data_source_stats_counts(
            session=session,
            ds_id=envelope.data_source_id,
            node_count=int(stats.get("nodeCount", 0) or 0),
            edge_count=int(stats.get("edgeCount", 0) or 0),
            entity_type_counts=json.dumps(entity_counts),
            edge_type_counts=json.dumps(edge_counts),
            probed=True,
            lane="probe",
        )


# Self-register every facet. The worker dispatches by envelope kind;
# ``stats_poll`` keeps its wire format from before the split, so
# in-flight messages from a previous release drain through the counts
# handler harmlessly (idempotent refresh).
from . import dispatcher  # noqa: E402

dispatcher.register_handler("stats_poll", collect_counts)
dispatcher.register_handler("stats_deep", collect_deep)
dispatcher.register_handler("probe", probe_counts)
