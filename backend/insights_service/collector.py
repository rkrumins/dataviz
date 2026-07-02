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

from backend.app.db.engine import get_jobs_session
from backend.app.db.models import DataSourcePollingConfigORM, WorkspaceDataSourceORM
from backend.app.db.repositories.stats_repo import (
    upsert_data_source_stats,
    upsert_data_source_stats_counts,
)
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine

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
) -> tuple[Any, Any, str, Optional[Any]]:
    """One short JOBS session: build the workspace-scoped engine and
    resolve ``provider_id`` (admission-gate granularity). For the deep
    facet, also resolve ontology metadata while the session is open —
    it is an in-memory cache hit after the eager resolution inside
    ``for_workspace``, but a TTL re-resolve must never land on a closed
    session. Returns ``(engine, provider, provider_id, ontology_meta)``.
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

    return engine, provider, provider_id, ontology_meta


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
    _engine, provider, provider_id, _ = await _open_context(
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

    async with get_jobs_session() as session:
        await upsert_data_source_stats_counts(
            session=session,
            ds_id=envelope.data_source_id,
            node_count=node_count,
            edge_count=int(stats.get("edgeCount", 0) or 0),
            entity_type_counts=json.dumps(stats.get("entityTypeCounts", {})),
            edge_type_counts=json.dumps(stats.get("edgeTypeCounts", {})),
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


async def collect_deep(envelope: StatsJobEnvelope) -> None:
    """Deep facet — one ``get_schema_stats`` pass serves everything.

    Counts derive from its per-type summaries (same key expressions as
    ``get_stats`` — ``labels(n)[0] or "unknown"`` / ``type(r) or
    "UNKNOWN"`` — so the persisted dicts are byte-identical), and the
    graph schema is built from it without re-fetching. The old shape ran
    ``get_schema_stats`` TWICE (once directly, once inside
    ``get_graph_schema``) plus ``get_stats``' two more scans.
    """
    engine, provider, provider_id, ontology_meta = await _open_context(
        envelope, resolve_ontology=True,
    )

    async with admission.gate(provider_id, op_kind="stats_deep"):
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


# Self-register both facets. The worker dispatches by envelope kind;
# ``stats_poll`` keeps its wire format from before the split, so
# in-flight messages from a previous release drain through the counts
# handler harmlessly (idempotent refresh).
from . import dispatcher  # noqa: E402

dispatcher.register_handler("stats_poll", collect_counts)
dispatcher.register_handler("stats_deep", collect_deep)
