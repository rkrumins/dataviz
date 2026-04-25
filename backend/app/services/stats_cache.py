"""Cache-only read helpers for graph introspection endpoints.

The web tier reads ``data_source_stats`` exclusively — provider
introspection is owned by the stats service. This module holds the
shared machinery every cache-only handler uses:

* ``read_stats_cache`` — tier classification + fire-and-forget refresh
* ``build_synthetic_schema`` — ontology-only fallback so the canvas
  renders even when the cache is cold
* ``classify_stats_service_health`` — drives the X-Stats-Service-Status
  response header so the frontend can surface "updates paused"
* ``build_computing_response_body`` — 202 envelope for cache-miss

Handlers never call the provider; they never have a code path that can
take longer than a single PK lookup. The consequence is that any
provider-side pathology (10-minute MATCH on a 1M-node graph) becomes a
stats-service concern, not a web-tier concern, and 504s become
impossible by construction.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.app.db.models import DataSourcePollingConfigORM
from backend.app.db.repositories import data_source_repo
from backend.app.db.repositories.stats_repo import get_data_source_stats
from backend.stats_service.enqueue import enqueue_stats_job_safe

logger = logging.getLogger(__name__)


CacheTier = Literal["fresh", "stale", "expired"]
StatsFieldName = Literal["node_stats", "schema_stats", "ontology_metadata", "graph_schema"]
StatsServiceStatus = Literal["healthy", "lagging", "unreachable", "unknown"]


class CacheMiss(Exception):
    """Raised when the cache row is absent, past absolute expiry, or has unparseable JSON.

    Handlers translate this to either a synthetic-from-ontology response
    (for schema endpoints) or a 202 Accepted (for stats endpoints).
    Crucially it is NOT translated to a 500 — a corrupt row is a cache
    miss, not a server error.
    """


# ── timestamp helpers ──────────────────────────────────────────────

def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _age_seconds(ts: Optional[datetime]) -> Optional[int]:
    if not ts:
        return None
    return max(0, int((datetime.now(timezone.utc) - ts).total_seconds()))


def _classify_tier(age_secs: Optional[int]) -> CacheTier:
    if age_secs is None:
        return "expired"
    if age_secs <= resilience.STATS_CACHE_FRESH_SECS:
        return "fresh"
    if age_secs >= resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS:
        return "expired"
    return "stale"


# ── stats-service health classification ────────────────────────────

async def classify_stats_service_health(
    session: AsyncSession, ds_id: str,
) -> tuple[StatsServiceStatus, Optional[str]]:
    """Classify the stats service's behavior for this data source.

    Reads ``data_source_polling_configs``. The staleness of
    ``last_polled_at`` reveals whether the stats worker is keeping up.
    Returns the status plus the last error (if any) so the caller can
    surface it via ``X-Provider-Health``.
    """
    result = await session.execute(
        select(DataSourcePollingConfigORM).where(
            DataSourcePollingConfigORM.data_source_id == ds_id
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        return "unknown", None
    last_polled = _parse_iso(row.last_polled_at)
    age = _age_seconds(last_polled)
    last_error = row.last_error
    if age is None:
        return "unknown", last_error
    if age <= resilience.STATS_SERVICE_LAGGING_THRESHOLD_SECS:
        return "healthy", last_error
    if age <= resilience.STATS_SERVICE_UNREACHABLE_THRESHOLD_SECS:
        return "lagging", last_error
    return "unreachable", last_error


# ── response headers ────────────────────────────────────────────────

def _build_freshness_headers(
    updated_at_iso: Optional[str],
    tier: CacheTier,
    *,
    refreshing: bool,
    service_status: StatsServiceStatus,
    provider_health: str,
) -> dict:
    """Build the X-Cache-*, X-Stats-Service-Status, X-Provider-Health headers.

    Called only after CacheMiss has been ruled out — ``tier`` is always
    ``fresh`` or ``stale`` here.
    """
    headers: dict = {
        "X-Cache-Source": "postgres",
        "X-Cache-Tier": tier,
        "X-Stats-Service-Status": service_status,
        "X-Provider-Health": provider_health,
    }
    if updated_at_iso:
        headers["X-Cache-Updated-At"] = updated_at_iso
        age = _age_seconds(_parse_iso(updated_at_iso))
        if age is not None:
            headers["X-Cache-Age-Seconds"] = str(age)
    if tier == "stale":
        headers["X-Cache-Stale"] = "true"
    if refreshing:
        headers["X-Cache-Refreshing"] = "true"
    return headers


# ── primary read helper ─────────────────────────────────────────────

async def read_stats_cache(
    session: AsyncSession,
    ds_id: str,
    ws_id: Optional[str],
    field: StatsFieldName,
) -> tuple[dict, dict]:
    """Read a field from ``data_source_stats`` with freshness classification.

    Returns ``(payload, headers)`` on fresh/stale hits. Raises
    :class:`CacheMiss` when the row is absent, the requested field is
    empty, the JSON is unparseable, or the row is past absolute expiry.

    On a ``stale`` hit, fires a best-effort background refresh via
    :func:`enqueue_stats_job_safe`. If Redis is down the enqueue
    silently fails; the handler still returns the stale cached data —
    Redis outage must not degrade the read path.
    """
    cache = await get_data_source_stats(session, ds_id)
    if not cache:
        logger.info("stats_cache.read ds_id=%s outcome=miss reason=no_row", ds_id)
        raise CacheMiss("no cache row for data source")

    updated_at = _parse_iso(cache.updated_at)
    age = _age_seconds(updated_at)
    tier = _classify_tier(age)
    if tier == "expired":
        logger.info("stats_cache.read ds_id=%s outcome=miss reason=expired age=%s", ds_id, age)
        raise CacheMiss("cache row past absolute expiry")

    # Extract the requested field. node_stats composes the four legacy
    # columns into the shape the deprecated /graph/stats endpoint emits.
    try:
        if field == "node_stats":
            payload: dict = {
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
            payload = json.loads(raw)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        logger.warning(
            "stats_cache.read ds_id=%s field=%s outcome=corrupt error=%s",
            ds_id, field, exc,
        )
        raise CacheMiss(f"corrupt JSON in {field}: {exc}") from exc

    # Fire-and-forget refresh if stale. enqueue_stats_job_safe already
    # swallows Redis failures — the extra try/except here is belt-and-
    # braces in case a future edit reintroduces a raise path.
    refreshing = False
    if tier == "stale" and ws_id:
        try:
            msg_id = await enqueue_stats_job_safe(ds_id, ws_id)
            refreshing = True  # Either we enqueued, or dedup held → work is coming
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

    headers = _build_freshness_headers(
        cache.updated_at, tier,
        refreshing=refreshing,
        service_status=service_status,
        provider_health=provider_health,
    )
    logger.info(
        "stats_cache.read ds_id=%s field=%s tier=%s service=%s refreshing=%s",
        ds_id, field, tier, service_status, refreshing,
    )
    return payload, headers


# ── synthetic schema from ontology ──────────────────────────────────

async def build_synthetic_schema(
    session: AsyncSession, ds_id: str,
) -> Optional[dict]:
    """Build a minimal GraphSchema from the data source's assigned ontology.

    Cache-miss fallback for ``/metadata/schema`` and ``/cached-schema``:
    the canvas renders with correct entity/relationship types (zero
    counts) while the real schema computes in the background.

    Returns ``None`` when no ontology is assigned or resolution fails —
    callers then fall through to 202. The returned dict matches the
    frontend's ``GraphSchema`` contract with ``ontologyDigest: None``,
    which the ViewWizard treats as "skip drift check" rather than
    raising a false positive.
    """
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or not ds.ontology_id:
        return None

    try:
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService

        repo = SQLAlchemyOntologyRepository(session)
        svc = LocalOntologyService(repo)
        resolved = await svc.resolve(ds.ontology_id, ds_id)
    except Exception as exc:
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


def synthetic_schema_headers() -> dict:
    """Headers attached to a synthetic-from-ontology schema response."""
    return {
        "X-Cache-Source": "ontology-synthetic",
        "X-Cache-Tier": "expired",
        "X-Cache-Refreshing": "true",
    }


# ── 202 envelope ────────────────────────────────────────────────────

def build_computing_response_body(ds_id: str, ws_id: Optional[str], msg_id: Optional[str]) -> dict:
    """Build the 202 Accepted body for cache-miss responses.

    ``msg_id`` comes from ``enqueue_stats_job_safe``. ``None`` means one
    of: dedup claim already held (another job is in flight) OR Redis is
    unreachable. The frontend treats both identically — poll and retry.
    """
    job_id = msg_id or f"dedup:{ds_id}"
    poll_prefix = f"/api/v1/{ws_id}/graph" if ws_id else "/api/v1/graph"
    return {
        "status": "computing" if msg_id else "already_computing",
        "jobId": job_id,
        "dataSourceId": ds_id,
        "pollUrl": f"{poll_prefix}/introspection/refresh/{job_id}",
    }
