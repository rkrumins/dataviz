"""Platform administration of the versioned graphs' FalkorDB projections, under
``/admin/versioning``: the disaster-recovery reseed of a provider, the fleet inventory, and moving
one graph's projection to another provider or key.

Every route needs ``system:admin``. None is on the API-key surface (``auth/api_key_surface``), so
an API key is refused.
"""
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import data_source_repo
from backend.app.providers import falkor_graph_registry
from backend.app.services import managed_sources
from backend.app.services.activity import recorder
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.graph_store.topology import key_slot
from backend.app.services.system_status import probes
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning import keymigrate
from backend.app.services.versioning.errors import (JobActive, ProjectionKeyInUse,
                                                    ProjectionKeyInvalid, ProjectionNotAdopted)
from backend.app.services.versioning.service import ConcurrencyError
from backend.auth_service.interface import User

from .versioning import _domain_errors, _watermark_model, get_versioning_service, rebuild_now

router = APIRouter()


class WatermarkResetRequest(BaseModel):
    provider: str = Field(..., min_length=1,
                          description="FalkorDB provider id; 'default' for the env instance")
    dry_run: bool = Field(False, alias="dryRun",
                          description="Count the graphs it would reseed, and change nothing")


@router.post("/watermarks/reset",
             summary="Reseed every versioned graph on a FalkorDB provider from Postgres")
async def reset_watermarks(
    body: WatermarkResetRequest,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Run after restoring a FalkorDB instance or shard, or rebuilding a region: its keys may
    hold an older state than the platform's watermarks say, and graphs projected before pass
    markers existed cannot tell. Every live versioned graph on the provider is reseeded in place
    by the projection worker; reads fall back to Postgres until each one catches up. A dry run
    answers how many that is, for the confirm, and is not recorded."""
    ids = await get_versioning_service().reset_projection_watermarks(
        provider=body.provider, actor=user.id, dry_run=body.dry_run)
    if body.dry_run:
        return {"provider": body.provider, "graphsToReset": len(ids)}
    await recorder.record_for_request(
        session, "platform.versioning.watermarks_reset",
        details={"provider": body.provider, "graphsReset": len(ids)},
        best_effort=True,   # the watermarks are already reset
    )
    return {"provider": body.provider, "graphsReset": len(ids)}


@router.get("/graphs",
            summary="Every versioned graph with its FalkorDB provider, key and projection state")
async def list_graphs(
    provider: Optional[str] = Query(
        None, min_length=1, description="FalkorDB provider id; 'default' for the env instance"),
    status: Optional[Literal["fresh", "lagging", "projecting", "rebuilding", "evicted",
                             "failed"]] = None,
    workspace_id: Optional[str] = Query(None, alias="workspaceId", min_length=1),
    kind: Optional[Literal["main", "fork", "orphan"]] = None,
    q: Optional[str] = Query(None, min_length=1, max_length=200),
    cursor: Optional[str] = Query(None, max_length=200,
                                  description="The previous page's nextCursor"),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(requires("system:admin")),
) -> dict:
    """The fleet inventory: one page of every versioned graph, by graph id, including the forks
    and orphans the Infrastructure projection rollup leaves out — so the ninth failing graph, a
    fork's key or a graph whose data source was deleted can be found and acted on."""
    return await probes.list_versioned_graphs(
        provider=provider, status=status, workspace_id=workspace_id, kind=kind, q=q,
        cursor=cursor, limit=limit)


class ProjectionMoveRequest(BaseModel):
    provider_id: str = Field(..., alias="providerId", min_length=1,
                             description="The FalkorDB provider to move the projection to")
    key: Optional[str] = Field(None, max_length=200,
                               description="This graph's platform key on it, or one of its "
                                           "retired keys to move back; omitted, a new one")


@router.post("/graphs/{graph_id}/projection/move",
             summary="Move a versioned graph's projection to another FalkorDB provider or key")
async def move_projection(
    graph_id: str,
    body: ProjectionMoveRequest,
    background: BackgroundTasks,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """A reseed move (doc 14 §6 KeyMigration, phase 1): the graph's projection is pinned to the
    new key and reseeded there from Postgres, which serves its reads until the new key catches
    up. The old key is dropped once it has, after a grace period; until then a move back onto
    it is cheap. Only keys the platform owns move; the customer's own graph, and a key other
    data sources read, are refused. Without ``key`` the graph's first free platform key on the
    provider is used, and a graph already on one there is left as it is (``changed: false``)."""
    svc = get_versioning_service()
    meta = await svc.get_graph(graph_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"unknown graph {graph_id}")
    wm = await svc.projection_watermark(graph_id)
    pin = wm["falkor_graph_name"]
    # Refused before any lookup; the service checks again under the graph lock.
    if pin in (None, f"gv_{graph_id}"):
        raise ProjectionNotAdopted("unpinned")
    if not wm["owns_falkor_graph"]:
        raise ProjectionNotAdopted("customer_key")
    await managed_sources.assert_provider_usable(session, meta["workspace_id"], body.provider_id,
                                                 subject="Versioned graph projections")
    ds = await data_source_repo.get_data_source_orm(session, meta["data_source_id"])
    if ds is not None and ds.projection_mode == "dedicated":
        # Its rollups live in a graph named from the data source, which a move would leave behind.
        raise HTTPException(status_code=422, detail={
            "type": "projection_mode_unsupported",
            "message": "a data source with a dedicated rollup graph cannot be moved"})
    job = (await session.execute(
        select(AggregationJobORM.id).where(
            AggregationJobORM.data_source_id == meta["data_source_id"],
            AggregationJobORM.status.in_(("pending", "running"))).limit(1)
    )).scalar_one_or_none()
    if job is not None:     # it keeps writing rollups into the old key
        raise JobActive(job, "a rollup rebuild is running for this graph; move it when it finishes")
    shared = await managed_sources.graph_key_bindings(
        session, wm["falkor_provider"] or (ds.provider_id if ds else None), pin,
        exclude_ds=meta["data_source_id"])
    if shared:              # they would go on reading a key nobody writes
        raise ProjectionNotAdopted("shared", "other data sources read this graph's FalkorDB key",
                                   sharedWith=len(shared))

    default = vconfig.DEFAULT_FALKOR_PROVIDER
    current = {"providerId": wm["falkor_provider"] or default, "key": pin}
    if (body.key is None and current["providerId"] == body.provider_id
            and keymigrate.is_owned_key(graph_id, pin)):
        res = {"changed": False, "from": current, "to": current, "retiring": None}
    else:
        key = await _target_key(graph_id, body, current, wm["retired_keys"])
        shard_map = {"tag": key[key.index("{") + 1:-1]
                     if keymigrate.is_owned_key(graph_id, key) else None,
                     "slot": key_slot(key), "chosenAt": datetime.now(timezone.utc).isoformat(),
                     "chosenBy": user.id}
        with _domain_errors():
            try:
                res = await svc.move_projection(graph_id=graph_id, provider=body.provider_id,
                                                key=key, actor=user.id, shard_map=shard_map)
            except ConcurrencyError as exc:     # enabling version control hasn't finished
                raise HTTPException(status_code=409,
                                    detail={"type": "bootstrapping", "message": str(exc)})
    if res["changed"]:
        background.add_task(rebuild_now, graph_id)
        await recorder.record_for_request(
            session, "platform.versioning.projection_moved",
            details={"graphId": graph_id, "workspaceId": meta["workspace_id"],
                     "dataSourceId": meta["data_source_id"], "from": res["from"],
                     "to": res["to"]},
            best_effort=True,   # the move is already committed
        )
    return {"graphId": graph_id, **res,
            "watermark": await _watermark_model(session, await svc.projection_watermark(graph_id))}


async def _target_key(graph_id: str, body: ProjectionMoveRequest, current: dict,
                      retired: list) -> str:
    """The key a move goes to: ``body.key``, or the graph's first platform key that neither
    exists on the provider nor is one of its retired keys. An explicit key must be this graph's
    platform key, one of its retired keys on that provider or its current key, and must not
    exist there unless it is one of those."""
    keys = await falkor_graph_registry.list_graph_keys(body.provider_id)
    if keys is None:        # cannot verify, never "free"
        raise HTTPException(status_code=503, detail={
            "type": "provider_unreachable", "retryable": True,
            "message": "the provider's FalkorDB graphs could not be listed; try again"})
    ours = {((e.get("provider") or vconfig.DEFAULT_FALKOR_PROVIDER), e["name"]) for e in retired}
    if body.key is None:
        taken = keys | {name for _p, name in ours}
        n = 1
        while keymigrate.owned_key(graph_id, n) in taken:
            n += 1
        return keymigrate.owned_key(graph_id, n)
    ours.add((current["providerId"], current["key"]))
    if (body.provider_id, body.key) not in ours:
        if not keymigrate.is_owned_key(graph_id, body.key):
            raise ProjectionKeyInvalid(body.key)
        if body.key in keys:
            raise ProjectionKeyInUse(body.provider_id, body.key)
    return body.key
