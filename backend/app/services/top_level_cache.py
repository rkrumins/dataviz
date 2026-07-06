"""Postgres-materialized "top-level nodes" payload for large graphs.

For data sources at/above ``resilience.STATS_POLL_LARGE_THRESHOLD`` nodes,
the live top-level/orphan query is too expensive to run per-request. The
insights counts lane (the collector) materializes a JSON payload —
displayName-sorted nodes, a fingerprint of the graph counts, and a digest
of the ontology's containment/root types — into
``DataSourceStatsORM.top_level_nodes``. The ``/top-level`` endpoint serves
pages out of that payload via :func:`try_serve_top_level` instead of
querying the provider directly.

Staleness contract: a served page is only as fresh as the last
materialization. ``should_rematerialize`` decides whether a stored payload
is still usable (matching schema version, count fingerprint, ontology
digest, and not flagged dirty); ``try_serve_top_level`` additionally
applies the stats-cache freshness tiers (fresh/stale/expired) to the
payload's write timestamp, enqueuing a background refresh on stale/expired
rows without necessarily blocking the read.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Dict, Iterable, Optional, Tuple

from backend.app.config import resilience
from backend.app.db.repositories.stats_repo import get_data_source_stats
from backend.app.services.aggregation.redis_client import get_redis
from backend.app.services.stats_cache import age_seconds, classify_tier, parse_iso
from backend.common.models.graph import GraphNode, TopLevelNodesResult
from backend.insights_service.enqueue import enqueue_stats_job_safe_ex

logger = logging.getLogger(__name__)

TOP_LEVEL_MATERIALIZE_LIMIT = 1000
_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

_FINGERPRINT_FIELDS = ("nodeCount", "edgeCount", "entityTypeCounts", "edgeTypeCounts")


def _dirty_key(ds_id: str) -> str:
    return f"insights:toplevel:dirty:{ds_id}"


def _kill_switch_enabled() -> bool:
    return os.getenv("TOP_LEVEL_SERVE_MATERIALIZED", "true").strip().lower() in (
        "1", "true", "yes", "on",
    )


def containment_digest(containment_types: Iterable[str], root_types: Iterable[str]) -> str:
    """Digest of the ontology shape that the materialized payload depends on.

    Order-insensitive and dedup'd — only the *set* of containment/root
    types matters, so a re-resolve that returns the same types in a
    different order does not spuriously invalidate the cache.
    """
    canonical = json.dumps(
        {
            "containment": sorted(set(containment_types or [])),
            "rootTypes": sorted(set(root_types or [])),
        },
        sort_keys=True,
    )
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()


def build_top_level_payload(result: TopLevelNodesResult, *, stats: dict, digest: str) -> str:
    """Serialize a materialization payload (schema documented in
    global-constraints: ``{v, digest, fingerprint, totalCount, truncated,
    nodes}``). Over-cap payloads are truncated to 200 nodes with
    ``truncated`` forced True — a single warning is logged."""
    fingerprint = {field: stats.get(field) for field in _FINGERPRINT_FIELDS}
    truncated = bool(result.has_more or len(result.nodes) < result.total_count)
    # try_serve_top_level keyset-slices this window assuming displayName-ASC;
    # enforce that invariant where the payload is built rather than trusting the
    # provider's ordering (defense-in-depth against the FalkorDB aggregating
    # ORDER-BY quirk). Same key the serve path compares the cursor on.
    ordered = sorted(result.nodes, key=lambda n: n.display_name or "")
    nodes = [n.model_dump(by_alias=True, mode="json") for n in ordered]

    payload: Dict[str, Any] = {
        "v": 1,
        "digest": digest,
        "fingerprint": fingerprint,
        "totalCount": result.total_count,
        "truncated": truncated,
        "nodes": nodes,
    }
    serialized = json.dumps(payload)
    if len(serialized) > _MAX_PAYLOAD_BYTES:
        logger.warning(
            "top_level_cache.build_payload oversized nodes=%d bytes=%d cap=%d — truncating to 200",
            len(nodes), len(serialized), _MAX_PAYLOAD_BYTES,
        )
        payload["nodes"] = nodes[:200]
        payload["truncated"] = True
        serialized = json.dumps(payload)
    return serialized


def should_rematerialize(
    stored_payload: Optional[dict], *, fresh_stats: dict, digest: str, dirty: bool,
) -> bool:
    """Pure decision: does the stored payload need to be rebuilt?"""
    if dirty:
        return True
    if not stored_payload:
        return True
    if stored_payload.get("v") != 1:
        return True
    fingerprint = stored_payload.get("fingerprint") or {}
    for field in _FINGERPRINT_FIELDS:
        if fingerprint.get(field) != fresh_stats.get(field):
            return True
    if stored_payload.get("digest") != digest:
        return True
    return False


async def consume_dirty_flag(ds_id: str) -> bool:
    """GETDEL the dirty flag for ``ds_id``. Best-effort: any Redis error
    is swallowed and treated as "not dirty"."""
    try:
        redis = get_redis()
        value = await redis.getdel(_dirty_key(ds_id))
        return value is not None
    except Exception as exc:
        logger.warning("top_level_cache.consume_dirty_flag ds=%s error=%s", ds_id, exc)
        return False


async def restore_dirty_flag(ds_id: str) -> None:
    """Re-set the dirty flag (e.g. after a consumed flag's rematerialize
    attempt failed, so the signal isn't lost). Best-effort no-op on error."""
    try:
        redis = get_redis()
        await redis.set(_dirty_key(ds_id), "1", ex=86400)
    except Exception as exc:
        logger.warning("top_level_cache.restore_dirty_flag ds=%s error=%s", ds_id, exc)


async def try_serve_top_level(
    session, engine, *, ds_id: str, ws_id: str, limit: int, cursor: Optional[str],
) -> Tuple[Optional[TopLevelNodesResult], Optional[int]]:
    """Attempt to serve a top-level-nodes page from the materialized payload.

    Returns ``(result, known_total)``. A non-None ``result`` should be
    served as-is; when ``result`` is None the caller must go live, passing
    ``known_total`` (which may itself be None) as ``known_total_count``.
    """
    def _outcome(name: str, result=None, total=None):
        logger.info("top_level_cache.serve ds=%s outcome=%s", ds_id, name)
        return result, total

    if not _kill_switch_enabled():
        return _outcome("miss_off")

    row = await get_data_source_stats(session, ds_id)
    if row is None:
        return _outcome("miss_no_row")

    if (row.node_count or 0) < resilience.STATS_POLL_LARGE_THRESHOLD:
        return _outcome("miss_small")

    raw = row.top_level_nodes
    if not raw:
        await enqueue_stats_job_safe_ex(ds_id, ws_id)
        return _outcome("miss_no_payload")

    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        await enqueue_stats_job_safe_ex(ds_id, ws_id)
        return _outcome("miss_no_payload")

    if payload.get("v") != 1:
        return _outcome("miss_version")

    resolved = await engine.get_resolved_ontology()
    if resolved is None:
        return _outcome("miss_ontology")

    digest = containment_digest(
        getattr(resolved, "containment_edge_types", None) or [],
        getattr(resolved, "root_entity_types", None) or [],
    )
    if digest != payload.get("digest"):
        await enqueue_stats_job_safe_ex(ds_id, ws_id)
        return _outcome("miss_digest")

    total = payload.get("totalCount")
    age = age_seconds(parse_iso(row.top_level_updated_at))
    tier = classify_tier(age)
    if tier == "expired":
        await enqueue_stats_job_safe_ex(ds_id, ws_id)
        return _outcome("miss_expired", total=total)
    if tier == "stale":
        await enqueue_stats_job_safe_ex(ds_id, ws_id)

    window = payload.get("nodes") or []
    filtered = (
        [n for n in window if n.get("displayName", "") > cursor]
        if cursor is not None else window
    )
    page = filtered[:limit]

    if not page:
        if payload.get("truncated"):
            return _outcome("miss_beyond_window", total=total)
        empty = TopLevelNodesResult(
            nodes=[], totalCount=total, hasMore=False, nextCursor=None,
            rootTypeCount=0, orphanCount=0,
        )
        return _outcome("stale_hit" if tier == "stale" else "hit", result=empty, total=total)

    root_types_set = {str(t) for t in (getattr(resolved, "root_entity_types", None) or [])}
    nodes = [GraphNode.model_validate(n) for n in page]
    root_type_count = 0
    orphan_count = 0
    for node in nodes:
        if root_types_set and str(node.entity_type) in root_types_set:
            root_type_count += 1
        else:
            orphan_count += 1

    has_more = len(filtered) > len(page) or bool(payload.get("truncated"))
    next_cursor = nodes[-1].display_name if has_more else None

    result = TopLevelNodesResult(
        nodes=nodes, totalCount=total, hasMore=has_more, nextCursor=next_cursor,
        rootTypeCount=root_type_count, orphanCount=orphan_count,
    )
    return _outcome("stale_hit" if tier == "stale" else "hit", result=result, total=total)
