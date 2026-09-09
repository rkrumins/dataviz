"""Graph store topology: every node, every shard, and where each graph lives.

Four reads over one cached snapshot (``services.graph_store.topology``).
Gating differs by route on purpose: the whole fleet is an administrator's
view of the infrastructure, while a single graph's PLACEMENT is part of
reading a data source — the Freshness drawer and a source's profile show
"which node holds this" to anyone who may see the source at all.

Nothing here dials a node per request. A refresh is the snapshot's job,
behind its TTL and its stampede lock, so a hundred concurrent viewers cost
one sweep.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from backend.app.auth.dependencies import requires
from backend.app.services.graph_store import topology
from backend.app.services.graph_store.schemas import (
    GraphPlacementResponse,
    GraphPlacementsResponse,
    GraphStoreTopologyResponse,
    PlacementBrief,
    ProviderTopologyResponse,
)
from .aggregation import _require_ingestion_read

logger = logging.getLogger(__name__)

router = APIRouter()

_REQUIRE_SYSTEM_ADMIN = requires("system:admin")

#: A list surface asks for many placements at once; the cap keeps one
#: request from turning into an unbounded response.
_MAX_BATCH = 200


async def _snapshot(fresh: bool = False) -> GraphStoreTopologyResponse:
    """The snapshot, or a 503 when there has never been one.

    A stale reading is served happily — it says so — because figures from a
    minute ago tell an operator more than an empty page. Only the case with
    nothing at all to show is an error.
    """
    try:
        return await topology.get_topology_snapshot(fresh=fresh)
    except Exception as exc:                          # noqa: BLE001 — reported as 503
        logger.warning("graph store: no topology to serve: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "GRAPH_STORE_TOPOLOGY_UNAVAILABLE",
                "message": "The graph store topology could not be read.",
                "reason": (str(exc) or exc.__class__.__name__)[:200],
            },
        ) from exc


@router.get(
    "/topology",
    response_model=GraphStoreTopologyResponse,
    response_model_by_alias=True,
    summary="Every graph store node: shards, replicas, memory, replication and graphs",
    dependencies=[Depends(_REQUIRE_SYSTEM_ADMIN)],
)
async def get_topology(fresh: bool = Query(False)) -> GraphStoreTopologyResponse:
    return await _snapshot(fresh=fresh)


@router.get(
    "/providers/{provider_id}",
    response_model=ProviderTopologyResponse,
    response_model_by_alias=True,
    summary="One provider's graph store: its nodes and how they are replicating",
    dependencies=[Depends(_REQUIRE_SYSTEM_ADMIN)],
)
async def get_provider_topology(
    provider_id: str, fresh: bool = Query(False),
) -> ProviderTopologyResponse:
    snapshot = await _snapshot(fresh=fresh)
    instance = topology.instance_for_provider(snapshot, provider_id)
    if instance is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(f"Provider {provider_id} is not an active graph store provider, "
                    f"or its store has not been read yet."),
        )
    name = next((p.name for p in instance.providers if p.id == provider_id), None)
    return ProviderTopologyResponse(
        provider_id=provider_id, provider_name=name, instance=instance,
        measured_at=snapshot.measured_at, cache_age_ms=snapshot.cache_age_ms,
        stale=snapshot.stale, last_error=snapshot.last_error,
    )


@router.get(
    "/placement",
    response_model=GraphPlacementResponse,
    response_model_by_alias=True,
    summary="Which node holds one data source's graph (and its projection graph)",
    dependencies=[Depends(_require_ingestion_read)],
)
async def get_placement(
    dataSourceId: Optional[str] = Query(None),
    providerId: Optional[str] = Query(None),
    graph: Optional[str] = Query(None),
) -> GraphPlacementResponse:
    """By data source, or by ``providerId``+``graph`` for a catalogue-keyed
    view that holds a graph name rather than a data source id."""
    if not dataSourceId and not (providerId and graph):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pass dataSourceId, or providerId and graph.",
        )
    snapshot = await _snapshot()
    if dataSourceId:
        ds = await _data_source(dataSourceId)
        if ds is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Data source {dataSourceId} not found",
            )
        provider_id = str(getattr(ds, "provider_id", "") or "")
        keys = topology.placement_keys_for(ds)
    else:
        provider_id, keys = str(providerId), [("source", str(graph))]

    instance = topology.instance_for_provider(snapshot, provider_id)
    placements = [
        topology.placement_for_graph(snapshot, provider_id, key, role=role)
        for role, key in keys
    ]
    return GraphPlacementResponse(
        data_source_id=dataSourceId,
        provider_id=provider_id,
        provider_name=next((p.name for p in (instance.providers if instance else [])
                            if p.id == provider_id), None),
        instance_id=instance.id if instance else None,
        mode=instance.mode if instance else "standalone",
        reachable=bool(instance and instance.reachable),
        error=(instance.error if instance else
               "this provider's graph store has not been read"),
        placements=[p for p in placements if p is not None],
        totals=instance.totals if instance else GraphPlacementResponse().totals,
        measured_at=snapshot.measured_at, cache_age_ms=snapshot.cache_age_ms,
        stale=snapshot.stale,
    )


@router.get(
    "/placements",
    response_model=GraphPlacementsResponse,
    response_model_by_alias=True,
    summary="Where several data sources' graphs live — one chip's worth each",
    dependencies=[Depends(_require_ingestion_read)],
)
async def get_placements(
    dataSourceIds: str = Query(..., description="Comma-separated data source ids"),
) -> GraphPlacementsResponse:
    ids = [i.strip() for i in dataSourceIds.split(",") if i.strip()][:_MAX_BATCH]
    snapshot = await _snapshot()
    rows = await _data_sources(ids)
    out = {}
    for ds in rows:
        provider_id = str(getattr(ds, "provider_id", "") or "")
        keys = topology.placement_keys_for(ds)
        if not keys:
            continue
        # The source graph is the one a list surface labels a row with.
        _role, key = keys[0]
        instance = topology.instance_for_provider(snapshot, provider_id)
        shard, _slot = topology.place(instance, key)
        row = topology.graph_row(instance, shard, key)
        out[ds.id] = PlacementBrief(
            graph_key=key,
            shard_index=shard.index if shard else None,
            master=shard.master.endpoint if shard else None,
            status=shard.master.status if shard else None,
            present=bool(row.present) if row else False,
        )
    return GraphPlacementsResponse(
        placements=out, measured_at=snapshot.measured_at,
        cache_age_ms=snapshot.cache_age_ms, stale=snapshot.stale,
    )


async def _data_source(ds_id: str):
    rows = await _data_sources([ds_id])
    return rows[0] if rows else None


async def _data_sources(ids):
    """The rows behind a placement question — read-only, one query."""
    from sqlalchemy import select

    from backend.app.db.models import WorkspaceDataSourceORM

    if not ids:
        return []
    factory = topology._session_factory()
    async with factory() as session:
        return list((await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id.in_(list(ids)),
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalars().all())
