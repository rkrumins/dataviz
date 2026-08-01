"""
View endpoints (top-level, cross-workspace).

Views are visual renderings of context models (or ad-hoc graphs).
Mounted at /api/v1/views

View-sharing rework (2026-07-31): every route enforces the
visibility-first evaluator (``backend.app.services.view_access``) —
private = creator + grants + workspace admins; workspace = members;
enterprise = any signed-in user. List/aggregate reads are scoped in
SQL via ``readable_views_clause`` (correct pagination, no
post-filtering); transitions to/from ``enterprise`` require
``workspace:view:publish``. The kill-switch ``RBAC_ENFORCE_VIEWS=false``
reverts scoping to legacy behaviour (auth requirements stay).
"""
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import ensure_view_mode_allowed
from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
    rbac_flag,
    requires,
)
from backend.app.common.single_flight import normalised_principal, read_views_sf
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM
from backend.app.db.repositories import data_source_repo, grant_repo, view_repo
from backend.app.db.repositories import notification_repo, view_activity_repo
from backend.app.providers.manager import provider_manager as provider_registry  # alias during migration
from backend.app.services.context_engine import ContextEngine
from backend.app.services.permission_service import PermissionClaims
from backend.app.services import view_access
from backend.app.services.versioning.db import graphver_session
from backend.app.services.versioning.models import BranchORM
from backend.auth_service.interface import User
from backend.common.models.management import (
    ViewAccessInfo,
    ViewAudience,
    ViewPublishRequest,
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewLayoutUpdateRequest,
    ViewResponse,
    ViewListResponse,
    ViewFacetsResponse,
    ViewCatalogStats,
)

logger = logging.getLogger(__name__)
router = APIRouter()


async def _viewer_context(
    session: AsyncSession,
    user: Optional[User],
    claims: PermissionClaims,
) -> view_access.ViewerContext:
    """Build the per-request ViewerContext used by every guarded route."""
    return await view_access.ViewerContext.build(session, user=user, claims=claims)


async def _load_view_orm(
    session: AsyncSession, view_id: str, *, include_deleted: bool = False,
) -> ViewORM:
    """Fetch the raw ORM row (the access predicates need it).

    The endpoint then calls ``view_repo.get_view_enriched`` to return
    the response shape — kept separate so the access check happens
    against the authoritative row and not a lossy DTO projection.

    Soft-deleted rows are invisible by default; only the restore flow
    passes ``include_deleted=True``.
    """
    from sqlalchemy import select
    query = select(ViewORM).where(ViewORM.id == view_id)
    if not include_deleted:
        query = query.where(ViewORM.deleted_at.is_(None))
    row = await session.execute(query)
    view = row.scalar_one_or_none()
    if view is None:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


async def _read_scope(
    session: AsyncSession,
    user: User,
    claims: PermissionClaims,
) -> view_access.ViewReadScope:
    """The caller's read reach for SQL scoping.

    Mirrors the ``requires()`` doctrine on session-store outages: when
    workspace grants are unavailable we refuse (503) rather than render
    an empty catalog that looks like revoked access.
    """
    if not claims.ws_available and "system:admin" not in claims.global_perms:
        raise HTTPException(
            status_code=503, detail="Authorization temporarily unavailable",
        )
    ctx = await _viewer_context(session, user, claims)
    return await view_access.build_read_scope(session, ctx)


async def _readable_clause(
    session: AsyncSession,
    user: User,
    claims: PermissionClaims,
):
    """(clause, scope) under RBAC enforcement; (None, None) when the
    kill-switch is off — repo functions treat None as unscoped."""
    if not rbac_flag("RBAC_ENFORCE_VIEWS"):
        return None, None
    scope = await _read_scope(session, user, claims)
    return view_access.readable_views_clause(scope), scope


def _category_filters(
    category: Optional[str],
    scope: Optional[view_access.ViewReadScope],
    user: Optional[User],
):
    """Translate the Explorer's ``category`` param into repo kwargs.

    ``shared-with-me`` = views reachable through an explicit grant
    (direct or via group), excluding the caller's own — a real answer,
    not the old visibility-tier approximation the frontend faked.
    Unknown categories are ignored (the other pills are plain filters
    the frontend already expresses via existing params).
    """
    if category != "shared-with-me":
        return None, None
    if scope is None:
        # Kill-switch path has no grant index — return nothing rather
        # than everything.
        return [], None
    return list(scope.granted_view_ids), user.id if user else None


# Suppress the "imported but unused" hint while os is referenced via
# rbac_flag. The flag wrapper itself reads os.environ.
_ = os

# Fallback user_id when no auth token is present (backward compatibility).
_ANONYMOUS_USER = "anonymous"


def _user_id(user) -> str:
    """Extract user_id from the optional user dependency, or fall back to anonymous."""
    return user.id if user else _ANONYMOUS_USER


def _view_update_changes(old, req) -> dict:
    """Field-level diff between a view and an update request, for the activity
    log. Only human-meaningful top-level fields; ``config`` (filters/layers) is
    flagged as changed, not deep-diffed."""
    ch: dict = {}
    if req.name is not None and req.name != old.name:
        ch["name"] = {"from": old.name, "to": req.name}
    if req.description is not None and (req.description or None) != (old.description or None):
        ch["description"] = {"from": old.description, "to": req.description}
    if req.view_type is not None and req.view_type != old.view_type:
        ch["viewType"] = {"from": old.view_type, "to": req.view_type}
    # visibility is deliberately absent: the generic PUT rejects it, so
    # only the dedicated endpoint can log a visibility_changed entry.
    if req.tags is not None and sorted(req.tags or []) != sorted(old.tags or []):
        ch["tags"] = {"from": old.tags, "to": req.tags}
    if req.is_pinned is not None and req.is_pinned != old.is_pinned:
        ch["pinned"] = {"from": old.is_pinned, "to": req.is_pinned}
    if req.config is not None:
        ch["content"] = True
    return ch


def _update_summary(changes: dict) -> str:
    """Human one-liner for an 'updated' activity entry from its diff."""
    if "name" in changes:
        return f'Renamed to "{changes["name"]["to"]}"'
    parts = []
    if "viewType" in changes:
        parts.append("layout")
    if "description" in changes:
        parts.append("description")
    if "tags" in changes:
        parts.append("tags")
    if "content" in changes:
        parts.append("content")
    if "pinned" in changes:
        parts.append("pinned" if changes["pinned"]["to"] else "unpinned")
    return "Edited " + ", ".join(parts) if parts else "Edited settings"


async def _compute_ontology_digest(
    session: AsyncSession,
    workspace_id: Optional[str],
    data_source_id: Optional[str],
) -> Optional[str]:
    """Resolve the active ontology for a view's scope and return its digest.

    Best-effort: if the engine can't be built (no workspace, provider down,
    unresolvable ontology), returns None so the caller stores NULL — the
    wizard treats NULL as "drift check unavailable" and just skips the
    banner. Drift detection is a UX feature, never a save blocker.
    """
    if not workspace_id:
        return None
    try:
        engine = await ContextEngine.for_workspace(
            workspace_id, provider_registry, session, data_source_id=data_source_id,
        )
        return await engine.get_ontology_digest()
    except Exception as exc:
        logger.warning(
            "Ontology digest computation failed for ws=%s ds=%s: %s",
            workspace_id, data_source_id, exc,
        )
        return None


def _clear_publish_request(view_orm: ViewORM) -> None:
    """Drop a pending publication request (approved, denied, or withdrawn)."""
    view_orm.publish_requested_by = None
    view_orm.publish_requested_at = None
    view_orm.publish_request_note = None


async def _enriched_or_404(
    session: AsyncSession, view_id: str, user: User,
) -> ViewResponse:
    """Re-read a view for the response after a mutation."""
    view = await view_repo.get_view_enriched(session, view_id, user_id=_user_id(user))
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


async def _record_break_glass_read(
    session: AsyncSession,
    ctx: view_access.ViewerContext,
    view_orm: ViewORM,
    user: User,
) -> None:
    """Note when an admin opens a PRIVATE view that isn't theirs.

    Platform admins can read every view — that reach is deliberate and
    stays (support, governance, incident response). What it shouldn't
    also be is invisible: a private view carries the expectation that
    nobody else looks, so when someone does, its owner can see that on
    the view's own timeline. Only break-glass reads qualify — the
    creator reading their own view, or anyone reading a workspace or
    enterprise view, is just reading.
    """
    if user is None or (view_orm.visibility or "private") != "private":
        return
    if view_orm.created_by == user.id:
        return
    # Reach the owner did NOT grant: a global admin short-circuit rather
    # than workspace-admin standing or an explicit share.
    from backend.app.services.permission_service import has_permission
    if not has_permission(ctx.claims, "system:admin"):
        return
    # One entry per admin per view per hour. The client re-reads a view
    # on every open and React Query refetches on top of that; without a
    # window the owner's timeline would be buried under one person's
    # single visit.
    from backend.app.db.models import ViewActivityLogORM
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent = await session.execute(
        select(ViewActivityLogORM.id)
        .where(
            ViewActivityLogORM.view_id == view_orm.id,
            ViewActivityLogORM.action == "admin_viewed",
            ViewActivityLogORM.actor == user.id,
            ViewActivityLogORM.created_at >= cutoff,
        )
        .limit(1)
    )
    if recent.first() is not None:
        return
    await view_activity_repo.record_view_activity(
        session, view_id=view_orm.id, workspace_id=view_orm.workspace_id,
        action="admin_viewed", actor=user.id,
        summary="Opened by a platform administrator",
    )


async def _publish_policy(session: AsyncSession, workspace_id: str) -> str:
    """The workspace's publication policy ('request' | 'open')."""
    from backend.app.db.models import WorkspaceORM
    row = await session.get(WorkspaceORM, workspace_id)
    return (getattr(row, "publish_policy", None) or "request") if row else "request"



@router.get("/popular", response_model=List[ViewResponse])
async def list_popular_views(
    limit: int = Query(20, le=100),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """List the most-favourited views readable by the caller.

    Single-flight wrapped: when N concurrent callers hit this with the
    same (principal, limit) pair the leader runs the query and the
    others receive the same result. Most-favourited views are a
    homepage-style render that frequently sees burst traffic from
    every Explorer tab opening at once; this kills the thundering
    herd against the views + favourites tables.
    """
    clause, _scope = await _readable_clause(session, user, claims)
    principal = normalised_principal(_user_id(user))
    key = ("popular", principal, limit)
    return await read_views_sf.run(
        key,
        lambda: view_repo.list_popular_views(
            session, limit=limit, user_id=_user_id(user), readable=clause,
        ),
    )


@router.get("/facets", response_model=ViewFacetsResponse)
async def get_view_facets(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewFacetsResponse:
    """Return distinct tags, view types, and creators across the views
    the caller can read.

    Used to populate the Explorer's Tag / View Type / Creator filter
    dropdowns from the authoritative set of values rather than deriving
    them from the currently-loaded page (which would miss tags/creators
    beyond the first page at scale). Scoped per principal — an
    unscoped facet aggregate leaks private views' tags and creator
    identities, which is how this endpoint shipped originally.

    Single-flight wrapped per principal: the response depends on who
    asks, so the key must too.
    """
    clause, _scope = await _readable_clause(session, user, claims)
    principal = normalised_principal(_user_id(user))
    return await read_views_sf.run(
        ("facets", principal),
        lambda: view_repo.get_view_facets(session, readable=clause),
    )


@router.get("/stats", response_model=ViewCatalogStats)
async def get_view_stats(
    visibility: Optional[str] = Query(None),
    visibility_in: Optional[List[str]] = Query(None, alias="visibilityIn"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    workspace_ids: Optional[List[str]] = Query(None, alias="workspaceIds"),
    context_model_id: Optional[str] = Query(None, alias="contextModelId"),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    view_type: Optional[str] = Query(None, alias="viewType"),
    view_types: Optional[List[str]] = Query(None, alias="viewTypes"),
    created_by: Optional[str] = Query(None, alias="createdBy"),
    created_by_in: Optional[List[str]] = Query(None, alias="createdByIn"),
    created_after: Optional[str] = Query(None, alias="createdAfter"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    favourited_only: bool = Query(False, alias="favouritedOnly"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    deleted_only: bool = Query(False, alias="deletedOnly"),
    attention_only: bool = Query(False, alias="attentionOnly"),
    category: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewCatalogStats:
    """Aggregate counts for the Explorer stats bar, scoped to the same
    filters the list endpoint accepts — including the caller's read
    reach, so the numbers always describe the population the list
    would actually return.
    """
    clause, scope = await _readable_clause(session, user, claims)
    ids_in, created_by_not = _category_filters(category, scope, user)
    return await view_repo.get_view_stats(
        session,
        visibility=visibility,
        visibility_in=visibility_in,
        workspace_id=workspace_id,
        workspace_ids=workspace_ids,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        view_type=view_type,
        view_types=view_types,
        created_by=created_by,
        created_by_in=created_by_in,
        created_by_not=created_by_not,
        created_after=created_after,
        search=search,
        tags=tags,
        ids_in=ids_in,
        user_id=_user_id(user),
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
        readable=clause,
    )


@router.get("/", response_model=ViewListResponse)
async def list_views(
    visibility: Optional[str] = Query(None),
    visibility_in: Optional[List[str]] = Query(None, alias="visibilityIn"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    workspace_ids: Optional[List[str]] = Query(None, alias="workspaceIds"),
    context_model_id: Optional[str] = Query(None, alias="contextModelId"),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    view_type: Optional[str] = Query(None, alias="viewType"),
    view_types: Optional[List[str]] = Query(None, alias="viewTypes"),
    created_by: Optional[str] = Query(None, alias="createdBy"),
    created_by_in: Optional[List[str]] = Query(None, alias="createdByIn"),
    created_after: Optional[str] = Query(None, alias="createdAfter"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    sort: Optional[str] = Query(
        None,
        description=(
            "Server-side ordering key: recently-modified (default), data-newest, "
            "data-oldest, newest, oldest, updated, popular, az, za. Ordering runs "
            "across the whole result set so it stays correct with infinite scroll."
        ),
    ),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    favourited_only: bool = Query(False, alias="favouritedOnly"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    deleted_only: bool = Query(False, alias="deletedOnly"),
    attention_only: bool = Query(False, alias="attentionOnly"),
    include: List[str] = Query(
        default_factory=list,
        description=(
            "Optional embedded resources. ``include=popular`` folds the "
            "Explorer's trending strip into this response (under "
            "``popular``) so the page only makes one request instead of "
            "two."
        ),
    ),
    popular_limit: int = Query(
        10,
        le=100,
        alias="popularLimit",
        description="Cap on the embedded popular list when include=popular.",
    ),
    category: Optional[str] = Query(
        None,
        description=(
            "Explorer category with server-side meaning: "
            "``shared-with-me`` = views shared with the caller through "
            "an explicit grant (excluding their own)."
        ),
    ),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewListResponse:
    """List accessible views as a paginated envelope.

    Returns ``{ items, total, hasMore, nextOffset }``. ``total`` is the
    authoritative count of matches so callers never have to infer "is
    there another page?" from array length. Access control runs inside
    the SQL (``readable_views_clause``), so the numbers are exact —
    the previous Python post-filter made ``total`` overcount and pages
    come back short.

    Filter params (single/multi pairs — the multi-value param wins when both are sent):
    - ``workspaceId`` / ``workspaceIds``
    - ``visibility`` / ``visibilityIn``
    - ``viewType`` / ``viewTypes``
    - ``createdBy`` / ``createdByIn``

    Additional filters:
    - ``createdAfter`` — ISO timestamp; returns views created on or after.
    - ``tags`` — OR semantics across the supplied tags.
    - ``attentionOnly`` — stale (>90d), inactive workspace/source, or
      broken data source reference. Mirrors the frontend health model
      so pagination stays accurate on large catalogs.
    - ``category=shared-with-me`` — explicit-grant shares only.
    """
    clause, scope = await _readable_clause(session, user, claims)
    ids_in, created_by_not = _category_filters(category, scope, user)
    response = await view_repo.list_views_filtered(
        session,
        visibility=visibility,
        visibility_in=visibility_in,
        workspace_id=workspace_id,
        workspace_ids=workspace_ids,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        view_type=view_type,
        view_types=view_types,
        created_by=created_by,
        created_by_in=created_by_in,
        created_by_not=created_by_not,
        created_after=created_after,
        search=search,
        tags=tags,
        ids_in=ids_in,
        sort=sort,
        limit=limit,
        offset=offset,
        user_id=_user_id(user),
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
        readable=clause,
    )

    # Optional ?include=popular: fold the trending strip into the same
    # response so the Explorer only makes one round-trip instead of two.
    # Scoped by the same readable clause as the main list.
    if "popular" in include:
        response.popular = await view_repo.list_popular_views(
            session, limit=popular_limit, user_id=_user_id(user),
            readable=clause,
        )

    return response


@router.post("/", response_model=ViewResponse, status_code=201)
async def create_view(
    req: ViewCreateRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new view. workspaceId is required.

    Captures the current ontology digest on the new row so later edits
    can detect ontology drift. Records created_by as the authenticated
    user's ID so views can be filtered by creator in the Explorer.

    Authorization: requires ``workspace:view:create`` in the target
    workspace; creating straight to ``enterprise`` additionally
    requires ``workspace:view:publish`` (the same gate as the
    visibility endpoint — a birth certificate is not a bypass).
    """
    if req.visibility is not None and req.visibility not in (
        "private", "workspace", "enterprise",
    ):
        # Validate before the DB CHECK constraint turns this into a 500.
        raise HTTPException(
            status_code=422,
            detail="visibility must be one of: private, workspace, enterprise",
        )

    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        from backend.app.services.permission_service import has_permission
        if not has_permission(
            claims, "workspace:view:create", workspace_id=req.workspace_id,
        ):
            raise HTTPException(
                status_code=403,
                detail="Missing permission: workspace:view:create",
            )
        if req.visibility == "enterprise" and not view_access.can_publish_in_workspace(
            claims, req.workspace_id,
        ):
            # A workspace set to 'open' has decided publishing isn't
            # admin-only there; anyone who may create a view in it may
            # publish one.
            if await _publish_policy(session, req.workspace_id) != "open":
                raise HTTPException(
                    status_code=403,
                    detail="Missing permission: workspace:view:publish",
                )

    # Admin → Features → View modes. The admin picks which layouts this deployment offers; the
    # wizard hides the rest. Enforced here too, because a hidden button is not a rule.
    await ensure_view_mode_allowed(req.view_type, session)

    digest = await _compute_ontology_digest(
        session, req.workspace_id, req.data_source_id,
    )
    view = await view_repo.create_view(
        session, req, ontology_digest=digest, user_id=_user_id(user),
    )
    await view_activity_repo.record_view_activity(
        session, view_id=view.id, workspace_id=view.workspace_id,
        action="created", actor=_user_id(user), summary=f'Created "{view.name}"',
    )
    return view


@router.get("/{view_id}", response_model=ViewResponse)
async def get_view(
    view_id: str = Path(...),
    branch_id: Optional[str] = Query(None, alias="branchId"),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single view by ID, enriched with workspace context and favourite data.

    ``branchId`` (a draft ref) projects the branch-effective config — base ⊕ the
    branch's layout overlay — so a draft sees its own layer/scope edits; published
    and other branches see the base. Absent (or no overlay) → base, unchanged.

    The response carries everything a caller needs to boot the canvas
    WITHOUT workspace membership: the ``access`` capability envelope,
    the resolved data source (workspace primary when the view stores
    NULL), and its ``providerId``."""
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        if not await view_access.can_read_view(session, ctx, view_orm):
            # 404 (not 403) so view existence stays private from
            # users with no access path.
            raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    await _record_break_glass_read(session, ctx, view_orm, user)

    view = await view_repo.get_view_enriched(
        session, view_id, user_id=_user_id(user), branch_id=branch_id,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    # Resolve the effective data source so the frontend never needs the
    # (membership-gated) workspace list to find it.
    if view_orm.data_source_id:
        ds = await data_source_repo.get_data_source_orm(
            session, view_orm.data_source_id,
        )
    else:
        ds = await data_source_repo.get_primary_data_source(
            session, view_orm.workspace_id,
        )
        if ds is not None:
            view.data_source_id = ds.id
            view.data_source_name = ds.label or view.data_source_name
    if ds is not None:
        view.provider_id = ds.provider_id

    view.audience = ViewAudience(
        workspaceMemberCount=await notification_repo.workspace_member_count(
            session, view_orm.workspace_id,
        ),
        explicitGrantCount=len(await grant_repo.list_grants_for_resource(
            session, resource_type="view", resource_id=view_id,
        )),
    )
    view.access = ViewAccessInfo(**await view_access.compute_access_envelope(
        session, ctx, view_orm,
        workspace_policy=await _publish_policy(session, view_orm.workspace_id),
    ))
    return view


@router.put("/{view_id}", response_model=ViewResponse)
async def update_view(
    view_id: str = Path(...),
    req: ViewUpdateRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an existing view.

    Refreshes the stored ontology digest to the CURRENT ontology state so
    subsequent edits will flag drift only for changes that happen after
    this save — every explicit save resets the drift baseline.

    ``visibility`` is NOT accepted here: it is a security field with its
    own authorization (publish gate) on ``PUT /views/{id}/visibility``.
    Rejecting loudly beats silently ignoring — an old client must never
    believe it changed sharing state when it didn't.
    """
    if req.visibility is not None:
        raise HTTPException(
            status_code=422,
            detail=(
                "visibility cannot be changed here; "
                "use PUT /views/{view_id}/visibility"
            ),
        )

    existing = await view_repo.get_view(session, view_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id)
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_edit_view(session, ctx, view_orm):
            raise HTTPException(
                status_code=403,
                detail="Missing permission: workspace:view:edit",
            )

    # Only when the type CHANGES. Withdrawing a layout stops NEW work in it; a view already
    # built in that layout must stay editable, or "existing views keep working" — which is what
    # the admin is told — would be false the moment they renamed one.
    if req.view_type is not None and req.view_type != existing.view_type:
        await ensure_view_mode_allowed(req.view_type, session)

    digest = await _compute_ontology_digest(
        session, existing.workspace_id, existing.data_source_id,
    )
    view = await view_repo.update_view(
        session, view_id, req, ontology_digest=digest, user_id=_user_id(user),
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    changes = _view_update_changes(existing, req)
    if changes:
        await view_activity_repo.record_view_activity(
            session, view_id=view.id, workspace_id=view.workspace_id,
            action="updated", actor=_user_id(user),
            summary=_update_summary(changes), changes=changes,
        )
    return view


@router.put("/{view_id}/layout", response_model=ViewResponse)
async def update_view_layout(
    view_id: str = Path(...),
    req: ViewLayoutUpdateRequest = Body(...),
    branch_id: Optional[str] = Query(None, alias="branchId"),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a view's layer layout (layers + assignments) in isolation.

    Layout-only: does not touch name/description/content (other than
    entityScope)/filters/or any other config key — see
    ``view_repo.update_view_layout`` for the merge + validation logic.

    ``branchId`` — when a draft branch is editing, the frontend threads its
    active branch id here so the write lands on that branch's
    ``view_layout_overlays`` row instead of the published ``views.config``.
    This keeps a draft's layer/assignment edits from leaking to Published (or
    other branches) until the draft is promoted. Omitted (base/published edit)
    → the published row is updated in place, exactly as before.
    """
    existing = await view_repo.get_view(session, view_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id)
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_edit_view(session, ctx, view_orm):
            raise HTTPException(
                status_code=403,
                detail="Missing permission: workspace:view:edit",
            )

    try:
        if branch_id:
            view = await view_repo.update_overlay_layout(
                session, view_id, branch_id, req,
            )
        else:
            view = await view_repo.update_view_layout(
                session, view_id, req, user_id=_user_id(user),
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.delete("/{view_id}", status_code=204)
async def delete_view(
    view_id: str = Path(...),
    permanent: bool = Query(False),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a view. Soft-deletes by default; pass ?permanent=true to remove from DB.

    Soft-delete: creator OR ``workspace:view:delete``.
    Hard-delete: ``workspace:admin`` only (per the action matrix).
    """
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        # "Delete forever" targets views that are ALREADY in the trash —
        # the live-only default would 404 before the authz check runs.
        view_orm = await _load_view_orm(
            session, view_id, include_deleted=permanent,
        )
        ctx = await _viewer_context(session, user, claims)
        if permanent:
            allowed = view_access.can_hard_delete_view(ctx, view_orm)
            need = "workspace:admin"
        else:
            allowed = view_access.can_delete_view(ctx, view_orm)
            need = "workspace:view:delete"
        if not allowed:
            raise HTTPException(status_code=403, detail=f"Missing permission: {need}")

    existing = await view_repo.get_view(session, view_id)
    if permanent:
        deleted = await view_repo.permanently_delete_view(session, view_id)
    else:
        deleted = await view_repo.delete_view(session, view_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    # Soft-delete only: a hard-deleted view has no timeline to show anyway.
    if not permanent and existing:
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=existing.workspace_id,
            action="deleted", actor=_user_id(user), summary=f'Deleted "{existing.name}"',
        )


@router.post("/{view_id}/restore", response_model=ViewResponse)
async def restore_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Restore a soft-deleted view (workspace admin only)."""
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id, include_deleted=True)
        ctx = await _viewer_context(session, user, claims)
        if not view_access.can_restore_view(ctx, view_orm):
            raise HTTPException(
                status_code=403,
                detail="Missing permission: workspace:admin",
            )

    restored = await view_repo.restore_view(session, view_id)
    if not restored:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found or not deleted")
    view = await view_repo.get_view_enriched(session, view_id, user_id=_user_id(user))
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view.workspace_id if view else None,
        action="restored", actor=_user_id(user),
        summary=f'Restored "{view.name}"' if view else "Restored",
    )
    return view


@router.put("/{view_id}/visibility", response_model=ViewResponse)
async def update_view_visibility(
    view_id: str = Path(...),
    visibility: str = Body(..., embed=True),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Change the visibility of a view (private | workspace | enterprise).

    Base rule: creator or workspace admin. Any transition to or from
    ``enterprise`` additionally requires ``workspace:view:publish`` —
    publishing exposes the view and read-only access to its data source
    to every signed-in user, which is a governance act, not an edit.
    """
    if visibility not in ("private", "workspace", "enterprise"):
        raise HTTPException(status_code=422, detail="visibility must be one of: private, workspace, enterprise")

    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id)
        ctx = await _viewer_context(session, user, claims)
        if not view_access.can_change_visibility(ctx, view_orm):
            raise HTTPException(
                status_code=403,
                detail="Only the creator or a workspace admin can change visibility",
            )
        crosses_enterprise = (
            view_orm.visibility != visibility
            and "enterprise" in (view_orm.visibility, visibility)
        )
        if crosses_enterprise:
            policy = await _publish_policy(session, view_orm.workspace_id)
            if not view_access.can_publish_under_policy(
                ctx, view_orm, policy=policy,
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Missing permission: workspace:view:publish",
                )

    existing = await view_repo.get_view(session, view_id)
    view = await view_repo.update_visibility(
        session, view_id, visibility, user_id=_user_id(user),
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    if existing and existing.visibility != visibility:
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=view.workspace_id,
            action="visibility_changed", actor=_user_id(user),
            summary=f"Visibility {existing.visibility} → {visibility}",
            changes={"visibility": {"from": existing.visibility, "to": visibility}},
        )
    return view



# ── Publication requests ─────────────────────────────────────────────
#
# ``workspace:view:publish`` is the right gate for exposing a view (and
# read-only access to its data source) to the whole platform. But a
# permission with no path around it is a dead end, and the product
# intent is the opposite: any member should be able to share their work
# with the wider world. So a member who cannot publish can ASK, in one
# click, and whoever holds the permission answers. Workspaces that
# don't want the ceremony set ``publish_policy='open'`` and members
# publish directly.

@router.post("/{view_id}/publish-request", response_model=ViewResponse)
async def request_publication(
    view_id: str = Path(...),
    note: Optional[str] = Body(None, embed=True),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask for this view to be published platform-wide.

    Open to whoever owns the view's sharing settings (creator or
    workspace admin) — the same bar as changing visibility, since this
    is the one visibility they cannot set themselves. Asking grants
    nothing; it queues the question for a publish-permission holder.
    """
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if rbac_flag("RBAC_ENFORCE_VIEWS") and not view_access.can_request_publish(ctx, view_orm):
        raise HTTPException(
            status_code=403,
            detail="Only the view's owner or a workspace admin can request publication",
        )
    if view_orm.visibility == "enterprise":
        raise HTTPException(status_code=409, detail="This view is already published")

    view_orm.publish_requested_by = user.id
    view_orm.publish_requested_at = datetime.now(timezone.utc).isoformat()
    view_orm.publish_request_note = (note or "").strip() or None
    await session.flush()
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view_orm.workspace_id,
        action="publish_requested", actor=user.id,
        summary="Requested publication to everyone",
        changes={"note": view_orm.publish_request_note},
    )
    # A queue nobody is told about is not a queue.
    await notification_repo.notify(
        session,
        user_ids=await notification_repo.users_who_can(
            session,
            workspace_id=view_orm.workspace_id,
            permission="workspace:view:publish",
        ),
        kind="view.publish_requested",
        title=f'Publication requested: "{view_orm.name}"',
        body=view_orm.publish_request_note
             or "Someone asked to publish this view to everyone.",
        link=f"/views/{view_id}",
        actor_id=user.id,
        resource_type="view",
        resource_id=view_id,
    )
    return await _enriched_or_404(session, view_id, user)


@router.delete("/{view_id}/publish-request", status_code=204)
async def withdraw_publication_request(
    view_id: str = Path(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Withdraw a pending request — the requester, or anyone who could
    have answered it."""
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    is_requester = view_orm.publish_requested_by == user.id
    if rbac_flag("RBAC_ENFORCE_VIEWS") and not (
        is_requester or view_access.can_answer_publish_request(ctx, view_orm)
    ):
        raise HTTPException(status_code=403, detail="Not your request to withdraw")
    _clear_publish_request(view_orm)
    await session.flush()


@router.post("/{view_id}/publish-request/approve", response_model=ViewResponse)
async def approve_publication(
    view_id: str = Path(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Approve a pending request: the view goes enterprise.

    Recorded as ``visibility_changed`` — the approval's whole point is
    the transition, and the timeline should say what happened, not how
    it was authorised (the request's own entry already says that).
    """
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if rbac_flag("RBAC_ENFORCE_VIEWS") and not view_access.can_answer_publish_request(ctx, view_orm):
        raise HTTPException(
            status_code=403,
            detail="Missing permission: workspace:view:publish",
        )
    if not view_orm.publish_requested_at:
        raise HTTPException(status_code=409, detail="No pending publication request")

    previous = view_orm.visibility
    requester = view_orm.publish_requested_by
    _clear_publish_request(view_orm)
    view_orm.visibility = "enterprise"
    view_orm.updated_by = user.id
    await session.flush()
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view_orm.workspace_id,
        action="visibility_changed", actor=user.id,
        summary=f"Published to everyone (requested by {requester or 'unknown'})",
        changes={
            "visibility": {"from": previous, "to": "enterprise"},
            "approvedRequestFrom": requester,
        },
    )
    await notification_repo.notify(
        session,
        user_ids=[requester] if requester else [],
        kind="view.publish_approved",
        title=f'"{view_orm.name}" is now published',
        body="Your request was approved — anyone signed in can open this view.",
        link=f"/views/{view_id}",
        actor_id=user.id,
        resource_type="view",
        resource_id=view_id,
    )
    return await _enriched_or_404(session, view_id, user)


@router.post("/{view_id}/publish-request/deny", response_model=ViewResponse)
async def deny_publication(
    view_id: str = Path(...),
    reason: Optional[str] = Body(None, embed=True),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Decline a pending request. The view keeps its current visibility;
    the reason lands on the view's timeline so the asker learns why."""
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if rbac_flag("RBAC_ENFORCE_VIEWS") and not view_access.can_answer_publish_request(ctx, view_orm):
        raise HTTPException(
            status_code=403,
            detail="Missing permission: workspace:view:publish",
        )
    if not view_orm.publish_requested_at:
        raise HTTPException(status_code=409, detail="No pending publication request")

    requester = view_orm.publish_requested_by
    _clear_publish_request(view_orm)
    await session.flush()
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view_orm.workspace_id,
        action="publish_denied", actor=user.id,
        summary=(reason or "").strip() or "Publication request declined",
        changes={"requestedBy": requester, "reason": (reason or "").strip() or None},
    )
    await notification_repo.notify(
        session,
        user_ids=[requester] if requester else [],
        kind="view.publish_denied",
        title=f'Publication declined: "{view_orm.name}"',
        body=(reason or "").strip()
             or "Your request to publish this view was declined.",
        link=f"/views/{view_id}",
        actor_id=user.id,
        resource_type="view",
        resource_id=view_id,
    )
    return await _enriched_or_404(session, view_id, user)

@router.post("/{view_id}/favourite", status_code=201)
async def favourite_view(
    view_id: str = Path(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Favourite a view for the current user. Gated by view-read access
    (this endpoint previously had no check at all — anyone who knew an
    id could favourite it and write to its activity log)."""
    view_orm = await _load_view_orm(session, view_id)
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_read_view(session, ctx, view_orm):
            raise HTTPException(
                status_code=404, detail=f"View '{view_id}' not found",
            )
    created = await view_repo.favourite_view(session, view_id, _user_id(user))
    if created:
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=view_orm.workspace_id,
            action="favourited", actor=_user_id(user), summary="Favourited",
        )
    return {"favourited": True, "created": created}


@router.delete("/{view_id}/favourite", status_code=204)
async def unfavourite_view(
    view_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove favourite for the current user. No read check — removing
    your own bookmark must keep working after access is revoked, and a
    404 here only ever reflects the caller's own rows."""
    removed = await view_repo.unfavourite_view(session, view_id, _user_id(user))
    if not removed:
        raise HTTPException(status_code=404, detail="Favourite not found")
    view = await view_repo.get_view(session, view_id)
    if view:
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=view.workspace_id,
            action="unfavourited", actor=_user_id(user), summary="Unfavourited",
        )


@router.get("/{view_id}/activity", response_model=List[view_activity_repo.ViewActivityEntry])
async def get_view_activity(
    view_id: str = Path(...),
    action: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Per-view activity timeline, newest first. Gated by view-read access —
    whoever can see the view can see how it changed. Legacy views with no
    recorded activity get a synthesized 'created' anchor from their stamps."""
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id)
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_read_view(session, ctx, view_orm):
            raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return await view_activity_repo.get_view_activity(
        session, view_id, action=action, limit=limit, offset=offset,
    )


@router.get(
    "/workspace/{workspace_id}/activity",
    response_model=List[view_activity_repo.ViewActivityEntry],
)
async def get_workspace_view_activity(
    workspace_id: str = Path(...),
    limit: int = Query(30, le=100),
    offset: int = Query(0, ge=0),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Recent activity across all of a workspace's views (each entry carries the
    view name). Powers the governance-tab feed. Gated by workspace view-read."""
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        from backend.app.services.permission_service import has_permission
        if not has_permission(claims, "workspace:view:read", workspace_id=workspace_id):
            raise HTTPException(status_code=403, detail="Missing permission: workspace:view:read")
    return await view_activity_repo.get_workspace_activity(
        session, workspace_id, limit=limit, offset=offset,
    )


@router.get("/me/feed", response_model=List[view_activity_repo.ViewActivityEntry])
async def list_my_activity_feed(
    limit: int = Query(15, le=50),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Recent activity across every view the CURRENT USER can see — the
    dashboard's "What changed" feed.

    Path is ``/me/feed`` rather than ``/me/activity`` on purpose: the latter
    would bind ``/{view_id}/activity`` with view_id="me".

    The read scope is pushed into SQL (``readable_views_clause``), so the
    LIMIT applies to the caller's readable feed — the old over-fetch+trim
    starved users whose readable views were sparse relative to global
    activity.
    """
    clause, _scope = await _readable_clause(session, user, claims)
    if clause is None:
        # Kill-switch path: legacy unscoped feed.
        pairs = await view_activity_repo.get_recent_activity(session, limit=limit)
        return [entry for entry, _ in pairs][:limit]
    pairs = await view_activity_repo.get_recent_activity(
        session, limit=limit, readable=clause,
    )
    return [entry for entry, _ in pairs]


class MyDraftEntry(BaseModel):
    """One piece of the caller's unfinished work."""

    model_config = ConfigDict(populate_by_name=True)

    draft_id: str = Field(alias="draftId")
    graph_id: str = Field(alias="graphId")
    view_id: str = Field(alias="viewId")
    view_name: str = Field(alias="viewName")
    view_type: Optional[str] = Field(default=None, alias="viewType")
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    name: Optional[str] = None
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


async def _open_drafts_for(owner: str, limit: int) -> List[BranchORM]:
    """The caller's OPEN drafts, newest-touched first.

    Seam on purpose: ``graphver`` is a separate schema (and, in some
    deployments, a separate database) with **no cross-schema FKs to public** —
    ``originating_view_id`` is a logical reference, not a join key. So the branch
    read happens here, against the graphver session, and the endpoint stitches
    the view titles from the app DB. Tests stub this one function, because the
    SQLite test harness never creates the graphver tables.
    """
    async with graphver_session() as s:
        rows = (
            await s.execute(
                select(BranchORM)
                .where(
                    BranchORM.owner == owner,
                    BranchORM.status == "open",
                    BranchORM.kind.in_(("draft", "fork_draft")),
                    BranchORM.originating_view_id.is_not(None),
                )
                .order_by(BranchORM.updated_at.desc())
                .limit(limit)
            )
        ).scalars().all()
    return list(rows)


@router.get("/me/drafts", response_model=List[MyDraftEntry])
async def list_my_drafts(
    limit: int = Query(6, le=25),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The caller's unpublished drafts — "pick up where you left off".

    Until now this work was invisible the moment you navigated away from the view
    you were editing: every branch endpoint is scoped to a single graph, so
    nothing could answer "what have I left unfinished?". Drafts then rot quietly
    and resurface as somebody else's merge conflict.

    Only drafts the caller OWNS, and only those still readable: a draft whose view
    was deleted, or which the caller can no longer read, drops out rather than
    rendering a dead link.
    """
    owner = _user_id(user)
    if not owner or owner == "anonymous":
        return []

    # Over-fetch: some drafts will be dropped by the deleted/RBAC filters below.
    drafts = await _open_drafts_for(owner, limit * 3)
    if not drafts:
        return []

    view_ids = [d.originating_view_id for d in drafts if d.originating_view_id]
    rows = (
        await session.execute(
            select(ViewORM).where(
                ViewORM.id.in_(view_ids),
                ViewORM.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    by_id = {v.id: v for v in rows}

    ctx = await _viewer_context(session, user, claims)
    enforce = rbac_flag("RBAC_ENFORCE_VIEWS")

    out: List[MyDraftEntry] = []
    for d in drafts:
        if len(out) >= limit:
            break
        view = by_id.get(d.originating_view_id)
        if view is None:
            continue  # view deleted since the draft was opened
        if enforce and not await view_access.can_read_view(session, ctx, view):
            continue
        out.append(
            MyDraftEntry(
                draftId=d.id,
                graphId=d.graph_id,
                viewId=view.id,
                viewName=view.name,
                viewType=view.view_type,
                workspaceId=view.workspace_id,
                name=d.name,
                createdAt=d.created_at,
                updatedAt=d.updated_at,
            )
        )
    return out


@router.get("/me/recent", response_model=List[view_repo.RecentViewEntry])
async def list_my_recent_views(
    limit: int = Query(5, le=20),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The signed-in user's recently visited views — "Continue where you left off".

    Server-side and per-user, so it follows them across devices/browsers and is
    joined against the LIVE views (never a stale name, deleted views drop out).
    Also scoped by the caller's CURRENT read reach — a visit row is
    history, not a capability, so a view that went private drops out.
    """
    clause, _scope = await _readable_clause(session, user, claims)
    return await view_repo.list_recent_views(
        session, _user_id(user), limit=limit, readable=clause,
    )


@router.post("/{view_id}/visit", status_code=204)
async def record_visit(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Record that the current user opened this view (drives the recents strip)."""
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id)
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_read_view(session, ctx, view_orm):
            raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    await view_repo.record_view_visit(session, view_id, _user_id(user))
