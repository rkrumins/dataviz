"""Process-wide resolved-ontology cache — kills the per-request resolution tax.

``ContextEngine`` is constructed fresh on every request, so its instance-level
300s ontology cache never survives between requests. Before this module, EVERY
graph read re-ran the full resolution pipeline: provider introspection (4-5
Cypher queries, worst case a full edge scan), ``OntologyService.resolve``
(Postgres), ``ensure_indices`` (~40 idempotent CREATE INDEX round-trips), and
``_apply_source_alignment`` (a Postgres WRITE + commit). Measured live, that
fixed tax dominated cheap endpoints (e.g. /assignments/compute at 4.8s whose
own queries are trivial) and multiplied by RTT against managed FalkorDB.

This cache is keyed ``(workspace_id, data_source_id)`` and holds the finished
``(ResolvedOntology, SourceAlignment)`` pair. Freshness is a two-part check:

* **Generation** — Redis counter ``ontgen:{ws}:{ds}`` bumped by every mutation
  that can change resolution (ontology CRUD/publish/import, data-source
  ontology (re)assignment, vocabulary-alignment confirmation). Bumps
  invalidate ALL pods on their next lookup (one Redis GET), matching the
  GraphCache generation-bump pattern.
* **TTL backstop** (300s, same constant the per-engine cache used) — bounds
  staleness for mutations that bypass the app (direct DB edits, out-of-band
  imports) exactly like the per-engine cache always has.

On a hit the engine still re-injects the cached config into the (process-
cached) provider — those are cheap in-memory setters, and the injection
contract ("aliases always reset", provider configured before any direct
``engine.provider.*`` call) is preserved verbatim. What a hit SKIPS is the
introspection queries, the Postgres resolve, the DDL storm, and the
alignment persistence write.

Redis unavailable ⇒ lookups report "bypass" and the caller falls back to the
full per-request path (previous behaviour), never a hard failure.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Same backstop the per-engine cache used; a single knob on purpose.
TTL_SECS: float = 300.0

_GEN_PREFIX = "ontgen"


@dataclass
class _Entry:
    generation: int
    resolved: Any  # ResolvedOntology
    alignment: Any  # SourceAlignment | None
    ts: float


_entries: Dict[Tuple[str, str], _Entry] = {}


def _key(workspace_id: Optional[str], data_source_id: Optional[str]) -> Tuple[str, str]:
    return (workspace_id or "", data_source_id or "")


def _gen_key(workspace_id: Optional[str], data_source_id: Optional[str]) -> str:
    return f"{_GEN_PREFIX}:{workspace_id or '-'}:{data_source_id or '-'}"


def _redis():
    # Late import: keeps this module import-light for unit tests that stub it.
    from backend.app.services.aggregation.redis_client import get_redis

    return get_redis()


async def current_generation(
    workspace_id: Optional[str], data_source_id: Optional[str],
) -> Optional[int]:
    """The scope's invalidation counter; ``None`` = Redis unavailable
    (caller must bypass the shared cache and resolve fully)."""
    try:
        raw = await _redis().get(_gen_key(workspace_id, data_source_id))
        return int(raw) if raw else 0
    except Exception as exc:
        logger.debug(
            "ontology generation read failed (%s) — shared ontology cache bypassed", exc,
        )
        return None


async def lookup(
    workspace_id: Optional[str], data_source_id: Optional[str],
) -> Optional[Tuple[Any, Any]]:
    """``(resolved, alignment)`` on a generation-fresh, TTL-fresh hit; else None."""
    gen = await current_generation(workspace_id, data_source_id)
    if gen is None:
        return None
    entry = _entries.get(_key(workspace_id, data_source_id))
    if (
        entry is not None
        and entry.generation == gen
        and (time.monotonic() - entry.ts) < TTL_SECS
    ):
        return entry.resolved, entry.alignment
    return None


def store(
    workspace_id: Optional[str],
    data_source_id: Optional[str],
    generation: int,
    resolved: Any,
    alignment: Any,
) -> None:
    """Cache a finished resolution under the generation observed BEFORE the
    resolve began — a bump that raced the resolve leaves the entry stale and
    the next lookup re-resolves (never serves across an invalidation)."""
    _entries[_key(workspace_id, data_source_id)] = _Entry(
        generation=generation, resolved=resolved, alignment=alignment,
        ts=time.monotonic(),
    )


async def bump_ontology_generation(
    workspace_id: Optional[str], data_source_id: Optional[str],
) -> None:
    """Invalidate every pod's cached resolution for this scope. Local entry
    drops immediately; other pods notice on their next one-GET lookup."""
    _entries.pop(_key(workspace_id, data_source_id), None)
    try:
        await _redis().incr(_gen_key(workspace_id, data_source_id))
    except Exception as exc:
        logger.warning(
            "ontology generation bump failed for %s/%s (pods fall back to the "
            "%ss TTL backstop): %s",
            workspace_id, data_source_id, int(TTL_SECS), exc,
        )


async def bump_scopes(scopes) -> int:
    """Bump many ``(workspace_id, data_source_id)`` scopes in ONE Redis
    round-trip (pipeline of INCRs). Local entries drop immediately either way.

    This is the bulk form of :func:`bump_ontology_generation` — ontology
    writers (publish/update/import…) fan out to every assigned data source,
    and doing that as N awaited INCRs made publish latency O(assignments)
    (the 30s-hang bug for widely-assigned ontologies).
    """
    scopes = list(scopes)
    for ws_id, ds_id in scopes:
        _entries.pop(_key(ws_id, ds_id), None)
    if not scopes:
        return 0
    try:
        pipe = _redis().pipeline(transaction=False)
        for ws_id, ds_id in scopes:
            pipe.incr(_gen_key(ws_id, ds_id))
        await pipe.execute()
    except Exception as exc:
        logger.warning(
            "bulk ontology generation bump failed for %d scopes (pods fall "
            "back to the %ss TTL backstop): %s", len(scopes), int(TTL_SECS), exc,
        )
    return len(scopes)


async def bump_for_ontology(session, ontology_id: str) -> int:
    """Bump every data source that resolves through ``ontology_id`` (used by
    ontology CRUD/publish/import endpoints, which don't know the consuming
    data sources up front). Returns the number of scopes bumped."""
    try:
        from sqlalchemy import select

        from backend.app.db.models import WorkspaceDataSourceORM

        rows = (
            await session.execute(
                select(
                    WorkspaceDataSourceORM.workspace_id, WorkspaceDataSourceORM.id,
                ).where(WorkspaceDataSourceORM.ontology_id == ontology_id)
            )
        ).all()
    except Exception as exc:
        logger.warning(
            "could not enumerate data sources for ontology %s (pods fall back "
            "to the TTL backstop): %s", ontology_id, exc,
        )
        return 0
    return await bump_scopes([(ws_id, ds_id) for ws_id, ds_id in rows])


def drop_local(workspace_id: Optional[str], data_source_id: Optional[str]) -> None:
    """Drop this pod's entry only (no cross-pod bump) — used by the engine's
    instance-level ``invalidate_ontology_cache`` to keep both layers in step."""
    _entries.pop(_key(workspace_id, data_source_id), None)


def reset_for_tests() -> None:
    _entries.clear()
