"""Cache-only read helpers for graph introspection endpoints.

Every cache-reading endpoint emits the same envelope shape:

    {
      "data": <payload-or-null>,
      "meta": {
        "status": "fresh"|"stale"|"computing"|"partial"|"error",
        "source": "postgres"|"ontology"|"none"|"error",
        "age_seconds": int|null,
        "ttl_seconds": int|null,
        "missing_fields": [str, ...],
        "stats_service_status": "healthy"|"lagging"|"unreachable"|"unknown",
        "provider_health": "healthy"|"unreachable"|"unknown",
        "refreshing": bool,
        "data_source_id": str,
        # Optional, only present on cache-miss / partial:
        "job_id"?: str,
        "poll_url"?: str,
        "updated_at"?: str ISO,
      }
    }

The status code is **always 200** — the response body itself communicates
state. This unifies the frontend parser (one shape regardless of cache
state, no special 202 handling) and keeps frontends that mishandle
non-200 codes from breaking on a cold cache.

Status values:
* ``fresh``     — cached row younger than ``STATS_CACHE_FRESH_SECS``
* ``stale``     — cached row older than fresh threshold but within
                  ``STATS_CACHE_ABSOLUTE_EXPIRY_SECS``; refresh enqueued
* ``partial``   — synthetic schema served from ontology only
* ``computing`` — no cache row, no synthetic available; job enqueued
* ``error``     — backend dependency unavailable (DB, etc.)

Provider introspection happens only inside the stats service. The web
tier never has a code path that calls the provider, so 504s on
graph-size-driven slowness are impossible by construction.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.app.db.models import DataSourcePollingConfigORM
from backend.app.db.repositories import data_source_repo
from backend.app.db.repositories.stats_repo import get_data_source_stats
from backend.insights_service.enqueue import enqueue_stats_job_safe

logger = logging.getLogger(__name__)


CacheStatus = Literal["fresh", "stale", "computing", "partial", "error"]
CacheSource = Literal["postgres", "ontology", "none", "error"]
StatsFieldName = Literal["node_stats", "schema_stats", "ontology_metadata", "graph_schema"]
StatsServiceStatus = Literal["healthy", "lagging", "unreachable", "unknown"]


class CacheMiss(Exception):
    """Raised when the cache row is absent, past absolute expiry, or has unparseable JSON.

    Handlers translate this to either a synthetic-from-ontology response
    (status ``partial``) or a ``computing`` envelope. Crucially it is
    NOT translated to a 5xx — a corrupt row is a cache miss, not a
    server error.
    """


# ── timestamp + freshness helpers ───────────────────────────────────
#
# These four primitives are the public freshness-classification API
# used by every cache-reading endpoint. They are intentionally NOT
# underscore-prefixed: handlers that need to assemble composite
# envelopes (e.g. /cached-stats reading multiple fields in one call)
# need to invoke this machinery directly instead of going through
# read_stats_cache, which is single-field.

def parse_iso(ts: Optional[str]) -> Optional[datetime]:
    """Parse an ISO timestamp; assume UTC if naïve. Returns None on bad input."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def age_seconds(ts: Optional[datetime]) -> Optional[int]:
    """Seconds since ``ts``, clamped to ≥ 0. Returns None when ts is None."""
    if not ts:
        return None
    return max(0, int((datetime.now(timezone.utc) - ts).total_seconds()))


def classify_tier(age_secs: Optional[int]) -> Literal["fresh", "stale", "expired"]:
    """Map an age (seconds) to one of three freshness tiers.

    * ``fresh``   — within ``STATS_CACHE_FRESH_SECS``
    * ``stale``   — past fresh but within ``STATS_CACHE_ABSOLUTE_EXPIRY_SECS``
    * ``expired`` — past absolute expiry, OR age unknown
    """
    if age_secs is None:
        return "expired"
    if age_secs <= resilience.STATS_CACHE_FRESH_SECS:
        return "fresh"
    if age_secs >= resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS:
        return "expired"
    return "stale"


def ttl_seconds(age_secs: Optional[int]) -> Optional[int]:
    """Time until cached data crosses the freshness boundary.

    For ``fresh`` rows: positive countdown until staleness. For ``stale``
    rows: 0 (already past freshness, refresh recommended). For unknown
    age: ``None``.
    """
    if age_secs is None:
        return None
    return max(0, resilience.STATS_CACHE_FRESH_SECS - age_secs)


# ── stats-service health classification ────────────────────────────

async def classify_stats_service_health(
    session: AsyncSession, ds_id: str,
) -> tuple[StatsServiceStatus, Optional[str]]:
    """Classify the stats service's behavior for this data source.

    The staleness of ``data_source_polling_configs.last_polled_at``
    reveals whether the stats worker is keeping up. Returns ``(status,
    last_error)`` so the caller can surface both ``stats_service_status``
    and ``provider_health`` in the envelope ``meta``.
    """
    result = await session.execute(
        select(DataSourcePollingConfigORM).where(
            DataSourcePollingConfigORM.data_source_id == ds_id
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        return "unknown", None
    age = age_seconds(parse_iso(row.last_polled_at))
    last_error = row.last_error
    if age is None:
        return "unknown", last_error
    if age <= resilience.STATS_SERVICE_LAGGING_THRESHOLD_SECS:
        return "healthy", last_error
    if age <= resilience.STATS_SERVICE_UNREACHABLE_THRESHOLD_SECS:
        return "lagging", last_error
    return "unreachable", last_error


# ── envelope builders ──────────────────────────────────────────────

def build_meta(
    *,
    status: CacheStatus,
    source: CacheSource,
    data_source_id: str,
    age_seconds: Optional[int] = None,
    ttl_seconds: Optional[int] = None,
    missing_fields: Optional[list[str]] = None,
    stats_service_status: StatsServiceStatus = "unknown",
    provider_health: str = "unknown",
    refreshing: bool = False,
    job_id: Optional[str] = None,
    poll_url: Optional[str] = None,
    updated_at: Optional[str] = None,
) -> dict:
    """Build the ``meta`` block of every cache response envelope.

    The five required keys (``status``, ``source``, ``age_seconds``,
    ``ttl_seconds``, ``missing_fields``) are always present even when
    null — the frontend can rely on a stable shape and unconditional
    field access.
    """
    meta: dict[str, Any] = {
        "status": status,
        "source": source,
        "age_seconds": age_seconds,
        "ttl_seconds": ttl_seconds,
        "missing_fields": list(missing_fields) if missing_fields else [],
        "data_source_id": data_source_id,
        "stats_service_status": stats_service_status,
        "provider_health": provider_health,
        "refreshing": refreshing,
    }
    if job_id is not None:
        meta["job_id"] = job_id
    if poll_url is not None:
        meta["poll_url"] = poll_url
    if updated_at is not None:
        meta["updated_at"] = updated_at
    return meta


def build_envelope(data: Optional[Any], meta: dict) -> dict:
    """Wrap a payload + meta dict into the canonical response envelope.

    Always returned with HTTP 200 — state lives in ``meta.status``.
    """
    return {"data": data, "meta": meta}


def build_computing_envelope(
    ds_id: str,
    ws_id: Optional[str],
    msg_id: Optional[str],
    *,
    missing_fields: Optional[list[str]] = None,
) -> dict:
    """Convenience: build a ``status=computing`` envelope for cache-miss responses.

    ``msg_id`` is the Redis stream message ID from
    ``enqueue_stats_job_safe``. ``None`` covers both "dedup claim
    already held" (another job in flight) and "Redis unreachable" — the
    frontend treats both identically (poll and retry).
    """
    job_id = msg_id or f"dedup:{ds_id}"
    poll_url = f"/api/v1/{ws_id}/graph/introspection/refresh/{job_id}" if ws_id else None
    meta = build_meta(
        status="computing",
        source="none",
        data_source_id=ds_id,
        missing_fields=missing_fields or [],
        refreshing=True,
        job_id=job_id,
        poll_url=poll_url,
    )
    return build_envelope(None, meta)


def build_error_envelope(ds_id: str, *, reason: str) -> dict:
    """Envelope for "backend dependency unavailable" — used when DB read fails.

    Frontends keep their last-known good data (React Query
    ``placeholderData`` or persister) and back off retrying based on
    ``meta.status == "error"``.
    """
    return build_envelope(
        None,
        build_meta(
            status="error",
            source="error",
            data_source_id=ds_id,
            missing_fields=[reason],
        ),
    )


# ── primary read helper ────────────────────────────────────────────

async def read_stats_cache(
    session: AsyncSession,
    ds_id: str,
    ws_id: Optional[str],
    field: StatsFieldName,
) -> tuple[Optional[dict], dict]:
    """Read one field from ``data_source_stats`` and classify freshness.

    Returns ``(data, meta)`` where ``data`` is the parsed JSON payload
    on a fresh/stale hit. Raises :class:`CacheMiss` when the row is
    absent, the requested field is empty, the JSON is unparseable, or
    the row is past absolute expiry.

    On a ``stale`` hit, fires a best-effort background refresh via
    :func:`enqueue_stats_job_safe`. If Redis is down the enqueue
    silently fails; the read still returns the stale data — Redis
    outage must not degrade the read path.
    """
    cache = await get_data_source_stats(session, ds_id)
    if not cache:
        logger.info("stats_cache.read ds_id=%s outcome=miss reason=no_row", ds_id)
        raise CacheMiss("no cache row for data source")

    age = age_seconds(parse_iso(cache.updated_at))
    tier = classify_tier(age)
    if tier == "expired":
        logger.info("stats_cache.read ds_id=%s outcome=miss reason=expired age=%s", ds_id, age)
        raise CacheMiss("cache row past absolute expiry")

    # Extract the requested field. node_stats composes the four legacy
    # columns into the shape the deprecated /graph/stats endpoint emits.
    try:
        if field == "node_stats":
            data: dict = {
                "nodeCount": cache.node_count or 0,
                "edgeCount": cache.edge_count or 0,
                "entityTypeCounts": json.loads(cache.entity_type_counts) if cache.entity_type_counts else {},
                "edgeTypeCounts": json.loads(cache.edge_type_counts) if cache.edge_type_counts else {},
            }
        else:
            raw = {
                "schema_stats": cache.schema_stats,
                "ontology_metadata": cache.ontology_metadata,
                "graph_schema": cache.graph_schema,
            }[field]
            if not raw or raw == "{}":
                logger.info(
                    "stats_cache.read ds_id=%s field=%s outcome=miss reason=empty_field",
                    ds_id, field,
                )
                raise CacheMiss(f"field {field} is empty")
            data = json.loads(raw)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        logger.warning(
            "stats_cache.read ds_id=%s field=%s outcome=corrupt error=%s",
            ds_id, field, exc,
        )
        raise CacheMiss(f"corrupt JSON in {field}: {exc}") from exc

    # Best-effort background refresh on stale.
    refreshing = False
    if tier == "stale" and ws_id:
        try:
            msg_id = await enqueue_stats_job_safe(ds_id, ws_id)
            refreshing = True
            logger.info(
                "stats_cache.enqueue ds_id=%s outcome=%s",
                ds_id, "enqueued" if msg_id else "dedup_or_redis_down",
            )
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "stats_cache.enqueue ds_id=%s outcome=unexpected_error error=%s",
                ds_id, exc,
            )

    service_status, last_error = await classify_stats_service_health(session, ds_id)
    provider_health = "unreachable" if last_error else "healthy"

    meta = build_meta(
        status="fresh" if tier == "fresh" else "stale",
        source="postgres",
        data_source_id=ds_id,
        age_seconds=age,
        ttl_seconds=ttl_seconds(age),
        missing_fields=[],
        stats_service_status=service_status,
        provider_health=provider_health,
        refreshing=refreshing,
        updated_at=cache.updated_at,
    )
    logger.info(
        "stats_cache.read ds_id=%s field=%s tier=%s service=%s refreshing=%s",
        ds_id, field, tier, service_status, refreshing,
    )
    return data, meta


# ── synthetic schema from ontology ──────────────────────────────────

async def build_synthetic_schema(
    session: AsyncSession, ds_id: str,
) -> Optional[dict]:
    """Build a minimal GraphSchema from the data source's assigned ontology.

    Cache-miss fallback for ``/metadata/schema`` and ``/cached-schema``:
    the canvas renders with correct entity/relationship types (zero
    counts) while the real schema computes in the background.

    Returns ``None`` when no ontology is assigned or resolution fails —
    callers then emit ``status=computing`` instead. The returned dict
    matches the frontend ``GraphSchema`` contract with
    ``ontologyDigest: None``, which the ViewWizard treats as "skip
    drift check" rather than raising a false positive.
    """
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or not ds.ontology_id:
        return None

    # ``LocalOntologyService.resolve`` takes (workspace_id, data_source_id) —
    # not ontology_id. The repo's underlying query filters on
    # ``WorkspaceDataSourceORM.workspace_id``; passing the ontology_id here
    # would silently match nothing and fall back to system defaults,
    # producing a synthetic schema that doesn't reflect the assigned
    # ontology at all. Use keyword args to make the contract obvious.
    try:
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService

        repo = SQLAlchemyOntologyRepository(session)
        svc = LocalOntologyService(repo)
        resolved = await svc.resolve(workspace_id=ds.workspace_id, data_source_id=ds_id)
    except (ValueError, KeyError, AttributeError) as exc:
        logger.warning(
            "build_synthetic_schema: ontology resolve failed ds_id=%s error=%s",
            ds_id, exc,
        )
        return None

    if not resolved or not resolved.entity_type_definitions:
        return None

    entity_types: list[dict] = []
    for ent_id, ent_def in resolved.entity_type_definitions.items():
        default_plural = (ent_def.name + "s") if ent_def.name else (ent_id.title() + "s")
        entity_types.append({
            "id": ent_id,
            "name": ent_def.name or ent_id.title(),
            "pluralName": ent_def.plural_name or default_plural,
            "description": ent_def.description or f"Entity type: {ent_id}",
            "visual": {
                "icon": ent_def.visual.icon,
                "color": ent_def.visual.color,
                "shape": ent_def.visual.shape,
                "size": ent_def.visual.size,
                "borderStyle": ent_def.visual.border_style,
                "showInMinimap": ent_def.visual.show_in_minimap,
            },
            "fields": [
                {
                    "id": f.id, "name": f.name, "type": f.type,
                    "required": f.required,
                    "showInNode": f.show_in_node, "showInPanel": f.show_in_panel,
                    "showInTooltip": f.show_in_tooltip, "displayOrder": f.display_order,
                }
                for f in ent_def.fields
            ] or [
                {
                    "id": "name", "name": "Name", "type": "string", "required": True,
                    "showInNode": True, "showInPanel": True, "showInTooltip": True, "displayOrder": 1,
                },
            ],
            "hierarchy": {
                "level": ent_def.hierarchy.level,
                "canContain": ent_def.hierarchy.can_contain,
                "canBeContainedBy": ent_def.hierarchy.can_be_contained_by,
                "defaultExpanded": ent_def.hierarchy.default_expanded,
            },
            "behavior": {
                "selectable": ent_def.behavior.selectable,
                "draggable": ent_def.behavior.draggable,
                "expandable": ent_def.behavior.expandable,
                "traceable": ent_def.behavior.traceable,
                "clickAction": ent_def.behavior.click_action,
                "doubleClickAction": ent_def.behavior.double_click_action,
            },
        })

    relationship_types: list[dict] = []
    for rel_id, rel_def in resolved.relationship_type_definitions.items():
        relationship_types.append({
            "id": rel_id.lower(),
            "name": rel_def.name or rel_id.title(),
            "description": rel_def.description or f"Relationship type: {rel_id}",
            "sourceTypes": rel_def.source_types,
            "targetTypes": rel_def.target_types,
            "visual": {
                "strokeColor": rel_def.visual.stroke_color,
                "strokeWidth": rel_def.visual.stroke_width,
                "strokeStyle": rel_def.visual.stroke_style,
                "animated": rel_def.visual.animated,
                "animationSpeed": rel_def.visual.animation_speed,
                "arrowType": rel_def.visual.arrow_type,
                "curveType": rel_def.visual.curve_type,
            },
            "bidirectional": rel_def.bidirectional,
            "showLabel": rel_def.show_label,
            "isContainment": rel_def.is_containment,
            "isLineage": rel_def.is_lineage,
            "category": rel_def.category,
        })

    logger.info(
        "stats_cache.read ds_id=%s source=ontology-synthetic entity_types=%d rel_types=%d",
        ds_id, len(entity_types), len(relationship_types),
    )
    return {
        "version": "1.0.0",
        "entityTypes": entity_types,
        "relationshipTypes": relationship_types,
        "rootEntityTypes": resolved.root_entity_types,
        "containmentEdgeTypes": resolved.containment_edge_types,
        "lineageEdgeTypes": resolved.lineage_edge_types,
        "ontologyDigest": None,
    }


# Fields that a synthetic-from-ontology schema cannot fill in — surfaced
# in the envelope ``meta.missing_fields`` so the frontend knows zero
# counts mean "we haven't measured the live graph yet" rather than "the
# real graph has zero of these."
SYNTHETIC_SCHEMA_MISSING_FIELDS = ["entityCounts", "edgeCounts"]
