"""
Admin Workspace endpoints — CRUD for workspaces and their data sources.
A workspace is an operational context containing one or more data sources,
each binding a Provider + Graph Name + Ontology.

RBAC Phase 2: each route declares its required permission via
``Depends(requires(...))``. List endpoints filter their results by the
caller's effective permissions so non-admins only see workspaces they
have a binding into. The legacy "everyone sees everything" behaviour
returns when ``RBAC_ENFORCE_WORKSPACES=false`` / ``RBAC_ENFORCE_DATASOURCES=false``.
"""
import asyncio
import logging
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ContextModelORM, WorkspaceORM, WorkspaceDataSourceORM, ViewORM

from backend.app.api.v1.capability_gate import require_ds_read_or_view_dspath
from backend.app.api.v1.view_read_scope import readable_clause
from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
    rbac_flag,
    requires,
)
from backend.app.common.http_caching import make_etag, maybe_not_modified
from backend.app.common.single_flight import read_stats_sf
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import (
    workspace_repo, provider_repo, ontology_definition_repo, data_source_repo,
    binding_repo, role_repo, user_repo, view_repo, profiling_repo, access_request_repo,
)
from backend.app.providers.manager import provider_manager as provider_registry  # alias during migration
from backend.app.services import profiling_series, template_access, workspace_visibility
from backend.app.services.activity import recorder
from backend.app.services.node_identity import (
    invalidate_node_identity,
    load_node_identity,
    scopes_resolving_through,
)
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
)
from backend.app.services.stats_cache import (
    SYNTHETIC_SCHEMA_MISSING_FIELDS, CacheMiss,
    build_computing_envelope, build_envelope, build_meta,
    build_synthetic_schema, read_stats_cache,
)
from backend.auth_service.interface import User
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
    WorkspaceSourceSummary,
    WorkspaceSummaryResponse,
    WorkspaceSummaryTrendResponse,
    WorkspaceSummaryRow,
    WorkspaceSummaryTotals,
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    DataSourceResponse,
    DeletedDataSource,
    WorkspaceDataSourceImpactResponse,
    WorkspaceImpactResponse,
    DataSourceMoveRequest,
)
from backend.insights_service.enqueue import enqueue_stats_job_safe

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.errors import LockBusy

logger = logging.getLogger(__name__)

router = APIRouter()


def _reaches_every_workspace(claims: PermissionClaims) -> bool:
    """Global admin; an organisation-wide operator — ``system:org-admin`` or
    ``system:org-viewer``, whose roles reach every workspace without a binding
    in each, so listing only their bound workspaces under-reported the estate
    they run; or an API key over everything whose owner's organisation-wide role
    gives it permissions in every workspace (``KeyScope.org_perms``), which its
    claims do not list one by one (a key's claims carry no global permission)."""
    key = claims.key_scope
    return (
        has_permission(claims, "system:admin")
        or "system:org-admin" in claims.global_perms
        or "system:org-viewer" in claims.global_perms
        or bool(key is not None and key.org_perms)
    )


def _can_read_workspace(claims: PermissionClaims, ws_id: str) -> bool:
    """A user can read a workspace if they hold any binding into it
    (any non-empty permission entry under that ws_id) OR reach every
    workspace. Used for list filtering and the GET-by-id check."""
    if _reaches_every_workspace(claims):
        return True
    return bool(claims.ws_perms.get(ws_id))


async def _as_seen_by(session: AsyncSession, claims: PermissionClaims, workspaces):
    """``workspaces`` with only the data sources the caller covers: all of
    them, except for an API key on part of a workspace."""
    covered = await workspace_visibility.key_data_source_ids(session, claims)
    if covered is None:
        return workspaces
    return [
        ws.model_copy(update={"data_sources": [d for d in ws.data_sources if d.id in covered]})
        for ws in workspaces
    ]


async def _visible_workspaces(session: AsyncSession, claims: PermissionClaims):
    """Every workspace the caller may list, each with only the data sources
    they cover. The one rule behind the list, the bulk stats and the summary,
    so their numbers can never describe different estates."""
    workspaces = await workspace_repo.list_workspaces(session)
    if rbac_flag("RBAC_ENFORCE_WORKSPACES") and not _reaches_every_workspace(claims):
        workspaces = [w for w in workspaces if claims.ws_perms.get(w.id)]
    return await _as_seen_by(session, claims, workspaces)


async def _with_view_counts(session: AsyncSession, user: User, claims: PermissionClaims, workspaces):
    """Each workspace's live views the caller can open — the count the summary
    gives, through the same read rule. Left unset when that rule can't be worked
    out (workspace grants unavailable): the list itself must still load."""
    try:
        readable, _scope = await readable_clause(session, user, claims)
    except HTTPException:
        return workspaces
    counts = await view_repo.count_views_grouped(
        session, ViewORM.workspace_id, readable=readable, ids=[w.id for w in workspaces],
    )
    return [w.model_copy(update={"view_count": counts.get(w.id, 0)}) for w in workspaces]


def _ensure_can_read_workspace(claims: PermissionClaims, ws_id: str) -> None:
    if rbac_flag("RBAC_ENFORCE_WORKSPACES") and not _can_read_workspace(claims, ws_id):
        raise HTTPException(
            status_code=404,
            detail=f"Workspace '{ws_id}' not found",
        )


# ================================================================== #
# Workspace CRUD                                                       #
# ================================================================== #

@router.get("", response_model=List[WorkspaceResponse])
async def list_workspaces(
    response: Response,
    limit: Optional[int] = Query(None, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None, max_length=200),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """List workspaces the caller has any binding into.

    System admins see every workspace; everyone else sees only the
    workspaces their role bindings (direct or via group) reach.

    Without ``limit`` this returns every permitted workspace (the shape the
    app's workspace store depends on). With ``limit`` it returns one page —
    filtered, RBAC-scoped and counted IN SQL — and sets ``X-Total-Count`` so a
    pager can render the right number of pages. Callers that page never load
    the whole estate just to show ten rows.
    """
    if limit is None:
        return await _with_view_counts(session, user, claims, await _visible_workspaces(session, claims))

    unrestricted = not rbac_flag("RBAC_ENFORCE_WORKSPACES") or _reaches_every_workspace(claims)
    permitted_ids = None if unrestricted else list(claims.ws_perms.keys())
    page, total = await workspace_repo.list_workspaces_page(
        session,
        limit=limit,
        offset=offset,
        search=search,
        permitted_ids=permitted_ids,
    )
    response.headers["X-Total-Count"] = str(total)
    return await _as_seen_by(session, claims, page)


@router.get("/summary", response_model=WorkspaceSummaryResponse)
async def get_workspaces_summary(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The estate's numbers as the caller can see them — the one definition
    the dashboard, the workspaces page and the admin overview all read, so
    they can never quote different totals.

    Declared before ``/{workspace_id}``, which would otherwise take "summary"
    for an id. The workspaces are the list's (``_visible_workspaces``) and the
    counts the bulk endpoint's (``_cached_stats_entries``): a source whose
    statistics are cold or expired is pending — counted as a source, refreshed
    in the background, left out of the sums rather than counted as empty.
    Nodes, edges and entity types are totalled once per physical graph, since
    a graph mounted in two workspaces is still one graph; each workspace row
    counts its own sources. Views are the live views the caller can read,
    counted exactly as the Explorer counts them.
    """
    workspaces = await _visible_workspaces(session, claims)
    sources = [ds for ws in workspaces for ds in ws.data_sources]
    entries = await _cached_stats_entries(session, sources)
    readable, _scope = await readable_clause(session, user, claims)
    views_by_ws = await view_repo.count_views_grouped(
        session, ViewORM.workspace_id, readable=readable,
    )
    views_by_ds = await view_repo.count_views_grouped(
        session, ViewORM.data_source_id, readable=readable, ids=[ds.id for ds in sources],
    )

    # Physical graph → (the freshest counted entry, the workspaces mounting it).
    graphs: dict = {}
    rows: List[WorkspaceSummaryRow] = []
    for ws in workspaces:
        row = WorkspaceSummaryRow(
            id=ws.id, name=ws.name, isDefault=ws.is_default,
            dataSources=len(ws.data_sources), views=views_by_ws.get(ws.id, 0),
        )
        types: set = set()
        for ds in ws.data_sources:
            entry = entries[ds.id]
            pending = entry["status"] == "computing"
            row.active_data_sources += 1 if ds.is_active else 0
            row.sources[ds.id] = WorkspaceSourceSummary(
                nodes=entry["nodeCount"], edges=entry["edgeCount"],
                pending=pending, views=views_by_ds.get(ds.id, 0),
            )
            if pending:
                row.pending_data_sources += 1
                continue
            row.nodes += entry["nodeCount"]
            row.edges += entry["edgeCount"]
            types.update(entry["entityTypeCounts"])
            key = (ds.provider_id, ds.graph_name) if ds.provider_id and ds.graph_name else (ds.id,)
            graph = graphs.setdefault(key, {"entry": entry, "workspaces": set()})
            if (entry.get("updatedAt") or "") > (graph["entry"].get("updatedAt") or ""):
                graph["entry"] = entry
            graph["workspaces"].add(ws.id)
        row.entity_types = sorted(types)
        rows.append(row)

    totals = WorkspaceSummaryTotals(
        workspaces=len(workspaces),
        dataSources=len(sources),
        activeDataSources=sum(r.active_data_sources for r in rows),
        pendingDataSources=sum(r.pending_data_sources for r in rows),
        nodes=sum(g["entry"]["nodeCount"] for g in graphs.values()),
        edges=sum(g["entry"]["edgeCount"] for g in graphs.values()),
        entityTypes=sorted({t for g in graphs.values() for t in g["entry"]["entityTypeCounts"]}),
        views=sum(views_by_ws.values()),
        sharedGraphs=sum(1 for g in graphs.values() if len(g["workspaces"]) > 1),
    )
    every = not rbac_flag("RBAC_ENFORCE_WORKSPACES") or _reaches_every_workspace(claims)
    return WorkspaceSummaryResponse(
        coverage="all" if every else "granted", totals=totals, workspaces=rows,
    )


#: Days the Dashboard's trend covers, today included.
TREND_DAYS = 30


@router.get("/summary/trend", response_model=WorkspaceSummaryTrendResponse)
async def get_workspaces_summary_trend(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The summary's totals over the last ``TREND_DAYS`` days — the same
    estate and the same counting rules, for the Dashboard's sparklines.

    Entities and relationships come from the day rollups profiling keeps, each
    observation filed under its physical graph first, so a graph mounted in two
    workspaces counts once here as it does in the summary. A graph keeps its
    last known size through days it wasn't measured; a day before anything was
    measured is None, not zero. Workspaces, sources and views are counted by
    the day they were created, among those that exist now. Read-only: unlike
    the summary it never queues a stats refresh.
    """
    now = datetime.now(timezone.utc)
    days = [(now.date() - timedelta(days=n)).isoformat() for n in range(TREND_DAYS - 1, -1, -1)]
    workspaces = await _visible_workspaces(session, claims)
    sources = [ds for ws in workspaces for ds in ws.data_sources]

    graph_of = {
        ds.id: f"{ds.provider_id}/{ds.graph_name}" if ds.provider_id and ds.graph_name else ds.id
        for ds in sources
    }
    observations, _truncated = await profiling_repo.read_observations(
        session, scope="all", scope_id=None, visible=list(graph_of),
        frm=days[0], to=now.isoformat(), grain="day",
    )
    series = profiling_series.build_series(
        [replace(o, data_source_id=graph_of[o.data_source_id]) for o in observations],
    )
    measured = {
        bucket[:10]: (n, e)
        for bucket, n, e in zip(series["buckets"], series["totals"].get("nodes", []), series["totals"].get("edges", []))
    }
    nodes: list = []
    edges: list = []
    last = (None, None)
    for day in days:
        last = measured.get(day, last)
        nodes.append(last[0])
        edges.append(last[1])

    def cumulative(created: list) -> list:
        born = sorted(c[:10] for c in created)
        return [sum(1 for b in born if b <= day) for day in days]

    readable, _scope = await readable_clause(session, user, claims)
    views_before = await view_repo.count_views(session, readable=readable, created_before=days[0])
    created = await view_repo.view_histogram(
        session, field="created", grain="hour", after=days[0],
        before=(now.date() + timedelta(days=1)).isoformat(), readable=readable,
    )
    per_day: dict = {}
    for hour, n in created:
        per_day[hour[:10]] = per_day.get(hour[:10], 0) + n
    views, running = [], views_before
    for day in days:
        running += per_day.get(day, 0)
        views.append(running)

    return WorkspaceSummaryTrendResponse(
        days=days,
        workspaces=cumulative([ws.created_at for ws in workspaces]),
        dataSources=cumulative([ds.created_at for ds in sources]),
        views=views,
        nodes=nodes,
        edges=edges,
    )


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(
    req: WorkspaceCreateRequest = Body(...),
    user: User = Depends(requires("system:workspaces:create")),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new workspace with one or more data sources."""
    # Allow empty workspaces for "Skip for Now" onboarding
    if not req.data_sources:
        req.data_sources = []

    # Validate all referenced catalog items / providers and ontologies exist
    from backend.app.db.repositories import catalog_repo
    for ds in req.data_sources:
        if ds.catalog_item_id:
            if not await catalog_repo.get_catalog_item(session, ds.catalog_item_id):
                raise HTTPException(status_code=404, detail=f"Catalog Item '{ds.catalog_item_id}' not found")
        elif not ds.provider_id:
            raise HTTPException(status_code=422, detail="Each data source requires either catalogItemId or providerId")
        if ds.ontology_id and not await ontology_definition_repo.get_ontology(session, ds.ontology_id):
            raise HTTPException(status_code=404, detail=f"Ontology '{ds.ontology_id}' not found")

    try:
        ws = await workspace_repo.create_workspace(session, req)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    # Phase 9: workspace lifecycle audit. Operators expect "who
    # created this workspace?" to be answerable from the audit log.
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.created",
        payload={
            "workspace_id": ws.id,
            "name": ws.name,
            "actor_id": user.id,
            "data_source_count": len(req.data_sources),
        },
    )
    return ws


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
async def get_workspace(
    workspace_id: str = Path(...),
    _user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single workspace with its data sources.

    Returns 404 (not 403) when the caller has no binding — keeps
    workspace existence private from non-members.
    """
    _ensure_can_read_workspace(claims, workspace_id)
    ws = await workspace_repo.get_workspace(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    return (await _as_seen_by(session, claims, [ws]))[0]


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(
    workspace_id: str = Path(...),
    req: WorkspaceUpdateRequest = Body(...),
    user: User = Depends(requires("workspace:admin", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Update workspace metadata (name, description, is_active)."""
    if req.default_layout_template_id:
        template = await session.get(ContextModelORM, req.default_layout_template_id)
        if template is None or not template_access.can_be_workspace_default(template, workspace_id):
            raise HTTPException(status_code=422, detail=(
                "A workspace's default layout template must be one every member can use: "
                "a built-in, an organization template, or this workspace's own."
            ))
    old_ws = await session.get(WorkspaceORM, workspace_id)
    old_identity = (
        getattr(old_ws, "identity_property", None),
        getattr(old_ws, "name_property", None),
    )
    try:
        ws = await workspace_repo.update_workspace(session, workspace_id, req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")

    # A workspace-level mapping change re-resolves every source in the
    # workspace that doesn't override it — mark those stale so the UI prompts a
    # re-run, but never enqueue the work here (see invalidate_node_identity).
    if (
        req.identity_property is not None or req.name_property is not None
    ) and old_identity != (ws.identity_property, ws.name_property):
        await invalidate_node_identity(
            session,
            await scopes_resolving_through(session, workspace_id=workspace_id),
            "workspace_identity_changed",
        )

    # Phase 9: lifecycle audit. ``changes`` keys only carries the
    # fields the request actually set so the event payload doesn't
    # serialise every unset field.
    changes = req.model_dump(exclude_unset=True, by_alias=False)
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.updated",
        payload={
            "workspace_id": workspace_id,
            "name": ws.name,
            "actor_id": user.id,
            "changes": list(changes.keys()),
        },
    )
    return ws


@router.get("/{workspace_id}/impact", response_model=WorkspaceImpactResponse)
async def get_workspace_impact(
    workspace_id: str = Path(...),
    _user: User = Depends(requires("workspace:admin", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """The blast radius of DELETING this workspace.

    Deleting a workspace is a HARD delete with a cascade, not the tidy soft
    delete the Explorer performs on a view: ``views.workspace_id`` is
    ON DELETE CASCADE, so every view in the workspace is destroyed — including
    ones already soft-deleted and awaiting restore. Data sources, workspace role
    bindings (i.e. every member's access) and workspace-scoped custom roles go
    too.

    The UI needs those numbers BEFORE the click. Until now the only guard was a
    browser ``confirm()`` reading "Delete this workspace and all its data
    sources?" — which doesn't mention the views at all.
    """
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    return await workspace_repo.get_workspace_impact(session, workspace_id)


@router.delete("/{workspace_id}", status_code=204)
async def delete_workspace(
    workspace_id: str = Path(...),
    user: User = Depends(requires("workspace:admin", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a workspace (cascades data sources, views, and rule-sets).

    Phase 7: also cascades to RBAC artefacts so the workspace doesn't
    leave behind orphan data:

      1. Drop every role binding scoped to this workspace.
      2. Drop every custom role scoped to this workspace (those roles
         can never be bound anywhere else, so they're operational
         debt). System workspace-template roles live at scope='global'
         and are unaffected.
      3. Emit ``rbac.workspace.roles_cascaded`` listing the role names
         so the audit log shows the cascade explicitly.
      4. Close its open access requests, so the people waiting see why.
    """
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")

    # Phase 9: capture the workspace's name BEFORE we delete it so
    # the audit event has something human-readable. Emit the
    # ``rbac.workspace.deleted`` event ahead of the cascade event
    # so the audit timeline reads "deleted → cascade" in order.
    ws_name = ws.name

    # Drop workspace-scoped bindings first so the role-cascade can
    # remove the roles without RoleInUseError tripping.
    revoked_bindings = await binding_repo.delete_scope_bindings(
        session, scope_type="workspace", scope_id=workspace_id,
    )
    cascaded_roles = await role_repo.delete_workspace_scoped_roles(
        session, workspace_id,
    )
    await access_request_repo.deny_open_for_target(
        session, target_type="workspace", target_id=workspace_id,
        resolver_id=user.id, note="The workspace was deleted",
    )

    await provider_registry.evict_workspace(workspace_id, session)
    deleted = await workspace_repo.delete_workspace(session, workspace_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.deleted",
        payload={
            "workspace_id": workspace_id,
            "name": ws_name,
            "actor_id": user.id,
            "bindings_removed": revoked_bindings,
            "roles_removed_count": len(cascaded_roles),
        },
    )

    if revoked_bindings or cascaded_roles:
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.workspace.roles_cascaded",
            payload={
                "workspace_id": workspace_id,
                "bindings_removed": revoked_bindings,
                "roles_removed": cascaded_roles,
                "actor_id": user.id,
            },
        )


@router.post("/{workspace_id}/set-default", response_model=WorkspaceResponse)
async def set_default_workspace(
    workspace_id: str = Path(...),
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a workspace to the default (used when no ws_id specified).

    Affects every user globally, so requires ``system:admin`` rather
    than the per-workspace admin permission.
    """
    success = await workspace_repo.set_default(session, workspace_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    # Clear cached default
    provider_registry._default_ws_id = None
    ws = await workspace_repo.get_workspace(session, workspace_id)
    return ws


# ================================================================== #
# Data Source Sub-Resource CRUD                                        #
# ================================================================== #

@router.get("/{workspace_id}/data-sources", response_model=List[DataSourceResponse])
async def list_data_sources(
    workspace_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:read", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """List all data sources for a workspace."""
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    return await data_source_repo.list_data_sources(session, workspace_id)


# Declared here, beside the list route and BEFORE every "/{ds_id}" route, so that a later
# `GET /{workspace_id}/data-sources/{ds_id}` can never capture "deleted" as an id.
@router.get("/{workspace_id}/data-sources/deleted", response_model=List[DeletedDataSource])
async def list_deleted_data_sources(
    workspace_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:read", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """The trash: data sources that can still be brought back.

    `restorable` is the only field the UI must obey. It is False once a purge has been queued —
    at which point the source is being dismantled and there is nothing left to restore — and the
    row is shown as "Being deleted" rather than offering a button that would 409. A purge that
    stopped says why instead: `purgeState` is ``failed`` with the job's reason, or ``blocked``
    with the `liveForks` that hold it back.
    """
    from backend.app.services.versioning import purge_worker

    rows = await data_source_repo.list_deleted_data_sources(session, workspace_id)
    if not rows:
        return []

    users = await _display_names(session, [r.deleted_by for r in rows if r.deleted_by])
    grace = gv_config.PURGE_GRACE_DAYS
    now = datetime.now(timezone.utc)

    out: List[DeletedDataSource] = []
    for r in rows:
        try:
            purge = await purge_worker.purge_state_for_data_source(data_source_id=r.id,
                                                                   deleted_at=r.deleted_at)
        except Exception:                                    # pragma: no cover - best effort
            logger.exception("could not read purge state for %s", r.id)
            purge = purge_worker.PurgeState()
        try:
            deleted = datetime.fromisoformat(r.deleted_at)
            days_left = max(0, grace - (now - deleted).days)
        except Exception:
            days_left = grace
        out.append(DeletedDataSource(
            id=r.id,
            label=r.label or r.graph_name or r.id,
            deletedAt=r.deleted_at,
            deletedBy=users.get(r.deleted_by or "", "a former member" if r.deleted_by else "someone"),
            daysLeft=days_left,
            restoreWindowDays=grace,
            purging=purge.state == "queued",
            restorable=not purge.final,
            purgeState=purge.state,
            purgeReason=purge.reason,
            liveForks=purge.forks,
        ))
    return out


async def _display_names(session: AsyncSession, ids: List[str]) -> dict:
    """usr_cd8b62ea79b6 -> "Priya Raman". Nobody should be shown a user id."""
    if not ids:
        return {}
    from backend.app.db.models import UserORM
    rows = (await session.execute(
        select(UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email)
        .where(UserORM.id.in_(list(set(ids)))))).all()
    return {uid: (" ".join(p for p in (first, last) if p).strip() or email)
            for uid, first, last, email in rows}


@router.post("/{workspace_id}/data-sources", response_model=DataSourceResponse, status_code=201)
async def add_data_source(
    workspace_id: str = Path(...),
    req: DataSourceCreateRequest = Body(...),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Add a data source to a workspace."""
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    # Validate references based on which path is used
    if req.catalog_item_id:
        from backend.app.db.repositories import catalog_repo
        if not await catalog_repo.get_catalog_item(session, req.catalog_item_id):
            raise HTTPException(status_code=404, detail=f"Catalog Item '{req.catalog_item_id}' not found")

        # A catalog item belongs to exactly ONE workspace — `uq_ds_catalog_item`
        # enforces it. Without this check the insert hit that constraint and the
        # handler below didn't recognise it (it only mapped uq_ds_ws_prov_graph),
        # so the request died as an unhandled IntegrityError → 500. The UI happily
        # offered already-owned items, so this was reachable by clicking.
        owner = (await session.execute(
            select(WorkspaceORM.id, WorkspaceORM.name)
            .join(
                WorkspaceDataSourceORM,
                WorkspaceDataSourceORM.workspace_id == WorkspaceORM.id,
            )
            .where(WorkspaceDataSourceORM.catalog_item_id == req.catalog_item_id,
                   # Only a LIVE data source can own a catalog item. Without this, deleting a
                   # data source would make its catalog item un-re-addable for the whole grace
                   # period — the undo window would silently be a lockout window, and the 409
                   # would name a workspace binding the user can no longer see.
                   WorkspaceDataSourceORM.deleted_at.is_(None))
        )).first()
        if owner:
            detail = (
                f"Already used by workspace '{owner.name}'"
                if owner.id != workspace_id
                else "This data source is already on this workspace"
            )
            raise HTTPException(status_code=409, detail=detail)
    elif not req.provider_id:
        raise HTTPException(status_code=422, detail="Either catalogItemId or providerId is required")
    if req.ontology_id and not await ontology_definition_repo.get_ontology(session, req.ontology_id):
        raise HTTPException(status_code=404, detail=f"Ontology '{req.ontology_id}' not found")
    try:
        created = await data_source_repo.create_data_source(
            session, workspace_id, req, created_by=_user.id,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        if (
            "uq_ds_ws_prov_graph" in str(e)
            or "uq_ds_catalog_item" in str(e)
            or "already allocated" in str(e)
        ):
            raise HTTPException(status_code=409, detail="This data source already exists on this workspace")
        raise

    # Seed instant stats from what discovery already profiled: if this
    # asset's counts are in asset_discovery_cache (they usually are —
    # the user just picked it from the discovery list), copy them into
    # data_source_stats so real figures show the moment the source is
    # registered. Bonus: the first poll then knows the graph's size and
    # gets the right timeout budget. Best-effort — the seeded poll
    # below refreshes everything regardless.
    if created.provider_id and created.graph_name:
        import json as _json

        from backend.app.db.models import AssetDiscoveryCacheORM
        from backend.app.db.repositories.stats_repo import (
            upsert_data_source_stats_counts,
        )
        try:
            cache_row = await session.get(
                AssetDiscoveryCacheORM, (created.provider_id, created.graph_name)
            )
            payload = (
                _json.loads(cache_row.payload)
                if cache_row is not None and cache_row.payload
                else {}
            )
            if payload.get("nodeCount") is not None:
                await upsert_data_source_stats_counts(
                    session=session,
                    ds_id=created.id,
                    node_count=int(payload.get("nodeCount") or 0),
                    edge_count=int(payload.get("edgeCount") or 0),
                    entity_type_counts=_json.dumps(payload.get("entityTypeCounts", {})),
                    edge_type_counts=_json.dumps(payload.get("edgeTypeCounts", {})),
                    lane="write",
                )
        except Exception:
            pass  # seed is a bonus; the poll below is the real refresh

    # Recorded in the onboarding's own transaction, committed below.
    await recorder.record_for_request(
        session, "workspace.data_source.added", **recorder.data_source_target(created),
        details={
            key: value for key, value in (
                ("providerId", created.provider_id),
                ("graphName", created.graph_name),
                ("catalogItemId", created.catalog_item_id),
            ) if value
        },
    )

    # Commit before enqueueing the stats poll. The stats worker uses an
    # independent session pool (PoolRole.JOBS), so if it pulls the job
    # off the Redis stream before this transaction commits, ``_resolve_
    # graph_key`` will return None and the first poll will fail. Explicit
    # commit guarantees the row is visible to the worker by the time the
    # XADD lands. The dependency-cleanup commit at request end becomes a
    # no-op for this empty transaction.
    await session.commit()

    # Proactive seeding: enqueue an immediate stats poll so the cache is
    # populated by the time the user opens Explorer. Best-effort — Redis
    # being down silently falls through; the scheduler tick will pick up
    # the data source within ~30s once Redis recovers.
    await enqueue_stats_job_safe(created.id, workspace_id)

    return created


@router.put("/{workspace_id}/data-sources/{ds_id}", response_model=DataSourceResponse)
async def update_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    req: DataSourceUpdateRequest = Body(...),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a data source. Evicts cached provider if provider/graph changed.

    Whether the source is restricted is the workspace admins' to change: the
    mark is what stops its members publishing views over it to everyone, so
    a member who could lift it could step around it."""
    old_ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not old_ds or old_ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    if (
        req.is_restricted is not None
        and req.is_restricted != bool(old_ds.is_restricted)
        and not has_permission(claims, "workspace:admin", workspace_id=workspace_id)
    ):
        raise HTTPException(
            status_code=403,
            detail="Only the workspace's admins can change whether a source is restricted",
        )

    # Validate new ontology if changing
    if req.ontology_id and not await ontology_definition_repo.get_ontology(session, req.ontology_id):
        raise HTTPException(status_code=404, detail=f"Ontology '{req.ontology_id}' not found")

    # A change to either node-identity property makes the existing
    # materialization stale (edges were resolved under the old identity, and the
    # conformance stamp wrote the old values onto the nodes), so a re-run is
    # REQUIRED, not optional. Snapshot the RESOLVED mapping either side of the
    # write rather than diffing the request against the column: with a provider
    # or workspace default underneath, CLEARING this source's override is a real
    # change, and setting it to the value it already inherited is not one.
    old_identity = await load_node_identity(session, old_ds)
    # Read before the write: the update below changes ``old_ds`` in place.
    old_ontology_id = old_ds.ontology_id

    # Evict old cache entry if provider/graph config changed
    if req.projection_mode is not None or req.dedicated_graph_name is not None:
        await provider_registry.evict_workspace(workspace_id, session)

    ds = await data_source_repo.update_data_source(session, ds_id, req)
    if not ds:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found")
    # Which fields were sent, never their values: an extraConfig can be large.
    await recorder.record_for_request(
        session, "workspace.data_source.updated", **recorder.data_source_target(ds),
        details={"fields": sorted(req.model_dump(by_alias=True, exclude_unset=True))},
    )

    new_identity = await load_node_identity(session, ds_id)
    mapping_changed = (
        old_identity.identity_property != new_identity.identity_property
        or old_identity.name_property != new_identity.name_property
    )

    # Track whether schema-invalidating fields changed so we know whether
    # to re-seed the stats cache below.
    schema_invalidating_change = (
        req.projection_mode is not None
        or req.dedicated_graph_name is not None
        or req.ontology_id is not None
        or mapping_changed
    )

    # Re-seed cache on schema-invalidating changes so the next read
    # doesn't serve stale schema/ontology. Commit first so the worker's
    # session sees the updated row when it picks up the job.
    if schema_invalidating_change:
        # Reset the persisted graph_schema so the next /cached-schema read
        # self-heals via build_synthetic_schema (correct containment types)
        # and the scheduler's deep poll rebuilds it in full. The counts poll
        # enqueued below never rewrites graph_schema, so without this the
        # stale schema would keep reading as "fresh".
        from backend.app.db.repositories.stats_repo import invalidate_schema_facet
        await invalidate_schema_facet(session, ds_id)
        await session.commit()
        await enqueue_stats_job_safe(ds_id, workspace_id)
        # Ontology (re)assignment / projection changes alter how reads
        # resolve — invalidate the process-wide resolved-ontology cache.
        from backend.app.services.resolved_ontology_cache import bump_ontology_generation
        await bump_ontology_generation(workspace_id, ds_id)
        # Cached hierarchy reads were answered under the old ontology / name
        # mapping (entity types, display names) — drop them. Only when one of
        # them really moved: the edit form re-sends the current ontologyId with
        # a rename. Never raises.
        if ds.ontology_id != old_ontology_id or mapping_changed:
            from backend.app.services.graph_cache import invalidate_hierarchy_reads
            await invalidate_hierarchy_reads(workspace_id, ds_id)

    # A mapping change makes the materialized AGGREGATED edges stale, and the
    # stamp's NULL-only fill means a re-run is required to rewrite them.
    if mapping_changed:
        await invalidate_node_identity(
            session, [(workspace_id, ds_id)], "identity_property_changed",
        )

    return ds


async def _evict(ds, workspace_id: str, session: AsyncSession) -> None:
    """Drop the cached provider for ONE data source.

    Deliberately not `evict_workspace`: that resolves its key set through `list_data_sources`,
    which now filters out soft-deleted rows — so calling it after a delete would quietly fail to
    evict the one row that actually needs evicting. Until now only statement order (evict, THEN
    delete) kept that from being a bug, and nothing said so. We hold the row; use it.
    """
    try:
        await provider_registry.evict_data_source(ds.provider_id, ds.graph_name or "")
    except Exception:                                        # pragma: no cover - cache only
        logger.exception("could not evict cached provider for %s", ds.id)
    # The resolved-ontology cache is scoped by (workspace_id, data_source_id) and will otherwise
    # keep serving this source's ontology to pods that never noticed it went away.
    try:
        from backend.app.services.resolved_ontology_cache import bump_ontology_generation
        await bump_ontology_generation(workspace_id, ds.id)
    except Exception:                                        # pragma: no cover - cache only
        logger.debug("resolved-ontology cache bump skipped for %s", ds.id, exc_info=True)


@router.delete("/{workspace_id}/data-sources/{ds_id}", status_code=204)
async def remove_data_source(
    workspace_id: str = Path(...),
    permanent: bool = Query(False, description="Skip the trash and destroy it now."),
    ds_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Move a data source to the trash — or, with ``?permanent=true``, destroy it now.

    THE DEFAULT IS REVERSIBLE. Nothing is deleted: the data-source row and its graph are
    tombstoned, which hides them from every read immediately, and that is all. No purge is
    queued. For `PURGE_GRACE_DAYS` the user can put it all back with one click, and only then
    does the reaper turn the tombstone into a real deletion.

    This works because of a detail that would otherwise be a footgun: every child of a data
    source is `ON DELETE SET NULL` (`views.data_source_id` and friends). A hard DELETE does not
    just break those links, it ERASES them — after it, nothing remembers which views belonged to
    this source, and no amount of resurrecting the row brings them back. A soft delete issues no
    DELETE, so the links survive untouched and restore is free.

    ``?permanent=true`` is the honest escape hatch: it queues the purge immediately (millions of
    version rows are not something an HTTP request deletes inline) and removes the row.
    """
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")

    count = await data_source_repo.count_data_sources(session, workspace_id)
    if count <= 1:
        raise HTTPException(status_code=409, detail="Cannot delete the last data source in a workspace")

    from backend.app.services.versioning import purge_worker

    if permanent:
        try:
            jobs = await purge_worker.purge_graph_for_data_source(
                data_source_id=ds_id, workspace_id=workspace_id, actor=_user.id)
            logger.info("data source %s PERMANENTLY deleted by %s; purge queued: %s",
                        ds_id, _user.id, jobs)
        except purge_worker.PurgeRefused as exc:
            # Nothing was queued, so nothing is recorded or deleted (e.g. forks still read it).
            raise HTTPException(status_code=409, detail={"type": exc.code, "message": exc.reason})
        except Exception:
            # Refuse rather than orphan. A permanent delete whose purge never got queued is
            # exactly the leak that put 2,296 unreachable graphs in this database.
            logger.exception("could not queue purge for %s", ds_id)
            raise HTTPException(
                status_code=503,
                detail="The version store is unavailable, so this cannot be permanently deleted "
                       "right now. Try again shortly.")
        await _evict(ds, workspace_id, session)
        await recorder.record_for_request(
            session, "workspace.data_source.removed", **recorder.data_source_target(ds),
            details={"permanent": True},
        )
        await data_source_repo.delete_data_source(session, ds_id)
        return

    # ── the reversible path ──
    # The graph is tombstoned FIRST. If it fails we have changed nothing and can say so; the
    # other order would leave the data source in the trash with its graph still live and
    # resolvable, which is the one inconsistent state worth avoiding.
    try:
        await purge_worker.tombstone_graphs_for_data_source(
            data_source_id=ds_id, workspace_id=workspace_id, actor=_user.id)
    except LockBusy:
        raise                    # 503 lock_busy: a save or import holds the graph; nothing changed
    except Exception:
        logger.exception("could not tombstone graphs for %s", ds_id)
        raise HTTPException(
            status_code=503,
            detail="The version store is unavailable, so this can't be removed right now. "
                   "Nothing has been changed. Try again shortly.")

    await _evict(ds, workspace_id, session)
    await data_source_repo.soft_delete_data_source(session, ds_id, actor=_user.id)
    await recorder.record_for_request(
        session, "workspace.data_source.removed", **recorder.data_source_target(ds),
        details={"permanent": False},
    )
    logger.info("data source %s moved to trash by %s (restorable for %s days)",
                ds_id, _user.id, gv_config.PURGE_GRACE_DAYS)


@router.post("/{workspace_id}/data-sources/{ds_id}/restore", response_model=DataSourceResponse)
async def restore_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Undo a delete. The views, models and version history all come back with it."""
    from backend.app.services.versioning import purge_worker

    # The graph goes first, because it is the one that can REFUSE: once a purge has been queued
    # there is nothing left to restore, and we must not hand back a data source pointing at a
    # graph that is being dismantled.
    row = await data_source_repo.get_data_source_orm(session, ds_id, include_deleted=True)
    purge = await purge_worker.restore_graphs_for_data_source(
        data_source_id=ds_id, workspace_id=workspace_id,
        deleted_at=row.deleted_at if row is not None else None)
    if purge.final:
        detail = "This data source is being permanently deleted and can no longer be restored."
        if purge.reason:
            detail = (f"Permanently deleting this data source stopped ({purge.reason}), and it "
                      "can no longer be restored.")
        raise HTTPException(status_code=409, detail=detail)

    restored = await data_source_repo.restore_data_source(session, ds_id)
    if restored is None:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' is not in the trash")

    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if ds is not None:
        await _evict(ds, workspace_id, session)   # re-resolve it fresh, not from a stale cache
    await recorder.record_for_request(
        session, "workspace.data_source.restored", **recorder.data_source_target(restored),
    )
    logger.info("data source %s restored by %s", ds_id, _user.id)
    return restored

@router.post(
    "/{workspace_id}/data-sources/{ds_id}/move",
    response_model=DataSourceResponse,
)
async def move_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    req: DataSourceMoveRequest = Body(...),
    user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Re-home a data source into another workspace — ONLY if nothing is built on it.

    A catalog item belongs to exactly one workspace (``uq_ds_catalog_item``), and it
    is allocated at onboarding. Getting that allocation wrong currently has no
    remedy short of detaching, which is destructive. This is the remedy, restricted
    to the case where it is provably safe.

    WHY ZERO VIEWS IS NOT A CONSERVATIVE CHOICE BUT THE ONLY CORRECT ONE:

      * ``views.data_source_id`` is ON DELETE SET NULL. Detach-and-re-add does not
        delete the old workspace's views — it silently ORPHANS them: alive, pointing
        at nothing.
      * Moving the row in place (what this does) keeps ``data_source_id`` valid, but
        a view still carries ``workspace_id = A`` while its source now lives in B.
        Members of A would be reading B's data through a workspace-scoped RBAC check
        that no longer describes reality.

    Soft-deleted views count. Restoring one afterwards would recreate exactly the
    situation above, so a source with a view in the trash cannot move either.

    Requires datasource:manage on BOTH workspaces — the decorator covers the source
    workspace; the target is checked below. Moving a source INTO a workspace you
    don't administer would otherwise be a way to plant data in it.
    """
    # Held until the move commits: a second move, or an enable of version control, waits here
    # and then finds the source gone from this workspace.
    ds = await data_source_repo.get_data_source_orm(session, ds_id, lock="update")
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")

    target_id = req.target_workspace_id
    if target_id == workspace_id:
        raise HTTPException(status_code=422, detail="The data source is already in this workspace")

    target = await workspace_repo.get_workspace_orm(session, target_id)
    if not target:
        raise HTTPException(status_code=404, detail=f"Workspace '{target_id}' not found")

    if not has_permission(claims, "workspace:datasource:manage", workspace_id=target_id):
        raise HTTPException(
            status_code=403,
            detail=f"You don't have permission to add data sources to '{target.name}'",
        )

    # THE precondition. Counts trashed views too — see the docstring.
    view_count = (await session.execute(
        select(func.count())
        .select_from(ViewORM)
        .where(ViewORM.data_source_id == ds_id)
    )).scalar_one()
    if view_count:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{view_count} view{'s are' if view_count != 1 else ' is'} built on this "
                "data source. Moving it would leave them reading a source in another "
                "workspace. Delete or rebuild them first."
            ),
        )

    # A workspace can't hold the same provider+graph twice (uq_ds_ws_prov_graph).
    if ds.provider_id and ds.graph_name:
        clash = (await session.execute(
            select(WorkspaceDataSourceORM.id).where(
                WorkspaceDataSourceORM.workspace_id == target_id,
                WorkspaceDataSourceORM.provider_id == ds.provider_id,
                WorkspaceDataSourceORM.graph_name == ds.graph_name,
                # A tombstone in the target workspace must not raise a 409 naming a data source
                # the user cannot see and cannot get rid of. (uq_ds_ws_prov_graph_live agrees.)
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).first()
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"'{target.name}' already has this graph connected",
            )

    source_ws_name = (await workspace_repo.get_workspace_orm(session, workspace_id)).name
    target_name = target.name
    target_fields = recorder.data_source_target(ds)   # read now: a failed commit expires the row

    # The versioned graph and its forks move FIRST, so a refusal (a job still running: 409
    # job_active) or an unreachable store changes nothing. The other order would leave the
    # source in B with its history readable only through A.
    from backend.app.services.versioning.errors import HTTP_MAPPED
    from backend.app.services.versioning.service import GraphVersioningService
    svc = GraphVersioningService()
    try:
        await svc.move_graph_workspace(ds_id, target_id, from_workspace_id=workspace_id)
    except HTTP_MAPPED:
        raise
    except Exception:
        logger.exception("could not move the versioned graph of %s", ds_id)
        raise HTTPException(
            status_code=503,
            detail="The version store is unavailable, so this can't be moved right now. "
                   "Nothing has been changed. Try again shortly.")

    try:
        # The row keeps its id, so stats, polling config and aggregation state follow it
        # for free. Only its owner changes.
        ds.workspace_id = target_id
        ds.is_primary = False  # primacy is per-workspace; it isn't inherited
        await session.flush()

        # Both workspaces' cached provider handles now describe the wrong shape.
        await provider_registry.evict_workspace(workspace_id, session)
        await provider_registry.evict_workspace(target_id, session)

        await user_repo.create_outbox_event(
            session,
            event_type="workspace.datasource.moved",
            payload={
                "data_source_id": ds_id,
                "from_workspace_id": workspace_id,
                "from_workspace_name": source_ws_name,
                "to_workspace_id": target_id,
                "to_workspace_name": target.name,
                "actor_id": user.id,
            },
        )
        # Committed here, not at request end, so a failure can still put the graph back.
        await session.commit()
    except BaseException as exc:
        # No two-phase commit across the stores: move the graph back — unless the commit landed
        # and only its answer was lost, which the row, read again, says. Shielded, and on a
        # cancellation too (the request's time ran out, the client went away).
        if await asyncio.shield(_committed_in(session, ds_id, target_id)):
            if not isinstance(exc, Exception):
                raise
            logger.warning("data source %s moved to %s although its commit raised %r", ds_id,
                           target_id, exc)
            return await data_source_repo.get_data_source(session, ds_id)
        detail = ("The data source couldn't be moved right now. Nothing has been changed. "
                  "Try again shortly.")
        try:
            await asyncio.shield(svc.move_graph_workspace(
                ds_id, workspace_id, from_workspace_id=target_id))
        except Exception:
            logger.exception("data source %s stayed in %s but its versioned graph could not be "
                             "moved back from %s", ds_id, workspace_id, target_id)
            detail = (f"The data source is still in '{source_ws_name}', but its version history "
                      f"could not be moved back from '{target_name}'. Move the data source to "
                      f"'{target_name}' again to finish the move.")
            try:
                await session.rollback()
                await recorder.record_for_request(
                    session, "workspace.data_source.move_incomplete", **target_fields,
                    details={"from_workspace_id": workspace_id, "to_workspace_id": target_id},
                    best_effort=True,
                )
                await session.commit()
            except Exception:
                logger.exception("could not record the incomplete move of data source %s", ds_id)
        if not isinstance(exc, Exception):
            raise
        logger.exception("moving data source %s from %s to %s failed", ds_id, workspace_id,
                         target_id)
        raise HTTPException(status_code=503, detail=detail) from exc

    return await data_source_repo.get_data_source(session, ds_id)


async def _committed_in(session: AsyncSession, ds_id: str, workspace_id: str) -> bool:
    """Whether the data source's row is committed in ``workspace_id``: a commit that raised may
    still have landed. False when the row cannot be read, so the move is undone as before."""
    try:
        await session.rollback()
        return await session.scalar(select(WorkspaceDataSourceORM.workspace_id).where(
            WorkspaceDataSourceORM.id == ds_id)) == workspace_id
    except Exception:
        logger.exception("could not read where data source %s is after its move", ds_id)
        return False


@router.get("/{workspace_id}/data-sources/{ds_id}/impact", response_model=WorkspaceDataSourceImpactResponse)
async def get_data_source_impact(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:read", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Return the blast radius of deleting a data source (e.g. affected semantic views)."""
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    
    return await data_source_repo.get_data_source_impact(session, ds_id)

@router.post("/{workspace_id}/data-sources/{ds_id}/set-primary", response_model=DataSourceResponse)
async def set_primary_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a data source to primary within its workspace."""
    success = await data_source_repo.set_primary(session, workspace_id, ds_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    ds = await data_source_repo.get_data_source(session, ds_id)
    await recorder.record_for_request(
        session, "workspace.data_source.primary_set", **recorder.data_source_target(ds),
    )
    return ds


@router.patch("/{workspace_id}/data-sources/{ds_id}/projection-mode", response_model=DataSourceResponse)
async def set_projection_mode(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    mode: str = Body(..., embed=True),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Set the aggregation edge projection mode for a data source.

    mode values:
    - "in_source"  — store AGGREGATED edges in the same graph as source data
    - "dedicated"  — store in a separate projection graph
    - ""           — clear override, inherit from provider default
    """
    if mode and mode not in ("in_source", "dedicated"):
        raise HTTPException(status_code=422, detail=f"Invalid projection mode: '{mode}'. Must be 'in_source', 'dedicated', or empty.")
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")

    # Guard: cannot change mode while an aggregation job is active
    from sqlalchemy import select
    from backend.app.services.aggregation.models import AggregationJobORM
    active_job = (
        await session.execute(
            select(AggregationJobORM)
            .where(AggregationJobORM.data_source_id == ds_id)
            .where(AggregationJobORM.status.in_(["pending", "running"]))
        )
    ).scalars().first()
    if active_job:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot change projection mode while aggregation job '{active_job.id}' is active. Cancel or wait for it to complete.",
        )

    before = ds.projection_mode
    ds.projection_mode = mode if mode else None
    from datetime import datetime, timezone
    ds.updated_at = datetime.now(timezone.utc).isoformat()
    await recorder.record_for_request(
        session, "workspace.data_source.projection_changed", **recorder.data_source_target(ds),
        details={"from": before, "to": ds.projection_mode},
    )
    await session.flush()
    await provider_registry.evict_workspace(workspace_id, session)
    return await data_source_repo.get_data_source(session, ds_id)


# ================================================================== #
# Cached Stats (DB-only — zero provider dependency)                    #
# ================================================================== #

async def _cached_stats_entries(session: AsyncSession, data_sources) -> dict:
    """``{ds_id: entry}`` from the stats cache — the one classification the
    bulk endpoint and the summary share. Cold, expired and stale rows enqueue a
    background refresh; cold or expired entries report ``status=computing``
    with zero counts so callers can skip them."""
    import json

    from backend.app.db.repositories.stats_repo import list_data_source_stats
    from backend.app.services.stats_cache import age_seconds, classify_tier, parse_iso

    cache_by_ds = {
        c.data_source_id: c
        for c in await list_data_source_stats(session, [d.id for d in data_sources])
    }

    def _counts(raw) -> dict:
        if not raw or raw == "{}":
            return {}
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return {}

    entries: dict = {}
    for ds in data_sources:
        cache = cache_by_ds.get(ds.id)
        tier = None
        if cache is not None:
            tier = classify_tier(age_seconds(parse_iso(cache.updated_at)))
        if cache is None or tier == "expired":
            await enqueue_stats_job_safe(ds.id, ds.workspace_id)
            entries[ds.id] = {
                "status": "computing",
                "nodeCount": 0,
                "edgeCount": 0,
                "entityTypeCounts": {},
            }
            continue
        if tier == "stale":
            await enqueue_stats_job_safe(ds.id, ds.workspace_id)
        entries[ds.id] = {
            "status": tier,
            "nodeCount": cache.node_count or 0,
            "edgeCount": cache.edge_count or 0,
            "entityTypeCounts": _counts(cache.entity_type_counts),
            # Raw nullable, deliberately NOT ``or 0`` like its neighbours:
            # NULL means "not measured" (the store would not answer, the
            # provider is not FalkorDB, or the row predates collection).
            # Zero would read as "this graph has no properties", which is
            # exactly backwards for the graphs this figure warns about.
            "propertyKeyCount": cache.property_key_count,
            "updatedAt": cache.updated_at,
        }
    return entries


@router.get("/datasources/cached-stats")
async def get_cached_stats_bulk(
    workspace_id: Optional[str] = Query(None),
    _user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Bulk cached graph statistics for every data source the caller can
    see, optionally scoped to one workspace via ``?workspace_id=``.

    Collapses the dashboard/admin N×M per-datasource ``/cached-stats``
    fan-out into one request backed by two SQL queries. Entries carry
    only what those surfaces consume (counts + type-count maps); the
    per-datasource endpoint remains the source for the full composite
    (schemaStats / ontologyMetadata / graphSchema).

    Visibility is the list's (``_visible_workspaces``) and the
    classification the summary's (``_cached_stats_entries``): cold,
    expired, and stale cache rows enqueue a background refresh — the
    same self-healing the per-datasource endpoint does — and cold or
    expired entries report ``status=computing`` with zero counts so
    callers can skip them.
    """
    workspaces = await _visible_workspaces(session, claims)
    if workspace_id is not None:
        workspaces = [w for w in workspaces if w.id == workspace_id]

    sources = [ds for ws in workspaces for ds in ws.data_sources]
    entries = await _cached_stats_entries(session, sources)
    data: dict = {f"{ds.workspace_id}/{ds.id}": entries[ds.id] for ds in sources}

    # build_meta (not a hand-rolled dict): the FE's isCacheEnvelope guard
    # requires status/source/age_seconds/ttl_seconds/missing_fields on
    # meta — a partial meta fails the guard and fetchEnveloped hands the
    # WHOLE envelope to callers instead of ``data``.
    meta = build_meta(
        status="fresh",
        source="postgres",
        data_source_id="*",  # bulk response — per-entry ids live in the data keys
    )
    meta["count"] = len(data)
    return JSONResponse(content={"data": data, "meta": meta})


@router.get("/{workspace_id}/datasources/{ds_id}/cached-stats")
async def get_cached_stats(
    request: Request,
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:read", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Return cached graph statistics for a data source.

    Cache-only read returning the canonical ``{data, meta}`` envelope
    with HTTP 200. ``data`` carries a composite of all cached fields
    (counts, schema_stats, ontology_metadata, graph_schema). On miss,
    enqueues a background refresh and returns ``meta.status=computing``.
    Never 404 when the data source exists.

    ETag/304 — the actual cached payload only changes when the stats
    job updates ``cache.updated_at``. We emit a strong ETag derived
    from (ds_id, updated_at) so clients that revalidate against an
    unchanged row get a 304 with no body. The 304 is only available
    on the cache-hit path (cold and expired-cache responses always
    carry a fresh "computing" envelope so polling kicks off correctly).
    """
    import json

    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace '{workspace_id}'")

    # ``read_stats_cache`` returns a single field at a time; /cached-stats
    # is the one endpoint that wants all four cached fields in a single
    # response, so it composes the envelope by hand using the same
    # freshness primitives every other handler relies on.
    from backend.app.db.repositories.stats_repo import get_data_source_stats
    from backend.app.services.stats_cache import (
        age_seconds, classify_stats_service_health, classify_tier,
        parse_iso, ttl_seconds,
    )

    def _maybe_load(raw):
        if not raw or raw == "{}":
            return None
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return None

    async def _build_snapshot() -> dict:
        """The single-flight-protected snapshot build.

        Encapsulates the expensive shared work: cache row read +
        classification + job enqueue + service-status probe + envelope
        construction. When 100 concurrent callers arrive for the same
        ``ds_id``, exactly one runs this body and the rest share the
        returned dict — turning what was 100 cache rows + 100 job
        enqueues into 1 + 1. Returns a plain dict (not the ORM row)
        so the shared result has no implicit session affinity.
        """
        cache = await get_data_source_stats(session, ds_id)
        if not cache:
            msg_id = await enqueue_stats_job_safe(ds_id, workspace_id)
            return {
                "computing": True,
                "envelope": build_computing_envelope(ds_id, workspace_id, msg_id),
            }

        age = age_seconds(parse_iso(cache.updated_at))
        tier = classify_tier(age)
        if tier == "expired":
            msg_id = await enqueue_stats_job_safe(ds_id, workspace_id)
            return {
                "computing": True,
                "envelope": build_computing_envelope(ds_id, workspace_id, msg_id),
            }

        refreshing = False
        if tier == "stale":
            await enqueue_stats_job_safe(ds_id, workspace_id)
            refreshing = True

        composite = {
            "nodeCount": cache.node_count or 0,
            "edgeCount": cache.edge_count or 0,
            "entityTypeCounts": _maybe_load(cache.entity_type_counts) or {},
            "edgeTypeCounts": _maybe_load(cache.edge_type_counts) or {},
            "schemaStats": _maybe_load(cache.schema_stats),
            "ontologyMetadata": _maybe_load(cache.ontology_metadata),
            "graphSchema": _maybe_load(cache.graph_schema),
            # Raw nullable, deliberately NOT ``or 0`` like its neighbours:
            # NULL means "not measured" (the store would not answer, the
            # provider is not FalkorDB, or the row predates collection).
            # Zero would read as "this graph has no properties", which is
            # exactly backwards for the graphs this figure warns about.
            "propertyKeyCount": cache.property_key_count,
        }

        service_status, last_error = await classify_stats_service_health(session, ds_id)
        meta = build_meta(
            status="fresh" if tier == "fresh" else "stale",
            source="postgres",
            data_source_id=ds_id,
            age_seconds=age,
            ttl_seconds=ttl_seconds(age),
            stats_service_status=service_status,
            provider_health="unreachable" if last_error else "healthy",
            refreshing=refreshing,
            updated_at=cache.updated_at,
        )
        return {
            "computing": False,
            "envelope": build_envelope(composite, meta),
            "updated_at": cache.updated_at,
        }

    snapshot = await read_stats_sf.run(("cached-stats", ds_id), _build_snapshot)

    # The cold-cache and expired paths can't 304 — they return a
    # "computing" envelope so the client knows to start polling. ETag
    # only applies on the cache-hit path where the body is a pure
    # function of (ds_id, updated_at).
    if snapshot["computing"]:
        return JSONResponse(content=snapshot["envelope"])

    # Per-caller ETag check: ``If-None-Match`` is per-request, so this
    # has to live outside the single-flight (which shares one body
    # across all current callers). The ETag itself is computed from
    # the shared ``updated_at`` so all callers compute the same tag.
    etag = make_etag("cached-stats", ds_id, snapshot["updated_at"])
    not_modified = maybe_not_modified(request, etag)
    if not_modified is not None:
        return not_modified

    return JSONResponse(
        content=snapshot["envelope"],
        headers={
            "ETag": etag,
            "Cache-Control": "private, max-age=0, must-revalidate",
        },
    )


# ================================================================== #
# Cached Schema (DB-only — zero provider dependency)                   #
# ================================================================== #

@router.get("/{workspace_id}/datasources/{ds_id}/cached-schema")
async def get_cached_schema(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    # Membership OR ?viewId= capability — the canvas open path needs
    # this read for non-members of the view's workspace.
    _user: User = Depends(require_ds_read_or_view_dspath),
    session: AsyncSession = Depends(get_db_session),
):
    """Return cached graph schema for a data source.

    Cache-only read returning the canonical ``{data, meta}`` envelope
    with HTTP 200. On miss, serves a synthetic schema built from the
    assigned ontology (``meta.status=partial``, ``meta.source=ontology``)
    and enqueues a background refresh. If no ontology is assigned
    either, returns ``meta.status=computing``. Never 404 when the data
    source exists — "cache not populated yet" is a state, not an error.
    """
    # 404 here is a genuine "doesn't exist", not a cache-state error.
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace '{workspace_id}'")

    try:
        data, meta = await read_stats_cache(session, ds_id, workspace_id, "graph_schema")
        return JSONResponse(content=build_envelope(data, meta))
    except CacheMiss:
        pass

    msg_id = await enqueue_stats_job_safe(ds_id, workspace_id)
    job_id = msg_id or f"dedup:{ds_id}"
    poll_url = f"/api/v1/{workspace_id}/graph/introspection/refresh/{job_id}"

    synthetic = await build_synthetic_schema(session, ds_id)
    if synthetic:
        meta = build_meta(
            status="partial", source="ontology",
            data_source_id=ds_id,
            missing_fields=SYNTHETIC_SCHEMA_MISSING_FIELDS,
            refreshing=True, job_id=job_id, poll_url=poll_url,
        )
        return JSONResponse(content=build_envelope(synthetic, meta))

    return JSONResponse(content=build_computing_envelope(
        ds_id, workspace_id, msg_id, missing_fields=SYNTHETIC_SCHEMA_MISSING_FIELDS,
    ))


# ================================================================== #
# Cached Ontology Metadata (DB-only — zero provider dependency)        #
# ================================================================== #

@router.get("/{workspace_id}/datasources/{ds_id}/cached-ontology")
async def get_cached_ontology(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    # Membership OR ?viewId= capability — see cached-schema above.
    _user: User = Depends(require_ds_read_or_view_dspath),
    session: AsyncSession = Depends(get_db_session),
):
    """Return cached ontology metadata for a data source.

    Cache-only read returning the canonical ``{data, meta}`` envelope
    with HTTP 200. On miss, enqueues a background refresh and returns
    ``meta.status=computing``. Never 404 when the data source exists.
    """
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace '{workspace_id}'")

    try:
        data, meta = await read_stats_cache(session, ds_id, workspace_id, "ontology_metadata")
        return JSONResponse(content=build_envelope(data, meta))
    except CacheMiss:
        pass

    msg_id = await enqueue_stats_job_safe(ds_id, workspace_id)
    return JSONResponse(content=build_computing_envelope(ds_id, workspace_id, msg_id))
