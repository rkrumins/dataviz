"""Platform administration of the versioned graphs' FalkorDB projections, under
``/admin/versioning``: the disaster-recovery reseed of a provider, the fleet inventory, moving
one graph's projection to another provider or key, and the residency policy (doc 17).

Every route needs ``system:admin``. None is on the API-key surface (``auth/api_key_surface``), so
an API key is refused.
"""
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import PlatformSettingsORM, WorkspaceDataSourceORM
from backend.app.db.repositories import data_source_repo
from backend.app.providers import falkor_graph_registry
from backend.app.services import managed_sources
from backend.app.services.activity import recorder
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.providers.shard_capacity import human_bytes
from backend.app.services.graph_store.topology import key_slot
from backend.app.services.system_status import probes
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning import keymigrate, residency, residency_policy
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
    if meta.get("fork_parent_graph_id"):       # a fork's data source has no store of its own
        from backend.app.services.fork_sources import ForkHasNoStore
        raise ForkHasNoStore(meta["data_source_id"])
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


@router.get("/residency-policy",
            summary="The residency policy: each value as saved, its default and its effective value")
async def get_residency_policy(
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """What the capacity loop evicts and loads by (doc 17), with ``enabled``: whether residency
    applies on this deployment at all (``GRAPHVER_RESIDENCY_ENABLED``)."""
    return residency_policy.describe(await session.get(PlatformSettingsORM, 1))


@router.put("/residency-policy", summary="Change residency policy values")
async def put_residency_policy(
    body: Dict[str, Any] = Body(..., examples=[{"highWaterPct": 75, "coldlineIdleSecs": -1}]),
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Partial: only the values named change, and ``-1`` clears one back to its default. A value
    out of its range, of the wrong kind, or contradicting another (Coldline idle longer than
    Standard idle; a stop mark less than 5 points under the start mark) is a 422 naming the
    field, and nothing is saved. Recorded with each changed value's before and after; this
    process applies the change at once, the others within 30 seconds."""
    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)
    before = residency_policy.saved_values(row)
    _validate(body, before)
    residency_policy.apply(row, body)
    after = residency_policy.saved_values(row)
    changed = sorted(w for w in after if after[w] != before[w])
    if changed:
        row.updated_at = datetime.now(timezone.utc).isoformat()
        row.updated_by = user.id
        await recorder.record_for_request(
            session, "platform.residency_policy.updated",
            details={"from": {w: before[w] for w in changed}, "to": {w: after[w] for w in changed}})
    await session.commit()
    residency_policy.invalidate()
    return residency_policy.describe(await session.get(PlatformSettingsORM, 1))


def _validate(body: Dict[str, Any], saved: Dict[str, Any]) -> None:
    try:
        residency_policy.validate(body, saved)
    except residency_policy.PolicyInvalid as exc:
        raise HTTPException(status_code=422, detail={
            "type": "invalid_residency_policy", "field": exc.field, "message": str(exc)})


@router.post("/residency-policy/preview",
             summary="What the next capacity pass would do with these residency values")
async def preview_residency_policy(
    body: Dict[str, Any] = Body(default_factory=dict, examples=[{"highWaterPct": 70}]),
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """The capacity planner run on the proposed values (partial, as for PUT, and refused as PUT
    refuses them) against current memory and graphs, acting on nothing: per master, what the
    next pass would evict (graph, data source, label, bytes, reason), which waiting loads would
    start, and which would still wait and why."""
    saved = residency_policy.saved_values(await session.get(PlatformSettingsORM, 1))
    _validate(body, saved)
    policy = residency_policy.effective(residency_policy.merged(saved, body))
    decided, snap = await residency.preview(policy)
    sources = {r["data_source_id"] for r in snap.rows.values()}
    labels = dict((await session.execute(
        select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label)
        .where(WorkspaceDataSourceORM.id.in_(sources)))).all()) if sources else {}

    def item(x, **extra) -> dict:
        ds = snap.rows.get(x.graph_id, {}).get("data_source_id")
        return {"graphId": x.graph_id, "dataSourceId": ds, "label": labels.get(ds),
                "bytes": x.bytes, **extra}

    return {
        "values": {wire: getattr(policy, attr)
                   for wire, attr in residency_policy.WIRE_NAMES.items()},
        "masters": [{
            "endpoint": m.master.endpoint, "usedBytes": m.master.used,
            "maxBytes": m.master.maxmemory or None, "reservedBytes": m.reserved,
            "usedAfterBytes": m.used_after, "hold": m.master.hold,
            "evictions": [item(e, reason=e.reason) for e in m.evictions],
            "loads": [item(x) for x in m.loads],
            "waits": [item(w, reason=w.reason, shortfallBytes=w.shortfall) for w in m.waits],
        } for m in decided.masters],
        "evictions": len(decided.evictions),
        "evictedBytes": sum(e.bytes for e in decided.evictions),
        "loads": len(decided.loads),
    }


async def _graph_with_a_key(graph_id: str) -> dict:
    meta = await get_versioning_service().get_graph(graph_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"unknown graph {graph_id}")
    if meta.get("fork_parent_graph_id"):
        raise HTTPException(status_code=409, detail={
            "type": "not_for_forks",
            "message": "a fork has no FalkorDB key of its own: it reads through its root, "
                       "whose residency applies"})
    return meta


@router.post("/graphs/{graph_id}/load",
             summary="Load an evicted versioned graph into FalkorDB again (Load now)")
async def load_graph(graph_id: str, _user: User = Depends(requires("system:admin"))) -> dict:
    """Asks for the graph's load (residency, doc 17), which the capacity loop admits like any
    other: it may wait for room (``waiting_capacity``). A graph in FalkorDB, or being loaded, is
    left as it is (``loadRequested`` false)."""
    await _graph_with_a_key(graph_id)
    wm = await get_versioning_service().projection_watermark(graph_id)
    requested = wm["status"] in ("evicted", "waiting_capacity")
    if requested:
        await residency.request_load(graph_id)
    return {"graphId": graph_id, "state": wm["residency_state"], "loadRequested": requested}


class ResidencyClassRequest(BaseModel):
    residency_class: Literal["always", "standard", "coldline"] = Field(..., alias="class")


@router.put("/graphs/{graph_id}/residency", summary="Set a versioned graph's residency class")
async def set_graph_residency(
    graph_id: str,
    body: ResidencyClassRequest,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Always (never evicted), Standard or Coldline (doc 17). Always on a graph whose key is not
    in FalkorDB is admission-checked now: 409 ``capacity_insufficient``, naming the master and the
    shortfall, when its load would not fit there; otherwise the class is set and its load asked
    for. Recorded with the class before and after."""
    meta = await _graph_with_a_key(graph_id)
    wm = await get_versioning_service().projection_watermark(graph_id)
    cls, out = body.residency_class, wm["residency_state"] in ("evicted", "waiting_capacity")
    if cls == "always" and out:
        fits, master, shortfall = await residency.admission(graph_id)
        if not fits:
            raise HTTPException(status_code=409, detail={
                "type": "capacity_insufficient", "master": master, "shortfallBytes": shortfall,
                "message": (f"master {master or '?'} has no room for this graph: it needs "
                            f"{human_bytes(shortfall)} more under its start mark"
                            if shortfall is not None else
                            f"master {master or '?'} could not be measured, so this graph's load "
                            "cannot be admitted now")})
    before = await residency.set_class(graph_id, cls)
    if cls == "always" and out:
        await residency.request_load(graph_id)
    if before != cls:
        await recorder.record_for_request(
            session, "platform.versioning.residency_changed",
            details={"graphId": graph_id, "workspaceId": meta["workspace_id"],
                     "dataSourceId": meta["data_source_id"], "from": before, "to": cls},
            best_effort=True,   # the class is already set
        )
    return {"graphId": graph_id, "residency": cls, "state": wm["residency_state"]}
