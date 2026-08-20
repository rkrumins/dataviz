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
import logging
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceORM, WorkspaceDataSourceORM, ViewORM

from backend.app.api.v1.capability_gate import require_ds_read_or_view_dspath
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
    binding_repo, role_repo, user_repo,
)
from backend.app.providers.manager import provider_manager as provider_registry  # alias during migration
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

logger = logging.getLogger(__name__)

router = APIRouter()


def _can_read_workspace(claims: PermissionClaims, ws_id: str) -> bool:
    """A user can read a workspace if they hold any binding into it
    (any non-empty permission entry under that ws_id) OR are global
    admin. Used for list filtering and the GET-by-id check."""
    if has_permission(claims, "system:admin"):
        return True
    return bool(claims.ws_perms.get(ws_id))


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
    _user: User = Depends(get_current_user),
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
    enforce = rbac_flag("RBAC_ENFORCE_WORKSPACES")
    unrestricted = not enforce or has_permission(claims, "system:admin")

    if limit is None:
        workspaces = await workspace_repo.list_workspaces(session)
        if unrestricted:
            return workspaces
        return [w for w in workspaces if claims.ws_perms.get(w.id)]

    permitted_ids = None if unrestricted else list(claims.ws_perms.keys())
    page, total = await workspace_repo.list_workspaces_page(
        session,
        limit=limit,
        offset=offset,
        search=search,
        permitted_ids=permitted_ids,
    )
    response.headers["X-Total-Count"] = str(total)
    return page


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
    return ws


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(
    workspace_id: str = Path(...),
    req: WorkspaceUpdateRequest = Body(...),
    user: User = Depends(requires("workspace:admin", workspace="workspace_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Update workspace metadata (name, description, is_active)."""
    old_ws = await session.get(WorkspaceORM, workspace_id)
    old_identity = (
        getattr(old_ws, "identity_property", None),
        getattr(old_ws, "name_property", None),
    )
    ws = await workspace_repo.update_workspace(session, workspace_id, req)
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
    row is shown as "Being deleted" rather than offering a button that would 409.
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
            purging = await purge_worker.purge_pending_for_data_source(data_source_id=r.id)
        except Exception:                                    # pragma: no cover - best effort
            logger.exception("could not read purge state for %s", r.id)
            purging = False
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
            purging=purging,
            restorable=not purging,
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
        created = await data_source_repo.create_data_source(session, workspace_id, req)
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
    session: AsyncSession = Depends(get_db_session),
):
    """Update a data source. Evicts cached provider if provider/graph changed."""
    old_ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not old_ds or old_ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")

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

    # Evict old cache entry if provider/graph config changed
    if req.projection_mode is not None or req.dedicated_graph_name is not None:
        await provider_registry.evict_workspace(workspace_id, session)

    ds = await data_source_repo.update_data_source(session, ds_id, req)
    if not ds:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found")

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
        except Exception:
            # Refuse rather than orphan. A permanent delete whose purge never got queued is
            # exactly the leak that put 2,296 unreachable graphs in this database.
            logger.exception("could not queue purge for %s", ds_id)
            raise HTTPException(
                status_code=503,
                detail="The version store is unavailable, so this cannot be permanently deleted "
                       "right now. Try again shortly.")
        await _evict(ds, workspace_id, session)
        await data_source_repo.delete_data_source(session, ds_id)
        return

    # ── the reversible path ──
    # The graph is tombstoned FIRST. If it fails we have changed nothing and can say so; the
    # other order would leave the data source in the trash with its graph still live and
    # resolvable, which is the one inconsistent state worth avoiding.
    try:
        await purge_worker.tombstone_graphs_for_data_source(
            data_source_id=ds_id, workspace_id=workspace_id, actor=_user.id)
    except Exception:
        logger.exception("could not tombstone graphs for %s", ds_id)
        raise HTTPException(
            status_code=503,
            detail="The version store is unavailable, so this can't be removed right now. "
                   "Nothing has been changed. Try again shortly.")

    await _evict(ds, workspace_id, session)
    await data_source_repo.soft_delete_data_source(session, ds_id, actor=_user.id)
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
    if not await purge_worker.restore_graphs_for_data_source(
            data_source_id=ds_id, workspace_id=workspace_id):
        raise HTTPException(
            status_code=409,
            detail="This data source is being permanently deleted and can no longer be restored.")

    restored = await data_source_repo.restore_data_source(session, ds_id)
    if restored is None:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' is not in the trash")

    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if ds is not None:
        await _evict(ds, workspace_id, session)   # re-resolve it fresh, not from a stale cache
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
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
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

    return await data_source_repo.get_data_source(session, ds_id)


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

    ds.projection_mode = mode if mode else None
    from datetime import datetime, timezone
    ds.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    await provider_registry.evict_workspace(workspace_id, session)
    return await data_source_repo.get_data_source(session, ds_id)


# ================================================================== #
# Cached Stats (DB-only — zero provider dependency)                    #
# ================================================================== #

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

    Visibility mirrors ``list_workspaces``: system admins see every
    workspace, everyone else only those their bindings reach. Cold,
    expired, and stale cache rows enqueue a background refresh — the
    same self-healing the per-datasource endpoint does — and cold or
    expired entries report ``status=computing`` with zero counts so
    callers can skip them.
    """
    import json

    from backend.app.db.repositories.stats_repo import list_data_source_stats
    from backend.app.services.stats_cache import age_seconds, classify_tier, parse_iso

    workspaces = await workspace_repo.list_workspaces(session)
    if rbac_flag("RBAC_ENFORCE_WORKSPACES") and not has_permission(claims, "system:admin"):
        workspaces = [w for w in workspaces if claims.ws_perms.get(w.id)]
    if workspace_id is not None:
        workspaces = [w for w in workspaces if w.id == workspace_id]

    ds_rows = await data_source_repo.list_data_sources_for_workspaces(
        session, [w.id for w in workspaces]
    )
    cache_by_ds = {
        c.data_source_id: c
        for c in await list_data_source_stats(session, [d.id for d in ds_rows])
    }

    def _counts(raw) -> dict:
        if not raw or raw == "{}":
            return {}
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return {}

    data: dict = {}
    for ds in ds_rows:
        key = f"{ds.workspace_id}/{ds.id}"
        cache = cache_by_ds.get(ds.id)
        tier = None
        if cache is not None:
            tier = classify_tier(age_seconds(parse_iso(cache.updated_at)))
        if cache is None or tier == "expired":
            await enqueue_stats_job_safe(ds.id, ds.workspace_id)
            data[key] = {
                "status": "computing",
                "nodeCount": 0,
                "edgeCount": 0,
                "entityTypeCounts": {},
            }
            continue
        if tier == "stale":
            await enqueue_stats_job_safe(ds.id, ds.workspace_id)
        data[key] = {
            "status": tier,
            "nodeCount": cache.node_count or 0,
            "edgeCount": cache.edge_count or 0,
            "entityTypeCounts": _counts(cache.entity_type_counts),
            "updatedAt": cache.updated_at,
        }

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
