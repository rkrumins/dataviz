"""Platform administration of the versioned graphs' FalkorDB projections, under
``/admin/versioning``: the disaster-recovery reseed of a provider, the fleet inventory, moving
one graph's projection to another provider or key, adopting a customer's key onto a platform key,
residency (doc 17), and how long a merged or abandoned draft keeps its changes (draft retention).

Every route needs ``system:admin``. None is on the API-key surface (``auth/api_key_surface``), so
an API key is refused.
"""
import contextlib
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional, Tuple

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
from backend.app.services.versioning import (build_policy, draft_retention, keymigrate, residency,
                                             residency_policy)
from backend.app.services.versioning.errors import (JobActive, ProjectionAlreadyAdopted,
                                                    ProjectionKeyInUse, ProjectionKeyInvalid,
                                                    ProjectionNotAdopted)
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
                             "rehydrating", "waiting_capacity", "failed"]] = None,
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
        # Its new key is seeded while the old one stands: a full copy, admitted like a load, and
        # committed before anything else is admitted. A graph out of FalkorDB only changes its
        # pin; its load is admitted when it starts. With residency on (or the switch unreadable)
        # the lock is always taken, and the graph's state read under it decides: a load finishing
        # meanwhile makes a copy.
        on = await residency_policy.switch_state() is not False
        async with residency.admitting() if on else contextlib.nullcontext():
            if on:
                wm = await svc.projection_watermark(graph_id)
            copied = on and wm.get("status") not in ("evicted", "waiting_capacity", "rehydrating")
            key, master = await _target_key(graph_id, body, current, wm["retired_keys"],
                                            placed=on)
            if copied:
                admitted = await residency.admission_on(graph_id, body.provider_id, key)
                if not admitted.fits:
                    raise _capacity_insufficient(admitted, "a copy of this graph")
            shard_map = {"tag": key[key.index("{") + 1:-1]
                         if keymigrate.is_owned_key(graph_id, key) else None,
                         "slot": key_slot(key), "chosenAt": datetime.now(timezone.utc).isoformat(),
                         "chosenBy": user.id, **({"master": master} if master else {})}
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
                      retired: list, *, placed: bool) -> Tuple[str, Optional[str]]:
    """The key a move goes to, and the master it was placed on: ``body.key``, or a platform key
    of the graph's that neither exists on the provider nor is one of its retired keys — with
    residency on (``placed``), on the provider's master with the most room (doc 17), else the
    first.
    An explicit key must be this graph's platform key, one of its retired keys on that provider
    or its current key, and must not exist there unless it is one of those."""
    keys = await falkor_graph_registry.list_graph_keys(body.provider_id)
    if keys is None:        # cannot verify, never "free"
        raise HTTPException(status_code=503, detail={
            "type": "provider_unreachable", "retryable": True,
            "message": "the provider's FalkorDB graphs could not be listed; try again"})
    ours = {((e.get("provider") or vconfig.DEFAULT_FALKOR_PROVIDER), e["name"]) for e in retired}
    if body.key is None:
        taken = keys | {name for _p, name in ours}
        chosen = await residency.place_key(graph_id, body.provider_id, taken) if placed else None
        if chosen is not None:
            return chosen
        n = 1
        while keymigrate.owned_key(graph_id, n) in taken:
            n += 1
        return keymigrate.owned_key(graph_id, n), None
    ours.add((current["providerId"], current["key"]))
    if (body.provider_id, body.key) not in ours:
        if not keymigrate.is_owned_key(graph_id, body.key):
            raise ProjectionKeyInvalid(body.key)
        if body.key in keys:
            raise ProjectionKeyInUse(body.provider_id, body.key)
    return body.key, None


@router.get("/residency-policy",
            summary="The residency policy: each value as saved, its default and its effective value")
async def get_residency_policy(
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """What the capacity loop evicts and loads by (doc 17), with ``enabled``: whether a system
    administrator has turned Graph residency on (Admin → Features), and ``switch``: where it is —
    its grace period, or the graphs still being brought back after it was turned off."""
    return await _policy(await session.get(PlatformSettingsORM, 1))


async def _policy(row) -> dict:
    enabled = await residency_policy.enabled()
    return {**residency_policy.describe(row), "enabled": enabled,
            "switch": await residency.switch_status(row, enabled)}


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
        row.updated_at = row.gv_policy_updated_at = datetime.now(timezone.utc).isoformat()
        row.updated_by = row.gv_policy_updated_by = user.id
        await recorder.record_for_request(
            session, "platform.residency_policy.updated",
            details={"from": {w: before[w] for w in changed}, "to": {w: after[w] for w in changed}})
    await session.commit()
    residency_policy.invalidate()
    return await _policy(await session.get(PlatformSettingsORM, 1))


def _validate(body: Dict[str, Any], saved: Dict[str, Any]) -> None:
    try:
        residency_policy.validate(body, saved)
    except residency_policy.PolicyInvalid as exc:
        raise HTTPException(status_code=422, detail={
            "type": "invalid_residency_policy", "field": exc.field, "message": str(exc)})


@router.get("/build-policy",
            summary="New-version builds: each setting as saved, its default and its effective value")
async def get_build_policy(
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """When and how a versioned graph's next version is built beside the key that serves it (doc 14
    §6), the room a copy needs, the pacing of the projector's writes and the limits on reads from
    Postgres: each value as saved, its default and its effective value, each setting's kind, range
    and help (``fields``), and ``enabled``: whether a system administrator has turned New-version
    builds on (Admin → Features)."""
    return await _build_policy(await session.get(PlatformSettingsORM, 1))


async def _build_policy(row) -> dict:
    return {**build_policy.describe(row), "enabled": await build_policy.enabled()}


@router.put("/build-policy", summary="Change New-version build settings")
async def put_build_policy(
    body: Dict[str, Any] = Body(..., examples=[{"copyMarginPct": 150, "noRoomPolicy": -1}]),
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Partial: only the values named change, and ``-1`` clears one back to its default. A value
    out of its range, of the wrong kind, or contradicting another (more Postgres reads at once per
    graph than per process) is a 422 naming the field, and nothing is saved. Recorded with each
    changed value's before and after. Every process reads the change on its next look, within two
    seconds (within 30 without Redis); a build already under way keeps the trigger and room values
    it started with."""
    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)
    before = build_policy.saved_values(row)
    try:
        build_policy.validate(body, before)
    except build_policy.PolicyInvalid as exc:
        raise HTTPException(status_code=422, detail={
            "type": "invalid_build_policy", "field": exc.field, "message": str(exc)})
    after = build_policy.merged(before, body)
    changed = sorted(w for w in after if after[w] != before[w])
    if changed:
        build_policy.save(row, after, user.id)
        row.updated_at = datetime.now(timezone.utc).isoformat()
        row.updated_by = user.id
        await recorder.record_for_request(
            session, "platform.build_policy.updated",
            details={"from": {w: before[w] for w in changed}, "to": {w: after[w] for w in changed}})
    await session.commit()
    await build_policy.invalidate()
    return await _build_policy(await session.get(PlatformSettingsORM, 1))


@router.get("/draft-retention",
            summary="How long a merged or abandoned draft keeps its changes")
async def get_draft_retention(
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """``days`` in force, as ``saved`` (null: ``GRAPHVER_DRAFT_RETENTION_DAYS`` applies, ``default``)
    and the range a value may take. A draft merged or abandoned more than ``days`` ago has its changes
    removed by the versioning worker, which keeps its record: the draft, its commits and its review.
    ``0`` keeps them for good."""
    return draft_retention.describe(await session.get(PlatformSettingsORM, 1))


class DraftRetentionChange(BaseModel):
    days: Optional[int] = Field(..., ge=draft_retention.MIN_DAYS, le=draft_retention.MAX_DAYS,
                                description="Days a merged or abandoned draft keeps its changes; 0 "
                                            "keeps them for good; null goes back to the default")


@router.put("/draft-retention",
            summary="Change how long a merged or abandoned draft keeps its changes")
async def put_draft_retention(
    body: DraftRetentionChange,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """``days`` from 0 to 3650, or null for the default; another value is a 422 and nothing is
    saved. Recorded with the value before and after. The worker reads it at the start of each pass
    (hourly): a shorter window removes the changes of the drafts it now reaches within the hour, and
    removed changes do not come back if the window is lengthened again."""
    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)
    before = row.gv_draft_retention_days
    if body.days != before:
        row.gv_draft_retention_days = body.days
        row.updated_at = datetime.now(timezone.utc).isoformat()
        row.updated_by = user.id
        await recorder.record_for_request(session, "platform.draft_retention.updated",
                                          details={"from": before, "to": body.days})
    await session.commit()
    return draft_retention.describe(row)


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
        "evictedBytes": sum(e.bytes or 0 for e in decided.evictions),
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
async def load_graph(
    graph_id: str,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Asks for the graph's load (residency, doc 17), which the capacity loop admits like any
    other: it may wait for room (``waiting_capacity``). A graph in FalkorDB, or being loaded, is
    left as it is (``loadRequested`` false). A load asked for is recorded."""
    meta = await _graph_with_a_key(graph_id)
    wm = await get_versioning_service().projection_watermark(graph_id)
    requested = wm["status"] in ("evicted", "waiting_capacity")
    if requested:
        await residency.request_load(graph_id)
        await recorder.record_for_request(
            session, "platform.versioning.load_requested",
            details={"graphId": graph_id, "workspaceId": meta["workspace_id"],
                     "dataSourceId": meta["data_source_id"], "state": wm["residency_state"]},
            best_effort=True,   # the load is already asked for
        )
    return {"graphId": graph_id, "state": wm["residency_state"], "loadRequested": requested}


#: A master's hold (``shard_capacity.hold_reason``), in words.
_HELD = {"fork": "it is writing its data to disk", "loading": "it is loading its data",
         "memory": "its memory is too high to write through", "replica_lost": "a replica dropped",
         "replica_lag": "a replica is behind", "unmeasured": "it could not be measured"}


def _capacity_insufficient(admitted: "residency.Admitted", what: str) -> HTTPException:
    """409 ``capacity_insufficient`` for a full write admission refused: its master, its shortfall
    (when it is one of room) and ``reason`` (``Admitted.why``), in words."""
    master, why = admitted.master or "?", admitted.why
    if why == "capacity":
        message = (f"master {master} has no room for {what}: it needs "
                   f"{human_bytes(admitted.shortfall)} more under its start mark")
    elif why == "unsized":
        message = (f"the size of {what} is not known, so it cannot be admitted now; it is "
                   "estimated from its history once that can be read")
    elif why == "busy":
        message = f"master {master} is taking another load; try again once it is done"
    elif why == "unmeasured":
        message = f"master {master} could not be measured, so {what} cannot be admitted now"
    else:
        message = f"master {master} cannot take {what} now: {_HELD.get(why, why)}"
    return HTTPException(status_code=409, detail={
        "type": "capacity_insufficient", "master": admitted.master,
        "shortfallBytes": admitted.shortfall if why == "capacity" else None, "reason": why,
        "message": message})


@router.post("/graphs/{graph_id}/adopt",
             summary="Adopt a graph's projection from the customer's own FalkorDB key onto a "
                     "platform key")
async def adopt_projection(
    graph_id: str,
    background: BackgroundTasks,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Adopt (doc 17): a graph that projects into the customer's own FalkorDB key moves onto a
    fresh platform key on the same provider — the reseed move (doc 14 §6): seeded from Postgres a
    page at a time, Postgres serving its reads until the new key catches up. From then the
    platform owns the key, and the graph's residency class applies. The customer's key is left
    exactly as it was — never written, dropped, renamed, relabelled or retired — so what other
    tools keep writing there no longer shows, and Bring into history no longer sees it. With
    residency on the key is placed on the provider's master with the most room, and the seed is
    admission-checked first (409 ``capacity_insufficient``).

    Refused where a move is: an unpinned graph, a key other data sources read (they would go on
    reading a key nobody writes), a dedicated rollup graph (422), a running rollup job; a graph
    already on a platform key (409 ``already_adopted``) and a fork (409 ``not_for_forks``). The
    reseed is scheduled and the adoption recorded."""
    meta = await _graph_with_a_key(graph_id)
    svc = get_versioning_service()
    wm = await svc.projection_watermark(graph_id)
    pin = wm["falkor_graph_name"]
    if pin in (None, f"gv_{graph_id}"):
        raise ProjectionNotAdopted("unpinned", "this graph has no FalkorDB key yet; nothing to adopt")
    if wm["owns_falkor_graph"]:
        raise ProjectionAlreadyAdopted(pin)
    ds = await data_source_repo.get_data_source_orm(session, meta["data_source_id"])
    if ds is not None and ds.projection_mode == "dedicated":
        # Its rollups live in a graph named from the key, which a new key would leave behind.
        raise HTTPException(status_code=422, detail={
            "type": "projection_mode_unsupported",
            "message": "a data source with a dedicated rollup graph cannot be adopted"})
    await _no_rollup_job(session, meta["data_source_id"])
    provider = wm["falkor_provider"] or vconfig.DEFAULT_FALKOR_PROVIDER
    shared = await managed_sources.graph_key_bindings(
        session, wm["falkor_provider"] or (ds.provider_id if ds else None), pin,
        exclude_ds=meta["data_source_id"])
    if shared:              # they would go on reading a key nobody writes
        raise ProjectionNotAdopted("shared", "other data sources read this graph's FalkorDB key",
                                   sharedWith=len(shared))
    keys = await falkor_graph_registry.list_graph_keys(provider)
    if keys is None:        # cannot verify, never "free"
        raise HTTPException(status_code=503, detail={
            "type": "provider_unreachable", "retryable": True,
            "message": "the provider's FalkorDB graphs could not be listed; try again"})
    taken = keys | {e["name"] for e in wm["retired_keys"]}
    # The key first, then its copy admitted on the master it hashes to, as a move's, and the
    # commit made before anything else is admitted.
    on = await residency_policy.switch_state() is not False
    async with residency.admitting() if on else contextlib.nullcontext():
        placed = await residency.place_key(graph_id, provider, taken) if on else None
        if placed is None:
            n = 1
            while keymigrate.owned_key(graph_id, n) in taken:
                n += 1
            placed = keymigrate.owned_key(graph_id, n), None
        key, master = placed
        if on:
            admitted = await residency.admission_on(graph_id, provider, key)
            if not admitted.fits:
                raise _capacity_insufficient(admitted, "this graph's copy")
        shard_map = {"tag": key[key.index("{") + 1:-1], "slot": key_slot(key),
                     "chosenAt": datetime.now(timezone.utc).isoformat(), "chosenBy": user.id,
                     **({"master": master} if master else {})}
        # Again, just before the commit: one started while the lock was waited for would go on
        # writing :AGGREGATED into the customer's key after it.
        await _no_rollup_job(session, meta["data_source_id"])
        with _domain_errors():
            try:
                res = await svc.adopt_projection(graph_id=graph_id, key=key, actor=user.id,
                                                 shard_map=shard_map)
            except ConcurrencyError as exc:     # enabling version control hasn't finished
                raise HTTPException(status_code=409,
                                    detail={"type": "bootstrapping", "message": str(exc)})
    background.add_task(rebuild_now, graph_id)
    await recorder.record_for_request(
        session, "platform.versioning.projection_adopted",
        details={"graphId": graph_id, "workspaceId": meta["workspace_id"],
                 "dataSourceId": meta["data_source_id"], "from": res["from"], "to": res["to"],
                 "externalDrift": res["externalDrift"]},
        best_effort=True,   # the adoption is already committed
    )
    return {"graphId": graph_id, "from": res["from"], "to": res["to"],
            "watermark": await _watermark_model(session, await svc.projection_watermark(graph_id))}


async def _no_rollup_job(session: AsyncSession, data_source_id: str) -> None:
    """Adopt waits for a pending or running rollup job of the data source: it writes the key the
    graph projects into (409 ``job_active``)."""
    job = (await session.execute(
        select(AggregationJobORM.id).where(
            AggregationJobORM.data_source_id == data_source_id,
            AggregationJobORM.status.in_(("pending", "running"))).limit(1)
    )).scalar_one_or_none()
    if job is not None:
        raise JobActive(job, "a rollup rebuild is running for this graph; adopt it when it "
                             "finishes")


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
    in FalkorDB has its room checked now (room only: setting a class writes nothing): 409
    ``capacity_insufficient``, naming the master and the shortfall, when its load would not fit
    there; otherwise the class is set and its load asked for. Recorded with the class before and
    after."""
    meta = await _graph_with_a_key(graph_id)
    wm = await get_versioning_service().projection_watermark(graph_id)
    cls, out = body.residency_class, wm["residency_state"] in ("evicted", "waiting_capacity")
    if cls == "always" and out:
        admitted = await residency.admission(graph_id)
        if not admitted.fits:
            raise _capacity_insufficient(admitted, "this graph")
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
