"""Graph store topology: every node, every shard, and where each graph lives.

Four reads over one cached snapshot (``services.graph_store.topology``).
Gating differs by route on purpose: the whole fleet is an administrator's
view of the infrastructure, while a single graph's PLACEMENT is part of
reading a data source — the Freshness drawer and a source's profile show
"which node holds this" to anyone who may see the source at all. That gate
is any-workspace, so the placement handlers do the second half of it: the
source row is read under the caller's visible workspaces, an id outside them
is a 404 rather than a 403, and what ELSE shares the shard is administrators
only.

Nothing here dials a node per request. A refresh is the snapshot's job,
behind its TTL and its stampede lock, so a hundred concurrent viewers cost
one sweep.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from backend.app.auth.dependencies import get_permission_claims, requires
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.graph_store import topology
from backend.app.services.graph_store.schemas import (
    GraphPlacementResponse,
    GraphPlacementsResponse,
    GraphStoreInstance,
    GraphStoreTopologyResponse,
    PlacementBrief,
    ProviderTopologyResponse,
    ReadRouting,
)
from backend.app.services.graph_cache import CacheScope, get_graph_cache

from .aggregation import _require_ingestion_read

logger = logging.getLogger(__name__)

router = APIRouter()

_REQUIRE_SYSTEM_ADMIN = requires("system:admin")

#: A list surface asks for many placements at once; the cap keeps one
#: request from turning into an unbounded response.
_MAX_BATCH = 200

#: Workspace and data source ids, as the schema mints them (``ws_``/``ds_``
#: plus hex). Enforced on the refresh route because its two ids become a
#: Redis ``SCAN MATCH`` glob: the metacharacters are what turn "this source"
#: into "every source of every workspace".
_ID_PATTERN = r"^[A-Za-z0-9_-]+$"


#: How long Re-measure may hold for the sweep it just asked for. Under any
#: sane gateway timeout: the point of this is that the request returns.
_REMEASURE_WAIT_S = 3.0


async def _snapshot(fresh: bool = False) -> GraphStoreTopologyResponse:
    """The snapshot as it stands — never a sweep run inside the request.

    Reading every node of every store takes as long as the slowest node
    allows, which on a cluster mid-rotation is tens of seconds. No gateway
    holds a connection that long, so building here means the request dies
    with a 504 having done all of the work and kept none of it. Instead:
    take what is cached, ask for a refresh in the background, and say that
    one is running. The page polls every 30s and fills in.

    A stale reading is served happily — it says so — because figures from a
    minute ago tell an operator more than an empty page. Having nothing at
    all yet is not an error either: it is the first sweep, and saying so is
    more use than a 503.
    """
    snapshot, refreshing = await topology.snapshot_for_request(
        fresh=fresh, wait_s=_REMEASURE_WAIT_S if fresh else 0.0,
    )
    if snapshot is None:
        return GraphStoreTopologyResponse(
            measured_at=None, ttl_s=topology._ttl_s(), refreshing=True,
            last_error=topology.last_error(),
        )
    return snapshot.model_copy(update={"refreshing": refreshing})


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
    "/cache-stats",
    summary="Graph response-cache hit ratio, per data source and per endpoint",
    dependencies=[Depends(_REQUIRE_SYSTEM_ADMIN)],
)
async def get_cache_stats(
    workspaceId: str = Query(..., description="Workspace to report on"),
    dataSourceId: Optional[str] = Query(
        None, description="One data source; omitted reports the workspace",
    ),
    windowMinutes: int = Query(
        120, ge=5, le=120, description="How far back to aggregate",
    ),
) -> dict:
    """How much of the read load the cache is actually absorbing.

    The graph response cache is the largest single lever on read capacity —
    a hit costs one Redis round trip, a miss costs a canvas open's worth of
    Cypher on the shard replicas that serve that source. Until this existed
    the only way to answer "is it hitting?" was to read TTL constants and
    infer, which is how an endpoint caching for five seconds instead of an
    hour went unnoticed.

    ``hitRatio`` counts real hits only. A stale-fallback is reported beside
    it but never folded in: it kept the user moving while the provider could
    not answer, and counting it would make an outage read as a cache win.

    ``payload`` is how big the answers actually are, bucketed, beside the cap
    they are measured against. ``tooLarge`` already says whether an answer
    fit; nothing said BY HOW MUCH, and an answer that grows past the cap is
    deleted and never cached at all — so any change to what an endpoint
    returns is a change that can silently stop it caching, and this is the
    distribution that decides it.
    """
    from backend.app.services.graph_cache import read_cache_stats

    buckets = max(1, windowMinutes * 60 // 300)
    stats = await read_cache_stats(workspaceId, dataSourceId, buckets=buckets)
    return {
        "workspaceId": workspaceId,
        "dataSourceId": dataSourceId,
        "windowSeconds": stats.get("window_seconds"),
        "totals": stats.get("totals", {}),
        "endpoints": stats.get("endpoints", {}),
        "payloadCapBytes": stats.get("payload_cap_bytes"),
    }


@router.post(
    "/cache/refresh",
    summary="Drop a data source's cached reads so the next open rebuilds them",
    dependencies=[Depends(_REQUIRE_SYSTEM_ADMIN)],
)
async def refresh_cache(
    workspaceId: str = Query(
        ..., pattern=_ID_PATTERN, description="Workspace the source belongs to",
    ),
    dataSourceId: str = Query(
        ..., pattern=_ID_PATTERN, description="Data source to refresh",
    ),
    keepFallback: bool = Query(
        True,
        description=(
            "Keep the last-known-good snapshots. Leave this on unless you are "
            "clearing genuinely wrong data — the LKG is what answers a read "
            "while the provider cannot, and dropping it converts the next "
            "outage from a stale answer into an error."
        ),
    ),
) -> dict:
    """Make the next read of every view on this source rebuild from the store.

    This is a generation bump, not a delete: existing entries become
    unreachable immediately and expire on their own, so there is no window
    where some pods serve the old answer and others the new one. Every process
    sees the new generation on its next read. Only ``keepFallback=false`` adds
    a SCAN, over the one scope's last-known-good mirror.

    Both ids are pattern-bound because that scope is turned into a Redis
    ``SCAN MATCH`` glob: ``*`` in either of them would widen the purge from
    one source to every source of every workspace — and the endpoint would
    report success for it.

    Use it when something changed the graph WITHOUT going through the app —
    a direct GRAPH.QUERY, an external loader, a restore. Changes the app makes
    already bump the generation, and a completed aggregation run already
    invalidates through the event listener; neither needs this.

    The cost lands on whoever opens a view next: one cold rebuild per view, on
    the shard replicas serving that source. Refreshing a busy source during
    peak hours moves that cost onto users.
    """
    cache = get_graph_cache()
    scope = CacheScope(workspace_id=workspaceId, data_source_id=dataSourceId, branch_id="")
    await cache.bump_generation(scope)
    purged = 0
    if not keepFallback:
        purged = await cache.purge_lkg_scope(scope)
    logger.info(
        "graph cache refreshed for %s/%s by operator request (lkg purged: %d)",
        workspaceId, dataSourceId, purged,
    )
    return {
        "workspaceId": workspaceId,
        "dataSourceId": dataSourceId,
        "invalidated": True,
        "fallbackKept": keepFallback,
        "fallbackEntriesPurged": purged,
    }


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
        provider_id=provider_id, provider_name=name,
        instance=_nodes_only(instance),
        reads=_read_routing(provider_id),
        measured_at=snapshot.measured_at, cache_age_ms=snapshot.cache_age_ms,
        stale=snapshot.stale, last_error=snapshot.last_error,
    )


def _nodes_only(instance: GraphStoreInstance) -> GraphStoreInstance:
    """The instance's nodes and counts, without the graph inventory.

    What reads this route is a provider's topology line and its node list —
    counts, endpoints, health, replication. The inventory is up to
    ``MAX_GRAPH_ROWS_PER_SHARD`` rows per shard and no pixel here renders
    one, but the connections page draws a card per provider, so ten
    providers on one cluster would each download the whole thing. The
    totals it is summarised by are on the shard already.
    """
    return instance.model_copy(update={
        "shards": [
            shard.model_copy(update={"graphs": [], "rows_by_key": {}})
            for shard in instance.shards
        ],
    })


def _read_routing(provider_id: str) -> Optional[ReadRouting]:
    """How this pod's reads for ``provider_id`` were served — summed over the
    proxies already built here. A dict lookup: never builds a provider."""
    from backend.app.providers.manager import provider_manager

    totals = {"replicaReads": 0, "masterReads": 0, "replicaFallbacks": 0}
    seen = False
    for proxy in provider_manager.instantiated(provider_id):
        counters = getattr(proxy, "read_routing_counters", None)
        if counters is None:
            continue
        seen = True
        for key, value in counters().items():
            totals[key] = totals.get(key, 0) + int(value)
    if not seen:
        return None
    return ReadRouting(
        replica_reads=totals["replicaReads"],
        master_reads=totals["masterReads"],
        replica_fallbacks=totals["replicaFallbacks"],
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
    claims: PermissionClaims = Depends(get_permission_claims),
) -> GraphPlacementResponse:
    """By data source, or by ``providerId``+``graph`` for a catalogue-keyed
    view that holds a graph name rather than a data source id."""
    if not dataSourceId and not (providerId and graph):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pass dataSourceId, or providerId and graph.",
        )
    visible = _visible_workspace_ids(claims)
    snapshot = await _snapshot()
    if dataSourceId:
        ds = await _data_source(dataSourceId, visible)
        if ds is None:
            # 404 for "not yours" as well as "not there": the ingestion gate
            # is any-workspace, so an existence-revealing 403 would let one
            # tenant enumerate another's sources one id at a time.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Data source {dataSourceId} not found",
            )
        provider_id = str(getattr(ds, "provider_id", "") or "")
        keys = topology.placement_keys_for(ds)
    else:
        # Free-form: a graph name with no row behind it, so there is nothing
        # to check ownership against. Administrators only.
        _require_system_admin(claims)
        provider_id, keys = str(providerId), [("source", str(graph))]

    instance = topology.instance_for_provider(snapshot, provider_id)
    placements = [
        _redact(p, claims)
        for p in (
            topology.placement_for_graph(snapshot, provider_id, key, role=role)
            for role, key in keys
        )
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
    claims: PermissionClaims = Depends(get_permission_claims),
) -> GraphPlacementsResponse:
    ids = [i.strip() for i in dataSourceIds.split(",") if i.strip()][:_MAX_BATCH]
    snapshot = await _snapshot()
    # Ids the caller cannot see simply do not come back — the response is a
    # map, so a missing key is the same answer a deleted source gives.
    rows = await _data_sources(ids, _visible_workspace_ids(claims))
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


def _visible_workspace_ids(claims: PermissionClaims) -> Optional[set]:
    """The workspaces this caller may read a data source in; ``None`` when
    they may read every one.

    ``_require_ingestion_read`` grants on the permission being held in ANY
    workspace — its own docstring says the handler then filters to the
    caller's visible workspaces, and placement is where that filtering
    happens. Platform tiers only for the unrestricted answer, matching
    ``workspace_visibility.compute_visible_data_source_ids``: a workspace
    data source belongs to one workspace and is not a shared catalogue row,
    so ``system:org-viewer`` sees the workspaces it is bound to like anyone
    else.
    """
    if ("system:admin" in claims.global_perms
            or "system:org-admin" in claims.global_perms):
        return None
    return set(claims.ws_perms.keys())


def _require_system_admin(claims: PermissionClaims) -> None:
    if "system:admin" in claims.global_perms:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "missing_permission",
            "permission": "system:admin",
            "scope": {"type": "global", "id": None},
            "message": "Looking up a placement by graph name is administrators only",
        },
    )


def _redact(placement, claims: PermissionClaims):
    """Drop what shares the shard, unless the caller may see the fleet.

    ``siblings_sample`` names up to eight OTHER graphs on the same shard —
    their keys and their data sources' labels — and the shard a graph lands
    on is arithmetic, not tenancy. So for anyone but an administrator it is
    another tenant's row in a response about your own. The COUNT stays: "you
    are sharing with 40 others" is the part that explains a slow shard, and
    it names nobody.
    """
    if placement is None or "system:admin" in claims.global_perms:
        return placement
    return placement.model_copy(update={"siblings_sample": []})


async def _data_source(ds_id: str, workspace_ids: Optional[set]):
    rows = await _data_sources([ds_id], workspace_ids)
    return rows[0] if rows else None


async def _data_sources(ids, workspace_ids: Optional[set]):
    """The rows behind a placement question — read-only, one query.

    ``workspace_ids`` is the caller's visible set, or ``None`` for a platform
    tier that sees every workspace. An empty set is a real answer (a user
    bound to nothing) and must return nothing, not everything.
    """
    from sqlalchemy import select

    from backend.app.db.models import WorkspaceDataSourceORM

    if not ids or workspace_ids is not None and not workspace_ids:
        return []
    where = [
        WorkspaceDataSourceORM.id.in_(list(ids)),
        WorkspaceDataSourceORM.deleted_at.is_(None),
    ]
    if workspace_ids is not None:
        where.append(WorkspaceDataSourceORM.workspace_id.in_(list(workspace_ids)))
    factory = topology._session_factory()
    async with factory() as session:
        return list((await session.execute(
            select(WorkspaceDataSourceORM).where(*where)
        )).scalars().all())
